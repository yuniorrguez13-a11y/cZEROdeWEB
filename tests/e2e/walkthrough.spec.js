// Fresh-user walkthrough regressions (phase 5): spots where a first-time user got stuck or lost something.
// - create: the generated words are shown whole (a phone's one-line field cut them off) with a Copy button
// - rename keeps the file extension (a saved/sent copy must still open elsewhere)
// - an empty album says how to fill it and its Add files puts new files into it
// - the phone selection bar labels its buttons
// - an audio file opened in the viewer can be handed to the player dock ("Play in background")
// - a video in the viewer fits a landscape laptop screen (its controls stay on screen)
// - the Send result is not hidden under the sticky header on a phone
// - a receiver without a vault can make one and come back to the .czd ("Create my vault"), without re-picking it
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIX = path.join(ROOT, 'tests/fixtures');
const PHONE = { width: 390, height: 844 };

/** Page errors and CSP violations; checked at the end of every test. */
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

/** Phones and Firefox have no save pickers: outputs are staged (Save buttons). */
async function noPickers(page) {
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
    delete window.showDirectoryPicker;
  });
}

/** A vault at test-speed KDF settings (the create form itself is covered by vault.spec.js). */
async function quickVault(page) {
  await page.evaluate(async () => {
    const mod = await import('/app/vault/vault.js');
    for (let i = 0; i < 200 && (!mod.vault || mod.vault.status === 'loading'); i++) await new Promise((r) => setTimeout(r, 50));
    await mod.vault.create('vault pass for e2e', { params: { m: 64, t: 1, p: 1 }, recovery: false });
  });
  await expect.poll(() => page.evaluate(async () => (await import('/app/state.js')).get('vault.status'))).toBe('unlocked');
}

async function openVault(page) {
  await page.goto('/#/vault');
  await expect(page.locator('.vv-hero')).toBeVisible();
  await quickVault(page);
  await expect(page.locator('.vv-unlocked')).toBeVisible();
}

async function addFiles(page, names) {
  const before = await page.locator('.vv-card').count();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.vv-add')]);
  await chooser.setFiles(names.map((n) => path.join(FIX, n)));
  await expect(page.locator('.vv-card')).toHaveCount(before + names.length, { timeout: 60_000 });
  const close = page.locator('.up-close');
  if (await close.isVisible().catch(() => false)) await close.click();
}

