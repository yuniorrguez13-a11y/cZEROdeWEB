// app/vault/store.js in Node: the shared ContainerStore conformance suite (tests/unit/store-conformance.js) against
// MemoryStore and IdbBlobStore (fake-indexeddb), IdbBlobStore internals (markers, segments, sweeps), and
// probeBestKind/openStore outside the browser. TauriFsStore runs in store-tauri.test.js (needs the fake first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { openVaultDb } from '../../app/vault/db.js';
import { IdbBlobStore, MemoryStore, openStore, probeBestKind } from '../../app/vault/store.js';
import { CzdError } from '../../app/errors.js';
import { randomBytes } from '../../app/util/bytes.js';
import { collectBytes, makeAssert, newId, pieces, storeCases } from './store-conformance.js';

const MiB = 2 ** 20;
const H = 3600 * 1000;
const T0 = 1_700_000_000_000;
const isCzd = (code) => (e) => e instanceof CzdError && e.code === code;
const a = makeAssert({ ok: (c, m) => assert.ok(c, m), equal: (x, y, m) => assert.equal(x, y, m) });

function clock() {
  const c = { offset: 0 };
  c.now = () => T0 + c.offset;
  c.advance = (ms) => {
    c.offset += ms;
  };
  return c;
}

const freshDb = () => openVaultDb({ idb: new IDBFactory(), IDBKeyRange });

const BACKENDS = [
  {
    name: 'MemoryStore',
    caps: { blob: true, stage: true, big: true },
    async make() {
      const c = clock();
      return { store: new MemoryStore({ now: c.now }), advance: c.advance };
    },
  },
  {
    name: 'IdbBlobStore',
    caps: { blob: true, stage: true, big: true },
    async make() {
      const c = clock();
      const db = await freshDb();
      const store = new IdbBlobStore(db, { now: c.now });
      await store.init();
      return { store, advance: c.advance, cleanup: () => db.close() };
    },
  },
];

for (const b of BACKENDS) {
  for (const c of storeCases(b.caps)) {
    test(`${b.name}: ${c.name}`, async () => {
      const env = await b.make();
      try {
        await c.fn(a, env);
      } finally {
        await env.cleanup?.();
      }
    });
  }
}

test('probeBestKind outside the browser and Tauri → idb', async () => {
  assert.equal(await probeBestKind(), 'idb');
});

test('openStore: idb needs the db; unknown kinds, opfs without OPFS and tauri-fs outside Tauri → store-unavailable', async () => {
  const db = await freshDb();
  const s = await openStore('idb', { db });
  assert.equal(s.kind, 'idb');
  assert.ok(s instanceof IdbBlobStore);
  await assert.rejects(openStore('idb', {}), isCzd('store-unavailable'));
  await assert.rejects(openStore('idb'), isCzd('store-unavailable'));
  await assert.rejects(openStore('opfs', { db }), isCzd('store-unavailable'));
  await assert.rejects(openStore('tauri-fs', { db }), isCzd('store-unavailable'));
  await assert.rejects(openStore('memory', { db }), isCzd('store-unavailable'));
  await assert.rejects(openStore(undefined, { db }), isCzd('store-unavailable'));
  db.close();
  await assert.rejects(openStore('idb', { db }), isCzd('store-unavailable'), 'closed db');
  await assert.rejects(s.source(newId()), isCzd('store-unavailable'), 'store on a closed db');
  const noRange = await openVaultDb({ idb: new IDBFactory(), IDBKeyRange: null });
  await assert.rejects(openStore('idb', { db: noRange }), isCzd('store-unavailable'), 'no IDBKeyRange');
  noRange.close();
});

/** Raw [key, value] rows of the blobs store. */
async function rawBlobs(db) {
  return db.tx(['blobs'], 'readonly', (tx) => {
    const k = tx.objectStore('blobs').getAllKeys();
    const v = tx.objectStore('blobs').getAll();
    return () => k.result.map((key, i) => [key, v.result[i]]);
  });
}

test('IdbBlobStore: 16 MiB Blob segments under [id, seg] and a done marker at [id, -1]', async () => {
  const db = await freshDb();
  const s = new IdbBlobStore(db, { now: () => T0 });
  const id = newId();
  const data = randomBytes(33 * MiB + 5);
  await s.write(id, pieces(data, [3 * MiB + 1]));
  const rows = await rawBlobs(db);
  assert.deepEqual(rows.map(([k]) => k), [[id, -1], [id, 0], [id, 1], [id, 2]]);
  assert.deepEqual(rows[0][1], { v: 1, mtime: T0, done: true, size: data.length, segs: 3 });
  assert.deepEqual(rows.slice(1).map(([, v]) => v.size), [16 * MiB, 16 * MiB, MiB + 5]);
  assert.ok(rows.slice(1).every(([, v]) => v instanceof Blob));
  const src = await s.source(id);
  assert.equal(src.blob.size, data.length);
  assert.deepEqual(await src.readAt(16 * MiB - 2, 4), data.subarray(16 * MiB - 2, 16 * MiB + 2));
  assert.deepEqual(await s.list(), [{ id, size: data.length, mtime: T0 }]);
  // A Blob source is cut into slices without reading it.
  const id2 = newId();
  await s.write(id2, new Blob([data]));
  assert.deepEqual(new Uint8Array(await (await s.source(id2)).blob.arrayBuffer()), data);
  db.close();
});

