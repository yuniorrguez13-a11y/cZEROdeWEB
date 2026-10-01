// czd2 container format v2 (DESIGN §3.3; docs/FORMAT.md copies the layout).
// A random 32-byte fileKey per container is wrapped by stanzas (passphrase / vault); HKDF subkeys
// authenticate the header (HMAC), encrypt the metadata (AES-GCM, random metaNonce) and the payload
// (STREAM: AES-GCM per chunk, nonce = BE88(i) ‖ final flag). Readers validate every bound before any
// KDF runs, verify the header MAC before touching the metadata, and only throw CzdError for bad data.

import { CzdError, toCzdError } from '../errors.js';
import { CHUNK_EXP } from '../config.js';
import { KDF_ARGON2ID, POLICY, checkParams, deriveKek, passphraseBytes } from './kdf.js';
import { ascii, be88, concat, ctEqual, fromUtf8, randomBytes, readU16, readU32, toHex, u16, u32, utf8, zeroize } from '../util/bytes.js';
import { abortable, fileChunks } from '../util/stream.js';
import { safeFilename } from '../util/format.js';

/** File magic ("\x89CZD\r\n\x1a\n"). */
export const MAGIC = new Uint8Array([0x89, 0x43, 0x5a, 0x44, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Format version byte. */
export const VERSION = 2;

/** Passphrase stanza type. */
export const ST_PASS = 1;

/** Vault stanza type. */
export const ST_VAULT = 2;

/** Reader/writer bounds. */
export const LIMITS = Object.freeze({
  chunkExpMin: 12,
  chunkExpMax: 24,
  maxStanzas: 4,
  maxPassStanzas: 2,
  maxVaultStanzas: 1,
  stanzaBodyMax: 1024, // unknown stanza types (skipped by this reader)
  passBody: 86,
  vaultBody: 92,
  metaLenMin: 272,
  metaLenMax: 2 ** 20 + 16,
  metaJsonSingle: 64 * 1024,
  metaJsonBundle: 2 ** 20,
  bundleEntries: 2000,
});

/** meta.type of a bundle. */
export const BUNDLE_TYPE = 'application/x-czd-bundle';

const subtle = () => globalThis.crypto.subtle;
const AAD_PASS = ascii('cZEROde czd2 pass');
const AAD_VAULT = ascii('cZEROde czd2 vault');
const MIME_RE = /^[a-z0-9.+-]{1,60}\/[a-z0-9.+-]{1,60}$/i;
const DAY_MS = 86400000;
const PREFIX_READ = 8192; // ≥ 28 + 4·(3 + stanzaBodyMax) + 16: enough to learn the header length
const GCM = 'AES-GCM';

/** Maps anything thrown while processing untrusted data to a CzdError. */
function asCzd(e) {
  return e instanceof CzdError ? e : toCzdError(e);
}

function isBytes(x, len) {
  return x instanceof Uint8Array && (len === undefined || x.length === len);
}

/**
 * One piece of a byte stream as a Uint8Array view (Uint8Array, other ArrayBufferViews, ArrayBuffer).
 * Anything else is a caller bug: a TypeError, never a silent reinterpretation (a number would
 * otherwise become that many zero bytes).
 */
function asBytes(raw, where) {
  if (raw instanceof Uint8Array) return raw;
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  throw new TypeError(`${where}: the source must yield Uint8Array pieces`);
}

/** A whole byte buffer passed where a stream is expected counts as one piece (it is iterable, but of numbers). */
function asPieces(x) {
  return x instanceof Uint8Array || x instanceof ArrayBuffer || ArrayBuffer.isView(x) ? [x] : x;
}

/** The payload key of an Opened; a released Opened (lock/purge raced the decrypt) is a cancellation. */
function payKey(opened) {
  const pay = opened.keys?.pay;
  if (!pay) throw new CzdError('aborted', { detail: 'released' });
  return pay;
}

function chunkNonce(i, last) {
  const n = new Uint8Array(12);
  n.set(be88(i));
  n[11] = last ? 1 : 0;
  return n;
}

/**
 * True when the first 8 bytes are the czd2 magic.
 * @param {Uint8Array} first8
 * @returns {boolean}
 */
export function isCzd2(first8) {
  if (!(first8 instanceof Uint8Array) || first8.length < 8) return false;
  for (let i = 0; i < 8; i++) if (first8[i] !== MAGIC[i]) return false;
  return true;
}

/**
 * Padmé padded length (leaks O(log log L) bits). Exact for every safe integer input; the result can
 * exceed 2^53 for inputs near it (callers check Number.isSafeInteger on derived sizes).
 * @param {number} n
 * @returns {number}
 */
export function padme(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('padme(): expected a safe integer ≥ 0');
  if (n < 2) return n;
  let e = Math.floor(Math.log2(n));
  if (2 ** e > n) e--; // Math.log2 may round up just below a power of two
  else if (2 ** (e + 1) <= n) e++;
  let s = Math.floor(Math.log2(e)) + 1;
  if (2 ** (s - 1) > e) s--;
  const step = 2 ** (e - s); // = mask + 1
  return Math.ceil(n / step) * step;
}

/**
 * Total container length for a plaintext size.
 * @param {number} size
 * @param {number} chunkExp
 * @param {number} headerLen
 * @returns {number}
 */
export function containerSize(size, chunkExp, headerLen) {
  const padded = padme(size);
  const n = Math.max(1, Math.ceil(padded / 2 ** chunkExp));
  return headerLen + padded + 16 * n;
}

// ---- header parsing ------------------------------------------------------------------------------

/**
 * Walks the header. With lengthOnly, stops once the header length is known (needs ≤ 4.2 KiB).
 * Views (not copies) into `b`.
 */
function scan(b, lengthOnly) {
  const need = (n) => {
    if (b.length < n) throw new CzdError('short-header');
  };
  const avail = Math.min(b.length, 8);
  for (let i = 0; i < avail; i++) if (b[i] !== MAGIC[i]) throw new CzdError('not-czd2');
  need(28);
  if (b[8] !== VERSION) throw new CzdError('unsupported-version', { detail: b[8] });
  if (b[9] !== 0) throw new CzdError('unknown-flags', { detail: b[9] });
  const chunkExp = b[10];
  if (chunkExp < LIMITS.chunkExpMin || chunkExp > LIMITS.chunkExpMax) throw new CzdError('bad-chunk-size', { detail: chunkExp });
  const k = b[11];
  if (k === 0) throw new CzdError('bad-stanza-count');
  if (k > LIMITS.maxStanzas) throw new CzdError('too-many-stanzas', { detail: k });
  const stanzas = [];
  let off = 28;
  let nPass = 0;
  let nVault = 0;
  for (let i = 0; i < k; i++) {
    need(off + 3);
    const type = b[off];
    const len = readU16(b, off + 1);
    if (type === ST_PASS) {
      if (len !== LIMITS.passBody) throw new CzdError('bad-stanza', { detail: 'pass length' });
      nPass++;
    } else if (type === ST_VAULT) {
      if (len !== LIMITS.vaultBody) throw new CzdError('bad-stanza', { detail: 'vault length' });
      nVault++;
    } else if (len > LIMITS.stanzaBodyMax) {
      throw new CzdError('bad-stanza', { detail: 'length' });
    }
    need(off + 3 + len);
    stanzas.push({ type, body: b.subarray(off + 3, off + 3 + len) });
    off += 3 + len;
  }
  if (nPass > LIMITS.maxPassStanzas || nVault > LIMITS.maxVaultStanzas) throw new CzdError('too-many-stanzas');
  need(off + 16);
  const metaNonce = b.subarray(off, off + 12);
  const metaLen = readU32(b, off + 12);
  off += 16;
  if (metaLen < LIMITS.metaLenMin || metaLen > LIMITS.metaLenMax || (metaLen - 16) % 256 !== 0) throw new CzdError('bad-meta', { detail: 'metaLen' });
  const headerLen = off + metaLen + 32;
  if (lengthOnly) return { headerLen };
  need(headerLen);
  return {
    chunkExp,
    stanzas,
    streamSalt: b.subarray(12, 28),
    metaNonce,
    metaLen,
    metaCT: b.subarray(off, off + metaLen),
    macOffset: off + metaLen,
    mac: b.subarray(off + metaLen, headerLen),
    headerLen,
  };
}

/**
 * Parses the header (copies every field; no keys, no KDF). `buf` may hold more than the header.
 * @param {Uint8Array} buf
 * @returns {{version:number, chunkExp:number, chunkSize:number, stanzas:{type:number, body:Uint8Array}[], streamSalt:Uint8Array, metaNonce:Uint8Array, metaLen:number, metaCT:Uint8Array, macOffset:number, mac:Uint8Array, headerLen:number, header:Uint8Array}}
 */
export function parseHeader(buf) {
  if (!(buf instanceof Uint8Array)) throw new TypeError('parseHeader(): expected a Uint8Array');
  let h;
  try {
    h = scan(buf, false);
  } catch (e) {
    throw asCzd(e);
  }
  return {
    version: VERSION,
    chunkExp: h.chunkExp,
    chunkSize: 2 ** h.chunkExp,
    stanzas: h.stanzas.map((s) => ({ type: s.type, body: s.body.slice() })),
    streamSalt: h.streamSalt.slice(),
    metaNonce: h.metaNonce.slice(),
    metaLen: h.metaLen,
    metaCT: h.metaCT.slice(),
    macOffset: h.macOffset,
    mac: h.mac.slice(),
    headerLen: h.headerLen,
    header: buf.slice(0, h.headerLen),
  };
}

function checkSource(src) {
  if (!src || typeof src.readAt !== 'function' || !Number.isSafeInteger(src.size) || src.size < 0) {
    throw new TypeError('expected a ByteSource');
  }
}

/**
 * Reads exactly the header bytes of a container from a ByteSource (two reads at most).
 * @param {import('../types.js').ByteSource} src
 * @returns {Promise<Uint8Array>}
 */
export async function readHeaderBytes(src) {
  checkSource(src);
  try {
    const first = await src.readAt(0, Math.min(src.size, PREFIX_READ));
    const { headerLen } = scan(first, true);
    if (headerLen > src.size) throw new CzdError('short-header');
    if (headerLen <= first.length) return first.slice(0, headerLen);
    return concat(first, await src.readAt(first.length, headerLen - first.length));
  } catch (e) {
    throw asCzd(e);
  }
}

// ---- keys and stanzas ----------------------------------------------------------------------------

/** HKDF-SHA256(fileKey, streamSalt) → {mac (HMAC-SHA256, 32-byte key), meta, pay (AES-256-GCM)}; non-extractable. */
async function fileKeys(fileKey, streamSalt) {
  const hk = await subtle().importKey('raw', fileKey, 'HKDF', false, ['deriveKey']);
  const d = (label, alg, usages) => subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: streamSalt, info: ascii(`cZEROde czd2 ${label}`) },
    hk, alg, false, usages);
  const [mac, meta, pay] = await Promise.all([
    d('header mac', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign', 'verify']),
    d('meta', { name: GCM, length: 256 }, ['encrypt', 'decrypt']),
    d('payload', { name: GCM, length: 256 }, ['encrypt', 'decrypt']),
  ]);
  return { mac, meta, pay };
}

/**
 * Derives a passphrase KEK for a batch of containers (one Argon2 run, fresh salt).
 * @param {string} pass
 * @param {{m:number, t:number, p:number}} [params]
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<import('../types.js').PassKek>}
 */
export async function makePassKek(pass, params = POLICY, { signal } = {}) {
  if (typeof pass !== 'string' || passphraseBytes(pass).length === 0) throw new TypeError('makePassKek(): empty passphrase');
  const prm = { m: params.m, t: params.t, p: params.p };
  const salt = randomBytes(16);
  const kek = await deriveKek(pass, salt, prm, { signal });
  return { kek, salt, params: prm };
}

/**
 * Passphrase stanza: kdfId | m | t | p | salt | wrapNonce | AES-GCM(KEK, wrapNonce, fileKey, "cZEROde czd2 pass").
 * @param {Uint8Array} fileKey
 * @param {import('../types.js').PassKek} passKek
 * @returns {Promise<import('../types.js').Stanza>}
 */
export async function passStanza(fileKey, passKek) {
  if (!isBytes(fileKey, 32)) throw new TypeError('passStanza(): fileKey must be 32 bytes');
  const { kek, salt, params } = passKek ?? {};
  if (!kek || !isBytes(salt, 16) || !params) throw new TypeError('passStanza(): bad PassKek');
  checkParams(params);
  const nonce = randomBytes(12);
  const wrapped = new Uint8Array(await subtle().encrypt({ name: GCM, iv: nonce, additionalData: AAD_PASS }, kek, fileKey));
  const body = concat(new Uint8Array([KDF_ARGON2ID]), u32(params.m), u32(params.t), new Uint8Array([params.p]), salt, nonce, wrapped);
  return { type: ST_PASS, body };
}

function checkId(x, what) {
  if (!isBytes(x, 16)) throw new TypeError(`${what} must be 16 bytes`);
}

/**
 * Vault stanza: vaultId | itemId | wrapNonce | AES-GCM(itemWrapKey, wrapNonce, fileKey, "cZEROde czd2 vault" ‖ vaultId ‖ itemId).
 * @param {Uint8Array} fileKey
 * @param {CryptoKey} itemWrapKey
 * @param {Uint8Array} vaultId
 * @param {Uint8Array} itemId
 * @returns {Promise<import('../types.js').Stanza>}
 */
export async function vaultStanza(fileKey, itemWrapKey, vaultId, itemId) {
  if (!isBytes(fileKey, 32)) throw new TypeError('vaultStanza(): fileKey must be 32 bytes');
  if (!itemWrapKey) throw new TypeError('vaultStanza(): missing itemWrapKey');
  checkId(vaultId, 'vaultId');
  checkId(itemId, 'itemId');
  const nonce = randomBytes(12);
  const wrapped = new Uint8Array(await subtle().encrypt({ name: GCM, iv: nonce, additionalData: concat(AAD_VAULT, vaultId, itemId) }, itemWrapKey, fileKey));
  return { type: ST_VAULT, body: concat(vaultId, itemId, nonce, wrapped) };
}

function parsePassBody(body) {
  return {
    kdfId: body[0],
    params: { m: readU32(body, 1), t: readU32(body, 5), p: body[9] },
    salt: body.subarray(10, 26),
    nonce: body.subarray(26, 38),
    wrapped: body.subarray(38, 86),
  };
}

async function unwrap(key, iv, wrapped, aad, code) {
  try {
    return new Uint8Array(await subtle().decrypt({ name: GCM, iv, additionalData: aad }, key, wrapped));
  } catch {
    throw new CzdError(code);
  }
}

async function openVaultStanza(body, vault) {
  const vaultId = body.subarray(0, 16);
  const itemId = body.subarray(16, 32);
  if (!ctEqual(vaultId, vault.vaultId)) throw new CzdError('other-vault');
  if (!ctEqual(itemId, vault.itemId)) throw new CzdError('item-mismatch');
  return unwrap(vault.wrapKey, body.subarray(32, 44), body.subarray(44, 92), concat(AAD_VAULT, vaultId, itemId), 'vault-unwrap-failed');
}

/** Tries the passphrase stanzas: every bound checked first, then ≤ 1 Argon2 per distinct (salt, m, t, p). */
async function openPassStanzas(stanzas, passphrase, { confirmKdf, signal }) {
  const all = stanzas.filter((s) => s.type === ST_PASS).map((s) => parsePassBody(s.body));
  if (all.length === 0) throw new CzdError('no-usable-stanza');
  const usable = all.filter((s) => s.kdfId === KDF_ARGON2ID);
  if (usable.length === 0) throw new CzdError('unsupported-kdf');
  for (const s of usable) checkParams(s.params);
  if (passphraseBytes(passphrase).length === 0) throw new CzdError('wrong-passphrase');
  const ab = abortable(signal);
  const keks = new Map();
  for (const s of usable) {
    ab.checkpoint();
    const id = `${toHex(s.salt)}|${s.params.m}|${s.params.t}|${s.params.p}`;
    let kek = keks.get(id);
    if (!kek) {
      kek = await deriveKek(passphrase, s.salt.slice(), s.params, { confirmKdf, signal });
      keks.set(id, kek);
    }
    try {
      const fileKey = await unwrap(kek, s.nonce, s.wrapped, AAD_PASS, 'wrong-passphrase');
      return { fileKey, kdf: { ...s.params } };
    } catch {
      // try the next stanza
    }
  }
  throw new CzdError('wrong-passphrase');
}

// ---- metadata ------------------------------------------------------------------------------------

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/**
 * Bundle iff the type, cleaned the way readers clean it (MIME types are case-insensitive), is BUNDLE_TYPE.
 * Deciding on the raw string would let 'Application/X-CZD-Bundle' skip the entries rules and still come
 * out as meta.type === BUNDLE_TYPE with no entries.
 */
function isBundleType(t) {
  return cleanType(t) === BUNDLE_TYPE;
}

/** Structural rules shared by reader and writer (names/types are cleaned only on read). */
function checkStructure(obj, jsonLen) {
  if (!isPlainObject(obj)) throw new CzdError('bad-meta', { detail: 'not an object' });
  const isBundle = isBundleType(obj.type);
  if (jsonLen > (isBundle ? LIMITS.metaJsonBundle : LIMITS.metaJsonSingle)) throw new CzdError('bad-meta', { detail: 'too long' });
  if (!Number.isSafeInteger(obj.size) || obj.size < 0) throw new CzdError('bad-meta', { detail: 'size' });
  if (!isBundle) return false;
  const { entries } = obj;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > LIMITS.bundleEntries) throw new CzdError('bad-meta', { detail: 'entries' });
  let off = 0;
  for (const e of entries) {
    if (!isPlainObject(e) || !Number.isSafeInteger(e.size) || e.size < 0 || e.off !== off) throw new CzdError('bad-meta', { detail: 'entry' });
    off += e.size;
    if (!Number.isSafeInteger(off)) throw new CzdError('bad-meta', { detail: 'entry' });
  }
  if (off !== obj.size) throw new CzdError('bad-meta', { detail: 'entries sum' });
  return true;
}

