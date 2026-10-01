// Integration-phase checks across views (DESIGN §1.5, §1.7, §3.7, §7, §12): hover fills only on devices that hover
// (no "stuck" highlight after a tap on a touch screen), toast layout with a long unbroken name on a phone, the
// Incoming list emptied by a lock, a backup that counts only once it was really saved (staged: the Save tap; a
// picked file: when the write finished), and album toasts that never show a name once the vault locked.
import { test, expect } from '@playwright/test';

const PASS = 'integration e2e passphrase';
const LIGHT = { m: 8192, t: 1, p: 1 };

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

const vaultStatus = (page) => page.evaluate(async () => (await import('/app/vault/vault.js')).vault?.status ?? null);

async function createVault(page, notes = []) {
  await expect.poll(() => vaultStatus(page), { timeout: 20_000 }).toBe('none');
  await page.evaluate(async ({ pass, params, notes }) => {
    const { vault } = await import('/app/vault/vault.js');
    await vault.create(pass, { recovery: false, params });
    for (const title of notes) await vault.addNote({ title, body: `body of ${title}` });
  }, { pass: PASS, params: LIGHT, notes });
}

/** A .btn-primary (+ a twin that is never touched) appended to the page, for computed-style comparisons. */
async function addButtons(page) {
  await page.evaluate(async () => {
    const { h } = await import('/app/util/dom.js');
    const box = h('div', { id: 'hv-box', class: 'row' },
      h('button', { type: 'button', class: 'btn btn-primary', id: 'hv-tap', text: 'Tap me' }),
      h('button', { type: 'button', class: 'btn btn-primary', id: 'hv-twin', text: 'Twin' }),
      h('button', { type: 'button', class: 'chip', id: 'hv-chip', text: 'Chip' }),
      h('button', { type: 'button', class: 'chip', id: 'hv-chip-twin', text: 'Chip twin' }));
    box.style.position = 'fixed';
    box.style.top = '80px';
    box.style.left = '16px';
    box.style.zIndex = '500';
    document.body.append(box);
  });
}

const look = (page, sel) => page.evaluate((s) => {
  const cs = getComputedStyle(document.querySelector(s));
  return { bg: cs.backgroundColor, border: cs.borderTopColor, color: cs.color };
}, sel);

test.describe('touch screen', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('a tap leaves no hover fill behind (buttons, chips); the drop area of Send is not highlighted', async ({ page }) => {
    const check = await watch(page);
    await page.goto('/#/send');
    await expect(page.locator('.sd-drop').first()).toBeVisible();
    expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(false);
    await addButtons(page);
    await page.tap('#hv-tap');
    await page.tap('#hv-chip');
    // (the pointer stays "over" the last tapped element: :hover matches, the fill must not apply)
    expect(await look(page, '#hv-chip')).toEqual(await look(page, '#hv-chip-twin'));
    await page.tap('#hv-tap');
    expect(await look(page, '#hv-tap')).toEqual(await look(page, '#hv-twin'));
    const drop = page.locator('.sd-drop').first();
    const before = await look(page, '.sd-drop');
    await drop.tap({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Escape').catch(() => {});
    expect(await look(page, '.sd-drop')).toEqual(before);
    await check();
  });

  test('a toast with a long unbroken name keeps its action button on screen', async ({ page }) => {
    const check = await watch(page);
    await page.goto('/#/more');
    await expect(page.locator('#app')).toBeVisible();
    await page.evaluate(async () => {
      const { toast } = await import('/app/util/dom.js');
      toast(`Deleted “${'W'.repeat(60)}.png”`, { timeout: 0, action: { label: 'Undo', onClick() {} } });
    });
    const t = page.locator('.toast').last();
    await expect(t).toBeVisible();
    const vw = page.viewportSize().width;
    const toastBox = await t.boundingBox();
    const action = await t.locator('.toast-action').boundingBox();
    expect(toastBox.x).toBeGreaterThanOrEqual(0);
    expect(toastBox.x + toastBox.width).toBeLessThanOrEqual(vw + 0.5);
    expect(action.x).toBeGreaterThanOrEqual(toastBox.x);
    expect(action.x + action.width).toBeLessThanOrEqual(toastBox.x + toastBox.width + 0.5);
    expect(action.height).toBeLessThan(48); // "Undo" on one line
    await t.locator('.toast-action').tap();
    await expect(page.locator('.toast')).toHaveCount(0);
    await check();
  });
});

test('desktop: hover fills still apply where a pointer hovers', async ({ page }) => {
  const check = await watch(page);
  await page.goto('/#/more');
  await expect(page.locator('#app')).toBeVisible();
  expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(true);
  await addButtons(page);
  const twin = await look(page, '#hv-twin');
  await page.hover('#hv-tap');
  await expect.poll(async () => (await look(page, '#hv-tap')).bg).not.toBe(twin.bg);
  await check();
});

test('the Incoming list is emptied by a lock: no names stay on screen', async ({ page }) => {
  const check = await watch(page);
  await page.goto('/#/send');
  await expect(page.locator('.sd-page')).toBeVisible();
  await page.evaluate(async () => {
    const state = await import('/app/state.js');
    const { navigate } = await import('/app/router.js');
    state.set('incoming.files', [new File(['hello'], 'holiday-secret.txt', { type: 'text/plain' }), new File(['x'], 'tax-return.pdf', { type: 'application/pdf' })]);
    navigate('#/incoming');
  });
  const panel = page.locator('.sd-incoming');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('holiday-secret.txt');
  await expect(panel).toContainText('tax-return.pdf');
  // No vault here: an idle purge is this tab's whole lock (it clears Send/Text secrets — and the list).
  await page.evaluate(async () => (await import('/app/state.js')).purge('idle'));
  await expect(panel).toBeHidden();
  await expect(page.locator('body')).not.toContainText('holiday-secret.txt');
  // Coming back to Send does not bring them back.
  await page.goto('/#/text');
  await page.goto('/#/send');
  await expect(page.locator('.sd-page')).toBeVisible();
  await expect(page.locator('.sd-incoming')).toBeHidden();
  await check();
});

test('a staged backup counts only when saved: Discard leaves "Never backed up", Save backup sets it', async ({ page }) => {
  test.setTimeout(120_000);
  const check = await watch(page);
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
    delete window.showDirectoryPicker;
  });
  await page.goto('/#/settings');
  await expect(page.locator('.st-page-settings')).toBeVisible();
  await createVault(page, ['one']);
  await expect(page.locator('#st-vault')).toContainText('Never backed up');
  const lastBackupAt = () => page.evaluate(async () => (await import('/app/vault/vault.js')).vault.lastBackupAt);

  await page.click('.st-export');
  const dlg = page.locator('.st-backup-modal');
  await expect(dlg.locator('.st-job[data-state="done"]')).toBeVisible({ timeout: 30_000 });
  expect(await lastBackupAt()).toBeNull(); // the file exists only in this tab so far
  await dlg.locator('.st-backup-done').click();
  await expect(dlg.locator('.st-backup-done')).toHaveText('Discard');
  await dlg.locator('.st-backup-done').click();
  await expect(dlg).toHaveCount(0);
  expect(await lastBackupAt()).toBeNull();
  await expect(page.locator('#st-vault')).toContainText('Never backed up');

  await page.click('.st-export');
  await expect(dlg.locator('.st-job[data-state="done"]')).toBeVisible({ timeout: 30_000 });
  expect(await lastBackupAt()).toBeNull();
  const [download] = await Promise.all([page.waitForEvent('download'), dlg.locator('.st-save-backup').click()]);
  expect(download.suggestedFilename()).toMatch(/\.czb$/);
  await expect.poll(lastBackupAt).not.toBeNull();
  await dlg.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('#st-vault')).toContainText('Last backup today');
  await check();
});

