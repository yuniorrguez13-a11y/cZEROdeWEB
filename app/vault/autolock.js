// Lock rules (DESIGN §1.6, §11): idle lock, hidden lock, lock on pagehide/freeze, panic Esc×3, privacy cover.
// Every rule compares timestamps when the page is shown again or receives input, so a throttled or frozen page
// still locks before it renders anything; timers are only best-effort extras.
// - Activity = input (pointer/key/touch/wheel), media playing (isMediaPlaying / state 'player') or a running job
//   (state 'busy' > 0).
// - Hidden time does not count while a picker/dialog/share sheet is pending (state 'picker.pending') or, with
//   "Keep music playing when hidden", while media plays.
// - With no unlocked vault the same rules still run state.purge(reason) (clears Send/Text secrets) — once per idle
//   or hidden period.
// - While a job runs (state 'busy' > 0) the screen wake lock is held where available (re-requested when shown again).
// - Settings are read live (app/settings.js get()) at every check.
// Node-importable: document/window are only touched inside startAutolock (injectable for tests).

import { isPickerPending as platformPickerPending, isTauri as platformIsTauri } from '../platform.js';

const TICK_MS = 5000;
const MIN_IDLE_MS = 60_000;
const PANIC_PRESSES = 3;
const PANIC_WINDOW_MS = 1500;
const HIDDEN_MS = Object.freeze({ immediate: 0, '1m': 60_000, '3m': 180_000, '15m': 900_000, never: Infinity });
const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel'];
const COVER = 'privacy-cover';

/**
 * Starts the lock rules. Extra options (tests): document, window, now, timers {setTimeout, clearTimeout, setInterval,
 * clearInterval}, isTauri, tauriWindow (an object with onFocusChanged/onResized/isMinimized like Tauri's Window),
 * wakeLock (navigator.wakeLock stand-in).
 * @param {{vault?: {status: string, lock(reason: string): void, addEventListener?: Function, removeEventListener?: Function},
 *   settings: {get(name: string): any}, state: {get(k: string): any, on(k: string, fn: Function): () => void, purge(reason: string): void},
 *   isMediaPlaying?: () => boolean, document?: Document, window?: Window, now?: () => number, timers?: object,
 *   isTauri?: boolean, tauriWindow?: object}} opts
 * @returns {() => void} stop
 */
