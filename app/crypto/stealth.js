// The camouflage ("stealth") alphabet shared by text v2 and legacy v4: unpadded standard base64
// with each of the 64 symbols replaced by a Georgian or Cyrillic letter.
// Ported from verify/legacy-web-decoder.mjs (lenient mode) and bench/legacy-fast.mjs (LUT decoder).

import { CzdError } from '../errors.js';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** SA[i] stands for base64 digit i: U+10D0–U+10F0 (Georgian ა…ჰ), then U+0410–U+042E (Cyrillic А…Ю). */
export const SA = Object.freeze(Array.from({ length: 64 }, (_, i) => String.fromCharCode(i <= 32 ? 0x10d0 + i : 0x0410 + (i - 33))));

/** Set of the 64 SA characters. */
export const SSET = new Set(SA);

// ECMAScript WhiteSpace ∪ LineTerminator (exactly what String.prototype.trim strips).
const WS_CODES = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];
const WS_RE = new RegExp(`[${WS_CODES.map((c) => `\\u${c.toString(16).padStart(4, '0')}`).join('')}]+`, 'g');

// Decode tables indexed by UTF-16 code unit: 0..63 digit, WS skip, PAD '=', -1 invalid.
// Every SA character is a single BMP code unit, so surrogates are simply invalid.
const WS = -2;
const PAD = -3;
function buildLut(raw) {
  const t = new Int8Array(0x10000).fill(-1);
  SA.forEach((c, i) => { t[c.charCodeAt(0)] = i; });
  for (const c of WS_CODES) t[c] = WS;
  if (raw) {
    for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
    t[0x3d] = PAD;
  }
  return t;
}
let LUT_SA = null;
let LUT_RAW = null;

const SA_CODES = new Uint16Array(SA.map((c) => c.charCodeAt(0)));

/**
 * Encodes bytes as stealth text (base64 without '=' in the SA alphabet).
 * @param {Uint8Array} u8
 * @returns {string}
 */
export function bytesToScript(u8) {
  const n = u8.length;
  const full = n - (n % 3);
  const rem = n % 3;
  const out = new Uint16Array((full / 3) * 4 + (rem ? rem + 1 : 0));
  let o = 0;
  for (let i = 0; i < full; i += 3) {
    const v = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
    out[o++] = SA_CODES[v >>> 18];
    out[o++] = SA_CODES[(v >>> 12) & 63];
    out[o++] = SA_CODES[(v >>> 6) & 63];
    out[o++] = SA_CODES[v & 63];
  }
  if (rem) {
    const v = (u8[full] << 16) | (rem > 1 ? u8[full + 1] << 8 : 0);
    out[o++] = SA_CODES[v >>> 18];
    out[o++] = SA_CODES[(v >>> 12) & 63];
    if (rem > 1) out[o++] = SA_CODES[(v >>> 6) & 63];
  }
  let s = '';
  for (let i = 0; i < out.length; i += 8192) s += String.fromCharCode.apply(null, out.subarray(i, i + 8192));
  return s;
}

/**
 * Decodes stealth text to bytes. All JS whitespace is ignored anywhere; with `allowRawBase64`
 * plain base64 characters (and trailing '=' padding) are accepted too, as the original app did.
 * Non-canonical trailing bits are accepted (forgiving base64). Anything else throws
 * CzdError('legacy-not-ciphertext'). Single pass over a code-unit lookup table: mapping the alphabet
 * costs a JS loop anyway, so Uint8Array.fromBase64 is used for plain base64 in util/bytes.fromB64 instead.
 * @param {string} text
 * @param {{allowRawBase64?: boolean}} [opts]
 * @returns {Uint8Array}
 */
export function scriptToBytes(text, { allowRawBase64 = true } = {}) {
  if (typeof text !== 'string') throw new CzdError('legacy-not-ciphertext');
  const lut = allowRawBase64 ? (LUT_RAW ??= buildLut(true)) : (LUT_SA ??= buildLut(false));
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  let digits = 0;
  let pads = 0;
  for (let i = 0; i < text.length; i++) {
    const v = lut[text.charCodeAt(i)];
    if (v >= 0) {
      if (pads) throw new CzdError('legacy-not-ciphertext');
      digits++;
      acc = ((acc << 6) | v) & 0xffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[o++] = (acc >>> bits) & 0xff;
      }
    } else if (v === WS) {
      continue;
    } else if (v === PAD) {
      pads++;
    } else {
      throw new CzdError('legacy-not-ciphertext');
    }
  }
  // Like the original (pad to a multiple of 4, then atob): '=' may stand in for some or all of the missing padding.
  if (digits % 4 === 1 || pads > (4 - (digits % 4)) % 4) throw new CzdError('legacy-not-ciphertext');
  return o === out.length ? out : out.slice(0, o);
}

/**
 * Removes every JS whitespace / line-terminator character.
 * @param {string} s
 * @returns {string}
 */
export function stripWs(s) {
  return s.replace(WS_RE, '');
}

/**
 * Share (0..1) of SA characters among the code points left after stripping whitespace; 0 when empty.
 * @param {string} s
 * @returns {number}
 */
export function stealthRatio(s) {
  let total = 0;
  let hits = 0;
  for (const ch of stripWs(s)) {
    total++;
    if (SSET.has(ch)) hits++;
  }
  return total === 0 ? 0 : hits / total;
}