function cleanType(t) {
  return typeof t === 'string' && MIME_RE.test(t) ? t.toLowerCase() : 'application/octet-stream';
}

function cleanName(s) {
  return safeFilename(typeof s === 'string' ? s : '');
}

function cleanMtime(v, now) {
  return Number.isSafeInteger(v) && v >= 0 && v <= now + DAY_MS ? v : undefined;
}

function decodeMeta(metaPT) {
  const jl = readU32(metaPT, 0);
  if (jl > metaPT.length - 4) throw new CzdError('bad-meta', { detail: 'jsonLen' });
  for (let i = 4 + jl; i < metaPT.length; i++) if (metaPT[i] !== 0) throw new CzdError('bad-meta', { detail: 'padding' });
  let obj;
  try {
    obj = JSON.parse(fromUtf8(metaPT.subarray(4, 4 + jl)));
  } catch {
    throw new CzdError('bad-meta', { detail: 'json' });
  }
  const isBundle = checkStructure(obj, jl);
  const now = Date.now();
  const meta = { v: 1, name: cleanName(obj.name), type: cleanType(obj.type), size: obj.size };
  const mtime = cleanMtime(obj.mtime, now);
  if (mtime !== undefined) meta.mtime = mtime;
  if (isBundle) {
    meta.entries = obj.entries.map((e) => {
      const out = { name: cleanName(e.name), type: cleanType(e.type), size: e.size, off: e.off };
      const mt = cleanMtime(e.mtime, now);
      if (mt !== undefined) out.mtime = mt;
      return out;
    });
  }
  return { meta, isBundle };
}