export function startAutolock({
  vault,
  settings,
  state,
  isMediaPlaying,
  document: doc = globalThis.document,
  window: win = globalThis.window,
  now = () => Date.now(),
  timers = globalThis,
  isTauri = platformIsTauri,
  tauriWindow,
  wakeLock = globalThis.navigator?.wakeLock,
} = {}) {
  const offs = [];
  const listen = (target, type, fn, opts) => {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, opts);
    offs.push(() => target.removeEventListener(type, fn, opts));
  };
  const setting = (name, fallback) => {
    try {
      const v = settings?.get?.(name);
      return v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  };
  const unlocked = () => vault?.status === 'unlocked';
  const playing = () => {
    try {
      if (typeof isMediaPlaying === 'function' && isMediaPlaying()) return true;
    } catch {
      // ignore a broken probe
    }
    return state?.get?.('player')?.playing === true;
  };
  const busy = () => Number(state?.get?.('busy')) > 0;
  const pickerPending = () => {
    if (state?.get?.('picker.pending') === true) return true;
    try {
      return platformPickerPending() === true;
    } catch {
      return false;
    }
  };
  const root = () => doc?.documentElement ?? null;
  const isHidden = () => doc?.visibilityState === 'hidden';

  function lockNow(reason) {
    if (unlocked()) vault.lock(reason);
    else state?.purge?.(reason);
  }

  // ───────── idle

  let lastActivity = now();
  let idleDone = false;

  function activity() {
    lastActivity = now();
    idleDone = false;
  }

  function checkIdle() {
    // Cheap first (this runs on every input event): the shortest idle setting is one minute.
    if (idleDone || now() - lastActivity < MIN_IDLE_MS) return;
    if (playing() || busy()) {
      activity();
      return;
    }
    const min = Number(setting('idleLockMin', 5));
    if (!(min > 0)) return;
    if (now() - lastActivity >= min * 60_000) {
      idleDone = true;
      lockNow('idle');
    }
  }

  // ───────── hidden

  let tracking = false; // a hidden period is being measured
  let hiddenDone = false;
  let accum = 0; // counted hidden ms before `since`
  let since = null; // start of the current counted stretch (null = paused)
  let hiddenTimer = null;

  const hiddenLimit = () => HIDDEN_MS[setting('hiddenLock', '3m')] ?? HIDDEN_MS['3m'];
  const exempt = () => pickerPending() || (setting('keepAudioWhenHidden', true) === true && playing());

  /** Pauses or resumes the hidden clock for pickers and (kept) audio. */
  function syncClock() {
    if (!tracking) return;
    const t = now();
    if (exempt()) {
      if (since !== null) {
        accum += t - since;
        since = null;
      }
    } else if (since === null) {
      since = t;
    }
  }

  const hiddenElapsed = () => accum + (since === null ? 0 : now() - since);

  function checkHidden() {
    if (!tracking || hiddenDone) return;
    syncClock();
    // Paused with nothing counted (a picker or music since the page was hidden): nothing to check. Time counted
    // before a pause still is: hidden 4 min unseen by any timer, then music starts → the 3 min limit has passed.
    if (since === null && accum === 0) return;
    if (hiddenElapsed() >= hiddenLimit()) {
      hiddenDone = true;
      lockNow('hidden');
    } else {
      scheduleHidden();
    }
  }

  function scheduleHidden() {
    timers.clearTimeout?.(hiddenTimer);
    hiddenTimer = null;
    if (!tracking || hiddenDone || since === null) return;
    const wait = hiddenLimit() - hiddenElapsed();
    if (!Number.isFinite(wait)) return;
    hiddenTimer = timers.setTimeout(checkHidden, Math.max(0, wait) + 50);
    hiddenTimer?.unref?.();
  }

  function startHidden() {
    if (tracking) return;
    tracking = true;
    hiddenDone = false;
    accum = 0;
    since = null;
    syncClock();
    checkHidden();
  }

  function endHidden() {
    tracking = false;
    accum = 0;
    since = null;
    timers.clearTimeout?.(hiddenTimer);
    hiddenTimer = null;
  }

  /** visible / focus / pageshow / resume / input: lock first if a limit passed, then reset the hidden clock. */
  function onShown() {
    checkHidden();
    checkIdle();
    if (!isHidden()) endHidden();
  }

  // ───────── privacy cover

  function cover() {
    if (setting('privacyCover', true) !== true || !unlocked()) return;
    root()?.classList.add(COVER);
  }

  function uncover() {
    root()?.classList.remove(COVER);
  }

  // ───────── panic

  let escTimes = [];

  function overlayOpen() {
    const r = root();
    if (r?.classList.contains('has-overlay') || r?.classList.contains('vw-open')) return true;
    try {
      return Boolean(doc?.querySelector?.('[aria-modal="true"]'));
    } catch {
      return false;
    }
  }

  function onKeydown(e) {
    if (e?.key === 'Escape' && !e.repeat) {
      if (overlayOpen()) {
        escTimes = [];
      } else {
        const t = now();
        escTimes = escTimes.filter((x) => t - x <= PANIC_WINDOW_MS);
        escTimes.push(t);
        if (escTimes.length >= PANIC_PRESSES) {
          escTimes = [];
          lockNow('panic');
          return;
        }
      }
    }
    onInput();
  }

  function onInput() {
    onShown();
    activity();
    uncover();
  }

  // ───────── screen wake lock while jobs run

  let sentinel = null;
  let wanting = false;

  function syncWakeLock() {
    const want = busy() && !isHidden();
    if (want && !sentinel && !wanting && typeof wakeLock?.request === 'function') {
      wanting = true;
      Promise.resolve()
        .then(() => wakeLock.request('screen'))
        .then((s) => {
          wanting = false;
          if (busy() && !stopped) sentinel = s;
          else s?.release?.().catch?.(() => {});
          sentinel?.addEventListener?.('release', () => {
            if (sentinel === s) sentinel = null;
          });
        }, () => {
          wanting = false; // not allowed now (hidden, battery saver): best effort only
        });
    } else if (!busy() && sentinel) {
      const s = sentinel;
      sentinel = null;
      Promise.resolve().then(() => s.release?.()).catch(() => {});
    }
  }

  // ───────── wiring

  listen(doc, 'visibilitychange', () => {
    if (isHidden()) {
      cover();
      startHidden();
    } else {
      onShown();
      uncover();
      syncWakeLock();
    }
  });
  listen(win, 'pagehide', (e) => {
    cover();
    if (!e?.persisted) lockNow('pagehide');
  });
  listen(doc, 'freeze', () => lockNow('freeze'));
  listen(doc, 'resume', onShown);
  listen(win, 'pageshow', () => {
    onShown();
    if (!isHidden()) uncover();
  });
  listen(win, 'focus', () => {
    onShown();
    uncover();
  });
  listen(win, 'blur', cover);
  listen(win, 'keydown', onKeydown, { capture: true });
  for (const type of INPUT_EVENTS) if (type !== 'keydown') listen(win, type, onInput, { capture: true, passive: true });

  if (typeof state?.on === 'function') {
    offs.push(state.on('player', () => {
      syncClock();
      checkHidden();
      activity(); // playback starting or stopping both restart the idle clock
    }));
    offs.push(state.on('picker.pending', () => {
      syncClock();
      checkHidden();
    }));
    offs.push(state.on('busy', () => {
      activity(); // a job starting or ending restarts the idle clock
      syncWakeLock();
    }));
    offs.push(state.on('settings', () => {
      checkHidden();
      scheduleHidden();
    }));
  }
  const onStatus = (e) => {
    if (e?.detail?.status === 'unlocked') {
      activity();
      hiddenDone = false;
      checkHidden(); // unlocked while hidden (a slow unlock finished in the background): the hidden rule applies now
    }
  };
  if (vault && typeof vault.addEventListener === 'function') {
    vault.addEventListener('status', onStatus);
    offs.push(() => vault.removeEventListener?.('status', onStatus));
  }

  const tick = timers.setInterval(() => {
    checkIdle();
    checkHidden();
  }, TICK_MS);
  tick?.unref?.();
  offs.push(() => timers.clearInterval?.(tick));

  let stopped = false;
  if (isTauri) watchTauriWindow(tauriWindow, { cover, uncover, offs, alive: () => !stopped });
  if (isHidden()) startHidden();
  syncWakeLock();

  return function stop() {
    if (stopped) return;
    stopped = true;
    endHidden();
    if (sentinel) {
      const s = sentinel;
      sentinel = null;
      Promise.resolve().then(() => s.release?.()).catch(() => {});
    }
    for (const off of offs.splice(0)) {
      try {
        off();
      } catch {
        // ignore
      }
    }
    uncover();
  };
}

/** Tauri: cover when the window loses focus or is minimized (the DOM blur may not fire for minimize). */
function watchTauriWindow(given, { cover, uncover, offs, alive }) {
  let w = given;
  try {
    w ??= globalThis.__TAURI__?.window?.getCurrentWindow?.();
  } catch {
    w = null;
  }
  if (!w) return;
  const keep = (p) => {
    Promise.resolve(p)
      .then((un) => {
        if (typeof un !== 'function') return;
        if (alive()) offs.push(un);
        else un();
      })
      .catch(() => {});
  };
  try {
    if (typeof w.onFocusChanged === 'function') keep(w.onFocusChanged((ev) => (ev?.payload ? uncover() : cover())));
    if (typeof w.onResized === 'function' && typeof w.isMinimized === 'function') {
      keep(w.onResized(() => {
        Promise.resolve(w.isMinimized()).then((min) => {
          if (min) cover();
        }, () => {});
      }));
    }
  } catch {
    // no window API: the DOM events still apply
  }
}
