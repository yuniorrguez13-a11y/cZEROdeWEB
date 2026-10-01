// app/state.js: get/set/on (+ '*'), listener isolation, busy counter and purge semantics
// (handlers isolated, SW lock message, BroadcastChannel 'czd-lock', no re-broadcast for 'remote').
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as state from '../../app/state.js';

test('initial values', () => {
  assert.equal(state.get('busy'), 0);
  assert.equal(state.get('sw.updateReady'), false);
  assert.equal(state.get('vault.status'), undefined);
});

test('set/get and listeners (key and *), with old values', () => {
  const seen = [];
  const all = [];
  const off = state.on('t.a', (v, info) => seen.push([v, info.key, info.old]));
  const offAll = state.on('*', (v, info) => all.push(info.key));
  state.set('t.a', 1);
  state.set('t.a', 1); // unchanged → no notification
  state.set('t.a', 2);
  state.set('t.b', 'x');
  off();
  state.set('t.a', 3);
  offAll();
  state.set('t.b', 'y');
  assert.deepEqual(seen, [[1, 't.a', undefined], [2, 't.a', 1]]);
  assert.deepEqual(all, ['t.a', 't.a', 't.b', 't.a']);
  assert.equal(state.get('t.a'), 3);
  assert.equal(state.get('t.b'), 'y');
});

test('objects always notify (new identity), same object does not', () => {
  let n = 0;
  const off = state.on('t.obj', () => n++);
  const o = { a: 1 };
  state.set('t.obj', o);
  state.set('t.obj', o);
  state.set('t.obj', { a: 1 });
  off();
  assert.equal(n, 2);
});

test('a throwing listener does not stop the others or the setter', (t) => {
  t.mock.method(console, 'error', () => {});
  const got = [];
  const off1 = state.on('t.err', () => {
    throw new Error('boom');
  });
  const off2 = state.on('t.err', (v) => got.push(v));
  assert.doesNotThrow(() => state.set('t.err', 1));
  assert.deepEqual(got, [1]);
  off1();
  off2();
});

test('on() requires a function', () => {
  assert.throws(() => state.on('x', null), TypeError);
  assert.throws(() => state.onPurge('nope'), TypeError);
});

test('busy(delta) never goes below 0 and notifies', () => {
  const seen = [];
  const off = state.on('busy', (v) => seen.push(v));
  assert.equal(state.busy(1), 1);
  assert.equal(state.busy(2), 3);
  assert.equal(state.busy(-5), 0);
  assert.equal(state.busy(-1), 0);
  off();
  assert.deepEqual(seen, [1, 3, 0]);
});

test('purge runs every handler in order with the reason; errors and rejections are isolated', async (t) => {
  t.mock.method(console, 'error', () => {});
  const calls = [];
  const offs = [
    state.onPurge((r) => calls.push(['a', r])),
    state.onPurge(() => {
      throw new Error('bad handler');
    }),
    state.onPurge(async () => {
      calls.push(['async']);
      throw new Error('async bad');
    }),
    state.onPurge((r) => calls.push(['b', r])),
  ];
  assert.doesNotThrow(() => state.purge('idle'));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, [['a', 'idle'], ['async'], ['b', 'idle']]);
  offs.forEach((off) => off());
  calls.length = 0;
  state.purge('user');
  assert.deepEqual(calls, []);
});

test('purge posts {cmd:"lock"} to the SW controller and broadcasts on czd-lock (not for "remote")', async () => {
  const swMsgs = [];
  const bcMsgs = [];
  const origNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { serviceWorker: { controller: { postMessage: (m) => swMsgs.push(m) } } },
  });
  const listener = new BroadcastChannel('czd-lock');
  listener.onmessage = (e) => bcMsgs.push(e.data);
  try {
    state.purge('user');
    state.purge('remote');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(swMsgs, [{ cmd: 'lock' }, { cmd: 'lock' }]);
    assert.deepEqual(bcMsgs, [{ cmd: 'lock', reason: 'user', from: state.TAB_ID }]);
  } finally {
    listener.close();
    if (origNav) Object.defineProperty(globalThis, 'navigator', origNav);
  }
});

