// Legacy screen e2e (DESIGN §1.9, §3.8, §4.4): the old web vault seeded by tests/e2e/seed.html (summary counts,
// wrong/right PINs, previews, saving a decrypted copy, "Import all unlocked" into a new vault with byte-exact items
// and playlists → albums, deleting the old data), every old-message vector (v1–v4, web and desktop editions), the
// version badges and the q/y legend, and an old desktop .czd opened through the file chooser.
// Every test starts from a fresh browser context (fresh storage).
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WEB = JSON.parse(readFileSync(path.join(ROOT, 'tests/vectors/legacy-web-vectors.json'), 'utf8'));
const DESK = JSON.parse(readFileSync(path.join(ROOT, 'tests/vectors/legacy-desktop-vectors.json'), 'utf8'));
const RED_DOT = path.join(ROOT, 'tests/fixtures/legacy/red-dot.czd');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const FILES = [...WEB.files.single_real_constants, ...WEB.files.batched_reduced_constants.vectors];
const fileVec = (name) => FILES.find((f) => f.record.name === name);
const NOISE = new Set('†‡§¶※◊●○◦•⁕⁂✦✧✩✪⌘⌬⍟⏣⌖⎌⌀');

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

/** No FS Access pickers: saves go to a 'stage' target and end in a download. */
async function noPickers(page) {
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
    delete window.showDirectoryPicker;
  });
}

async function seedOldVault(page) {
  await page.goto('/tests/e2e/seed.html');
  await page.waitForFunction(() => window.__seeded);
  const r = await page.evaluate(() => window.__seeded);
  expect(r.error).toBeUndefined();
  return r;
}

async function openLegacy(page) {
  await page.goto('/#/legacy');
  await expect(page.locator('.lg-page')).toBeVisible();
}

async function createVault(page) {
  await page.evaluate(async () => {
    const { vault } = await import('/app/vault/vault.js');
    await vault.create('legacy e2e passphrase 1', { recovery: false, params: { m: 8192, t: 1, p: 1 } });
  });
}

