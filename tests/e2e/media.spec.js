// Media e2e (DESIGN §5, §8): a czd2 container built in the page from tests/fixtures/clip.webm plays through the
// service worker (sw-stream.js), keeps playing and seeking after CDP ServiceWorker.stopAllWorkers (the 'need'
// handshake re-registers the token), and downloads through a single-use SW download (plain <a href>, byte-compared).
// The viewer's keyboard and Back behaviour and the player's queue advance run in the real app shell.
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as precache } from '../../scripts/precache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** Page errors and CSP violations (other modules may still log their phase-2 stubs as warnings). */
async function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return errors;
}

/** The app page, controlled by the service worker. */
async function controlledApp(page) {
  if (precache({ check: true }).stale) throw new Error('sw-assets.js is stale: run `node scripts/precache.mjs` first');
  await page.goto('/');
  await page.evaluate(async () => {
    (await import('/app/pwa.js')).registerServiceWorker();
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

/** Encrypts a fixture into a czd2 container Blob in the page; window[varName] = container DecryptSource. */
async function sealFixture(page, name, type, varName = '__src') {
  await page.evaluate(async ({ name, type, varName }) => {
    const C = await import('/app/crypto/container.js');
    const { blobSource } = await import('/app/util/stream.js');
    const bytes = new Uint8Array(await (await fetch(`/tests/fixtures/${name}`)).arrayBuffer());
    window.__pk ??= await C.makePassKek('pw', { m: 64, t: 1, p: 1 });
    const parts = [];
    for await (const p of C.encryptStream(bytes, { size: bytes.length, meta: { name, type }, chunkExp: 14, stanzasFor: async (fk) => [await C.passStanza(fk, window.__pk)] })) parts.push(p);
    const src = blobSource(new Blob(parts));
    window[varName] = { kind: 'container', src, opened: await C.openSource(src, { passphrase: 'pw' }) };
  }, { name, type, varName });
}

async function seekTo(page, t) {
  return page.evaluate((target) => new Promise((resolve, reject) => {
    const v = window.__v;
    const timer = setTimeout(() => reject(new Error(`seek to ${target} timed out (readyState ${v.readyState}, error ${v.error?.code})`)), 15000);
    v.addEventListener('seeked', () => {
      clearTimeout(timer);
      resolve(v.currentTime);
    }, { once: true });
    v.currentTime = target;
  }), t);
}

test('SW streaming: video plays and seeks, then keeps playing and seeking after the worker is stopped', async ({ page, context }) => {
  const errors = await watchErrors(page);
  await controlledApp(page);
  await sealFixture(page, 'clip.webm', 'video/webm');
  const info = await page.evaluate(async () => {
    const media = await import('/app/media/media.js');
    window.__needs = [];
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.cmd === 'need') window.__needs.push(e.data.token);
    });
    const h = await media.playableUrl(window.__src, { mode: 'video' });
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'metadata';
    document.body.append(v);
    window.__v = v;
    await new Promise((resolve, reject) => {
      v.onloadedmetadata = resolve;
      v.onerror = () => reject(new Error(`video error ${v.error?.code}`));
      v.src = h.url;
    });
    window.__h = h;
    return { via: h.via, url: h.url, duration: v.duration, width: v.videoWidth };
  });
  expect(info.via).toBe('sw');
  expect(info.url).toMatch(/\/czstream\/[A-Z2-7]{26}$/);
  expect(info.width).toBe(640);
  expect(Math.abs(info.duration - 5)).toBeLessThan(0.3);

  // the response the worker gives (fetch from the same client → same rules as the media element)
  const head = await page.evaluate(async (url) => {
    const r = await fetch(url, { headers: { Range: 'bytes=0-15' } });
    return { status: r.status, type: r.headers.get('Content-Type'), range: r.headers.get('Content-Range'), csp: r.headers.get('Content-Security-Policy'), cache: r.headers.get('Cache-Control'), n: (await r.arrayBuffer()).byteLength };
  }, info.url);
  expect(head).toEqual({ status: 206, type: 'video/webm', range: 'bytes 0-15/670202', csp: "default-src 'none'; sandbox", cache: 'no-store', n: 16 });

  await page.evaluate(() => window.__v.play());
  await expect.poll(() => page.evaluate(() => window.__v.currentTime), { timeout: 15000 }).toBeGreaterThan(0.3);
  expect(Math.abs((await seekTo(page, 2)) - 2)).toBeLessThan(0.2);

  const cdp = await context.newCDPSession(page);
  const statuses = [];
  cdp.on('ServiceWorker.workerVersionUpdated', (e) => statuses.push(...e.versions.map((v) => v.runningStatus)));
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await expect.poll(() => statuses.at(-1)).toBe('stopped');

  // after the restart the worker has no tokens: playback and seeking continue (Chromium may serve a small clip from
  // what it buffered; any new range request makes the worker ask the page: 'need')
  expect(Math.abs((await seekTo(page, 4.2)) - 4.2)).toBeLessThan(0.2);
  const before = await page.evaluate(() => window.__v.currentTime);
  await expect.poll(() => page.evaluate(() => window.__v.currentTime), { timeout: 15000 }).toBeGreaterThan(before + 0.2);
  await cdp.send('ServiceWorker.stopAllWorkers');
  await expect.poll(() => statuses.at(-1)).toBe('stopped');
  const needsBefore = await page.evaluate(() => window.__needs.length);
  const ranged = await page.evaluate(async (url) => {
    const r = await fetch(url, { headers: { Range: 'bytes=670000-' } });
    return { status: r.status, range: r.headers.get('Content-Range'), n: (await r.arrayBuffer()).byteLength };
  }, info.url);
  expect(ranged).toEqual({ status: 206, range: 'bytes 670000-670201/670202', n: 202 });
  expect(await page.evaluate(() => window.__needs.length)).toBe(needsBefore + 1);
  // a fresh element on the same URL after another restart
  await cdp.send('ServiceWorker.stopAllWorkers');
  await expect.poll(() => statuses.at(-1)).toBe('stopped');
  const again = await page.evaluate(async (url) => {
    const v = document.createElement('video');
    v.muted = true;
    document.body.append(v);
    await new Promise((resolve, reject) => {
      v.onloadedmetadata = resolve;
      v.onerror = () => reject(new Error(`video error ${v.error?.code}`));
      v.src = url;
    });
    await new Promise((r) => {
      v.onseeked = r;
      v.currentTime = 3;
    });
    return { duration: v.duration, needs: window.__needs.length };
  }, info.url);
  expect(Math.abs(again.duration - 5)).toBeLessThan(0.3);

  // released: the page denies 'need' → the worker answers 403 to a request from the restarted worker
  await page.evaluate(() => window.__h.release());
  await cdp.send('ServiceWorker.stopAllWorkers');
  expect(await page.evaluate(async (url) => (await fetch(url, { headers: { Range: 'bytes=0-0' } })).status, info.url)).toBe(403);
  // a navigation to a media URL is refused (another tab of the same origin, also controlled by the worker)
  const other = await context.newPage();
  const nav = await other.goto(info.url);
  expect(nav.status()).toBe(403);
  await other.close();

  expect(await page.evaluate(() => window.__csp)).toEqual([]);
  expect(errors).toEqual([]);
});

