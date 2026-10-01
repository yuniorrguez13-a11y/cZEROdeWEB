// app/legacy/oldvault.js on a fresh fake-indexeddb factory seeded with the exact records of the web vectors
// (czeroode_db v2: vault/files/playlists, keyPath 'id').
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { ROOT } from './helpers-phase0.js';
import {
  decodeOldItem, deleteOldDb, forgetPins, listOldItems, listOldPlaylists, probeOldVault, setIdb, tryPin,
} from '../../app/legacy/oldvault.js';
import { bytesToScript } from '../../app/crypto/stealth.js';
import { CzdError } from '../../app/errors.js';
import { fromB64, randomBytes, toB64, utf8 } from '../../app/util/bytes.js';
import { kindOf, safeFilename, safeMediaType } from '../../app/util/format.js';

const web = JSON.parse(readFileSync(path.join(ROOT, 'tests/vectors/legacy-web-vectors.json'), 'utf8'));
const IDB = web.indexeddb;
const code = (c) => (e) => e instanceof CzdError && e.code === c;
const sha256 = (u8) => createHash('sha256').update(u8).digest('hex');
const blobBytes = async (b) => new Uint8Array(await b.arrayBuffer());

const SINGLE = web.files.single_real_constants;
const BATCH = web.files.batched_reduced_constants;
const FILE_VECTORS = [...SINGLE, ...BATCH.vectors];
const PLAYLISTS = [...web.playlists.real_constants, ...web.playlists.reduced_constants];

/** Wraps a factory to record every connection it hands out and whether it was closed. */
function tracked(idb, { databases = true } = {}) {
  const open = new Set();
  const calls = { open: 0 };
  const f = {
    open(...a) {
      calls.open++;
      const req = idb.open(...a);
      req.addEventListener('success', () => {
        const db = req.result;
        open.add(db);
        const close = db.close.bind(db);
        db.close = () => { open.delete(db); close(); };
      });
      return req;
    },
    deleteDatabase: (n) => idb.deleteDatabase(n),
    cmp: (a, b) => idb.cmp(a, b),
  };
  if (databases) f.databases = () => idb.databases();
  return { f, open, calls };
}