// ---- open ----------------------------------------------------------------------------------------

/**
 * Unlocks a header: bounds → stanza (vault: vaultId + itemId must match; passphrase: params gated,
 * ≤ 2 Argon2) → subkeys → header MAC (constant time) → metadata (validated and sanitized).
 * @param {Uint8Array} buf header bytes (more is fine)
 * @param {{passphrase?: string, vault?: {wrapKey: CryptoKey, vaultId: Uint8Array, itemId: Uint8Array}, confirmKdf?: Function, signal?: AbortSignal}} [opts]
 * @returns {Promise<import('../types.js').Opened>}
 */
export async function openHeader(buf, { passphrase, vault, confirmKdf, signal } = {}) {
  if (!(buf instanceof Uint8Array)) throw new TypeError('openHeader(): expected a Uint8Array');
  const usePass = passphrase !== undefined && passphrase !== null;
  if (usePass && typeof passphrase !== 'string') throw new TypeError('openHeader(): passphrase must be a string');
  if (vault != null) {
    if (!vault.wrapKey) throw new TypeError('openHeader(): vault.wrapKey is required');
    checkId(vault.vaultId, 'vault.vaultId');
    checkId(vault.itemId, 'vault.itemId');
  }
  if (!usePass && vault == null) throw new TypeError('openHeader(): passphrase or vault is required');
  const ab = abortable(signal);
  let fileKey = null;
  try {
    ab.checkpoint();
    const h = parseHeader(buf);
    let via = null;
    let kdf;
    let err = null;
    if (vault != null) {
      const vs = h.stanzas.find((s) => s.type === ST_VAULT);
      try {
        if (!vs) throw new CzdError('no-usable-stanza');
        fileKey = await openVaultStanza(vs.body, vault);
        via = 'vault';
      } catch (e) {
        err = e;
      }
    }
    if (!fileKey && usePass) {
      const hasPass = h.stanzas.some((s) => s.type === ST_PASS);
      if (hasPass || !err) {
        const r = await openPassStanzas(h.stanzas, passphrase, { confirmKdf, signal });
        fileKey = r.fileKey;
        kdf = r.kdf;
        via = 'pass';
      }
    }
    if (!fileKey) throw err ?? new CzdError('no-usable-stanza');
    if (fileKey.length !== 32) throw new CzdError('bad-stanza', { detail: 'fileKey length' });
    ab.checkpoint();
    const keys = await fileKeys(fileKey, h.streamSalt);
    if (!(await subtle().verify('HMAC', keys.mac, h.mac, h.header.subarray(0, h.macOffset)))) throw new CzdError('header-mac');
    let metaPT;
    try {
      metaPT = new Uint8Array(await subtle().decrypt({ name: GCM, iv: h.metaNonce }, keys.meta, h.metaCT));
    } catch {
      throw new CzdError('meta-auth');
    }
    const { meta, isBundle } = decodeMeta(metaPT);
    const size = meta.size;
    const chunkSize = 2 ** h.chunkExp;
    const paddedSize = padme(size);
    const n = Math.max(1, Math.ceil(paddedSize / chunkSize));
    if (!Number.isSafeInteger(containerSize(size, h.chunkExp, h.headerLen))) throw new CzdError('size-mismatch', { detail: 'size too large' });
    /** @type {import('../types.js').Opened} */
    const opened = {
      headerLen: h.headerLen,
      chunkExp: h.chunkExp,
      chunkSize,
      n,
      streamSalt: h.streamSalt,
      stanzas: h.stanzas,
      meta,
      size,
      paddedSize,
      mac: h.mac,
      via,
      keys,
      fileKey, // kept for the desktop stream (DESIGN §5.3 stream_register); release() wipes it
      isBundle,
    };
    if (kdf) opened.kdf = kdf;
    return opened;
  } catch (e) {
    zeroize(fileKey);
    throw asCzd(e);
  }
}

