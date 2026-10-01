// Import queue and special-file sniffing.
// Owner: V1b (phase 3). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from '../errors.js';

/** -> {el, done: Promise}. */
export function startImport({ vault, files, folders, album }) {
  throw new CzdError('not-implemented');
}

/** -> 'czd2'|'czb'|'oldczd'|null. */
export async function sniffFile(file) {
  throw new CzdError('not-implemented');
}

/** Sends a czd2/czb/old .czd file to Open/Restore/Legacy instead of importing it. */
export function routeSpecialFile(file, kind) {
  throw new CzdError('not-implemented');
}
