// Send · Open review e2e (DESIGN §1.6, §1.7, §5.1, §7): no decrypted object URL survives a lock (bundle thumbnails
// re-rendered while decrypting), keyboard focus stays in the card while locking, double clicks start one save or add
// (even when the first click's job is done before the second click lands), a lock
// or a route change in the middle of "Lock & save" leaves nothing behind, a .czd dropped on the Lock card is offered
// to the Open card, bundle row buttons name their file, the "create a vault" hint reads as one sentence, a locked
// vault is unlocked right in the Open card (the file stays open), no decrypted name survives a lock anywhere in the
// page, and incoming plain files ask to create a vault first when there is none.
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
  const save = page.locator('.sd-entry-single .sd-act-save');
  await save.dblclick();
  // The copy downloads while the click's activation lasts; if decrypting outlasts it (a slow machine), a "Ready to
  // save" dialog asks for one more click instead.
  const ready = page.locator('.sd-ready');
  await expect.poll(async () => downloads + (await ready.count()), { timeout: 30_000 }).toBeGreaterThan(0);
  if (!downloads) {
    await ready.locator('.sd-ready-row .btn-primary').click();
    await ready.getByRole('button', { name: 'Done' }).click();
    await expect(ready).toHaveCount(0);
  }
  await expect.poll(() => downloads).toBe(1);
  // A small file is saved before the second click of a double click lands (sooner still on a busy machine, where
  // the clicks arrive further apart): that second click doesn't save it again.
  const box = await save.boundingBox();
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.sd-act-save')), at)).toBe(true);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await page.waitForTimeout(1000);
  expect(downloads).toBe(1);
  await expect(ready).toHaveCount(0);
  await check();
});

test('the second click of a double click that lands after Add / Add all finished adds nothing more', async ({ page }) => {
  const check = await watch(page);
  await page.goto('/#/open');
  await createVault(page);
  await makeCzd(page, [{ name: 'a.txt', type: 'text/plain', text: 'aaa' }, { name: 'b.txt', type: 'text/plain', text: 'bbb' }], { name: 'trip.czd' });
  await openCzdInCard(page);
  const counts = () => page.evaluate(async () => {
    const { vault } = await import('/app/vault/vault.js');
    return { items: vault.items().length, albums: vault.lists().filter((l) => l.name === 'trip').length };
  });
  /** A lone second click (clickCount 2) on `button`, as when a double click's first click already did the job. */
  const lateSecondClick = async (button) => {
    const box = await button.boundingBox();
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.className ?? '', at)).toMatch(/sd-act-add|sd-add-all/);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.up({ clickCount: 2 });
    await page.waitForTimeout(1000);
  };
  const add = page.getByRole('button', { name: 'Add a.txt to my vault' });
  await add.click();
  await expect.poll(counts).toEqual({ items: 1, albums: 0 });
  await lateSecondClick(add);
  expect(await counts()).toEqual({ items: 1, albums: 0 });
  await page.locator('.sd-add-all').click();
  await expect.poll(counts, { timeout: 30_000 }).toEqual({ items: 3, albums: 1 });
  await expect(page.locator('.sd-add-all')).toBeEnabled();
  await lateSecondClick(page.locator('.sd-add-all'));
  expect(await counts()).toEqual({ items: 3, albums: 1 });
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
  await t.getByRole('button', { name: 'Open' }).click();
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
  // One flowing sentence (icon + one text box, then its button), not three flex columns.
  const kids = await page.locator('.sd-vault-hint').evaluate((el) => [...el.children].map((c) => c.tagName));
  expect(kids).toEqual(['svg', 'SPAN', 'BUTTON']);
  await expect(page.locator('.sd-vault-hint .sd-vault-text')).toHaveText('Want to keep these files? Make your own vault first — the file waits here for you.');
  await createVault(page);
  await expect(page.getByRole('button', { name: 'Add a.txt to my vault' })).toBeVisible();
  await expect(page.locator('.sd-vault-hint')).toHaveCount(0);
  await check();
});

test('the vault is unlocked from the Open card: the file stays open and Add all fills the album', async ({ page }) => {
  const check = await watch(page);
  await page.goto('/#/open');
  await createVault(page);
  await page.evaluate(async () => (await import('/app/vault/vault.js')).vault.lock('user'));
  await expect.poll(() => page.evaluate(async () => (await import('/app/state.js')).get('vault.status'))).toBe('locked');
  await makeCzd(page, [{ name: 'a.txt', type: 'text/plain', text: 'aaa' }, { name: 'b.txt', type: 'text/plain', text: 'bbb' }], { name: 'trip.czd' });
  await openCzdInCard(page);
  await expect(page.locator('.sd-add-all')).toHaveCount(0);
  await page.locator('.sd-vault-open').click();
  const field = page.locator('input[name="czd-vault-unlock"]');
  await expect(field).toBeFocused();
  await field.fill('not the vault pass');
  await field.press('Enter');
  await expect(page.locator('.sd-vault-form .pass-err')).toHaveText('Wrong passphrase. Capital letters matter; spaces at the ends are ignored.', { timeout: 30_000 });
  await field.fill('vault pass for e2e');
  await page.locator('.sd-vault-go').click();
  await expect(page.locator('.sd-add-all')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.sd-add-all')).toBeFocused();
  await expect(page.locator('.sd-vault-form')).toHaveCount(0);
  await expect(page.locator('.sd-card-open')).toHaveAttribute('data-phase', 'opened');
  await page.locator('.sd-add-all').click();
  await expect(page.locator('.toast', { hasText: 'album “trip”' })).toBeVisible({ timeout: 30_000 });
  const album = await page.evaluate(async () => {
    const { vault } = await import('/app/vault/vault.js');
    const l = vault.lists().find((x) => x.name === 'trip');
    return l ? l.itemIds.map((id) => vault.item(id).name).sort() : null;
  });
  expect(album).toEqual(['a.txt', 'b.txt']);
  await check();
});

test('after a lock no decrypted file name is left anywhere in the page', async ({ page }) => {
  const check = await watch(page);
  await page.goto('/#/open');
  await makeCzd(page, [{ name: 'zebra-secret-name.txt', type: 'text/plain', text: 'top secret body' }]);
  await openCzdInCard(page);
  await expect(page.locator('.sd-entry-name')).toHaveText('zebra-secret-name.txt');
  await page.locator('.sd-act-preview').click();
  await expect(page.locator('.vw-root')).toBeVisible();
  await page.waitForTimeout(300);
  await page.evaluate(async () => (await import('/app/state.js')).purge('user'));
  await expect(page.locator('.sd-card-open')).toHaveAttribute('data-phase', 'empty');
  await page.waitForTimeout(400);
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  expect(html).not.toContain('zebra-secret-name');
  expect(html).not.toContain('top secret body');
  await check();
});

test('incoming plain files offer "Add to vault"; without a vault it asks to create one first', async ({ page }) => {
  const check = await watch(page);
  await page.goto('/#/send');
  await expect(page.locator('.sd-card-lock')).toBeVisible();
  await page.evaluate(async () => {
    const state = await import('/app/state.js');
    state.set('incoming.files', [new File(['hello'], 'holiday.jpg', { type: 'image/jpeg' })]);
  });
  const row = page.locator('.sd-in-row');
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Add to vault' }).click();
  await expect(page.locator('.toast', { hasText: 'Create your vault first' })).toBeVisible();
  await expect(page).toHaveURL(/#\/vault$/);
  await check();
});
