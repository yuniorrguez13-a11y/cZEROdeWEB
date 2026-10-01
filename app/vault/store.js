// Container stores: where encrypted vault containers live (DESIGN §4.2).
// Phase 0: MemoryStore (tests) is complete; probeBestKind/openStore and the OPFS, IDB and
// Tauri backends are owned by D.

import { CzdError } from '../errors.js';
import { abortable, blobSource } from '../util/stream.js';

const ID_RE = /^[0-9a-f]{32}$/;
const TMP_MAX_AGE = 24 * 3600 * 1000;
const ORPHAN_MAX_AGE = 3600 * 1000;

/**
 * Picks the best backend for this device.
 * @returns {Promise<'opfs'|'idb'|'tauri-fs'>}
 */
export async function probeBestKind() {
  throw new CzdError('not-implemented');
}

/**
 * Opens the container store recorded in meta.storeKind (never silently switches; failure → store-unavailable).
 * @param {string} kind
 * @param {{db: import('../types.js').VaultDb}} opts
 * @returns {Promise<import('../types.js').ContainerStore>}
 */
export async function openStore(kind, { db }) {
  throw new CzdError('not-implemented');
}

function bytesOf(x) {
  if (x instanceof Uint8Array) return x;
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  return null;
}

/** Collects any supported source into Blob parts (copies), checking `signal` between chunks. */
async function toParts(source, signal) {
  const ab = abortable(signal);
  ab.checkpoint();
  if (typeof Blob !== 'undefined' && source instanceof Blob) return { parts: [source], size: source.size };
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
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new TypeError('store: invalid id');
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
    const known = knownIds instanceof Set ? knownIds : new Set(knownIds ?? []);
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
