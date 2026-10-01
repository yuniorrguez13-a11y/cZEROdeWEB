// Container stores: where encrypted vault containers live (DESIGN §4.2). Only ciphertext ever reaches a store.
// Backends: OpfsStore (web default; writes through vault/opfs-worker.js), IdbBlobStore (engines without OPFS;
// 16 MiB Blob segments in the vault db), TauriFsStore (desktop; $APPDATA/vault2/items) and MemoryStore (tests).
// All share one contract (types.js ContainerStore): ids are 32 lowercase hex chars, a failed or aborted write
// leaves nothing behind, errors from the source propagate unchanged, storage failures are CzdErrors.

import { CODES, CzdError, toCzdError } from '../errors.js';
import * as platform from '../platform.js';
import { randomBytes, toHex } from '../util/bytes.js';
import { safeFilename } from '../util/format.js';
import { abortable, blobSource, fileChunks, rechunk } from '../util/stream.js';

const ID_RE = /^[0-9a-f]{32}$/;
const ITEM_FILE_RE = /^([0-9a-f]{32})\.czd$/;
const TMP_FILE_RE = /^[0-9a-f]{32}\.tmp$/;
const TMP_MAX_AGE = 24 * 3600 * 1000;
const ORPHAN_MAX_AGE = 3600 * 1000;
const MiB = 2 ** 20;

/** OPFS layout (relative to the origin's root directory). */
const OPFS_ITEMS = 'czd/v1/items';
const OPFS_TMP = 'czd/v1/tmp';
/** Bytes per write-chunk message, and how many may be queued in the worker at once. */
const OPFS_PIECE = MiB;
const OPFS_MAX_INFLIGHT = 4;
const OPFS_PROBE_MS = 5000;
/** IdbBlobStore segment size; marker record at seg -1: {v, mtime, done, size?, segs?}. */
const IDB_SEG = 16 * MiB;
const IDB_MARKER = -1;
/** TauriFsStore read size for stream(). */
const TAURI_READ = 8 * MiB;

const isBlob = (x) => typeof Blob === 'function' && x instanceof Blob;

function checkId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new TypeError('store: invalid id');
}

function checkName(name) {
  if (typeof name !== 'string') throw new TypeError('store: stage() needs a name');
}

/** knownIds for sweep(): an Array, Set or other iterable of ids. Missing → TypeError (never "nothing is known"). */
function knownSet(knownIds) {
  if (knownIds instanceof Set) return knownIds;
  if (knownIds == null || typeof knownIds === 'string' || typeof knownIds[Symbol.iterator] !== 'function') {
    throw new TypeError('store: sweep() needs knownIds');
  }
  return new Set(knownIds);
}

function bytesOf(x) {
  if (x instanceof Uint8Array) return x;
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  return null;
}

/**
 * Any supported source → an (async) iterable of byte chunks. Throws TypeError up front for unsupported sources;
 * non-byte chunks throw TypeError while iterating.
 */
function sourceIterable(source) {
  if (isBlob(source)) return fileChunks(source, OPFS_PIECE);
  const whole = bytesOf(source);
  if (whole) return [whole];
  if (!source || typeof source === 'string' || (typeof source[Symbol.asyncIterator] !== 'function' && typeof source[Symbol.iterator] !== 'function')) {
    throw new TypeError('store: unsupported source');
  }
  return source;
}

/** Re-yields `iterable` as Uint8Arrays (TypeError for anything else), remembering the source's own failure. */
function tapSource(iterable) {
  const tap = { error: null };
  tap.iterable = (async function* checked() {
    try {
      for await (const chunk of iterable) {
        const u8 = bytesOf(chunk);
        if (!u8) throw new TypeError('store: source chunks must be bytes');
        yield u8;
      }
    } catch (e) {
      tap.error = e;
      throw e;
    }
  })();
  return tap;
}

/** Holds navigator.locks 'czd-store' exclusively if it is free; resolves `busy` when another holder has it. */
async function withStoreLock(fn, busy) {
  const locks = globalThis.navigator?.locks;
  if (!locks || typeof locks.request !== 'function') return fn();
  return locks.request('czd-store', { mode: 'exclusive', ifAvailable: true }, (lock) => (lock ? fn() : busy));
}

/** navigator.storage numbers (null when unavailable, e.g. WebKitGTK). */
async function webEstimate() {
  const [est, persisted] = await Promise.all([platform.storage.estimate(), platform.storage.persisted()]);
  if (!est && persisted === null) return null;
  const num = (v) => (Number.isFinite(v) ? v : null);
  return { usage: num(est?.usage), quota: num(est?.quota), persisted: typeof persisted === 'boolean' ? persisted : null };
}

/** Wraps a ByteSource so read failures become CzdErrors (a vanished file → 'item-file-missing'). */
function guardSource(src) {
  const map = (e) => {
    if (e instanceof CzdError || e instanceof TypeError) return e;
    if (e && (e.name === 'NotFoundError' || e.name === 'NotReadableError')) return new CzdError('item-file-missing', { cause: e });
    return toCzdError(e);
  };
  const out = {
    size: src.size,
    async readAt(off, len) {
      try {
        return await src.readAt(off, len);
      } catch (e) {
        throw map(e);
      }
    },
    async *stream(start, end) {
      try {
        yield* src.stream(start, end);
      } catch (e) {
        throw map(e);
      }
    },
  };
  if (src.blob) out.blob = src.blob;
  return out;
}

