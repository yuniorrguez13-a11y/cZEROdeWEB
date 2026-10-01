// Text e2e (DESIGN §1.8, §1.11, §3.4): encrypt → decrypt round trip with the ciphertext coloured per script,
// auto-detection of the mode, a wrong passphrase, every legacy v4 vector (desktop + web editions) in Decrypt mode,
// the Mixed Script banner pointing to Legacy, the codzilla trigger, the weak-PIN skull only while encrypting, the
// size cap, "Save to vault as note" and a lock clearing the screen. Fresh browser context per test.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const vec = (n) => JSON.parse(readFileSync(path.join(ROOT, 'tests/vectors', n), 'utf8'));
const PASS = 'e2e correct horse battery';
const MESSAGE = 'Meet me at the old bridge at 9 ✓\nBring the blue notebook — and don’t tell anyone.';

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

async function openText(page) {
  await page.goto('/#/text');
  await expect(page.locator('.tx-card')).toBeVisible();
}

const msg = (page) => page.locator('.tx-msg');
const pass = (page) => page.locator('input[name="czd-text-pass"]');
const plainOut = (page) => page.locator('.tx-out-plain .tx-plain');

async function encrypt(page, message, passphrase) {
  await msg(page).fill(message);
  await pass(page).fill(passphrase);
  await page.click('.tx-go');
  await expect(page.locator('.tx-out-cipher')).toBeVisible({ timeout: 60_000 });
  return page.locator('.tx-cipher').textContent();
}

test('encrypt → decrypt round trip: coloured script, auto-detected mode, wrong passphrase', async ({ page }) => {
  const check = await watch(page);
  await openText(page);
  await msg(page).fill(MESSAGE);
  await expect(page.locator('.tx-chip')).toHaveAttribute('data-mode', 'encrypt');
  await expect(page.locator('.tx-go')).toHaveText('Encrypt');
  await expect(page.locator('.tx-status')).toHaveText('▶ Encrypting');
  const ct = await encrypt(page, MESSAGE, PASS);
  expect(ct.startsWith('ჶ')).toBe(true);
  expect(await page.locator('.tx-cipher .geo').count()).toBeGreaterThan(0);
  expect(await page.locator('.tx-cipher .cyr').count()).toBeGreaterThan(0);
  await expect(page.locator('.tx-out-cipher .copy-btn')).toBeVisible();

  // Paste the ciphertext back: the mode follows (marker → Decrypt) and the same passphrase opens it.
  await page.click('.tx-clear');
  await expect(msg(page)).toHaveValue('');
  await expect(page.locator('.tx-out-slot')).toBeEmpty();
  await msg(page).fill(ct);
  await expect(page.locator('.tx-chip')).toHaveAttribute('data-mode', 'decrypt');
  await expect(page.locator('.tx-chip')).toContainText('cZEROde message');
  await expect(page.locator('.tx-go')).toHaveText('Decrypt');
  await expect(page.locator('.tx-status')).toHaveText('◀ Decrypting');
  await pass(page).press('Enter');
  await expect.poll(() => plainOut(page).textContent(), { timeout: 60_000 }).toBe(MESSAGE);
  await expect(page.locator('.tx-note')).toHaveCount(0); // no unlocked vault

  // A wrong passphrase is reported on the field (key commitment: never a garbage message).
  await page.click('.tx-clear');
  await msg(page).fill(ct);
  await pass(page).fill(`${PASS}!`);
  await page.click('.tx-go');
  await expect(page.locator('.tx-card .pass-err')).toHaveText('Wrong passphrase. Capital letters matter; spaces at the ends are ignored.', { timeout: 60_000 });
  await expect(page.locator('.tx-out-slot')).toBeEmpty();
  await check();
});

test('every legacy v4 vector decrypts in Decrypt mode', async ({ page }) => {
  const check = await watch(page);
  const desktop = vec('legacy-desktop-vectors.json').v4_text.map((v) => ({ id: v.id, pin: v.pin, text: v.ciphertext, plain: v.plaintext }));
  const web = vec('legacy-web-vectors.json').v4.vectors.map((v, i) => ({ id: `web-${i}`, pin: v.pin, text: v.ciphertext, plain: v.plaintext }));
  const all = [...desktop, ...web];
  expect(all.length).toBe(16);
  await openText(page);
  await page.locator('.tx-bar .seg-btn', { hasText: 'Decrypt' }).click();
  await expect(page.locator('.tx-page')).toHaveAttribute('data-mode', 'decrypt');
  await expect(page.locator('.tx-card .pass-gen')).toBeHidden(); // Generate is for encrypting
  for (const v of all) {
    if (await page.locator('.tx-clear').isVisible()) await page.click('.tx-clear');
    await expect(page.locator('.tx-out-slot')).toBeEmpty();
    await msg(page).fill(v.text);
    await pass(page).fill(v.pin);
    await pass(page).press('Enter');
    await expect.poll(() => plainOut(page).textContent(), { timeout: 30_000, message: v.id }).toBe(v.plain);
    await expect(page.locator('.tx-out-plain .badge')).toHaveText('old v4');
  }
  // The skull never shows on a decrypt field, even for the old PIN "12345" of one vector.
  await expect(page.locator('.eg-modal')).toHaveCount(0);
  // A wrong PIN.
  await page.click('.tx-clear');
  await msg(page).fill(desktop[0].text);
  await pass(page).fill('9999');
  await pass(page).press('Enter');
  await expect(page.locator('.tx-card .pass-err')).toContainText('Wrong passphrase or PIN', { timeout: 30_000 });
  await check();
});

