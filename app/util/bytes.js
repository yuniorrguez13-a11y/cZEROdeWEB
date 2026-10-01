// Byte helpers: encodings, big-endian integers, constant-time compare.
// Invalid arguments from code (wrong types, bad hex/base64/base32 text) throw TypeError/RangeError;
// reads past the end of untrusted buffers throw CzdError so format readers never leak RangeError.

import { CzdError } from '../errors.js';

const enc = new TextEncoder();
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const B32_LUT = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < 32; i++) {
    t[B32.charCodeAt(i)] = i;
    t[B32.toLowerCase().charCodeAt(i)] = i;
  }
  for (const [from, to] of [['0', 'O'], ['1', 'I'], ['8', 'B']]) t[from.charCodeAt(0)] = B32.indexOf(to);
  return t;
})();

/** @param {unknown} x @returns {Uint8Array} */
function asU8(x) {
  if (x instanceof Uint8Array) return x;
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  throw new TypeError('expected bytes');
}

/**
 * Concatenates byte arrays (Uint8Array, other views or ArrayBuffers) into a new Uint8Array.
 * @param {...(Uint8Array|ArrayBufferView|ArrayBuffer)} arrays
 * @returns {Uint8Array}
 */
export function concat(...arrays) {
  const parts = arrays.map(asU8);
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** UTF-8 encode (lone surrogates become U+FFFD). @param {string} s @returns {Uint8Array} */
export function utf8(s) {
  return enc.encode(s);
}

/**
 * UTF-8 decode. A leading BOM is kept (exact round trip). With `fatal` (default) invalid UTF-8
 * throws TypeError; callers map it to their own error code.
 * @param {Uint8Array} u8
 * @param {{fatal?: boolean}} [opts]
 * @returns {string}
 */
export function fromUtf8(u8, { fatal = true } = {}) {
  return new TextDecoder('utf-8', { fatal, ignoreBOM: true }).decode(u8);
}

/** Bytes of an ASCII string (AAD/info labels). Throws TypeError on non-ASCII. @param {string} s */
export function ascii(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x7f) throw new TypeError('ascii(): non-ASCII character');
    out[i] = c;
  }
  return out;
}

/** Lowercase hex. @param {Uint8Array} u8 @returns {string} */
export function toHex(u8) {
  const b = asU8(u8);
  let s = '';
  for (let i = 0; i < b.length; i++) s += HEX[b[i]];
  return s;
}

