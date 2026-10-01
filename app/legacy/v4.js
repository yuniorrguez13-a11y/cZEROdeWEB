// Legacy v4 "cZEROde" AES payloads (decode only): PBKDF2-SHA256 (100 000 iterations) PIN key + AES-256-GCM.
// Blob = salt(16) | iv(12) | ciphertext | tag(16), written as unpadded base64 in the stealth alphabet
// (crypto/stealth.js). Ported from verify/legacy-*-decoder.mjs (strict/rework modes) and bench/legacy-fast.mjs.

import { CzdError } from '../errors.js';
import { SSET, scriptToBytes, stripWs } from '../crypto/stealth.js';
import { toHex, utf8 } from '../util/bytes.js';

const ITERATIONS = 100000;
/** Smallest possible blob: salt + iv + tag around an empty plaintext. */
export const MIN_BLOB = 44;
// Every legacy file payload (web 'file'/'chunk', desktop 'image') starts with these 15 bytes.
const PAYLOAD_PREFIX = utf8('{"v":1,"type":"');
// Stealth letters that the Mixed Script v1–v3 maps never emit (SA minus GEO and CYR values): real ciphertext
// almost always contains some (P(none in 59 chars) ≈ 3e-9), long v1/v3 text never does.
const V4_ONLY = new Set('თჟქღშჩძჭБЙПЦЩЪЫЬЭЮ');

const subtle = () => globalThis.crypto.subtle;

/**
 * The PIN spellings tried, in order (DESIGN §3.1): exactly as typed, trimmed, NFC, NFD; then NFC/NFD of the
 * trimmed PIN. Distinct, non-empty values only (the old apps never accepted an empty PIN).
 * @param {string} pin
 * @returns {string[]}
 */
export function pinVariants(pin) {
  if (typeof pin !== 'string') return [];
  const t = pin.trim();
  const out = [];
  for (const v of [pin, t, pin.normalize('NFC'), pin.normalize('NFD'), t.normalize('NFC'), t.normalize('NFD')]) {
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * PBKDF2-HMAC-SHA256(UTF-8(pin), salt, 100 000) → 32 key bytes. The PIN is used exactly as given.
 * @param {string} pin
 * @param {Uint8Array} salt 16 bytes
 * @returns {Promise<Uint8Array>}
 */
export async function pbkdf2Legacy(pin, salt) {
  if (typeof pin !== 'string') throw new TypeError('pbkdf2Legacy(): pin must be a string');
  if (!(salt instanceof Uint8Array) || salt.length !== 16) throw new TypeError('pbkdf2Legacy(): salt must be 16 bytes');
  const base = await subtle().importKey('raw', utf8(pin), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, base, 256));
}

/**
 * Stealth (or raw base64) text → blob. Whitespace anywhere is ignored. Throws CzdError('legacy-not-ciphertext')
 * when the text is not base64 in either alphabet or the blob is shorter than MIN_BLOB.
 * @param {string} text
 * @param {{allowRawBase64?: boolean}} [opts]
 * @returns {Uint8Array}
 */
export function v4Blob(text, { allowRawBase64 = true } = {}) {
  const blob = scriptToBytes(text, { allowRawBase64 });
  if (blob.length < MIN_BLOB) throw new CzdError('legacy-not-ciphertext');
  return blob;
}

/**
 * The first 60 blob bytes (salt, iv, first 32 ciphertext bytes) decoded from the start of a long ciphertext
 * without decoding all of it — enough for precheckV4 and the salt, as precheckV4 reads it like a blob with a
 * 16-byte plaintext. Falls back to the whole text when it is short or the head is unusual. Throws like v4Blob.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function v4Head(text) {
  if (typeof text === 'string' && text.length > 256) {
    const head = stripWs(text.slice(0, 256)).slice(0, 80);
    if (head.length === 80) {
      try {
        return scriptToBytes(head, { allowRawBase64: true });
      } catch {
        // fall through: the full decode reports the error
      }
    }
  }
  return v4Blob(text);
}

/** Lowercase hex of a blob's salt (key-cache key). @param {Uint8Array} blob */
export function saltHex(blob) {
  return toHex(blob.subarray(0, 16));
}

/**
 * Derives the AES keys for one PIN spelling and one blob's salt (non-extractable; the raw bits are wiped).
 * @param {string} pin
 * @param {Uint8Array} blob
 * @returns {Promise<{gcm: CryptoKey, ctr: CryptoKey}>}
 */
export async function v4Keys(pin, blob) {
  const bits = await pbkdf2Legacy(pin, blob.slice(0, 16));
  try {
    const [gcm, ctr] = await Promise.all([
      subtle().importKey('raw', bits, 'AES-GCM', false, ['decrypt']),
      subtle().importKey('raw', bits, 'AES-CTR', false, ['decrypt']),
    ]);
    return { gcm, ctr };
  } finally {
    bits.fill(0);
  }
}

/**
 * 1-block check: decrypts only the first 16 plaintext bytes with AES-CTR on GCM's first data counter
 * block (iv ‖ 00000002) and compares them with '{"v":1,"type":"'. Works on a full blob or a v4Head().
 * Not authenticated: a match means the key is right with overwhelming probability, not that the data is intact.
 * @param {Uint8Array} blob full blob or v4Head()
 * @param {{ctr: CryptoKey}} keys
 * @returns {Promise<boolean>}
 */
export async function precheckV4(blob, keys) {
  const n = Math.min(16, blob.length - MIN_BLOB);
  if (n < PAYLOAD_PREFIX.length) return false;
  const counter = new Uint8Array(16);
  counter.set(blob.subarray(16, 28));
  counter[15] = 2;
  const pt = new Uint8Array(await subtle().decrypt({ name: 'AES-CTR', counter, length: 32 }, keys.ctr, blob.slice(28, 28 + n)));
  let d = 0;
  for (let i = 0; i < PAYLOAD_PREFIX.length; i++) d |= pt[i] ^ PAYLOAD_PREFIX[i];
  pt.fill(0);
  return d === 0;
}

/**
 * AES-GCM open of a full blob. Resolves the plaintext bytes, or null when authentication fails.
 * @param {Uint8Array} blob
 * @param {{gcm: CryptoKey}} keys
 * @returns {Promise<Uint8Array|null>}
 */
export async function openV4(blob, keys) {
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: blob.slice(16, 28) }, keys.gcm, blob.subarray(28)));
  } catch {
    return null;
  }
}