async function seed(idb, { vault = [], files = [], playlists = [] } = {}) {
  assert.equal(IDB.db_name, 'czeroode_db');
  const names = Object.keys(IDB.stores);
  const db = await new Promise((resolve, reject) => {
    const r = idb.open(IDB.db_name, IDB.db_version);
    r.onupgradeneeded = () => {
      for (const n of names) r.result.createObjectStore(n, { keyPath: IDB.stores[n].keyPath, autoIncrement: IDB.stores[n].autoIncrement });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction(names, 'readwrite');
    for (const rec of vault) tx.objectStore('vault').put(rec);
    for (const rec of files) tx.objectStore('files').put(rec);
    for (const rec of playlists) tx.objectStore('playlists').put(rec);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

const dbNames = async (idb) => (await idb.databases()).map((d) => d.name);

async function seededAll() {
  const idb = new IDBFactory();
  await seed(idb, { vault: web.vault.map((v) => v.record), files: FILE_VECTORS.map((v) => v.record), playlists: PLAYLISTS.map((p) => p.record) });
  const t = tracked(idb);
  setIdb(t.f);
  return { idb, open: t.open };
}

test('probe on an empty factory returns null and never creates czeroode_db (with and without databases())', async () => {
  for (const databases of [true, false]) {
    const idb = new IDBFactory();
    const t = tracked(idb, { databases });
    setIdb(t.f);
    assert.equal(await probeOldVault(), null);
    await assert.rejects(listOldItems(), code('legacy-no-db'));
    await assert.rejects(tryPin('1234'), code('legacy-no-db'));
    await assert.rejects(decodeOldItem('files:1'), code('legacy-no-db'));
    await assert.rejects(listOldPlaylists(), code('legacy-no-db'));
    assert.deepEqual(await dbNames(idb), [], `databases() ${databases}`);
    assert.equal(t.open.size, 0);
    // With databases() nothing is opened; without it, the open-then-abort-and-delete path ran.
    assert.equal(t.calls.open > 0, !databases);
  }
  // An existing but empty old database is not reported either, and is left alone.
  const idb = new IDBFactory();
  await seed(idb);
  setIdb(tracked(idb, { databases: false }).f);
  assert.equal(await probeOldVault(), null);
  assert.deepEqual(await listOldItems(), []);
  assert.deepEqual(await dbNames(idb), ['czeroode_db']);
});

test('probe counts; list shows every record with sanitized names; nothing stays open', async () => {
  const { idb, open } = await seededAll();
  assert.deepEqual(await probeOldVault(), { notes: web.vault.length, files: FILE_VECTORS.length, playlists: PLAYLISTS.length });
  assert.equal(open.size, 0);
  const items = await listOldItems();
  assert.equal(open.size, 0);
  assert.equal(items.length, web.vault.length + FILE_VECTORS.length);
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const v of FILE_VECTORS) {
    const it = byId.get(`files:${v.record.id}`);
    assert.ok(it, v.label);
    assert.equal(it.store, 'files');
    assert.equal(it.name, safeFilename(v.record.name));
    assert.equal(it.kind, kindOf(v.record.mime, safeFilename(v.record.name)));
    assert.equal(it.size, v.record.size);
    assert.equal(it.date, v.record.date);
    assert.equal(it.chunked, v.record.isChunked);
    assert.equal(it.unlocked, false);
    assert.equal(it.format, 'v4');
  }
  const formats = { 'snack plan': ['v4', false], 'json-looking plaintext': ['v4', false], 'v2 thing': ['v2', true], 'v3 thing': ['v3', false] };
  for (const v of web.vault) {
    const it = byId.get(`vault:${v.record.id}`);
    assert.equal(it.store, 'vault');
    assert.equal(it.kind, 'note');
    assert.equal(it.name, safeFilename(v.record.name));
    assert.equal(it.ver, v.record.ver);
    assert.equal(it.date, v.record.date);
    const [format, unlocked] = formats[v.record.name] ?? ['plain', true]; // the BUG record holds plaintext
    assert.equal(it.format, format, v.label);
    assert.equal(it.unlocked, unlocked, v.label);
  }
  // The plaintext of a v4 note is never longer than its blob says.
  assert.equal(byId.get(`vault:${web.vault[0].record.id}`).size, utf8(web.vault[0].plaintext).length);
  assert.deepEqual(await dbNames(idb), ['czeroode_db']);
});

test('tryPin unlocks exactly the records of that PIN; every file decodes to the recorded bytes', async () => {
  const { open } = await seededAll();
  await listOldItems();
  const pins = [...new Set(FILE_VECTORS.map((v) => v.pin))];
  for (const pin of pins) {
    const ids = await tryPin(pin);
    const want = FILE_VECTORS.filter((v) => v.pin === pin).map((v) => `files:${v.record.id}`);
    assert.deepEqual(ids.filter((id) => id.startsWith('files:')).sort(), want.sort(), pin);
    assert.deepEqual(await tryPin(pin), [], `${pin} again`);
  }
  assert.equal(open.size, 0);
  for (const v of FILE_VECTORS) {
    const r = await decodeOldItem(`files:${v.record.id}`);
    const bytes = await blobBytes(r.blob);
    assert.equal(sha256(bytes), v.expected_plaintext_sha256, v.label);
    assert.deepEqual(bytes, fromB64(v.expected_plaintext_b64), v.label);
    assert.equal(r.name, safeFilename(v.record.name));
    const mime = v.original_decrypt.mime ?? JSON.parse(v.decrypted_payload_json).mime;
    assert.equal(r.type, mime, v.label);
    assert.equal(r.blob.type, safeMediaType(mime));
    assert.equal(r.mtime, v.record.date);
    if (v.original_decrypt.bytes_len !== undefined) assert.equal(bytes.length, v.original_decrypt.bytes_len);
  }
  // The 0-byte file the original could not save.
  const empty = SINGLE.find((v) => v.input_file.size === 0);
  assert.ok(empty.original_decrypt.BUG);
  assert.equal((await decodeOldItem(`files:${empty.record.id}`)).blob.size, 0);
  assert.equal(open.size, 0);
  assert.ok((await listOldItems()).filter((i) => i.store === 'files').every((i) => i.unlocked));
});

test('wrong PIN, PIN spellings, forgetPins', async () => {
  await seededAll();
  const wp = web.files.wrong_pin;
  assert.equal(wp.original_result.ok, false);
  assert.deepEqual(await tryPin(wp.pin), []);
  await assert.rejects(decodeOldItem(`files:${wp.record_id}`), code('legacy-wrong-pin'));
  assert.deepEqual(await tryPin(''), []);
  // Typed with spaces around it: the trimmed spelling opens the '1234' records. The exact spelling is 7 units
  // long, which is all the v3 note can be checked against (its pin_hint is '7 chars').
  const ids = await tryPin('  1234 ');
  const v3 = web.vault.find((v) => v.record.ver === 'v3').record;
  assert.equal(v3.pin_hint, '7 chars');
  assert.deepEqual(ids.sort(), [...FILE_VECTORS.filter((v) => v.pin === '1234').map((v) => `files:${v.record.id}`), `vault:${v3.id}`].sort());
  const nfd = FILE_VECTORS.find((v) => v.pin === 'pässwörd🔑');
  assert.ok((await tryPin(nfd.pin.normalize('NFD'))).includes(`files:${nfd.record.id}`));
  await decodeOldItem(`files:${nfd.record.id}`);
  forgetPins();
  await assert.rejects(decodeOldItem(`files:${nfd.record.id}`), code('legacy-wrong-pin'));
  assert.ok((await listOldItems()).filter((i) => i.store === 'files').every((i) => !i.unlocked));
  await assert.rejects(decodeOldItem('files:does-not-exist'), code('item-not-found'));
});

test('vault notes: v4, plaintext-saved, JSON-looking, v2, v3 (+ invalid placeholder)', async () => {
  const idb = new IDBFactory();
  const base = { pin_hint: '', date: 1790812128400, size: 0 };
  const extra = [
    { ...base, id: 'x1', name: 'v2 failed', ver: 'v2', cipher: 'could not decode' },
    { ...base, id: 'x2', name: 'v2 after decode', ver: 'v2', cipher: 'nello vault' },
    { ...base, id: 'x3', name: 'v3 after decode', ver: 'v3', cipher: 'hello vault', pin_hint: '7 chars' },
    { ...base, id: 'x4', name: 'no cipher', ver: 'cz' },
    { ...base, id: 'x5', name: '<img src=x onerror=alert(1)>', ver: 'cz', cipher: 'plain text' },
  ];
  await seed(idb, { vault: [...web.vault.map((v) => v.record), ...extra] });
  setIdb(tracked(idb).f);
  const id = (rec) => `vault:${rec.id}`;
  const [v4a, bug, json, v2, v3] = web.vault;

  // No PIN needed: the plaintext-saved note and the v2 note.
  assert.deepEqual(await decodeOldItem(id(bug.record)), { note: { title: safeFilename(bug.record.name), body: bug.plaintext }, plaintextNote: true });
  assert.equal(bug.original_vault_modal.ok, false);
  assert.deepEqual(await decodeOldItem(id(v2.record)), { note: { title: safeFilename(v2.record.name), body: v2.v2sdec_of_cipher.text } });
  assert.deepEqual(await decodeOldItem('vault:x2'), { note: { title: safeFilename('v2 after decode'), body: 'nello vault' }, plaintextNote: true });
  assert.deepEqual(await decodeOldItem('vault:x3'), { note: { title: safeFilename('v3 after decode'), body: 'hello vault' }, plaintextNote: true });
  assert.deepEqual(await decodeOldItem('vault:x5'), { note: { title: safeFilename('<img src=x onerror=alert(1)>'), body: 'plain text' }, plaintextNote: true });
  await assert.rejects(decodeOldItem('vault:x1'), code('legacy-bad-record'));
  await assert.rejects(decodeOldItem('vault:x4'), code('legacy-bad-record'));
  const list = await listOldItems();
  assert.equal(list.find((i) => i.id === 'vault:x1').format, 'bad');
  assert.equal(list.find((i) => i.id === 'vault:x1').unlocked, false);

  // PIN-locked notes.
  for (const v of [v4a, json, v3]) await assert.rejects(decodeOldItem(id(v.record)), code('legacy-wrong-pin'));
  assert.deepEqual(await tryPin('nope'), []); // a 4-char PIN does not even match the v3 note's '7 chars' hint
  assert.deepEqual(await tryPin(v4a.pin), [id(v4a.record)]);
  assert.deepEqual(await decodeOldItem(id(v4a.record)), { note: { title: safeFilename(v4a.record.name), body: v4a.plaintext } });
  assert.equal(v4a.original_vault_modal.shown_text, v4a.plaintext);
  assert.deepEqual(await tryPin(json.pin), [id(json.record)]);
  assert.deepEqual(await decodeOldItem(id(json.record)), { note: { title: safeFilename(json.record.name), body: json.plaintext } });
  assert.deepEqual(await tryPin(v3.pin), [id(v3.record)]);
  assert.deepEqual(await decodeOldItem(id(v3.record)), { note: { title: safeFilename(v3.record.name), body: v3.v3sd_of_cipher } });
  assert.equal(v3.v3sd_of_cipher, v3.plaintext);
});

test('batched records: chunk order, truncation, duplicates, splices', async () => {
  const clip = BATCH.vectors.find((v) => v.record.isChunked && v.record.chunks.length === 4);
  const other = BATCH.vectors.find((v) => v.record.isChunked && v.pin !== clip.pin);
  const c = clip.record.chunks;
  const variants = {
    order: [c[2], c[0], c[3], c[1]],
    truncated: c.slice(0, 3),
    duplicate: [c[0], c[1], c[2], c[2]],
    extra: [...c, c[3]],
    spliced: [c[0], c[1], c[2], other.record.chunks[2]],
    empty: [],
    garbage: [c[0], 'not ciphertext!', c[2], c[3]],
  };
  const idb = new IDBFactory();
  await seed(idb, { files: Object.entries(variants).map(([k, chunks]) => ({ ...clip.record, id: k, chunks })) });
  setIdb(tracked(idb).f);
  const unlocked = await tryPin(clip.pin);
  assert.deepEqual(unlocked.sort(), ['files:duplicate', 'files:extra', 'files:garbage', 'files:order', 'files:spliced', 'files:truncated']);
  const r = await decodeOldItem('files:order');
  assert.equal(sha256(await blobBytes(r.blob)), BATCH.chunk_order_test.expected_sha256);
  assert.equal(BATCH.chunk_truncation_test.bytes_len, 1200); // what the original silently returned
  await assert.rejects(decodeOldItem('files:truncated'), code('legacy-missing-chunks'));
  await assert.rejects(decodeOldItem('files:duplicate'), code('legacy-missing-chunks'));
  await assert.rejects(decodeOldItem('files:extra'), code('legacy-missing-chunks'));
  await assert.rejects(decodeOldItem('files:spliced'), code('legacy-bad-record'));
  await assert.rejects(decodeOldItem('files:garbage'), code('legacy-bad-record'));
  await assert.rejects(decodeOldItem('files:empty'), code('legacy-bad-record'));
});

test('playlists: dangling ids dropped, tracks decode like the old player', async () => {
  const { open } = await seededAll();
  const lists = await listOldPlaylists();
  assert.equal(open.size, 0);
  assert.equal(lists.length, PLAYLISTS.length);
  const files = new Set(FILE_VECTORS.map((v) => v.record.id));
  for (const p of PLAYLISTS) {
    const l = lists.find((x) => x.id === p.record.id);
    assert.equal(l.name, safeFilename(p.record.name));
    assert.deepEqual(l.itemIds, p.record.fileIds.filter((id) => files.has(id)).map((id) => `files:${id}`));
    await tryPin(p.pin);
    assert.equal(l.itemIds.length, p.original_player_tracks.length);
    for (const [i, track] of p.original_player_tracks.entries()) {
      const r = await decodeOldItem(l.itemIds[i]);
      const bytes = await blobBytes(r.blob);
      assert.equal(r.name, safeFilename(track.name));
      assert.equal(r.type, track.mime);
      assert.equal(bytes.length, track.size);
      assert.equal(sha256(bytes), track.sha256);
    }
  }
  assert.ok(web.playlists.real_constants[0].record.fileIds.includes('missing-id-123'));
});

test('deleteOldDb removes the database and forgets everything', async () => {
  const { idb, open } = await seededAll();
  await tryPin('1234');
  await deleteOldDb();
  assert.equal(open.size, 0);
  assert.deepEqual(await dbNames(idb), []);
  assert.equal(await probeOldVault(), null);
  await assert.rejects(listOldItems(), code('legacy-no-db'));
  assert.deepEqual(await dbNames(idb), []);
});

// genBytes from legacy-web.md §8 (xorshift32, logical shifts).
function genBytes(n, seed) {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

async function sealV4(text, pin) {
  const subtle = globalThis.crypto.subtle;
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const base = await subtle.importKey('raw', utf8(pin), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8(text)));
  const blob = new Uint8Array(28 + ct.length);
  blob.set(salt, 0);
  blob.set(iv, 16);
  blob.set(ct, 28);
  return bytesToScript(blob);
}

test('real-size batched record (15 740 985 bytes, 4 × 5 MiB chunks) rebuilt from the summary vector', async () => {
  const s = web.files.batched_real_constants_summary;
  const bytes = genBytes(s.input_file.size, 0xc0ffee);
  assert.equal(sha256(bytes), s.expected_plaintext_sha256);
  const CHUNK = web.constants.CHUNK_SIZE;
  const rec = s.record_without_chunks;
  const name = s.input_file.name.replace(/\.[^.]+$/, '');
  const chunks = [];
  for (const meta of s.chunks) {
    const slice = bytes.subarray(meta.index * CHUNK, (meta.index + 1) * CHUNK);
    assert.equal(sha256(slice), meta.data_sha256);
    const data = toB64(slice);
    assert.equal(data.length, meta.data_b64_len);
    const json = JSON.stringify({ v: 1, type: 'chunk', index: meta.index, totalChunks: s.chunks_count, data, mime: rec.mime, name, ext: rec.ext });
    assert.equal(json.replace(data, '<base64 elided>'), meta.payload_json_elided);
    chunks.push(await sealV4(json, s.pin));
    assert.equal(chunks.at(-1).length, meta.cipher_chars);
  }
  const record = { ...rec, chunks };
  assert.deepEqual(Object.keys(record).sort(), [...s.record_keys].sort());
  const idb = new IDBFactory();
  await seed(idb, { files: [record] });
  setIdb(tracked(idb).f);
  assert.deepEqual(await tryPin(s.pin), [`files:${rec.id}`]);
  const r = await decodeOldItem(`files:${rec.id}`);
  assert.equal(r.blob.size, s.original_decrypt.bytes_len);
  assert.equal(sha256(await blobBytes(r.blob)), s.original_decrypt.sha256);
  assert.equal(r.type, s.original_decrypt.mime);
  assert.equal(r.name, safeFilename(rec.name));
  assert.equal(s.original_decrypt.download_name, rec.name);
});

// ───────── review regressions

/** Makes every transaction the tracked factory hands out go through patch(tx, realTransaction, args). */
function patchTransactions(t, patch) {
  const open = t.f.open;
  t.f.open = (...a) => {
    const req = open(...a);
    req.addEventListener('success', () => {
      const db = req.result;
      const real = db.transaction.bind(db);
      db.transaction = (...args) => patch(real, args);
    });
    return req;
  };
}

/** patch(store) on every object store of a transaction. */
const patchStores = (patch) => (real, args) => {
  const tx = real(...args);
  const os = tx.objectStore.bind(tx);
  tx.objectStore = (n) => patch(os(n));
  return tx;
};

test('forgetPins during an in-flight tryPin: nothing stays remembered', async () => {
  await seededAll();
  await listOldItems();
  const v = SINGLE[0];
  const pending = tryPin(v.pin); // PBKDF2 runs after this returns
  forgetPins(); // e.g. the vault locked (purge) meanwhile
  assert.deepEqual(await pending, []);
  await assert.rejects(decodeOldItem(`files:${v.record.id}`), code('legacy-wrong-pin'));
  assert.ok((await listOldItems()).every((i) => !i.unlocked || !['v4', 'v3'].includes(i.format)));
  // A decode already past the PIN check when forgetPins() runs does not hand back plaintext afterwards.
  const clip = BATCH.vectors.find((x) => x.record.isChunked);
  for (const rec of [v.record, clip.record]) {
    const idb = new IDBFactory();
    await seed(idb, { files: [rec] });
    const t = tracked(idb);
    let hook = null;
    patchTransactions(t, patchStores((st) => {
      const get = st.get.bind(st);
      st.get = (k) => { const r = get(k); hook?.(); return r; };
      return st;
    }));
    setIdb(t.f);
    const pin = rec === v.record ? v.pin : clip.pin;
    assert.deepEqual(await tryPin(pin), [`files:${rec.id}`]);
    assert.ok((await decodeOldItem(`files:${rec.id}`)).blob);
    hook = () => forgetPins(); // the record is being read: the PIN check already passed
    await assert.rejects(decodeOldItem(`files:${rec.id}`), code('aborted'), rec.id);
    hook = null;
    await assert.rejects(decodeOldItem(`files:${rec.id}`), code('legacy-wrong-pin'));
  }
});

test('deleteOldDb while another tab holds czeroode_db open: rejects other-tab instead of hanging', async () => {
  const { idb } = await seededAll();
  // An old-app tab: a connection that ignores versionchange.
  const blocker = await new Promise((resolve, reject) => {
    const r = idb.open('czeroode_db');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const outcome = await Promise.race([deleteOldDb().then(() => 'deleted', (e) => e), new Promise((r) => setTimeout(() => r('hung'), 2000))]);
  assert.ok(outcome instanceof CzdError && outcome.code === 'other-tab', String(outcome));
  blocker.close(); // the queued delete completes once the other tab lets go
  for (let i = 0; i < 50 && (await dbNames(idb)).length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(await dbNames(idb), []);
  assert.equal(await probeOldVault(), null);
});

test('IndexedDB failures surface as CzdError, never raw DOMExceptions', async () => {
  const idb = new IDBFactory();
  await seed(idb, { files: [SINGLE[0].record], playlists: [PLAYLISTS[0].record] });
  const t = tracked(idb);
  let mode = 'tx';
  const storeFails = patchStores((st) => {
    st.getAllKeys = () => { throw new DOMException('nope', 'UnknownError'); };
    return st;
  });
  patchTransactions(t, (real, args) => {
    if (mode === 'tx') throw new DOMException('closing', 'InvalidStateError');
    return storeFails(real, args);
  });
  setIdb(t.f);
  const isCzd = (e) => e instanceof CzdError;
  await assert.rejects(listOldItems(), isCzd);
  await assert.rejects(listOldPlaylists(), isCzd);
  assert.equal(await probeOldVault(), null);
  mode = 'store';
  await assert.rejects(listOldPlaylists(), isCzd);
  assert.equal(t.open.size, 0);
});

test('chunks spliced from another file with the same PIN, or with inconsistent sizes, are rejected', async () => {
  const clip = BATCH.vectors.find((v) => v.record.isChunked && v.record.chunks.length === 4);
  const bytes = fromB64(clip.expected_plaintext_b64);
  const { mime, name, ext } = JSON.parse(clip.decrypted_payload_jsons[3]);
  const meta = { mime, name, ext };
  const CH = 400; // reduced-constants CHUNK_SIZE of this vector set
  assert.equal(BATCH.constants.CHUNK_SIZE, CH);
  const chunk = (i, slice, over = {}) => sealV4(JSON.stringify({ v: 1, type: 'chunk', index: i, totalChunks: 4, data: toB64(slice), ...meta, ...over }), clip.pin);
  const c = clip.record.chunks;
  const good = await chunk(3, bytes.subarray(3 * CH));
  const records = {
    resealed: [c[0], c[1], c[2], good],
    otherName: [c[0], c[1], c[2], await chunk(3, bytes.subarray(3 * CH), { name: 'someone else' })],
    otherMime: [c[0], c[1], c[2], await chunk(3, bytes.subarray(3 * CH), { mime: 'image/png' })],
    shortMiddle: [c[0], await chunk(1, bytes.subarray(CH, 2 * CH - 1)), c[2], c[3]],
    longLast: [c[0], c[1], c[2], await chunk(3, bytes.subarray(0, CH + 1))],
  };
  const idb = new IDBFactory();
  await seed(idb, { files: Object.entries(records).map(([id, chunks]) => ({ ...clip.record, id, chunks })) });
  setIdb(tracked(idb).f);
  assert.equal((await tryPin(clip.pin)).length, 5);
  assert.equal(sha256(await blobBytes((await decodeOldItem('files:resealed')).blob)), clip.expected_plaintext_sha256);
  for (const id of ['otherName', 'otherMime', 'shortMiddle', 'longLast']) await assert.rejects(decodeOldItem(`files:${id}`), code('legacy-bad-record'), id);
});

test("'cz' notes: text with whitespace (e.g. Georgian prose saved after a decrypt) is a plaintext note", async () => {
  const prose = 'გამარჯობა მეგობარო '.repeat(4).trim(); // 68 stealth letters: decodes as base64 once spaces are dropped
  const cipher = web.vault[0].record.cipher;
  const idb = new IDBFactory();
  const base = { ver: 'cz', pin_hint: '1 chars', date: 1, size: 0 };
  await seed(idb, { vault: [{ ...base, id: 'p', name: 'prose', cipher: prose }, { ...base, id: 'c', name: 'cipher', cipher }] });
  setIdb(tracked(idb).f);
  const list = await listOldItems();
  assert.equal(list.find((i) => i.id === 'vault:p').format, 'plain');
  assert.equal(list.find((i) => i.id === 'vault:c').format, 'v4');
  assert.deepEqual(await decodeOldItem('vault:p'), { note: { title: 'prose', body: prose }, plaintextNote: true });
});

test('old file records never yield the app pseudo-types (note / bundle)', async () => {
  const v = SINGLE[0];
  const idb = new IDBFactory();
  await seed(idb, { files: [{ ...v.record, id: 'n', mime: 'application/x-czd-note' }] });
  setIdb(tracked(idb).f);
  const [item] = await listOldItems();
  assert.equal(item.kind, kindOf('', item.name)); // classified by its name only, never as a vault note
  await tryPin(v.pin);
  const r = await decodeOldItem('files:n');
  assert.equal(r.type, JSON.parse(v.decrypted_payload_json).mime); // the payload's own (real) type wins
});
