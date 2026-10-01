// Platform smoke tests (DESIGN §2.3, §2.6, §8): the app loads under its CSP without console errors, the service
// worker precaches with integrity, controls the page after a reload and serves the app offline, the share target
// hands files over exactly once, and a worker never survives on a *.localhost (Tauri) origin.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { run as precache } from '../../scripts/precache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** ASSETS / ASSET_VERSION as generated into sw-assets.js. */
function swAssets() {
  const sandbox = { self: {} };
  vm.runInNewContext(readFileSync(path.join(ROOT, 'sw-assets.js'), 'utf8'), sandbox);
  return sandbox.self;
}

/**
 * Lets Playwright see (route, take offline) the service worker's own network requests, for the workers created
 * while `fn` runs (Chromium; read when Playwright attaches to a new worker).
 */
async function withWorkerNetwork(fn) {
  const key = 'PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS';
  const before = process.env[key];
  process.env[key] = '1';
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
}

/** Collects console errors, page errors and CSP violations of a page. */
async function watchErrors(page) {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return errors;
}

/** A stale sw-assets.js makes every install fail its integrity check: say so instead of timing out. */
function requireFreshPrecache() {
  if (precache({ check: true }).stale) throw new Error('sw-assets.js is stale: run `node scripts/precache.mjs` first');
}