/** The old apps' TextDecoder: UTF-8, invalid bytes → U+FFFD, one leading BOM dropped. @param {Uint8Array} u8 */
export function legacyUtf8(u8) {
  return new TextDecoder().decode(u8);
}

/**
 * Decrypts v4 stealth text (raw base64 accepted, whitespace ignored) to plaintext bytes, retrying the PIN
 * spellings of pinVariants() until GCM authenticates.
 * Throws CzdError 'legacy-not-ciphertext' (not base64 / too short) or 'legacy-wrong-pin'.
 * @param {string} text
 * @param {string} pin
 * @returns {Promise<Uint8Array>}
 */
export async function decryptV4Bytes(text, pin) {
  const blob = v4Blob(text);
  for (const v of pinVariants(pin)) {
    const plain = await openV4(blob, await v4Keys(v, blob));
    if (plain) return plain;
  }
  throw new CzdError('legacy-wrong-pin');
}

/**
 * decryptV4Bytes decoded like the original app (non-fatal UTF-8, one leading U+FEFF stripped).
 * @param {string} text
 * @param {string} pin
 * @returns {Promise<string>}
 */
export async function decryptV4Text(text, pin) {
  return legacyUtf8(await decryptV4Bytes(text, pin));
}

/**
 * Whether `pin` (any spelling of pinVariants) opens a v4 file payload, by the 1-block check only
 * (one PBKDF2 per spelling, no full decrypt). False for payloads that are not legacy file JSON.
 * Throws CzdError('legacy-not-ciphertext') when `text` is not ciphertext.
 * @param {string} text
 * @param {string} pin
 * @returns {Promise<boolean>}
 */
export async function pinMatchesV4(text, pin) {
  const head = v4Head(text);
  for (const v of pinVariants(pin)) {
    if (await precheckV4(head, await v4Keys(v, head))) return true;
  }
  return false;
}

/**
 * The original detector isAES: at least 12 code points after trim(), more than 85 % of them stealth letters.
 * @param {string} s
 * @returns {boolean}
 */
export function isAES(s) {
  if (typeof s !== 'string') return false;
  const c = [...s.trim()];
  if (c.length < 12) return false;
  let hits = 0;
  for (const x of c) if (SSET.has(x)) hits++;
  return hits / c.length > 0.85;
}

/**
 * Detection heuristic for v4 stealth ciphertext: isAES plus at least one stealth letter that the Mixed Script
 * maps never produce, so long Georgian v1/v3 text is not taken for ciphertext.
 * @param {string} s
 * @returns {boolean}
 */
export function looksLikeV4(s) {
  if (!isAES(s)) return false;
  for (const ch of s) if (V4_ONLY.has(ch)) return true;
  return false;
}
