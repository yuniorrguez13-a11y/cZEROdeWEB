// Send · Open review e2e (DESIGN §1.6, §1.7, §5.1, §7): no decrypted object URL survives a lock (bundle thumbnails
// re-rendered while decrypting), keyboard focus stays in the card while locking, double clicks start one save, a lock
// or a route change in the middle of "Lock & save" leaves nothing behind, a .czd dropped on the Lock card is offered
// to the Open card, bundle row buttons name their file, and the "unlock your vault" hint reads as one sentence.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIX = path.join(ROOT, 'tests/fixtures');

async function watch(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return async () => {
    const csp = await page.evaluate(() => window.__csp ?? []).catch(() => []);
    expect([...errors, ...csp]).toEqual([]);
  };
}

/** Records every blob: URL the page creates and revokes (window.__liveUrls = created minus revoked). */
async function trackUrls(page) {
  await page.addInitScript(() => {
    const live = new Set();
    window.__liveUrls = live;
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (o) => {
      const u = create(o);
      live.add(u);
      return u;
    };
    URL.revokeObjectURL = (u) => {
      live.delete(u);
      return revoke(u);
    };
  });
}

async function noPickers(page) {
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
    delete window.showDirectoryPicker;
  });
}

/** Builds a passphrase .czd in the page (test-speed KDF) from fixture URLs / texts; window.__czd = the File. */
async function makeCzd(page, files, { pass = 'pw', name = 'pics.czd' } = {}) {
  await page.evaluate(async ({ files, pass, name }) => {
    const C = await import('/app/crypto/container.js');
    const pk = await C.makePassKek(pass, { m: 64, t: 1, p: 1 });
    const blobs = [];
    for (const f of files) blobs.push(f.url ? new Uint8Array(await (await fetch(f.url)).arrayBuffer()) : new TextEncoder().encode(f.text));
    let meta;
    let data;
    if (files.length === 1) {
      meta = { name: files[0].name, type: files[0].type };
      data = blobs[0];
    } else {
      meta = C.bundleMeta(files.map((f, i) => ({ name: f.name, type: f.type, size: blobs[i].length })));
      data = new Uint8Array(await new Blob(blobs).arrayBuffer());
    }
    const parts = [];
    for await (const p of C.encryptStream([data], { size: data.length, meta, stanzasFor: async (fk) => [await C.passStanza(fk, pk)] })) parts.push(p);
    window.__czd = new File(parts, name);
  }, { files, pass, name });
}

async function openCzdInCard(page, pass = 'pw') {
  await page.evaluate(async () => (await import('/app/state.js')).set('incoming.files', [window.__czd]));
  await page.fill('input[name="czd-open-pass"]', pass);
  await page.click('.sd-unlock');
  await expect(page.locator('.sd-opened')).toBeVisible({ timeout: 30_000 });
}

async function createVault(page) {
  await page.evaluate(async () => {
    const mod = await import('/app/vault/vault.js');
    for (let i = 0; i < 200 && (!mod.vault || mod.vault.status === 'loading'); i++) await new Promise((r) => setTimeout(r, 50));
    await mod.vault.create('vault pass for e2e', { params: { m: 64, t: 1, p: 1 }, recovery: false });
  });
  await expect.poll(() => page.evaluate(async () => (await import('/app/state.js')).get('vault.status'))).toBe('unlocked');
}

const IMAGES = Array.from({ length: 6 }, (_, i) => ({ name: `photo-${i + 1}.png`, type: 'image/png', url: '/tests/fixtures/image.png' }));

test('a lock revokes every decrypted object URL, even thumbnails re-rendered while they decrypt', async ({ page }) => {
  const check = await watch(page);
  await trackUrls(page);
  await page.goto('/#/open');
  await expect(page.locator('.sd-card-open')).toBeVisible();
  await makeCzd(page, IMAGES);
  await page.evaluate(async () => (await import('/app/state.js')).set('incoming.files', [window.__czd]));
  await page.fill('input[name="czd-open-pass"]', 'pw');
  await page.click('.sd-unlock');
  await expect(page.locator('.sd-entries-bundle .sd-entry')).toHaveCount(6, { timeout: 30_000 });
  // Re-render the card several times while the thumbnails are being decrypted (a vault status change does that).
  await page.evaluate(async () => {
    const state = await import('/app/state.js');
    for (let i = 0; i < 6; i++) {
      state.set('vault.status', i % 2 ? 'none' : 'locked');
      await new Promise((r) => setTimeout(r, 5));
    }
    state.set('vault.status', 'none');
  });
  await expect(page.locator('.sd-entries-bundle .sd-thumb-img')).toHaveCount(6, { timeout: 30_000 });
  await page.waitForTimeout(300);
  await page.evaluate(async () => (await import('/app/state.js')).purge('idle'));
  await expect(page.locator('.sd-card-open')).toHaveAttribute('data-phase', 'empty');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => [...window.__liveUrls])).toEqual([]);
  await check();
});

