// PWA glue (DESIGN §2.6), web only: service worker registration and user-confirmed updates, the install
// prompt, the share target hand-off, and files the app is launched with. Owner: C2.
// registerServiceWorker() is the one call main.js makes; it also routes files opened with the app
// (PWA launchQueue, or Tauri file associations via platform.onOpenFiles) to state 'incoming.files' + #/incoming.
// Node-importable: browser globals are only touched inside functions.

import * as state from './state.js';
import { navigate } from './router.js';
import { isTauri, onOpenFiles } from './platform.js';

const SHARE_REPLY_MS = 5000;
const UPDATE_CHECK_MS = 60 * 60 * 1000;
/** Returning to the app checks for an update at most this often (each check is a request for sw.js). */
const UPDATE_MIN_GAP_MS = 10 * 60 * 1000;

let started = false;
/** @type {ServiceWorkerRegistration|null} */
let registration = null;
/** True once this page asked the waiting worker to take over (applyUpdate). */
let updateRequested = false;
/** A reload is already scheduled for when it is safe. */
let reloadPending = false;

function warn(what, e) {
  globalThis.console?.warn?.(`[pwa] ${what}`, e);
}

function swContainer() {
  const nav = globalThis.navigator;
  return nav && 'serviceWorker' in nav ? nav.serviceWorker : null;
}

/** Nothing secret is on screen and no job runs: a reload loses nothing. */
function safeToReload() {
  return state.get('vault.status') !== 'unlocked' && (Number(state.get('busy')) || 0) === 0;
}

/** Resolves once safeToReload() holds. */
function whenSafe() {
  if (safeToReload()) return Promise.resolve();
  return new Promise((resolve) => {
    const offs = [];
    const check = () => {
      if (!safeToReload()) return;
      for (const off of offs) off();
      resolve();
    };
    offs.push(state.on('vault.status', check), state.on('busy', check));
  });
}

function reload() {
  try {
    globalThis.location?.reload();
  } catch (e) {
    warn('reload failed', e);
  }
}

function watchRegistration(reg) {
  const sw = swContainer();
  const markIfWaiting = () => {
    // Only an UPDATE is announced: on the first install there is no controller yet.
    if (reg.waiting && sw?.controller) state.set('sw.updateReady', true);
  };
  markIfWaiting();
  reg.addEventListener('updatefound', () => {
    const incoming = reg.installing;
    if (!incoming) return;
    incoming.addEventListener('statechange', () => {
      if (incoming.state === 'installed') markIfWaiting();
    });
  });
  let lastCheck = Date.now();
  const check = () => {
    lastCheck = Date.now();
    return reg.update().catch(() => {});
  };
  const timer = setInterval(check, UPDATE_CHECK_MS);
  timer?.unref?.();
  globalThis.document?.addEventListener?.('visibilitychange', () => {
    if (globalThis.document.visibilityState === 'visible' && Date.now() - lastCheck >= UPDATE_MIN_GAP_MS) check();
  });
}

function wireIncoming() {
  onOpenFiles((files) => {
    state.set('incoming.files', files);
    navigate('#/incoming');
  });
}

/**
 * Sets up the PWA side once: registers ./sw.js (scope ./, updateViaCache none) when not under Tauri, in a
 * secure context, with service worker support, and not on *.localhost; captures beforeinstallprompt into
 * state 'install.prompt'; sets 'sw.updateReady' when an update waits; routes launched files to #/incoming.
 */
export function registerServiceWorker() {
  if (started) return;
  started = true;
  try {
    wireIncoming();
  } catch (e) {
    warn('open-files wiring failed', e);
  }
  const win = globalThis.window;
  if (isTauri || !win) return;

  win.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.set('install.prompt', e);
  });
  win.addEventListener('appinstalled', () => state.set('install.prompt', null));

  const sw = swContainer();
  if (!sw || !globalThis.isSecureContext || /\.localhost$/i.test(globalThis.location?.hostname ?? '')) return;

  let controlled = Boolean(sw.controller);
  sw.addEventListener('controllerchange', () => {
    // First install: the new worker claims this page; nothing to reload.
    if (!controlled && !updateRequested) {
      controlled = true;
      return;
    }
    // An update took over (from this tab, or another tab applied it): the page's code is now older than
    // the cache, so reload as soon as nothing would be lost.
    if (reloadPending) return;
    reloadPending = true;
    whenSafe().then(() => {
      reloadPending = false;
      reload();
    });
  });

  sw.register('./sw.js', { scope: './', updateViaCache: 'none' })
    .then((reg) => {
      registration = reg;
      watchRegistration(reg);
    })
    .catch((e) => warn('service worker registration failed', e));
}

/**
 * Applies a waiting update: waits until the vault is not unlocked and no job runs (busy 0), then asks the
 * waiting worker to skip waiting; the page reloads on controllerchange.
 * @returns {Promise<boolean>} false when no update is waiting
 */
export async function applyUpdate() {
  const sw = swContainer();
  if (!sw || isTauri) return false;
  const reg = registration ?? (await sw.getRegistration().catch(() => null));
  if (!reg || !reg.waiting) return false;
  await whenSafe();
  const waiting = reg.waiting;
  if (!waiting) return false;
  updateRequested = true;
  waiting.postMessage({ cmd: 'SKIP_WAITING' });
  return true;
}

/**
 * Files the share target received (the SW keeps them in memory for 5 minutes and hands them out once).
 * @param {string} id
 * @returns {Promise<File[]>}
 */
export async function takeSharedFiles(id) {
  const sw = swContainer();
  if (!sw || isTauri || !id) return [];
  let worker = sw.controller;
  if (!worker) {
    let timer;
    const ready = await Promise.race([sw.ready, new Promise((r) => (timer = setTimeout(() => r(null), SHARE_REPLY_MS)))]);
    clearTimeout(timer);
    worker = ready?.active ?? null;
  }
  if (!worker) return [];
  const channel = new MessageChannel();
  const reply = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), SHARE_REPLY_MS);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data);
    };
  });
  worker.postMessage({ cmd: 'share-get', id: String(id) }, [channel.port2]);
  const data = await reply;
  channel.port1.close();
  const files = Array.isArray(data?.files) ? data.files : [];
  return files.filter((f) => typeof File === 'function' && f instanceof File);
}

/** Installed PWA (display-mode standalone or iOS navigator.standalone). Always false under Tauri. */
export function isStandalone() {
  if (isTauri) return false;
  try {
    if (globalThis.matchMedia?.('(display-mode: standalone)').matches) return true;
  } catch {
    // ignore
  }
  return globalThis.navigator?.standalone === true;
}

/** iPhone/iPad, including iPadOS Safari in desktop mode (reports MacIntel with touch points). */
export function isIOS() {
  const nav = globalThis.navigator;
  if (!nav) return false;
  if (/iPad|iPhone|iPod/.test(nav.userAgent ?? '')) return true;
  return nav.platform === 'MacIntel' && Number(nav.maxTouchPoints) > 1;
}

/**
 * Shows the browser's install prompt captured from beforeinstallprompt (Chromium only).
 * @returns {Promise<boolean>} true when the user accepted
 */
export async function promptInstall() {
  const event = state.get('install.prompt');
  if (!event || typeof event.prompt !== 'function') return false;
  state.set('install.prompt', null); // a prompt event can be used once
  try {
    await event.prompt();
    const choice = await event.userChoice;
    return choice?.outcome === 'accepted';
  } catch {
    return false;
  }
}
