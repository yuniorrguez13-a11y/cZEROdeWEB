// Vault: the only module UI code uses for vault data (DESIGN §1.4–1.7, §3.5, §3.7, §4, §10).
// Key model (§3.5): KEK = Argon2id(passphrase) wraps a random 32-byte VMK (AES-GCM, aad "cZEROde vault v1" ‖ vaultId);
// an optional recovery code (20 random bytes) wraps it a second time. The VMK only ever lives as a non-extractable
// HKDF key that derives itemWrapKey (container vault stanzas), indexKey (encrypted index records) and backupKey (.czb).
// Every item is its own czd2 container (fresh fileKey) in the ContainerStore; IndexedDB holds the encrypted index.
// lock() is synchronous: running jobs are interrupted, keys, the decrypted index, thumbnail URLs and handed-out Opened
// objects are dropped, then state.purge(reason) clears everything else.
//
// Writes that were already started when lock() runs (and writes started from a 'locking' listener, e.g. the UI's
// pending deletes or a dirty note editor) captured their keys synchronously and finish; they never touch the
// in-memory index of a later unlock.

import { CzdError, isCancel, toCzdError } from '../errors.js';
import { CAPS, CHUNK_EXP } from '../config.js';
import * as state from '../state.js';
import { storage as platformStorage } from '../platform.js';
import { FLOOR, KDF_ARGON2ID, POLICY, checkParams, deriveKek, passphraseBytes } from '../crypto/kdf.js';
import { BUNDLE_TYPE, LIMITS, bundleMeta, containerSize, decryptSource, encryptStream, openSource, passStanza, release, vaultStanza } from '../crypto/container.js';
import { ascii, concat, ctEqual, fromB64, fromBase32, fromHex, fromUtf8, randomBytes, toB64, toBase32, toHex, utf8, zeroize } from '../util/bytes.js';
import { abortable, collect, fileChunks } from '../util/stream.js';
import { NOTE_TYPE, dedupeName, extOf, kindOf, mimeFromExt, safeFilename } from '../util/format.js';
import { makeThumb } from './thumbs.js';
import { planBackup, readBackupHeader, restore, writeBackup } from './backup.js';

/**
 * The app's Vault singleton (created by vault/boot.js via setVault). null until boot.
 * Importers see updates through the live binding.
 * @type {Vault|null}
 */
export let vault = null;

/**
 * Sets the singleton (boot.js; tests).
 * @param {Vault|null} v
 */
export function setVault(v) {
  vault = v;
}

// ───────── key model (§3.5)

const GCM = 'AES-GCM';
const AAD_WRAP = ascii('cZEROde vault v1');
const AAD_RWRAP = ascii('cZEROde recovery v1');
const INFO_ITEM_WRAP = 'cZEROde czd2 vault item-wrap';
const INFO_INDEX = 'cZEROde vault index';
const INFO_BACKUP = 'cZEROde backup';
const INFO_RECOVERY = 'cZEROde recovery';
/** AAD prefixes of the encrypted index records ('item:'‖id16, 'list:'‖id16, 'thumb:'‖id16). */
const REC = Object.freeze({ item: ascii('item:'), list: ascii('list:'), thumb: ascii('thumb:') });
const CODE_BYTES = 20;
const CODE_CHARS = 32;
const ID_RE = /^[0-9a-f]{32}$/;
const MIME_RE = /^[a-z0-9.+-]{1,60}\/[a-z0-9.+-]{1,60}$/;
/** Largest note payload decrypted for the editor or an export. */
const NOTE_MAX = 16 * 2 ** 20;
const LABEL_MAX = 200;
const NOTE_EXPORT_TYPE = 'text/plain';
// Container errors that mean "this stored item is not what the index says" (swapped, edited, truncated, replaced).
const TAMPER = new Set(['not-czd2', 'short-header', 'unsupported-version', 'unknown-flags', 'bad-chunk-size', 'bad-stanza-count',
  'too-many-stanzas', 'bad-stanza', 'bad-meta', 'no-usable-stanza', 'other-vault', 'item-mismatch', 'vault-unwrap-failed', 'header-mac',
  'meta-auth', 'size-mismatch', 'truncated', 'unsupported-kdf']);

const subtle = () => globalThis.crypto.subtle;
const hkdf = (salt, info) => ({ name: 'HKDF', hash: 'SHA-256', salt, info: ascii(info) });
const isPlain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isUint = (x) => Number.isSafeInteger(x) && x >= 0;
const clock = () => (typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now());

/** The raw VMK as a non-extractable HKDF key. */
function importVmk(raw) {
  return subtle().importKey('raw', raw, 'HKDF', false, ['deriveKey', 'deriveBits']);
}

/** itemWrapKey + indexKey (AES-256-GCM) and backupKey (HMAC-SHA256, 32-byte key) from the VMK, salt = vaultId. */
async function deriveVaultKeys(vmk, vaultId) {
  const aes = (info) => subtle().deriveKey(hkdf(vaultId, info), vmk, { name: GCM, length: 256 }, false, ['encrypt', 'decrypt']);
  const [itemWrap, index, backup] = await Promise.all([
    aes(INFO_ITEM_WRAP),
    aes(INFO_INDEX),
    subtle().deriveKey(hkdf(vaultId, INFO_BACKUP), vmk, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']),
  ]);
  return { itemWrap, index, backup };
}

/** RK = HKDF-SHA256(ikm = code bytes, salt = vaultId, "cZEROde recovery") as an AES-256-GCM key. */
async function recoveryKek(code, vaultId) {
  const ikm = await subtle().importKey('raw', code, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(hkdf(vaultId, INFO_RECOVERY), ikm, { name: GCM, length: 256 }, false, ['encrypt', 'decrypt']);
}

/** AES-GCM(kek, fresh iv, VMK, aad ‖ vaultId) → {iv, ct(48)}. */
async function sealVmk(kek, raw, vaultId, aad) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: GCM, iv, additionalData: concat(aad, vaultId) }, kek, raw));
  return { iv, ct };
}

/** Decrypts a VMK wrap to raw bytes; any failure → CzdError(code). */
async function openVmk(kek, wrap, vaultId, aad, code) {
  let raw;
  try {
    raw = new Uint8Array(await subtle().decrypt({ name: GCM, iv: wrap.iv, additionalData: concat(aad, vaultId) }, kek, wrap.ct));
  } catch {
    throw new CzdError(code);
  }
  if (raw.length !== 32) {
    zeroize(raw);
    throw new CzdError(code);
  }
  return raw;
}

/** Unlock path: unwrapKey straight into a non-extractable HKDF key (the raw VMK never reaches JS). */
async function unwrapVmk(kek, wrap, vaultId) {
  try {
    return await subtle().unwrapKey('raw', wrap.ct, kek, { name: GCM, iv: wrap.iv, additionalData: concat(AAD_WRAP, vaultId) },
      'HKDF', false, ['deriveKey', 'deriveBits']);
  } catch {
    throw new CzdError('wrong-passphrase');
  }
}

/** Encrypted index record body: {iv, enc = AES-GCM(indexKey, iv, bytes, aad = prefix ‖ id16)}. */
async function sealRecord(key, prefix, id16, bytes) {
  const iv = randomBytes(12);
  const enc = new Uint8Array(await subtle().encrypt({ name: GCM, iv, additionalData: concat(prefix, id16) }, key, bytes));
  return { iv, enc };
}

/** Decrypts an index record (rejects with the WebCrypto error on any mismatch). */
async function openRecord(key, prefix, id16, rec) {
  if (!(rec?.iv instanceof Uint8Array) || !(rec?.enc instanceof Uint8Array)) throw new TypeError('bad record');
  return new Uint8Array(await subtle().decrypt({ name: GCM, iv: rec.iv, additionalData: concat(prefix, id16) }, key, rec.enc));
}

/** Recovery code display form: 32 base32 characters as 8 groups of 4. */
function formatCode(bytes) {
  return toBase32(bytes).match(/.{4}/g).join('-');
}

/** Tolerant parse (case, '-', spaces, 0/1/8 look-alikes); anything that isn't 20 bytes → recovery-wrong. */
function parseCode(code) {
  const clean = typeof code === 'string' ? code.replace(/[\s-]+/g, '').replace(/=+$/, '') : '';
  if (clean.length !== CODE_CHARS) throw new CzdError('recovery-wrong');
  try {
    const bytes = fromBase32(clean);
    if (bytes.length !== CODE_BYTES) throw new TypeError('length');
    return bytes;
  } catch {
    throw new CzdError('recovery-wrong');
  }
}

function paramsOf(meta) {
  if (meta.kdf?.id !== KDF_ARGON2ID) throw new CzdError('unsupported-kdf');
  return { m: meta.kdf.m, t: meta.kdf.t, p: meta.kdf.p };
}