/** Hex (either case, even length) → bytes. Throws TypeError on anything else. @param {string} s */
export function fromHex(s) {
  if (typeof s !== 'string' || s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new TypeError('fromHex(): invalid hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Standard padded base64. @param {Uint8Array} u8 @returns {string} */
export function toB64(u8) {
  const b = asU8(u8);
  if (typeof b.toBase64 === 'function') return b.toBase64();
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Standard base64 → bytes with forgiving-base64 rules (ASCII whitespace ignored, padding optional,
 * non-zero trailing bits accepted — the same as atob). Throws TypeError on invalid input.
 * @param {string} s
 * @returns {Uint8Array}
 */
export function fromB64(s) {
  if (typeof s !== 'string') throw new TypeError('fromB64(): expected a string');
  if (typeof Uint8Array.fromBase64 === 'function') {
    try {
      return Uint8Array.fromBase64(s, { lastChunkHandling: 'loose' });
    } catch {
      throw new TypeError('fromB64(): invalid base64');
    }
  }
  let bin;
  try {
    bin = atob(s);
  } catch {
    throw new TypeError('fromB64(): invalid base64');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** base64url without padding. @param {Uint8Array} u8 @returns {string} */
export function toB64url(u8) {
  return toB64(u8).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** RFC 4648 base32, uppercase, no padding. @param {Uint8Array} u8 @returns {string} */
export function toBase32(u8) {
  const b = asU8(u8);
  let out = '';
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < b.length; i++) {
    acc = ((acc << 8) | b[i]) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(acc >>> bits) & 31];
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

/**
 * Base32 → bytes, tolerant of how people type codes: any case, '-' and whitespace ignored,
 * trailing '=' ignored, 0→O, 1→I, 8→B. Leftover bits are dropped. Throws TypeError otherwise.
 * @param {string} s
 * @returns {Uint8Array}
 */
export function fromBase32(s) {
  if (typeof s !== 'string') throw new TypeError('fromBase32(): expected a string');
  const clean = s.replace(/[\s-]+/g, '').replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 5) / 8));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    const v = c < 128 ? B32_LUT[c] : -1;
    if (v < 0) throw new TypeError('fromBase32(): invalid character');
    acc = ((acc << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return out;
}

/** Cryptographically random bytes (any length). @param {number} n @returns {Uint8Array} */
export function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) globalThis.crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

/**
 * Constant-time equality for equal-length inputs (lengths are not secret: different lengths → false).
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
export function ctEqual(a, b) {
  const x = asU8(a);
  const y = asU8(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

/** Best-effort wipe (fills with zeros). Accepts null/undefined. @param {Uint8Array|null|undefined} u8 */
export function zeroize(u8) {
  if (u8 && ArrayBuffer.isView(u8)) asU8(u8).fill(0);
}

function checkUint(v, max, name) {
  if (!Number.isInteger(v) || v < 0 || v > max) throw new RangeError(`${name}(): out of range`);
}

/** Big-endian u16. @param {number} v @returns {Uint8Array} */
export function u16(v) {
  checkUint(v, 0xffff, 'u16');
  return new Uint8Array([v >>> 8, v & 0xff]);
}

/** Big-endian u32. @param {number} v @returns {Uint8Array} */
export function u32(v) {
  checkUint(v, 0xffffffff, 'u32');
  return new Uint8Array([v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}

/** Big-endian u64 of a safe integer. @param {number} v @returns {Uint8Array} */
export function u64(v) {
  checkUint(v, Number.MAX_SAFE_INTEGER, 'u64');
  const out = new Uint8Array(8);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, Math.floor(v / 2 ** 32));
  dv.setUint32(4, v >>> 0);
  return out;
}

function view(b, o, n) {
  const u = asU8(b);
  const off = o ?? 0;
  if (!Number.isInteger(off) || off < 0 || off + n > u.length) throw new CzdError('truncated');
  return new DataView(u.buffer, u.byteOffset + off, n);
}

/** Reads a big-endian u16 at offset o (CzdError 'truncated' past the end). @param {Uint8Array} b @param {number} o */
export function readU16(b, o) {
  return view(b, o, 2).getUint16(0);
}

/** Reads a big-endian u32 at offset o (CzdError 'truncated' past the end). @param {Uint8Array} b @param {number} o */
export function readU32(b, o) {
  return view(b, o, 4).getUint32(0);
}

/**
 * Reads a big-endian u64 at offset o. Values above Number.MAX_SAFE_INTEGER throw
 * CzdError('size-mismatch') (readers may rewrap); past the end → CzdError('truncated').
 * @param {Uint8Array} b
 * @param {number} o
 */
export function readU64(b, o) {
  const dv = view(b, o, 8);
  const hi = dv.getUint32(0);
  const lo = dv.getUint32(4);
  if (hi > 0x1fffff) throw new CzdError('size-mismatch', { detail: 'u64 above 2^53' });
  return hi * 2 ** 32 + lo;
}

/** 11-byte big-endian counter (czd2 chunk nonce prefix) for a safe integer i ≥ 0. @param {number} i */
export function be88(i) {
  checkUint(i, Number.MAX_SAFE_INTEGER, 'be88');
  const out = new Uint8Array(11);
  const dv = new DataView(out.buffer);
  dv.setUint32(3, Math.floor(i / 2 ** 32));
  dv.setUint32(7, i >>> 0);
  return out;
}
