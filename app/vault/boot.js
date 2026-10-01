// Vault boot: db/store/vault singleton, tab lock, sweeps, autolock, legacy probe, Tauri mirror rebuild, setStager.
// Owner: E (phase 2). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from '../errors.js';

/** Called once by main.js. */
export async function boot({ router, state, settings }) {
  throw new CzdError('not-implemented');
}