/** Registers the worker through app/pwa.js (idempotent: main.js normally did it already), reloads, waits for control. */
async function controlledReload(page) {
  requireFreshPrecache();
  await page.evaluate(async () => {
    (await import('/app/pwa.js')).registerServiceWorker();
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

test('sw-assets.js matches the staged files (run `node scripts/precache.mjs` after changing app files)', () => {
  expect(precache({ check: true }).stale).toBe(false);
});

test('app loads under its CSP without console errors or CSP violations', async ({ page }) => {
  requireFreshPrecache();
  const errors = await watchErrors(page);
  const res = await page.goto('/');
  expect(res.ok()).toBe(true);
  await expect(page).toHaveTitle('cZEROde');
  // main.js registers the worker itself.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
  expect(errors).toEqual([]);
});

test('service worker precaches with integrity, controls the page after reload and serves the app offline', ({ page, context }) => withWorkerNetwork(async () => {
  const { ASSETS, ASSET_VERSION } = swAssets();
  await watchErrors(page); // console errors of the app itself are the previous test's business
  await page.goto('/');
  await controlledReload(page);

  const caches = await page.evaluate(async () => {
    const out = {};
    for (const name of await caches.keys()) out[name] = (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname.slice(1));
    return out;
  });
  expect(Object.keys(caches)).toEqual([`czd-${ASSET_VERSION}`]);
  expect(caches[`czd-${ASSET_VERSION}`].sort()).toEqual([...ASSETS].sort());

  await context.setOffline(true);
  await page.reload();
  await expect(page).toHaveTitle('cZEROde');
  const offline = await page.evaluate(async () => {
    const config = await fetch('./app/config.js');
    const manifest = await fetch('./manifest.webmanifest');
    const missing = await fetch('./definitely-not-precached.txt').then((r) => r.status, () => 'network-error');
    return { config: config.status, fromSw: Boolean(navigator.serviceWorker.controller), manifest: (await manifest.json()).id, missing };
  });
  expect(offline).toEqual({ config: 200, fromSw: true, manifest: './', missing: 'network-error' });
  await context.setOffline(false);
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
}));

test('share target: POST → 303 #/incoming?share=<id>, files handed out exactly once', async ({ page, context, baseURL }) => {
  await page.goto('/');
  await controlledReload(page);

  // Submit like the OS share sheet does (a cross-origin navigation POST), with page scripts disabled so the
  // app that loads after the redirect can't take the files before the test does.
  const sharer = await context.newPage();
  const cdp = await context.newCDPSession(sharer);
  await sharer.setContent(`<form method="post" enctype="multipart/form-data" action="${baseURL}/share-target">
    <input type="file" name="files" multiple><button type="submit">share</button></form>`);
  await sharer.setInputFiles('input[type=file]', [
    { name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('hello from the share sheet') },
    { name: 'pic.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
  ]);
  await cdp.send('Emulation.setScriptExecutionDisabled', { value: true });
  await Promise.all([sharer.waitForURL(/#\/incoming\?share=[0-9a-f]{32}$/), sharer.click('button')]);
  const id = new URL(sharer.url()).hash.split('share=')[1];
  expect(new URL(sharer.url()).pathname).toBe('/');

  const taken = await page.evaluate(async (shareId) => {
    const { takeSharedFiles } = await import('/app/pwa.js');
    const first = await takeSharedFiles(shareId);
    const second = await takeSharedFiles(shareId);
    return {
      first: await Promise.all(first.map(async (f) => ({ name: f.name, type: f.type, size: f.size, text: f.name.endsWith('.txt') ? await f.text() : null }))),
      second: second.length,
      unknown: (await takeSharedFiles('0'.repeat(32))).length,
    };
  }, id);
  expect(taken).toEqual({
    first: [
      { name: 'hello.txt', type: 'text/plain', size: 26, text: 'hello from the share sheet' },
      { name: 'pic.png', type: 'image/png', size: 7, text: null },
    ],
    second: 0,
    unknown: 0,
  });
});

test('a service worker registered on a *.localhost origin (Tauri) removes itself', async ({ page, baseURL }) => {
  const port = new URL(baseURL).port;
  await page.goto(`http://tauri.localhost:${port}/tests/e2e/seed.html?clear=1`);
  await page.waitForFunction(() => window.__seeded);
  const before = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    return Boolean(reg);
  });
  expect(before).toBe(true);
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), { timeout: 15000 }).toBe(0);
  expect(await page.evaluate(async () => (await caches.keys()).filter((n) => n.startsWith('czd-')))).toEqual([]);
  // The app itself never registers a worker there.
  const registered = await page.evaluate(async () => {
    const { registerServiceWorker } = await import('/app/pwa.js');
    registerServiceWorker();
    await new Promise((r) => setTimeout(r, 500));
    return (await navigator.serviceWorker.getRegistrations()).length;
  });
  expect(registered).toBe(0);
});

test('precache entries are re-verified per worker lifetime: tampered cache → refetch, tampered network → 500', ({ page, context }) => withWorkerNetwork(async () => {
  const { ASSET_VERSION } = swAssets();
  const real = readFileSync(path.join(ROOT, 'app/config.js'), 'utf8');
  await page.goto('/');
  await controlledReload(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  const tamper = () => page.evaluate(async (name) => {
    const cache = await caches.open(name);
    await cache.put(new URL('./app/config.js', location.href).href, new Response('export const VERSION = "evil";', { headers: { 'Content-Type': 'text/javascript' } }));
  }, `czd-${ASSET_VERSION}`);
  const get = () => page.evaluate(async () => {
    const r = await fetch('./app/config.js');
    return { status: r.status, text: await r.text() };
  });

  await tamper();
  await cdp.send('ServiceWorker.stopAllWorkers');
  expect(await get()).toEqual({ status: 200, text: real });

  await tamper();
  await context.route('**/app/config.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export const VERSION = "evil";' }));
  await cdp.send('ServiceWorker.stopAllWorkers');
  const bad = await get();
  expect(bad.status).toBe(500);
  expect(bad.text).toContain('integrity check failed');
}));

test('legacy seed page recreates czeroode_db v2 from the web vectors', async ({ page }) => {
  const web = JSON.parse(readFileSync(path.join(ROOT, 'tests/vectors/legacy-web-vectors.json'), 'utf8'));
  const ids = (list) => new Set(list.map((v) => v.record.id)).size;
  const expected = {
    vault: ids(web.vault),
    files: ids([...web.files.single_real_constants, ...web.files.batched_reduced_constants.vectors]),
    playlists: ids([...web.playlists.real_constants, ...web.playlists.reduced_constants]),
  };
  await page.goto('/tests/e2e/seed.html');
  expect(await (await page.waitForFunction(() => window.__seeded)).jsonValue()).toEqual(expected);
  expect(await page.evaluate(async () => (await indexedDB.databases()).find((d) => d.name === 'czeroode_db')?.version)).toBe(2);
  await page.goto('/tests/e2e/seed.html?clear=1');
  expect(await (await page.waitForFunction(() => window.__seeded)).jsonValue()).toEqual({ cleared: true });
  expect(await page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === 'czeroode_db'))).toBe(false);
});