/**
 * readHeaderBytes + openHeader + the total-size check (before anything is shown).
 * @param {import('../types.js').ByteSource} src
 * @param {Parameters<typeof openHeader>[1]} [opts]
 * @returns {Promise<import('../types.js').Opened>}
 */
export async function openSource(src, opts = {}) {
  const header = await readHeaderBytes(src);
  const opened = await openHeader(header, opts);
  if (src.size !== containerSize(opened.size, opened.chunkExp, opened.headerLen)) {
    release(opened);
    throw new CzdError('size-mismatch');
  }
  return opened;
}

/**
 * Drops the keys held by an Opened and zero-fills its raw fileKey (best effort; later decrypt calls
 * throw TypeError). Callers release every Opened when done with it.
 * @param {import('../types.js').Opened} opened
 */
export function release(opened) {
  if (!opened || typeof opened !== 'object') return;
  zeroize(opened.fileKey);
  opened.fileKey = null;
  opened.keys = null;
}

// ---- encrypt -------------------------------------------------------------------------------------

function checkStanzas(stanzas) {
  if (!Array.isArray(stanzas) || stanzas.length === 0) throw new CzdError('bad-stanza-count');
  if (stanzas.length > LIMITS.maxStanzas) throw new CzdError('too-many-stanzas');
  let nPass = 0;
  let nVault = 0;
  for (const s of stanzas) {
    if (!s || !Number.isInteger(s.type) || s.type < 0 || s.type > 255 || !isBytes(s.body)) throw new CzdError('bad-stanza');
    if (s.type === ST_PASS && s.body.length !== LIMITS.passBody) throw new CzdError('bad-stanza');
    if (s.type === ST_VAULT && s.body.length !== LIMITS.vaultBody) throw new CzdError('bad-stanza');
    if (s.body.length > LIMITS.stanzaBodyMax) throw new CzdError('bad-stanza');
    if (s.type === ST_PASS) nPass++;
    if (s.type === ST_VAULT) nVault++;
  }
  if (nPass > LIMITS.maxPassStanzas || nVault > LIMITS.maxVaultStanzas) throw new CzdError('too-many-stanzas');
}

