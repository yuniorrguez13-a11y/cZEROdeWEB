// Vault screens e2e (DESIGN §1.3–§1.6, §4.5, §12): first run, create (typed / generated) with the recovery code,
// the vault minimum, the weak-PIN skull only on the create field, lock/unlock, wrong passphrase, recovery-code
// unlock, adding files through the file chooser (cards + thumbnails), the viewer (Back closes it), rename, favorites,
// search, sort, delete + Undo / commit, multi-select delete, notes (save → new id, still open), panic Esc ×3,
// autolock (page.clock), saving a decrypted copy through the staged download, the other-tab handoff and a phone
// viewport smoke test. Every test starts from a fresh browser context (fresh storage).
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIX = path.join(ROOT, 'tests/fixtures');
const PASS = 'correct horse battery staple';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const ITEM_HASH = /#\/vault\/item\/([0-9a-f]{32})$/;

// Most tests run Argon2id at the real policy two or three times (create, unlock): extra time on a busy machine.
test.beforeEach(({ browserName }, testInfo) => {
  void browserName;
  testInfo.setTimeout(testInfo.timeout + 60_000);
});

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

async function openApp(page) {
  await page.goto('/');
  await expect(page.locator('.vv-hero')).toBeVisible();
}

/** Fills the create form with a typed passphrase and creates the vault; returns the recovery code. */
async function createVault(page, pass = PASS) {
  await page.click('[data-choice="create"]');
  await page.fill('input[name="czd-vault-new"]', pass);
  await page.fill('input[name="czd-vault-confirm"]', pass);
  await page.getByLabel('If I forget this passphrase').check();
  await page.click('.vv-submit');
  // Argon2id at the real policy: slow when the machine is busy (parallel workers).
  await expect(page.locator('.vv-recovery')).toBeVisible({ timeout: 60_000 });
  const code = (await page.locator('.vv-code-group').allTextContents()).join('-');
  await page.getByRole('button', { name: 'I saved it' }).click();
  await expect(page.locator('.vv-unlocked')).toBeVisible();
  return code;
}

async function closeUploadDock(page) {
  const close = page.locator('.up-close');
  if (await close.isVisible().catch(() => false)) await close.click();
}

/** Adds fixture files through "Add files" (the system file chooser) and waits for their cards. */
async function addFiles(page, names) {
  const before = await page.locator('.vv-card').count();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.vv-add')]);
  await chooser.setFiles(names.map((n) => path.join(FIX, n)));
  await expect(page.locator('.vv-card')).toHaveCount(before + names.length, { timeout: 60_000 });
  await closeUploadDock(page);
}