const row = (page, name) => page.locator('.lg-oldvault .lg-item', { has: page.locator('.lg-item-text', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });

async function tryPin(page, pin) {
  await page.fill('input[name="czd-legacy-vault-pin"]', pin);
  await page.click('.lg-pin-go');
}

test('old web vault: counts, wrong and right PINs, previews, save, import all, playlists → albums, delete', async ({ page }) => {
  test.setTimeout(150_000);
  const check = await watch(page);
  await noPickers(page);
  const seeded = await seedOldVault(page);
  await openLegacy(page);
  const card = page.locator('.lg-oldvault');
  await expect(card).toBeVisible();
  await expect(card.locator('.lg-card-sub')).toContainText(`${seeded.vault} notes · ${seeded.files} files · ${seeded.playlists} playlists`);
  await expect(card.locator('.lg-item')).toHaveCount(seeded.vault + seeded.files);
  // The unencrypted note and the keyless v2 note need no PIN.
  await expect(card.locator('.lg-item[data-state="open"]')).toHaveCount(2);
  await expect(row(page, 'v3 thing').locator('.lg-tag')).toHaveText('best effort');

  await tryPin(page, 'nope');
  await expect(card.locator('.pass-err')).toContainText('didn’t open anything new');
  await expect(card.locator('.lg-item[data-state="open"]')).toHaveCount(2);

  await tryPin(page, 'pl-pin');
  await expect(card.locator('.lg-pin-status')).toContainText('Unlocked 2 items');
  await expect(row(page, 'Song One.mp3')).toHaveAttribute('data-state', 'open');
  await expect(row(page, 'song-two.ogg')).toHaveAttribute('data-state', 'open');
  for (const pin of ['vault-pin', '1234', 'chunky']) {
    await tryPin(page, pin);
    await expect(card.locator('.lg-pin-status')).toContainText('Unlocked');
  }
  await expect(row(page, 'snack plan')).toHaveAttribute('data-state', 'open');
  await expect(row(page, 'tiny.png')).toHaveAttribute('data-state', 'open');
  await expect(row(page, 'clip.mp4')).toHaveAttribute('data-state', 'open');
  await expect(row(page, 'My Notes.txt')).toHaveAttribute('data-state', 'locked');
  const unlockedCount = await card.locator('.lg-item[data-state="open"]').count();

  // Preview a note (read-only note mode) and an image file (random bytes in the vectors: honest "can't show").
  await row(page, 'snack plan').locator('.lg-act-preview').click();
  await expect(page.locator('.vw-root')).toHaveAttribute('data-mode', 'note');
  await expect(page.locator('.vw-note-body')).toHaveValue('meet at 6, bring snacks');
  await page.keyboard.press('Escape');
  await expect(page.locator('.vw-root')).toHaveCount(0);
  await row(page, 'tiny.png').locator('.lg-act-preview').click();
  await expect(page.locator('.vw-root')).toHaveAttribute('data-mode', 'image');
  await expect(page.locator('.vw-name')).toHaveText('tiny.png');
  await expect(page.locator('.vw-card-text')).toContainText("can't show .png");
  await page.keyboard.press('Escape');
  await expect(page.locator('.vw-root')).toHaveCount(0);

  // Save a decrypted copy (staged → download) and compare bytes with the vector.
  const [download] = await Promise.all([page.waitForEvent('download'), row(page, 'tiny.png').locator('.lg-act-save').click()]);
  expect(download.suggestedFilename()).toBe('tiny.png');
  expect(sha(readFileSync(await download.path()))).toBe(fileVec('tiny.png').expected_plaintext_sha256);

  // Import needs the new vault.
  await expect(page.locator('.lg-import-all')).toBeDisabled();
  await createVault(page);
  await expect(page.locator('.lg-import-all')).toBeEnabled();
  await expect(page.locator('.lg-import-all')).toContainText(`(${unlockedCount})`);
  await page.click('.lg-import-all');
  await expect(page.locator('.toast').filter({ hasText: `Imported ${unlockedCount} items` })).toBeVisible({ timeout: 60_000 });
  await expect(card.locator('.lg-item[data-state="imported"]')).toHaveCount(unlockedCount);
  await expect(page.locator('.lg-import-all')).toBeDisabled();

  const got = await page.evaluate(async () => {
    const { vault } = await import('/app/vault/vault.js');
    const { decryptSource, release } = await import('/app/crypto/container.js');
    const out = { items: {}, lists: vault.lists().map((l) => ({ name: l.name, names: l.itemIds.map((id) => vault.item(id).name) })) };
    for (const it of vault.items()) {
      const { src, opened } = await vault.open(it.id);
      const parts = [];
      for await (const p of decryptSource(src, opened)) parts.push(p);
      release(opened);
      const buf = await new Blob(parts).arrayBuffer();
      const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
      out.items[it.name] = { kind: it.kind, size: it.size, sha: hex, text: it.kind === 'note' ? new TextDecoder().decode(buf) : null };
    }
    out.done = await vault.kvGet('legacy-import-done');
    return out;
  });
  expect(Object.keys(got.items).length).toBe(unlockedCount);
  for (const name of ['tiny.png', 'Song One.mp3', 'song-two.ogg', 'clip.mp4', 'Track.flac']) {
    expect(got.items[name], name).toBeTruthy();
    expect(got.items[name].sha, name).toBe(fileVec(name).expected_plaintext_sha256);
  }
  expect(JSON.parse(got.items['snack plan'].text)).toMatchObject({ title: 'snack plan', body: 'meet at 6, bring snacks' });
  expect(got.items['v2 thing'].kind).toBe('note');
  // Playlists → albums (the dangling id of the old playlist is dropped).
  expect(got.lists).toEqual(expect.arrayContaining([
    { name: 'Road Trip _b_', names: ['Song One.mp3', 'song-two.ogg'] },
    { name: 'Vids', names: ['clip.mp4'] },
  ]));
  expect(got.done).toBe(true);
  expect(await page.evaluate(async () => (await import('/app/state.js')).get('legacy.importDone'))).toBe(true);

  // Delete old data: confirm (with the backup offer), then the section disappears and the database is gone.
  await page.click('.lg-delete-old');
  await expect(page.locator('.modal')).toContainText('Make a backup first?');
  await expect(page.locator('.modal').getByRole('button', { name: 'Back up first' })).toBeVisible();
  await page.locator('.modal').getByRole('button', { name: 'Delete old data' }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Old cZEROde 1 data deleted' })).toBeVisible();
  await expect(card).toBeHidden();
  const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  expect(dbs).not.toContain('czeroode_db');
  await check();
});

test('a lock forgets the old PINs and clears decoded output', async ({ page }) => {
  const check = await watch(page);
  await seedOldVault(page);
  await openLegacy(page);
  await tryPin(page, 'vault-pin');
  await expect(row(page, 'snack plan')).toHaveAttribute('data-state', 'open');
  await page.fill('#lg-msg', WEB.v4.vectors[0].ciphertext);
  await page.fill('input[name="czd-legacy-msg-pin"]', WEB.v4.vectors[0].pin);
  await page.click('.lg-decode');
  await expect(page.locator('.lg-out-text')).toHaveText(WEB.v4.vectors[0].plaintext);
  await createVault(page);
  await page.evaluate(async () => (await import('/app/vault/vault.js')).vault.lock('user'));
  await expect(page.locator('.lg-out-text')).toHaveCount(0);
  await expect(page.locator('#lg-msg')).toHaveValue('');
  await expect(row(page, 'snack plan')).toHaveAttribute('data-state', 'locked');
  await check();
});

test('no old data: the old web vault section stays hidden and nothing is created', async ({ page }) => {
  const check = await watch(page);
  await openLegacy(page);
  await expect(page.locator('.lg-msgs')).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.locator('.lg-oldvault')).toBeHidden();
  const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  expect(dbs).not.toContain('czeroode_db');
  await check();
});

/** Every message vector: [label, version, text, pin, expected]. */
function messageVectors() {
  const out = [];
  for (const v of WEB.v1.encode_decode) out.push(['web v1', 'v1', v.encoded, '', v.decoded_by_original]);
  for (const v of WEB.v1.decode_only) out.push(['web v1', 'v1', v.input, '', v.decoded_by_original]);
  // Noise characters in a plaintext can't come back (decodeV2 drops every noise code point): those check the wiring only.
  for (const v of WEB.v2.vectors) out.push(['web v2', 'v2', v.ciphertext, '', [...v.plaintext].some((c) => NOISE.has(c)) ? null : v.intended_output]);
  for (const v of WEB.v3.vectors) out.push(['web v3', 'v3', v.ciphertext, v.pin, v.original_decoder_output]);
  for (const v of WEB.v4.vectors) out.push(['web v4', 'v4', v.ciphertext, v.pin, v.plaintext]);
  for (const v of DESK.v4_text) out.push(['desktop v4', 'v4', v.ciphertext, v.pin, v.plaintext]);
  for (const v of DESK.legacy_text.v1) out.push(['desktop v1', 'v1', v.encoded, '', v.original_decT]);
  for (const v of DESK.legacy_text.v2) out.push(['desktop v2', 'v2', v.ciphertext, '', v.corrected_decode]);
  for (const v of DESK.legacy_text.v3) out.push(['desktop v3', 'v3', v.ciphertext, v.pin, v.original_v3sdec]);
  return out;
}

test('old messages: every v1/v2/v3/v4 vector decodes as expected', async ({ page }) => {
  test.setTimeout(150_000);
  const check = await watch(page);
  await openLegacy(page);
  const SEG = { v1: 'I', v2: 'II', v3: 'III', v4: 'IV' };
  const vecs = messageVectors();
  expect(vecs.length).toBeGreaterThan(80);
  let checked = 0;
  for (const [label, ver, text, pin, expected] of vecs) {
    await page.locator('.lg-msgs .seg-btn', { hasText: new RegExp(`^${SEG[ver]}$`) }).click();
    await page.fill('#lg-msg', text);
    if (pin) await page.fill('input[name="czd-legacy-msg-pin"]', pin);
    await page.click('.lg-decode');
    const out = page.locator('.lg-out-text');
    await expect(out).toHaveCount(1);
    await expect(page.locator('.lg-out')).toHaveAttribute('data-version', ver);
    const want = expected ?? await page.evaluate(async (s) => (await import('/app/legacy/mixed.js')).decodeV2(s).text, text);
    await expect.poll(() => out.evaluate((el) => el.textContent), { message: `${label}: ${text.slice(0, 30)}` }).toBe(want);
    if (expected !== null) checked++;
  }
  expect(checked).toBeGreaterThan(70);
  await check();
});

test('old messages: auto-detect badges, PIN errors, q/y note and the legend', async ({ page }) => {
  const check = await watch(page);
  await openLegacy(page);
  const badge = page.locator('.lg-detect .lg-ver');
  // v4 → IV "cZEROde v1 AES", needs a PIN; a wrong PIN is an inline error.
  const v4 = WEB.v4.vectors[0];
  await page.fill('#lg-msg', v4.ciphertext);
  await expect(badge).toHaveClass(/lg-ver-v4/);
  await expect(badge).toContainText('cZEROde v1 AES');
  await expect(page.locator('input[name="czd-legacy-msg-pin"]')).toBeVisible();
  await page.fill('input[name="czd-legacy-msg-pin"]', 'wrong');
  await page.click('.lg-decode');
  await expect(page.locator('.lg-msgs .pass-err')).toHaveText('Wrong PIN.');
  await page.fill('input[name="czd-legacy-msg-pin"]', v4.pin);
  await page.keyboard.press('Enter');
  await expect(page.locator('.lg-out-text')).toHaveText(v4.plaintext);
  // v2 → II "rip 💀", decodes as you type, no PIN.
  await page.fill('#lg-msg', WEB.v2.vectors[0].ciphertext);
  await expect(badge).toHaveClass(/lg-ver-v2/);
  await expect(badge).toContainText('rip 💀');
  await expect(page.locator('input[name="czd-legacy-msg-pin"]')).toBeHidden();
  await expect(page.locator('.lg-out-text')).toHaveText(WEB.v2.vectors[0].intended_output);
  await expect(page.locator('.lg-out-extra')).toContainText('Method');
  // v3 → III "old cipher".
  const v3 = WEB.v3.vectors.find((v) => v.ui_detects_as_ciphertext);
  await page.fill('#lg-msg', v3.ciphertext);
  await expect(badge).toHaveClass(/lg-ver-v3/);
  await expect(badge).toContainText('old cipher');
  await page.fill('input[name="czd-legacy-msg-pin"]', v3.pin);
  await page.click('.lg-decode');
  await expect(page.locator('.lg-out-text')).toHaveText(v3.original_decoder_output);
  // v1 → I "origin" with the q/y note (ყ is shared).
  await page.fill('#lg-msg', 'ყუიზ');
  await expect(badge).toContainText('origin');
  await expect(page.locator('.lg-out-text')).toHaveText('yuiz');
  await expect(page.locator('.lg-out-warn')).toContainText('q and y share a letter');
  // A new cZEROde message points to Text.
  await page.fill('#lg-msg', 'ჶაბგდ');
  await expect(page.locator('.lg-detect-new a')).toHaveAttribute('href', '#/text');
  // Legend chart: 26 letters, q and y marked as shared.
  await page.click('.lg-legend-sum');
  await expect(page.locator('.lg-cell')).toHaveCount(26);
  await expect(page.locator('.lg-cell-shared')).toHaveCount(2);
  await expect(page.locator('.lg-legend-note')).toContainText('q and y share a letter');
  await check();
});

test('old desktop .czd: file chooser → PIN → preview, save and import', async ({ page }) => {
  const check = await watch(page);
  await noPickers(page);
  await openLegacy(page);
  const vec = DESK.czd_files[0];
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.lg-czd-pick')]);
  expect(await chooser.element().evaluate((el) => el.accept)).toBe(''); // no accept filter
  await chooser.setFiles(RED_DOT);
  const item = page.locator('.lg-desktop .lg-item');
  await expect(item).toHaveAttribute('data-state', 'locked');
  await page.fill('input[name="czd-legacy-czd-pin"]', 'nope');
  await page.click('.lg-czd-open');
  await expect(item).toHaveAttribute('data-state', 'wrong');
  await page.fill('input[name="czd-legacy-czd-pin"]', vec.pin);
  await page.click('.lg-czd-open');
  await expect(item).toHaveAttribute('data-state', 'open');
  await expect(item.locator('.lg-item-text')).toHaveText('red-dot.png');
  // Preview: a real PNG shows in the viewer.
  await item.locator('.lg-act-preview').click();
  await expect(page.locator('.vw-root')).toHaveAttribute('data-mode', 'image');
  await expect.poll(() => page.locator('.vw-img').evaluate((img) => img.complete && img.naturalWidth)).toBe(1);
  await page.keyboard.press('Escape');
  // Save: the decrypted PNG bytes.
  const [download] = await Promise.all([page.waitForEvent('download'), item.locator('.lg-act-save').click()]);
  expect(download.suggestedFilename()).toBe('red-dot.png');
  expect(readFileSync(await download.path()).toString('base64')).toBe(vec.input.file_bytes_b64);
  // Import into a new vault.
  await createVault(page);
  await item.locator('.lg-act-import').click();
  await expect(page.locator('.toast').filter({ hasText: 'is in your vault now' })).toBeVisible();
  const names = await page.evaluate(async () => (await import('/app/vault/vault.js')).vault.items().map((i) => `${i.name}|${i.type}|${i.size}`));
  expect(names).toEqual(['red-dot.png|image/png|70']);
  await check();
});

test('old desktop .czd handed over through state legacy.files', async ({ page }) => {
  const check = await watch(page);
  await page.goto('/#/more');
  await expect(page.locator('.st-page-more')).toBeVisible();
  await page.evaluate(async (b64) => {
    const state = await import('/app/state.js');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    state.set('legacy.files', [new File([bytes], 'red-dot.czd')]);
    location.hash = '#/legacy';
  }, readFileSync(RED_DOT).toString('base64'));
  await expect(page.locator('.lg-desktop .lg-item')).toHaveAttribute('data-state', 'locked');
  expect(await page.evaluate(async () => (await import('/app/state.js')).get('legacy.files'))).toBeNull();
  await check();
});