test('SW download: a plain <a href> to a single-use token streams the plaintext to the downloads', async ({ page }) => {
  const errors = await watchErrors(page);
  await controlledApp(page);
  await sealFixture(page, 'clip.webm', 'video/webm');
  const [download, result] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(async () => {
      const media = await import('/app/media/media.js');
      window.__failed = [];
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'download-failed') window.__failed.push(e.data.token);
      });
      const r = await media.downloadViaSw(window.__src, { name: 'clip copy.webm' });
      return { name: r.name, where: r.where };
    }),
  ]);
  expect(result).toEqual({ name: 'clip copy.webm', where: 'downloads' });
  expect(download.suggestedFilename()).toBe('clip copy.webm');
  const got = readFileSync(await download.path());
  expect(got.length).toBe(670202);
  expect(sha(got)).toBe(sha(readFileSync(path.join(ROOT, 'tests/fixtures/clip.webm'))));
  await expect(page).toHaveURL(/\/(#.*)?$/);

  // single use: clicking the same URL again gets 204 (the page stays) and the page hears download-failed
  const url = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find((x) => x.href.includes('/czstream/'));
    return a ? a.href : null;
  });
  expect(url).toBe(null); // the link was removed right after the click
  const second = await page.evaluate(async () => {
    const media = await import('/app/media/media.js');
    const scope = (await navigator.serviceWorker.ready).scope;
    const a = document.createElement('a');
    a.href = `${scope}czstream/AAAAAAAAAAAAAAAAAAAAAAAAAA?download=1`;
    document.body.append(a);
    a.click();
    a.remove();
    await new Promise((r) => setTimeout(r, 1500));
    return { failed: window.__failed.length, href: location.href, hasMedia: typeof media.downloadViaSw };
  });
  expect(second.failed).toBeGreaterThan(0);
  expect(second.href).not.toContain('czstream');
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
  expect(errors).toEqual([]);
});

