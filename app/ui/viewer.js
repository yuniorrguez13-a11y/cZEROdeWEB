// Full-screen viewer (DESIGN §1.5).
// Owner: F (phase 2). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from '../errors.js';

/** items: ViewerItem[]; -> {close(), setIndex(i), update(items)}. */
export function openViewer({ items, index, onAction, onClose, routed = false }) {
  throw new CzdError('not-implemented');
}

/** Closes the open viewer, if any. */
export function closeViewer() {
  throw new CzdError('not-implemented');
}
