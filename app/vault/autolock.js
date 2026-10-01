// Idle/hidden/panic lock rules (DESIGN §1.6).
// Owner: E (phase 2). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from '../errors.js';

/** -> stop(). */
export function startAutolock({ vault, settings, state, isMediaPlaying }) {
  throw new CzdError('not-implemented');
}
