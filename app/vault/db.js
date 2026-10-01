// IndexedDB 'czd-vault' v1 (DESIGN §4.1): the vault record, the encrypted index (items, lists, thumbs), kv and the
// IdbBlobStore segments. Every storage failure is a CzdError: QuotaExceededError → 'quota-exceeded'; a closed,
// blocked-by-upgrade or broken database → 'store-unavailable'; anything else → 'internal'. Misuse by the caller
// (unknown store, malformed id/record) is a TypeError, like the other modules.

import { CzdError, toCzdError } from '../errors.js';
import { ctEqual, fromB64, toB64 } from '../util/bytes.js';

const NAME = 'czd-vault';
const VERSION = 1;
const STORES = Object.freeze(['meta', 'items', 'lists', 'thumbs', 'kv', 'blobs']);
/** In-line keys; the other stores take out-of-line keys ('meta' 'vault', kv strings, blobs [id, seg]). */
const KEY_PATH = Object.freeze({ items: 'id', lists: 'id', thumbs: 'id' });
const META_KEY = 'vault';
const ID_RE = /^[0-9a-f]{32}$/;

const SNAPSHOT_FORMAT = 'czd-vault-snapshot';
const SNAPSHOT_MAX_RECORDS = 2_000_000;
const SNAPSHOT_MAX_DEPTH = 32;

/** IDB error names that mean "this database can't be used right now" rather than a bug. */
const UNAVAILABLE = new Set(['InvalidStateError', 'UnknownError', 'VersionError', 'NotFoundError', 'SecurityError', 'InvalidAccessError']);

/** Any IDB failure → CzdError. */
function mapError(e) {
  if (e instanceof CzdError) return e;
  const name = e && typeof e === 'object' ? e.name : undefined;
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return toCzdError(e);
  if (UNAVAILABLE.has(name)) return new CzdError('store-unavailable', { cause: e, detail: name });
  // An abort the browser started (not ours) is not a user cancel: never let it read as 'aborted'.
  return new CzdError('internal', { cause: e, detail: name });
}

function checkStore(store) {
  if (!STORES.includes(store)) throw new TypeError(`db: unknown store ${String(store)}`);
}

const isId = (x) => typeof x === 'string' && ID_RE.test(x);
const isPlain = (x) => x !== null && typeof x === 'object' && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);

/** Checks a record for put() and returns the out-of-line key to use (undefined for in-line stores). */
function putKey(store, rec, key) {
  checkStore(store);
  if (rec === undefined) throw new TypeError(`db: put(${store}) needs a value`);
  const kp = KEY_PATH[store];
  if (kp) {
    if (!rec || typeof rec !== 'object' || !isId(rec[kp])) throw new TypeError(`db: ${store} records need a 32-hex id`);
    if (key !== undefined && key !== rec[kp]) throw new TypeError(`db: key differs from ${store} record id`);
    return undefined;
  }
  if (store === 'meta') {
    const k = key ?? META_KEY;
    if (k !== META_KEY) throw new TypeError(`db: the meta store only holds '${META_KEY}'`);
    if (!isPlain(rec)) throw new TypeError('db: the vault record must be an object');
    return k;
  }
  if (store === 'kv' && typeof key !== 'string') throw new TypeError('db: kv keys are strings');
  if (key === undefined) throw new TypeError(`db: put(${store}) needs a key`);
  return key;
}

function checkDeleteKey(store, key) {
  checkStore(store);
  if (key === undefined || key === null) throw new TypeError(`db: delete(${store}) needs a key`);
}

/**
 * Opens (creating on first use) the vault database.
 * @param {{idb?: IDBFactory, IDBKeyRange?: typeof IDBKeyRange, onClose?: (reason: 'versionchange'|'closed') => void}} [opts]
 *   idb: the factory (fake-indexeddb in tests); IDBKeyRange: the matching key-range class (only IdbBlobStore needs
 *   it; defaults to the global); onClose: called once when the connection goes away (another tab upgrades or
 *   deletes the database, or the browser closes it). After that every call rejects with 'store-unavailable'.
 * @returns {Promise<VaultDb>}
 */
