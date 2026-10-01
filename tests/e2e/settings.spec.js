// Settings / About / More e2e (DESIGN §1.10, §3.5, §3.7, §4.3, §6, §12): the theme persists across a reload, change
// passphrase, recovery code create → lock → recovery unlock, backup export (staged download) → delete vault →
// restore (replace), merges that skip duplicates (same vault and another vault's backup), restore with a recovery
// code, the storage section, the About page's web-origin warning, and the More menu.
// Every test starts from a fresh browser context (fresh storage).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BACKUP = path.join(ROOT, 'tests/vectors/backup-v1.czb');
const BACKUP_INFO = JSON.parse(readFileSync(path.join(ROOT, 'tests/vectors/backup-v1.json'), 'utf8'));
const PASS = 'settings e2e passphrase 1';
const NEW_PASS = 'a brand new passphrase 22';
const LIGHT = { m: 8192, t: 1, p: 1 };

/** Page errors and CSP violations; checked at the end of every test. */
async function watch(page, { allowCsp = [] } = {}) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return async () => {
    const csp = (await page.evaluate(() => window.__csp ?? []).catch(() => [])).filter((v) => !allowCsp.includes(v));
    expect([...errors, ...csp]).toEqual([]);
  };
}

async function noPickers(page) {
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
    delete window.showDirectoryPicker;
  });
}

async function openSettings(page) {
  await page.goto('/#/settings');
  await expect(page.locator('.st-page-settings')).toBeVisible();
}

/** Creates the vault in the page (light KDF parameters keep the test fast) and adds notes. */
async function createVault(page, { recovery = false, notes = [] } = {}) {
  return page.evaluate(async ({ pass, params, recovery, notes }) => {
    const { vault } = await import('/app/vault/vault.js');
    const r = await vault.create(pass, { recovery, params });
    for (const title of notes) await vault.addNote({ title, body: `body of ${title}` });
    return r.recoveryCode;
  }, { pass: PASS, params: LIGHT, recovery, notes });
}

const itemNames = (page) => page.evaluate(async () => (await import('/app/vault/vault.js')).vault.items().map((i) => i.name).sort());
const vaultStatus = (page) => page.evaluate(async () => (await import('/app/vault/vault.js')).vault.status);
const lockVault = (page) => page.evaluate(async () => (await import('/app/vault/vault.js')).vault.lock('user'));
const toast = (page, text) => page.locator('.toast').filter({ hasText: text });

test('theme cards switch the theme live and it persists across a reload', async ({ page }) => {
  const check = await watch(page);
  await openSettings(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'gothic');
  await expect(page.locator('.st-theme')).toHaveCount(3);
  await expect(page.locator('.st-theme-on')).toHaveAttribute('data-theme', 'gothic');
  await page.locator('.st-theme[data-theme="minimal-white"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'minimal-white');
  await expect(page.locator('.st-theme-on')).toHaveAttribute('data-theme', 'minimal-white');
  await page.reload();
  await expect(page.locator('.st-page-settings')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'minimal-white');
  await expect(page.locator('.st-theme-on')).toHaveAttribute('data-theme', 'minimal-white');
  // Keyboard: arrows move within the radio group.
  await page.locator('.st-theme[data-theme="minimal-white"] input').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'minimal-black');
  expect(await page.evaluate(() => localStorage.getItem('czd2.theme'))).toBe('"minimal-black"');
  await check();
});

test('security settings are stored', async ({ page }) => {
  const check = await watch(page);
  await openSettings(page);
  await page.locator('#st-security .seg[aria-label="Lock after inactivity"] .seg-btn', { hasText: '15 min' }).click();
  await page.locator('#st-security .seg[aria-label="Lock when in the background"] .seg-btn', { hasText: 'At once' }).click();
  await page.locator('#st-security .seg[aria-label="Clear copied secrets"] .seg-btn', { hasText: 'Off' }).click();
  await page.getByRole('switch', { name: 'Keep music playing in the background' }).click();
  const stored = await page.evaluate(() => ['idleLockMin', 'hiddenLock', 'clipboardClearSec', 'keepAudioWhenHidden'].map((k) => localStorage.getItem(`czd2.${k}`)));
  expect(stored).toEqual(['15', '"immediate"', '0', 'false']);
  await expect(page.locator('#st-security')).toContainText("JavaScript can't guarantee every secret is wiped from memory");
  await check();
});

