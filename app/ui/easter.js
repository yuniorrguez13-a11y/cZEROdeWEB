// Weak-PIN easter egg (DESIGN §1.11).
// Owner: C1 (phase 1). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from '../errors.js';

/** Shows the weak-PIN modal for 123/1234/12345 on secret-setting purposes only. */
export function maybeEasterEgg(value, purpose) {
  throw new CzdError('not-implemented');
}

/** The weak-PIN modal itself. */
export function showSkull() {
  throw new CzdError('not-implemented');
}
