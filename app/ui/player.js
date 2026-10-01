// Persistent audio/video player dock (mounted once into #player-dock by the shell).
// Owner: F (phase 2). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from '../errors.js';

/** Mounts the player UI into the shell dock. */
export function mountPlayer(dock) {
  throw new CzdError('not-implemented');
}

/** items: ViewerItem[]. */
export function playQueue(items, { start = 0, shuffle = false, repeat = 'off', title } = {}) {
  throw new CzdError('not-implemented');
}

/** Stops playback and clears the queue. */
export function stop() {
  throw new CzdError('not-implemented');
}

/** True while audio/video plays (autolock activity). */
export function isPlaying() {
  throw new CzdError('not-implemented');
}