const sameParams = (a, b) => a.m === b.m && a.t === b.t && a.p === b.p;
const hasPass = (s) => typeof s === 'string' && passphraseBytes(s).length > 0;

/** navigator.locks 'czd-vault-record' (exclusive) around a vault-record read-modify-write, when available. */
function withRecordLock(fn) {
  const locks = globalThis.navigator?.locks;
  if (!locks || typeof locks.request !== 'function') return fn();
  return locks.request('czd-vault-record', { mode: 'exclusive' }, () => fn());
}

/** The bundle of key-model operations backup.js needs (no import cycle). */
const KM = Object.freeze({
  REC,
  withRecordLock,
  deriveVaultKeys,
  importVmk,
  sealRecord,
  openRecord,
  parseIndex,
  parseList,
  sanitizeIndex,
  cleanLabel,
  /**
   * Unlocks a backup's VMK with {pass} or {code} → {raw (32 bytes, caller zeroizes), vmk, keys}.
   * @param {{vaultId:Uint8Array, kdf:{id:number,m:number,t:number,p:number,salt:Uint8Array}, wrap:{iv,ct}, rwrap:{iv,ct}|null}} rec
   */
  async unlockRecord(rec, secret, { confirmKdf, signal } = {}) {
    let raw;
    if (secret && typeof secret.code === 'string') {
      const code = parseCode(secret.code);
      try {
        if (!rec.rwrap) throw new CzdError('recovery-wrong');
        raw = await openVmk(await recoveryKek(code, rec.vaultId), rec.rwrap, rec.vaultId, AAD_RWRAP, 'recovery-wrong');
      } finally {
        zeroize(code);
      }
    } else if (secret && typeof secret.pass === 'string') {
      if (!hasPass(secret.pass)) throw new CzdError('wrong-passphrase');
      const kek = await deriveKek(secret.pass, rec.kdf.salt, paramsOf(rec), { purpose: 'vault', confirmKdf, signal });
      raw = await openVmk(kek, rec.wrap, rec.vaultId, AAD_WRAP, 'wrong-passphrase');
    } else {
      throw new TypeError('restore: secret must be {pass} or {code}');
    }
    try {
      const vmk = await importVmk(raw);
      return { raw, vmk, keys: await deriveVaultKeys(vmk, rec.vaultId) };
    } catch (e) {
      zeroize(raw);
      throw e;
    }
  },
  /** A fresh passphrase wrap {kdf, wrap} for a raw VMK (same KDF parameters, new salt). */
  async rewrap(raw, vaultId, params, pass) {
    const salt = randomBytes(16);
    const kek = await deriveKek(pass, salt, params, { purpose: 'vault' });
    return { kdf: { id: KDF_ARGON2ID, m: params.m, t: params.t, p: params.p, salt }, wrap: await sealVmk(kek, raw, vaultId, AAD_WRAP) };
  },
});

// ───────── index records

/** ItemIndex JSON → object (authenticated by indexKey; still shape-checked). */
function parseIndex(bytes) {
  const o = JSON.parse(fromUtf8(bytes));
  if (!isPlain(o) || typeof o.name !== 'string' || typeof o.type !== 'string' || !isUint(o.size) || typeof o.hmac !== 'string') {
    throw new TypeError('bad index record');
  }
  return o;
}

/** List JSON → {name, itemIds, cover?, createdAt}. */
function parseList(bytes) {
  const o = JSON.parse(fromUtf8(bytes));
  if (!isPlain(o) || typeof o.name !== 'string' || !Array.isArray(o.itemIds)) throw new TypeError('bad list record');
  const l = { name: cleanLabel(o.name, 'Album'), itemIds: o.itemIds.filter((x) => typeof x === 'string' && ID_RE.test(x)), createdAt: isUint(o.createdAt) ? o.createdAt : 0 };
  if (typeof o.cover === 'string' && ID_RE.test(o.cover)) l.cover = o.cover;
  return l;
}

/** Index fields with names/types cleaned and unknown keys dropped (every record read at unlock, and merged records). */
function sanitizeIndex(ix) {
  const type = cleanType(ix.type, ix.name);
  const out = {
    name: type === NOTE_TYPE ? cleanLabel(ix.name, 'Note') : safeFilename(ix.name),
    type,
    size: ix.size,
    addedAt: isUint(ix.addedAt) ? ix.addedAt : 0,
    origName: typeof ix.origName === 'string' ? safeFilename(ix.origName) : safeFilename(ix.name),
    hmac: ix.hmac,
  };
  if (isUint(ix.mtime)) out.mtime = ix.mtime;
  if (ix.fav === true) out.fav = true;
  if (ix.hasThumb === true) out.hasThumb = true;
  if (Number.isFinite(ix.duration) && ix.duration >= 0) out.duration = ix.duration;
  if (isUint(ix.w) && isUint(ix.h) && ix.w > 0 && ix.h > 0) {
    out.w = ix.w;
    out.h = ix.h;
  }
  return out;
}

/**
 * "type/subtype" lowercased without parameters; missing/invalid/generic → the extension's type (or octet-stream).
 * The czd bundle type is reserved for bundle containers (the writer requires entries): a file claiming it is
 * typed like one with no type.
 */
function cleanType(type, name) {
  const t = typeof type === 'string' ? type.split(';', 1)[0].trim().toLowerCase() : '';
  if (MIME_RE.test(t) && t !== 'application/octet-stream' && t !== BUNDLE_TYPE) return t;
  const fromExt = mimeFromExt(extOf(typeof name === 'string' ? name : ''));
  return fromExt === BUNDLE_TYPE ? 'application/octet-stream' : fromExt;
}

/** cleanType for imported bytes (addFile/addStream): the note type is only ever set by addNote/saveNote. */
function importType(type, name) {
  const t = cleanType(type, name);
  return t === NOTE_TYPE ? cleanType('', name) : t;
}

const LABEL_STRIP = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g;

/** A user-typed label (note title, album name): invisible/control characters removed, NFC, trimmed, ≤ 200 units. */
function cleanLabel(s, fallback) {
  const t = String(s ?? '').replace(LABEL_STRIP, '').normalize('NFC').trim();
  let out = t.length > LABEL_MAX ? t.slice(0, LABEL_MAX) : t;
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out || fallback;
}

function toInfo(id, ix, storedBytes) {
  /** @type {import('../types.js').ItemInfo & {w?:number, h?:number}} */
  const info = {
    id,
    name: ix.name,
    type: ix.type,
    kind: kindOf(ix.type, ix.name),
    size: ix.size,
    addedAt: isUint(ix.addedAt) ? ix.addedAt : 0,
    storedBytes: isUint(storedBytes) ? storedBytes : 0,
    fav: ix.fav === true,
    hasThumb: ix.hasThumb === true,
  };
  if (isUint(ix.mtime)) info.mtime = ix.mtime;
  if (Number.isFinite(ix.duration) && ix.duration >= 0) info.duration = ix.duration;
  if (isUint(ix.w) && isUint(ix.h) && ix.w > 0 && ix.h > 0) {
    info.w = ix.w;
    info.h = ix.h;
  }
  return info;
}

function listInfo(id, l, items) {
  /** @type {import('../types.js').ListInfo} */
  const out = { id, name: l.name, itemIds: l.itemIds.filter((x) => items.has(x)), createdAt: l.createdAt };
  if (l.cover && items.has(l.cover) && l.itemIds.includes(l.cover)) out.cover = l.cover;
  return out;
}

/** Thumbnailer output → {jpeg?, w?, h?, duration?} (anything malformed dropped). */
function normalizeThumb(t) {
  if (!isPlain(t)) return null;
  const out = {};
  if (t.jpeg instanceof Uint8Array && t.jpeg.length > 0 && t.jpeg.length <= CAPS.thumbBytes) out.jpeg = t.jpeg;
  if (isUint(t.w) && isUint(t.h) && t.w > 0 && t.h > 0) {
    out.w = t.w;
    out.h = t.h;
  }
  if (Number.isFinite(t.duration) && t.duration >= 0) out.duration = t.duration;
  return out;
}

function notePayload(title, body) {
  return utf8(JSON.stringify({ v: 1, title: String(title ?? ''), body: String(body ?? '') }));
}

/** "<safe title>.txt" (DESIGN §11). */
function noteFileName(title) {
  const base = String(title ?? '').trim() || 'note';
  return safeFilename(/\.txt$/i.test(base) ? base : `${base}.txt`);
}

/** Exact czd2 length for one pass stanza and the meta object encryptStream will write (`{...meta, v: 1, size}`). */
function passContainerSize(meta, size) {
  const json = utf8(JSON.stringify({ ...meta, v: 1, size })).length;
  const metaLen = Math.ceil((4 + json) / 256) * 256 + 16;
  const headerLen = 28 + 3 + LIMITS.passBody + 16 + metaLen + 32;
  return containerSize(size, CHUNK_EXP, headerLen);
}