test('old Mixed Script is detected and pointed to Legacy', async ({ page }) => {
  const check = await watch(page);
  const v1 = vec('legacy-desktop-vectors.json').legacy_text.v1[0].encoded;
  await openText(page);
  await msg(page).fill(v1);
  const b = page.locator('.tx-mixed .banner');
  await expect(b).toContainText('This looks like old Mixed Script — open in Legacy →');
  await expect(page.locator('.tx-chip')).toHaveAttribute('data-mode', 'encrypt');
  await msg(page).fill('just a normal message');
  await expect(b).toHaveCount(0);
  await msg(page).fill(v1);
  await b.getByRole('button', { name: 'Open in Legacy' }).click();
  await expect(page).toHaveURL(/#\/legacy$/);
  // Legacy takes the hand-off (state 'legacy.text'): the message is in its box, detected, and the key is cleared.
  await expect(page.locator('#lg-msg')).toHaveValue(v1);
  await expect(page.locator('.lg-msgs')).toHaveAttribute('data-version', 'v1');
  await expect(page.locator('.lg-detect')).toContainText('Looks like');
  expect(await page.evaluate(async () => (await import('/app/state.js')).get('legacy.text') ?? null)).toBeNull();
  await check();
});

test('codzilla + Encrypt opens the Codzilla page', async ({ page }) => {
  const check = await watch(page);
  await openText(page);
  await msg(page).fill('CodZilla');
  await page.click('.tx-go');
  await expect(page).toHaveURL(/#\/codzilla$/);
  await check();
});

test('the weak-PIN skull and the weak warning only show while encrypting', async ({ page }) => {
  const check = await watch(page);
  await openText(page);
  await msg(page).fill('hello there');
  await pass(page).pressSequentially('1234');
  await expect(page.locator('.eg-modal')).toBeVisible();
  await page.getByRole('button', { name: 'ok fine' }).click();
  await expect(page.locator('.eg-modal')).toHaveCount(0);
  await expect(page.locator('.tx-card .pass-weak')).toBeVisible();

  await page.locator('.tx-bar .seg-btn', { hasText: 'Decrypt' }).click();
  await expect(page.locator('.tx-card .pass-weak')).toBeHidden();
  await expect(page.locator('.tx-card .meter')).toBeHidden();
  await pass(page).fill('');
  await pass(page).blur();
  await pass(page).focus();
  await pass(page).pressSequentially('123');
  await page.waitForTimeout(900);
  await expect(page.locator('.eg-modal')).toHaveCount(0);

  // Auto mode with a ciphertext-looking message is Decrypt too: no skull.
  await page.locator('.tx-bar .seg-btn', { hasText: 'Auto' }).click();
  await msg(page).fill(vec('legacy-desktop-vectors.json').v4_text[0].ciphertext);
  await expect(page.locator('.tx-chip')).toHaveAttribute('data-mode', 'decrypt');
  await pass(page).fill('');
  await pass(page).pressSequentially('12345');
  await page.waitForTimeout(900);
  await expect(page.locator('.eg-modal')).toHaveCount(0);
  await check();
});

test('a decrypted message is saved to the vault as a note; a lock clears the screen', async ({ page }) => {
  const check = await watch(page);
  await openText(page);
  await page.evaluate(async () => {
    const mod = await import('/app/vault/vault.js');
    for (let i = 0; i < 200 && (!mod.vault || mod.vault.status === 'loading'); i++) await new Promise((r) => setTimeout(r, 50));
    await mod.vault.create('vault pass for e2e', { params: { m: 64, t: 1, p: 1 }, recovery: false });
  });
  const ct = await encrypt(page, MESSAGE, PASS);
  await page.click('.tx-clear');
  await msg(page).fill(ct);
  await pass(page).press('Enter');
  await expect.poll(() => plainOut(page).textContent(), { timeout: 60_000 }).toBe(MESSAGE);
  await page.click('.tx-note');
  await expect(page.locator('.tx-note')).toHaveText('Saved to your vault');
  const note = await page.evaluate(async () => {
    const { vault } = await import('/app/vault/vault.js');
    const n = vault.items().find((i) => i.kind === 'note');
    return n ? { name: n.name, ...(await vault.readNote(n.id)) } : null;
  });
  expect(note).toEqual({ name: 'Meet me at the old bridge at 9 ✓', title: 'Meet me at the old bridge at 9 ✓', body: MESSAGE });

  // Over the cap: a clear message instead of a frozen tab.
  await page.click('.tx-clear');
  await page.locator('.tx-bar .seg-btn', { hasText: 'Encrypt' }).click();
  await msg(page).evaluate((el) => {
    el.value = 'x'.repeat(2 ** 20 + 1);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('.tx-count')).toContainText('too long');
  await page.click('.tx-go');
  await expect(page.locator('.tx-error')).toContainText('too long');

  // Lock: message, output and passphrase are gone; the mode goes back to Auto.
  await msg(page).fill('secret draft');
  await page.click('.sh-lock');
  await expect(msg(page)).toHaveValue('');
  await expect(pass(page)).toHaveValue('');
  await expect(page.locator('.tx-out-slot')).toBeEmpty();
  await expect(page.locator('.tx-bar .seg-btn[aria-checked="true"]')).toHaveText('Auto');
  await check();
});