/** Opens the viewer in the app with plain (legacy-style) sources for an image, a text file and a PDF. */
async function openTestViewer(page, { routed = false } = {}) {
  await page.evaluate(async ({ routed }) => {
    const { openViewer } = await import('/app/ui/viewer.js');
    const files = [['image.png', 'image/png'], ['notes.txt', 'text/plain'], ['doc.pdf', 'application/pdf']];
    const blobs = await Promise.all(files.map(async ([n]) => (await fetch(`/tests/fixtures/${n}`)).blob()));
    window.__closed = [];
    const items = files.map(([name, type], i) => ({
      key: `k${i}`, name, type, kind: 'other', size: blobs[i].size, actions: ['fav', 'save', 'share', 'send', 'rename', 'album', 'delete'],
      getSource: async () => ({ kind: 'plain', blob: blobs[i], name, type }),
    }));
    window.__viewer = openViewer({ items, index: 0, routed, onAction: (a, it) => window.__closed.push(`action:${a}:${it.key}`), onClose: (r) => window.__closed.push(r) });
  }, { routed });
  await expect(page.locator('.vw-root')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.querySelector('.vw-img')?.naturalWidth ?? 0)).toBe(320);
}

test('viewer: arrow keys move without history entries; Back and Esc close; routed prev/next replace the route', async ({ page }) => {
  const errors = await watchErrors(page);
  await page.goto('/#/vault');
  await expect(page.locator('.sh-header')).toBeVisible();
  const base = await page.evaluate(() => history.length);
  await openTestViewer(page);
  await expect.poll(() => page.evaluate(() => history.length)).toBe(base + 1);
  await expect(page.locator('.vw-name')).toHaveText('image.png');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.vw-count')).toHaveText('2 / 3');
  await expect(page.locator('.vw-text')).toContainText('cZEROde');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.vw-card-text')).toHaveText('No preview for this kind of file.');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.vw-count')).toHaveText('2 / 3');
  expect(await page.evaluate(() => history.length)).toBe(base + 1);
  // the background is inert while the viewer is open
  expect(await page.evaluate(() => document.getElementById('app').inert)).toBe(true);
  await page.goBack();
  await expect(page.locator('.vw-root')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/vault$/);
  expect(await page.evaluate(() => window.__closed)).toEqual(['back']);
  expect(await page.evaluate(() => document.getElementById('app').inert)).toBe(false);

  await openTestViewer(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('.vw-root')).toHaveCount(0);
  expect(await page.evaluate(() => window.__closed)).toEqual(['user']);
  await expect.poll(() => page.evaluate(() => history.state?.czdOverlay ?? null)).toBe(null);

  // routed (vault-view at #/vault/item/<key>): prev/next replace the last route segment
  await page.evaluate(() => {
    location.hash = '#/vault/item/k0';
  });
  const routedBase = await page.evaluate(() => history.length);
  await openTestViewer(page, { routed: true });
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/#\/vault\/item\/k1$/);
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/#\/vault\/item\/k2$/);
  expect(await page.evaluate(() => history.length)).toBe(routedBase);
  // actions call onAction synchronously; More opens a menu
  await page.locator('.vw-act[aria-label="Save"]').click();
  await page.locator('.vw-act-more').click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  expect(await page.evaluate(() => window.__closed)).toEqual(['action:save:k2', 'action:delete:k2']);
  await page.keyboard.press('Escape');
  await expect(page.locator('.vw-root')).toHaveCount(0);
  expect(await page.evaluate(() => window.__closed.at(-1))).toBe('user');
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
  expect(errors).toEqual([]);
});