test('a backup written to a picked file counts when the write finished (no Save step)', async ({ page }) => {
  test.setTimeout(120_000);
  const check = await watch(page);
  await page.addInitScript(() => {
    window.__written = 0;
    window.__closed = false;
    // A save picker that hands out an in-memory file handle (desktop Chromium's FS Access shape).
    window.showSaveFilePicker = async () => ({
      name: 'my-backup.czb',
      async createWritable() {
        return {
          async write(chunk) {
            window.__written += chunk.byteLength ?? chunk.size ?? 0;
          },
          async close() {
            window.__closed = true;
          },
          async abort() {},
        };
      },
    });
  });
  await page.goto('/#/settings');
  await expect(page.locator('.st-page-settings')).toBeVisible();
  await createVault(page, ['one', 'two']);
  await page.click('.st-export');
  const dlg = page.locator('.st-backup-modal');
  await expect(dlg.locator('.st-job[data-state="done"]')).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => window.__closed)).toBe(true);
  expect(await page.evaluate(() => window.__written)).toBeGreaterThan(0);
  await expect(dlg.locator('.st-save-backup')).toHaveCount(0);
  await expect.poll(() => page.evaluate(async () => (await import('/app/vault/vault.js')).vault.lastBackupAt)).not.toBeNull();
  await dlg.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('#st-vault')).toContainText('Last backup today');
  await check();
});

test('album toasts never show an album name once the vault locked during the save', async ({ page }) => {
  const check = await watch(page);
  await page.goto('/#/more');
  await createVault(page, ['n1']);
  await page.evaluate(async () => {
    const { vault } = await import('/app/vault/vault.js');
    const real = vault.createList.bind(vault);
    // The lock lands while the album is being saved (between the await and the toast).
    vault.createList = async (o) => {
      const l = await real(o);
      vault.lock('user');
      return l;
    };
    const A = await import('/app/ui/albums.js');
    window.__made = A.createAlbumDialog({ vault, itemIds: [] });
  });
  const input = page.locator('.modal input');
  await input.fill('Top Secret Trip');
  await input.press('Enter');
  await page.evaluate(() => window.__made);
  expect(await vaultStatus(page)).toBe('locked');
  await page.waitForTimeout(300);
  // Checked once, not polled (a toast would go away by itself after a few seconds).
  expect(await page.locator('.toast').allTextContents()).not.toContain('Album “Top Secret Trip” created.');
  expect(await page.evaluate(() => document.body.textContent.includes('Top Secret Trip'))).toBe(false);
  await check();
});
