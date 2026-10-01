// Old desktop .czd files ({"v":1,"type":"image","cipher":<v4>}).
// Owner: B (phase 1). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from '../errors.js';

/** Sniffs the old JSON .czd prefix ({"v":1,"type":"image"). */
export function isOldCzd(first8) {
  throw new CzdError('not-implemented');
}

/** -> {name, type, blob}. */
export async function openOldCzd(text, pin) {
  throw new CzdError('not-implemented');
}
