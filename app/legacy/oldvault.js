// Read-only access to the old web vault: IndexedDB 'czeroode_db' (version 2; stores vault, files, playlists,
// keyPath 'id'), legacy-web.md §2. Never creates the database, never writes to it (except deleteOldDb) and
// never keeps a connection open between calls. Item ids are opaque: '<store>:<record id>'.
// Remembered PIN spellings and derived keys live in memory until forgetPins() (the view calls it on purge).

import { CzdError } from '../errors.js';
import { fromB64, utf8 } from '../util/bytes.js';
import { kindOf, safeFilename, safeMediaType } from '../util/format.js';
import { decodeV2, decodeV3, isV2C } from './mixed.js';
import { cleanMime } from './oldczd.js';
import { MIN_BLOB, legacyUtf8, openV4, pinVariants, precheckV4, saltHex, v4Blob, v4Head, v4Keys } from './v4.js';

const DB_NAME = 'czeroode_db';
const NEEDS_PIN = new Set(['v4file', 'v4note', 'v3note']);
const FORMAT = { v4file: 'v4', v4note: 'v4', v3note: 'v3', v2note: 'v2', plain: 'plain', bad: 'bad' };
const PARALLEL = 4;

let idbOverride = null;
/** @type {Map<string, Entry>|null} one read of the DB (names, heads of ciphertexts; no secrets) */
let index = null;
/** id → the PIN spelling that unlocked it */
const pins = new Map();
/** salt hex → keys derived from a PIN that unlocked that blob */
const keys = new Map();
/** Bumped by forgetPins(): work started before it must not remember PINs or hand back plaintext. */
let generation = 0;

/**
 * @typedef {{id: string, store: 'vault'|'files', key: string|number, name: string, kind: string, size: number,
 *   date: number, chunked: boolean, ver?: string, mode: string, blob?: Uint8Array, hintLen?: number|null}} Entry
 */

/**
 * Injects the IDBFactory to use (tests); null restores globalThis.indexedDB. Clears all cached state.
 * @param {IDBFactory|null} factory
 */
export function setIdb(factory) {
  idbOverride = factory || null;
  index = null;
  forgetPins();
}

function idbFactory() {
  const f = idbOverride ?? globalThis.indexedDB;
  if (!f) throw new CzdError('legacy-no-db');
  return f;
}

// Rejects 'other-tab' when another connection (an old-app tab never closes its own) blocks the delete; the
// request stays queued and completes once that tab lets go.
function deleteDb(idb) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = idb.deleteDatabase(DB_NAME);
    } catch (e) {
      reject(new CzdError('legacy-no-db', { cause: e }));
      return;
    }
    req.onsuccess = () => resolve();
    req.onerror = () => reject(new CzdError('legacy-no-db', { cause: req.error }));
    req.onblocked = () => reject(new CzdError('other-tab'));
  });
}

