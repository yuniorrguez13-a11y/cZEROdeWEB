// Text format v2: Argon2id + AES-GCM + key commitment in the stealth alphabet (DESIGN §3.4).
// Owner: A (phase 1). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from '../errors.js';

/** Marker that starts every v2 message (U+10F6). */
export const TEXT_MARKER = 'ჶ';

/** -> string. */
export async function encryptText(message, passphrase, { params, signal } = {}) {
  throw new CzdError('not-implemented');
}

/** -> string; throws not-cz-text | wrong-passphrase | text-preset-unknown. */
export async function decryptText(text, passphrase, { confirmKdf, signal } = {}) {
  throw new CzdError('not-implemented');
}

/** -> 'v2'|'v4'|'mixed'|null. */
export function detectText(s) {
  throw new CzdError('not-implemented');
}
