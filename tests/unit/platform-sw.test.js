// sw.js in node:vm with fake worker globals (caches, fetch, registration): fetch routing order (§2.6), share
// target hand-off (once, bounded), precache install with integrity, per-lifetime re-verification, and the
// *.localhost self-removal. The real worker in Chromium is covered by tests/e2e/smoke.spec.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers-phase0.js';

const SW = readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const SCOPE = 'https://example.test/app/';
const b64sha = (s) => createHash('sha256').update(s).digest('base64');

/** Loads sw.js into a fresh realm. `files`: asset path → network body. */
function loadWorker({ hostname = 'example.test', files = { 'index.html': '<!doctype html>', 'app/main.js': 'export {};' }, integrity, active = null } = {}) {
  const listeners = {};
  const network = new Map(Object.entries(files));
  const fetched = [];
  const cacheStore = new Map(); // cache name → Map(url → {body, type})
  const fakeCache = (name) => {
    if (!cacheStore.has(name)) cacheStore.set(name, new Map());
    const m = cacheStore.get(name);
    return {
      async match(url) {
        const e = m.get(String(url));
        return e ? new Response(e.body, { headers: { 'Content-Type': e.type } }) : undefined;
      },
      async put(url, res) {
        m.set(String(url), { body: await res.clone().text(), type: res.headers.get('Content-Type') ?? '' });
      },
      async delete(url) {
        return m.delete(String(url));
      },
      async keys() {
        return [...m.keys()].map((u) => ({ url: u }));
      },
    };
  };
  const state = { claimed: 0, skipped: 0, unregistered: 0, imported: [] };
  const self = {
    location: { hostname },
    registration: { scope: SCOPE, active, unregister: async () => (state.unregistered++, true) },
    clients: { claim: async () => state.claimed++ },
    skipWaiting: async () => state.skipped++,
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
  };
  const sandbox = {
    self,
    caches: {
      open: async (name) => fakeCache(name),
      keys: async () => [...cacheStore.keys()],
      delete: async (name) => cacheStore.delete(name),
    },
    async fetch(req) {
      fetched.push({ url: req.url, cache: req.cache });
      const rel = req.url.startsWith(SCOPE) ? req.url.slice(SCOPE.length) : null;
      if (rel === null || !network.has(rel)) return new Response('nope', { status: 404 });
      return new Response(network.get(rel), { headers: { 'Content-Type': rel.endsWith('.html') ? 'text/html' : 'text/javascript' } });
    },
    importScripts(...urls) {
      state.imported.push(...urls);
      self.ASSETS = Object.keys(files).sort();
      self.INTEGRITY = integrity ?? Object.fromEntries(Object.entries(files).map(([k, v]) => [k, b64sha(v)]));
      self.ASSET_VERSION = 'abcdef012345';
      self.czStream = { handle: (event) => new Response(`stream ${new URL(event.request.url).pathname}`, { status: 206 }) };
    },
    URL,
    Request,
    Response,
    File,
    Blob,
    btoa,
    crypto: globalThis.crypto,
    Date,
    Map,
    Set,
    Promise,
    Array,
    String,
    Error,
    console,
    decodeURIComponent,
  };
  vm.runInNewContext(SW, sandbox, { filename: 'sw.js' });

  async function dispatch(type, init = {}) {
    let responded;
    const waits = [];
    const event = {
      ...init,
      respondWith(p) {
        responded = Promise.resolve(p);
      },
      waitUntil(p) {
        waits.push(Promise.resolve(p));
      },
    };
    for (const fn of listeners[type] ?? []) fn(event);
    await Promise.all(waits);
    return responded ? await responded : undefined;
  }
  const req = (rel, { method = 'GET', mode = 'cors', formData } = {}) => ({ url: new URL(rel, SCOPE).href, method, mode, formData });
  return { self, state, listeners, network, fetched, cacheStore, dispatch, req };
}

/** A share-target POST carrying `names` as files. */
function sharePost(w, names) {
  return w.req('share-target', {
    method: 'POST',
    mode: 'navigate',
    formData: async () => ({ getAll: (k) => (k === 'files' ? names.map((n) => new File([n], n)) : []) }),
  });
}

async function shareGet(w, id) {
  let reply;
  const port = { postMessage: (m) => (reply = m) };
  await w.dispatch('message', { data: { cmd: 'share-get', id }, ports: [port] });
  return reply;
}

test('*.localhost (Tauri): never imports the app scripts; installs, then deletes its caches and unregisters', async () => {
  const w = loadWorker({ hostname: 'tauri.localhost' });
  assert.deepEqual(w.state.imported, []);
  assert.equal(w.listeners.fetch, undefined, 'no fetch handler');
  w.cacheStore.set('czd-old', new Map());
  w.cacheStore.set('other', new Map());
  await w.dispatch('install');
  assert.equal(w.state.skipped, 1);
  await w.dispatch('activate');
  assert.deepEqual([...w.cacheStore.keys()], ['other']);
  assert.equal(w.state.unregistered, 1);
});

test('install precaches every asset with cache:reload and its integrity; first install claims, an update does not', async () => {
  const w = loadWorker();
  assert.deepEqual(w.state.imported, ['./sw-assets.js', './sw-stream.js']);
  await w.dispatch('install');
  assert.deepEqual(w.fetched.map((f) => [f.url.slice(SCOPE.length), f.cache]).sort(), [['app/main.js', 'reload'], ['index.html', 'reload']]);
  assert.deepEqual([...w.cacheStore.get('czd-abcdef012345').keys()].sort(), [`${SCOPE}app/main.js`, `${SCOPE}index.html`]);
  w.cacheStore.set('czd-old', new Map());
  await w.dispatch('activate');
  assert.deepEqual([...w.cacheStore.keys()], ['czd-abcdef012345'], 'older czd-* caches deleted');
  assert.equal(w.state.claimed, 1);

  const upd = loadWorker({ active: { state: 'activated' } });
  await upd.dispatch('install');
  await upd.dispatch('activate');
  assert.equal(upd.state.claimed, 0, 'an update never claims pages running older code');
});