/** Any byte source → an iterable of Uint8Array pieces, reporting progress after each piece. */
async function* progressPieces(source, onProgress, total, signal) {
  const ab = abortable(signal);
  let it = source;
  if (typeof Blob !== 'undefined' && source instanceof Blob) it = fileChunks(source);
  else if (source && typeof source.readAt === 'function' && typeof source.stream === 'function') it = source.stream();
  else if (source instanceof Uint8Array || source instanceof ArrayBuffer || ArrayBuffer.isView(source)) it = [source];
  if (!it || typeof it === 'string' || (typeof it[Symbol.asyncIterator] !== 'function' && typeof it[Symbol.iterator] !== 'function')) {
    throw new TypeError('vault: source must be a Blob, bytes, a ByteSource or an (async) iterable of bytes');
  }
  let done = 0;
  for await (const raw of it) {
    ab.checkpoint();
    const piece = raw instanceof Uint8Array ? raw : ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
      : raw instanceof ArrayBuffer ? new Uint8Array(raw) : null;
    if (!piece) throw new TypeError('vault: source pieces must be bytes');
    done += piece.length;
    yield piece;
    report(onProgress, done, total);
  }
}

function report(onProgress, done, total) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress(done, total);
  } catch (e) {
    globalThis.console?.warn?.('[vault] onProgress failed', e);
  }
}

