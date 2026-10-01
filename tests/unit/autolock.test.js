// app/vault/autolock.js (DESIGN §1.6, §11) with a fake document/window, a manual clock and fake timers: idle lock
// (input, media, jobs, live settings), hidden lock by timestamps (also when timers never fire), keep-audio and picker
// suspension, pagehide/freeze, panic Esc×3, privacy cover (DOM + Tauri window), purge without a vault, stop().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN, setup } from './autolock-helpers.js';

test('idle: locks after idleLockMin without input; input resets the clock; once per idle period', () => {
  const e = setup();
  e.timers.advance(4 * MIN);
  e.fire(e.win, 'pointerdown');
  e.timers.advance(4 * MIN);
  assert.deepEqual(e.vault.locks, []);
  e.timers.advance(1.2 * MIN);
  assert.deepEqual(e.vault.locks, ['idle']);
  e.timers.advance(30 * MIN);
  assert.deepEqual(e.vault.locks, ['idle'], 'not repeated');
  assert.deepEqual(e.purges, [], 'the vault lock purges by itself');
  e.stop();
});

test('idle: media playing and running jobs count as activity; setting read live; 0 = never', () => {
  const e = setup({ media: true });
  e.timers.advance(20 * MIN);
  assert.deepEqual(e.vault.locks, []);
  e.playing.on = false;
  e.state.set('busy', 1);
  e.timers.advance(20 * MIN);
  assert.deepEqual(e.vault.locks, []);
  e.state.set('busy', 0);
  e.conf.idleLockMin = 1;
  e.timers.advance(1.2 * MIN);
  assert.deepEqual(e.vault.locks, ['idle']);
  e.stop();
  const never = setup({ settings: { idleLockMin: 0 } });
  never.timers.advance(600 * MIN);
  assert.deepEqual(never.vault.locks, []);
  never.stop();
});

test('idle with no unlocked vault: state.purge("idle") once per idle period', () => {
  const e = setup({ status: 'locked' });
  e.timers.advance(6 * MIN);
  e.timers.advance(6 * MIN);
  assert.deepEqual(e.purges, ['idle']);
  assert.deepEqual(e.vault.locks, []);
  e.fire(e.win, 'keydown', { key: 'a' });
  e.timers.advance(6 * MIN);
  assert.deepEqual(e.purges, ['idle', 'idle']);
  e.stop();
});

test('hidden: locks after the hidden delay (timer path); immediate; never', () => {
  const e = setup();
  e.hide();
  e.timers.advance(2.9 * MIN);
  assert.deepEqual(e.vault.locks, []);
  e.timers.advance(0.2 * MIN);
  assert.deepEqual(e.vault.locks, ['hidden']);
  e.stop();
  const now = setup({ settings: { hiddenLock: 'immediate' } });
  now.hide();
  assert.deepEqual(now.vault.locks, ['hidden']);
  now.stop();
  const never = setup({ settings: { hiddenLock: 'never', idleLockMin: 0 } });
  never.hide();
  never.timers.advance(600 * MIN);
  never.show();
  assert.deepEqual(never.vault.locks, []);
  never.stop();
});

test('hidden: timestamps lock synchronously on return even when no timer ever fired (visible, pageshow, focus, input)', () => {
  for (const ret of ['visible', 'pageshow', 'focus', 'pointerdown', 'resume']) {
    const e = setup({ settings: { idleLockMin: 0 } });
    e.hide();
    e.clock.t += 4 * MIN; // frozen page: time passes, timers don't run
    let lockedDuring = null;
    e.vault.lock = (r) => {
      lockedDuring = r;
      e.vault.status = 'locked';
    };
    if (ret === 'visible') e.show();
    else if (ret === 'resume') e.fire(e.doc, 'resume');
    else e.fire(e.win, ret);
    assert.equal(lockedDuring, 'hidden', ret);
    e.stop();
  }
});

test('hidden shorter than the limit: no lock, and the clock restarts for the next hidden period', () => {
  const e = setup({ settings: { idleLockMin: 0 } });
  e.hide();
  e.clock.t += 2 * MIN;
  e.show();
  e.hide();
  e.clock.t += 2 * MIN;
  e.show();
  assert.deepEqual(e.vault.locks, []);
  e.stop();
});

test('keep music playing: hidden time does not count while media plays; the lock follows when it stops', () => {
  const e = setup({ media: true, settings: { idleLockMin: 0 } });
  e.hide();
  e.timers.advance(30 * MIN);
  assert.deepEqual(e.vault.locks, []);
  e.playing.on = false;
  e.state.set('player', { playing: false });
  e.timers.advance(2.5 * MIN);
  assert.deepEqual(e.vault.locks, []);
  e.timers.advance(0.6 * MIN);
  assert.deepEqual(e.vault.locks, ['hidden']);
  e.stop();
  const imm = setup({ media: true, settings: { idleLockMin: 0, hiddenLock: 'immediate' } });
  imm.hide();
  imm.timers.advance(10 * MIN);
  assert.deepEqual(imm.vault.locks, []);
  imm.playing.on = false;
  imm.state.set('player', { playing: false });
  assert.deepEqual(imm.vault.locks, ['hidden'], 'locks when playback stops');
  imm.stop();
  const off = setup({ media: true, settings: { idleLockMin: 0, keepAudioWhenHidden: false } });
  off.hide();
  off.timers.advance(3.1 * MIN);
  assert.deepEqual(off.vault.locks, ['hidden']);
  off.stop();
});