function toIterable(source, chunkSize) {
  if (typeof Blob !== 'undefined' && source instanceof Blob) return fileChunks(source, chunkSize);
  if (source && typeof source.readAt === 'function' && typeof source.stream === 'function') return source.stream();
  const s = asPieces(source);
  if (s && typeof s !== 'string' && (typeof s[Symbol.asyncIterator] === 'function' || typeof s[Symbol.iterator] === 'function')) return s;
  throw new TypeError('encryptStream(): source must be bytes, an (async) iterable of bytes, a Blob or a ByteSource');
}

/**
 * Encrypts a stream into a container. ALWAYS uses a fresh random fileKey and streamSalt.
 * Yields the header, then the ciphertext chunks.
 * @param {AsyncIterable<Uint8Array>|Iterable<Uint8Array>|Blob|import('../types.js').ByteSource} source exactly `size` bytes
 * @param {{size:number, meta:object, stanzasFor:(fileKey:Uint8Array) => Promise<import('../types.js').Stanza[]>, chunkExp?:number, signal?:AbortSignal}} opts
 * @returns {AsyncGenerator<Uint8Array>}
 */
export async function* encryptStream(source, { size, meta, stanzasFor, chunkExp = CHUNK_EXP, signal } = {}) {
  const fileKey = randomBytes(32);
  try {
    // The header comes first and the subkeys exist by then: wipe the raw fileKey right away.
    for await (const piece of _encryptStreamWith(source, { size, meta, stanzasFor, chunkExp, signal, fileKey, streamSalt: randomBytes(16) })) {
      zeroize(fileKey);
      yield piece;
    }
  } finally {
    zeroize(fileKey);
  }
}

