// app/pwa.js in Node with faked browser globals: registration gating, install prompt, update flow (waits for a
// locked vault and busy 0 before SKIP_WAITING), share-target hand-off, launchQueue routing, iOS/standalone checks.
// The real service worker is exercised in tests/e2e/smoke.spec.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as state from '../../app/state.js';

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

class FakeTarget {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

// Browser-ish globals before pwa.js is imported (it reads them lazily, but registration happens once).
const win = new FakeTarget();
const sw = new FakeTarget();
const registrations = [];
const waitingMessages = [];
const waiting = { postMessage: (m) => waitingMessages.push(m) };
let updateChecks = 0;
const reg = Object.assign(new FakeTarget(), { waiting: null, installing: null, update: async () => updateChecks++ });
const doc = Object.assign(new FakeTarget(), { visibilityState: 'visible' });
sw.controller = { postMessage: () => {} };
sw.register = async (url, opts) => {
  registrations.push([url, opts]);
  return reg;
};
sw.getRegistration = async () => reg;
sw.ready = Promise.resolve(reg);
let reloads = 0;
let consumer = null;
setGlobal('window', win);
setGlobal('isSecureContext', true);
setGlobal('location', { hostname: '127.0.0.1', hash: '', href: 'http://127.0.0.1/', reload: () => reloads++ });
setGlobal('navigator', { serviceWorker: sw, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux x86_64', maxTouchPoints: 0 });
setGlobal('launchQueue', { setConsumer: (fn) => (consumer = fn) });
setGlobal('matchMedia', () => ({ matches: false }));
setGlobal('document', doc);

const pwa = await import('../../app/pwa.js');
const tick = () => new Promise((r) => setTimeout(r, 0));

test('registerServiceWorker registers ./sw.js once with scope ./ and updateViaCache none', async () => {
  pwa.registerServiceWorker();
  pwa.registerServiceWorker();
  await tick();
  assert.deepEqual(registrations, [['./sw.js', { scope: './', updateViaCache: 'none' }]]);
});

test('beforeinstallprompt is captured into install.prompt; promptInstall uses it once', async () => {
  let prevented = false;
  let prompted = 0;
  const event = { preventDefault: () => (prevented = true), prompt: async () => prompted++, userChoice: Promise.resolve({ outcome: 'accepted' }) };
  win.dispatch('beforeinstallprompt', event);
  assert.equal(prevented, true);
  assert.equal(state.get('install.prompt'), event);
  assert.equal(await pwa.promptInstall(), true);
  assert.equal(prompted, 1);
  assert.equal(state.get('install.prompt'), null);
  assert.equal(await pwa.promptInstall(), false, 'no prompt left');
  win.dispatch('beforeinstallprompt', { ...event, preventDefault() {} });
  win.dispatch('appinstalled');
  assert.equal(state.get('install.prompt'), null);
});

test('an installed update sets sw.updateReady', async () => {
  const incoming = Object.assign(new FakeTarget(), { state: 'installing' });
  reg.installing = incoming;
  reg.dispatch('updatefound');
  reg.waiting = waiting;
  incoming.state = 'installed';
  incoming.dispatch('statechange');
  assert.equal(state.get('sw.updateReady'), true);
});

test('applyUpdate waits until the vault is not unlocked and busy is 0, then posts SKIP_WAITING; controllerchange reloads', async () => {
  state.set('vault.status', 'unlocked');
  state.set('busy', 1);
  let resolved = false;
  const p = pwa.applyUpdate().then((v) => (resolved = v));
  await tick();
  assert.equal(resolved, false);
  assert.deepEqual(waitingMessages, []);
  state.set('vault.status', 'locked');
  await tick();
  assert.deepEqual(waitingMessages, [], 'still busy');
  state.set('busy', 0);
  await p;
  assert.equal(resolved, true);
  assert.deepEqual(waitingMessages, [{ cmd: 'SKIP_WAITING' }]);
  sw.dispatch('controllerchange');
  await tick();
  assert.equal(reloads, 1);
});

test('a controllerchange caused by another tab reloads only once nothing would be lost', async () => {
  state.set('vault.status', 'unlocked');
  sw.dispatch('controllerchange');
  sw.dispatch('controllerchange');
  await tick();
  assert.equal(reloads, 1);
  state.set('vault.status', 'locked');
  await tick();
  assert.equal(reloads, 2, 'one reload for both events');
});

test('applyUpdate without a waiting worker resolves false', async () => {
  reg.waiting = null;
  assert.equal(await pwa.applyUpdate(), false);
});

test('takeSharedFiles asks the controller over a MessageChannel and keeps only Files', async () => {
  // Node clones File as Blob; browsers keep File. Pass messages by reference here.
  const RealChannel = globalThis.MessageChannel;
  setGlobal('MessageChannel', class {
    constructor() {
      this.port1 = { onmessage: null, close() {} };
      const p1 = this.port1;
      this.port2 = { postMessage: (data) => setTimeout(() => p1.onmessage?.({ data }), 0) };
    }
  });
  const asked = [];
  sw.controller = {
    postMessage(msg, [port]) {
      asked.push(msg);
      port.postMessage(msg.id === 'abc' ? { ok: true, files: [new File(['hi'], 'hi.txt'), 'not a file'] } : { ok: false, files: [] });
    },
  };
  const files = await pwa.takeSharedFiles('abc');
  assert.deepEqual(files.map((f) => f.name), ['hi.txt']);
  assert.deepEqual(await pwa.takeSharedFiles('nope'), []);
  assert.deepEqual(asked, [{ cmd: 'share-get', id: 'abc' }, { cmd: 'share-get', id: 'nope' }]);
  assert.deepEqual(await pwa.takeSharedFiles(''), []);
  setGlobal('MessageChannel', RealChannel);
});

test('files from launchQueue land in incoming.files and the route moves to #/incoming', async () => {
  assert.equal(typeof consumer, 'function');
  await consumer({ files: [{ kind: 'file', getFile: async () => new File(['x'], 'sent.czd') }] });
  await tick();
  assert.deepEqual(state.get('incoming.files').map((f) => f.name), ['sent.czd']);
  assert.equal(globalThis.location.hash, '#/incoming');
});

test('isIOS: iPhone/iPad user agents and iPadOS desktop mode', () => {
  assert.equal(pwa.isIOS(), false);
  setGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5, serviceWorker: sw });
  assert.equal(pwa.isIOS(), true);
  setGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5, serviceWorker: sw });
  assert.equal(pwa.isIOS(), true);
  setGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0, serviceWorker: sw });
  assert.equal(pwa.isIOS(), false);
});