test('a pending picker suspends the hidden lock; the clock starts when it settles', () => {
  const e = setup({ settings: { idleLockMin: 0 } });
  e.state.set('picker.pending', true);
  e.hide();
  e.timers.advance(9 * MIN);
  e.clock.t += 1 * MIN;
  e.show();
  assert.deepEqual(e.vault.locks, [], 'returning from the picker');
  e.hide();
  e.timers.advance(5 * MIN);
  assert.deepEqual(e.vault.locks, []);
  e.state.set('picker.pending', false);
  e.timers.advance(3.1 * MIN);
  assert.deepEqual(e.vault.locks, ['hidden']);
  e.stop();
});

test('pagehide (not persisted) and freeze lock at once; a bfcache pagehide only covers', () => {
  const e = setup();
  e.fire(e.win, 'pagehide', { persisted: true });
  assert.deepEqual(e.vault.locks, []);
  assert.equal(e.covered(), true);
  e.fire(e.win, 'pagehide', { persisted: false });
  assert.deepEqual(e.vault.locks, ['pagehide']);
  e.vault.status = 'unlocked';
  e.fire(e.doc, 'freeze');
  assert.deepEqual(e.vault.locks, ['pagehide', 'freeze']);
  e.stop();
});

test('panic: Esc ×3 within 1.5 s locks (no vault → purge); slower, repeats or an open overlay do not', () => {
  const e = setup();
  const esc = (extra = {}) => e.fire(e.win, 'keydown', { key: 'Escape', ...extra });
  esc();
  e.clock.t += 800;
  esc();
  e.clock.t += 800;
  esc();
  assert.deepEqual(e.vault.locks, [], 'spread over 1.6 s');
  esc({ repeat: true });
  esc({ repeat: true });
  assert.deepEqual(e.vault.locks, [], 'auto-repeat ignored');
  e.clock.t += 2000;
  e.setModal(true);
  esc();
  esc();
  esc();
  assert.deepEqual(e.vault.locks, [], 'a modal is open');
  e.setModal(false);
  e.doc.documentElement.classList.add('vw-open');
  esc();
  esc();
  esc();
  assert.deepEqual(e.vault.locks, [], 'the viewer is open');
  e.doc.documentElement.classList.remove('vw-open');
  esc();
  esc();
  esc();
  assert.deepEqual(e.vault.locks, ['panic']);
  esc();
  esc();
  esc();
  assert.deepEqual(e.purges, ['panic'], 'no unlocked vault: purge');
  e.stop();
});

test('privacy cover: on hidden/blur/pagehide while unlocked, off on visible/focus/input; setting and lock respected', () => {
  const e = setup({ settings: { idleLockMin: 0, hiddenLock: 'never' } });
  e.hide();
  assert.equal(e.covered(), true);
  e.show();
  assert.equal(e.covered(), false);
  e.fire(e.win, 'blur');
  assert.equal(e.covered(), true);
  e.fire(e.win, 'focus');
  assert.equal(e.covered(), false);
  e.fire(e.win, 'blur');
  e.fire(e.win, 'pointerdown');
  assert.equal(e.covered(), false);
  e.conf.privacyCover = false;
  e.fire(e.win, 'blur');
  assert.equal(e.covered(), false);
  e.conf.privacyCover = true;
  e.vault.status = 'locked';
  e.fire(e.win, 'blur');
  assert.equal(e.covered(), false, 'nothing to hide while locked');
  e.stop();
});

test('Tauri: window focus loss and minimize cover; stop() unlistens', async () => {
  const handlers = {};
  const unlistened = [];
  const tw = {
    onFocusChanged: async (fn) => {
      handlers.focus = fn;
      return () => unlistened.push('focus');
    },
    onResized: async (fn) => {
      handlers.resize = fn;
      return () => unlistened.push('resize');
    },
    minimized: false,
    isMinimized: async () => tw.minimized,
  };
  const e = setup({ isTauri: true, tauriWindow: tw });
  await new Promise((r) => setTimeout(r, 0));
  handlers.focus({ payload: false });
  assert.equal(e.covered(), true);
  handlers.focus({ payload: true });
  assert.equal(e.covered(), false);
  tw.minimized = true;
  handlers.resize({});
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(e.covered(), true);
  e.stop();
  assert.deepEqual(unlistened.sort(), ['focus', 'resize']);
  assert.equal(e.covered(), false);
});

test('stop(): no more locks, timers cleared, cover removed', () => {
  const e = setup();
  e.hide();
  assert.equal(e.covered(), true);
  e.stop();
  assert.equal(e.covered(), false);
  e.timers.advance(60 * MIN);
  e.fire(e.win, 'pagehide', { persisted: false });
  for (let i = 0; i < 3; i++) e.fire(e.win, 'keydown', { key: 'Escape' });
  assert.deepEqual(e.vault.locks, []);
  assert.equal(e.timers.pending(), 0);
});

test('screen wake lock held while a job runs, released after; re-requested when shown again', async () => {
  const log = [];
  const wakeLock = {
    async request(type) {
      const s = new EventTarget();
      s.release = async () => {
        log.push('release');
        s.dispatchEvent(new Event('release'));
      };
      log.push(`request:${type}`);
      wakeLock.last = s;
      return s;
    },
  };
  const e = setup({ wakeLock });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  await flush();
  assert.deepEqual(log, []);
  e.state.set('busy', 1);
  await flush();
  assert.deepEqual(log, ['request:screen']);
  e.state.set('busy', 2);
  await flush();
  assert.deepEqual(log, ['request:screen'], 'one lock for all jobs');
  // The browser drops it when the page is hidden; it comes back when shown while still busy.
  e.hide();
  wakeLock.last.dispatchEvent(new Event('release'));
  e.show();
  await flush();
  assert.deepEqual(log, ['request:screen', 'request:screen']);
  e.state.set('busy', 0);
  await flush();
  assert.deepEqual(log, ['request:screen', 'request:screen', 'release']);
  e.stop();
});
