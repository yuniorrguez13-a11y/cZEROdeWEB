// Decrypted media for the viewer/player: Blob, SW streaming or Tauri czstream URLs (DESIGN §5).
// Owner: F (phase 2). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from '../errors.js';
import { CAPS } from '../config.js';

/** mode 'image'|'audio'|'video'; -> {url, via:'blob'|'sw'|'tauri', release()}; throws too-big-to-preview. */
export async function playableUrl(src, { mode }) {
  throw new CzdError('not-implemented');
}

/** -> {text, truncated}. */
export async function readText(src, { maxBytes = CAPS.text } = {}) {
  throw new CzdError('not-implemented');
}

/** -> Blob. */
export async function decryptToBlob(src, { maxBytes, type, signal }) {
  throw new CzdError('not-implemented');
}

/** -> File. */
export async function prepareShare(src, { name, type }) {
  throw new CzdError('not-implemented');
}

/** Streams to a SaveTarget; provisional on error. */
export async function saveDecrypted(target, src, { name, type, signal, onProgress }) {
  throw new CzdError('not-implemented');
}

/** Starts preparing the next track/item. */
export function prefetch(src) {
  throw new CzdError('not-implemented');
}

/** Revokes everything (registered via onPurge). */
export function releaseAll() {
  throw new CzdError('not-implemented');
}