const card = (page, name) => page.locator('.vv-card', { has: page.locator('.vv-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
const names = (page) => page.locator('.vv-card .vv-name').allTextContents();
const status = (page) => page.evaluate(async () => (await import('/app/vault/vault.js')).vault?.status);

async function cardMenu(page, name, item) {
  await card(page, name).locator('.vv-more').click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

async function lock(page) {
  await page.click('.sh-lock');
  await expect(page.locator('.vv-lockpage')).toBeVisible();
}

async function unlock(page, pass = PASS) {
  await page.fill('input[name="czd-vault-unlock"]', pass);
  await page.keyboard.press('Enter');
  await expect(page.locator('.vv-unlocked')).toBeVisible({ timeout: 60_000 });
}

test('first run: hero with three choices, quick tour, open link', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await expect(page.locator('.vv-choice')).toHaveCount(3);
  await expect(page.locator('[data-choice="create"]')).toContainText('Hide my photos & files');
  await expect(page.locator('[data-choice="open"]')).toContainText('Open a file someone sent me');
  await expect(page.locator('[data-choice="restore"]')).toContainText('I have a backup (.czb)');
  await expect(page.locator('.tu-modal')).toHaveCount(0); // the tour never opens by itself
  await page.getByRole('button', { name: 'Quick tour' }).click();
  await expect(page.locator('.tu-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.tu-modal')).toHaveCount(0);
  await page.click('[data-choice="open"]');
  await expect(page).toHaveURL(/#\/open$/);
  await check();
});

test('create with a typed passphrase: vault minimum, skull only on the create field, recovery code', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await page.click('[data-choice="create"]');
  const submit = page.locator('.vv-submit');
  const reason = page.locator('.vv-reason');
  await expect(submit).toBeDisabled();
  await page.fill('input[name="czd-vault-new"]', 'short');
  await expect(reason).toHaveText(/at least 10 characters/);
  await expect(submit).toBeDisabled();
  await page.fill('input[name="czd-vault-new"]', 'password123');
  await expect(reason).toHaveText(/Too easy to guess/);
  // The weak-PIN skull on the field that sets the vault passphrase.
  await page.fill('input[name="czd-vault-new"]', '1234');
  await expect(page.locator('.eg-modal')).toBeVisible();
  await page.getByRole('button', { name: 'ok fine' }).click();
  await page.fill('input[name="czd-vault-new"]', PASS);
  await page.fill('input[name="czd-vault-confirm"]', `${PASS}x`);
  await expect(reason).toHaveText(/don't match/);
  await page.fill('input[name="czd-vault-confirm"]', `  ${PASS} `); // ends are ignored (§3.1)
  await expect(reason).toHaveText(/Tick the box/);
  await expect(submit).toBeDisabled();
  await page.getByLabel('If I forget this passphrase').check();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.locator('.vv-recovery')).toBeVisible({ timeout: 30_000 });
  const groups = await page.locator('.vv-code-group').allTextContents();
  expect(groups).toHaveLength(8);
  for (const g of groups) expect(g).toMatch(/^[A-Z2-7]{4}$/);
  await page.getByRole('button', { name: 'I saved it' }).click();
  await expect(page.locator('.vv-recovery')).toHaveCount(0);
  await expect(page.locator('.vv-empty')).toContainText('Your vault is empty');
  // Never on the unlock field.
  await lock(page);
  await page.fill('input[name="czd-vault-unlock"]', '1234');
  await page.waitForTimeout(900);
  await expect(page.locator('.eg-modal')).toHaveCount(0);
  await unlock(page);
  await check();
});

test('recovery code sheet: Copy puts the code on the clipboard, Download .txt saves it', async ({ page, context }) => {
  const check = await watch(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true, writable: true });
  });
  await openApp(page);
  await page.click('[data-choice="create"]');
  await page.fill('input[name="czd-vault-new"]', PASS);
  await page.fill('input[name="czd-vault-confirm"]', PASS);
  await page.getByLabel('If I forget this passphrase').check();
  await page.click('.vv-submit');
  const sheet = page.locator('.vv-recovery');
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  const code = (await page.locator('.vv-code-group').allTextContents()).join('-');
  await sheet.getByRole('button', { name: 'Copy code' }).click();
  await expect(sheet.getByRole('button', { name: '✓ Copied!' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
  const [download] = await Promise.all([page.waitForEvent('download'), sheet.getByRole('button', { name: 'Download .txt' }).click()]);
  expect(download.suggestedFilename()).toBe('cZEROde-recovery-code.txt');
  expect(readFileSync(await download.path(), 'utf8')).toContain(code);
  await sheet.getByRole('button', { name: 'I saved it' }).click();
  await expect(sheet).toHaveCount(0);
  await check();
});

test('create with a generated passphrase, then unlock with it', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await page.click('[data-choice="create"]');
  await page.getByRole('button', { name: 'Generate' }).click();
  const pass = await page.inputValue('input[name="czd-vault-new"]');
  expect(pass).toMatch(/^[a-z]+(-[a-z]+){4}$/);
  await expect(page.locator('input[name="czd-vault-confirm"]')).toBeHidden();
  const saved = page.getByLabel('I saved it (password manager');
  await expect(saved).toBeVisible();
  await expect(page.locator('.vv-submit')).toBeDisabled();
  await saved.check();
  await page.getByLabel('If I forget this passphrase').check();
  await page.click('.vv-submit');
  await expect(page.locator('.vv-recovery')).toBeVisible({ timeout: 30_000 });
  await page.locator('.vv-recovery').getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(page.locator('.vv-unlocked')).toBeVisible();
  await lock(page);
  await unlock(page, pass);
  await check();
});

test('create on a low-memory device: asks before using lighter protection (FLOOR), vault flagged floor', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await page.evaluate(async () => {
    const { vault } = await import('/app/vault/vault.js');
    const { CzdError } = await import('/app/errors.js');
    const create = vault.create.bind(vault);
    window.__createParams = [];
    vault.create = async (pass, opts = {}) => {
      window.__createParams.push(opts.params ?? null);
      if (!opts.params) throw new CzdError('kdf-out-of-memory');
      return create(pass, opts);
    };
  });
  await page.click('[data-choice="create"]');
  await page.fill('input[name="czd-vault-new"]', PASS);
  await page.fill('input[name="czd-vault-confirm"]', PASS);
  await page.getByLabel('If I forget this passphrase').check();
  await page.click('.vv-submit');
  const dialog = page.locator('.modal', { hasText: 'Low memory: use lighter protection?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Use lighter protection' }).click();
  await expect(page.locator('.vv-recovery')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'I saved it' }).click();
  const info = await page.evaluate(async () => {
    const { vault } = await import('/app/vault/vault.js');
    return { floor: vault.floor, params: window.__createParams, kdf: vault.kdfParams };
  });
  expect(info.floor).toBe(true);
  expect(info.params).toEqual([null, { m: 19456, t: 2, p: 1 }]);
  expect(info.kdf).toEqual({ m: 19456, t: 2, p: 1 });
  await check();
});

test('lock and unlock; a wrong passphrase says so and selects the field', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await createVault(page);
  await lock(page);
  await expect(page.locator('.vv-lockpage .vv-micro')).toHaveText(/Locked/);
  await page.fill('input[name="czd-vault-unlock"]', 'not my passphrase');
  await page.click('.vv-submit');
  await expect(page.locator('.pass-err')).toHaveText('Wrong passphrase. Capital letters matter; spaces at the ends are ignored.', { timeout: 30_000 });
  await expect(page.locator('input[name="czd-vault-unlock"]')).toBeFocused();
  expect(await status(page)).toBe('locked');
  await unlock(page);
  expect(await status(page)).toBe('unlocked');
  await expect(page.locator('.vv-add')).toBeFocused(); // keyboard users land on the main action
  await check();
});

test('recovery code: unlock and set a new passphrase', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  const code = await createVault(page);
  await lock(page);
  await page.getByRole('button', { name: 'Forgot it?' }).click();
  await page.click('[data-choice="recovery"]');
  await page.fill('input[name="czd-recovery-code"]', 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH');
  const fresh = 'a brand new passphrase';
  await page.fill('input[name="czd-change-new"]', fresh);
  await page.fill('input[name="czd-change-confirm"]', fresh);
  await page.click('.vv-submit');
  await expect(page.locator('.pass-err:not([hidden])')).toHaveText("That recovery code doesn't open this vault.", { timeout: 30_000 });
  await page.fill('input[name="czd-recovery-code"]', code.toLowerCase().replace(/-/g, ' '));
  await page.click('.vv-submit');
  await expect(page.locator('.vv-unlocked')).toBeVisible({ timeout: 30_000 });
  await lock(page);
  await page.fill('input[name="czd-vault-unlock"]', PASS);
  await page.click('.vv-submit');
  await expect(page.locator('.pass-err:not([hidden])')).toHaveText(/Wrong passphrase/, { timeout: 30_000 });
  await unlock(page, fresh);
  await check();
});