test('isStandalone: display-mode standalone or navigator.standalone', () => {
  assert.equal(pwa.isStandalone(), false);
  setGlobal('matchMedia', (q) => ({ matches: q === '(display-mode: standalone)' }));
  assert.equal(pwa.isStandalone(), true);
  setGlobal('matchMedia', () => ({ matches: false }));
  setGlobal('navigator', { standalone: true, serviceWorker: sw });
  assert.equal(pwa.isStandalone(), true);
});

test('returning to the app checks for an update at most every 10 minutes', async () => {
  const realNow = Date.now;
  try {
    const before = updateChecks;
    doc.dispatch('visibilitychange');
    doc.dispatch('visibilitychange');
    assert.equal(updateChecks, before, 'registration just happened: no extra request for sw.js');
    const t0 = realNow();
    Date.now = () => t0 + 11 * 60 * 1000;
    doc.dispatch('visibilitychange');
    doc.dispatch('visibilitychange');
    assert.equal(updateChecks, before + 1, 'one check after the gap, not one per event');
    doc.visibilityState = 'hidden';
    Date.now = () => t0 + 30 * 60 * 1000;
    doc.dispatch('visibilitychange');
    assert.equal(updateChecks, before + 1, 'hiding never checks');
  } finally {
    Date.now = realNow;
    doc.visibilityState = 'visible';
  }
});