export async function openVaultDb({ idb = globalThis.indexedDB, IDBKeyRange: keyRange = globalThis.IDBKeyRange, onClose } = {}) {
  if (!idb || typeof idb.open !== 'function') throw new CzdError('store-unavailable', { detail: 'no IndexedDB' });
  const conn = await new Promise((resolve, reject) => {
    let req;
    try {
      req = idb.open(NAME, VERSION);
    } catch (e) {
      reject(mapError(e));
      return;
    }
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (ev.oldVersion < 1) {
        for (const s of STORES) {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, KEY_PATH[s] ? { keyPath: KEY_PATH[s] } : undefined);
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = (ev) => {
      ev.preventDefault?.();
      reject(new CzdError('store-unavailable', { cause: req.error, detail: req.error?.name }));
    };
    req.onblocked = () => {
      // Only an older connection can block v1 (none exists); keep waiting like the browser does.
    };
  });
  for (const s of STORES) {
    if (!conn.objectStoreNames.contains(s)) {
      conn.close();
      throw new CzdError('store-unavailable', { detail: `missing object store ${s}` });
    }
  }
  return new VaultDb(conn, keyRange, onClose);
}

/**
 * One connection to 'czd-vault'. Methods resolve after their transaction commits.
 * @implements {import('../types.js').VaultDb}
 */
class VaultDb {
  /** @param {IDBDatabase} conn */
  constructor(conn, keyRange, onClose) {
    this._conn = conn;
    this._keyRange = keyRange;
    this._onClose = typeof onClose === 'function' ? onClose : null;
    this._closed = false;
    // Never block another tab's upgrade or deleteDatabase: let go at once and report it.
    conn.onversionchange = () => this._shut('versionchange');
    conn.onclose = () => this._shut('closed');
  }

  _shut(reason) {
    if (this._closed) return;
    this._closed = true;
    try {
      this._conn.close();
    } catch {
      // already closed
    }
    if (this._onClose) {
      try {
        this._onClose(reason);
      } catch {
        // a listener's failure must not break the close
      }
    }
  }

  /** True once the connection is gone (close(), versionchange, or closed by the browser). */
  get closed() {
    return this._closed;
  }

  /** The IDBKeyRange class matching this connection's factory (IdbBlobStore). */
  get keyRange() {
    if (typeof this._keyRange?.bound !== 'function') throw new CzdError('store-unavailable', { detail: 'no IDBKeyRange' });
    return this._keyRange;
  }

  /**
   * Low-level: runs `fn(tx, abort)` inside ONE transaction. `fn` must issue its requests synchronously (or from
   * request callbacks) and may return a function that produces the result once the transaction has committed.
   * `abort(err)` aborts the transaction and rejects with `err`. Used by IdbBlobStore.
   * @template T
   * @param {string[]} names
   * @param {'readonly'|'readwrite'} mode
   * @param {(tx: IDBTransaction, abort: (err: Error) => void) => (void | (() => T))} fn
   * @returns {Promise<T>}
   */
  tx(names, mode, fn) {
    return new Promise((resolve, reject) => {
      for (const n of names) checkStore(n);
      if (this._closed) {
        reject(new CzdError('store-unavailable', { detail: 'database closed' }));
        return;
      }
      let tx;
      try {
        tx = this._conn.transaction(names, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
      } catch (e) {
        reject(this._closed ? new CzdError('store-unavailable', { cause: e, detail: 'database closed' }) : mapError(e));
        return;
      }
      let reason = null;
      let result;
      const abort = (err) => {
        if (reason) return;
        reason = err instanceof CzdError || err instanceof TypeError ? err : mapError(err);
        try {
          tx.abort();
        } catch {
          // already finished
        }
      };
      tx.oncomplete = () => {
        try {
          resolve(typeof result === 'function' ? result() : undefined);
        } catch (e) {
          reject(mapError(e));
        }
      };
      tx.onabort = () => {
        if (reason) reject(reason);
        else if (this._closed) reject(new CzdError('store-unavailable', { cause: tx.error, detail: 'database closed' }));
        else reject(tx.error ? mapError(tx.error) : new CzdError('internal', { detail: 'transaction aborted' }));
      };
      try {
        result = fn(tx, abort);
      } catch (e) {
        abort(e);
      }
    });
  }

  /** @returns {Promise<object|undefined>} the vault record ('meta' 'vault') */
  async getMeta() {
    return this.tx(['meta'], 'readonly', (tx) => {
      const r = tx.objectStore('meta').get(META_KEY);
      return () => r.result;
    });
  }

  /**
   * Writes the vault record. With `expectWrapCt` the write is a compare-and-swap inside the same transaction:
   * a Uint8Array must equal the stored wrap.ct (else CzdError 'vault-changed'); null means "no vault yet"
   * (else 'vault-exists'). Without it the record is written unconditionally.
   * @param {object} rec
   * @param {{expectWrapCt?: Uint8Array|null}} [opts]
   */
  async putMeta(rec, { expectWrapCt } = {}) {
    putKey('meta', rec);
    await this.commit([{ op: 'put', store: 'meta', key: META_KEY, value: rec }], { expectWrapCt });
  }

  /**
   * Every value of a store (key order).
   * @param {string} store
   * @returns {Promise<object[]>}
   */
  async getAll(store) {
    checkStore(store);
    return this.tx([store], 'readonly', (tx) => {
      const r = tx.objectStore(store).getAll();
      return () => r.result;
    });
  }

  /**
   * One record, or undefined. Ids that can't exist (not 32-hex for items/lists/thumbs) resolve undefined.
   * @param {string} store
   * @param {any} id
   */
  async get(store, id) {
    checkStore(store);
    if (KEY_PATH[store] && !isId(id)) return undefined;
    if (id === undefined || id === null) return undefined;
    return this.tx([store], 'readonly', (tx) => {
      const r = tx.objectStore(store).get(id);
      return () => r.result;
    });
  }

  /**
   * Puts one record. items/lists/thumbs carry their 32-hex `id`; meta defaults to key 'vault'; kv and blobs need `key`.
   * @param {string} store
   * @param {any} rec
   * @param {any} [key]
   */
  async put(store, rec, key) {
    await this.commit([{ op: 'put', store, value: rec, key }]);
  }

  /**
   * Deletes one record (no-op when missing).
   * @param {string} store
   * @param {any} key
   */
  async delete(store, key) {
    checkStore(store);
    if (KEY_PATH[store] && !isId(key)) return;
    await this.commit([{ op: 'delete', store, key }]);
  }

  /**
   * Applies every op in ONE readwrite transaction (all or nothing).
   * ops: {op:'put', store, value, key?} (key only for meta/kv/blobs) | {op:'delete', store, key}.
   * `expectWrapCt` adds the putMeta compare-and-swap on the vault record to the same transaction.
   * @param {Array<{op:'put'|'delete', store:string, value?:any, key?:any}>} ops
   * @param {{expectWrapCt?: Uint8Array|null}} [opts]
   */
  async commit(ops, { expectWrapCt } = {}) {
    if (!Array.isArray(ops)) throw new TypeError('db: commit() takes an array of ops');
    if (expectWrapCt !== undefined && expectWrapCt !== null && !(expectWrapCt instanceof Uint8Array)) {
      throw new TypeError('db: expectWrapCt must be a Uint8Array or null');
    }
    const plan = ops.map((o) => {
      if (!o || typeof o !== 'object') throw new TypeError('db: bad op');
      if (o.op === 'put') return { put: true, store: o.store, key: putKey(o.store, o.value, o.key), value: o.value };
      if (o.op === 'delete') {
        checkDeleteKey(o.store, o.key);
        return { put: false, store: o.store, key: o.key };
      }
      throw new TypeError(`db: unknown op ${String(o.op)}`);
    });
    const cas = expectWrapCt !== undefined;
    if (!plan.length && !cas) return;
    const names = [...new Set([...plan.map((p) => p.store), ...(cas ? ['meta'] : [])])];
    await this.tx(names, 'readwrite', (tx, abort) => {
      if (cas) {
        const r = tx.objectStore('meta').get(META_KEY);
        r.onsuccess = () => {
          const cur = r.result;
          if (expectWrapCt === null) {
            if (cur !== undefined) abort(new CzdError('vault-exists'));
          } else if (!(cur?.wrap?.ct instanceof Uint8Array) || !ctEqual(cur.wrap.ct, expectWrapCt)) {
            abort(new CzdError('vault-changed'));
          }
        };
      }
      // Requests run in order: a failed compare-and-swap aborts before any of these is committed.
      for (const p of plan) {
        const os = tx.objectStore(p.store);
        if (!p.put) os.delete(p.key);
        else if (p.key === undefined) os.put(p.value);
        else os.put(p.value, p.key);
      }
    });
  }

  /** @param {string} k @returns {Promise<any>} */
  async kvGet(k) {
    if (typeof k !== 'string') throw new TypeError('db: kv keys are strings');
    return this.get('kv', k);
  }

  /** Sets a kv value; `undefined` deletes the key. @param {string} k @param {any} v */
  async kvSet(k, v) {
    if (typeof k !== 'string') throw new TypeError('db: kv keys are strings');
    if (v === undefined) await this.commit([{ op: 'delete', store: 'kv', key: k }]);
    else await this.commit([{ op: 'put', store: 'kv', key: k, value: v }]);
  }

  /** Empties every store (meta, index, thumbs, kv and IdbBlobStore segments) in one transaction. */
  async clearAll() {
    await this.tx([...STORES], 'readwrite', (tx) => {
      for (const s of STORES) tx.objectStore(s).clear();
    });
  }

  /** Closes the connection (idempotent); later calls reject with 'store-unavailable'. */
  close() {
    if (this._closed) return;
    this._closed = true;
    try {
      this._conn.close();
    } catch {
      // already closed
    }
  }

  /**
   * JSON-safe copy of meta, items, lists and kv (one consistent read) for the Tauri index mirror.
   * Uint8Arrays become {"$b64": "<base64>"}; thumbs and blobs are left out; kv values that JSON can't hold
   * (Blob, Map, Date, …) are skipped.
   * @returns {Promise<{format:string, v:1, meta:object|null, items:object[], lists:object[], kv:Array<[string, any]>}>}
   */
  async exportSnapshot() {
    const raw = await this.tx(['meta', 'items', 'lists', 'kv'], 'readonly', (tx) => {
      const meta = tx.objectStore('meta').get(META_KEY);
      const items = tx.objectStore('items').getAll();
      const lists = tx.objectStore('lists').getAll();
      const kvKeys = tx.objectStore('kv').getAllKeys();
      const kvVals = tx.objectStore('kv').getAll();
      return () => ({ meta: meta.result, items: items.result, lists: lists.result, kvKeys: kvKeys.result, kvVals: kvVals.result });
    });
    const kv = [];
    raw.kvKeys.forEach((k, i) => {
      if (typeof k !== 'string') return;
      try {
        kv.push([k, encodeValue(raw.kvVals[i], 0)]);
      } catch {
        // not JSON-safe: kv holds conveniences only, the mirror goes on without it
      }
    });
    try {
      return {
        format: SNAPSHOT_FORMAT,
        v: 1,
        meta: raw.meta === undefined ? null : encodeValue(raw.meta, 0),
        items: raw.items.map((r) => encodeValue(r, 0)),
        lists: raw.lists.map((r) => encodeValue(r, 0)),
        kv,
      };
    } catch (e) {
      throw new CzdError('internal', { cause: e, detail: 'record not JSON-safe' });
    }
  }

  /**
   * Rebuilds the database from exportSnapshot() output (after JSON round trip). Only when no vault record
   * exists (else 'vault-exists'); replaces meta, items, lists, kv and clears thumbs in one transaction.
   * A malformed snapshot rejects with 'bad-meta' before anything is written.
   * @param {object} snap
   */
  async importSnapshot(snap) {
    const { meta, items, lists, kv } = decodeSnapshot(snap);
    await this.tx(['meta', 'items', 'lists', 'thumbs', 'kv'], 'readwrite', (tx, abort) => {
      const r = tx.objectStore('meta').get(META_KEY);
      r.onsuccess = () => {
        if (r.result !== undefined) {
          abort(new CzdError('vault-exists'));
          return;
        }
        try {
          for (const s of ['items', 'lists', 'thumbs', 'kv']) tx.objectStore(s).clear();
          for (const it of items) tx.objectStore('items').put(it);
          for (const l of lists) tx.objectStore('lists').put(l);
          for (const [k, v] of kv) tx.objectStore('kv').put(v, k);
          tx.objectStore('meta').put(meta, META_KEY);
        } catch (e) {
          abort(e);
        }
      };
    });
  }
}

// ───────── snapshot encoding

const isBadKey = (k) => k === '__proto__';

/** Plain data → JSON-safe data (Uint8Array → {$b64}); throws TypeError on anything else. */
function encodeValue(v, depth) {
  if (depth > SNAPSHOT_MAX_DEPTH) throw new TypeError('snapshot: too deep');
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (Number.isFinite(v)) return v;
    throw new TypeError('snapshot: non-finite number');
  }
  if (ArrayBuffer.isView(v)) return { $b64: toB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  if (v instanceof ArrayBuffer) return { $b64: toB64(new Uint8Array(v)) };
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : encodeValue(x, depth + 1)));
  if (isPlain(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === '$b64') throw new TypeError('snapshot: ambiguous $b64 object');
    const out = {};
    for (const k of keys) {
      if (v[k] === undefined || isBadKey(k)) continue;
      out[k] = encodeValue(v[k], depth + 1);
    }
    return out;
  }
  throw new TypeError('snapshot: unsupported value');
}