test('add files through the file chooser: cards, kinds, durations and thumbnails', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await createVault(page);
  await addFiles(page, ['image.png', 'notes.txt', 'clip.webm', 'tone.wav']);
  await expect(card(page, 'image.png')).toHaveAttribute('data-kind', 'image');
  await expect(card(page, 'notes.txt')).toHaveAttribute('data-kind', 'doc');
  await expect(card(page, 'clip.webm')).toHaveAttribute('data-kind', 'video');
  await expect(card(page, 'tone.wav')).toHaveAttribute('data-kind', 'audio');
  await expect(card(page, 'image.png').locator('.vv-thumb.has-img img')).toBeVisible({ timeout: 20_000 });
  await expect(card(page, 'image.png').locator('img')).toHaveAttribute('src', /^blob:/);
  await expect(card(page, 'clip.webm').locator('.vv-dur')).toHaveText('0:05');
  await expect(card(page, 'tone.wav').locator('.vv-dur')).toHaveText('0:01');
  await expect(page.locator('.vv-chip[data-kind="all"] .vv-chip-n')).toHaveText('4');
  await expect(page.locator('.vv-head .vv-sub')).toContainText('4 items');
  await check();
});

test('viewer: an image opens at #/vault/item/<id>, Back closes it; keyboard open and Esc close', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await createVault(page);
  await addFiles(page, ['image.png', 'notes.txt']);
  await card(page, 'image.png').locator('.vv-open').click();
  await expect(page.locator('.vw-root .vw-img')).toBeVisible();
  await expect(page).toHaveURL(ITEM_HASH);
  await page.goBack();
  await expect(page.locator('.vw-root')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/vault$/);
  // Keyboard: arrows move between cards, Enter opens, ← → step inside the viewer, Esc closes back to the grid route.
  const order = await names(page);
  await card(page, order[0]).locator('.vv-open').focus();
  await page.keyboard.press('ArrowRight');
  await expect(card(page, order[1]).locator('.vv-open')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.vw-name')).toHaveText(order[1]);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.vw-name')).toHaveText(order[0]);
  await expect(page.locator(order[0] === 'notes.txt' ? '.vw-root .vw-text' : '.vw-root .vw-img')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.vw-root')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/vault$/);
  await check();
});

test('a link to an item that arrives while locked opens it after unlocking', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await createVault(page);
  await addFiles(page, ['image.png']);
  const id = await card(page, 'image.png').getAttribute('data-id');
  await card(page, 'image.png').locator('.vv-open').click();
  await expect(page.locator('.vw-root .vw-img')).toBeVisible();
  await page.locator('.vw-close').click();
  await expect(page).toHaveURL(/#\/vault$/);
  await lock(page);
  await page.evaluate((x) => {
    location.hash = `#/vault/item/${x}`;
  }, id);
  await expect(page.locator('.vv-lockpage')).toBeVisible();
  await unlock(page);
  await expect(page.locator('.vw-root .vw-img')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.vw-root')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/vault$/);
  // Locking with the viewer open closes it and leaves the item route.
  await card(page, 'image.png').locator('.vv-open').click();
  await expect(page).toHaveURL(ITEM_HASH);
  await page.evaluate(async () => (await import('/app/vault/vault.js')).vault.lock('user'));
  await expect(page.locator('.vw-root')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/vault$/);
  await check();
});

test('rename, favorite filter, search and sort', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await createVault(page);
  await addFiles(page, ['image.png', 'notes.txt', 'tone.wav']);
  await cardMenu(page, 'notes.txt', 'Rename');
  const input = page.locator('.modal input.input');
  await expect(input).toHaveValue('notes.txt');
  await input.fill('diary.txt');
  await page.keyboard.press('Enter');
  await expect(card(page, 'diary.txt')).toBeVisible();
  await expect(card(page, 'notes.txt')).toHaveCount(0);

  await cardMenu(page, 'image.png', 'Favorite');
  await expect(card(page, 'image.png').locator('.vv-fav')).toBeVisible();
  await page.click('.vv-chip[data-kind="fav"]');
  expect(await names(page)).toEqual(['image.png']);
  await page.click('.vv-chip[data-kind="note"]');
  await expect(page.locator('.vv-empty')).toContainText('No notes yet');
  await page.click('.vv-chip[data-kind="all"]');
  await expect(page.locator('.vv-card')).toHaveCount(3);

  await page.fill('.vv-search-input', 'DIA');
  await expect(page.locator('.vv-card')).toHaveCount(1);
  expect(await names(page)).toEqual(['diary.txt']);
  await page.fill('.vv-search-input', 'nothing like this');
  await expect(page.locator('.vv-empty')).toContainText('Nothing found');
  await page.fill('.vv-search-input', '');
  await expect(page.locator('.vv-card')).toHaveCount(3);

  await page.selectOption('.vv-sort', 'name');
  await expect.poll(() => names(page)).toEqual(['diary.txt', 'image.png', 'tone.wav']);
  await page.selectOption('.vv-sort', 'size');
  await expect.poll(() => names(page)).toEqual(['tone.wav', 'image.png', 'diary.txt']);
  const oldest = await page.evaluate(async () => (await import('/app/vault/vault.js')).vault.items().map((i) => i.name).reverse());
  await page.selectOption('.vv-sort', 'old');
  await expect.poll(() => names(page)).toEqual(oldest);
  // The sort is remembered (settings.vaultSort).
  await page.reload();
  await unlock(page);
  await expect(page.locator('.vv-sort')).toHaveValue('old');
  await check();
});

