// Hash router (DESIGN §1.2).
// Owner: C1 (phase 1). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from './errors.js';

/** routes: {top: () => Promise<ViewModule>}. */
export function start(root, routes, { fallback = 'vault' }) {
  throw new CzdError('not-implemented');
}

/** Changes the route. */
export function navigate(hash, { replace = false } = {}) {
  throw new CzdError('not-implemented');
}

/** -> Route. */
export function current() {
  throw new CzdError('not-implemented');
}

/** History entry for sheets/viewer; returns {close()}. */
export function pushOverlay(onPop) {
  throw new CzdError('not-implemented');
}
