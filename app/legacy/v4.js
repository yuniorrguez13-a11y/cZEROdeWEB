// Legacy v4 AES text/file payloads: PBKDF2-SHA256 PIN key + AES-GCM (decode only).
// Owner: B (phase 1). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from '../errors.js';

/** PBKDF2-SHA256, 100000 iterations. */
export async function pbkdf2Legacy(pin, salt) {
  throw new CzdError('not-implemented');
}

/** -> Uint8Array. */
export async function decryptV4Bytes(text, pin) {
  throw new CzdError('not-implemented');
}

/** -> string; PIN retries per §3.1. */
export async function decryptV4Text(text, pin) {
  throw new CzdError('not-implemented');
}

/** 1-block precheck for file payloads. */
export async function pinMatchesV4(text, pin) {
  throw new CzdError('not-implemented');
}

/** Detection heuristic. */
export function looksLikeV4(s) {
  throw new CzdError('not-implemented');
}