test('delete: Undo restores, the delete commits after the undo window; multi-select delete commits on lock', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await createVault(page);
  await addFiles(page, ['image.png', 'notes.txt', 'tone.wav', 'doc.pdf']);
  const stored = () => page.evaluate(async () => (await import('/app/vault/vault.js')).vault.items().map((i) => i.name).sort());

  await cardMenu(page, 'notes.txt', 'Delete');
  await expect(card(page, 'notes.txt')).toHaveCount(0);
  const toast = page.locator('.toast', { hasText: 'Deleted' });
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(card(page, 'notes.txt')).toHaveCount(1);
  expect(await stored()).toContain('notes.txt');

  await cardMenu(page, 'notes.txt', 'Delete');
  await expect(card(page, 'notes.txt')).toHaveCount(0);
  expect(await stored()).toContain('notes.txt'); // still undoable
  await expect.poll(stored, { timeout: 15_000 }).not.toContain('notes.txt');
  await expect(page.locator('.toast', { hasText: 'Deleted' })).toHaveCount(0);

  await page.click('.vv-selectbtn');
  await card(page, 'image.png').locator('.vv-open').click();
  await card(page, 'tone.wav').locator('.vv-open').click();
  await expect(page.locator('.vv-selcount')).toHaveText('2 selected');
  await page.locator('.vv-selbar').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.vv-card')).toHaveCount(1);
  await expect(page.locator('.toast', { hasText: 'Deleted 2 items' })).toBeVisible();
  await lock(page); // a pending delete commits on lock
  await unlock(page);
  await expect(page.locator('.vv-card')).toHaveCount(1);
  expect(await stored()).toEqual(['doc.pdf']);
  await check();
});

test('delete inside the viewer: it moves on to the next item and the route follows; Undo brings it back', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await createVault(page);
  await addFiles(page, ['image.png', 'notes.txt', 'doc.pdf']);
  const order = await names(page);
  await card(page, order[0]).locator('.vv-open').click();
  await expect(page.locator('.vw-name')).toHaveText(order[0]);
  const firstUrl = page.url();
  await page.locator('.vw-act-more').click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.locator('.vw-name')).toHaveText(order[1]);
  await expect(page.locator('.vw-count')).toHaveText('1 / 2');
  await expect.poll(() => page.url()).not.toBe(firstUrl);
  const id = ITEM_HASH.exec(page.url())[1];
  expect(await card(page, order[1]).getAttribute('data-id')).toBe(id);
  await page.locator('.toast', { hasText: 'Deleted' }).getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.vw-count')).toHaveText('2 / 3');
  await expect(page.locator('.vw-name')).toHaveText(order[1]);
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-card')).toHaveCount(3);
  await check();
});

test('notes: New note opens the editor, Save makes a new id and keeps it open; an untouched new note is dropped', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await createVault(page);
  // Opened and closed without typing: nothing is left behind.
  await page.getByRole('button', { name: 'New note' }).click();
  await expect(page.locator('.vw-note-title')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.vw-root')).toHaveCount(0);
  await expect.poll(() => page.evaluate(async () => (await import('/app/vault/vault.js')).vault.items().length)).toBe(0);

  await page.getByRole('button', { name: 'New note' }).click();
  await expect(page.locator('.vw-note-title')).toBeFocused();
  const firstId = ITEM_HASH.exec(page.url())[1];
  await page.fill('.vw-note-title', 'Groceries');
  await page.fill('.vw-note-body', 'eggs\nmilk');
  await page.click('.vw-note-save');
  await expect(page.locator('.vw-note-status')).toHaveText('Saved');
  await expect.poll(() => ITEM_HASH.exec(page.url())?.[1]).not.toBe(firstId);
  const savedId = ITEM_HASH.exec(page.url())[1];
  await expect(page.locator('.vw-note-title')).toHaveValue('Groceries');
  await expect(page.locator('.vw-name')).toHaveText('Groceries');
  // Edit again: another new id, still open.
  await page.fill('.vw-note-body', 'eggs\nmilk\nbread');
  await page.click('.vw-note-save');
  await expect.poll(() => ITEM_HASH.exec(page.url())?.[1]).not.toBe(savedId);
  await expect(page.locator('.vw-note-body')).toHaveValue('eggs\nmilk\nbread');
  await page.click('.vw-close');
  await expect(page.locator('.vw-root')).toHaveCount(0);
  await expect(page.locator('.vv-card')).toHaveCount(1);
  await expect(card(page, 'Groceries')).toHaveAttribute('data-kind', 'note');
  // Reopens with the saved text.
  await card(page, 'Groceries').locator('.vv-open').click();
  await expect(page.locator('.vw-note-body')).toHaveValue('eggs\nmilk\nbread');
  await check();
});

test('drop anywhere on the vault and paste images add files', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await createVault(page);
  const png = readFileSync(path.join(FIX, 'image.png')).toString('base64');
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
    const target = document.querySelector('.vv-empty');
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
  }, png);
  await expect(card(page, 'dropped.png')).toBeVisible({ timeout: 30_000 });
  await closeUploadDock(page);
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    document.body.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  }, png);
  await expect(page.locator('.vv-card .vv-name', { hasText: /^Pasted image .+\.png$/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.vv-card')).toHaveCount(2);
  await check();
});

test('album mode: header with name and count, Play queues the music, Delete album keeps the items', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await createVault(page);
  await addFiles(page, ['image.png', 'tone.wav', 'notes.txt']);
  const id = await page.evaluate(async () => {
    const { vault } = await import('/app/vault/vault.js');
    const ids = vault.items().filter((i) => i.name !== 'notes.txt').map((i) => i.id);
    return (await vault.createList({ name: 'Road trip', itemIds: ids })).id;
  });
  await page.evaluate((x) => {
    location.hash = `#/vault/album/${x}`;
  }, id);
  const head = page.locator('.vv-album-head');
  await expect(head.locator('.vv-title')).toHaveText('Road trip');
  await expect(head.locator('.vv-sub')).toContainText('2 items');
  await expect(page.locator('.vv-card')).toHaveCount(2);
  await expect(card(page, 'notes.txt')).toHaveCount(0);
  await head.getByRole('button', { name: 'Play' }).click();
  await expect(page.locator('#player-dock .pl-root')).toBeVisible();
  await expect(page.locator('#player-dock .pl-name')).toHaveText('tone.wav');
  // An item opened from the album returns to the album.
  await card(page, 'image.png').locator('.vv-open').click();
  await expect(page.locator('.vw-root .vw-img')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`#/vault/album/${id}$`));
  await head.getByRole('button', { name: 'Delete album' }).click();
  await page.locator('.modal').getByRole('button', { name: 'Delete album' }).click();
  await expect(page).toHaveURL(/#\/vault$/);
  await expect(page.locator('.vv-card')).toHaveCount(3);
  expect(await page.evaluate(async () => (await import('/app/vault/vault.js')).vault.lists().length)).toBe(0);
  await check();
});

