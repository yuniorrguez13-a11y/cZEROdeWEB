// Text format v2: Argon2id + AES-GCM + key commitment, written in the stealth alphabet (DESIGN §3.4).
//   text   = "ჶ" + bytesToScript(blob)
//   blob   = 0x02 | preset | salt16 | nonce12 | commit16 | GCM(encKey, nonce, pt, aad = blob[0..2))
//   encKey = HKDF(bits, ∅, "cZEROde text v2 key");  commit = HKDF(bits, ∅, "cZEROde text v2 commit")[0..16)
//   pt     = UTF-8(message) ‖ 0x80 ‖ 0x00* (multiple of 16)

import { CzdError, toCzdError } from '../errors.js';
import { ascii, concat, ctEqual, fromUtf8, randomBytes, utf8 } from '../util/bytes.js';
import { FLOOR, POLICY, derive, passphraseBytes } from './kdf.js';
import { bytesToScript, scriptToBytes, stripWs } from './stealth.js';
import { detectLegacyText } from '../legacy/mixed.js';

/** Marker that starts every v2 message (U+10F6, outside the stealth alphabet). */
export const TEXT_MARKER = 'ჶ';

const VERSION = 0x02;
const PRESETS = Object.freeze({ 1: POLICY, 2: FLOOR });
const HEAD = 2 + 16 + 12 + 16; // version, preset, salt, nonce, commit
const INFO_KEY = ascii('cZEROde text v2 key');
const INFO_COMMIT = ascii('cZEROde text v2 commit');
const subtle = () => globalThis.crypto.subtle;

function presetOf(params) {
  for (const [id, p] of Object.entries(PRESETS)) {
    if (params.m === p.m && params.t === p.t && params.p === p.p) return Number(id);
  }
  throw new TypeError('encryptText(): params must be POLICY or FLOOR');
}

/** bits → {encKey (AES-GCM), commit (16 bytes)}; cached by kdf.derive under purpose 'text-v2'. */
async function buildTextKeys(bits) {
  const hk = await subtle().importKey('raw', bits, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const hkdf = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info });
  const [encKey, commit] = await Promise.all([
    subtle().deriveKey(hkdf(INFO_KEY), hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
    subtle().deriveBits(hkdf(INFO_COMMIT), hk, 128),
  ]);
  return { encKey, commit: new Uint8Array(commit) };
}

function pad(msgBytes) {
  const out = new Uint8Array((Math.floor(msgBytes.length / 16) + 1) * 16);
  out.set(msgBytes);
  out[msgBytes.length] = 0x80;
  return out;
}

function unpad(pt) {
  let i = pt.length - 1;
  while (i >= 0 && pt[i] === 0) i--;
  if (i < 0 || pt[i] !== 0x80 || pt.length - i > 16) throw new CzdError('not-cz-text', { detail: 'padding' });
  return pt.subarray(0, i);
}

/**
 * Encrypts a message (fresh salt and nonce every time).
 * @param {string} message exactly as typed
 * @param {string} passphrase
 * @param {{params?: {m:number,t:number,p:number}, signal?: AbortSignal}} [opts] params: POLICY (preset 1, default) or FLOOR (preset 2)
 * @returns {Promise<string>}
 */
export async function encryptText(message, passphrase, { params = POLICY, signal } = {}) {
  if (typeof message !== 'string') throw new TypeError('encryptText(): message must be a string');
  if (typeof passphrase !== 'string' || passphraseBytes(passphrase).length === 0) throw new TypeError('encryptText(): empty passphrase');
  const preset = presetOf(params);
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const { encKey, commit } = await derive(passphrase, salt, PRESETS[preset], { purpose: 'text-v2', signal, build: buildTextKeys });
  const head = new Uint8Array([VERSION, preset]);
  const pt = pad(utf8(message));
  try {
    const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: head }, encKey, pt));
    return TEXT_MARKER + bytesToScript(concat(head, salt, nonce, commit, ct));
  } finally {
    pt.fill(0);
  }
}

/**
 * Decrypts a v2 message. Whitespace anywhere is ignored; the commitment is compared (constant time)
 * before AES-GCM, so a wrong passphrase never reaches the cipher.
 * @param {string} text
 * @param {string} passphrase
 * @param {{confirmKdf?: Function, signal?: AbortSignal}} [opts]
 * @returns {Promise<string>}
 * @throws {CzdError} not-cz-text | wrong-passphrase | text-preset-unknown
 */
