// cZEROde service worker (classic script; DESIGN §2.6). Web only: the desktop app never registers it.
//   install   fetch every precached asset with {cache:'reload'}, check its SHA-256 against INTEGRITY, store it
//             in the cache 'czd-<ASSET_VERSION>'; any failure aborts the install (the old worker stays).
//   activate  delete other 'czd-*' caches; clients.claim() only on the very first install (updates are
//             user-confirmed through SKIP_WAITING, see app/pwa.js).
//   fetch     (1) POST ./share-target → files kept in memory under a random id (5 min), 303 → ./#/incoming?share=<id>
//             (2) ./czstream/*        → self.czStream.handle(event) (sw-stream.js, §5.2), 404 when it is missing
//             (3) navigations to the app (./ or ./index.html) → precached index.html
//             (4) precached GETs      → cache, each entry re-verified once per worker lifetime
//             (5) anything else       → network (not intercepted)
//   message   {cmd:'share-get', id} → reply {ok, files} on the port (once), {cmd:'SKIP_WAITING'} → skipWaiting().
//             Streaming messages {cmd:'register'|'unregister'|'lock'} → self.czStream.onMessage(event) (sw-stream.js).
'use strict';

// Under Tauri the app is served from *.localhost (Windows: https://tauri.localhost). A worker must never
// run there: if one was ever registered, it removes itself and its caches.
if (/\.localhost$/i.test(self.location.hostname)) {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
      for (const name of await caches.keys()) if (name.startsWith('czd-')) await caches.delete(name);
      await self.registration.unregister();
    })());
  });
} else {
  importScripts('./sw-assets.js', './sw-stream.js');
  czdWorker();
}

function czdWorker() {
  const CACHE = `czd-${self.ASSET_VERSION}`;
  const SCOPE = new URL(self.registration.scope);
  const ASSET_SET = new Set(self.ASSETS);
  const SHARE_TTL_MS = 5 * 60 * 1000;
  /** Unclaimed shares kept at most (oldest dropped): any page can POST to ./share-target. */
  const MAX_SHARES = 16;
  const FETCH_PARALLEL = 6;

  /** Share-target payloads: id → {files: File[], expires}. Memory only (never Cache Storage or IDB). */
  const shares = new Map();
  /** Precached paths whose cached bytes were verified during this worker's lifetime. */
  const verified = new Set();
  /** Set by install when no worker was active before (first install) and read by activate. */
  let claimOnActivate = false;

  /** Repo-relative asset path for a same-origin URL inside the scope, else null. */
  function assetPath(url) {
    if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return null;
    let rel;
    try {
      rel = decodeURIComponent(url.pathname.slice(SCOPE.pathname.length));
    } catch {
      return null;
    }
    return rel;
  }

  const assetUrl = (path) => new URL(path, SCOPE).href;

  function b64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  async function digestB64(buf) {
    return b64(await crypto.subtle.digest('SHA-256', buf));
  }

  /** Fetches one asset from the network (bypassing the HTTP cache), checks it and returns a clean Response. */
  async function fetchVerified(path) {
    const res = await fetch(new Request(assetUrl(path), { cache: 'reload', credentials: 'same-origin', redirect: 'error' }));
    if (!res.ok) throw new Error(`precache: HTTP ${res.status} for ${path}`);
    const buf = await res.arrayBuffer();
    if ((await digestB64(buf)) !== self.INTEGRITY[path]) throw new Error(`precache: integrity mismatch for ${path}`);
    const type = res.headers.get('Content-Type');
    return new Response(buf, { status: 200, headers: type ? { 'Content-Type': type } : {} });
  }

  async function precacheAll() {
    const cache = await caches.open(CACHE);
    const queue = [...self.ASSETS];
    const worker = async () => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        const res = await fetchVerified(path);
        await cache.put(assetUrl(path), res);
        verified.add(path);
      }
    };
    await Promise.all(Array.from({ length: Math.min(FETCH_PARALLEL, queue.length) }, worker));
  }

  self.addEventListener('install', (event) => {
    claimOnActivate = !self.registration.active;
    event.waitUntil(precacheAll());
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('czd-') && name !== CACHE) await caches.delete(name);
      }
      if (claimOnActivate) await self.clients.claim();
    })());
  });

  function integrityFailure(path) {
    return new Response(`integrity check failed: ${path}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  /** Serves a precached asset; the cached copy is re-verified once per worker lifetime. */
  async function servePrecached(path) {
    const cache = await caches.open(CACHE);
    const url = assetUrl(path);
    const cached = await cache.match(url);
    if (cached) {
      if (verified.has(path)) return cached;
      if ((await digestB64(await cached.clone().arrayBuffer())) === self.INTEGRITY[path]) {
        verified.add(path);
        return cached;
      }
      await cache.delete(url);
    }
    try {
      const fresh = await fetchVerified(path);
      await cache.put(url, fresh.clone());
      verified.add(path);
      return fresh;
    } catch {
      return integrityFailure(path);
    }
  }

  function sweepShares(now = Date.now()) {
    for (const [id, entry] of shares) if (entry.expires <= now) shares.delete(id);
  }

  function randomId() {
    const b = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  async function receiveShare(request) {
    sweepShares();
    let files = [];
    try {
      const form = await request.formData();
      files = form.getAll('files').filter((f) => typeof File === 'function' && f instanceof File);
    } catch {
      files = [];
    }
    let target = './#/incoming';
    if (files.length) {
      const id = randomId();
      while (shares.size >= MAX_SHARES) shares.delete(shares.keys().next().value);
      shares.set(id, { files, expires: Date.now() + SHARE_TTL_MS });
      target = `./#/incoming?share=${id}`;
    }
    return Response.redirect(new URL(target, SCOPE).href, 303);
  }

  self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);
    const path = assetPath(url);
    if (path === null) return; // other origins or outside the scope: network

    if (request.method === 'POST') {
      if (path === 'share-target') event.respondWith(receiveShare(request));
      return;
    }
    if (path.startsWith('czstream/')) {
      const stream = self.czStream;
      event.respondWith(
        stream && typeof stream.handle === 'function'
          ? Promise.resolve().then(() => stream.handle(event))
          : new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } }),
      );
      return;
    }
    if (request.method !== 'GET') return;
    if (request.mode === 'navigate' && (path === '' || path === 'index.html')) {
      event.respondWith(servePrecached('index.html'));
      return;
    }
    if (ASSET_SET.has(path)) event.respondWith(servePrecached(path));
  });

  self.addEventListener('message', (event) => {
    const data = event.data;
    const cmd = typeof data === 'string' ? data : data && data.cmd;
    if (cmd === 'SKIP_WAITING') {
      event.waitUntil(self.skipWaiting());
      return;
    }
    if (cmd === 'register' || cmd === 'unregister' || cmd === 'lock') {
      const stream = self.czStream;
      if (stream && typeof stream.onMessage === 'function') stream.onMessage(event);
      return;
    }
    if (cmd === 'share-get') {
      sweepShares();
      const id = String(data.id || '');
      const entry = shares.get(id);
      shares.delete(id);
      const reply = entry ? { ok: true, files: entry.files } : { ok: false, files: [] };
      const port = event.ports && event.ports[0];
      if (port) port.postMessage(reply);
      else if (event.source) event.source.postMessage({ cmd: 'share-files', id, ...reply });
    }
  });
}
