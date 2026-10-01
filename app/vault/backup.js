// Backup .czb v1 (DESIGN §3.7).
// Owner: E (phase 2). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from '../errors.js';

/** Yields the backup bytes. */
export async function* writeBackup(ctx) {
  throw new CzdError('not-implemented');
}

/** Parse + bounds, no keys. */
export async function readBackupHeader(src) {
  throw new CzdError('not-implemented');
}

/** Replace or merge. */
export async function restore(ctx, src, secret, opts) {
  throw new CzdError('not-implemented');
}