function isoDay(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Events (CustomEvent.detail): 'status' {status} | 'items' {added:[], removed:[], updated:[]} | 'lists' {} | 'job' {running:boolean}
 * — plus 'meta' {} (vault record changed: passphrase, recovery code, last backup) and 'locking' {reason} (dispatched
 * synchronously by lock() while the keys still exist: the last chance to start a pending delete or save a dirty note).
 */
export class Vault extends EventTarget {
  /**
   * @param {{db: import('../types.js').VaultDb|null, openStore: (kind?: string) => Promise<import('../types.js').ContainerStore>,
   *   policy?: {m:number,t:number,p:number}, thumbnailer?: (file: Blob, type: string) => Promise<object|null>, now?: () => number,
   *   isHolder?: () => boolean, useHere?: () => Promise<boolean>}} deps
   *   openStore(kind) opens the store of an existing vault (meta.storeKind); openStore() (no kind) probes and opens the best
   *   store for a new vault. db null → status 'unavailable'. useHere: boot's tab-lock takeover (extra over §10).
   */
  constructor({ db, openStore, policy = POLICY, thumbnailer, now = () => Date.now(), isHolder = () => true, useHere } = {}) {
    super();
    /** @type {'loading'|'none'|'locked'|'unlocked'|'other-tab'|'unavailable'} */
    this.status = 'loading';
    this.kdfParams = null;
    this.lastUnlockMs = null;
    this.lastBackupAt = null;
    this.hasRecovery = false;
    this.storeKind = null;
    this.floor = false;
    this._db = db ?? null;
    this._openStore = openStore;
    this._policy = { m: policy.m, t: policy.t, p: policy.p };
    this._thumbnailer = typeof thumbnailer === 'function' ? thumbnailer : makeThumb;
    this._now = now;
    this._isHolder = isHolder;
    this._useHere = typeof useHere === 'function' ? useHere : null;
    this._meta = null;
    this._store = null;
    this._storeError = null;
    this._keys = null;
    this._vaultId = null;
    /** @type {Map<string, {ix: object, storedBytes: number}>} */
    this._items = new Map();
    /** @type {Map<string, {name: string, itemIds: string[], cover?: string, createdAt: number}>} */
    this._lists = new Map();
    this._thumbUrls = new Map();
    /** id → how many thumbUrl() calls got the current URL and haven't released it (releaseThumb). */
    this._thumbRefs = new Map();
    this._thumbPending = new Map();
    this._opened = new Set();
    this._jobs = new Set();
    this._epoch = 0;
    this._chain = Promise.resolve();
    /** True while lock() runs (nested lock() calls are no-ops). */
    this._locking = false;
    /** True while lock() dispatches 'locking' (listeners may still write: pending deletes, a dirty note). */
    this._inLocking = false;
    /** Ids of index records that failed to decrypt at the last unlock (left in place, never shown). */
    this.damaged = [];
  }

  // ───────── status and plumbing

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this._emit('status', { status });
  }

  _applyMeta(meta) {
    this._meta = meta ?? null;
    this.kdfParams = meta?.kdf ? { m: meta.kdf.m, t: meta.kdf.t, p: meta.kdf.p } : null;
    this.floor = meta?.floor === true;
    this.hasRecovery = Boolean(meta?.rwrap);
    this.storeKind = meta?.storeKind ?? null;
    this.lastBackupAt = isUint(meta?.lastBackupAt) ? meta.lastBackupAt : null;
  }

  /** Status when not unlocked. */
  _restStatus() {
    if (!this._db) return 'unavailable';
    if (!this._isHolder()) return 'other-tab';
    if (!this._meta) return 'none';
    return this._storeError ? 'unavailable' : 'locked';
  }

  _requireDb() {
    if (!this._db) throw new CzdError('store-unavailable');
  }

  _requireHolder() {
    if (!this._isHolder()) throw new CzdError('other-tab');
  }

  /**
   * Index/container writes need the tab lock, except writes started by a 'locking' listener (pending deletes, a dirty
   * note): when the lock comes from losing the tab lock ('remote'), the tab is no longer the holder by then.
   */
  _requireWriter() {
    if (!this._inLocking) this._requireHolder();
  }

  async _ensureStore() {
    if (this._store) return this._store;
    if (!this._meta) throw new CzdError('no-vault');
    let store;
    try {
      store = await this._openStore(this._meta.storeKind);
    } catch (e) {
      throw e instanceof CzdError && e.code === 'store-unavailable' ? e : new CzdError('store-unavailable', { cause: e });
    }
    if (!store) throw new CzdError('store-unavailable');
    this._store = store;
    this._storeError = null;
    return store;
  }

  async _newStore() {
    if (this._store) return this._store;
    let store;
    try {
      store = await this._openStore();
    } catch (e) {
      throw e instanceof CzdError && e.code === 'store-unavailable' ? e : new CzdError('store-unavailable', { cause: e });
    }
    if (!store) throw new CzdError('store-unavailable');
    this._store = store;
    return store;
  }

  /** Keys and index captured synchronously: later awaits keep working on them even if lock() runs meanwhile. */
  _ctx() {
    if (this.status !== 'unlocked' || !this._keys) throw new CzdError('vault-locked');
    return { keys: this._keys, vaultId: this._vaultId, epoch: this._epoch, store: this._store, items: this._items, lists: this._lists };
  }

  /** True while no lock happened since ctx was captured. */
  _live(ctx) {
    return ctx.epoch === this._epoch;
  }

  /** Index mutations run one at a time (read-modify-write of the in-memory index and lists). */
  _mutex(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.then(() => {}, () => {});
    return run;
  }

  /**
   * Registers a running job (import/export/backup/restore): state.busy, 'job' events, and an AbortSignal that the
   * caller's signal and lock() both abort. fail(e) maps a lock-caused abort to 'interrupted'.
   */
  _job(signal) {
    const ctl = new AbortController();
    const job = { ctl, locked: false };
    let off = null;
    if (signal) {
      if (signal.aborted) ctl.abort(signal.reason);
      else {
        const on = () => ctl.abort(signal.reason);
        signal.addEventListener('abort', on, { once: true });
        off = () => signal.removeEventListener('abort', on);
      }
    }
    this._jobs.add(job);
    state.busy(1);
    if (this._jobs.size === 1) this._emit('job', { running: true });
    let ended = false;
    return {
      signal: ctl.signal,
      fail(e) {
        if (job.locked && (isCancel(e) || e?.code === 'interrupted')) return new CzdError('interrupted', { cause: e });
        return e instanceof CzdError || e instanceof TypeError || e instanceof RangeError ? e : toCzdError(e);
      },
      end: () => {
        if (ended) return;
        ended = true;
        off?.();
        this._jobs.delete(job);
        state.busy(-1);
        if (this._jobs.size === 0) this._emit('job', { running: false });
      },
    };
  }

  _track(opened) {
    for (const o of this._opened) if (!o.keys) this._opened.delete(o);
    this._opened.add(opened);
  }

  _release(opened) {
    release(opened);
    this._opened.delete(opened);
  }

  /** Revokes an item's thumbnail URL whatever its references (lock, removal, replacement) and drops a pending decrypt. */
  _revokeThumb(id) {
    this._thumbRefs.delete(id);
    this._thumbPending.delete(id);
    const url = this._thumbUrls.get(id);
    if (url) {
      this._thumbUrls.delete(id);
      try {
        URL.revokeObjectURL(url);
      } catch {
        // already revoked
      }
    }
  }

  _revokeThumbs() {
    for (const id of [...this._thumbUrls.keys()]) this._revokeThumb(id);
    this._thumbPending.clear();
    this._thumbRefs.clear();
  }

  /** Decrypts every items and lists record (thumbs stay encrypted until thumbUrl). Broken records are skipped. */
  async _loadIndex(keys) {
    const [itemRecs, listRecs] = await Promise.all([this._db.getAll('items'), this._db.getAll('lists')]);
    const items = new Map();
    const lists = new Map();
    const damaged = [];
    await Promise.all(itemRecs.map(async (r) => {
      try {
        const ix = sanitizeIndex(parseIndex(await openRecord(keys.index, REC.item, fromHex(r.id), r)));
        items.set(r.id, { ix, storedBytes: isUint(r.storedBytes) ? r.storedBytes : 0 });
      } catch {
        damaged.push(r.id);
      }
    }));
    await Promise.all(listRecs.map(async (r) => {
      try {
        lists.set(r.id, parseList(await openRecord(keys.index, REC.list, fromHex(r.id), r)));
      } catch {
        damaged.push(r.id);
      }
    }));
    if (damaged.length) globalThis.console?.warn?.(`[vault] ${damaged.length} index record(s) could not be decrypted`);
    return { items, lists, damaged };
  }

  async _finishUnlock(vmk, meta, epoch) {
    const keys = await deriveVaultKeys(vmk, meta.vaultId);
    const { items, lists, damaged } = await this._loadIndex(keys);
    if (epoch !== this._epoch) throw new CzdError('aborted', { detail: 'locked while unlocking' });
    // An overlapping unlock finished first: keep its index (work started since then holds those Maps).
    if (this.status === 'unlocked' && this._keys) return;
    this._keys = keys;
    this._vaultId = meta.vaultId.slice();
    this._items = items;
    this._lists = lists;
    this.damaged = damaged;
    this._setStatus('unlocked');
  }

  async _sealList(ctx, id, l) {
    const body = { name: l.name, itemIds: l.itemIds, createdAt: l.createdAt };
    if (l.cover) body.cover = l.cover;
    return { id, ...(await sealRecord(ctx.keys.index, REC.list, fromHex(id), utf8(JSON.stringify(body)))) };
  }

  async _sealItem(ctx, id, ix, storedBytes) {
    return { id, ...(await sealRecord(ctx.keys.index, REC.item, fromHex(id), utf8(JSON.stringify(ix)))), storedBytes };
  }

  // ───────── lifecycle

  /** Reads meta.vault and sets status ('none' | 'locked' | 'other-tab' | 'unavailable'). Safe to call again. */
  async init() {
    if (this.status === 'unlocked') return;
    if (!this._db) {
      this._setStatus('unavailable');
      return;
    }
    let meta;
    try {
      meta = await this._db.getMeta();
    } catch (e) {
      this._storeError = toCzdError(e);
      this._setStatus('unavailable');
      return;
    }
    this._applyMeta(meta);
    this._storeError = null;
    if (meta && this._isHolder()) {
      try {
        await this._ensureStore();
      } catch (e) {
        this._storeError = e;
      }
    }
    if (this.status !== 'unlocked') this._setStatus(this._restStatus());
  }

  /**
   * Creates the vault (status must be 'none') and leaves it unlocked.
   * params: KDF parameters (default: the policy; FLOOR after a kdf-out-of-memory → the vault is flagged floor).
   * recovery: also create a recovery code (returned once, never stored).
   * @returns {Promise<{ms: number, recoveryCode: string|null}>}
   */
  async create(pass, { params, recovery = true } = {}) {
    this._requireDb();
    this._requireHolder();
    if (!hasPass(pass)) throw new TypeError('create(): empty passphrase');
    if (this.status === 'unlocked' || this._meta) throw new CzdError('vault-exists');
    const prm = params ? { m: params.m, t: params.t, p: params.p } : { ...this._policy };
    checkParams(prm);
    const epoch = this._epoch;
    const t0 = clock();
    const store = await this._newStore();
    const vaultId = randomBytes(16);
    const salt = randomBytes(16);
    const kek = await deriveKek(pass, salt, prm, { purpose: 'vault' });
    const raw = randomBytes(32);
    const code = recovery ? randomBytes(CODE_BYTES) : null;
    try {
      const wrap = await sealVmk(kek, raw, vaultId, AAD_WRAP);
      const rwrap = code ? await sealVmk(await recoveryKek(code, vaultId), raw, vaultId, AAD_RWRAP) : null;
      const vmk = await importVmk(raw);
      const keys = await deriveVaultKeys(vmk, vaultId);
      const meta = {
        v: 1,
        vaultId,
        kdf: { id: KDF_ARGON2ID, m: prm.m, t: prm.t, p: prm.p, salt },
        floor: sameParams(prm, FLOOR) && !sameParams(prm, POLICY),
        wrap,
        rwrap,
        storeKind: store.kind,
        createdAt: this._now(),
        lastBackupAt: null,
      };
      try {
        await this._db.putMeta(meta, { expectWrapCt: null });
      } catch (e) {
        if (e instanceof CzdError && e.code === 'vault-exists') await this.init().catch(() => {});
        throw e;
      }
      this._applyMeta(meta);
      this._storeError = null;
      this._emit('meta', {});
      const recoveryCode = code ? formatCode(code) : null;
      const ms = Math.round(clock() - t0);
      if (epoch === this._epoch) {
        this._keys = keys;
        this._vaultId = vaultId.slice();
        this._items = new Map();
        this._lists = new Map();
        this.damaged = [];
        this.lastUnlockMs = ms;
        this._setStatus('unlocked');
      } else {
        this._setStatus(this._restStatus());
      }
      return { ms, recoveryCode };
    } finally {
      zeroize(raw);
      zeroize(code);
    }
  }

  /**
   * Unlocks with the passphrase. Throws wrong-passphrase, other-tab, no-vault, store-unavailable.
   * @returns {Promise<{ms: number}>}
   */
  async unlock(pass, { confirmKdf } = {}) {
    this._requireDb();
    this._requireHolder();
    if (this.status === 'unlocked') return { ms: 0 };
    const epoch = this._epoch;
    const t0 = clock();
    const meta = await this._db.getMeta();
    this._applyMeta(meta);
    if (!meta) {
      this._setStatus(this._restStatus());
      throw new CzdError('no-vault');
    }
    await this._ensureStore();
    if (!hasPass(pass)) throw new CzdError('wrong-passphrase');
    const kek = await deriveKek(pass, meta.kdf.salt, paramsOf(meta), { purpose: 'vault', confirmKdf });
    const vmk = await unwrapVmk(kek, meta.wrap, meta.vaultId);
    await this._finishUnlock(vmk, meta, epoch);
    const ms = Math.round(clock() - t0);
    this.lastUnlockMs = ms;
    return { ms };
  }

  /**
   * Opens the vault with the recovery code and sets newPass as its passphrase (same KDF parameters, new salt).
   * The recovery code keeps working. Throws recovery-wrong.
   * @returns {Promise<{ms: number}>}
   */
  async unlockWithRecovery(code, newPass) {
    this._requireDb();
    this._requireHolder();
    if (!hasPass(newPass)) throw new TypeError('unlockWithRecovery(): empty new passphrase');
    const bytes = parseCode(code);
    const epoch = this._epoch;
    const t0 = clock();
    try {
      await withRecordLock(async () => {
        const meta = await this._db.getMeta();
        this._applyMeta(meta);
        if (!meta) throw new CzdError('no-vault');
        await this._ensureStore();
        if (!meta.rwrap) throw new CzdError('recovery-wrong');
        const raw = await openVmk(await recoveryKek(bytes, meta.vaultId), meta.rwrap, meta.vaultId, AAD_RWRAP, 'recovery-wrong');
        try {
          const { kdf, wrap } = await KM.rewrap(raw, meta.vaultId, paramsOf(meta), newPass);
          const next = { ...meta, kdf, wrap };
          await this._db.putMeta(next, { expectWrapCt: meta.wrap.ct });
          this._applyMeta(next);
          this._emit('meta', {});
          if (this.status !== 'unlocked') await this._finishUnlock(await importVmk(raw), next, epoch);
        } finally {
          zeroize(raw);
        }
      });
    } finally {
      zeroize(bytes);
    }
    const ms = Math.round(clock() - t0);
    this.lastUnlockMs = ms;
    return { ms };
  }

  /**
   * Synchronous lock: interrupts running jobs, emits 'locking', drops keys, the decrypted index, thumbnail URLs and
   * every Opened handed out, sets the status, then state.purge(reason).
   * @param {string} reason 'user'|'idle'|'hidden'|'pagehide'|'freeze'|'panic'|'remote'|…
   */
  lock(reason) {
    // A lock() from inside this one (a 'locking' listener, a status listener, or a purge handler that locks): the
    // running lock completes everything.
    if (this._locking) return;
    this._locking = true;
    try {
      const why = String(reason ?? 'user');
      for (const job of this._jobs) {
        if (job.locked) continue;
        job.locked = true;
        job.ctl.abort(new CzdError('interrupted'));
      }
      if (this.status === 'unlocked' && this._keys) {
        this._inLocking = true;
        try {
          this._emit('locking', { reason: why });
        } catch (e) {
          globalThis.console?.warn?.('[vault] locking listener failed', e);
        } finally {
          this._inLocking = false;
        }
      }
      this._epoch++;
      this._keys = null;
      this._vaultId = null;
      this._items = new Map();
      this._lists = new Map();
      this.damaged = [];
      this._revokeThumbs();
      for (const o of this._opened) release(o);
      this._opened.clear();
      if (this.status !== 'loading') this._setStatus(this._restStatus());
      state.purge(why);
    } finally {
      this._locking = false;
    }
  }

  /** Re-wraps the VMK with a new passphrase (old one required). CAS on the vault record → vault-changed. */
  async changePassphrase(oldPass, newPass) {
    this._requireDb();
    this._requireHolder();
    this._ctx();
    if (!hasPass(newPass)) throw new TypeError('changePassphrase(): empty new passphrase');
    await withRecordLock(async () => {
      const meta = await this._requireMeta();
      const raw = await this._rawVmk(meta, oldPass);
      try {
        const { kdf, wrap } = await KM.rewrap(raw, meta.vaultId, paramsOf(meta), newPass);
        const next = { ...meta, kdf, wrap };
        await this._db.putMeta(next, { expectWrapCt: meta.wrap.ct });
        this._applyMeta(next);
        this._emit('meta', {});
      } finally {
        zeroize(raw);
      }
    });
  }

  /**
   * Creates (or replaces) the recovery code; asks for the passphrase. -> code (8 groups of 4 base32 characters).
   * @returns {Promise<string>}
   */
  async setRecovery(pass) {
    this._requireDb();
    this._requireHolder();
    return withRecordLock(async () => {
      const meta = await this._requireMeta();
      const raw = await this._rawVmk(meta, pass);
      const code = randomBytes(CODE_BYTES);
      try {
        const rwrap = await sealVmk(await recoveryKek(code, meta.vaultId), raw, meta.vaultId, AAD_RWRAP);
        const next = { ...meta, rwrap };
        await this._db.putMeta(next, { expectWrapCt: meta.wrap.ct });
        this._applyMeta(next);
        this._emit('meta', {});
        return formatCode(code);
      } finally {
        zeroize(raw);
        zeroize(code);
      }
    });
  }

  /** Removes the recovery code (asks for the passphrase). */
  async removeRecovery(pass) {
    this._requireDb();
    this._requireHolder();
    await withRecordLock(async () => {
      const meta = await this._requireMeta();
      zeroize(await this._rawVmk(meta, pass));
      const next = { ...meta, rwrap: null };
      await this._db.putMeta(next, { expectWrapCt: meta.wrap.ct });
      this._applyMeta(next);
      this._emit('meta', {});
    });
  }

  async _requireMeta() {
    const meta = await this._db.getMeta();
    if (!meta) {
      this._applyMeta(null);
      throw new CzdError('no-vault');
    }
    if (this._vaultId && !ctEqual(meta.vaultId, this._vaultId)) throw new CzdError('vault-changed');
    return meta;
  }

  /** The raw VMK from the passphrase wrap (caller zeroizes). */
  async _rawVmk(meta, pass) {
    if (!hasPass(pass)) throw new CzdError('wrong-passphrase');
    const kek = await deriveKek(pass, meta.kdf.salt, paramsOf(meta), { purpose: 'vault' });
    return openVmk(kek, meta.wrap, meta.vaultId, AAD_WRAP, 'wrong-passphrase');
  }

  /** Deletes the vault: the database is cleared, then every container is deleted; status 'none'. */
  async destroy() {
    this._requireDb();
    this._requireHolder();
    const meta = this._meta;
    this.lock('destroy');
    const recs = await this._db.getAll('items').catch(() => []);
    let store = this._store;
    if (!store && meta) store = await Promise.resolve().then(() => this._openStore(meta.storeKind)).catch(() => null);
    const ids = new Set(recs.map((r) => r.id));
    if (store) for (const e of await store.list().catch(() => [])) ids.add(e.id);
    await this._db.clearAll();
    this._applyMeta(null);
    this._storeError = null;
    this._setStatus(this._restStatus());
    this._emit('meta', {});
    if (store) await Promise.all([...ids].map((id) => store.delete(id).catch(() => {})));
  }

  // ───────── reading the index

  /** Sync; throws vault-locked. -> ItemInfo[] (newest first). */
  items() {
    const ctx = this._ctx();
    const out = [];
    for (const [id, e] of ctx.items) out.push(toInfo(id, e.ix, e.storedBytes));
    return out.sort((a, b) => b.addedAt - a.addedAt || (a.id < b.id ? -1 : 1));
  }

  /** Sync; throws vault-locked / item-not-found. -> ItemInfo. */
  item(id) {
    const e = this._ctx().items.get(id);
    if (!e) throw new CzdError('item-not-found');
    return toInfo(id, e.ix, e.storedBytes);
  }

  /** Sync; throws vault-locked. -> ListInfo[] (oldest first; itemIds limited to existing items). */
  lists() {
    const ctx = this._ctx();
    const out = [];
    for (const [id, l] of ctx.lists) out.push(listInfo(id, l, ctx.items));
    return out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  }

  /** Sync; throws vault-locked / item-not-found. -> ListInfo. */
  list(id) {
    const ctx = this._ctx();
    const l = ctx.lists.get(id);
    if (!l) throw new CzdError('item-not-found');
    return listInfo(id, l, ctx.items);
  }

  /**
   * Object URL of the item's thumbnail (decrypted on first use, shared by every view showing it) or null. Each call
   * that resolves to a URL takes one reference: hand it back with releaseThumb(id) once that view no longer shows
   * it (a null result needs no release). The URL is revoked when the last reference goes, and on lock/removal.
   * @param {string} id
   * @returns {Promise<string|null>}
   */
  async thumbUrl(id) {
    const ctx = this._ctx();
    const e = ctx.items.get(id);
    if (!e || e.ix.hasThumb !== true) return null;
    let url = this._thumbUrls.get(id);
    if (!url) {
      let pending = this._thumbPending.get(id);
      if (!pending) {
        pending = (async () => {
          const rec = await this._db.get('thumbs', id);
          if (!rec) return null;
          let jpeg;
          try {
            jpeg = await openRecord(ctx.keys.index, REC.thumb, fromHex(id), rec);
          } catch {
            return null;
          }
          // Locked or removed while decrypting: nobody would revoke a URL made now.
          if (!this._live(ctx) || !ctx.items.has(id) || this._thumbPending.get(id) !== pending) return null;
          const made = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
          this._thumbUrls.set(id, made);
          return made;
        })().finally(() => {
          if (this._thumbPending.get(id) === pending) this._thumbPending.delete(id);
        });
        this._thumbPending.set(id, pending);
      }
      url = await pending;
    }
    // Only the URL still current gets a reference (a lock or removal may have revoked it meanwhile).
    if (!url || this._thumbUrls.get(id) !== url) return null;
    this._thumbRefs.set(id, (this._thumbRefs.get(id) ?? 0) + 1);
    return url;
  }

  /**
   * Hands back one reference taken by thumbUrl(id) (a grid card, album cover or picker row stopped showing it,
   * §12); the URL is revoked when none is left, and a later thumbUrl(id) decrypts a fresh one. Extra over §10. Safe
   * while locked and for unknown ids (no-op without a reference).
   * @param {string} id
   */
  releaseThumb(id) {
    const n = this._thumbRefs.get(id) ?? 0;
    if (n > 1) {
      this._thumbRefs.set(id, n - 1);
      return;
    }
    if (n === 1) this._revokeThumb(id);
  }

  // ───────── adding

  _thumb(blob, type) {
    return Promise.resolve()
      .then(() => this._thumbnailer(blob, type))
      .catch(() => null);
  }

  /**
   * Encrypts `source` into a fresh container (new id, vault stanza), writes it, verifies the stored header, then commits
   * the index record (+ thumbnail, album membership; replacing `replaces` for notes) in ONE transaction. Any failure
   * deletes the written container.
   */
  async _addCore({ name, type, size, mtime }, source, { album, signal, onProgress, thumb, replaces, carry } = {}) {
    const ctx = this._ctx();
    this._requireWriter();
    if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('vault: size must be a safe integer ≥ 0');
    const job = this._job(signal);
    const id16 = randomBytes(16);
    const id = toHex(id16);
    let written = false;
    try {
      const ab = abortable(job.signal);
      const meta = { name, type };
      if (mtime !== undefined) meta.mtime = mtime;
      let mac = null;
      const enc = encryptStream(progressPieces(source, onProgress, size, job.signal), {
        size,
        meta,
        signal: job.signal,
        stanzasFor: async (fk) => [await vaultStanza(fk, ctx.keys.itemWrap, ctx.vaultId, id16)],
      });
      const tapped = (async function* tap() {
        for await (const piece of enc) {
          mac ??= piece.slice(piece.length - 32);
          yield piece;
        }
      })();
      ab.checkpoint();
      written = true;
      const storedBytes = await ctx.store.write(id, tapped, { signal: job.signal });
      ab.checkpoint();
      const hmac = await verifyStored(ctx, id, id16, mac, job.signal);
      const th = normalizeThumb(await thumb);
      ab.checkpoint();
      const ix = { name, type, size, addedAt: carry?.addedAt ?? this._now(), origName: carry?.origName ?? name, hmac };
      if (mtime !== undefined) ix.mtime = mtime;
      if (carry?.fav === true) ix.fav = true;
      if (th?.jpeg) ix.hasThumb = true;
      if (th?.duration !== undefined) ix.duration = th.duration;
      if (th?.w) {
        ix.w = th.w;
        ix.h = th.h;
      }
      const itemRec = await this._sealItem(ctx, id, ix, storedBytes);
      const thumbRec = th?.jpeg ? { id, ...(await sealRecord(ctx.keys.index, REC.thumb, id16, th.jpeg)) } : null;
      const changed = await this._mutex(async () => {
        const lists = new Map();
        if (replaces) {
          for (const [lid, l] of ctx.lists) {
            if (!l.itemIds.includes(replaces) && l.cover !== replaces) continue;
            const nl = { ...l, itemIds: l.itemIds.map((x) => (x === replaces ? id : x)) };
            if (l.cover === replaces) nl.cover = id;
            lists.set(lid, nl);
          }
        }
        if (album != null && ctx.lists.has(album)) {
          const l = lists.get(album) ?? ctx.lists.get(album);
          if (!l.itemIds.includes(id)) lists.set(album, { ...l, itemIds: [...l.itemIds, id] });
        }
        const ops = [{ op: 'put', store: 'items', value: itemRec }];
        if (thumbRec) ops.push({ op: 'put', store: 'thumbs', value: thumbRec });
        if (replaces) ops.push({ op: 'delete', store: 'items', key: replaces }, { op: 'delete', store: 'thumbs', key: replaces });
        for (const [lid, l] of lists) ops.push({ op: 'put', store: 'lists', value: await this._sealList(ctx, lid, l) });
        ab.checkpoint();
        await this._db.commit(ops);
        written = false; // committed: the container belongs to the index now
        if (this._live(ctx)) {
          ctx.items.set(id, { ix, storedBytes });
          if (replaces) {
            ctx.items.delete(replaces);
            this._revokeThumb(replaces);
          }
          for (const [lid, l] of lists) ctx.lists.set(lid, l);
        }
        return lists.size > 0;
      });
      if (this._live(ctx)) {
        this._emit('items', { added: [id], removed: replaces ? [replaces] : [], updated: [] });
        if (changed) this._emit('lists', {});
      }
      if (replaces) await ctx.store.delete(replaces).catch(() => {});
      return toInfo(id, ix, storedBytes);
    } catch (e) {
      if (written) await ctx.store.delete(id).catch(() => {});
      throw job.fail(e);
    } finally {
      job.end();
    }
  }

  /**
   * Adds a File/Blob (the UI sniffs special files first; whatever arrives is stored). Thumbnail/poster/duration come
   * from the thumbnailer run on the source file. -> ItemInfo.
   */
  async addFile(file, { name, album, signal, onProgress } = {}) {
    if (typeof Blob === 'undefined' || !(file instanceof Blob)) throw new TypeError('addFile(): expected a File or Blob');
    this._ctx();
    const nm = safeFilename(name ?? file.name ?? '');
    const type = importType(file.type, nm);
    const mtime = isUint(file.lastModified) && file.lastModified > 0 ? file.lastModified : undefined;
    const thumb = this._thumb(file, type);
    return this._addCore({ name: nm, type, size: file.size, mtime }, file, { album, signal, onProgress, thumb });
  }

  /** Adds `size` bytes from an (async) iterable/ByteSource/Blob; thumbFrom: a Blob for the thumbnailer. -> ItemInfo. */
  async addStream({ name, type, size, mtime } = {}, source, { album, signal, onProgress, thumbFrom } = {}) {
    this._ctx();
    const nm = safeFilename(name ?? '');
    const ty = importType(type, nm);
    const thumb = typeof Blob !== 'undefined' && thumbFrom instanceof Blob ? this._thumb(thumbFrom, ty) : null;
    return this._addCore({ name: nm, type: ty, size, mtime: isUint(mtime) ? mtime : undefined }, source, { album, signal, onProgress, thumb });
  }

  /** New note (container type NOTE_TYPE, payload {"v":1,"title","body"}). -> ItemInfo. */
  async addNote({ title, body } = {}) {
    const bytes = notePayload(title, body);
    return this._addCore({ name: cleanLabel(title, 'Note'), type: NOTE_TYPE, size: bytes.length }, [bytes], {});
  }

  /** Saves a note as a NEW container with a new id (fav, addedAt and album membership carried over). -> ItemInfo. */
  async saveNote(id, { title, body } = {}) {
    const ctx = this._ctx();
    const cur = ctx.items.get(id);
    if (!cur) throw new CzdError('item-not-found');
    if (kindOf(cur.ix.type, cur.ix.name) !== 'note') throw new TypeError('saveNote(): not a note');
    const bytes = notePayload(title, body);
    return this._addCore({ name: cleanLabel(title, 'Note'), type: NOTE_TYPE, size: bytes.length }, [bytes], {
      replaces: id,
      carry: { fav: cur.ix.fav === true, addedAt: cur.ix.addedAt, origName: cur.ix.origName },
    });
  }

  /** -> {title, body} (text that isn't note JSON becomes the body). */
  async readNote(id) {
    const { src, opened, info } = await this.open(id);
    try {
      if (opened.size > NOTE_MAX) throw new CzdError('too-big-to-preview');
      const text = fromUtf8(await collect(decryptSource(src, opened), { max: NOTE_MAX }), { fatal: false });
      try {
        const o = JSON.parse(text);
        if (isPlain(o) && (typeof o.title === 'string' || typeof o.body === 'string')) {
          return { title: typeof o.title === 'string' ? o.title : info.name, body: typeof o.body === 'string' ? o.body : '' };
        }
      } catch {
        // not note JSON
      }
      return { title: info.name, body: text };
    } finally {
      this._release(opened);
    }
  }

  // ───────── editing

  async _updateIndex(id, patch) {
    const ctx = this._ctx();
    this._requireWriter();
    return this._mutex(async () => {
      const cur = ctx.items.get(id);
      if (!cur) throw new CzdError('item-not-found');
      const ix = { ...cur.ix, ...patch };
      if (ix.fav !== true) delete ix.fav;
      await this._db.put('items', await this._sealItem(ctx, id, ix, cur.storedBytes));
      if (this._live(ctx) && ctx.items.has(id)) {
        ctx.items.set(id, { ix, storedBytes: cur.storedBytes });
        this._emit('items', { added: [], removed: [], updated: [id] });
      }
      return toInfo(id, ix, cur.storedBytes);
    });
  }

  /** Renames an item (index only; the container keeps its original name). -> ItemInfo. */
  async rename(id, name) {
    const cur = this._ctx().items.get(id);
    if (!cur) throw new CzdError('item-not-found');
    const nm = cur.ix.type === NOTE_TYPE ? cleanLabel(name, cur.ix.name) : safeFilename(String(name ?? ''));
    return this._updateIndex(id, { name: nm });
  }

  /** -> ItemInfo. */
  async setFavorite(id, fav) {
    return this._updateIndex(id, { fav: fav === true });
  }

  /**
   * Deletes items: index records, thumbnails and album membership in one commit, then the containers.
   * Keys are captured at call time, so a delete started from a 'locking' listener completes. -> removed ids.
   */
  async remove(ids) {
    const ctx = this._ctx();
    this._requireWriter();
    const want = [...new Set(Array.isArray(ids) ? ids : [ids])];
    const list = await this._mutex(async () => {
      const gone = want.filter((id) => ctx.items.has(id));
      if (!gone.length) return gone;
      const set = new Set(gone);
      const ops = [];
      for (const id of gone) ops.push({ op: 'delete', store: 'items', key: id }, { op: 'delete', store: 'thumbs', key: id });
      const changed = new Map();
      for (const [lid, l] of ctx.lists) {
        if (!l.itemIds.some((x) => set.has(x)) && !set.has(l.cover)) continue;
        const nl = { ...l, itemIds: l.itemIds.filter((x) => !set.has(x)) };
        if (set.has(nl.cover)) delete nl.cover;
        changed.set(lid, nl);
        ops.push({ op: 'put', store: 'lists', value: await this._sealList(ctx, lid, nl) });
      }
      await this._db.commit(ops);
      if (this._live(ctx)) {
        for (const id of gone) {
          ctx.items.delete(id);
          this._revokeThumb(id);
        }
        for (const [lid, l] of changed) ctx.lists.set(lid, l);
        this._emit('items', { added: [], removed: gone, updated: [] });
        if (changed.size) this._emit('lists', {});
      }
      return gone;
    });
    await Promise.all(list.map((id) => ctx.store.delete(id).catch(() => {})));
    return list;
  }

  // ───────── reading items

  async _openWith(ctx, id, signal) {
    const cur = ctx.items.get(id);
    if (!cur) throw new CzdError('item-not-found');
    const src = await ctx.store.source(id);
    let opened;
    try {
      opened = await openSource(src, { vault: { wrapKey: ctx.keys.itemWrap, vaultId: ctx.vaultId, itemId: fromHex(id) }, signal });
    } catch (e) {
      if (e instanceof CzdError && TAMPER.has(e.code)) throw new CzdError('item-tampered', { cause: e, detail: e.code });
      throw e;
    }
    let expected = null;
    try {
      expected = fromB64(cur.ix.hmac);
    } catch {
      expected = null;
    }
    if (!expected || !ctEqual(opened.mac, expected)) {
      release(opened);
      throw new CzdError('item-tampered', { detail: 'header MAC differs from the index' });
    }
    if (!this._live(ctx)) {
      release(opened);
      throw new CzdError('aborted', { detail: 'locked' });
    }
    this._track(opened);
    return { src, opened, cur };
  }

  /**
   * Opens an item's container (vault stanza) and checks its header MAC against the index (item-tampered).
   * The caller releases `opened` (container.release); lock() releases it too.
   * @returns {Promise<{src: import('../types.js').ByteSource, opened: import('../types.js').Opened, info: import('../types.js').ItemInfo}>}
   */
  async open(id) {
    const ctx = this._ctx();
    const { src, opened, cur } = await this._openWith(ctx, id);
    return { src, opened, info: toInfo(id, cur.ix, cur.storedBytes) };
  }

  /**
   * -> DecryptSource {kind:'container', src, opened} plus itemId, name/type (current index values) and release()
   * (media.disposeSource calls it).
   */
  async sourceFor(id) {
    const { src, opened, info } = await this.open(id);
    return { kind: 'container', src, opened, itemId: id, name: info.name, type: info.type, release: () => this._release(opened) };
  }

  // ───────── send

  /**
   * Re-encrypts items into fresh passphrase containers (stanza from passKek): one output per item, or one bundle for
   * several ids when `bundle`. Names/types are the CURRENT index values; notes become "<title>.txt" (body only);
   * mtime only with keepDates. Streams are lazy (each runs as a job; a lock interrupts it). `size` is the exact
   * output length. -> [{name, size, stream}]
   */
  async exportCzd(ids, passKek, { bundle = true, keepDates = false, signal, onProgress } = {}) {
    const ctx = this._ctx();
    const list = [...new Set(Array.isArray(ids) ? ids : [ids])];
    if (!list.length) throw new TypeError('exportCzd(): no items');
    if (!passKek || !passKek.kek || !(passKek.salt instanceof Uint8Array) || !passKek.params) throw new TypeError('exportCzd(): bad PassKek');
    for (const id of list) if (!ctx.items.has(id)) throw new CzdError('item-not-found');
    const parts = [];
    for (const id of list) {
      const { ix } = ctx.items.get(id);
      const mtime = keepDates && isUint(ix.mtime) ? ix.mtime : undefined;
      if (kindOf(ix.type, ix.name) === 'note') {
        const note = await this.readNote(id);
        const bytes = utf8(note.body);
        parts.push({ id, name: noteFileName(note.title), type: NOTE_EXPORT_TYPE, size: bytes.length, mtime, bytes });
      } else {
        const name = safeFilename(ix.name);
        parts.push({ id, name, type: cleanType(ix.type, name), size: ix.size, mtime });
      }
    }
    if (!this._live(ctx)) throw new CzdError('aborted', { detail: 'locked' });
    const total = parts.reduce((n, p) => n + p.size, 0);
    let done = 0;
    const progress = (n) => {
      done += n;
      report(onProgress, done, total);
    };
    if (bundle && parts.length > 1) {
      const taken = new Set();
      const meta = bundleMeta(parts.map((p) => {
        const e = { name: dedupeName(p.name, taken), type: p.type, size: p.size };
        if (p.mtime !== undefined) e.mtime = p.mtime;
        return e;
      }));
      return [{ name: meta.name, size: passContainerSize(meta, meta.size), stream: this._exportStream(ctx, parts, meta, passKek, signal, progress) }];
    }
    return parts.map((p) => {
      const meta = { name: p.name, type: p.type };
      if (p.mtime !== undefined) meta.mtime = p.mtime;
      return { name: p.name, size: passContainerSize(meta, p.size), stream: this._exportStream(ctx, [p], meta, passKek, signal, progress) };
    });
  }

  async* _exportStream(ctx, parts, meta, passKek, signal, progress) {
    if (!this._live(ctx)) throw new CzdError('interrupted');
    const job = this._job(signal);
    const self = this;
    try {
      async function* plain() {
        for (const p of parts) {
          if (p.bytes) {
            yield p.bytes;
            progress(p.bytes.length);
            continue;
          }
          const { src, opened } = await self._openWith(ctx, p.id, job.signal);
          try {
            if (opened.size !== p.size) throw new CzdError('item-tampered', { detail: 'size differs from the index' });
            for await (const pt of decryptSource(src, opened, { signal: job.signal })) {
              yield pt;
              progress(pt.length);
            }
          } finally {
            self._release(opened);
          }
        }
      }
      const size = parts.length > 1 ? meta.size : parts[0].size;
      yield* encryptStream(plain(), { size, meta, signal: job.signal, stanzasFor: async (fk) => [await passStanza(fk, passKek)] });
    } catch (e) {
      throw job.fail(e);
    } finally {
      job.end();
    }
  }

  // ───────── albums

  /** -> ListInfo. */
  async createList({ name, itemIds = [] } = {}) {
    const ctx = this._ctx();
    this._requireWriter();
    return this._mutex(async () => {
      const id = toHex(randomBytes(16));
      const l = { name: cleanLabel(name, 'Album'), itemIds: [...new Set(itemIds)].filter((x) => ctx.items.has(x)), createdAt: this._now() };
      await this._db.put('lists', await this._sealList(ctx, id, l));
      if (this._live(ctx)) {
        ctx.lists.set(id, l);
        this._emit('lists', {});
      }
      return listInfo(id, l, ctx.items);
    });
  }

  /** Updates name, itemIds (order kept) and/or cover (an item of the album; null clears). -> ListInfo. */
  async updateList(id, { name, itemIds, cover } = {}) {
    const ctx = this._ctx();
    this._requireWriter();
    return this._mutex(async () => {
      const cur = ctx.lists.get(id);
      if (!cur) throw new CzdError('item-not-found');
      const l = { ...cur };
      if (name !== undefined) l.name = cleanLabel(name, cur.name);
      if (itemIds !== undefined) l.itemIds = [...new Set(itemIds)].filter((x) => ctx.items.has(x));
      if (cover !== undefined) {
        if (cover && l.itemIds.includes(cover)) l.cover = cover;
        else delete l.cover;
      }
      if (l.cover && !l.itemIds.includes(l.cover)) delete l.cover;
      await this._db.put('lists', await this._sealList(ctx, id, l));
      if (this._live(ctx)) {
        ctx.lists.set(id, l);
        this._emit('lists', {});
      }
      return listInfo(id, l, ctx.items);
    });
  }

  async removeList(id) {
    const ctx = this._ctx();
    this._requireWriter();
    await this._mutex(async () => {
      if (!ctx.lists.has(id)) throw new CzdError('item-not-found');
      await this._db.delete('lists', id);
      if (this._live(ctx)) {
        ctx.lists.delete(id);
        this._emit('lists', {});
      }
    });
  }

  // ───────── backups (§3.7)

  /**
   * .czb export: the plan (entries, record hashes, exact size) is made now; the stream emits it (records re-read and
   * checked) and sets lastBackupAt when it completes. -> {name, size, stream} (+ skipped: items whose container is
   * missing or unreadable and were left out; createdAt: the backup's time). markDone:false (extra over §10) leaves
   * lastBackupAt alone: the caller calls markBackedUp(createdAt) once the file was really kept (a staged backup
   * exists only in this tab until the user saves it).
   * @param {{signal?: AbortSignal, onProgress?: (done: number) => void, markDone?: boolean}} [opts]
   */
  async exportBackup({ signal, onProgress, markDone = true } = {}) {
    const ctx = this._ctx();
    this._requireHolder();
    // Planning reads and checks every record and container header: a job of its own (busy, wake lock, lock aborts it).
    const planning = this._job(signal);
    let plan;
    try {
      plan = await planBackup({
        db: this._db,
        store: ctx.store,
        backupKey: ctx.keys.backup,
        itemWrapKey: ctx.keys.itemWrap,
        vaultId: ctx.vaultId,
        now: this._now,
        signal: planning.signal,
      });
    } catch (e) {
      throw planning.fail(e);
    } finally {
      planning.end();
    }
    if (!this._live(ctx)) throw new CzdError('interrupted');
    const self = this;
    async function* stream() {
      if (!self._live(ctx)) throw new CzdError('interrupted');
      const job = self._job(signal);
      try {
        yield* writeBackup({ db: self._db, store: ctx.store, plan, signal: job.signal, onProgress });
      } catch (e) {
        throw job.fail(e);
      } finally {
        job.end();
      }
      if (markDone) await self._touchBackup(plan.createdAt);
    }
    return { name: `cZEROde-backup-${isoDay(plan.createdAt)}.czb`, size: plan.size, stream: stream(), skipped: plan.skipped.length, createdAt: plan.createdAt };
  }

  /**
   * Records a finished backup (meta lastBackupAt; the backup reminder goes quiet). For exportBackup({markDone:
   * false}) callers once the user really kept the file — e.g. a staged backup only after its Save click. Extra over
   * §10. Never rejects (a failure is logged).
   * @param {number} [at] backup time (ms), default now (pass exportBackup's createdAt to date it by its snapshot)
   * @returns {Promise<void>}
   */
  async markBackedUp(at = this._now()) {
    if (!isUint(at) || !this._db) return;
    await this._touchBackup(at);
  }

  async _touchBackup(at) {
    try {
      await withRecordLock(async () => {
        const meta = await this._db.getMeta();
        if (!meta || (this._meta && !ctEqual(meta.vaultId, this._meta.vaultId))) return;
        const next = { ...meta, lastBackupAt: at };
        await this._db.putMeta(next, { expectWrapCt: meta.wrap.ct });
        this._applyMeta(next);
        this._emit('meta', {});
      });
    } catch (e) {
      globalThis.console?.warn?.('[vault] could not record the backup time', e);
    }
  }

  /** Reads a .czb header (no keys). -> {sameVault, items, lists, thumbs, createdAt, hasRecovery}. */
  async inspectBackup(src) {
    const hdr = await readBackupHeader(src);
    const cur = this._meta?.vaultId;
    return {
      sameVault: Boolean(cur && ctEqual(cur, hdr.vaultId)),
      items: hdr.counts.items,
      lists: hdr.counts.lists,
      thumbs: hdr.counts.thumbs,
      createdAt: hdr.createdAt,
      hasRecovery: hdr.rwrap !== null,
    };
  }

  /**
   * Restores a .czb. 'replace' (status 'none'): the backup becomes this device's vault and is left unlocked; secret
   * {pass} or {code} (optionally {code, newPass} to also set a new passphrase). 'merge' (unlocked): same vault → no
   * secret needed, existing ids skipped; another vault → {pass}|{code} of that backup, every item re-encrypted under
   * a new id (repeat merges skip what was merged before). -> {added, skipped}.
   */
  async restoreBackup(src, secret, { mode, signal, onProgress, confirmKdf } = {}) {
    this._requireDb();
    this._requireHolder();
    if (mode === 'replace') {
      if (this.status === 'unlocked') throw new CzdError('vault-exists');
      const meta = await this._db.getMeta();
      if (meta) {
        this._applyMeta(meta);
        this._setStatus(this._restStatus());
        throw new CzdError('vault-exists');
      }
      const epoch = this._epoch;
      const store = await this._newStore();
      const job = this._job(signal);
      let r;
      try {
        r = await restore({ db: this._db, store, km: KM, now: this._now, signal: job.signal, onProgress, confirmKdf }, src, secret, { mode });
      } catch (e) {
        throw job.fail(e);
      } finally {
        job.end();
      }
      this._applyMeta(r.meta);
      this._storeError = null;
      this._emit('meta', {});
      try {
        await this._finishUnlock(r.vmk, r.meta, epoch);
      } catch (e) {
        if (!isCancel(e)) throw e;
        this._setStatus(this._restStatus());
      }
      return { added: r.added, skipped: r.skipped };
    }
    if (mode !== 'merge') throw new TypeError("restoreBackup(): mode must be 'replace' or 'merge'");
    const ctx = this._ctx();
    const job = this._job(signal);
    let r;
    try {
      r = await restore({
        db: this._db,
        store: ctx.store,
        km: KM,
        now: this._now,
        signal: job.signal,
        onProgress,
        confirmKdf,
        current: { vaultId: ctx.vaultId, keys: ctx.keys },
      }, src, secret, { mode });
    } catch (e) {
      await this._reloadAfterMerge(ctx, []);
      throw job.fail(e);
    } finally {
      job.end();
    }
    await this._reloadAfterMerge(ctx, r.addedIds);
    return { added: r.added, skipped: r.skipped };
  }

  /** Re-reads the index after a merge, in place (operations in flight hold these same Map objects). */
  async _reloadAfterMerge(ctx, addedIds) {
    if (!this._live(ctx)) return;
    try {
      await this._mutex(async () => {
        const { items, lists } = await this._loadIndex(ctx.keys);
        if (!this._live(ctx)) return;
        ctx.items.clear();
        for (const [id, e] of items) ctx.items.set(id, e);
        ctx.lists.clear();
        for (const [id, l] of lists) ctx.lists.set(id, l);
      });
      if (!this._live(ctx)) return;
      this._emit('items', { added: addedIds.filter((id) => ctx.items.has(id)), removed: [], updated: [] });
      this._emit('lists', {});
    } catch (e) {
      globalThis.console?.warn?.('[vault] reloading the index after a merge failed', e);
    }
  }

  // ───────── storage and tabs

  /** -> {count, itemBytes, usage, quota, persisted} (nulls when unknown; count/itemBytes also while locked). */
  async storage() {
    let count = null;
    let itemBytes = null;
    if (this.status === 'unlocked') {
      count = this._items.size;
      itemBytes = 0;
      for (const e of this._items.values()) itemBytes += e.storedBytes;
    } else if (this._db && this._meta) {
      try {
        const recs = await this._db.getAll('items');
        count = recs.length;
        itemBytes = recs.reduce((n, r) => n + (isUint(r.storedBytes) ? r.storedBytes : 0), 0);
      } catch {
        // unknown
      }
    }
    let est = null;
    try {
      est = this._store ? await this._store.estimate() : null;
    } catch {
      est = null;
    }
    if (!est) {
      const [e, persisted] = await Promise.all([platformStorage.estimate(), platformStorage.persisted()]);
      est = { usage: e?.usage, quota: e?.quota, persisted };
    }
    const num = (v) => (Number.isFinite(v) ? v : null);
    return { count, itemBytes, usage: num(est.usage), quota: num(est.quota), persisted: typeof est.persisted === 'boolean' ? est.persisted : null };
  }

  /**
   * Small device-local values in the vault database's 'kv' store (dismissals, 'legacy-import-done', …): stored in the
   * clear, never secrets; 'merged:…' keys belong to backup merges. Extra over §10.
   * @param {string} key
   */
  async kvGet(key) {
    this._requireDb();
    return this._db.kvGet(key);
  }

  /** Sets (undefined deletes) a 'kv' value; see kvGet. Extra over §10. */
  async kvSet(key, value) {
    this._requireDb();
    if (typeof key !== 'string' || key.startsWith('merged:')) throw new TypeError('kvSet(): reserved or invalid key');
    await this._db.kvSet(key, value);
  }

  /** Tab-lock handoff (§4.5): asks the holder tab to yield, takes the lock, then re-reads the vault (status 'locked'/'none'). */
  async useHere() {
    if (this._useHere) {
      const ok = await this._useHere();
      if (ok === false) throw new CzdError('other-tab');
    }
    await this.init();
  }
}

/** Reads a freshly written container back: header MAC/size verified and equal to what was produced. -> hmac (base64). */
async function verifyStored(ctx, id, id16, mac, signal) {
  const src = await ctx.store.source(id);
  const opened = await openSource(src, { vault: { wrapKey: ctx.keys.itemWrap, vaultId: ctx.vaultId, itemId: id16 }, signal });
  try {
    if (!(mac instanceof Uint8Array) || !ctEqual(opened.mac, mac)) throw new CzdError('item-tampered', { detail: 'stored header differs' });
    return toB64(opened.mac);
  } finally {
    release(opened);
  }
}
