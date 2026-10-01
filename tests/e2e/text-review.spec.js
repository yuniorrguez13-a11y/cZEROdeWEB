// Text review e2e (DESIGN §1.8, §1.11, §3.10): an output belongs to the message and passphrase it was made from
// (editing either drops it; a run whose input changed meanwhile shows nothing), the Mixed Script banner shows in
// every mode, "Save to vault as note" saves once however often it is clicked, and the Legacy hand-off of an old
// message is cleared by a lock. Fresh browser context per test.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const vec = (n) => JSON.parse(readFileSync(path.join(ROOT, 'tests/vectors', n), 'utf8'));
const PASS = 'e2e correct horse battery';

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

const msg = (page) => page.locator('.tx-msg');
const pass = (page) => page.locator('input[name="czd-text-pass"]');

async function openText(page) {
  await page.goto('/#/text');
  await expect(page.locator('.tx-card')).toBeVisible();
}

async function encrypt(page, message) {
  await msg(page).fill(message);
  await pass(page).fill(PASS);
  await page.click('.tx-go');
  await expect(page.locator('.tx-out-cipher')).toBeVisible({ timeout: 60_000 });
  return page.locator('.tx-cipher').textContent();
}

test('editing the message or the passphrase drops the output made from the old one', async ({ page }) => {
  const check = await watch(page);
  await openText(page);
  const ct = await encrypt(page, 'first draft');
  await msg(page).press('End');
  await msg(page).pressSequentially(', fixed');
  await expect(page.locator('.tx-out-slot')).toBeEmpty();

  await page.click('.tx-clear');
  await msg(page).fill(ct);
  await pass(page).press('Enter');
  await expect(page.locator('.tx-plain')).toHaveText('first draft', { timeout: 60_000 });
  await pass(page).press('End');
  await pass(page).pressSequentially('!');
  await expect(page.locator('.tx-out-slot')).toBeEmpty();
  await check();
});

test('a message edited while it is being encrypted shows no stale result', async ({ page }) => {
  const check = await watch(page);
  await openText(page);
  await msg(page).fill('original message');
  await pass(page).fill(PASS);
  await page.click('.tx-go');
  await expect(page.locator('.tx-go')).toBeDisabled();
  await msg(page).press('End');
  await msg(page).pressSequentially('!');
  await expect(page.locator('.tx-go')).toBeEnabled({ timeout: 60_000 });
  await page.waitForTimeout(300);
  await expect(page.locator('.tx-out-slot')).toBeEmpty();
  await check();
});

test('the old Mixed Script banner also shows in Decrypt mode', async ({ page }) => {
  const check = await watch(page);
  await openText(page);
  await page.locator('.tx-bar .seg-btn', { hasText: 'Decrypt' }).click();
  await msg(page).fill(vec('legacy-desktop-vectors.json').legacy_text.v1[0].encoded);
  await expect(page.locator('.tx-mixed .banner')).toContainText('old Mixed Script');
  await check();
});

test('"Save to vault as note" saves one note however often it is clicked', async ({ page }) => {
  const check = await watch(page);
  await openText(page);
  await page.evaluate(async () => {
    const mod = await import('/app/vault/vault.js');
    for (let i = 0; i < 200 && (!mod.vault || mod.vault.status === 'loading'); i++) await new Promise((r) => setTimeout(r, 50));
    await mod.vault.create('vault pass for e2e', { params: { m: 64, t: 1, p: 1 }, recovery: false });
  });
  const ct = await encrypt(page, 'note me once');
  await page.click('.tx-clear');
  await msg(page).fill(ct);
  await pass(page).press('Enter');
  await expect(page.locator('.tx-plain')).toHaveText('note me once', { timeout: 60_000 });
  await page.locator('.tx-note').dblclick();
  await expect(page.locator('.tx-note')).toHaveText('Saved to your vault');
  await page.waitForTimeout(500);
  const notes = await page.evaluate(async () => (await import('/app/vault/vault.js')).vault.items().filter((i) => i.kind === 'note').length);
  expect(notes).toBe(1);
  await check();
});

test('a lock clears the old message handed to Legacy', async ({ page }) => {
  const check = await watch(page);
  await openText(page);
  await msg(page).fill(vec('legacy-desktop-vectors.json').legacy_text.v1[0].encoded);
  await page.locator('.tx-mixed .banner').getByRole('button', { name: 'Open in Legacy' }).click();
  await expect(page).toHaveURL(/#\/legacy$/);
  await expect(page.locator('#lg-msg')).not.toHaveValue('');
  await page.evaluate(async () => (await import('/app/state.js')).purge('user'));
  expect(await page.evaluate(async () => (await import('/app/state.js')).get('legacy.text') ?? null)).toBeNull();
  await expect(page.locator('#lg-msg')).toHaveValue('');
  await check();
});