test('install fails when a fetched asset does not match INTEGRITY', async () => {
  const w = loadWorker({ integrity: { 'index.html': b64sha('<!doctype html>'), 'app/main.js': b64sha('something else') } });
  await assert.rejects(w.dispatch('install'), /integrity mismatch for app\/main\.js/);
});

test('fetch routing: share POST, czstream, app navigations, precached GETs, everything else untouched', async () => {
  const w = loadWorker();
  await w.dispatch('install');
  // (2) czstream → sw-stream.js
  const s = await w.dispatch('fetch', { request: w.req('czstream/TOKEN?download=1') });
  assert.equal(s.status, 206);
  assert.equal(await s.text(), 'stream /app/czstream/TOKEN');
  // (3) navigations to the app → precached index.html (even offline)
  w.network.clear();
  for (const rel of ['', 'index.html', '?x=1#/vault']) {
    const nav = await w.dispatch('fetch', { request: w.req(rel, { mode: 'navigate' }) });
    assert.equal(await nav.text(), '<!doctype html>', `navigation to "${rel}"`);
  }
  // (4) precached GET
  assert.equal(await (await w.dispatch('fetch', { request: w.req('app/main.js') })).text(), 'export {};');
  // (5) not intercepted: other paths, other methods, outside the scope, other origins, other pages' navigations
  for (const r of [w.req('tests/browser/index.html', { mode: 'navigate' }), w.req('app/unknown.js'), w.req('app/main.js', { method: 'HEAD' }),
    w.req('other', { method: 'POST' }), { url: 'https://example.test/elsewhere/app/main.js', method: 'GET', mode: 'cors' },
    { url: 'https://evil.test/app/main.js', method: 'GET', mode: 'cors' }]) {
    assert.equal(await w.dispatch('fetch', { request: r }), undefined, r.url);
  }
});

test('precached entries are re-verified once per worker lifetime: tampered cache → refetch; bad network → 500', async () => {
  const w = loadWorker();
  await w.dispatch('install');
  const fresh = loadWorker(); // a restarted worker: same caches, nothing verified yet
  fresh.cacheStore.set('czd-abcdef012345', w.cacheStore.get('czd-abcdef012345'));
  fresh.cacheStore.get('czd-abcdef012345').set(`${SCOPE}app/main.js`, { body: 'evil()', type: 'text/javascript' });
  const ok = await fresh.dispatch('fetch', { request: fresh.req('app/main.js') });
  assert.equal(await ok.text(), 'export {};', 'tampered cache entry replaced from the network');
  assert.equal(fresh.cacheStore.get('czd-abcdef012345').get(`${SCOPE}app/main.js`).body, 'export {};');

  const third = loadWorker();
  third.cacheStore.set('czd-abcdef012345', new Map([[`${SCOPE}app/main.js`, { body: 'evil()', type: 'text/javascript' }]]));
  third.network.set('app/main.js', 'evil()');
  const bad = await third.dispatch('fetch', { request: third.req('app/main.js') });
  assert.equal(bad.status, 500);
  assert.match(await bad.text(), /integrity check failed/);
});

test('share target: 303 to #/incoming?share=<id>; files handed out once; no files → plain #/incoming', async () => {
  const w = loadWorker();
  const res = await w.dispatch('fetch', { request: sharePost(w, ['a.txt', 'b.png']) });
  assert.equal(res.status, 303);
  const loc = res.headers.get('Location');
  assert.match(loc, new RegExp(`^${SCOPE.replace(/[.]/g, '\\.')}#/incoming\\?share=[0-9a-f]{32}$`));
  const id = loc.split('share=')[1];
  const first = await shareGet(w, id);
  assert.equal(first.ok, true);
  assert.deepEqual(first.files.map((f) => f.name), ['a.txt', 'b.png']);
  const again = await shareGet(w, id); // a vm-realm object: compare fields
  assert.equal(again.ok, false, 'single use');
  assert.equal(again.files.length, 0);
  const empty = await w.dispatch('fetch', { request: sharePost(w, []) });
  assert.equal(empty.headers.get('Location'), `${SCOPE}#/incoming`);
});

test('share target keeps at most 16 unclaimed shares (oldest dropped)', async () => {
  const w = loadWorker();
  const ids = [];
  for (let i = 0; i < 20; i++) {
    const res = await w.dispatch('fetch', { request: sharePost(w, [`f${i}.txt`]) });
    ids.push(res.headers.get('Location').split('share=')[1]);
  }
  for (let i = 0; i < 4; i++) assert.equal((await shareGet(w, ids[i])).ok, false, `share ${i} dropped`);
  for (let i = 4; i < 20; i++) assert.deepEqual((await shareGet(w, ids[i])).files.map((f) => f.name), [`f${i}.txt`]);
});

test('SKIP_WAITING message (object or string form) calls skipWaiting', async () => {
  const w = loadWorker();
  await w.dispatch('message', { data: { cmd: 'SKIP_WAITING' } });
  await w.dispatch('message', { data: 'SKIP_WAITING' });
  await w.dispatch('message', { data: { cmd: 'unknown' } });
  assert.equal(w.state.skipped, 2);
});
