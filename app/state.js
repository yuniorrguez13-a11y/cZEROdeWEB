// Tiny app state store + the lock/purge registry.
// Owner: C1 (phase 1). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from './errors.js';

/** Current value. */
export function get(key) {
  throw new CzdError('not-implemented');
}

/** Sets and notifies. */
export function set(key, value) {
  throw new CzdError('not-implemented');
}

/** Subscribe (key or '*'); returns off(). */
export function on(key, fn) {
  throw new CzdError('not-implemented');
}

/** Registers a purge handler (reason) => void; returns off(). */
export function onPurge(fn) {
  throw new CzdError('not-implemented');
}

/** Runs purge handlers (errors isolated), posts SW {cmd:'lock'}, Tauri stream_clear, BroadcastChannel 'czd-lock'. */
export function purge(reason) {
  throw new CzdError('not-implemented');
}

/** Adjusts 'busy'. */
export function busy(delta) {
  throw new CzdError('not-implemented');
}
