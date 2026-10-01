// Single active vault tab (DESIGN §4.5) with the real navigator.locks + BroadcastChannel: two tabs of one browser
// profile — the second one is 'other-tab' and can't unlock; "Use it here" moves the vault (the holder locks and
// shows other-tab); a user lock in one tab locks the other, while another tab's own idle/hidden purge does not.
import { test, expect } from '@playwright/test';

const PASS = 'tab lock e2e passphrase';

const status = (page) => page.evaluate(async () => (await import('./app/vault/vault.js')).vault?.status ?? null);

/** vault.<method>(arg) in the page → {ok, status} | {ok:false, code}. */
function call(page, method, arg) {
  return page.evaluate(async ([name, a]) => {
    const { vault } = await import('./app/vault/vault.js');
    try {
      if (name === 'create') await vault.create(a, { recovery: false });
      else if (name === 'unlock') await vault.unlock(a);
      else if (name === 'useHere') await vault.useHere();
      else if (name === 'useHereTwice') await Promise.all([vault.useHere(), vault.useHere()]);
      else throw new Error(`unknown ${name}`);
      return { ok: true, status: vault.status };
    } catch (e) {
      return { ok: false, code: e?.code ?? String(e) };
    }
  }, [method, arg]);
}

const purge = (page, reason) => page.evaluate(async (r) => (await import('./app/state.js')).purge(r), reason);

test('two tabs: other-tab, "Use it here" handoff both ways, remote user lock; passive purges ignored', async ({ context }) => {
  const a = await context.newPage();
  await a.goto('/');
  await expect.poll(() => status(a)).toBe('none');
  expect(await call(a, 'create', PASS)).toEqual({ ok: true, status: 'unlocked' });

  const b = await context.newPage();
  await b.goto('/');
  await expect.poll(() => status(b)).toBe('other-tab');
  expect(await call(b, 'unlock', PASS)).toEqual({ ok: false, code: 'other-tab' });
  expect(await status(a)).toBe('unlocked');

  // "Use it here" in B: A locks and shows other-tab, B can unlock.
  expect(await call(b, 'useHere')).toEqual({ ok: true, status: 'locked' });
  await expect.poll(() => status(a)).toBe('other-tab');
  expect(await call(b, 'unlock', PASS)).toEqual({ ok: true, status: 'unlocked' });

  // Another tab's own idle/hidden purge does not lock the vault tab; a user lock does.
  await purge(a, 'idle');
  await purge(a, 'hidden');
  await b.waitForTimeout(200);
  expect(await status(b)).toBe('unlocked');
  await purge(a, 'user');
  await expect.poll(() => status(b)).toBe('locked');

  // And back: A takes over again (two overlapping calls, like a double click), B shows other-tab.
  expect(await call(a, 'useHereTwice')).toEqual({ ok: true, status: 'locked' });
  await expect.poll(() => status(b)).toBe('other-tab');
  expect(await call(a, 'unlock', PASS)).toEqual({ ok: true, status: 'unlocked' });
  await a.waitForTimeout(3500); // past the yield wait: the second request must not have cost A the lock
  expect(await status(a)).toBe('unlocked');
  expect(await status(b)).toBe('other-tab');
});

test("passive purges in another tab leave this tab's service-worker streams alone; a deliberate lock stops them", async ({ context }) => {
  const SIZE = 8 * 2 ** 20;
  const controlled = async (page) => {
    await page.goto('/');
    await page.evaluate(async () => {
      (await import('/app/pwa.js')).registerServiceWorker();
      await navigator.serviceWorker.ready;
    });
    if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  };
  const a = await context.newPage();
  await controlled(a);
  const b = await context.newPage();
  await controlled(b);

  // Tab A streams a locked file through the service worker (like a Send preview: no vault needed), and starts reading.
  const first = await a.evaluate(async (size) => {
    const C = await import('/app/crypto/container.js');
    const { blobSource } = await import('/app/util/stream.js');
    const media = await import('/app/media/media.js');
    const data = new Uint8Array(size);
    for (let o = 0; o < size; o += 65536) crypto.getRandomValues(data.subarray(o, o + 65536));
    const pk = await C.makePassKek('pw', { m: 64, t: 1, p: 1 });
    const parts = [];
    for await (const p of C.encryptStream(data, { size, meta: { name: 'clip.webm', type: 'video/webm' }, chunkExp: 14, stanzasFor: async (fk) => [await C.passStanza(fk, pk)] })) parts.push(p);
    const src = blobSource(new Blob(parts));
    const opened = await C.openSource(src, { passphrase: 'pw' });
    window.__needs = 0;
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.cmd === 'need') window.__needs++;
    });
    window.__h = await media.playableUrl({ kind: 'container', src, opened }, { mode: 'video' });
    const res = await fetch(window.__h.url);
    window.__reader = res.body.getReader();
    const r = await window.__reader.read();
    return { via: window.__h.via, n: r.value.length };
  }, SIZE);
  expect(first.via).toBe('sw');
  expect(first.n).toBeLessThan(SIZE);

  // Tab B (no vault) goes idle / hidden / away: its purges are its own.
  for (const reason of ['idle', 'hidden', 'pagehide', 'freeze']) await purge(b, reason);
  await a.waitForTimeout(300);
  const rest = await a.evaluate(async (n0) => {
    let n = n0;
    try {
      for (;;) {
        const r = await window.__reader.read();
        if (r.done) break;
        n += r.value.length;
      }
      return { ok: true, n };
    } catch (e) {
      return { ok: false, n, error: String(e) };
    }
  }, first.n);
  expect(rest).toEqual({ ok: true, n: SIZE });
  const ranged = await a.evaluate(async () => (await fetch(window.__h.url, { headers: { Range: 'bytes=0-15' } })).status);
  expect(ranged).toBe(206);
  expect(await a.evaluate(() => window.__needs)).toBe(0); // the worker still knew the token

  // A deliberate lock (user) in tab B reaches tab A: its streams and keys are gone.
  await purge(b, 'user');
  await expect.poll(() => a.evaluate(async () => (await fetch(window.__h.url, { headers: { Range: 'bytes=0-0' } })).status)).toBe(403);
});