test('IdbBlobStore: a write in progress is invisible; missing segments → item-file-missing', async () => {
  const db = await freshDb();
  let t = T0;
  const s = new IdbBlobStore(db, { now: () => t });
  const id = newId();
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  async function* paused() {
    yield randomBytes(17 * MiB);
    await gate;
    yield randomBytes(10);
  }
  const writing = s.write(id, paused());
  // wait until the first segment is stored
  for (let i = 0; i < 200 && (await rawBlobs(db)).length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(s.source(id), isCzd('item-file-missing'), 'half-written container is not readable');
  assert.deepEqual(await s.list(), [], 'and not listed');
  t += 30 * 60 * 1000;
  assert.deepEqual(await s.sweep({ knownIds: [] }), { tmp: 0, orphans: 0 }, 'a recent write in progress is not an orphan');
  t += 2 * H;
  assert.deepEqual(await s.sweep({ knownIds: [] }), { tmp: 0, orphans: 1 }, 'one without progress for 2 h is');
  release();
  await assert.rejects(writing, isCzd('item-file-missing'), 'the writer notices its marker is gone');
  assert.deepEqual(await rawBlobs(db), [], 'and nothing is left');
  db.close();
});

test('IdbBlobStore: corrupt or partial segment sets are never served; markerless segments are swept', async () => {
  const db = await freshDb();
  const s = new IdbBlobStore(db, { now: () => T0 });
  const id = newId();
  await s.write(id, randomBytes(17 * MiB));
  await db.tx(['blobs'], 'readwrite', (tx) => tx.objectStore('blobs').delete([id, 1]));
  await assert.rejects(s.source(id), isCzd('item-file-missing'));
  const stray = newId();
  await db.put('blobs', new Blob([new Uint8Array(3)]), [stray, 0]);
  await db.put('blobs', new Blob([new Uint8Array(3)]), ['not-an-id', 0]);
  const r = await s.sweep({ knownIds: [id] });
  assert.deepEqual(r, { tmp: 0, orphans: 1 }, 'markerless stray segments go; known ids and foreign keys stay');
  const keys = (await rawBlobs(db)).map(([k]) => k[0]);
  assert.ok(!keys.includes(stray));
  assert.ok(keys.includes(id) && keys.includes('not-an-id'));
  db.close();
});

test('IdbBlobStore: staged outputs live under tmp:<random>; estimate falls back to Σ sizes without navigator.storage', async () => {
  const db = await freshDb();
  const s = new IdbBlobStore(db, { now: () => T0 });
  const f = await s.stage('photo.jpg.czd', randomBytes(1000));
  assert.equal(f.name, 'photo.jpg.czd');
  const g = await s.stage('photo.jpg.czd', randomBytes(10));
  assert.equal(f.size, 1000);
  assert.equal(g.size, 10);
  const keys = [...new Set((await rawBlobs(db)).map(([k]) => k[0]))];
  assert.equal(keys.length, 2);
  assert.ok(keys.every((k) => /^tmp:[0-9a-f]{32}$/.test(k)), keys.join());
  await s.write(newId(), randomBytes(500));
  assert.deepEqual(await s.estimate(), { usage: 1510, quota: null, persisted: null });
  assert.equal((await s.list()).length, 1);
  db.close();
});

test('IdbBlobStore: quota errors from IndexedDB become quota-exceeded and the partial container is removed', async () => {
  const db = await freshDb();
  const s = new IdbBlobStore(db, { now: () => T0 });
  const id = newId();
  // Make the second segment's transaction fail like a full disk does.
  const realTx = db.tx.bind(db);
  let segPuts = 0;
  db.tx = (names, mode, fn) => realTx(names, mode, (tx, abort) => {
    const os = tx.objectStore('blobs');
    const put = os.put.bind(os);
    os.put = (v, k) => {
      if (v instanceof Blob && ++segPuts === 2) throw new DOMException('full', 'QuotaExceededError');
      return put(v, k);
    };
    return fn(tx, abort);
  });
  await assert.rejects(s.write(id, randomBytes(20 * MiB)), isCzd('quota-exceeded'));
  db.tx = realTx;
  assert.deepEqual(await rawBlobs(db), [], 'nothing left behind');
  db.close();
});

test('MemoryStore keeps its phase-0 behaviour: quota option, staging, list rows', async () => {
  const s = new MemoryStore({ quota: 1000, now: () => 5 });
  const id = newId();
  await s.write(id, new Uint8Array(600));
  await assert.rejects(s.write(newId(), new Uint8Array(500)), isCzd('quota-exceeded'));
  assert.deepEqual(await s.list(), [{ id, size: 600, mtime: 5 }]);
  assert.deepEqual(await s.estimate(), { usage: 600, quota: 1000, persisted: false });
  assert.equal(s.kind, 'memory');
  const src = await s.source(id);
  assert.deepEqual(await collectBytes(src.stream()), new Uint8Array(600));
});

test('IdbBlobStore: staged File names are sanitized (no path separators or control characters)', async () => {
  const db = await freshDb();
  const s = new IdbBlobStore(db, { now: () => T0 });
  const { safeFilename } = await import('../../app/util/format.js');
  for (const name of ['../../evil/x.czd', 'a\u0000b‮c.czd', 'CON', '']) {
    const f = await s.stage(name, randomBytes(3));
    assert.equal(f.name, safeFilename(name), JSON.stringify(name));
    assert.ok(!/[\\/\u0000-\u001f‮]/.test(f.name), f.name);
  }
  db.close();
});