const card = (page, name) => page.locator('.vv-card', { has: page.locator('.vv-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });

async function cardMenu(page, name, item) {
  await card(page, name).locator('.vv-more').click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

/** Builds a passphrase .czd in the page (test-speed KDF); window.__czd = the File. */
async function makeCzd(page, files, { pass = 'pw', name = 'from-a-friend.czd' } = {}) {
  await page.evaluate(async ({ files, pass, name }) => {
    const C = await import('/app/crypto/container.js');
    const pk = await C.makePassKek(pass, { m: 64, t: 1, p: 1 });
    const blobs = [];
    for (const f of files) blobs.push(new Uint8Array(await (await fetch(f.url)).arrayBuffer()));
    const meta = C.bundleMeta(files.map((f, i) => ({ name: f.name, type: f.type, size: blobs[i].length })));
    const data = new Uint8Array(await new Blob(blobs).arrayBuffer());
    const parts = [];
    for await (const p of C.encryptStream([data], { size: data.length, meta, stanzasFor: async (fk) => [await C.passStanza(fk, pk)] })) parts.push(p);
    window.__czd = new File(parts, name);
  }, { files, pass, name });
}

const PHOTOS = ['beach.png', 'sky.png', 'park.png'].map((name) => ({ name, type: 'image/png', url: '/tests/fixtures/image.png' }));

test('create (phone): the generated words are shown whole with Copy; new words repaint them; a purge clears them', async ({ page, context }) => {
  const check = await watch(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize(PHONE);
  await page.goto('/');
  await page.click('[data-choice="create"]');
  const box = page.locator('.vv-phrase');
  await expect(box).toBeHidden();
  await page.getByRole('button', { name: 'Generate' }).click();
  const pass = await page.inputValue('input[name="czd-vault-new"]');
  // The one-line field cannot show five words on a phone; the box below it does, wrapped and inside the screen.
  expect(await page.locator('input[name="czd-vault-new"]').evaluate((i) => i.scrollWidth > i.clientWidth)).toBe(true);
  await expect(box).toBeVisible();
  await expect(page.locator('.vv-phrase-text')).toHaveText(pass);
  const fits = await box.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const t = el.querySelector('.vv-phrase-text');
    return r.left >= 0 && r.right <= document.documentElement.clientWidth && t.scrollWidth <= t.clientWidth;
  });
  expect(fits).toBe(true);
  await box.getByRole('button', { name: 'Copy' }).click();
  await expect(box.getByRole('button', { name: '✓ Copied!' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(pass);
  // Typing your own passphrase hides the box (only generated words are shown there).
  await page.fill('input[name="czd-vault-new"]', 'my own long passphrase');
  await expect(box).toBeHidden();
  await page.getByRole('button', { name: 'Generate' }).click();
  const again = await page.inputValue('input[name="czd-vault-new"]');
  expect(again).not.toBe(pass);
  await expect(page.locator('.vv-phrase-text')).toHaveText(again);
  // Idle without a vault purges the screen: the words leave the DOM with the field's value.
  await page.evaluate(async () => (await import('/app/state.js')).purge('idle'));
  await expect(box).toBeHidden();
  await expect(page.locator('.vv-phrase-text')).toHaveText('');
  expect(await page.evaluate((p) => document.documentElement.textContent.includes(p), again)).toBe(false);
  await check();
});

test('rename keeps the extension: only the name starts selected, and a name typed without one keeps the old one', async ({ page }) => {
  const check = await watch(page);
  await openVault(page);
  await addFiles(page, ['image.png', 'notes.txt']);
  await cardMenu(page, 'image.png', 'Rename');
  const input = page.locator('.modal input.input');
  await expect(input).toHaveValue('image.png');
  expect(await input.evaluate((i) => [i.selectionStart, i.selectionEnd])).toEqual([0, 5]);
  await page.keyboard.type('Beach day');
  await expect(input).toHaveValue('Beach day.png');
  await page.keyboard.press('Enter');
  await expect(card(page, 'Beach day.png')).toBeVisible();
  // Deleting the extension by hand gets it back; a different one typed on purpose is kept.
  await cardMenu(page, 'Beach day.png', 'Rename');
  await input.fill('Beach');
  await page.keyboard.press('Enter');
  await expect(card(page, 'Beach.png')).toBeVisible();
  await cardMenu(page, 'notes.txt', 'Rename');
  await input.fill('diary.md');
  await page.keyboard.press('Enter');
  await expect(card(page, 'diary.md')).toBeVisible();
  const stored = await page.evaluate(async () => (await import('/app/vault/vault.js')).vault.items().map((i) => i.name).sort());
  expect(stored).toEqual(['Beach.png', 'diary.md']);
  await check();
});

test('an empty album says how to fill it; its Add files puts new files straight into the album', async ({ page }) => {
  const check = await watch(page);
  await openVault(page);
  await addFiles(page, ['notes.txt']);
  await page.getByRole('button', { name: 'New album' }).first().click();
  await page.locator('.modal input.input').fill('Summer 26');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/vault\/album\/[0-9a-f]+$/);
  const empty = page.locator('.empty', { hasText: 'This album is empty' });
  await expect(empty).toContainText('Go to All items, click Select, pick them and choose Album.');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), empty.getByRole('button', { name: 'Add files' }).click()]);
  await chooser.setFiles(path.join(FIX, 'image.png'));
  await expect(page.locator('.vv-card')).toHaveCount(1, { timeout: 60_000 });
  await expect(card(page, 'image.png')).toBeVisible();
  const lists = await page.evaluate(async () => {
    const v = (await import('/app/vault/vault.js')).vault;
    return v.lists().map((l) => ({ name: l.name, items: l.itemIds.map((id) => v.items().find((i) => i.id === id)?.name) }));
  });
  expect(lists).toEqual([{ name: 'Summer 26', items: ['image.png'] }]);
  await check();
});

test.describe('touch phone', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test('the selection bar labels its buttons, and an empty album speaks touch', async ({ page }) => {
    const check = await watch(page);
    await openVault(page);
    await addFiles(page, ['image.png', 'notes.txt']);
    await page.click('.vv-selectbtn');
    await card(page, 'image.png').locator('.vv-open').click();
    const bar = page.locator('.vv-selbar');
    await expect(bar).toBeVisible();
    for (const label of ['Favorite', 'Album', 'Save', 'Send', 'Delete']) {
      await expect(bar.locator('.vv-selact-label', { hasText: label })).toBeVisible();
    }
    const inside = await bar.evaluate((el) => [...el.querySelectorAll('.vv-selact')].every((b) => {
      const r = b.getBoundingClientRect();
      return r.left >= 0 && r.right <= document.documentElement.clientWidth && b.scrollWidth <= b.clientWidth + 1;
    }));
    expect(inside).toBe(true);
    await page.getByRole('button', { name: 'Cancel selection' }).click();
    await page.evaluate(async () => {
      const v = (await import('/app/vault/vault.js')).vault;
      const l = await v.createList({ name: 'Empty one' });
      location.hash = `#/vault/album/${l.id}`;
    });
    await expect(page.locator('.empty', { hasText: 'This album is empty' })).toContainText('tap Select, pick them and tap Album.');
    await check();
  });

  test('after Lock & save the result title sits below the sticky header, Save in view', async ({ page }) => {
    const check = await watch(page);
    await noPickers(page);
    await openVault(page);
    // Three photos picked in the vault → Send (the card that came out taller than the screen).
    const png = readFileSync(path.join(FIX, 'image.png'));
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.tap('.vv-add')]);
    await chooser.setFiles([
      ...['IMG_2041.png', 'IMG_2042.png', 'IMG_2043.png'].map((name) => ({ name, mimeType: 'image/png', buffer: png })),
      { name: 'doc.pdf', mimeType: 'application/pdf', buffer: readFileSync(path.join(FIX, 'doc.pdf')) },
      { name: 'tone.wav', mimeType: 'audio/wav', buffer: readFileSync(path.join(FIX, 'tone.wav')) },
    ]);
    await expect(page.locator('.vv-card')).toHaveCount(5, { timeout: 60_000 });
    await page.evaluate(async () => {
      const ids = (await import('/app/vault/vault.js')).vault.items().filter((i) => i.kind === 'image').map((i) => i.id);
      (await import('/app/state.js')).set('send.pending', { itemIds: ids });
      location.hash = '#/send';
    });
    await expect(page.locator('.sd-card-lock .sd-go')).toBeVisible();
    await page.tap('.sd-go');
    await expect(page.locator('.sd-save').first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(300);
    const geo = await page.evaluate(() => ({
      header: document.querySelector('.sh-header').getBoundingClientRect().bottom,
      title: document.querySelector('.sd-result-title').getBoundingClientRect().top,
      save: document.querySelector('.sd-save').getBoundingClientRect().bottom,
      nav: document.querySelector('.sh-bottom').getBoundingClientRect().top,
    }));
    expect(geo.title).toBeGreaterThanOrEqual(geo.header);
    expect(geo.save).toBeLessThanOrEqual(geo.nav);
    await check();
  });
});