test('change passphrase, then the new one unlocks and the old one does not', async ({ page }) => {
  const check = await watch(page);
  await openSettings(page);
  await createVault(page);
  await expect(page.locator('.st-status')).toContainText('Unlocked');
  await page.click('.st-change');
  const dlg = page.locator('.st-change-modal');
  await expect(dlg).toContainText('If someone may know your old passphrase AND has a copy of your vault or a backup');
  await page.fill('input[name="czd-change-old"]', 'not my passphrase');
  await page.fill('input[name="czd-change-new"]', NEW_PASS);
  await page.fill('input[name="czd-change-confirm"]', `${NEW_PASS}x`);
  await expect(dlg.locator('.st-reason')).toContainText("don't match");
  await expect(dlg.locator('.st-change-go')).toBeDisabled();
  await page.fill('input[name="czd-change-confirm"]', NEW_PASS);
  await expect(dlg.locator('.st-change-go')).toBeEnabled();
  await dlg.locator('.st-change-go').click();
  await expect(dlg.locator('.pass-err:visible')).toHaveText('Wrong passphrase. Capital letters matter; spaces at the ends are ignored.');
  await page.fill('input[name="czd-change-old"]', PASS);
  await page.keyboard.press('Enter');
  await expect(toast(page, 'Passphrase changed')).toBeVisible();
  await expect(dlg).toHaveCount(0);
  const r = await page.evaluate(async (arg) => {
    const { vault } = await import('/app/vault/vault.js');
    vault.lock('user');
    let oldOk = true;
    try {
      await vault.unlock(arg.old);
    } catch (e) {
      oldOk = e.code;
    }
    await vault.unlock(arg.next);
    return { oldOk, status: vault.status };
  }, { old: PASS, next: NEW_PASS });
  expect(r).toEqual({ oldOk: 'wrong-passphrase', status: 'unlocked' });
  await check();
});

test('recovery code: create → lock → unlock with the code; replace and remove', async ({ page }) => {
  const check = await watch(page);
  await openSettings(page);
  await createVault(page, { recovery: false });
  await expect(page.locator('.st-rec-badge')).toHaveText('Off');
  await page.click('.st-rec-create');
  await page.fill('input[name="czd-confirm-pass"]', 'wrong one');
  await page.click('.st-pass-go');
  await expect(page.locator('.modal .pass-err:visible')).toContainText('Wrong passphrase');
  await page.fill('input[name="czd-confirm-pass"]', PASS);
  await page.click('.st-pass-go');
  const rec = page.locator('.st-recovery-modal');
  await expect(rec).toBeVisible();
  await expect(rec.locator('.st-code-group')).toHaveCount(8);
  await expect(rec).toContainText('Anyone with this code can open your vault.');
  const code = (await rec.locator('.st-code-group').allTextContents()).join('-');
  expect(code).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
  await rec.getByRole('button', { name: 'I saved it' }).click();
  await expect(rec).toHaveCount(0);
  await expect(page.locator('.st-rec-badge')).toHaveText('On');
  const r = await page.evaluate(async (arg) => {
    const { vault } = await import('/app/vault/vault.js');
    vault.lock('user');
    await vault.unlockWithRecovery(arg.code, arg.next);
    const s1 = vault.status;
    vault.lock('user');
    await vault.unlock(arg.next);
    return [s1, vault.status];
  }, { code, next: NEW_PASS });
  expect(r).toEqual(['unlocked', 'unlocked']);
  // Replace: the old code stops working.
  await page.click('.st-rec-create');
  await page.fill('input[name="czd-confirm-pass"]', NEW_PASS);
  await page.click('.st-pass-go');
  await expect(rec.locator('.st-code-group')).toHaveCount(8);
  const code2 = (await rec.locator('.st-code-group').allTextContents()).join('-');
  expect(code2).not.toBe(code);
  await rec.getByRole('button', { name: 'I saved it' }).click();
  // Remove.
  await page.click('.st-rec-remove');
  await page.fill('input[name="czd-confirm-pass"]', NEW_PASS);
  await page.click('.st-pass-go');
  await expect(toast(page, 'Recovery code removed')).toBeVisible();
  await expect(page.locator('.st-rec-badge')).toHaveText('Off');
  expect(await page.evaluate(async () => (await import('/app/vault/vault.js')).vault.hasRecovery)).toBe(false);
  await check();
});

