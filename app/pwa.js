// PWA glue: service worker registration, updates, install, share target (web only).
// Owner: C2 (phase 1). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from './errors.js';

/** Registers sw.js (never under Tauri). */
export function registerServiceWorker() {
  throw new CzdError('not-implemented');
}

/** SKIP_WAITING + reload when safe. */
export async function applyUpdate() {
  throw new CzdError('not-implemented');
}

/** -> File[] from the share target. */
export async function takeSharedFiles(id) {
  throw new CzdError('not-implemented');
}

/** Installed PWA (display-mode standalone or navigator.standalone). */
export function isStandalone() {
  throw new CzdError('not-implemented');
}

/** iPhone/iPad (including iPadOS desktop-mode Safari). */
export function isIOS() {
  throw new CzdError('not-implemented');
}

/** -> boolean. */
export async function promptInstall() {
  throw new CzdError('not-implemented');
}
