// app/vault/db.js on a fresh fake-indexeddb factory per test: schema, meta CAS, index records, one-transaction
// commits, kv, clearAll, close/versionchange, error mapping, and the JSON snapshot used by the Tauri mirror.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange, IDBObjectStore, forceCloseDatabase } from 'fake-indexeddb';
import { openVaultDb } from '../../app/vault/db.js';
import { CzdError } from '../../app/errors.js';
import { randomBytes, toHex } from '../../app/util/bytes.js';

const isCzd = (code) => (e) => e instanceof CzdError && e.code === code;
const newId = () => toHex(randomBytes(16));

function metaRec(over = {}) {
  return {
    v: 1,
    vaultId: randomBytes(16),
    kdf: { id: 1, m: 65536, t: 3, p: 1, salt: randomBytes(16) },
    floor: false,
    wrap: { iv: randomBytes(12), ct: randomBytes(48) },
    rwrap: null,
    storeKind: 'opfs',
    createdAt: 1700000000000,
    lastBackupAt: null,
    ...over,
  };
}
const itemRec = (id = newId()) => ({ id, iv: randomBytes(12), enc: randomBytes(100), storedBytes: 12345 });
const listRec = (id = newId()) => ({ id, iv: randomBytes(12), enc: randomBytes(40) });
const thumbRec = (id = newId()) => ({ id, iv: randomBytes(12), enc: randomBytes(900) });

async function fresh(opts = {}) {
  const idb = new IDBFactory();
  return { idb, db: await openVaultDb({ idb, IDBKeyRange, ...opts }) };
}