/**
 * TEST-ONLY: encryptStream with caller-chosen fileKey/streamSalt (reusing them reuses the keystream).
 * App code must never import this; a unit test enforces it.
 * @param {*} source
 * @param {{size:number, meta:object, stanzasFor:Function, chunkExp?:number, signal?:AbortSignal, fileKey:Uint8Array, streamSalt:Uint8Array}} opts
 * @returns {AsyncGenerator<Uint8Array>}
 */
export async function* _encryptStreamWith(source, { size, meta, stanzasFor, chunkExp = CHUNK_EXP, signal, fileKey, streamSalt }) {
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('encryptStream(): size must be a safe integer ≥ 0');
  if (!Number.isInteger(chunkExp) || chunkExp < LIMITS.chunkExpMin || chunkExp > LIMITS.chunkExpMax) throw new TypeError('encryptStream(): bad chunkExp');
  if (!isPlainObject(meta)) throw new TypeError('encryptStream(): meta must be an object');
  if (typeof stanzasFor !== 'function') throw new TypeError('encryptStream(): stanzasFor is required');
  if (!isBytes(fileKey, 32) || !isBytes(streamSalt, 16)) throw new TypeError('encryptStream(): bad fileKey/streamSalt');
  const CS = 2 ** chunkExp;
  const total = padme(size);
  const n = Math.max(1, Math.ceil(total / CS));
  if (!Number.isSafeInteger(total + 16 * n)) throw new TypeError('encryptStream(): size too large');
  const iterable = toIterable(source, CS);
  const ab = abortable(signal);

  const stanzas = await stanzasFor(fileKey);
  checkStanzas(stanzas);
  const metaObj = { ...meta, v: 1, size };
  const json = utf8(JSON.stringify(metaObj));
  checkStructure(metaObj, json.length);
  const metaPT = new Uint8Array(Math.ceil((4 + json.length) / 256) * 256);
  metaPT.set(u32(json.length));
  metaPT.set(json, 4);
  if (metaPT.length + 16 > LIMITS.metaLenMax) throw new CzdError('bad-meta', { detail: 'too long' });
  const keys = await fileKeys(fileKey, streamSalt);
  const metaNonce = randomBytes(12);
  const metaCT = new Uint8Array(await subtle().encrypt({ name: GCM, iv: metaNonce }, keys.meta, metaPT));
  const parts = [MAGIC, new Uint8Array([VERSION, 0, chunkExp, stanzas.length]), streamSalt];
  for (const s of stanzas) parts.push(new Uint8Array([s.type]), u16(s.body.length), s.body);
  parts.push(metaNonce, u32(metaCT.length), metaCT);
  const body = concat(...parts);
  const mac = new Uint8Array(await subtle().sign('HMAC', keys.mac, body));
  ab.checkpoint();
  yield concat(body, mac);

  let i = 0;
  let fill = 0;
  let seen = 0;
  const buf = new Uint8Array(CS);
  const seal = async (pt) => {
    ab.checkpoint();
    const ct = new Uint8Array(await subtle().encrypt({ name: GCM, iv: chunkNonce(i, i === n - 1) }, keys.pay, pt));
    i++;
    return ct;
  };
  for await (const raw of iterable) {
    const piece = asBytes(raw, 'encryptStream()');
    seen += piece.length;
    if (seen > size) throw new CzdError('source-larger-than-size');
    for (let off = 0; off < piece.length;) {
      const k = Math.min(CS - fill, piece.length - off);
      buf.set(piece.subarray(off, off + k), fill);
      fill += k;
      off += k;
      if (fill === CS && i < n - 1) {
        yield await seal(buf);
        fill = 0;
      }
    }
  }
  if (seen !== size) throw new CzdError('source-size-mismatch');
  // Zero padding up to padme(size): remaining full chunks, then the final one.
  let remaining = total - (i * CS + fill);
  while (i < n) {
    const k = Math.min(CS - fill, remaining);
    buf.fill(0, fill, fill + k);
    fill += k;
    remaining -= k;
    if (i === n - 1) {
      yield await seal(buf.subarray(0, fill));
      break;
    }
    if (fill === CS) {
      yield await seal(buf);
      fill = 0;
    }
  }
}