/** Inverse of encodeValue; throws TypeError on anything JSON can't produce or a bad base64 string. */
function decodeValue(v, depth) {
  if (depth > SNAPSHOT_MAX_DEPTH) throw new TypeError('snapshot: too deep');
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (Number.isFinite(v)) return v;
    throw new TypeError('snapshot: non-finite number');
  }
  if (Array.isArray(v)) return v.map((x) => decodeValue(x, depth + 1));
  if (isPlain(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === '$b64') {
      if (typeof v.$b64 !== 'string') throw new TypeError('snapshot: bad $b64');
      return fromB64(v.$b64);
    }
    const out = {};
    for (const k of keys) {
      if (isBadKey(k)) continue;
      out[k] = decodeValue(v[k], depth + 1);
    }
    return out;
  }
  throw new TypeError('snapshot: unsupported value');
}

const isU8 = (x, n) => x instanceof Uint8Array && (n === undefined || x.length === n);
const isUint = (x) => Number.isSafeInteger(x) && x >= 0;
const optional = (x, check) => x === undefined || x === null || check(x);

function checkMetaRecord(m) {
  return isPlain(m) && m.v === 1 && isU8(m.vaultId, 16)
    && isPlain(m.kdf) && isUint(m.kdf.id) && isUint(m.kdf.m) && isUint(m.kdf.t) && isUint(m.kdf.p) && isU8(m.kdf.salt, 16)
    && isPlain(m.wrap) && isU8(m.wrap.iv, 12) && isU8(m.wrap.ct, 48)
    && optional(m.rwrap, (r) => isPlain(r) && isU8(r.iv, 12) && isU8(r.ct, 48))
    && optional(m.floor, (f) => typeof f === 'boolean')
    && optional(m.storeKind, (k) => typeof k === 'string')
    && optional(m.createdAt, isUint) && optional(m.lastBackupAt, isUint);
}