test('creates czd-vault v1 with the six stores (key paths per DESIGN §4.1)', async () => {
  const { idb, db } = await fresh();
  db.close();
  const raw = await new Promise((resolve, reject) => {
    const r = idb.open('czd-vault');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  assert.equal(raw.version, 1);
  assert.deepEqual([...raw.objectStoreNames].sort(), ['blobs', 'items', 'kv', 'lists', 'meta', 'thumbs']);
  const tx = raw.transaction([...raw.objectStoreNames]);
  const kp = Object.fromEntries([...raw.objectStoreNames].map((n) => [n, tx.objectStore(n).keyPath]));
  assert.deepEqual(kp, { blobs: null, items: 'id', kv: null, lists: 'id', meta: null, thumbs: 'id' });
  raw.close();
  // Reopening keeps the data.
  const db2 = await openVaultDb({ idb });
  await db2.kvSet('x', 1);
  db2.close();
  const db3 = await openVaultDb({ idb });
  assert.equal(await db3.kvGet('x'), 1);
  db3.close();
});

test('no IndexedDB, or a newer database version → store-unavailable', async () => {
  await assert.rejects(openVaultDb({ idb: null }), isCzd('store-unavailable'));
  await assert.rejects(openVaultDb({ idb: {} }), isCzd('store-unavailable'));
  const idb = new IDBFactory();
  await new Promise((resolve) => {
    const r = idb.open('czd-vault', 7);
    r.onsuccess = () => {
      r.result.close();
      resolve();
    };
  });
  await assert.rejects(openVaultDb({ idb }), isCzd('store-unavailable'));
});

test('meta: getMeta undefined at first; putMeta round trips Uint8Arrays', async () => {
  const { db } = await fresh();
  assert.equal(await db.getMeta(), undefined);
  const m = metaRec();
  await db.putMeta(m);
  assert.deepEqual(await db.getMeta(), m);
  await assert.rejects(db.putMeta(null), TypeError);
  await assert.rejects(db.putMeta([1]), TypeError);
  db.close();
});

test('putMeta compare-and-swap on wrap.ct: vault-changed / vault-exists, nothing written on failure', async () => {
  const { db } = await fresh();
  const m1 = metaRec();
  await db.putMeta(m1, { expectWrapCt: null });
  await assert.rejects(db.putMeta(metaRec(), { expectWrapCt: null }), isCzd('vault-exists'));
  const m2 = { ...m1, wrap: { iv: randomBytes(12), ct: randomBytes(48) } };
  await assert.rejects(db.putMeta(m2, { expectWrapCt: randomBytes(48) }), isCzd('vault-changed'));
  assert.deepEqual(await db.getMeta(), m1, 'unchanged after a failed CAS');
  await db.putMeta(m2, { expectWrapCt: m1.wrap.ct.slice() });
  assert.deepEqual(await db.getMeta(), m2);
  await assert.rejects(db.putMeta(m1, { expectWrapCt: m1.wrap.ct }), isCzd('vault-changed'), 'old ct no longer matches');
  await assert.rejects(db.putMeta(m1, { expectWrapCt: 'nope' }), TypeError);
  // no vault at all → vault-changed for a Uint8Array expectation
  const { db: empty } = await fresh();
  await assert.rejects(empty.putMeta(m1, { expectWrapCt: m1.wrap.ct }), isCzd('vault-changed'));
  assert.equal(await empty.getMeta(), undefined);
  db.close();
  empty.close();
});

test('items/lists/thumbs: put/get/getAll/delete keyed by 32-hex id', async () => {
  const { db } = await fresh();
  const [i1, i2] = [itemRec(), itemRec()];
  await db.put('items', i1);
  await db.put('items', i2);
  await db.put('lists', listRec(i1.id));
  await db.put('thumbs', thumbRec(i1.id));
  assert.deepEqual(await db.get('items', i1.id), i1);
  assert.deepEqual((await db.getAll('items')).sort((x, y) => (x.id < y.id ? -1 : 1)), [i1, i2].sort((x, y) => (x.id < y.id ? -1 : 1)));
  assert.equal((await db.getAll('thumbs')).length, 1);
  await db.delete('items', i1.id);
  assert.equal(await db.get('items', i1.id), undefined);
  await db.delete('items', i1.id);
  // lookups of impossible ids are simply "not found"; writes of malformed records are refused
  assert.equal(await db.get('items', '../x'), undefined);
  await db.delete('items', 'nope');
  await assert.rejects(db.put('items', { id: 'ABC', iv: new Uint8Array(12) }), TypeError);
  await assert.rejects(db.put('items', { ...itemRec(), id: i2.id.toUpperCase() }), TypeError);
  await assert.rejects(db.put('items', itemRec(), 'other-key'), TypeError);
  await assert.rejects(db.put('nope', {}), TypeError);
  await assert.rejects(db.getAll('nope'), TypeError);
  await assert.rejects(db.put('kv', 1), TypeError, 'kv needs a key');
  db.close();
});

test('commit applies every op in ONE transaction; a failed CAS rolls all of them back', async () => {
  const { db } = await fresh();
  const m = metaRec();
  await db.putMeta(m);
  const a = itemRec();
  const b = itemRec();
  await db.put('items', b);
  await db.commit([
    { op: 'put', store: 'items', value: a },
    { op: 'put', store: 'lists', value: listRec() },
    { op: 'delete', store: 'items', key: b.id },
    { op: 'put', store: 'kv', key: 'merged:x', value: { n: 1 } },
  ]);
  assert.deepEqual((await db.getAll('items')).map((r) => r.id), [a.id]);
  assert.deepEqual(await db.kvGet('merged:x'), { n: 1 });
  const c = itemRec();
  const m2 = { ...m, wrap: { iv: randomBytes(12), ct: randomBytes(48) } };
  await assert.rejects(db.commit([{ op: 'put', store: 'items', value: c }, { op: 'put', store: 'meta', key: 'vault', value: m2 }], { expectWrapCt: randomBytes(48) }), isCzd('vault-changed'));
  assert.equal(await db.get('items', c.id), undefined, 'rolled back');
  assert.deepEqual(await db.getMeta(), m);
  await db.commit([{ op: 'put', store: 'items', value: c }, { op: 'put', store: 'meta', value: m2 }], { expectWrapCt: m.wrap.ct });
  assert.deepEqual(await db.get('items', c.id), c);
  assert.deepEqual(await db.getMeta(), m2);
  // restore-style commit into an empty database
  const { db: d2 } = await fresh();
  await d2.commit([{ op: 'put', store: 'meta', key: 'vault', value: m }, { op: 'put', store: 'items', value: a }, { op: 'put', store: 'thumbs', value: thumbRec(a.id) }], { expectWrapCt: null });
  await assert.rejects(d2.commit([{ op: 'put', store: 'items', value: b }], { expectWrapCt: null }), isCzd('vault-exists'));
  assert.equal(await d2.get('items', b.id), undefined);
  await d2.commit([]);
  for (const bad of [null, 'x', [{ op: 'upsert', store: 'items', value: a }], [{ op: 'delete', store: 'items' }], [{ op: 'put', store: 'meta', key: 'other', value: m }]]) {
    await assert.rejects(d2.commit(bad), TypeError);
  }
  db.close();
  d2.close();
});

test('kv: any structured value; undefined deletes; string keys only', async () => {
  const { db } = await fresh();
  assert.equal(await db.kvGet('dismissed'), undefined);
  await db.kvSet('dismissed', { banner: true, at: [1, 2] });
  assert.deepEqual(await db.kvGet('dismissed'), { banner: true, at: [1, 2] });
  await db.kvSet('legacy-import-done', true);
  await db.kvSet('dismissed', undefined);
  assert.equal(await db.kvGet('dismissed'), undefined);
  assert.equal(await db.kvGet('legacy-import-done'), true);
  await assert.rejects(db.kvSet(1, 1), TypeError);
  await assert.rejects(db.kvGet(null), TypeError);
  db.close();
});

test('clearAll empties every store, blobs included', async () => {
  const { db } = await fresh();
  await db.putMeta(metaRec());
  await db.put('items', itemRec());
  await db.put('lists', listRec());
  await db.put('thumbs', thumbRec());
  await db.kvSet('k', 1);
  await db.put('blobs', new Blob([new Uint8Array(3)]), [newId(), 0]);
  await db.clearAll();
  assert.equal(await db.getMeta(), undefined);
  for (const s of ['items', 'lists', 'thumbs', 'kv', 'blobs']) assert.deepEqual(await db.getAll(s), [], s);
  db.close();
});

test('close() and closed connections → store-unavailable', async () => {
  const { db } = await fresh();
  db.close();
  db.close();
  assert.equal(db.closed, true);
  await assert.rejects(db.getMeta(), isCzd('store-unavailable'));
  await assert.rejects(db.kvSet('a', 1), isCzd('store-unavailable'));
  await assert.rejects(db.commit([{ op: 'put', store: 'items', value: itemRec() }]), isCzd('store-unavailable'));
});

test('versionchange: the connection lets go at once (another tab can upgrade/delete) and reports it', async () => {
  const reasons = [];
  const { idb, db } = await fresh({ onClose: (r) => reasons.push(r) });
  await db.kvSet('a', 1);
  await new Promise((resolve, reject) => {
    const r = idb.open('czd-vault', 2);
    r.onblocked = () => reject(new Error('blocked by our open connection'));
    r.onsuccess = () => {
      r.result.close();
      resolve();
    };
    r.onerror = () => reject(r.error);
  });
  assert.deepEqual(reasons, ['versionchange']);
  assert.equal(db.closed, true);
  await assert.rejects(db.kvGet('a'), isCzd('store-unavailable'));
  // deleteDatabase is not blocked either
  const { idb: idb2, db: db2 } = await fresh({ onClose: (r) => reasons.push(r) });
  await new Promise((resolve, reject) => {
    const r = idb2.deleteDatabase('czd-vault');
    r.onblocked = () => reject(new Error('blocked'));
    r.onsuccess = () => resolve();
  });
  assert.equal(db2.closed, true);
  assert.deepEqual(reasons, ['versionchange', 'versionchange']);
});

test('a connection the browser closes (e.g. site data cleared) → onClose("closed") and store-unavailable', async () => {
  const reasons = [];
  const { db } = await fresh({ onClose: (r) => reasons.push(r) });
  forceCloseDatabase(db._conn);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(reasons, ['closed']);
  await assert.rejects(db.getMeta(), isCzd('store-unavailable'));
});

test('QuotaExceededError → quota-exceeded (transaction rolled back); other IDB failures are CzdErrors too', async () => {
  const { db } = await fresh();
  const realPut = IDBObjectStore.prototype.put;
  const a = itemRec();
  const b = itemRec();
  let n = 0;
  IDBObjectStore.prototype.put = function put(...args) {
    if (++n === 2) throw new DOMException('disk full', 'QuotaExceededError');
    return realPut.apply(this, args);
  };
  try {
    await assert.rejects(db.commit([{ op: 'put', store: 'items', value: a }, { op: 'put', store: 'items', value: b }]), isCzd('quota-exceeded'));
    n = 10;
    IDBObjectStore.prototype.put = function put() {
      throw new DOMException('cannot clone', 'DataCloneError');
    };
    await assert.rejects(db.kvSet('fn', 1), (e) => e instanceof CzdError && e.code === 'internal' && e.detail === 'DataCloneError');
  } finally {
    IDBObjectStore.prototype.put = realPut;
  }
  assert.deepEqual(await db.getAll('items'), [], 'nothing from the failed commit');
  // structured clone failures surface as CzdError, not DOMException
  await assert.rejects(db.kvSet('fn', () => 1), (e) => e instanceof CzdError);
  db.close();
});

test('exportSnapshot → JSON → importSnapshot rebuilds meta, items, lists and kv (thumbs and blobs excluded)', async () => {
  const { db } = await fresh();
  const m = metaRec({ storeKind: 'tauri-fs', rwrap: { iv: randomBytes(12), ct: randomBytes(48) }, lastBackupAt: 1700000001000 });
  const items = [itemRec(), itemRec(), itemRec()];
  const lists = [listRec(), listRec()];
  await db.putMeta(m);
  for (const r of items) await db.put('items', r);
  for (const r of lists) await db.put('lists', r);
  await db.put('thumbs', thumbRec(items[0].id));
  await db.put('blobs', new Blob([new Uint8Array(3)]), [items[0].id, 0]);
  await db.kvSet('dismissed', { legacy: true, nested: { bytes: new Uint8Array([1, 2, 3]) } });
  await db.kvSet('merged:aa:bb', newId());
  await db.kvSet('a-blob', new Blob(['x'])); // not JSON-safe: skipped
  const snap = await db.exportSnapshot();
  const text = JSON.stringify(snap);
  assert.ok(!text.includes('"thumbs"'));
  const parsed = JSON.parse(text);
  assert.equal(parsed.format, 'czd-vault-snapshot');
  assert.equal(parsed.v, 1);
  assert.equal(parsed.items.length, 3);
  assert.deepEqual(parsed.kv.map(([k]) => k).sort(), ['dismissed', 'merged:aa:bb']);
  assert.equal(typeof parsed.meta.vaultId.$b64, 'string');

  const { db: d2 } = await fresh();
  await d2.kvSet('stale', 1);
  await d2.put('thumbs', thumbRec());
  await d2.importSnapshot(parsed);
  assert.deepEqual(await d2.getMeta(), m);
  const byId = (x, y) => (x.id < y.id ? -1 : 1);
  assert.deepEqual((await d2.getAll('items')).sort(byId), [...items].sort(byId));
  assert.deepEqual((await d2.getAll('lists')).sort(byId), [...lists].sort(byId));
  assert.deepEqual(await d2.getAll('thumbs'), [], 'thumbs cleared (not in the snapshot)');
  assert.deepEqual(await d2.getAll('blobs'), []);
  assert.equal(await d2.kvGet('stale'), undefined, 'kv replaced');
  assert.deepEqual(await d2.kvGet('dismissed'), { legacy: true, nested: { bytes: new Uint8Array([1, 2, 3]) } });
  assert.deepEqual(JSON.parse(JSON.stringify(await d2.exportSnapshot())), parsed, 'stable');
  await assert.rejects(d2.importSnapshot(parsed), isCzd('vault-exists'), 'never over an existing vault');
  db.close();
  d2.close();
});

test('exportSnapshot of an empty database; importSnapshot rejects malformed snapshots with bad-meta', async () => {
  const { db } = await fresh();
  assert.deepEqual(await db.exportSnapshot(), { format: 'czd-vault-snapshot', v: 1, meta: null, items: [], lists: [], kv: [] });
  const src = await fresh();
  await src.db.putMeta(metaRec());
  await src.db.put('items', itemRec());
  const good = JSON.parse(JSON.stringify(await src.db.exportSnapshot()));
  const mutate = (fn) => {
    const s = structuredClone(good);
    fn(s);
    return s;
  };
  const bad = [
    null,
    'x',
    { ...good, format: 'other' },
    { ...good, v: 2 },
    { ...good, meta: null },
    { ...good, items: 'x' },
    mutate((s) => { s.meta.vaultId = { $b64: 'AAAA' }; }),
    mutate((s) => { s.meta.wrap.ct = { $b64: '***' }; }),
    mutate((s) => { s.meta.kdf = null; }),
    mutate((s) => { s.items[0].id = '../../x'; }),
    mutate((s) => { s.items[0].iv = 'AAAAAAAAAAAAAAAA'; }),
    mutate((s) => { s.items[0].storedBytes = -1; }),
    mutate((s) => { s.items.push(s.items[0]); }),
    mutate((s) => { s.kv = [['a']]; }),
    mutate((s) => { s.kv = [[1, 2]]; }),
    mutate((s) => { let deep = 1; for (let i = 0; i < 100; i++) deep = [deep]; s.kv = [['deep', deep]]; }),
  ];
  for (const s of bad) await assert.rejects(db.importSnapshot(s), isCzd('bad-meta'), JSON.stringify(s)?.slice(0, 80));
  assert.equal(await db.getMeta(), undefined, 'nothing written');
  // "__proto__" keys from JSON never reach a prototype
  const evil = JSON.parse(JSON.stringify(good).replace('"kv":[]', '"kv":[["x",{"__proto__":{"polluted":true},"ok":1}]]'));
  await db.importSnapshot(evil);
  const v = await db.kvGet('x');
  assert.deepEqual(v, { ok: 1 });
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(v), Object.prototype);
  db.close();
  src.db.close();
});
