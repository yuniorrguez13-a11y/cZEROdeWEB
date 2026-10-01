// Old desktop .czd files (decode only): UTF-8 JSON {"v":1,"type":"image","cipher":<v4 stealth text>} whose
// cipher decrypts to {"v":1,"type":"image","mime","name","data":<base64>} (legacy-desktop.md §1).

import { CzdError } from '../errors.js';
import { fromB64, utf8 } from '../util/bytes.js';
import { safeFilename, safeMediaType } from '../util/format.js';
import { decryptV4Bytes, legacyUtf8 } from './v4.js';

// {"v":1, with JSON whitespace allowed between tokens and an optional UTF-8 BOM.
const PREFIX = /^(?:\xef\xbb\xbf)?[ \t\r\n]*\{[ \t\r\n]*"v"[ \t\r\n]*:[ \t\r\n]*1[ \t\r\n]*,/;
// A sniff cut short after the "v" key, with everything seen so far consistent with PREFIX.
const PARTIAL = /^(?:\xef\xbb\xbf)?[ \t\r\n]*\{[ \t\r\n]*"v"[ \t\r\n]*(?::[ \t\r\n]*(?:1[ \t\r\n]*)?)?$/;

const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp',
  'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/tiff': 'tif' };

/**
 * Lower-cased MIME type when `t` is a plausible type/subtype token, else ''. The app's own pseudo-types
 * (application/x-czd-note, application/x-czd-bundle) never come from old data and are refused, so an old
 * record cannot pose as a vault note or bundle.
 * @param {unknown} t
 * @returns {string}
 */
export function cleanMime(t) {
  if (typeof t !== 'string') return '';
  const m = t.trim().toLowerCase();
  if (m.startsWith('application/x-czd-')) return '';
  return m.length <= 127 && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(m) ? m : '';
}

function extForImage(mime) {
  if (IMAGE_EXT[mime]) return IMAGE_EXT[mime];
  const sub = mime.split('/')[1].replace(/^x-/, '');
  return /^[a-z0-9]{1,8}$/.test(sub) ? sub : 'png';
}

function b64(data) {
  try {
    return fromB64(data);
  } catch {
    throw new CzdError('legacy-bad-record');
  }
}

/**
 * Sniffs the old JSON .czd prefix {"v":1, (JSON whitespace and a UTF-8 BOM tolerated). With only the first
 * 8 bytes the prefix may be cut short; it then matches when everything seen is consistent and the "v" key is in.
 * @param {Uint8Array|ArrayBuffer|string} first8
 * @returns {boolean}
 */
export function isOldCzd(first8) {
  let u8;
  if (typeof first8 === 'string') u8 = utf8(first8);
  else if (first8 instanceof Uint8Array || first8 instanceof ArrayBuffer) u8 = new Uint8Array(first8);
  else return false;
  const s = String.fromCharCode(...u8.subarray(0, 64)); // one char per byte
  return PREFIX.test(s) || (u8.length < 64 && PARTIAL.test(s));
}

/**
 * Opens an old desktop .czd: parses the outer JSON (one leading BOM ignored), decrypts `cipher` with the PIN
 * (spellings retried per DESIGN §3.1) and returns the image. A missing or non-string mime means image/png, and
 * the name gets an extension from the mime. Web-edition single-file payloads are accepted too; any other
 * plaintext comes back as a text file.
 * Throws CzdError 'legacy-bad-record' (not an old .czd / bad payload), 'legacy-not-ciphertext' or 'legacy-wrong-pin'.
 * @param {string|Uint8Array} text file contents
 * @param {string} pin
 * @returns {Promise<{name: string, type: string, blob: Blob}>}
 */
export async function openOldCzd(text, pin) {
  let s = text;
  if (s instanceof Uint8Array) {
    try {
      s = new TextDecoder('utf-8', { fatal: true }).decode(s);
    } catch {
      throw new CzdError('legacy-bad-record');
    }
  }
  if (typeof s !== 'string') throw new CzdError('legacy-bad-record');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  let outer;
  try {
    outer = JSON.parse(s);
  } catch {
    throw new CzdError('legacy-bad-record');
  }
  if (!outer || typeof outer !== 'object' || typeof outer.cipher !== 'string' || !outer.cipher) throw new CzdError('legacy-bad-record');

  const plaintext = legacyUtf8(await decryptV4Bytes(outer.cipher, pin));
  let p = null;
  try {
    p = JSON.parse(plaintext);
  } catch {
    // not JSON: returned as text below
  }
  if (p && typeof p === 'object' && p.type === 'image' && typeof p.data === 'string') {
    const type = cleanMime(p.mime) || 'image/png';
    const base = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : 'decrypted_image';
    return { name: safeFilename(`${base}.${extForImage(type)}`), type, blob: new Blob([b64(p.data)], { type: safeMediaType(type) }) };
  }
  if (p && typeof p === 'object' && p.type === 'file' && typeof p.data === 'string') {
    const type = cleanMime(p.mime) || 'application/octet-stream';
    const name = `${typeof p.name === 'string' && p.name ? p.name : 'file'}.${typeof p.ext === 'string' && p.ext ? p.ext : 'bin'}`;
    return { name: safeFilename(name), type, blob: new Blob([b64(p.data)], { type: safeMediaType(type) }) };
  }
  return { name: 'decrypted.txt', type: 'text/plain', blob: new Blob([plaintext], { type: safeMediaType('text/plain') }) };
}
