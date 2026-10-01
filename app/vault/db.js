// IndexedDB czd-vault v1 (DESIGN §4.1).
// Owner: D (phase 2). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from '../errors.js';

/** -> VaultDb. */
export async function openVaultDb({ idb = globalThis.indexedDB } = {}) {
  throw new CzdError('not-implemented');
}
