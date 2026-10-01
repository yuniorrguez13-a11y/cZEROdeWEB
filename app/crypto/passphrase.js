// Passphrase generation and strength estimate (DESIGN §3.9).
// Owner: A (phase 1). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from '../errors.js';

/** BIP39 words joined by "-". */
export function generatePassphrase(words) {
  throw new CzdError('not-implemented');
}

/** Entropy estimate for a typed passphrase. */
export function estimateBits(s) {
  throw new CzdError('not-implemented');
}

/** -> {bits, label:'weak'|'ok'|'strong', crack}. */
export function strength(s, { generated = false, words = 0 } = {}) {
  throw new CzdError('not-implemented');
}

/** Crack-time label. */
export function crackTime(bits) {
  throw new CzdError('not-implemented');
}

/** -> {ok, reason}. */
export function meetsVaultMinimum(s, { generated }) {
  throw new CzdError('not-implemented');
}

/** The old app's weak-PIN set. */
export const WEAK = new Set(['123', '1234', '12345', 'password', 'qwerty', 'abc', '0000', '1111', 'pass', 'admin']);

/** In the old WEAK set (inline warning on secret-setting fields). */
export function isWeak(s) {
  throw new CzdError('not-implemented');
}

/** '123'|'1234'|'12345'. */
export function isEasterEggPin(s) {
  throw new CzdError('not-implemented');
}
