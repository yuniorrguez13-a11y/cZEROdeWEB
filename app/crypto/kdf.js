// Argon2id KDF: the ONLY place KDF constants live (DESIGN §3.2).
// Owner: A (phase 1). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from '../errors.js';

/** KDF id for Argon2id v1.3. */
export const KDF_ARGON2ID = 1;

/** Default parameters. */
export const POLICY = Object.freeze({ m: 65536, t: 3, p: 1 });

/** Low-memory parameters. */
export const FLOOR = Object.freeze({ m: 19456, t: 2, p: 1 });

/** UTF-8(s.normalize('NFC').trim().replace(/\s+/gu, ' ')). */
export function passphraseBytes(s) {
  throw new CzdError('not-implemented');
}

/** 'ok'|'confirm' or throws CzdError('kdf-params-out-of-range'). */
export function checkParams(params) {
  throw new CzdError('not-implemented');
}

/** -> Uint8Array(32). */
export async function argon2id(pwBytes, salt, params, { signal } = {}) {
  throw new CzdError('not-implemented');
}

/** Cached derivation; build: async (bits) => value; bits zero-filled after. */
export async function derive(pass, salt, params, { purpose, signal, confirmKdf, build }) {
  throw new CzdError('not-implemented');
}

/** -> AES-GCM CryptoKey (encrypt, decrypt, wrapKey, unwrapKey). */
export async function deriveKek(pass, salt, params, opts) {
  throw new CzdError('not-implemented');
}

/** Drops the derived-key cache (purge). */
export function clearKdfCache() {
  throw new CzdError('not-implemented');
}

/** -> {ok, ms}. */
export async function bootProbe() {
  throw new CzdError('not-implemented');
}

/** Duration of the last Argon2 run (ms). */
export let lastMs = 0;

/** Test hook: replace the Argon2 implementation (null restores it). */
export function __setArgon2ForTests(fn) {
  throw new CzdError('not-implemented');
}
