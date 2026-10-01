// Shared harness for the autolock unit tests: a fake document/window, a manual clock, fake timers, a fake state
// store and a fake vault around startAutolock().
import { startAutolock } from '../../app/vault/autolock.js';

class ClassList {
  constructor() {
    this.s = new Set();
  }

  add(c) {
    this.s.add(c);
  }

  remove(c) {
    this.s.delete(c);
  }

  contains(c) {
    return this.s.has(c);
  }
}

export function fakeTimers(clock) {
  let next = 0;
  const tasks = new Map();
  return {
    setTimeout(fn, ms) {
      tasks.set(++next, { at: clock.t + Math.max(0, ms), fn });
      return next;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
    setInterval(fn, ms) {
      tasks.set(++next, { at: clock.t + ms, fn, every: ms });
      return next;
    },
    clearInterval(id) {
      tasks.delete(id);
    },
    /** Time passes and due timers fire in order. */
    advance(ms) {
      const end = clock.t + ms;
      for (;;) {
        let due = null;
        for (const [id, task] of tasks) if (task.at <= end && (!due || task.at < due[1].at)) due = [id, task];
        if (!due) break;
        const [id, task] = due;
        clock.t = task.at;
        if (task.every) task.at += task.every;
        else tasks.delete(id);
        task.fn();
      }
      clock.t = end;
    },
    pending: () => tasks.size,
  };
}

export function setup({ settings: over = {}, status = 'unlocked', isTauri = false, tauriWindow, media = false, wakeLock } = {}) {
  const clock = { t: 1_000_000 };
  const timers = fakeTimers(clock);
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  doc.documentElement = { classList: new ClassList() };
  let modalOpen = false;
  doc.querySelector = (sel) => (modalOpen && sel === '[aria-modal="true"]' ? {} : null);
  const win = new EventTarget();
  const values = new Map([['busy', 0]]);
  const subs = new Map();
  const purges = [];
  const state = {
    get: (k) => values.get(k),
    set(k, v) {
      values.set(k, v);
      for (const fn of subs.get(k) ?? []) fn(v);
    },
    on(k, fn) {
      if (!subs.has(k)) subs.set(k, new Set());
      subs.get(k).add(fn);
      return () => subs.get(k).delete(fn);
    },
    purge: (r) => purges.push(r),
  };
  const conf = { idleLockMin: 5, hiddenLock: '3m', keepAudioWhenHidden: true, privacyCover: true, ...over };
  const settings = { get: (n) => conf[n] };
  const vault = new EventTarget();
  vault.status = status;
  vault.locks = [];
  vault.lock = (r) => {
    vault.locks.push(r);
    vault.status = 'locked';
  };
  const playing = { on: media };
  const stop = startAutolock({ vault, settings, state, isMediaPlaying: () => playing.on, document: doc, window: win, now: () => clock.t, timers, isTauri, tauriWindow, wakeLock });
  const fire = (target, type, props = {}) => target.dispatchEvent(Object.assign(new Event(type), props));
  const hide = () => {
    doc.visibilityState = 'hidden';
    fire(doc, 'visibilitychange');
  };
  const show = () => {
    doc.visibilityState = 'visible';
    fire(doc, 'visibilitychange');
  };
  const covered = () => doc.documentElement.classList.contains('privacy-cover');
  return { clock, timers, doc, win, state, conf, vault, purges, playing, stop, fire, hide, show, covered, setModal: (b) => (modalOpen = b) };
}

export const MIN = 60_000;