test('panic: Esc three times locks the vault', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await createVault(page);
  await page.locator('.vv-head .vv-title').click();
  for (let i = 0; i < 3; i++) await page.keyboard.press('Escape');
  await expect(page.locator('.vv-lockpage')).toBeVisible();
  expect(await status(page)).toBe('locked');
  await check();
});

test('autolock: idle for the configured minutes locks (page.clock)', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await createVault(page);
  await addFiles(page, ['image.png']);
  await page.clock.install();
  await page.clock.fastForward('04:00');
  await page.waitForTimeout(500);
  expect(await status(page)).toBe('unlocked');
  await page.clock.fastForward('02:00');
  await expect(page.locator('.vv-lockpage')).toBeVisible({ timeout: 15_000 });
  // Lock clears decrypted names from the page.
  await expect(page.locator('.vv-card')).toHaveCount(0);
  await check();
});

test('save a decrypted copy: no save picker → staged download', async ({ page }) => {
  const check = await watch(page);
  await page.addInitScript(() => {
    for (const name of ['showSaveFilePicker', 'showDirectoryPicker']) {
      try {
        Object.defineProperty(window, name, { value: undefined, configurable: true, writable: true });
      } catch {
        // not defined here
      }
    }
  });
  await openApp(page);
  await createVault(page);
  await addFiles(page, ['image.png']);
  const [download] = await Promise.all([page.waitForEvent('download'), cardMenu(page, 'image.png', 'Save decrypted copy')]);
  expect(download.suggestedFilename()).toBe('image.png');
  const bytes = readFileSync(await download.path());
  expect(sha(bytes)).toBe(sha(readFileSync(path.join(FIX, 'image.png'))));
  await check();
});

test('other tab: the second tab shows "open in another tab"; Use it here moves the vault', async ({ context }) => {
  const a = await context.newPage();
  const checkA = await watch(a);
  await openApp(a);
  await createVault(a);
  const b = await context.newPage();
  const checkB = await watch(b);
  await b.goto('/');
  await expect(b.locator('.vv[data-screen="other-tab"]')).toBeVisible();
  await expect(b.locator('.vv-title')).toHaveText('Open in another tab');
  await b.getByRole('button', { name: 'Use it here' }).click();
  await expect(b.locator('.vv-lockpage')).toBeVisible({ timeout: 15_000 });
  await expect(a.locator('.vv[data-screen="other-tab"]')).toBeVisible();
  await expect(a.locator('.vv-card')).toHaveCount(0);
  await unlock(b);
  await checkA();
  await checkB();
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('mobile viewport smoke: hero, create, add, menu, select bar, no sideways scroll', async ({ page }) => {
    const check = await watch(page);
    await openApp(page);
    await expect(page.locator('.sh-bottom')).toBeVisible();
    await createVault(page);
    await addFiles(page, ['image.png', 'notes.txt']);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const boxes = await page.locator('.vv-card').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
    expect(boxes[0]).toBe(boxes[1]); // two columns
    await card(page, 'image.png').locator('.vv-more').click();
    await expect(page.getByRole('menuitem', { name: 'Save decrypted copy' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.click('.vv-selectbtn');
    await expect(page.locator('.vv-selbar')).toBeVisible();
    await card(page, 'notes.txt').locator('.vv-open').click();
    await expect(page.locator('.vv-selcount')).toHaveText('1 selected');
    await page.click('.vv-selclose');
    await expect(page.locator('.vv-selbar')).toBeHidden();
    await card(page, 'image.png').locator('.vv-open').click();
    await expect(page.locator('.vw-root .vw-img')).toBeVisible();
    await page.locator('.vw-close').click();
    await expect(page.locator('.vw-root')).toHaveCount(0);
    await check();
  });
});

// ───────── review fixes (adversarial pass)

test('viewer: an action that takes the item out of the filter keeps it shown; deleting the last one leaves the item route', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await createVault(page);
  await addFiles(page, ['image.png', 'notes.txt']);
  const imageId = await card(page, 'image.png').getAttribute('data-id');
  await cardMenu(page, 'image.png', 'Favorite');
  await page.click('.vv-chip[data-kind="fav"]');
  await expect(page.locator('.vv-card')).toHaveCount(1);
  await card(page, 'image.png').locator('.vv-open').click();
  await expect(page.locator('.vw-name')).toHaveText('image.png');
  await page.locator('.vw-act-fav').click(); // unfavorite: no longer in the ★ filter
  await expect(page.locator('.vw-act-fav')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.vw-name')).toHaveText('image.png');
  await expect(page.locator('.vw-root .vw-img')).toBeVisible();
  expect(page.url()).toContain(`#/vault/item/${imageId}`);
  await page.keyboard.press('Escape');
  await expect(page.locator('.vw-root')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/vault$/);
  await expect(page.locator('.vv-empty')).toContainText('No favorites yet');

  // The only item of a filter, deleted inside the viewer: the viewer closes and the route goes back to the grid.
  await page.click('.vv-chip[data-kind="doc"]');
  await card(page, 'notes.txt').locator('.vv-open').click();
  await expect(page.locator('.vw-name')).toHaveText('notes.txt');
  await page.locator('.vw-act-more').click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.locator('.vw-root')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/vault$/);
  await page.locator('.toast', { hasText: 'Deleted' }).getByRole('button', { name: 'Undo' }).click();
  await expect(card(page, 'notes.txt')).toHaveCount(1);
  await check();
});

test('New note: a double click makes one note, and nothing is left when it is closed untouched', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await createVault(page);
  await page.getByRole('button', { name: 'New note' }).dblclick();
  await expect(page.locator('.vw-note-title')).toBeVisible();
  await page.waitForTimeout(800);
  expect(await page.evaluate(async () => (await import('/app/vault/vault.js')).vault.items().length)).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.vw-root')).toHaveCount(0);
  await expect.poll(() => page.evaluate(async () => (await import('/app/vault/vault.js')).vault.items().length)).toBe(0);
  await check();
});

test('create: "I saved it" is unticked again when the generated words change', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await page.click('[data-choice="create"]');
  await page.getByRole('button', { name: 'Generate' }).click();
  const saved = page.getByLabel('I saved it (password manager');
  await saved.check();
  await page.getByLabel('If I forget this passphrase').check();
  await expect(page.locator('.vv-submit')).toBeEnabled();
  await page.getByRole('button', { name: 'Generate' }).click();
  await expect(saved).not.toBeChecked();
  await expect(page.locator('.vv-submit')).toBeDisabled();
  await check();
});

