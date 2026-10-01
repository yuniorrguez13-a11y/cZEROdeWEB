// Albums strip, editor and add-to-album dialog.
// Owner: V1b (phase 3). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from '../errors.js';

/** -> el. */
export function albumStrip({ vault, onOpen }) {
  throw new CzdError('not-implemented');
}

/** -> sheet. */
export function albumEditor({ vault, id }) {
  throw new CzdError('not-implemented');
}

/** Lets the user pick or create an album for the items. */
export async function addToAlbumDialog({ vault, itemIds }) {
  throw new CzdError('not-implemented');
}