// Opens czeroode_db at its current version. An upgrade can only mean it did not exist: the upgrade is
// aborted and the (empty) database deleted again, so probing never leaves one behind. Resolves null then.
function openExisting(idb) {
  return new Promise((resolve, reject) => {
    let fresh = false;
    let req;
    try {
      req = idb.open(DB_NAME);
    } catch (e) {
      reject(new CzdError('legacy-no-db', { cause: e }));
      return;
    }
    const gone = () => deleteDb(idb).then(() => resolve(null), () => resolve(null));
    req.onupgradeneeded = () => {
      fresh = true;
      try {
        req.transaction.abort();
      } catch {
        // already finished; the database is deleted below either way
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      if (fresh) {
        db.close();
        gone();
        return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = (ev) => {
      ev?.preventDefault?.();
      if (fresh) gone();
      else reject(new CzdError('legacy-no-db', { cause: req.error }));
    };
  });
}

async function mayExist(idb) {
  if (typeof idb.databases !== 'function') return true;
  try {
    return (await idb.databases()).some((d) => d.name === DB_NAME);
  } catch {
    return true;
  }
}

/** Runs fn(db) on a short-lived connection; null when the database does not exist. */
async function withDb(fn) {
  const idb = idbFactory();
  if (!(await mayExist(idb))) return null;
  const db = await openExisting(idb);
  if (!db) return null;
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/**
 * One read-only transaction over the stores that exist; `start(store, name, fail)` issues requests whose
 * callbacks stay synchronous. Resolves when the transaction completes. Always rejects with a CzdError:
 * 'legacy-no-db' when the transaction cannot run, 'legacy-bad-record' when a request or callback failed.
 */
function readTx(db, names, start) {
  const present = names.filter((n) => db.objectStoreNames.contains(n));
  if (!present.length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let failure = null;
    let tx;
    try {
      tx = db.transaction(present, 'readonly');
    } catch (e) {
      reject(new CzdError('legacy-no-db', { cause: e }));
      return;
    }
    const fail = (e) => {
      failure ??= e instanceof CzdError ? e : new CzdError('legacy-bad-record', { cause: e });
      try {
        tx.abort();
      } catch {
        // already aborted
      }
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(failure ?? new CzdError('legacy-no-db', { cause: tx.error }));
    try {
      for (const n of present) start(tx.objectStore(n), n, fail);
    } catch (e) {
      fail(e);
    }
  });
}

/** Cursor over a store: visit(primaryKey, value) for every record. */
function eachRecord(store, visit, fail) {
  const req = store.openCursor();
  req.onerror = () => fail(req.error);
  req.onsuccess = () => {
    const c = req.result;
    if (!c) return;
    try {
      visit(c.primaryKey, c.value);
    } catch (e) {
      fail(e);
      return;
    }
    c.continue();
  };
}

const nonEmpty = (s) => (typeof s === 'string' && s.trim() ? s : null);
const idFor = (store, key) => `${store}:${typeof key === 'number' ? '#' : ''}${key}`;
const validKey = (key) => typeof key === 'string' || Number.isFinite(key);

function dateOf(rec, key) {
  if (Number.isFinite(rec.date)) return rec.date;
  const n = Number(key);
  return Number.isFinite(n) ? n : 0;
}

function vaultEntry(key, rec) {
  const ver = typeof rec.ver === 'string' ? rec.ver : 'cz';
  const cipher = rec.cipher;
  const e = { id: idFor('vault', key), store: 'vault', key, name: safeFilename(nonEmpty(rec.name) ?? `${ver}-${key}`), kind: 'note',
    size: 0, date: dateOf(rec, key), chunked: false, ver, mode: 'bad' };
  if (typeof cipher !== 'string') return e;
  e.size = utf8(cipher).length;
  if (ver === 'v2') {
    // Saved from the v2 output box: ciphertext (marker first), the decoded plaintext, or the failure placeholder.
    if (cipher !== 'could not decode') e.mode = isV2C(cipher) ? 'v2note' : 'plain';
  } else if (ver === 'v3') {
    // v3 output never contains ASCII letters; with some, the box held the decoded plaintext.
    e.mode = /[A-Za-z]/.test(cipher) ? 'plain' : 'v3note';
    const m = /^(\d+) chars$/.exec(typeof rec.pin_hint === 'string' ? rec.pin_hint : '');
    e.hintLen = m ? Number(m[1]) : null;
  } else {
    // 'cz': the output box held stealth ciphertext (one unbroken run of stealth letters, never any whitespace)
    // or, saved after a decrypt, the plaintext; anything that does not decode strictly is that plaintext.
    e.mode = 'plain';
    if (!/\s/u.test(cipher)) {
      try {
        e.blob = v4Blob(cipher, { allowRawBase64: false });
        e.mode = 'v4note';
        e.size = e.blob.length - MIN_BLOB;
      } catch {
        // stays 'plain'
      }
    }
  }
  return e;
}

function fileEntry(key, rec) {
  const name = safeFilename(nonEmpty(rec.name) ?? 'file');
  const chunked = rec.isChunked === true;
  const e = { id: idFor('files', key), store: 'files', key, name, kind: kindOf(cleanMime(rec.mime), name),
    size: Number.isSafeInteger(rec.size) && rec.size >= 0 ? rec.size : 0, date: dateOf(rec, key), chunked, mode: 'bad' };
  const first = chunked ? (Array.isArray(rec.chunks) ? rec.chunks[0] : undefined) : rec.cipher;
  if (typeof first === 'string') {
    try {
      e.blob = v4Head(first);
      e.mode = 'v4file';
    } catch {
      // stays 'bad'
    }
  }
  return e;
}

async function buildIndex() {
  const entries = await withDb((db) => {
    const out = [];
    return readTx(db, ['vault', 'files'], (store, name, fail) => eachRecord(store, (key, rec) => {
      if (!validKey(key) || !rec || typeof rec !== 'object') return;
      out.push(name === 'vault' ? vaultEntry(key, rec) : fileEntry(key, rec));
    }, fail)).then(() => out);
  });
  if (entries === null) {
    index = null;
    return null;
  }
  index = new Map(entries.map((e) => [e.id, e]));
  for (const id of pins.keys()) if (!index.has(id)) pins.delete(id);
  return index;
}

async function currentIndex() {
  const idx = index ?? (await buildIndex());
  if (!idx) throw new CzdError('legacy-no-db');
  return idx;
}

function getRecord(store, key) {
  return withDb((db) => new Promise((resolve, reject) => {
    readTx(db, [store], (s, _n, fail) => {
      const req = s.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => fail(req.error);
    }).then(() => resolve(undefined), reject);
  }));
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * Counts what the old web vault holds, or null when there is no old database or it is empty/unreadable.
 * Never creates the database.
 * @returns {Promise<null|{notes: number, files: number, playlists: number}>}
 */
export async function probeOldVault() {
  try {
    const counts = await withDb((db) => {
      const c = { notes: 0, files: 0, playlists: 0 };
      const field = { vault: 'notes', files: 'files', playlists: 'playlists' };
      return readTx(db, ['vault', 'files', 'playlists'], (store, name, fail) => {
        const req = store.count();
        req.onsuccess = () => { c[field[name]] = req.result; };
        req.onerror = () => fail(req.error);
      }).then(() => c);
    });
    return counts && counts.notes + counts.files + counts.playlists > 0 ? counts : null;
  } catch {
    return null;
  }
}

/**
 * Lists every old note and file (fresh read). Names are sanitized and were never encrypted. `unlocked` is true
 * for items that need no PIN and for those a tryPin() call opened. Extra fields: `format`
 * ('v4'|'v3'|'v2'|'plain'|'bad'; 'plain' = a note saved unencrypted) and `ver` (vault notes: 'cz'|'v2'|'v3').
 * Throws CzdError('legacy-no-db') when there is no old database (or it cannot be read), 'legacy-bad-record' when
 * a record cannot be read.
 * @returns {Promise<Array<{store: 'vault'|'files', id: string, name: string, kind: string, size: number, date: number,
 *   chunked: boolean, unlocked: boolean, format: string, ver?: string}>>}
 */
export async function listOldItems() {
  const idx = await buildIndex();
  if (!idx) throw new CzdError('legacy-no-db');
  return [...idx.values()].map((e) => ({
    store: e.store, id: e.id, name: e.name, kind: e.kind, size: e.size, date: e.date, chunked: e.chunked,
    unlocked: e.mode !== 'bad' && (!NEEDS_PIN.has(e.mode) || pins.has(e.id)), format: FORMAT[e.mode], ...(e.ver ? { ver: e.ver } : {}),
  }));
}

// Records a working PIN unless forgetPins() ran since `gen` was taken.
function remember(e, pin, gen, k) {
  if (gen !== generation) return false;
  pins.set(e.id, pin);
  if (k) keys.set(saltHex(e.blob), k);
  return true;
}

async function unlock(e, variants, gen) {
  if (e.mode === 'v3note') {
    // Unverifiable; the record's pin_hint ('<n> chars') at least rules out PINs of the wrong length.
    const v = variants.find((p) => e.hintLen == null || p.length === e.hintLen);
    return v !== undefined && remember(e, v, gen);
  }
  for (const v of variants) {
    if (gen !== generation) return false;
    const k = await v4Keys(v, e.blob);
    let good;
    if (e.mode === 'v4file') {
      good = await precheckV4(e.blob, k);
    } else {
      const plain = await openV4(e.blob, k);
      good = plain !== null;
      plain?.fill(0);
    }
    if (good) return remember(e, v, gen, k);
  }
  return false;
}

/**
 * Tries a PIN (all spellings per DESIGN §3.1) on every still-locked item: files by the 1-block check on their
 * first ciphertext, v4 notes by a full decrypt, v3 notes by the PIN length hint. Can be called again with
 * other PINs. Resolves the ids unlocked by this call.
 * @param {string} pin
 * @returns {Promise<string[]>}
 */
export async function tryPin(pin) {
  const gen = generation;
  const idx = await currentIndex();
  const variants = pinVariants(pin);
  if (!variants.length) return [];
  const todo = [...idx.values()].filter((e) => NEEDS_PIN.has(e.mode) && !pins.has(e.id));
  const ok = await pool(todo, PARALLEL, (e) => unlock(e, variants, gen));
  return gen === generation ? todo.filter((_, i) => ok[i]).map((e) => e.id) : [];
}

/**
 * Drops every remembered old PIN and derived key. A tryPin() still running remembers nothing, and a
 * decodeOldItem() still running rejects CzdError('aborted').
 */
export function forgetPins() {
  generation++;
  pins.clear();
  keys.clear();
}

function bad() {
  return new CzdError('legacy-bad-record');
}

/** Throws CzdError('aborted') when forgetPins() ran since `gen` was taken. */
function stillWanted(gen) {
  if (gen !== generation) throw new CzdError('aborted');
}

function b64(data) {
  try {
    return fromB64(data);
  } catch {
    throw bad();
  }
}

/** Decrypts one v4 ciphertext with the remembered PIN (cached key when tryPin derived it) → parsed JSON. */
async function openJson(text, pin, k) {
  let blob;
  try {
    blob = v4Blob(text);
  } catch {
    throw bad();
  }
  const plain = await openV4(blob, k ?? keys.get(saltHex(blob)) ?? (await v4Keys(pin, blob)));
  if (!plain) throw bad();
  try {
    return JSON.parse(legacyUtf8(plain));
  } catch {
    throw bad();
  } finally {
    plain.fill(0);
  }
}

async function decodeFile(e, rec, pin, gen) {
  let meta;
  let parts;
  if (!e.chunked) {
    if (typeof rec.cipher !== 'string') throw bad();
    meta = await openJson(rec.cipher, pin);
    // A 0-byte file has data '' (the original could not save it; accepted here).
    if (!meta || meta.type !== 'file' || typeof meta.data !== 'string') throw bad();
    parts = [b64(meta.data)];
  } else {
    const chunks = rec.chunks;
    if (!Array.isArray(chunks) || !chunks.length || chunks.some((c) => typeof c !== 'string')) throw bad();
    // Every chunk has its own salt: derive all keys at once, then decrypt one chunk at a time.
    let heads;
    try {
      heads = chunks.map((c) => v4Head(c));
    } catch {
      throw bad();
    }
    const ks = await Promise.all(heads.map((h) => keys.get(saltHex(h)) ?? v4Keys(pin, h)));
    const got = [];
    for (let i = 0; i < chunks.length; i++) {
      stillWanted(gen);
      const p = await openJson(chunks[i], pin, ks[i]);
      if (!p || p.type !== 'chunk' || !Number.isInteger(p.index) || !Number.isInteger(p.totalChunks) || typeof p.data !== 'string') throw bad();
      got.push({ index: p.index, total: p.totalChunks, bytes: b64(p.data), meta: p });
      p.data = '';
    }
    got.sort((a, b) => a.index - b.index);
    if (got.some((g, i) => g.index !== i || g.total !== got.length)) throw new CzdError('legacy-missing-chunks');
    // No chunk is bound to its record, so a chunk of another file under the same PIN would also decrypt. The
    // original wrote one name/mime/ext and equal slices (only the last one shorter) per file: check both.
    const [first] = got;
    const full = first.bytes.length;
    for (const [i, g] of got.entries()) {
      if (g.meta.mime !== first.meta.mime || g.meta.name !== first.meta.name || g.meta.ext !== first.meta.ext) throw bad();
      const n = g.bytes.length;
      if (i < got.length - 1 ? n !== full : n === 0 || n > full) throw bad();
    }
    meta = first.meta;
    parts = got.map((g) => g.bytes);
  }
  const type = cleanMime(meta.mime) || cleanMime(rec.mime) || 'application/octet-stream';
  const name = nonEmpty(rec.name) ? e.name : safeFilename(`${nonEmpty(meta.name) ?? 'file'}.${nonEmpty(meta.ext) ?? 'bin'}`);
  return { name, type, mtime: e.date, blob: new Blob(parts, { type: safeMediaType(type) }) };
}

async function decodeNote(e, rec, pin) {
  const note = (body, plaintextNote) => ({ note: { title: e.name, body }, ...(plaintextNote ? { plaintextNote: true } : {}) });
  const cipher = rec.cipher;
  if (typeof cipher !== 'string') throw bad();
  switch (e.mode) {
    case 'plain':
      return note(cipher, true);
    case 'v2note':
      return note(decodeV2(cipher).text);
    case 'v3note':
      return note(decodeV3(cipher, pin).text);
    default: {
      let blob;
      try {
        blob = v4Blob(cipher, { allowRawBase64: false });
      } catch {
        throw bad();
      }
      const plain = await openV4(blob, keys.get(saltHex(blob)) ?? (await v4Keys(pin, blob)));
      if (!plain) throw bad();
      const body = legacyUtf8(plain);
      plain.fill(0);
      return note(body);
    }
  }
}

/**
 * Decodes one item from listOldItems(). Files → {name, type, mtime, blob} (single-shot or reassembled chunks;
 * chunk indices must be exactly 0..n−1 with n === totalChunks, else 'legacy-missing-chunks'; chunks that
 * disagree on name/mime/ext or slice size are 'legacy-bad-record'). Notes →
 * {note: {title, body}}, plus plaintextNote: true for notes that were saved unencrypted.
 * Throws CzdError 'legacy-wrong-pin' (not unlocked yet), 'legacy-bad-record', 'legacy-missing-chunks',
 * 'item-not-found', 'legacy-no-db', or 'aborted' when forgetPins() ran meanwhile (PIN-locked items only).
 * @param {string} id
 * @returns {Promise<{name: string, type: string, mtime: number, blob: Blob} | {note: {title: string, body: string}, plaintextNote?: boolean}>}
 */
export async function decodeOldItem(id) {
  const gen = generation;
  const idx = await currentIndex();
  const e = idx.get(id);
  if (!e) throw new CzdError('item-not-found');
  if (e.mode === 'bad') throw bad();
  const pin = pins.get(e.id);
  if (NEEDS_PIN.has(e.mode) && pin === undefined) throw new CzdError('legacy-wrong-pin');
  const rec = await getRecord(e.store, e.key);
  if (rec === null) throw new CzdError('legacy-no-db');
  if (!rec || typeof rec !== 'object') throw new CzdError('item-not-found');
  const out = e.store === 'files' ? await decodeFile(e, rec, pin, gen) : await decodeNote(e, rec, pin);
  if (NEEDS_PIN.has(e.mode)) stillWanted(gen);
  return out;
}

/**
 * Old playlists with their file ids mapped to listOldItems() ids; ids of deleted files are dropped (as the old
 * player did). Names are sanitized.
 * @returns {Promise<Array<{id: string, name: string, itemIds: string[]}>>}
 */
export async function listOldPlaylists() {
  const out = await withDb((db) => {
    const lists = [];
    const fileKeys = new Set();
    return readTx(db, ['playlists', 'files'], (store, name, fail) => {
      if (name === 'files') {
        const req = store.getAllKeys();
        req.onsuccess = () => { for (const k of req.result) fileKeys.add(k); };
        req.onerror = () => fail(req.error);
      } else {
        eachRecord(store, (key, rec) => {
          if (validKey(key) && rec && typeof rec === 'object') lists.push({ key, rec });
        }, fail);
      }
    }).then(() => lists.map(({ key, rec }) => ({
      id: String(key),
      name: safeFilename(nonEmpty(rec.name) ?? 'playlist'),
      itemIds: (Array.isArray(rec.fileIds) ? rec.fileIds : []).filter((k) => validKey(k) && fileKeys.has(k)).map((k) => idFor('files', k)),
    })));
  });
  if (out === null) throw new CzdError('legacy-no-db');
  return out;
}

/**
 * Deletes czeroode_db (only after the user confirms) and forgets everything cached about it. Rejects
 * CzdError('other-tab') when another tab (e.g. a cZEROde 1 tab) keeps it open; the deletion then completes by
 * itself once that tab closes.
 */
export async function deleteOldDb() {
  await deleteDb(idbFactory());
  index = null;
  forgetPins();
}