test('backup export (staged download) → delete vault → restore from the file → items back', async ({ page }) => {
  test.setTimeout(120_000);
  const check = await watch(page);
  await noPickers(page);
  await openSettings(page);
  await createVault(page, { notes: ['alpha', 'beta', 'gamma'] });
  await expect(page.locator('.st-row-storage')).toContainText('3 items');
  await page.click('.st-export');
  const dlg = page.locator('.st-backup-modal');
  await expect(dlg.locator('.st-job[data-state="done"]')).toBeVisible({ timeout: 30_000 });
  await expect(dlg).toContainText('Backup ready');
  const [download] = await Promise.all([page.waitForEvent('download'), dlg.locator('.st-save-backup').click()]);
  expect(download.suggestedFilename()).toMatch(/^czerode-backup-\d{8}\.czb$/);
  const bytes = readFileSync(await download.path());
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x43, 0x5a, 0x42, 0x0d, 0x0a, 0x1a, 0x0a]);
  await dlg.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('#st-vault')).toContainText('Last backup today');

  // Delete the vault (typed DELETE).
  await page.click('.st-delete');
  const confirm = page.locator('.modal');
  await expect(confirm.getByRole('button', { name: 'Delete vault' })).toBeDisabled();
  await confirm.locator('input').fill('DELETE');
  await confirm.getByRole('button', { name: 'Delete vault' }).click();
  await expect(toast(page, 'Vault deleted')).toBeVisible();
  await expect(page.locator('.st-status')).toContainText('No vault yet');
  expect(await vaultStatus(page)).toBe('none');

  // Restore (replace) from the downloaded file.
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.st-restore')]);
  await chooser.setFiles({ name: download.suggestedFilename(), mimeType: 'application/octet-stream', buffer: bytes });
  const rdlg = page.locator('.st-restore-modal');
  await expect(rdlg).toContainText('Restore backup');
  await expect(rdlg.locator('.st-fact', { hasText: 'Items' })).toContainText('3');
  await page.fill('input[name="czd-restore-pass"]', 'wrong passphrase');
  await rdlg.locator('.st-restore-go').click();
  await expect(rdlg.locator('.pass-err:visible')).toContainText('Wrong passphrase');
  await page.fill('input[name="czd-restore-pass"]', PASS);
  await rdlg.locator('.st-restore-go').click();
  await expect(toast(page, 'Restored 3 items')).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/#\/vault$/);
  expect(await vaultStatus(page)).toBe('unlocked');
  expect(await itemNames(page)).toEqual(['alpha', 'beta', 'gamma']);
  expect(await page.evaluate(async () => {
    const { vault } = await import('/app/vault/vault.js');
    return vault.readNote(vault.items().find((i) => i.name === 'beta').id);
  })).toEqual({ title: 'beta', body: 'body of beta' });
  await check();
});