test('first run warns about a private window or limited storage', async ({ page }) => {
  const check = await watch(page);
  await page.addInitScript(() => {
    const est = navigator.storage.estimate.bind(navigator.storage);
    navigator.storage.estimate = async () => ({ ...(await est()), quota: 300 * 2 ** 20 });
  });
  await openApp(page);
  await expect(page.locator('.vv-none .banner')).toContainText('Private window or limited storage');
  await check();
});

test('first run: no storage warning when there is room', async ({ page }) => {
  const check = await watch(page);
  await page.addInitScript(() => {
    const est = navigator.storage.estimate.bind(navigator.storage);
    navigator.storage.estimate = async () => ({ ...(await est()), quota: 50 * 2 ** 30 });
  });
  await openApp(page);
  await page.waitForTimeout(500);
  await expect(page.locator('.vv-none .banner')).toHaveCount(0);
  await check();
});

test('keyboard: Enter toggles in select mode; deleting a card from its menu moves focus to the next card', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await createVault(page);
  await addFiles(page, ['image.png', 'notes.txt', 'doc.pdf']);
  const order = await names(page);
  await page.click('.vv-selectbtn');
  await card(page, order[0]).locator('.vv-open').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.vv-selcount')).toHaveText('1 selected');
  await expect(page.locator('.vw-root')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(page.locator('.vv-selcount')).toHaveText('Tap items to select');
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-selbar')).toBeHidden();
  // Card menu by keyboard: Delete is the last entry.
  await card(page, order[1]).locator('.vv-more').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(card(page, order[1])).toHaveCount(0);
  await expect(card(page, order[2]).locator('.vv-open')).toBeFocused();
  // Undo from the toast: the restored card gets the focus back.
  await page.locator('.toast', { hasText: 'Deleted' }).getByRole('button', { name: 'Undo' }).click();
  await expect(card(page, order[1]).locator('.vv-open')).toBeFocused();
  await check();
});

test('a note title keeps its punctuation in the grid and in toasts', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await createVault(page);
  await page.evaluate(async () => (await import('/app/vault/vault.js')).vault.addNote({ title: 'To do: Monday?', body: 'x' }));
  await expect(page.locator('.vv-card .vv-name')).toHaveText('To do: Monday?');
  await cardMenu(page, 'To do: Monday?', 'Delete');
  await expect(page.locator('.toast', { hasText: 'Deleted “To do: Monday?”' })).toBeVisible();
  await check();
});

test('lock clears decrypted names from everywhere: dialogs, toasts, search, thumbnails', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await createVault(page);
  await addFiles(page, ['image.png', 'notes.txt']);
  await expect(card(page, 'image.png').locator('.vv-thumb.has-img img')).toBeVisible({ timeout: 20_000 });
  await page.fill('.vv-search-input', 'image');
  await expect(page.locator('.vv-card')).toHaveCount(1);
  await cardMenu(page, 'image.png', 'Rename');
  await expect(page.locator('.modal input.input')).toHaveValue('image.png');
  await page.evaluate(async () => (await import('/app/vault/vault.js')).vault.lock('user'));
  await expect(page.locator('.vv-lockpage')).toBeVisible();
  const leak = await page.evaluate(() => {
    const out = [];
    if (document.documentElement.textContent.includes('image.png') || document.documentElement.textContent.includes('notes.txt')) out.push('text');
    for (const el of document.querySelectorAll('input, textarea')) if (/image|notes/.test(el.value)) out.push(`value:${el.className}`);
    for (const el of document.querySelectorAll('[src^="blob:"], [href^="blob:"]')) out.push(`url:${el.tagName}`);
    return out;
  });
  expect(leak).toEqual([]);
  await check();
});

test('a dirty note in the viewer is saved when the vault locks', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await createVault(page);
  await page.getByRole('button', { name: 'New note' }).click();
  await expect(page.locator('.vw-note-title')).toBeFocused();
  await page.fill('.vw-note-title', 'Secret plan');
  await page.fill('.vw-note-body', 'step one');
  await page.evaluate(async () => (await import('/app/vault/vault.js')).vault.lock('user'));
  await expect(page.locator('.vw-root')).toHaveCount(0);
  await expect(page.locator('.vv-lockpage')).toBeVisible();
  await expect(page).toHaveURL(/#\/vault$/);
  await page.waitForTimeout(500);
  await unlock(page);
  await expect(page.locator('.vv-card')).toHaveCount(1);
  await card(page, 'Secret plan').locator('.vv-open').click();
  await expect(page.locator('.vw-note-body')).toHaveValue('step one');
  await check();
});

