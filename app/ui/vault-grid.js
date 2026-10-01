// Vault grid/list of items.
// Owner: V1a (phase 3). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from '../errors.js';

/** -> {el, update(), destroy()}. */
export function grid({ vault, filter, onOpen, onSelect }) {
  throw new CzdError('not-implemented');
}