const checkItemRecord = (r) => isPlain(r) && isId(r.id) && isU8(r.iv, 12) && isU8(r.enc) && optional(r.storedBytes, isUint);
const checkListRecord = (r) => isPlain(r) && isId(r.id) && isU8(r.iv, 12) && isU8(r.enc);

/** Parses and validates a snapshot; any problem → CzdError('bad-meta'). */
function decodeSnapshot(snap) {
  const bad = (detail, cause) => new CzdError('bad-meta', { detail: `snapshot: ${detail}`, cause });
  if (!isPlain(snap) || snap.format !== SNAPSHOT_FORMAT || snap.v !== 1) throw bad('not a vault snapshot');
  for (const k of ['items', 'lists', 'kv']) {
    if (!Array.isArray(snap[k]) || snap[k].length > SNAPSHOT_MAX_RECORDS) throw bad(`${k} must be an array`);
  }
  let meta;
  let items;
  let lists;
  let kv;
  try {
    meta = decodeValue(snap.meta, 0);
    items = snap.items.map((r) => decodeValue(r, 0));
    lists = snap.lists.map((r) => decodeValue(r, 0));
    kv = snap.kv.map((e) => {
      if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string') throw new TypeError('kv entries are [key, value]');
      return [e[0], decodeValue(e[1], 0)];
    });
  } catch (e) {
    throw bad('malformed', e);
  }
  if (!checkMetaRecord(meta)) throw bad('bad vault record');
  const seen = new Set();
  for (const r of items) {
    if (!checkItemRecord(r) || seen.has(r.id)) throw bad('bad item record');
    seen.add(r.id);
  }
  seen.clear();
  for (const r of lists) {
    if (!checkListRecord(r) || seen.has(r.id)) throw bad('bad list record');
    seen.add(r.id);
  }
  return { meta, items, lists, kv };
}