test('merge restore skips duplicates: the same vault and another vault’s backup', async ({ page }) => {
  test.setTimeout(120_000);
  const check = await watch(page);
  await noPickers(page);
  await openSettings(page);
  await createVault(page, { notes: ['one', 'two'] });
  // Same vault: export, add one more, merge → nothing new.
  await page.click('.st-export');
  const dlg = page.locator('.st-backup-modal');
  const [download] = await Promise.all([page.waitForEvent('download'), dlg.locator('.st-save-backup').click()]);
  const own = readFileSync(await download.path());
  await dlg.getByRole('button', { name: 'Done' }).click();
  await page.evaluate(async () => (await import('/app/vault/vault.js')).vault.addNote({ title: 'three', body: '3' }));
  let [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.st-restore')]);
  await chooser.setFiles({ name: 'own.czb', mimeType: 'application/octet-stream', buffer: own });
  const rdlg = page.locator('.st-restore-modal');
  await expect(rdlg).toContainText('Merge backup');
  await expect(rdlg.locator('.st-czb .badge')).toContainText('This vault');
  await expect(rdlg.locator('input[name="czd-restore-pass"]')).toHaveCount(0); // same vault: no secret
  await rdlg.locator('.st-restore-go').click();
  await expect(toast(page, 'Nothing new — 2 items already in your vault')).toBeVisible({ timeout: 30_000 });
  expect(await itemNames(page)).toEqual(['one', 'three', 'two']);

  // Another vault's backup (golden vector): its passphrase → every item added; a second merge adds nothing.
  [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.st-restore')]);
  await chooser.setFiles(BACKUP);
  await expect(rdlg).toContainText('Merge backup');
  await expect(rdlg.locator('.st-fact', { hasText: 'Items' })).toContainText(String(BACKUP_INFO.items.length));
  await page.fill('input[name="czd-restore-pass"]', BACKUP_INFO.passphrase);
  await rdlg.locator('.st-restore-go').click();
  await expect(toast(page, `Merged ${BACKUP_INFO.items.length} items`)).toBeVisible({ timeout: 60_000 });
  expect((await itemNames(page)).length).toBe(3 + BACKUP_INFO.items.length);
  [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.st-restore')]);
  await chooser.setFiles(BACKUP);
  // With the recovery code this time.
  await rdlg.locator('.seg-btn', { hasText: 'Recovery code' }).click();
  await page.fill('input[name="czd-restore-code"]', BACKUP_INFO.recoveryCode.toLowerCase());
  await rdlg.locator('.st-restore-go').click();
  await expect(toast(page, `Nothing new — ${BACKUP_INFO.items.length} items already in your vault`)).toBeVisible({ timeout: 60_000 });
  expect((await itemNames(page)).length).toBe(3 + BACKUP_INFO.items.length);
  await check();
});

test('restore with the recovery code sets a new passphrase', async ({ page }) => {
  test.setTimeout(120_000);
  // The golden backup's thumbnail is stub bytes (scripts/gen-backup-vector.mjs), not a JPEG: the vault grid shown after
  // the restore makes Chromium refetch that blob: URL, which the CSP refuses. Real thumbnails are always real JPEGs.
  const check = await watch(page, { allowCsp: ['connect-src blob'] });
  await openSettings(page);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.st-restore')]);
  await chooser.setFiles(BACKUP);
  const rdlg = page.locator('.st-restore-modal');
  await expect(rdlg).toContainText('Restore backup');
  await rdlg.locator('.seg-btn', { hasText: 'Recovery code' }).click();
  await page.fill('input[name="czd-restore-code"]', 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH');
  // Generated words need the "I saved it" tick (as when creating a vault).
  await rdlg.locator('.pass-gen').click();
  await expect(rdlg.locator('.st-check')).toBeVisible();
  await rdlg.locator('.st-restore-go').click();
  await expect(rdlg.locator('.st-error')).toContainText('I saved it');
  await page.fill('input[name="czd-restore-new"]', 'short');
  await expect(rdlg.locator('.st-check')).toBeHidden();
  await rdlg.locator('.st-restore-go').click();
  await expect(rdlg.locator('.st-error')).toContainText('at least 10 characters');
  await page.fill('input[name="czd-restore-new"]', NEW_PASS);
  await rdlg.locator('.st-restore-go').click();
  await expect(rdlg.locator('.pass-err:visible')).toContainText("doesn't open this backup");
  await page.fill('input[name="czd-restore-code"]', BACKUP_INFO.recoveryCode);
  await rdlg.locator('.st-restore-go').click();
  await expect(toast(page, `Restored ${BACKUP_INFO.items.length} items`)).toBeVisible({ timeout: 60_000 });
  const r = await page.evaluate(async (pass) => {
    const { vault } = await import('/app/vault/vault.js');
    vault.lock('user');
    await vault.unlock(pass);
    return vault.items().length;
  }, NEW_PASS);
  expect(r).toBe(BACKUP_INFO.items.length);
  await check();
});

test('a backup can’t be restored over a locked vault; not-a-backup files are refused', async ({ page }) => {
  const check = await watch(page);
  await openSettings(page);
  await createVault(page);
  await lockVault(page);
  await expect(page.locator('.st-status')).toContainText('Locked');
  let [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.st-restore')]);
  await chooser.setFiles(BACKUP);
  await expect(page.locator('.modal')).toContainText('Unlock your vault first to merge this backup');
  await page.locator('.modal .modal-actions').getByRole('button', { name: 'Close' }).click();
  [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.st-restore')]);
  await chooser.setFiles({ name: 'nope.czb', mimeType: 'application/octet-stream', buffer: Buffer.from('not a backup at all') });
  await expect(toast(page, 'not a cZEROde backup')).toBeVisible();
  await check();
});

test('storage section renders; Keep my data asks the browser', async ({ page }) => {
  const check = await watch(page);
  await openSettings(page);
  await expect(page.locator('#st-vault')).toContainText('No vault yet');
  await createVault(page, { notes: ['n'] });
  const storage = page.locator('.st-row-storage');
  await expect(storage.locator('.storage')).toBeVisible();
  await expect(storage).toContainText('1 item');
  await expect(storage.locator('.storage-track')).toBeVisible();
  const keep = page.locator('.st-keep');
  if (await keep.count()) {
    await keep.click();
    await expect(page.locator('.toast')).toBeVisible();
  }
  await expect(page.locator('#st-security .st-value')).toHaveText(/^~[\d,]+ ms$/);
  await check();
});

test('About page: plain-language security model with the web-origin warning', async ({ page }) => {
  const check = await watch(page);
  await page.goto('/#/about');
  await expect(page.locator('.st-page-about')).toBeVisible();
  const origin = page.locator('.st-origin');
  await expect(origin).toContainText('Every GitHub Pages site of this account shares https://yuniorrguez13-a11y.github.io.');
  await expect(origin).toContainText('Never publish another GitHub Pages project from this account. The desktop app is not affected.');
  await expect(page.locator('.st-page-about')).toContainText('What it can’t protect against');
  await expect(page.locator('.st-page-about')).toContainText('Only a .czb backup survives that.');
  await expect(page.locator('.sh-tab.active')).toHaveText('More');
  await check();
});

test('More menu: every card goes where it says', async ({ page }) => {
  const check = await watch(page);
  await page.goto('/#/more');
  await expect(page.locator('.st-page-more')).toBeVisible();
  await expect(page.locator('.st-foot-ver')).toContainText('2.0.0');
  await expect(page.locator('[data-more="update"]')).toBeHidden(); // desktop only
  for (const [id, hash, sel] of [['settings', '#/settings', '.st-page-settings'], ['legacy', '#/legacy', '.lg-page'], ['about', '#/about', '.st-page-about'], ['codzilla', '#/codzilla', '.cz-page']]) {
    await page.locator(`[data-more="${id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${hash.replace('/', '\\/')}$`));
    await expect(page.locator(sel)).toBeVisible();
    await page.goto('/#/more');
    await expect(page.locator('.st-page-more')).toBeVisible();
  }
  await page.locator('[data-more="tour"]').click();
  await expect(page.locator('.tu-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.tu-modal')).toHaveCount(0);
  const install = page.locator('[data-more="install"]');
  await expect(install).toBeVisible();
  await install.click();
  await expect(page.locator('.st-install-modal')).toContainText('Install cZEROde');
  await page.locator('.st-install-modal').getByRole('button', { name: 'Got it' }).click();
  await check();
});

test('backup dialog: a double click keeps it, an unsaved staged backup asks first, focus comes back', async ({ page }) => {
  test.setTimeout(90_000);
  const check = await watch(page);
  await noPickers(page);
  await openSettings(page);
  await createVault(page, { notes: ['one'] });
  const exportBtn = page.locator('.st-export');
  await expect(exportBtn).toBeEnabled();
  await exportBtn.dblclick();
  const dlg = page.locator('.st-backup-modal');
  await expect(dlg.locator('.st-job[data-state="done"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.st-backup-modal')).toHaveCount(1);
  // Done (or Esc) without saving: a warning first, then "Discard" really closes.
  await dlg.locator('.st-backup-done').click();
  await expect(dlg.locator('.st-unsaved')).toBeVisible();
  await expect(dlg.locator('.st-backup-done')).toHaveText('Discard');
  await expect(dlg.locator('.st-save-backup')).toBeFocused();
  const [download] = await Promise.all([page.waitForEvent('download'), dlg.locator('.st-save-backup').click()]);
  expect(download.suggestedFilename()).toMatch(/^czerode-backup-\d{8}\.czb$/);
  await expect(dlg.locator('.st-unsaved')).toBeHidden();
  await expect(dlg.locator('.st-backup-done')).toHaveText('Done');
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('.st-export')).toBeFocused();

  // Esc while it runs = Cancel; a second export can start afterwards.
  await page.locator('.st-export').click();
  await expect(page.locator('.st-backup-modal')).toHaveCount(1);
  await page.keyboard.press('Escape');
  // Either it was still running (Esc cancelled it) or it had finished (Esc asks about the unsaved file first).
  await expect.poll(async () => (await page.locator('.st-backup-modal').count()) === 0
    || page.locator('.st-backup-modal .st-unsaved').isVisible()).toBe(true);
  if (await page.locator('.st-backup-modal').count()) await page.keyboard.press('Escape');
  await expect(page.locator('.st-backup-modal')).toHaveCount(0);
  await check();
});

test('keyboard: focus survives the recovery code and passphrase dialogs; double clicks keep dialogs open', async ({ page }) => {
  const check = await watch(page);
  await openSettings(page);
  await createVault(page);
  await page.locator('.st-rec-create').focus();
  await page.keyboard.press('Enter');
  await page.fill('input[name="czd-confirm-pass"]', PASS);
  await page.keyboard.press('Enter');
  const rec = page.locator('.st-recovery-modal');
  await expect(rec.getByRole('button', { name: 'I saved it' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(rec).toHaveCount(0);
  await expect(page.locator('.st-rec-create')).toBeFocused();
  await expect(page.locator('.st-rec-create')).toHaveText('Replace code');
  // Remove: its button goes away, focus lands on "Create code".
  await page.locator('.st-rec-remove').focus();
  await page.keyboard.press('Enter');
  await page.fill('input[name="czd-confirm-pass"]', PASS);
  await page.keyboard.press('Enter');
  await expect(toast(page, 'Recovery code removed')).toBeVisible();
  await expect(page.locator('.st-rec-create')).toBeFocused();
  // A double click opens the dialog and leaves it open.
  await page.locator('.st-change').dblclick();
  await page.waitForTimeout(600);
  await expect(page.locator('.st-change-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.st-change')).toBeFocused();
  await page.locator('.st-delete').dblclick();
  await page.waitForTimeout(600);
  await expect(page.locator('.modal')).toContainText('Delete vault?');
  await page.keyboard.press('Escape');
  await check();
});

test('the section index follows the scroll; an update waiting for a lock says so', async ({ page }) => {
  const check = await watch(page);
  await openSettings(page);
  await createVault(page);
  await expect(page.locator('.st-toc-link.active')).toHaveAttribute('data-target', 'appearance');
  await page.locator('.st-toc-link[data-target="app"]').click();
  await expect(page.locator('.st-toc-link.active')).toHaveAttribute('data-target', 'app');
  await expect(page.locator('#st-app-title')).toBeFocused();
  await page.locator('#st-vault').scrollIntoViewIfNeeded();
  await page.evaluate(() => document.getElementById('st-vault').scrollIntoView({ block: 'start' }));
  await expect(page.locator('.st-toc-link.active')).toHaveAttribute('data-target', 'vault');
  await page.evaluate(async () => (await import('/app/state.js')).set('sw.updateReady', true));
  const upd = page.locator('.st-update');
  await expect(upd).toHaveText('Update after lock');
  await upd.click();
  await expect(toast(page, 'installs as soon as you lock')).toBeVisible();
  await check();
});