test('audio viewer: "Play in background" hands the song to the player dock, which keeps playing on other screens', async ({ page }) => {
  const check = await watch(page);
  await openVault(page);
  await addFiles(page, ['tone.wav', 'image.png']);
  // Not on a photo, and never in the action bar.
  await card(page, 'image.png').locator('.vv-open').click();
  await expect(page.locator('.vw-root[data-mode="image"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play in background' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.vw-root')).toHaveCount(0);
  await card(page, 'tone.wav').locator('.vv-open').click();
  await expect(page.locator('.vw-root[data-mode="audio"] .vw-audio:not(.vw-pending)')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vw-actions').getByRole('button', { name: 'Play in background' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Play in background' }).click();
  await expect(page.locator('.vw-root')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/vault$/);
  await expect(page.locator('.pl-name')).toHaveText('tone.wav');
  // The dock plays it (the 1.5 s tone may already be over when this looks: it started, then).
  await expect.poll(() => page.evaluate(() => {
    const a = document.querySelector('.pl-audio');
    return Boolean(a && a.currentSrc && (a.currentTime > 0 || !a.paused));
  }), { timeout: 15_000 }).toBe(true);
  await page.goto('/#/text');
  await expect(page.locator('.pl-name')).toHaveText('tone.wav');
  expect(await page.evaluate(() => Boolean(document.querySelector('.pl-audio')?.currentSrc))).toBe(true);
  await check();
});

test('laptop: a video in the viewer fits the screen, controls included', async ({ page }) => {
  const check = await watch(page);
  await page.setViewportSize({ width: 1366, height: 768 });
  await openVault(page);
  await addFiles(page, ['clip.webm']);
  await card(page, 'clip.webm').locator('.vv-open').click();
  const video = page.locator('.vw-video');
  await expect(page.locator('.vw-root[data-mode="video"]')).toBeVisible();
  await expect.poll(() => video.evaluate((v) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  const box = await video.evaluate((v) => {
    const r = v.getBoundingClientRect();
    const s = v.parentElement.getBoundingClientRect();
    return { bottom: r.bottom, right: r.right, stageBottom: s.bottom, vh: innerHeight, vw: innerWidth };
  });
  expect(box.bottom).toBeLessThanOrEqual(box.stageBottom + 0.5);
  expect(box.bottom).toBeLessThanOrEqual(box.vh);
  expect(box.right).toBeLessThanOrEqual(box.vw);
  await check();
});

test('receiver without a vault: "Create my vault" keeps the .czd; the new vault leads back to it and Add all works', async ({ page }) => {
  const check = await watch(page);
  await page.goto('/#/open');
  await makeCzd(page, PHOTOS);
  await page.evaluate(async () => (await import('/app/state.js')).set('incoming.files', [window.__czd]));
  await page.fill('input[name="czd-open-pass"]', 'pw');
  await page.click('.sd-unlock');
  await expect(page.locator('.sd-opened')).toBeVisible({ timeout: 30_000 });
  const hint = page.locator('.sd-vault-none');
  await expect(hint).toContainText('Make your own vault first — the file waits here for you.');
  await hint.getByRole('button', { name: 'Create my vault' }).click();
  await expect(page).toHaveURL(/#\/vault$/);
  await expect(page.locator('.vv-hero')).toBeVisible();
  // Nothing decrypted stays behind while the vault is being made.
  expect(await page.evaluate(() => document.documentElement.textContent.includes('beach.png'))).toBe(false);
  await quickVault(page);
  const banner = page.locator('.vv-banner', { hasText: 'Your locked file is waiting.' });
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Back to my file' }).click();
  await expect(page).toHaveURL(/#\/open$/);
  await expect(page.locator('.sd-card-open .sd-chip-name')).toHaveText('from-a-friend.czd');
  await expect(page.locator('.toast', { hasText: 'Type its passphrase again' })).toBeVisible();
  await expect(page.locator('input[name="czd-open-pass"]')).toBeFocused();
  await page.fill('input[name="czd-open-pass"]', 'pw');
  await page.click('.sd-unlock');
  await expect(page.locator('.sd-opened')).toBeVisible({ timeout: 30_000 });
  await page.click('.sd-add-all');
  await expect.poll(() => page.evaluate(async () => (await import('/app/vault/vault.js')).vault.items().length), { timeout: 30_000 }).toBe(3);
  // Used once: the vault no longer says a file is waiting.
  expect(await page.evaluate(async () => (await import('/app/state.js')).get('open.waiting'))).toBe(null);
  await check();
});

test('receiver without a vault: a lock while the vault is being made drops the waiting .czd', async ({ page }) => {
  const check = await watch(page);
  await page.goto('/#/open');
  await makeCzd(page, PHOTOS);
  await page.evaluate(async () => (await import('/app/state.js')).set('incoming.files', [window.__czd]));
  await page.fill('input[name="czd-open-pass"]', 'pw');
  await page.click('.sd-unlock');
  await expect(page.locator('.sd-opened')).toBeVisible({ timeout: 30_000 });
  await page.locator('.sd-vault-none').getByRole('button', { name: 'Create my vault' }).click();
  await expect(page.locator('.vv-hero')).toBeVisible();
  expect(await page.evaluate(async () => (await import('/app/state.js')).get('open.waiting'))).toBe(true);
  await page.evaluate(async () => (await import('/app/state.js')).purge('idle'));
  expect(await page.evaluate(async () => (await import('/app/state.js')).get('open.waiting'))).toBe(null);
  await page.goto('/#/open');
  await expect(page.locator('.sd-card-open')).toHaveAttribute('data-phase', 'empty');
  await check();
});