function checkRange(off, len, size) {
  if (!Number.isSafeInteger(off) || !Number.isSafeInteger(len) || off < 0 || len < 0) throw new TypeError('readAt(): bad range');
  if (off + len > size) throw new CzdError('truncated');
}

function streamBounds(start, end, size) {
  const a = start ?? 0;
  const b = end ?? size;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < a) throw new TypeError('stream(): bad range');
  if (b > size) throw new CzdError('truncated');
  return [a, b];
}

/**
 * Picks the backend for a NEW vault: 'tauri-fs' in the desktop app; else 'opfs' when the origin private file
 * system exists and the worker's sync-access-handle write/read probe passes; else 'idb'.
 * @returns {Promise<'opfs'|'idb'|'tauri-fs'>}
 */
export async function probeBestKind() {
  if (platform.isTauri) return 'tauri-fs';
  if (typeof globalThis.navigator?.storage?.getDirectory !== 'function' || typeof globalThis.Worker !== 'function') return 'idb';
  const client = new OpfsWorkerClient(defaultWorkerUrl());
  try {
    return (await withTimeout(client.call('probe'), OPFS_PROBE_MS)) === true ? 'opfs' : 'idb';
  } catch {
    return 'idb';
  } finally {
    client.terminate();
  }
}

/**
 * Opens the container store recorded in meta.storeKind and initializes it. Never switches backends:
 * any failure → CzdError('store-unavailable').
 * @param {'opfs'|'idb'|'tauri-fs'} kind
 * @param {{db?: import('../types.js').VaultDb, now?: () => number}} [opts] db is required for 'idb'
 * @returns {Promise<import('../types.js').ContainerStore>}
 */