// ---- decrypt -------------------------------------------------------------------------------------

/** TypeError for a non-Opened argument; CzdError('aborted') for one already released (a lock race). */
function checkOpened(opened) {
  if (!opened || typeof opened !== 'object' || !('keys' in opened)) throw new TypeError('expected an Opened');
  payKey(opened);
}

function lastPtLen(opened) {
  return opened.paddedSize - (opened.n - 1) * opened.chunkSize;
}

/** Decrypts chunk i; checks that bytes past meta.size are zero. Returns the whole chunk plaintext. */
async function openChunk(opened, i, ct) {
  const last = i === opened.n - 1;
  // Read the key outside the try: a release() between chunks must not be reported as a damaged file.
  const key = payKey(opened);
  let pt;
  try {
    pt = new Uint8Array(await subtle().decrypt({ name: GCM, iv: chunkNonce(i, last) }, key, ct));
  } catch {
    throw new CzdError(last ? 'truncated-or-corrupt' : 'chunk-auth', { detail: i });
  }
  const dataEnd = opened.size - i * opened.chunkSize;
  for (let j = Math.max(0, dataEnd); j < pt.length; j++) if (pt[j] !== 0) throw new CzdError('bad-padding');
  return pt;
}

/**
 * Decrypts the payload (the bytes after the header) strictly: exact chunk lengths, final flag only on
 * the last chunk, `truncated` on early EOF, `trailing-data` after the last chunk, zero padding.
 * Earlier plaintext is released before the end is verified: treat output as provisional until the
 * generator returns normally.
 * @param {AsyncIterable<Uint8Array>|Iterable<Uint8Array>} ctSource
 * @param {import('../types.js').Opened} opened
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {AsyncGenerator<Uint8Array>}
 */
export async function* decryptStream(ctSource, opened, { signal } = {}) {
  checkOpened(opened);
  const ab = abortable(signal);
  const CS = opened.chunkSize;
  const n = opened.n;
  const lastWant = lastPtLen(opened) + 16;
  const buf = new Uint8Array(CS + 16);
  let fill = 0;
  let i = 0;
  let out = 0;
  const take = async (ct) => {
    ab.checkpoint();
    const pt = await openChunk(opened, i, ct);
    i++;
    const keep = Math.max(0, Math.min(pt.length, opened.size - out));
    out += keep;
    return pt.subarray(0, keep);
  };
  try {
    for await (const raw of asPieces(ctSource)) {
      const piece = asBytes(raw, 'decryptStream()');
      for (let off = 0; off < piece.length;) {
        if (i >= n) throw new CzdError('trailing-data');
        const want = i === n - 1 ? lastWant : CS + 16;
        const k = Math.min(want - fill, piece.length - off);
        buf.set(piece.subarray(off, off + k), fill);
        fill += k;
        off += k;
        if (fill === want) {
          fill = 0;
          yield await take(buf.subarray(0, want));
        }
      }
    }
    if (i !== n) throw new CzdError('truncated');
  } catch (e) {
    throw asCzd(e);
  }
}

