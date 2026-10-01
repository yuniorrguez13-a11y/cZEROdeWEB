// Per-device settings in localStorage ('czd2.' + name, JSON).
// Owner: C1 (phase 1). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from './errors.js';

/** Default values for every setting. */
export const DEFAULTS = Object.freeze({
  theme: 'gothic',
  idleLockMin: 5,
  hiddenLock: '3m',
  keepAudioWhenHidden: true,
  privacyCover: true,
  clipboardClearSec: 30,
  vaultView: 'grid',
  vaultSort: 'new',
  sendHideName: true,
  sendOnePerFile: false,
  sendKeepDates: false,
  tutorialDone: false,
  dismissed: Object.freeze({}),
});

/** Setting value (default when unset). */
export function get(name) {
  throw new CzdError('not-implemented');
}

/** Stores a setting. */
export function set(name, value) {
  throw new CzdError('not-implemented');
}

/** All settings. */
export function all() {
  throw new CzdError('not-implemented');
}

/** czd_theme → czd2.theme once. */
export function migrateLegacy() {
  throw new CzdError('not-implemented');
}
