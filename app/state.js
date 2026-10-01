// Tiny app state store + the lock/purge registry (DESIGN §10).
// Keys: 'vault.status' 'route' 'sw.updateReady' 'install.prompt' 'busy' 'send.pending' {itemIds}
//       'incoming.files' File[] 'settings' {key,value} 'player' {playing:boolean}
//       'open.waiting' true while a .czd set aside by a receiver without a vault waits in Send · Open
// purge(reason) is what "lock" means for everything outside the vault: every module that holds
// keys, object URLs or decrypted DOM registers an onPurge handler.

import { randomBytes, toHex } from './util/bytes.js';

const values = new Map([['busy', 0], ['sw.updateReady', false]]);
const listeners = new Map(); // key | '*' → Set<fn>
const purgeHandlers = new Set();
let channel; // BroadcastChannel('czd-lock'), created on first use
let purging = false;
/** Lock reasons that come from this tab's own inactivity: they lock this tab only (see purge, isPassive). */
const PASSIVE = new Set(['idle', 'hidden', 'pagehide', 'freeze']);

/**
 * Whether a lock reason is passive — this tab's idle or hidden timer, or the page being hidden/frozen — as opposed
 * to a deliberate lock (user, panic, destroy, a closed database…). Passive purges never reach other tabs: the
 * service worker drops only this page's streams and nothing is broadcast. Extra over §10 (vault boot uses it too).
 * @param {string} reason
 * @returns {boolean}
 */
export function isPassive(reason) {
  return PASSIVE.has(String(reason));
}

/**
 * Random id of this tab, sent as `from` with every 'czd-lock' broadcast. A BroadcastChannel never delivers
 * a message to the object that posted it, but it DOES deliver it to other channel objects of the same tab,
 * so a listener with its own channel must ignore messages whose `from` is TAB_ID (onRemoteLock does that).
 */
export const TAB_ID = (() => {
  try {
    return toHex(randomBytes(8));
  } catch {
    return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  }
})();

function lockChannel() {
  if (channel) return channel;
  if (typeof globalThis.BroadcastChannel !== 'function') return null;
  try {
    channel = new BroadcastChannel('czd-lock');
    channel.unref?.(); // Node: don't keep the process alive (browsers have no unref)
  } catch (e) {
    report('BroadcastChannel czd-lock', e);
    channel = null;
  }
  return channel;
}

function report(where, err) {
  try {
    globalThis.console?.error?.(`[state] ${where} failed`, err);
  } catch {
    // ignore
  }
}

/**
 * Current value of a key (undefined when never set).
 * @param {string} key
 * @returns {any}
 */
export function get(key) {
  return values.get(key);
}

/**
 * Sets a key and notifies its listeners and '*' listeners when the value changed (Object.is).
 * Listener errors are isolated (logged, never thrown to the caller).
 * @param {string} key
 * @param {any} value
 */
export function set(key, value) {
  const old = values.get(key);
  if (values.has(key) && Object.is(old, value)) return;
  values.set(key, value);
  const info = { key, old };
  for (const k of [key, '*']) {
    const fns = listeners.get(k);
    if (!fns) continue;
    for (const fn of [...fns]) {
      try {
        fn(value, info);
      } catch (e) {
        report(`listener for '${key}'`, e);
      }
    }
  }
}

/**
 * Subscribes to a key (or '*' for every key). The listener gets (value, {key, old}).
 * @param {string} key
 * @param {(value: any, info: {key: string, old: any}) => void} fn
 * @returns {() => void} off
 */
export function on(key, fn) {
  if (typeof fn !== 'function') throw new TypeError('state.on(): fn must be a function');
  let fns = listeners.get(key);
  if (!fns) listeners.set(key, (fns = new Set()));
  fns.add(fn);
  return () => {
    fns.delete(fn);
  };
}

/**
 * Registers a purge handler, called with the lock reason ('user'|'idle'|'hidden'|'pagehide'|'panic'|'remote'|…).
 * @param {(reason: string) => void} fn
 * @returns {() => void} off
 */
export function onPurge(fn) {
  if (typeof fn !== 'function') throw new TypeError('state.onPurge(): fn must be a function');
  purgeHandlers.add(fn);
  return () => {
    purgeHandlers.delete(fn);
  };
}

/**
 * Lock-time cleanup: runs every purge handler (errors and rejections isolated, registration order),
 * then best effort: SW {cmd:'lock'} (drops streaming keys), Tauri stream_clear, and
 * BroadcastChannel 'czd-lock' {cmd:'lock', reason, from: TAB_ID} so other tabs lock too (not re-broadcast
 * for 'remote'). A passive reason (isPassive: idle, hidden, pagehide, freeze) stays in this tab: the SW gets
 * {cmd:'lock', scope:'client'} (only this page's streams) and nothing is broadcast, so a background tab's own
 * idle/hidden purge never stops the media or locks the vault of the tab in use. Synchronous; the cross-process
 * parts finish in the background. A purge() called from a purge handler is ignored (the running one already
 * clears everything).
 * @param {string} reason
 */
export function purge(reason) {
  // A handler that locks again (vault.lock → purge) must not recurse: the running purge covers it.
  if (purging) return;
  purging = true;
  try {
    for (const fn of [...purgeHandlers]) {
      try {
        const r = fn(reason);
        if (r && typeof r.then === 'function') r.then(undefined, (e) => report('purge handler', e));
      } catch (e) {
        report('purge handler', e);
      }
    }
  } finally {
    purging = false;
  }
  const passive = isPassive(reason);
  try {
    globalThis.navigator?.serviceWorker?.controller?.postMessage(passive ? { cmd: 'lock', scope: 'client' } : { cmd: 'lock' });
  } catch (e) {
    report('SW lock message', e);
  }
  if (globalThis.__TAURI__ || globalThis.isTauri === true) {
    import('./platform.js')
      .then((p) => (p.isTauri && typeof p.tauriStreamClear === 'function' ? p.tauriStreamClear() : undefined))
      .catch((e) => report('tauriStreamClear', e));
  }
  if (reason !== 'remote' && !passive) {
    try {
      lockChannel()?.postMessage({ cmd: 'lock', reason: String(reason), from: TAB_ID });
    } catch (e) {
      report('BroadcastChannel czd-lock', e);
    }
  }
}

/**
 * Subscribes to lock broadcasts from OTHER tabs ('czd-lock' messages whose `from` isn't TAB_ID); the
 * listener gets the remote reason and is expected to lock this tab (vault.lock('remote')).
 * Extra over §10 (used by vault boot/autolock). No-op without BroadcastChannel.
 * @param {(reason: string) => void} fn
 * @returns {() => void} off
 */
export function onRemoteLock(fn) {
  if (typeof fn !== 'function') throw new TypeError('state.onRemoteLock(): fn must be a function');
  const ch = lockChannel();
  if (!ch) return () => {};
  const handler = (e) => {
    const m = e?.data;
    if (!m || typeof m !== 'object' || m.cmd !== 'lock' || m.from === TAB_ID) return;
    try {
      fn(typeof m.reason === 'string' ? m.reason : 'remote');
    } catch (err) {
      report('remote lock listener', err);
    }
  };
  ch.addEventListener('message', handler);
  return () => ch.removeEventListener('message', handler);
}

/**
 * Adjusts the 'busy' counter (running jobs; > 0 blocks update reloads). Never goes below 0.
 * @param {number} delta
 * @returns {number} the new count
 */
export function busy(delta) {
  const n = Math.max(0, (Number(values.get('busy')) || 0) + (Number(delta) || 0));
  set('busy', n);
  return n;
}