/** Plaintext of [start, endInclusive] chunk by chunk (each chunk read with readAt and authenticated). */
async function* rangeChunks(src, opened, start, endInclusive, signal) {
  const ab = abortable(signal);
  const CS = opened.chunkSize;
  const c0 = Math.floor(start / CS);
  const c1 = Math.floor(endInclusive / CS);
  try {
    for (let c = c0; c <= c1; c++) {
      ab.checkpoint();
      const len = (c === opened.n - 1 ? lastPtLen(opened) : CS) + 16;
      const ct = await src.readAt(opened.headerLen + c * (CS + 16), len);
      const pt = await openChunk(opened, c, ct);
      const a = c === c0 ? start - c * CS : 0;
      const b = c === c1 ? endInclusive - c * CS + 1 : CS;
      yield pt.subarray(a, b);
    }
  } catch (e) {
    throw asCzd(e);
  }
}

function checkRange(opened, start, endInclusive) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endInclusive) || start < 0 || endInclusive < start || endInclusive >= opened.size) {
    throw new RangeError('range outside the plaintext');
  }
}

/**
 * Decrypts a whole container from a ByteSource, or one bundle entry ({off, size}) via random access.
 * @param {import('../types.js').ByteSource} src
 * @param {import('../types.js').Opened} opened
 * @param {{signal?: AbortSignal, entry?: {off:number, size:number}}} [opts]
 * @returns {AsyncGenerator<Uint8Array>}
 */
export async function* decryptSource(src, opened, { signal, entry } = {}) {
  checkSource(src);
  checkOpened(opened);
  if (!entry) {
    yield* decryptStream(src.stream(Math.min(opened.headerLen, src.size), src.size), opened, { signal });
    return;
  }
  const { off, size } = entry;
  if (!Number.isSafeInteger(off) || !Number.isSafeInteger(size) || off < 0 || size < 0 || off + size > opened.size) {
    throw new RangeError('decryptSource(): entry outside the plaintext');
  }
  if (size === 0) return;
  yield* rangeChunks(src, opened, off, off + size - 1, signal);
}

/**
 * Random-access decrypt of plaintext bytes [start, endInclusive] (only the chunks that cover it).
 * @param {import('../types.js').ByteSource} src
 * @param {import('../types.js').Opened} opened
 * @param {number} start
 * @param {number} endInclusive
 * @returns {Promise<Uint8Array>}
 */
export async function decryptRange(src, opened, start, endInclusive) {
  checkSource(src);
  checkOpened(opened);
  checkRange(opened, start, endInclusive);
  const out = new Uint8Array(endInclusive - start + 1);
  let o = 0;
  for await (const part of rangeChunks(src, opened, start, endInclusive)) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

/**
 * Authenticates every chunk (and the exact length) without keeping the plaintext.
 * @param {import('../types.js').ByteSource} src
 * @param {import('../types.js').Opened} opened
 * @param {{signal?: AbortSignal, onProgress?: (done:number, total:number) => void}} [opts]
 * @returns {Promise<true>}
 */
export async function verifySource(src, opened, { signal, onProgress } = {}) {
  let done = 0;
  for await (const pt of decryptSource(src, opened, { signal })) {
    done += pt.length;
    if (onProgress) onProgress(done, opened.size);
  }
  return true;
}

/**
 * Bundle metadata for 1..2000 entries (payload = the entries' bytes concatenated in order).
 * @param {{name:string, type:string, size:number, mtime?:number}[]} entries
 * @returns {{v:1, name:string, type:string, size:number, entries:{name:string, type:string, size:number, off:number, mtime?:number}[]}}
 */
export function bundleMeta(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > LIMITS.bundleEntries) throw new CzdError('bad-meta', { detail: 'bundle entries' });
  let off = 0;
  const out = entries.map((e) => {
    if (!e || !Number.isSafeInteger(e.size) || e.size < 0) throw new TypeError('bundleMeta(): entry size must be a safe integer ≥ 0');
    const r = { name: String(e.name ?? ''), type: String(e.type ?? 'application/octet-stream'), size: e.size, off };
    if (Number.isSafeInteger(e.mtime) && e.mtime >= 0) r.mtime = e.mtime;
    off += e.size;
    return r;
  });
  return { v: 1, name: `${entries.length} files`, type: BUNDLE_TYPE, size: off, entries: out };
}
