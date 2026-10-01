// Review regressions for app/vault/autolock.js (DESIGN §1.6): hidden time counted BEFORE an exemption (music,
// picker) started still locks, and a vault that becomes unlocked while the page is hidden is held to the hidden rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN, setup } from './autolock-helpers.js';

test('hidden past the limit, then music starts (no timer ran): locks at once, also on return while it plays', () => {
  const e = setup({ settings: { idleLockMin: 0 } });
  e.hide();
  e.clock.t += 4 * MIN; // throttled background page: no timer fired
  e.playing.on = true;
  e.state.set('player', { playing: true });
  assert.deepEqual(e.vault.locks, ['hidden'], '4 min of counted hidden time exceed the 3 min limit');
  e.stop();

  const r = setup({ settings: { idleLockMin: 0 } });
  r.hide();
  r.clock.t += 4 * MIN;
  r.playing.on = true; // media.js reports playback through isMediaPlaying only (no state event)
  r.show();
  assert.deepEqual(r.vault.locks, ['hidden'], 'returning while the music plays');
  r.stop();
});

test('hidden past the limit, then a picker opens (no timer ran): locks', () => {
  const e = setup({ settings: { idleLockMin: 0 } });
  e.hide();
  e.clock.t += 4 * MIN;
  e.state.set('picker.pending', true);
  assert.deepEqual(e.vault.locks, ['hidden']);
  e.stop();
});

test('time counted before the music started adds up with time after it stopped', () => {
  const e = setup({ settings: { idleLockMin: 0 } });
  e.hide();
  e.timers.advance(2 * MIN);
  e.playing.on = true;
  e.state.set('player', { playing: true });
  e.timers.advance(30 * MIN);
  assert.deepEqual(e.vault.locks, []);
  e.playing.on = false;
  e.state.set('player', { playing: false });
  e.timers.advance(0.9 * MIN);
  assert.deepEqual(e.vault.locks, []);
  e.timers.advance(0.2 * MIN);
  assert.deepEqual(e.vault.locks, ['hidden']);
  e.stop();
});

test('a vault unlocked while the page is hidden is locked by the hidden rule without waiting for a tick', () => {
  const e = setup({ status: 'locked', settings: { idleLockMin: 0, hiddenLock: 'immediate' } });
  e.hide();
  e.vault.status = 'unlocked';
  e.vault.dispatchEvent(Object.assign(new Event('status'), { detail: { status: 'unlocked' } }));
  assert.deepEqual(e.vault.locks, ['hidden']);
  e.stop();
});