test('passive purges (idle/hidden/pagehide/freeze) stay in this tab: a client-scoped SW lock, no broadcast', async () => {
  const swMsgs = [];
  const bcMsgs = [];
  const origNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { serviceWorker: { controller: { postMessage: (m) => swMsgs.push(m) } } },
  });
  const listener = new BroadcastChannel('czd-lock');
  listener.onmessage = (e) => bcMsgs.push(e.data);
  let ran = 0;
  const off = state.onPurge(() => ran++);
  try {
    for (const r of ['idle', 'hidden', 'pagehide', 'freeze']) {
      assert.equal(state.isPassive(r), true, r);
      state.purge(r);
    }
    for (const r of ['user', 'panic', 'remote', 'destroy', 'closed']) assert.equal(state.isPassive(r), false, r);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ran, 4, 'handlers still run (this tab clears its own secrets)');
    assert.deepEqual(swMsgs, Array(4).fill({ cmd: 'lock', scope: 'client' }));
    assert.deepEqual(bcMsgs, [], 'nothing reaches other tabs');
    state.purge('panic');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(swMsgs.at(-1), { cmd: 'lock' }, 'a deliberate lock clears every page');
    assert.deepEqual(bcMsgs, [{ cmd: 'lock', reason: 'panic', from: state.TAB_ID }]);
  } finally {
    off();
    listener.close();
    if (origNav) Object.defineProperty(globalThis, 'navigator', origNav);
  }
});

test('purge survives a throwing SW controller', (t) => {
  t.mock.method(console, 'error', () => {});
  const origNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { serviceWorker: { controller: { postMessage: () => { throw new Error('dead'); } } } },
  });
  try {
    let ran = false;
    const off = state.onPurge(() => {
      ran = true;
    });
    assert.doesNotThrow(() => state.purge('hidden'));
    assert.ok(ran);
    off();
  } finally {
    if (origNav) Object.defineProperty(globalThis, 'navigator', origNav);
  }
});

// ───────── review regressions (C1 adversarial review)

test('czd-lock: the broadcast carries this tab id; onRemoteLock hears other tabs only', async () => {
  assert.equal(typeof state.TAB_ID, 'string');
  assert.ok(state.TAB_ID.length >= 8);
  const sameTab = new BroadcastChannel('czd-lock'); // e.g. another module of THIS tab listening on its own channel
  const seen = [];
  sameTab.onmessage = (e) => seen.push(e.data);
  const remote = [];
  const off = state.onRemoteLock((reason) => remote.push(reason));
  const otherTab = new BroadcastChannel('czd-lock');
  try {
    state.purge('user'); // (a passive reason isn't broadcast at all)
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(seen, [{ cmd: 'lock', reason: 'user', from: state.TAB_ID }], 'own tab id lets listeners ignore the echo');
    assert.deepEqual(remote, [], 'onRemoteLock never fires for this tab’s own purge');
    otherTab.postMessage({ cmd: 'lock', reason: 'user', from: 'some-other-tab' });
    otherTab.postMessage({ cmd: 'nope' });
    otherTab.postMessage({ cmd: 'lock', reason: 'user', from: state.TAB_ID }); // replayed echo of our own id
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(remote, ['user']);
    off();
    otherTab.postMessage({ cmd: 'lock', reason: 'panic', from: 'x' });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(remote, ['user'], 'off() unsubscribes');
  } finally {
    sameTab.close();
    otherTab.close();
  }
});

test('purge is not re-entrant: a handler that locks again does not recurse or re-broadcast', async () => {
  const seen = [];
  const listener = new BroadcastChannel('czd-lock');
  listener.onmessage = (e) => seen.push(e.data.reason);
  let runs = 0;
  const off = state.onPurge((reason) => {
    runs++;
    if (runs < 50) state.purge(`${reason}-again`); // e.g. a handler calling vault.lock() → state.purge()
  });
  try {
    assert.doesNotThrow(() => state.purge('user'));
    assert.equal(runs, 1, 'handlers ran once');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(seen, ['user'], 'one broadcast');
    state.purge('idle');
    assert.equal(runs, 2, 'a later purge runs again');
  } finally {
    off();
    listener.close();
  }
});