test('keyboard focus stays in the Lock card while locking and lands on the result', async ({ page }) => {
  const check = await watch(page);
  await noPickers(page);
  await page.goto('/#/send');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.sd-pick')]);
  await chooser.setFiles([path.join(FIX, 'image.png')]);
  await page.locator('.sd-go').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.sd-card-lock')).toHaveAttribute('data-phase', /working|result/);
  const inCard = () => page.evaluate(() => Boolean(document.activeElement?.closest('.sd-card-lock')));
  expect(await inCard()).toBe(true);
  await expect(page.locator('.sd-result')).toBeVisible({ timeout: 60_000 });
  expect(await inCard()).toBe(true);
  await check();
});

test('a double click on Lock & save opens one save picker and makes one .czd', async ({ page }) => {
  const check = await watch(page);
  await page.addInitScript(() => {
    window.__pickers = 0;
    window.showSaveFilePicker = async (opts) => {
      window.__pickers++;
      await new Promise((r) => setTimeout(r, 300));
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('e2e-dbl', { create: true });
      return dir.getFileHandle(opts.suggestedName, { create: true });
    };
  });
  await page.goto('/#/send');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.sd-pick')]);
  await chooser.setFiles([path.join(FIX, 'notes.txt')]);
  await page.locator('.sd-go').dblclick();
  await expect(page.locator('.sd-result')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__pickers)).toBe(1);
  const names = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('e2e-dbl');
    const out = [];
    for await (const [n, h] of dir.entries()) out.push({ n, size: (await h.getFile()).size });
    return out;
  });
  expect(names).toHaveLength(1);
  expect(names[0].size).toBeGreaterThan(0);
  await check();
});

test('a double click on Save (staged decrypted copy) downloads once', async ({ page }) => {
  const check = await watch(page);
  await noPickers(page);
  await page.goto('/#/open');
  await makeCzd(page, [{ name: 'note.txt', type: 'text/plain', text: 'hello there' }]);
  await openCzdInCard(page);
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.locator('.sd-entry-single .sd-act-save').dblclick();
  await page.waitForTimeout(1500);
  const ready = page.locator('.sd-ready .btn-primary');
  if (await ready.count()) await ready.first().click();
  await page.waitForTimeout(500);
  expect(downloads).toBe(1);
  await check();
});

test('a lock or a route change during Lock & save leaves an empty card and no running job', async ({ page }) => {
  const check = await watch(page);
  await noPickers(page);
  await page.goto('/#/send');
  const big = Buffer.alloc(24 * 2 ** 20, 7);
  for (const how of ['lock', 'route']) {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.sd-pick')]);
    await chooser.setFiles([{ name: 'big.bin', mimeType: 'application/octet-stream', buffer: big }]);
    await page.click('.sd-go');
    await expect(page.locator('.sd-card-lock')).toHaveAttribute('data-phase', 'working');
    if (how === 'lock') {
      await page.evaluate(async () => (await import('/app/state.js')).purge('user'));
      await expect(page.locator('.sd-card-lock')).toHaveAttribute('data-phase', 'empty');
    } else {
      await page.evaluate(() => {
        location.hash = '#/text';
      });
      await expect(page.locator('.tx-card')).toBeVisible();
      await page.evaluate(() => {
        location.hash = '#/send';
      });
      await expect(page.locator('.sd-card-lock')).toHaveAttribute('data-phase', 'empty');
    }
    await expect.poll(() => page.evaluate(async () => (await import('/app/state.js')).get('busy')), { timeout: 15_000 }).toBe(0);
    await expect(page.locator('.sd-result')).toHaveCount(0);
  }
  await check();
});

test('a locked .czd added to the Lock card is offered to the Open card instead', async ({ page }) => {
  const check = await watch(page);
  await page.goto('/#/send');
  await makeCzd(page, [{ name: 'note.txt', type: 'text/plain', text: 'hello' }], { name: 'from-chat.czd' });
  const bytes = await page.evaluate(async () => [...new Uint8Array(await window.__czd.arrayBuffer())]);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.sd-pick')]);
  await chooser.setFiles([{ name: 'from-chat.czd', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) }]);
  const t = page.locator('.toast', { hasText: 'already locked' });
  await expect(t).toBeVisible();
  await t.getByRole('button', { name: 'Open it' }).click();
  await expect(page.locator('.sd-card-open .sd-chip-name')).toHaveText('from-chat.czd');
  await expect(page.locator('.sd-card-lock')).toHaveAttribute('data-phase', 'empty');
  await check();
});

test('bundle rows: icon buttons name their file; the vault hint is one sentence', async ({ page }) => {
  const check = await watch(page);
  await page.goto('/#/open');
  await makeCzd(page, [{ name: 'a.txt', type: 'text/plain', text: 'a' }, { name: 'b.txt', type: 'text/plain', text: 'b' }]);
  await openCzdInCard(page);
  await expect(page.getByRole('button', { name: 'Preview a.txt' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save b.txt' })).toBeVisible();
  // One flowing sentence (icon + one text box), not three flex columns.
  const kids = await page.locator('.sd-vault-hint').evaluate((el) => [...el.children].map((c) => c.tagName));
  expect(kids).toEqual(['svg', 'SPAN']);
  await createVault(page);
  await expect(page.getByRole('button', { name: 'Add a.txt to my vault' })).toBeVisible();
  await expect(page.locator('.sd-vault-hint')).toHaveCount(0);
  await check();
});