export async function decryptText(text, passphrase, { confirmKdf, signal } = {}) {
  if (typeof passphrase !== 'string') throw new TypeError('decryptText(): passphrase must be a string');
  try {
    const s = typeof text === 'string' ? stripWs(text) : '';
    if (!s.startsWith(TEXT_MARKER)) throw new CzdError('not-cz-text');
    let blob;
    try {
      blob = scriptToBytes(s.slice(TEXT_MARKER.length), { allowRawBase64: false });
    } catch {
      throw new CzdError('not-cz-text');
    }
    if (blob.length < 2) throw new CzdError('not-cz-text');
    if (blob[0] !== VERSION) throw new CzdError(blob[0] > VERSION ? 'text-preset-unknown' : 'not-cz-text');
    const params = PRESETS[blob[1]];
    if (!params) throw new CzdError('text-preset-unknown');
    const ctLen = blob.length - HEAD;
    if (ctLen < 32 || ctLen % 16 !== 0) throw new CzdError('not-cz-text');
    if (passphraseBytes(passphrase).length === 0) throw new CzdError('wrong-passphrase');
    const salt = blob.slice(2, 18);
    const nonce = blob.subarray(18, 30);
    const commit = blob.subarray(30, 46);
    const keys = await derive(passphrase, salt, params, { purpose: 'text-v2', signal, confirmKdf, build: buildTextKeys });
    if (!ctEqual(keys.commit, commit)) throw new CzdError('wrong-passphrase');
    let pt;
    try {
      pt = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: nonce, additionalData: blob.subarray(0, 2) }, keys.encKey, blob.subarray(HEAD)));
    } catch {
      throw new CzdError('not-cz-text', { detail: 'tampered' });
    }
    try {
      return fromUtf8(unpad(pt));
    } catch (e) {
      throw e instanceof CzdError ? e : new CzdError('not-cz-text', { detail: 'utf-8' });
    } finally {
      pt.fill(0);
    }
  } catch (e) {
    throw toCzdError(e);
  }
}

// Stealth letters that Mixed Script v1–v3 never emits (SA minus the v1 letter maps; the same set as
// legacy/v4.js V4_ONLY, checked by a unit test against legacy/mixed.decodeV1).
const MIXED_NEVER = new Set('თჟქღშჩძჭБЙПЦЩЪЫЬЭЮ');
const MIN_SCRIPT_SHARE = 1 / 8;

/**
 * Classifies pasted text: 'v2' (marker), 'v4', 'mixed' (legacy Mixed Script v1–v3) or null.
 * 'v4' = ≥ 60 characters and ≥ 85 % stealth characters (DESIGN §1.8) that also look like base64 over the
 * stealth alphabet rather than prose or Mixed Script:
 *  - at least one letter Mixed Script never emits (keeps v1 text with capitals and v3 text out);
 *  - Georgian and Cyrillic each ≥ 1/8 of the stealth characters (keeps Georgian prose out, also with a
 *    Russian name in it; ciphertext is about 52 % / 48 %).
 * For 60 random base64 digits the two rules miss with probability ≈ 3e-9 and ≈ 1e-8.
 * @param {string} s
 * @returns {'v2'|'v4'|'mixed'|null}
 */
export function detectText(s) {
  if (typeof s !== 'string') return null;
  const t = stripWs(s);
  if (t === '') return null;
  if (t.startsWith(TEXT_MARKER)) return 'v2';
  let count = 0;
  let cyrillic = 0;
  let georgian = 0;
  let neverMixed = false;
  for (const ch of t) {
    count++;
    if (ch >= '\u0410' && ch <= '\u042e') cyrillic++;
    else if (ch >= '\u10d0' && ch <= '\u10f0') georgian++;
    if (MIXED_NEVER.has(ch)) neverMixed = true;
  }
  const stealth = cyrillic + georgian;
  if (count >= 60 && stealth / count >= 0.85 && neverMixed
    && cyrillic >= stealth * MIN_SCRIPT_SHARE && georgian >= stealth * MIN_SCRIPT_SHARE) return 'v4';
  try {
    const legacy = detectLegacyText(s);
    if (legacy === 'v1' || legacy === 'v2' || legacy === 'v3') return 'mixed';
  } catch {
    // a detector must never throw
  }
  return null;
}