export async function openStore(kind, { db, now } = {}) {
  let store;
  if (kind === 'opfs') store = new OpfsStore({ now });
  else if (kind === 'idb') {
    if (!db) throw new CzdError('store-unavailable', { detail: 'the idb store needs the vault db' });
    store = new IdbBlobStore(db, { now });
  } else if (kind === 'tauri-fs') {
    if (!platform.isTauri) throw new CzdError('store-unavailable', { detail: 'tauri-fs outside the desktop app' });
    store = new TauriFsStore({ now });
  } else {
    throw new CzdError('store-unavailable', { detail: `unknown store kind ${String(kind)}` });
  }
  try {
    await store.init();
  } catch (e) {
    store.close?.();
    throw e instanceof CzdError && e.code === 'store-unavailable' ? e : new CzdError('store-unavailable', { cause: e });
  }
  return store;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CzdError('store-unavailable', { detail: 'timeout' })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// ───────── OPFS

function defaultWorkerUrl() {
  return new URL('./opfs-worker.js', import.meta.url);
}

/** A worker {name, message} error → CzdError (QuotaExceededError → 'quota-exceeded'); cause keeps the name. */
function workerError(err) {
  const name = typeof err?.name === 'string' ? err.name : 'Error';
  const message = typeof err?.message === 'string' ? err.message : '';
  if (name === 'CzdError' && CODES.includes(message)) return new CzdError(message);
  const cause = typeof DOMException === 'function' ? new DOMException(message, name) : Object.assign(new Error(message), { name });
  if (name === 'QuotaExceededError') return new CzdError('quota-exceeded', { cause });
  return new CzdError('internal', { cause, detail: `${name}: ${message}` });
}

/** Request/response client for vault/opfs-worker.js: {rid, cmd, ...} → {rid, ok, result | error}. */
class OpfsWorkerClient {
  constructor(url) {
    this.url = url;
    this.worker = null;
    this.rid = 0;
    this.pending = new Map();
    /** Bumped whenever the worker goes away (terminate or crash): its open handles went with it. */
    this.gen = 0;
    this.lastError = null;
  }

  _start() {
    if (this.worker) return this.worker;
    let w;
    try {
      w = new Worker(this.url, { type: 'module', name: 'czd-opfs' });
    } catch (e) {
      throw new CzdError('store-unavailable', { cause: e, detail: 'opfs worker' });
    }
    w.onmessage = (ev) => {
      const m = ev.data;
      const p = m && this.pending.get(m.rid);
      if (!p) return;
      this.pending.delete(m.rid);
      if (m.ok) p.resolve(m.result);
      else p.reject(workerError(m.error));
    };
    w.onerror = (ev) => {
      ev.preventDefault?.();
      this._fail(new CzdError('store-unavailable', { detail: `opfs worker failed${ev.message ? `: ${ev.message}` : ''}` }));
    };
    w.onmessageerror = () => this._fail(new CzdError('internal', { detail: 'opfs worker message error' }));
    this.worker = w;
    return w;
  }

  /** Rejects everything pending and drops the worker (its sync access handles close with it). */
  _fail(err) {
    const w = this.worker;
    this.worker = null;
    this.gen++;
    this.lastError = err;
    try {
      w?.terminate();
    } catch {
      // gone already
    }
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(err);
  }

  /**
   * @param {string} cmd
   * @param {object} [args]
   * @param {Transferable[]} [transfer]
   * @param {number} [gen] only run on the worker of this generation (a command that continues a write must
   *   not reach a new worker, which never saw write-begin): otherwise reject with the error that ended it
   */
  call(cmd, args = {}, transfer = [], gen = undefined) {
    return new Promise((resolve, reject) => {
      if (gen !== undefined && gen !== this.gen) {
        reject(this.lastError ?? new CzdError('aborted', { detail: 'opfs worker gone' }));
        return;
      }
      let w;
      try {
        w = this._start();
      } catch (e) {
        reject(e);
        return;
      }
      const rid = ++this.rid;
      this.pending.set(rid, { resolve, reject });
      try {
        w.postMessage({ ...args, rid, cmd }, transfer);
      } catch (e) {
        this.pending.delete(rid);
        reject(toCzdError(e));
      }
    });
  }

  terminate() {
    this._fail(new CzdError('aborted', { detail: 'opfs worker terminated' }));
  }
}

/**
 * Web default store: containers at /czd/v1/items/<id>.czd in the origin private file system. Writes go through
 * the worker (sync access handle on the FINAL path, ≤ 4 chunks in flight, partial file removed on failure);
 * reads never open a handle: `getFile().slice()` in the calling context. Staged Send outputs live in
 * /czd/v1/tmp/<random>.tmp (the File handed back carries the real name).
 * @implements {import('../types.js').ContainerStore}
 */
export class OpfsStore {
  /** @param {{now?: () => number, workerUrl?: URL|string}} [opts] */
  constructor({ now = () => Date.now(), workerUrl } = {}) {
    this.kind = 'opfs';
    this.now = now;
    this._client = new OpfsWorkerClient(workerUrl ?? defaultWorkerUrl());
    this._dirs = null;
    /** Largest number of write-chunk messages seen in flight (tests). */
    this.maxInflight = 0;
  }

  async _handles() {
    if (!this._dirs) {
      this._dirs = (async () => {
        const storage = globalThis.navigator?.storage;
        if (typeof storage?.getDirectory !== 'function') throw new CzdError('store-unavailable', { detail: 'no OPFS' });
        try {
          const root = await storage.getDirectory();
          const v1 = await (await root.getDirectoryHandle('czd', { create: true })).getDirectoryHandle('v1', { create: true });
          return {
            items: await v1.getDirectoryHandle('items', { create: true }),
            tmp: await v1.getDirectoryHandle('tmp', { create: true }),
          };
        } catch (e) {
          throw new CzdError('store-unavailable', { cause: e, detail: e?.name });
        }
      })();
    }
    try {
      return await this._dirs;
    } catch (e) {
      this._dirs = null;
      throw e;
    }
  }

  /**
   * Creates the directories and runs the worker's write/read probe. A probe that fails only for lack of space
   * passes: a full origin still holds a readable vault, and deleting items is how the user frees space.
   */
  async init() {
    await this._handles();
    let ok;
    try {
      ok = await withTimeout(this._client.call('probe'), OPFS_PROBE_MS);
    } catch (e) {
      if (e instanceof CzdError && e.code === 'quota-exceeded') return;
      throw new CzdError('store-unavailable', { cause: e, detail: 'opfs probe' });
    }
    if (ok !== true) throw new CzdError('store-unavailable', { detail: 'opfs probe' });
  }

  /** Terminates the worker (a later call starts a new one). */
  close() {
    this._client.terminate();
  }

  /**
   * Streams `source` into `where`/`name` ('items' or 'tmp') through the worker; on any failure the partial
   * file is removed. Every command of one write goes to the worker that opened its handle: if that worker goes
   * away (close(), crash) the write rejects with the reason and the page removes the file itself.
   */
  async _put(where, name, source, signal) {
    const ab = abortable(signal);
    ab.checkpoint();
    const tap = tapSource(sourceIterable(source));
    // A Blob already arrives as fresh exact-size pieces (fileChunks); anything else is re-cut (and copied).
    const pieces = isBlob(source) ? tap.iterable : rechunk(tap.iterable, OPFS_PIECE);
    const path = `${where === 'tmp' ? OPFS_TMP : OPFS_ITEMS}/${name}`;
    const client = this._client;
    const gen = client.gen;
    try {
      await client.call('write-begin', { path }, [], gen);
    } catch (e) {
      // A live worker that refuses (e.g. another context holds the file) leaves the file alone; a worker that
      // went away mid-command may already have created it.
      if (client.gen !== gen) await this._removeHere(where, name);
      throw e;
    }
    const queue = [];
    let total = 0;
    try {
      for await (const piece of pieces) {
        ab.checkpoint();
        if (queue.length >= OPFS_MAX_INFLIGHT) await queue.shift();
        const exact = piece.byteOffset === 0 && piece.buffer.byteLength === piece.length ? piece : piece.slice();
        total += exact.length; // before the transfer detaches it
        const sent = client.call('write-chunk', { path, buf: exact.buffer }, [exact.buffer], gen);
        sent.catch(() => {}); // awaited below; don't report it as unhandled meanwhile
        queue.push(sent);
        this.maxInflight = Math.max(this.maxInflight, queue.length);
      }
      while (queue.length) await queue.shift();
      ab.checkpoint();
      const size = await client.call('write-commit', { path }, [], gen);
      if (size !== total) throw new CzdError('internal', { detail: `opfs size ${size} after writing ${total}` });
      return total;
    } catch (e) {
      await Promise.allSettled(queue);
      const removed = await client.call('write-abort', { path }, [], gen).then(() => true, () => false);
      if (!removed) await this._removeHere(where, name);
      throw tap.error ?? e;
    }
  }

  /**
   * Removes a partial file from the page when its writer is gone. The dead worker's handle is released
   * asynchronously, so a locked file is retried briefly; one still locked after that is left to the sweep.
   */
  async _removeHere(where, name) {
    let dir;
    try {
      dir = (await this._handles())[where];
    } catch {
      return;
    }
    for (let i = 0; i < 10; i++) {
      try {
        await dir.removeEntry(name);
        return;
      } catch (e) {
        if (e?.name !== 'NoModificationAllowedError' && e?.name !== 'InvalidModificationError') return;
      }
      await new Promise((r) => setTimeout(r, 25 * (i + 1)));
    }
  }

  /**
   * @param {string} id
   * @param {AsyncIterable<Uint8Array>|Iterable<Uint8Array>|Blob|Uint8Array} source
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<number>} bytes written
   */
  async write(id, source, { signal } = {}) {
    checkId(id);
    await this._handles();
    return this._put('items', `${id}.czd`, source, signal);
  }

  /**
   * @param {string} id
   * @returns {Promise<import('../types.js').ByteSource>} with `.blob` (the OPFS File)
   */
  async source(id) {
    checkId(id);
    const { items } = await this._handles();
    let file;
    try {
      file = await (await items.getFileHandle(`${id}.czd`)).getFile();
    } catch (e) {
      if (e?.name === 'NotFoundError') throw new CzdError('item-file-missing', { cause: e });
      throw toCzdError(e);
    }
    return guardSource(blobSource(file));
  }

  /** @param {string} id */
  async delete(id) {
    checkId(id);
    await this._client.call('delete', { path: `${OPFS_ITEMS}/${id}.czd` });
  }

  /** @returns {Promise<Array<{id: string, size: number, mtime: number}>>} */
  async list() {
    const out = [];
    for (const e of await this._client.call('list', { dir: OPFS_ITEMS })) {
      const m = ITEM_FILE_RE.exec(e.name);
      if (m) out.push({ id: m[1], size: e.size, mtime: e.mtime });
    }
    return out;
  }

  /**
   * Stages a Send output in /czd/v1/tmp and returns it as a File named `name`.
   * @param {string} name
   * @param {AsyncIterable<Uint8Array>|Iterable<Uint8Array>|Blob|Uint8Array} source
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<File>}
   */
  async stage(name, source, { signal } = {}) {
    checkName(name);
    const { tmp } = await this._handles();
    const file = `${toHex(randomBytes(16))}.tmp`;
    await this._put('tmp', file, source, signal);
    let disk;
    try {
      disk = await (await tmp.getFileHandle(file)).getFile();
    } catch (e) {
      throw toCzdError(e);
    }
    return new File([disk], safeFilename(name), { type: 'application/octet-stream', lastModified: disk.lastModified });
  }

  async _tryDelete(path) {
    try {
      await this._client.call('delete', { path });
      return true;
    } catch (e) {
      // Open in another context (a write in progress elsewhere) or already gone: leave it.
      if (e?.cause?.name === 'NoModificationAllowedError' || e?.cause?.name === 'NotFoundError') return false;
      throw e;
    }
  }

  /**
   * Deletes staged files older than 24 h and item files without a record older than 1 h, while holding
   * navigator.locks 'czd-store' (skipped, with `skipped: true`, when another context holds it).
   * The caller must hold the vault tab lock.
   * @param {{knownIds: Iterable<string>}} opts
   * @returns {Promise<{tmp: number, orphans: number, skipped?: boolean}>}
   */
  async sweep({ knownIds }) {
    const known = knownSet(knownIds);
    return withStoreLock(async () => {
      const t = this.now();
      let tmp = 0;
      let orphans = 0;
      for (const e of await this._client.call('list', { dir: OPFS_TMP })) {
        if (TMP_FILE_RE.test(e.name) && t - e.mtime > TMP_MAX_AGE && (await this._tryDelete(`${OPFS_TMP}/${e.name}`))) tmp++;
      }
      for (const e of await this._client.call('list', { dir: OPFS_ITEMS })) {
        const m = ITEM_FILE_RE.exec(e.name);
        if (m && !known.has(m[1]) && t - e.mtime > ORPHAN_MAX_AGE && (await this._tryDelete(`${OPFS_ITEMS}/${e.name}`))) orphans++;
      }
      return { tmp, orphans };
    }, { tmp: 0, orphans: 0, skipped: true });
  }

  /** navigator.storage estimate + persisted (fields null when unknown), or null. */
  async estimate() {
    return webEstimate();
  }
}

// ───────── IndexedDB segments

/** Blob → 16 MiB slices (no copy); anything else → 16 MiB Uint8Array pieces. */
function segmentsOf(source) {
  if (isBlob(source)) {
    return (function* slices() {
      for (let o = 0; o < source.size; o += IDB_SEG) yield source.slice(o, Math.min(source.size, o + IDB_SEG));
    })();
  }
  return rechunk(tapSource(sourceIterable(source)).iterable, IDB_SEG);
}

/**
 * Store for engines without OPFS: each container is 16 MiB Blob segments in the vault db's 'blobs' store under
 * [key, 0..n-1], plus a marker at [key, -1] ({v, mtime, done, size, segs}) written first and completed last, so a
 * half-written container is never readable and sweeps know its age. key = item id, or 'tmp:<random>' for
 * staged outputs. `source(id).blob` is the composite Blob of the segments.
 * @implements {import('../types.js').ContainerStore}
 */
export class IdbBlobStore {
  /**
   * @param {any} db the VaultDb from openVaultDb()
   * @param {{now?: () => number}} [opts]
   */
  constructor(db, { now = () => Date.now() } = {}) {
    this.kind = 'idb';
    this.db = db;
    this.now = now;
  }

  async init() {
    if (!this.db || typeof this.db.tx !== 'function') throw new CzdError('store-unavailable', { detail: 'no vault db' });
    if (this.db.closed) throw new CzdError('store-unavailable', { detail: 'vault db closed' });
    void this.db.keyRange; // throws store-unavailable without IDBKeyRange
  }

  _all(key) {
    return this.db.keyRange.bound([key, -Infinity], [key, Infinity]);
  }

  async _drop(key) {
    await this.db.tx(['blobs'], 'readwrite', (tx) => {
      tx.objectStore('blobs').delete(this._all(key));
    });
  }

  /** Aborts the transaction when the write's marker was removed under it (delete or sweep). */
  _stillOurs(os, key, abort) {
    const r = os.get([key, IDB_MARKER]);
    r.onsuccess = () => {
      if (!r.result || r.result.done !== false) abort(new CzdError('item-file-missing', { detail: 'removed while writing' }));
    };
  }

  async _put(key, source, signal) {
    const ab = abortable(signal);
    ab.checkpoint();
    const pieces = segmentsOf(source);
    const marker = (extra) => ({ v: 1, mtime: this.now(), done: false, ...extra });
    await this.db.tx(['blobs'], 'readwrite', (tx) => {
      const os = tx.objectStore('blobs');
      os.delete(this._all(key));
      os.put(marker(), [key, IDB_MARKER]);
    });
    let segs = 0;
    let total = 0;
    try {
      for await (const part of pieces) {
        ab.checkpoint();
        const blob = isBlob(part) ? part : new Blob([part]);
        const seg = segs;
        await this.db.tx(['blobs'], 'readwrite', (tx, abort) => {
          const os = tx.objectStore('blobs');
          this._stillOurs(os, key, abort);
          os.put(blob, [key, seg]);
          os.put(marker(), [key, IDB_MARKER]); // keeps the age fresh while a long write runs
        });
        segs++;
        total += blob.size;
      }
      ab.checkpoint();
      await this.db.tx(['blobs'], 'readwrite', (tx, abort) => {
        const os = tx.objectStore('blobs');
        this._stillOurs(os, key, abort);
        os.put(marker({ done: true, size: total, segs }), [key, IDB_MARKER]);
      });
      return total;
    } catch (e) {
      await this._drop(key).catch(() => {});
      throw e;
    }
  }

  /** The complete container under `key` as one Blob; 'item-file-missing' when absent or incomplete. */
  async _blob(key) {
    const KR = this.db.keyRange;
    const { marker, keys, blobs } = await this.db.tx(['blobs'], 'readonly', (tx) => {
      const os = tx.objectStore('blobs');
      const range = KR.bound([key, 0], [key, Infinity]);
      const m = os.get([key, IDB_MARKER]);
      const k = os.getAllKeys(range);
      const v = os.getAll(range);
      return () => ({ marker: m.result, keys: k.result, blobs: v.result });
    });
    if (!marker || marker.done !== true) throw new CzdError('item-file-missing');
    const ok = blobs.length === marker.segs && keys.every((k, i) => k[1] === i) && blobs.every(isBlob);
    const blob = ok ? new Blob(blobs) : null;
    if (!blob || blob.size !== marker.size) throw new CzdError('item-file-missing', { detail: 'segments missing' });
    return blob;
  }

  /**
   * @param {string} id
   * @param {AsyncIterable<Uint8Array>|Iterable<Uint8Array>|Blob|Uint8Array} source
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<number>}
   */
  async write(id, source, { signal } = {}) {
    checkId(id);
    return this._put(id, source, signal);
  }

  /** @param {string} id */
  async source(id) {
    checkId(id);
    return guardSource(blobSource(await this._blob(id)));
  }

  /** @param {string} id */
  async delete(id) {
    checkId(id);
    await this._drop(id);
  }

  /** Every key in the store with its marker (null when only segments are left). */
  async _scan() {
    return this.db.tx(['blobs'], 'readonly', (tx) => {
      const os = tx.objectStore('blobs');
      const found = new Map();
      const req = os.getAllKeys();
      req.onsuccess = () => {
        for (const k of req.result) {
          if (!Array.isArray(k) || typeof k[0] !== 'string') continue;
          if (!found.has(k[0])) found.set(k[0], null);
          if (k[1] === IDB_MARKER) {
            const m = os.get(k);
            m.onsuccess = () => found.set(k[0], m.result ?? null);
          }
        }
      };
      return () => found;
    });
  }

  /** @returns {Promise<Array<{id: string, size: number, mtime: number}>>} complete items only */
  async list() {
    const out = [];
    for (const [key, m] of await this._scan()) {
      if (ID_RE.test(key) && m?.done === true) out.push({ id: key, size: m.size, mtime: m.mtime });
    }
    return out;
  }

  /**
   * @param {string} name
   * @param {AsyncIterable<Uint8Array>|Iterable<Uint8Array>|Blob|Uint8Array} source
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<File>}
   */
  async stage(name, source, { signal } = {}) {
    checkName(name);
    const key = `tmp:${toHex(randomBytes(16))}`;
    await this._put(key, source, signal);
    return new File([await this._blob(key)], safeFilename(name), { type: 'application/octet-stream' });
  }

  /**
   * Same rules as OpfsStore.sweep; segments left without a marker count as old.
   * @param {{knownIds: Iterable<string>}} opts
   * @returns {Promise<{tmp: number, orphans: number, skipped?: boolean}>}
   */
  async sweep({ knownIds }) {
    const known = knownSet(knownIds);
    return withStoreLock(async () => {
      const t = this.now();
      const doomed = [];
      let tmp = 0;
      let orphans = 0;
      for (const [key, m] of await this._scan()) {
        const age = m && Number.isFinite(m.mtime) ? t - m.mtime : Infinity;
        if (key.startsWith('tmp:')) {
          if (age > TMP_MAX_AGE) {
            doomed.push(key);
            tmp++;
          }
        } else if (ID_RE.test(key) && !known.has(key) && age > ORPHAN_MAX_AGE) {
          doomed.push(key);
          orphans++;
        }
      }
      if (doomed.length) {
        await this.db.tx(['blobs'], 'readwrite', (tx) => {
          const os = tx.objectStore('blobs');
          for (const key of doomed) os.delete(this._all(key));
        });
      }
      return { tmp, orphans };
    }, { tmp: 0, orphans: 0, skipped: true });
  }

  /** navigator.storage numbers; without them (WebKitGTK) usage = Σ stored containers and staged files. */
  async estimate() {
    const web = await webEstimate();
    if (web && web.usage !== null) return web;
    let usage = 0;
    for (const m of (await this._scan()).values()) if (m?.done === true && Number.isFinite(m.size)) usage += m.size;
    return { usage, quota: web?.quota ?? null, persisted: web?.persisted ?? null };
  }
}

// ───────── Tauri

/**
 * Desktop store: containers at $APPDATA/vault2/items/<id>.czd through platform.tauriFs (first 8 MiB batch
 * creates the file, the rest is appended; a failed write removes it). Reads are readAt calls (no `.blob`).
 * There is no staging area: the desktop app always has a real save target.
 * @implements {import('../types.js').ContainerStore}
 */
export class TauriFsStore {
  /** @param {{fs?: typeof platform.tauriFs, now?: () => number}} [opts] fs is injectable for tests */
  constructor({ fs = platform.tauriFs, now = () => Date.now() } = {}) {
    this.kind = 'tauri-fs';
    this.fs = fs;
    this.now = now;
    this._dir = null;
    /** id → size (containers are never rewritten in place, so a size stays true until delete). */
    this._sizes = new Map();
    // A listing or stat that overlaps a write or delete of an id must not cache what it saw for that id (a
    // partial size, or a file that is gone): writes and deletes stamp the id, and in-progress writes are counted.
    this._clock = 0;
    /** @type {Map<string, number>} id → stamp of its last write/delete start or end */
    this._changed = new Map();
    /** @type {Map<string, number>} id → writes in progress */
    this._writing = new Map();
  }

  _touch(id) {
    this._changed.set(id, ++this._clock);
  }

  /** True when nothing wrote or deleted `id` since `since` (a `_clock` value) and no write of it is running. */
  _untouched(id, since) {
    return !this._writing.has(id) && (this._changed.get(id) ?? 0) <= since;
  }

  async _items() {
    if (!this._dir) {
      this._dir = (async () => {
        try {
          const dir = await this.fs.join(await this.fs.appDataDir(), 'vault2', 'items');
          await this.fs.mkdir(dir);
          return dir;
        } catch (e) {
          throw new CzdError('store-unavailable', { cause: e, detail: 'vault2/items' });
        }
      })();
    }
    try {
      return await this._dir;
    } catch (e) {
      this._dir = null;
      throw e;
    }
  }

  async _path(id) {
    checkId(id);
    return this.fs.join(await this._items(), `${id}.czd`);
  }

  async init() {
    await this._items();
  }

  /**
   * @param {string} id
   * @param {AsyncIterable<Uint8Array>|Iterable<Uint8Array>|Blob|Uint8Array} source
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<number>}
   */
  async write(id, source, { signal } = {}) {
    checkId(id);
    const ab = abortable(signal);
    ab.checkpoint();
    const tap = tapSource(sourceIterable(source));
    const path = await this._path(id);
    this._sizes.delete(id);
    this._writing.set(id, (this._writing.get(id) ?? 0) + 1);
    this._touch(id);
    let n;
    try {
      n = await this.fs.writeStream(path, tap.iterable, { signal });
    } catch (e) {
      throw tap.error ?? e;
    } finally {
      const left = this._writing.get(id) - 1;
      if (left > 0) this._writing.set(id, left);
      else this._writing.delete(id);
      this._touch(id);
    }
    this._sizes.set(id, n);
    return n;
  }

  /** Size of an item file, or undefined when there is none. */
  async _size(id, path) {
    if (this._sizes.has(id)) return this._sizes.get(id);
    if (typeof this.fs.stat === 'function') {
      const since = this._clock;
      try {
        const st = await this.fs.stat(path);
        if (Number.isSafeInteger(st?.size)) {
          if (this._untouched(id, since)) this._sizes.set(id, st.size);
          return st.size;
        }
      } catch {
        // fall back to the listing
      }
    }
    await this.list();
    return this._sizes.get(id);
  }

  /**
   * @param {string} id
   * @returns {Promise<import('../types.js').ByteSource>} (no `.blob`)
   */
  async source(id) {
    const path = await this._path(id);
    const size = await this._size(id, path);
    if (size === undefined) throw new CzdError('item-file-missing');
    const fs = this.fs;
    const fail = async (e) => {
      if (e instanceof CzdError && e.code === 'truncated') return e;
      const gone = await fs.exists(path).then((x) => !x, () => false);
      if (gone) return new CzdError('item-file-missing', { cause: e });
      return e instanceof CzdError ? e : toCzdError(e);
    };
    const read = async (off, len) => {
      try {
        return await fs.readAt(path, off, len);
      } catch (e) {
        throw await fail(e);
      }
    };
    return {
      size,
      async readAt(off, len) {
        checkRange(off, len, size);
        return len === 0 ? new Uint8Array(0) : read(off, len);
      },
      async *stream(start, end) {
        const [a, b] = streamBounds(start, end, size);
        for (let p = a; p < b; ) {
          const n = Math.min(TAURI_READ, b - p);
          yield await read(p, n);
          p += n;
        }
      },
    };
  }

  /** @param {string} id */
  async delete(id) {
    const path = await this._path(id);
    this._sizes.delete(id);
    this._touch(id);
    try {
      await this.fs.remove(path);
    } catch (e) {
      if (await this.fs.exists(path).catch(() => true)) throw e;
    } finally {
      this._touch(id);
    }
  }

  /** @returns {Promise<Array<{id: string, size: number, mtime: number|null}>>} */
  async list() {
    const dir = await this._items();
    const since = this._clock;
    let entries;
    try {
      entries = await this.fs.list(dir);
    } catch (e) {
      if (!(await this.fs.exists(dir).catch(() => true))) return [];
      throw e;
    }
    const out = [];
    const seen = new Set();
    for (const e of entries) {
      const m = e && e.isFile && typeof e.name === 'string' ? ITEM_FILE_RE.exec(e.name) : null;
      if (!m || !Number.isSafeInteger(e.size)) continue;
      out.push({ id: m[1], size: e.size, mtime: Number.isFinite(e.mtime) ? e.mtime : null });
      if (this._untouched(m[1], since)) this._sizes.set(m[1], e.size);
      seen.add(m[1]);
    }
    for (const id of [...this._sizes.keys()]) if (!seen.has(id) && this._untouched(id, since)) this._sizes.delete(id);
    return out;
  }

  /** Not available on desktop (Send always writes to a picked file or folder). */
  async stage(name, source, opts) {
    throw new CzdError('internal', { detail: 'TauriFsStore has no staging area' });
  }

  /**
   * Deletes item files without a record whose mtime is older than 1 h (files with an unknown mtime stay).
   * @param {{knownIds: Iterable<string>}} opts
   * @returns {Promise<{tmp: number, orphans: number, skipped?: boolean}>}
   */
  async sweep({ knownIds }) {
    const known = knownSet(knownIds);
    return withStoreLock(async () => {
      const t = this.now();
      let orphans = 0;
      for (const e of await this.list()) {
        if (known.has(e.id) || e.mtime === null || t - e.mtime <= ORPHAN_MAX_AGE) continue;
        try {
          await this.delete(e.id);
          orphans++;
        } catch {
          // locked or vanished: next sweep
        }
      }
      return { tmp: 0, orphans };
    }, { tmp: 0, orphans: 0, skipped: true });
  }

  /** {usage: Σ container sizes, quota: null, persisted: true} (files on disk are never evicted). */
  async estimate() {
    let usage = 0;
    for (const e of await this.list()) usage += e.size;
    return { usage, quota: null, persisted: true };
  }
}

// ───────── memory (tests)

/** Collects any supported source into Blob parts (copies), checking `signal` between chunks. */
async function toParts(source, signal) {
  const ab = abortable(signal);
  ab.checkpoint();
  if (isBlob(source)) return { parts: [source], size: source.size };
  const whole = bytesOf(source);
  if (whole) return { parts: [whole.slice()], size: whole.length };
  if (!source || typeof source === 'string' || (typeof source[Symbol.asyncIterator] !== 'function' && typeof source[Symbol.iterator] !== 'function')) {
    throw new TypeError('store: unsupported source');
  }
  const parts = [];
  let size = 0;
  for await (const chunk of source) {
    ab.checkpoint();
    const u8 = bytesOf(chunk);
    if (!u8) throw new TypeError('store: source chunks must be bytes');
    parts.push(u8.slice());
    size += u8.length;
  }
  ab.checkpoint();
  return { parts, size };
}

/**
 * In-memory ContainerStore for unit tests. Same contract as the real backends:
 * ids are 32 lowercase hex chars; a failed or aborted write leaves nothing behind;
 * `source(id)` resolves a ByteSource with `.blob`.
 * Options: `quota` (bytes; exceeding it throws CzdError('quota-exceeded')) and `now` (clock for sweeps).
 * @implements {import('../types.js').ContainerStore}
 */
export class MemoryStore {
  /** @param {{quota?: number, now?: () => number}} [opts] */
  constructor({ quota = Infinity, now = () => Date.now() } = {}) {
    this.kind = 'memory';
    this.quota = quota;
    this.now = now;
    /** @type {Map<string, {blob: Blob, mtime: number}>} */
    this.items = new Map();
    /** @type {Map<string, {file: File, mtime: number}>} */
    this.tmp = new Map();
  }

  async init() {}

  /** Bytes currently held (items + staged files). */
  usage() {
    let n = 0;
    for (const e of this.items.values()) n += e.blob.size;
    for (const e of this.tmp.values()) n += e.file.size;
    return n;
  }

  /**
   * @param {string} id
   * @param {AsyncIterable<Uint8Array>|Iterable<Uint8Array>|Blob|Uint8Array} source
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<number>} bytes written
   */
  async write(id, source, { signal } = {}) {
    checkId(id);
    const { parts, size } = await toParts(source, signal);
    const replaced = this.items.get(id)?.blob.size ?? 0;
    if (this.usage() - replaced + size > this.quota) throw new CzdError('quota-exceeded');
    this.items.set(id, { blob: new Blob(parts), mtime: this.now() });
    return size;
  }

  /**
   * @param {string} id
   * @returns {Promise<import('../types.js').ByteSource>}
   */
  async source(id) {
    const e = this.items.get(id);
    if (!e) throw new CzdError('item-file-missing');
    return blobSource(e.blob);
  }

  /** @param {string} id */
  async delete(id) {
    this.items.delete(id);
  }

  /** @returns {Promise<Array<{id: string, size: number, mtime: number}>>} */
  async list() {
    return [...this.items].map(([id, e]) => ({ id, size: e.blob.size, mtime: e.mtime }));
  }

  /**
   * Stages a temporary output (Send) and returns it as a File.
   * @param {string} name
   * @param {AsyncIterable<Uint8Array>|Iterable<Uint8Array>|Blob|Uint8Array} source
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<File>}
   */
  async stage(name, source, { signal } = {}) {
    const { parts, size } = await toParts(source, signal);
    const replaced = this.tmp.get(name)?.file.size ?? 0;
    if (this.usage() - replaced + size > this.quota) throw new CzdError('quota-exceeded');
    const file = new File(parts, name, { type: 'application/octet-stream' });
    this.tmp.set(name, { file, mtime: this.now() });
    return file;
  }

  /**
   * Deletes staged files older than 24 h and item files without a record older than 1 h.
   * @param {{knownIds: Iterable<string>}} opts
   * @returns {Promise<{tmp: number, orphans: number}>}
   */
  async sweep({ knownIds }) {
    const known = knownSet(knownIds);
    const t = this.now();
    let tmp = 0;
    let orphans = 0;
    for (const [name, e] of this.tmp) {
      if (t - e.mtime > TMP_MAX_AGE) { this.tmp.delete(name); tmp++; }
    }
    for (const [id, e] of this.items) {
      if (!known.has(id) && t - e.mtime > ORPHAN_MAX_AGE) { this.items.delete(id); orphans++; }
    }
    return { tmp, orphans };
  }

  /** @returns {Promise<{usage: number, quota: number|null, persisted: boolean}>} */
  async estimate() {
    return { usage: this.usage(), quota: Number.isFinite(this.quota) ? this.quota : null, persisted: false };
  }
}