test('recovery sheet: closing it without a choice says how to make a code later', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await page.click('[data-choice="create"]');
  await page.fill('input[name="czd-vault-new"]', PASS);
  await page.fill('input[name="czd-vault-confirm"]', PASS);
  await page.getByLabel('If I forget this passphrase').check();
  await page.click('.vv-submit');
  await expect(page.locator('.vv-recovery')).toBeVisible({ timeout: 30_000 });
  await page.locator('.vv-recovery .sheet-close').click();
  await expect(page.locator('.vv-recovery')).toHaveCount(0);
  await expect(page.locator('.toast', { hasText: 'Settings → Vault' })).toBeVisible();
  await check();
});

test('banners: "Keep my data" asks for persistent storage from the click; the backup chip opens the export', async ({ page }) => {
  const check = await watch(page);
  await page.addInitScript(() => {
    let persisted = false;
    window.__persistCalls = 0;
    navigator.storage.persisted = async () => persisted;
    navigator.storage.persist = async () => {
      window.__persistCalls++;
      window.__persistActive = navigator.userActivation?.isActive ?? null;
      persisted = true;
      return true;
    };
    window.__pickerCalls = [];
    window.showSaveFilePicker = async (opts) => {
      window.__pickerCalls.push(opts?.suggestedName ?? null);
      throw new DOMException('cancelled', 'AbortError');
    };
  });
  await openApp(page);
  await createVault(page);
  const persistBanner = page.locator('.vv-banners .banner', { hasText: 'Not protected from cleanup' });
  await expect(persistBanner).toBeVisible();
  await persistBanner.getByRole('button', { name: 'Keep my data' }).click();
  await expect(page.locator('.toast', { hasText: 'Protected' })).toBeVisible();
  await expect(persistBanner).toHaveCount(0);
  expect(await page.evaluate(() => [window.__persistCalls, window.__persistActive])).toEqual([1, true]);

  await addFiles(page, ['image.png']);
  const chip = page.locator('.vv-backup-chip');
  await expect(chip).toBeHidden();
  await page.evaluate(async () => {
    const { vault } = await import('/app/vault/vault.js');
    vault.lastBackupAt = Date.now() - 9 * 86_400_000;
    vault.dispatchEvent(new CustomEvent('meta', { detail: {} }));
  });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText('Last backup 9 days ago');
  await chip.click();
  await expect.poll(() => page.evaluate(() => window.__pickerCalls)).toEqual([expect.stringMatching(/\.czb$/)]);
  await check();
});

test.describe('phone share', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('Share / Save to Photos: decrypt first, then the Share button\'s own click shares the file', async ({ page }) => {
    const check = await watch(page);
    await page.addInitScript(() => {
      window.__shared = [];
      Object.defineProperty(Navigator.prototype, 'canShare', { configurable: true, value: (d) => Array.isArray(d?.files) && d.files.length > 0 });
      Object.defineProperty(Navigator.prototype, 'share', {
        configurable: true,
        value: async (d) => {
          window.__shared.push({ names: d.files.map((f) => f.name), sizes: d.files.map((f) => f.size), active: navigator.userActivation?.isActive ?? null });
        },
      });
    });
    await openApp(page);
    await createVault(page);
    await addFiles(page, ['image.png']);
    await card(page, 'image.png').locator('.vv-more').click();
    await page.getByRole('menuitem', { name: 'Share / Save to Photos' }).click();
    const dialog = page.locator('.modal', { hasText: 'Ready to share' });
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => window.__shared.length)).toBe(0); // nothing shared before the second click
    await dialog.getByRole('button', { name: 'Share / Save to Photos' }).click();
    await expect(dialog).toHaveCount(0);
    const shared = await page.evaluate(() => window.__shared);
    expect(shared).toEqual([{ names: ['image.png'], sizes: [readFileSync(path.join(FIX, 'image.png')).length], active: true }]);
    await check();
  });
});

test('locking while a decrypted copy is being prepared: nothing is saved and no error is shown', async ({ page }) => {
  const check = await watch(page);
  await page.addInitScript(() => {
    for (const name of ['showSaveFilePicker', 'showDirectoryPicker']) {
      try {
        Object.defineProperty(window, name, { value: undefined, configurable: true, writable: true });
      } catch {
        // not defined here
      }
    }
  });
  await openApp(page);
  await createVault(page);
  await addFiles(page, ['image.png']);
  await page.evaluate(async () => {
    const { vault } = await import('/app/vault/vault.js');
    const orig = vault.sourceFor.bind(vault);
    vault.sourceFor = async (id) => {
      await new Promise((r) => setTimeout(r, 600)); // the lock lands before the item is opened
      return orig(id);
    };
  });
  let downloads = 0;
  page.on('download', () => downloads++);
  await cardMenu(page, 'image.png', 'Save decrypted copy');
  await expect(page.locator('.toast', { hasText: 'Decrypting' })).toBeVisible();
  await page.evaluate(async () => (await import('/app/vault/vault.js')).vault.lock('user'));
  await expect(page.locator('.vv-lockpage')).toBeVisible();
  await page.waitForTimeout(1500);
  expect(downloads).toBe(0);
  await expect(page.locator('.toast')).toHaveCount(0);
  await expect(page.locator('.modal')).toHaveCount(0);
  await check();
});

test('old cZEROde 1 data: hero link and a dismissible vault banner that stays dismissed', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  const setLegacy = () => page.evaluate(async () => (await import('/app/state.js')).set('legacy.found', { notes: 1, files: 2, playlists: 0 }));
  await setLegacy();
  await expect(page.locator('.vv-legacy-link')).toHaveText('Coming from cZEROde 1? Your old stuff is safe →');
  await createVault(page);
  const legacyBanner = page.locator('.vv-banners .banner', { hasText: 'Coming from cZEROde 1?' });
  await expect(legacyBanner).toBeVisible();
  await legacyBanner.getByRole('button', { name: 'Dismiss' }).click();
  await expect(legacyBanner).toHaveCount(0);
  await page.reload();
  await unlock(page);
  await page.waitForTimeout(500); // the boot's own legacy probe has settled
  await setLegacy();
  await expect(page.locator('.vv-banners .banner', { hasText: 'Not protected from cleanup' })).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.locator('.vv-banners .banner', { hasText: 'Coming from cZEROde 1?' })).toHaveCount(0);
  // Different old data (more files found): the banner comes back.
  await page.evaluate(async () => (await import('/app/state.js')).set('legacy.found', { notes: 1, files: 3, playlists: 0 }));
  await expect(page.locator('.vv-banners .banner', { hasText: 'Coming from cZEROde 1?' })).toBeVisible();
  await check();
});