test('player: the shell dock plays a queue, advances on ended, sets Media Session metadata, stops on lock', async ({ page }) => {
  const errors = await watchErrors(page);
  await page.goto('/#/vault');
  await expect(page.locator('#player-dock .pl-root')).toBeAttached();
  await sealFixture(page, 'tone.wav', 'audio/wav', '__a');
  await sealFixture(page, 'audio.webm', 'audio/webm', '__b');
  await page.evaluate(async () => {
    const { playQueue } = await import('/app/ui/player.js');
    const item = (key, name, type, v) => ({ key, name, type, kind: 'audio', size: 1, getSource: async () => ({ ...window[v], release() {} }) });
    playQueue([item('a', 'tone.wav', 'audio/wav', '__a'), item('b', 'audio.webm', 'audio/webm', '__b')], { title: 'Road trip' });
  });
  const dock = page.locator('#player-dock .pl-root');
  await expect(dock).toBeVisible();
  await expect(dock.locator('.pl-name')).toHaveText('tone.wav');
  await expect(dock.locator('.pl-sub')).toHaveText('Road trip · 1 / 2');
  await expect.poll(() => page.evaluate(() => document.querySelector('.pl-audio').readyState)).toBeGreaterThan(0);
  if (await page.evaluate(() => document.querySelector('.pl-audio').paused)) await dock.locator('.pl-play').click();
  await expect.poll(() => page.evaluate(async () => (await import('/app/ui/player.js')).isPlaying())).toBe(true);
  expect(await page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe('tone.wav');
  expect(await page.evaluate(async () => (await import('/app/state.js')).get('player'))).toEqual({ playing: true });
  await page.evaluate(() => {
    const a = document.querySelector('.pl-audio');
    a.currentTime = a.duration - 0.05;
  });
  await expect(dock.locator('.pl-name')).toHaveText('audio.webm');
  await expect(dock.locator('.pl-sub')).toHaveText('Road trip · 2 / 2');
  await expect.poll(() => page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe('audio.webm');
  await dock.locator('.pl-btn[aria-label="Queue"]').click();
  await expect(dock.locator('.pl-current .pl-row-name')).toHaveText('audio.webm');
  // a lock stops and clears the player
  await page.evaluate(async () => (await import('/app/state.js')).purge('user'));
  await expect(dock).toBeHidden();
  expect(await page.evaluate(() => navigator.mediaSession.metadata)).toBe(null);
  expect(await page.evaluate(async () => (await import('/app/ui/player.js')).isPlaying())).toBe(false);
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
  expect(errors).toEqual([]);
});

test('viewer (routed): saving a note follows its new id in the route without a history entry', async ({ page }) => {
  const errors = await watchErrors(page);
  await page.goto('/#/vault');
  await expect(page.locator('.sh-header')).toBeVisible();
  await page.evaluate(() => {
    location.hash = '#/vault/item/n1';
  });
  await expect(page).toHaveURL(/#\/vault\/item\/n1$/);
  const base = await page.evaluate(() => history.length);
  await page.evaluate(async () => {
    const { openViewer } = await import('/app/ui/viewer.js');
    const { NOTE_TYPE } = await import('/app/util/format.js');
    const note = (key, title, body) => ({
      key, name: title, type: NOTE_TYPE, kind: 'note', size: 10, actions: ['editNote'],
      getSource: async () => ({ kind: 'plain', blob: new Blob([JSON.stringify({ v: 1, title, body })]), name: title, type: NOTE_TYPE }),
    });
    let v = null;
    v = openViewer({
      items: [note('n0', 'Other', 'x'), note('n1', 'Plan', 'one')],
      index: 1,
      routed: true,
      onAction: async (a, it, p) => {
        // like the vault: its 'items' event rebuilds the list before saveNote resolves with the new ItemInfo
        v.update([note('n2', p.title, p.body), note('n0', 'Other', 'x')]);
        return { id: 'n2', name: p.title };
      },
    });
  });
  const body = page.locator('.vw-note-body');
  await expect(body).toHaveValue('one');
  await body.fill('one two');
  await page.locator('.vw-note-save').click();
  await expect(page.locator('.vw-note-status')).toHaveText('Saved');
  await expect(page).toHaveURL(/#\/vault\/item\/n2$/);
  await expect(page.locator('.vw-count')).toHaveText('1 / 2');
  await expect(body).toHaveValue('one two');
  expect(await page.evaluate(() => history.length)).toBe(base);
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
  expect(errors).toEqual([]);
});