test('deleting a note with unsaved edits inside the viewer does not save it again', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await createVault(page);
  await page.evaluate(async () => (await import('/app/vault/vault.js')).vault.addNote({ title: 'Diary', body: 'day one' }));
  await card(page, 'Diary').locator('.vv-open').click();
  await expect(page.locator('.vw-note-body')).toHaveValue('day one');
  await page.fill('.vw-note-body', 'day one, edited');
  await page.locator('.vw-act-more').click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.locator('.vw-root')).toHaveCount(0);
  await expect(page.locator('.vv-card')).toHaveCount(0);
  await page.waitForTimeout(500);
  const names = await page.evaluate(async () => (await import('/app/vault/vault.js')).vault.items().map((i) => i.name));
  expect(names).toEqual(['Diary']); // the original, still undoable — not a re-saved copy
  await expect(page.locator('.toast', { hasText: 'Note saved' })).toHaveCount(0);
  await page.locator('.toast', { hasText: 'Deleted' }).getByRole('button', { name: 'Undo' }).click();
  await card(page, 'Diary').locator('.vv-open').click();
  await expect(page.locator('.vw-note-body')).toHaveValue('day one');
  await check();
});

test('multi-select Save without folder pickers: one Save button per decrypted copy', async ({ page }) => {
  const check = await watch(page);
  await page.addInitScript(() => {
    for (const name of ['showSaveFilePicker', 'showDirectoryPicker']) {
      try {
        Object.defineProperty(window, name, { value: undefined, configurable: true, writable: true });
      } catch {
        // not defined here
      }
    }
  });
  await openApp(page);
  await createVault(page);
  await addFiles(page, ['image.png', 'notes.txt']);
  await page.evaluate(async () => (await import('/app/vault/vault.js')).vault.addNote({ title: 'Plan: A/B', body: 'go' }));
  await page.click('.vv-selectbtn');
  await page.locator('.vv-selall').click();
  await expect(page.locator('.vv-selcount')).toHaveText('3 selected');
  await page.locator('.vv-selbar').getByRole('button', { name: 'Save' }).click();
  const dialog = page.locator('.modal', { hasText: '3 files ready' });
  await expect(dialog).toBeVisible();
  const got = [];
  for (let i = 0; i < 3; i++) {
    const [download] = await Promise.all([page.waitForEvent('download'), dialog.locator('.vv-ready-row .btn-primary:not(:disabled)').first().click()]);
    got.push(download.suggestedFilename());
  }
  expect(got.sort()).toEqual(['Plan_ A_B.txt', 'image.png', 'notes.txt']);
  await expect(dialog.locator('.vv-ready-row .btn-primary:disabled')).toHaveCount(3);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.vv-selbar')).toBeHidden();
  await check();
});

test.describe('tall window', () => {
  test.use({ viewport: { width: 1280, height: 1600 } });

  test('files dropped below the content (empty space at the bottom) still land in the vault', async ({ page }) => {
    const check = await watch(page);
    await openApp(page);
    await createVault(page);
    const png = readFileSync(path.join(FIX, 'image.png')).toString('base64');
    const inVault = await page.evaluate(async (b64) => {
      const target = document.elementFromPoint(640, 1560);
      if (!target?.closest('.vv')) return false;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'bottom.png', { type: 'image/png' }));
      for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      return true;
    }, png);
    expect(inVault).toBe(true);
    await expect(card(page, 'bottom.png')).toBeVisible({ timeout: 30_000 });
    await check();
  });
});

test('first run: "I have a backup" restores a .czb and opens the restored vault', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await createVault(page);
  await addFiles(page, ['image.png']);
  // A backup of this vault, then the vault is deleted: the device is back at the first-run screen.
  const b64 = await page.evaluate(async () => {
    const { vault } = await import('/app/vault/vault.js');
    const { name, stream } = await vault.exportBackup();
    const parts = [];
    for await (const c of stream) parts.push(c);
    const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await vault.destroy();
    return { name, data: btoa(s) };
  });
  await expect(page.locator('.vv-hero')).toBeVisible();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-choice="restore"]')]);
  await chooser.setFiles({ name: b64.name, mimeType: 'application/octet-stream', buffer: Buffer.from(b64.data, 'base64') });
  const dialog = page.locator('.modal', { hasText: 'Restore backup' });
  await expect(dialog).toBeVisible();
  await page.fill('input[name="czd-restore-pass"]', PASS);
  await dialog.getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('.vv-unlocked')).toBeVisible({ timeout: 30_000 });
  await expect(card(page, 'image.png')).toBeVisible();
  await check();
});

test('forgot it → delete vault and start over (typed DELETE) brings back the first-run screen', async ({ page }) => {
  const check = await watch(page);
  await openApp(page);
  await createVault(page);
  await addFiles(page, ['image.png']);
  await lock(page);
  await page.getByRole('button', { name: 'Forgot it?' }).click();
  await page.click('[data-choice="delete"]');
  const dialog = page.locator('.modal', { hasText: 'Delete this vault?' });
  const confirm = dialog.getByRole('button', { name: 'Delete vault' });
  await expect(confirm).toBeDisabled();
  await dialog.locator('input').fill('delete');
  await expect(confirm).toBeDisabled();
  await dialog.locator('input').fill('DELETE');
  await confirm.click();
  await expect(page.locator('.vv-hero')).toBeVisible({ timeout: 15_000 });
  expect(await status(page)).toBe('none');
  await check();
});
