// Send · Open e2e (DESIGN §1.7, §3.6, §5.1, §12): lock one file with the pickers removed (staged output → Save →
// download) and open that .czd in #/open (wrong passphrase, preview, save, byte-compared); three files → one bundle
// → open shows three entries → "Add all to my vault" creates an album named after the bundle; a vault item handed
// over through state 'send.pending'; the FS Access path with picker stubs returning OPFS handles (one output via
// showSaveFilePicker, three via showDirectoryPicker) whose bytes open again; the cZEROde 1 desktop .czd vector with
// its PIN; the PWA share target (#/incoming) and a lock clearing everything. Fresh browser context per test.
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as precache } from '../../scripts/precache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIX = path.join(ROOT, 'tests/fixtures');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const fixture = (n) => readFileSync(path.join(FIX, n));
const RANDOM_CZD = /^cz-[a-z2-7]{8}\.czd$/;
const MAGIC = [0x89, 0x43, 0x5a, 0x44, 0x0d, 0x0a, 0x1a, 0x0a];

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

/** Desktop Chromium without FS Access pickers: chooseSaveTarget stages the outputs (the mobile/Firefox/Safari path). */
async function noPickers(page) {
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
    delete window.showDirectoryPicker;
  });
}

async function openSend(page, hash = '#/send') {
  await page.goto(`/${hash}`);
  await expect(page.locator('.sd-card-lock')).toBeVisible();
}

/** Creates (and unlocks) a vault in the page with test-speed KDF parameters. */
async function createVault(page) {
  await page.evaluate(async () => {
    const mod = await import('/app/vault/vault.js'); // live binding: the singleton appears once boot ran
    for (let i = 0; i < 200 && (!mod.vault || mod.vault.status === 'loading'); i++) await new Promise((r) => setTimeout(r, 50));
    await mod.vault.create('vault pass for e2e', { params: { m: 64, t: 1, p: 1 }, recovery: false });
  });
  await expect.poll(() => page.evaluate(async () => (await import('/app/state.js')).get('vault.status'))).toBe('unlocked');
}

async function pickToLock(page, names) {
  const btn = page.locator('.sd-pick, .sd-add').first();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), btn.click()]);
  await chooser.setFiles(names.map((n) => path.join(FIX, n)));
  await expect(page.locator('.sd-file')).toHaveCount(names.length);
}

/** Lock & save (staged): returns the passphrase and the saved .czd. */
async function lockStaged(page, outputs = 1) {
  await page.click('.sd-go');
  await expect(page.locator('.sd-result')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.sd-output')).toHaveCount(outputs);
  const pass = (await page.locator('.sd-result .sd-pass .sd-phrase-text').textContent()).trim();
  expect(pass.split('-')).toHaveLength(6);
  const files = [];
  for (let i = 0; i < outputs; i++) {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.sd-save').nth(i).click()]);
    const buffer = readFileSync(await dl.path());
    files.push({ name: dl.suggestedFilename(), buffer });
  }
  return { pass, files };
}

async function chooseToOpen(page, file) {
  await page.evaluate(() => {
    location.hash = '#/open';
  });
  await expect(page.locator('.sd-focus-open')).toBeVisible();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.sd-pick-open')]);
  await chooser.setFiles({ name: file.name, mimeType: 'application/octet-stream', buffer: file.buffer });
}

async function unlockWith(page, pass, field = 'czd-open-pass') {
  await page.fill(`input[name="${field}"]`, pass);
  await page.click('.sd-unlock');
}

/** Clicks a decrypted-save button and returns the downloaded bytes (staged: saved at once, or via "Ready to save"). */
async function saveDecryptedFrom(page, button) {
  const download = page.waitForEvent('download', { timeout: 30_000 });
  await page.locator(button).click();
  const ready = page.locator('.sd-ready .btn-primary');
  const winner = await Promise.race([download.then(() => 'download'), ready.waitFor({ timeout: 30_000 }).then(() => 'ready')]);
  if (winner === 'ready') await ready.first().click();
  const dl = await download;
  return { name: dl.suggestedFilename(), buffer: readFileSync(await dl.path()) };
}

/** Opens bytes in the page with container.openSource and returns meta + plaintext sha256 of each entry. */
function openInPage(page, buffer, pass) {
  return page.evaluate(async ({ b64, pass }) => {
    const C = await import('/app/crypto/container.js');
    const { blobSource } = await import('/app/util/stream.js');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const src = blobSource(new Blob([bytes]));
    const opened = await C.openSource(src, { passphrase: pass });
    const hex = async (u8) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', u8))].map((x) => x.toString(16).padStart(2, '0')).join('');
    const read = async (entry) => {
      const parts = [];
      for await (const p of C.decryptSource(src, opened, { entry })) parts.push(p);
      return hex(await new Blob(parts).arrayBuffer());
    };
    const out = { name: opened.meta.name, type: opened.meta.type, isBundle: opened.isBundle, mtime: opened.meta.mtime ?? null, entries: [], entryMtimes: [] };
    if (opened.isBundle) {
      for (const e of opened.meta.entries) {
        out.entries.push({ name: e.name, sha: await read({ off: e.off, size: e.size }) });
        out.entryMtimes.push(e.mtime ?? null);
      }
    }
    else out.sha = await read();
    C.release(opened);
    return out;
  }, { b64: buffer.toString('base64'), pass });
}

test('lock one file (staged) → open it in #/open: wrong passphrase, preview, save', async ({ page }) => {
  const check = await watch(page);
  await noPickers(page);
  await openSend(page);
  await pickToLock(page, ['image.png']);
  await expect(page.locator('.sd-summary')).toContainText('1 file → 1 .czd file');
  const { pass, files: [czd] } = await lockStaged(page);
  expect(czd.name).toMatch(RANDOM_CZD);
  expect([...czd.buffer.subarray(0, 8)]).toEqual(MAGIC);
  await expect(page.locator('.sd-output-name')).toHaveText(czd.name);
  await expect(page.locator('.sd-quote')).toContainText('#/open');

  await chooseToOpen(page, czd);
  await expect(page.locator('.sd-open-pass')).toBeVisible();
  await expect(page.locator('.sd-card-open .sd-chip-name')).toHaveText(czd.name);
  await unlockWith(page, `${pass}x`);
  await expect(page.locator('.sd-card-open .pass-err')).toHaveText('Wrong passphrase. Capital letters matter; spaces at the ends are ignored.', { timeout: 30_000 });
  await unlockWith(page, `  ${pass}  `); // ends are trimmed (§3.1)
  const entry = page.locator('.sd-entry-single');
  await expect(entry.locator('.sd-entry-name')).toHaveText('image.png', { timeout: 30_000 });
  await expect(entry.locator('.sd-entry-meta')).toContainText('Photo');
  await expect(entry.locator('.sd-thumb-img')).toBeVisible();
  await expect(entry.locator('.sd-act-add')).toHaveCount(0); // no unlocked vault

  await entry.locator('.sd-act-preview').click();
  const img = page.locator('.vw-root .vw-img');
  await expect(img).toBeVisible();
  expect(await img.evaluate((el) => el.src.startsWith('blob:') && el.naturalWidth > 0)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('.vw-root')).toHaveCount(0);

  const saved = await saveDecryptedFrom(page, '.sd-entry-single .sd-act-save');
  expect(saved.name).toBe('image.png');
  expect(sha(saved.buffer)).toBe(sha(fixture('image.png')));

  // A lock (here: idle purge without a vault) drops the open file and the Lock card's passphrase/result.
  await page.evaluate(async () => (await import('/app/state.js')).purge('idle'));
  await expect(page.locator('.sd-card-open')).toHaveAttribute('data-phase', 'empty');
  await expect(page.locator('.sd-card-lock')).toHaveAttribute('data-phase', 'empty');
  await check();
});

test('three files → one bundle → open shows three entries → add all to my vault creates the album', async ({ page }) => {
  const check = await watch(page);
  await noPickers(page);
  await openSend(page);
  await createVault(page);
  await pickToLock(page, ['image.png', 'notes.txt', 'audio.webm']);
  await expect(page.locator('.sd-summary')).toContainText('3 files → one .czd bundle');
  // Show the real name: the .czd is called "3 files.czd" and the album is named after it.
  await page.locator('[data-opt="sendHideName"] input').uncheck();
  const { pass, files: [czd] } = await lockStaged(page);
  expect(czd.name).toBe('3 files.czd');
  expect(await page.evaluate(() => localStorage.getItem('czd2.sendHideName'))).toBe('false');

  const inPage = await openInPage(page, czd.buffer, pass);
  expect(inPage.isBundle).toBe(true);
  expect(inPage.entries).toEqual(['image.png', 'notes.txt', 'audio.webm'].map((n) => ({ name: n, sha: sha(fixture(n)) })));
  expect(inPage.entryMtimes).toEqual([null, null, null]); // "Keep file dates" is off

  await chooseToOpen(page, czd);
  await unlockWith(page, pass);
  const rows = page.locator('.sd-entries-bundle .sd-entry');
  await expect(rows).toHaveCount(3, { timeout: 30_000 });
  await expect(rows.locator('.sd-entry-name')).toHaveText(['image.png', 'notes.txt', 'audio.webm']);
  await expect(page.locator('.sd-bundle-bar .sd-label')).toContainText('3 files');

  await page.click('.sd-add-all');
  await expect(page.locator('.toast', { hasText: 'Added 3 files to your vault' })).toBeVisible({ timeout: 60_000 });
  const vaultState = await page.evaluate(async () => {
    const { vault } = await import('/app/vault/vault.js');
    const items = vault.items();
    return { lists: vault.lists().map((l) => ({ name: l.name, items: l.itemIds.map((id) => items.find((i) => i.id === id)?.name).sort() })), count: items.length };
  });
  expect(vaultState.count).toBe(3);
  expect(vaultState.lists).toEqual([{ name: '3 files', items: ['audio.webm', 'image.png', 'notes.txt'] }]);
  await check();
});

test('a vault item handed over through send.pending is sent as a .czd', async ({ page }) => {
  const check = await watch(page);
  await noPickers(page);
  await page.goto('/#/vault');
  await createVault(page);
  const id = await page.evaluate(async () => {
    const { vault } = await import('/app/vault/vault.js');
    const bytes = await (await fetch('/tests/fixtures/image.png')).arrayBuffer();
    const info = await vault.addFile(new File([bytes], 'beach.png', { type: 'image/png', lastModified: 1767225600000 }));
    const state = await import('/app/state.js');
    state.set('send.pending', { itemIds: [info.id] });
    location.hash = '#/send';
    return info.id;
  });
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  await expect(page.locator('.sd-card-lock .sd-label').first()).toHaveText('From your vault · 1');
  await expect(page.locator('.sd-file-name')).toHaveText('beach.png');
  expect(await page.evaluate(async () => (await import('/app/state.js')).get('send.pending'))).toBe(null);
  await page.locator('[data-opt="sendKeepDates"] input').check();
  const { pass, files: [czd] } = await lockStaged(page);
  expect(czd.name).toMatch(RANDOM_CZD);
  const opened = await openInPage(page, czd.buffer, pass);
  expect(opened).toMatchObject({ name: 'beach.png', type: 'image/png', isBundle: false, mtime: 1767225600000, sha: sha(fixture('image.png')) });

  // The passphrase can be kept in the vault as a note.
  await page.click('.sd-note');
  await expect(page.locator('.sd-note')).toHaveText('Saved to your vault');
  const note = await page.evaluate(async () => {
    const { vault } = await import('/app/vault/vault.js');
    const n = vault.items().find((i) => i.kind === 'note');
    return n ? (await vault.readNote(n.id)).body : null;
  });
  expect(note).toContain(`Passphrase: ${pass}`);
  await check();
});

test('FS Access pickers (OPFS stubs): one output via the save picker, three via the folder picker', async ({ page }) => {
  const check = await watch(page);
  await page.addInitScript(() => {
    const dir = async (name) => (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
    window.__pickers = [];
    window.showSaveFilePicker = async (opts) => {
      window.__pickers.push(['save', opts?.suggestedName]);
      return (await dir('e2e-save')).getFileHandle(opts.suggestedName, { create: true });
    };
    window.showDirectoryPicker = async () => {
      window.__pickers.push(['dir']);
      return dir('e2e-dir');
    };
  });
  const readDir = (name) => page.evaluate(async (d) => {
    const handle = await (await navigator.storage.getDirectory()).getDirectoryHandle(d);
    const out = [];
    for await (const [n, h] of handle.entries()) out.push({ name: n, b64: btoa(String.fromCharCode(...new Uint8Array(await (await h.getFile()).arrayBuffer()))) });
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }, name);

  await openSend(page);
  await pickToLock(page, ['image.png']);
  await page.click('.sd-go');
  await expect(page.locator('.sd-result')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.sd-output .badge')).toHaveText('Saved');
  await expect(page.locator('.sd-save')).toHaveCount(0);
  const pass1 = (await page.locator('.sd-result .sd-pass .sd-phrase-text').textContent()).trim();
  const one = await readDir('e2e-save');
  expect(one).toHaveLength(1);
  expect(one[0].name).toMatch(RANDOM_CZD);
  expect(await openInPage(page, Buffer.from(one[0].b64, 'base64'), pass1)).toMatchObject({ name: 'image.png', sha: sha(fixture('image.png')) });

  await page.click('.sd-again');
  await pickToLock(page, ['image.png', 'notes.txt', 'doc.pdf']);
  await page.locator('[data-opt="sendOnePerFile"] input').check();
  await expect(page.locator('.sd-summary')).toContainText('3 files → 3 .czd files');
  await page.click('.sd-go');
  await expect(page.locator('.sd-output')).toHaveCount(3, { timeout: 60_000 });
  const pass3 = (await page.locator('.sd-result .sd-pass .sd-phrase-text').textContent()).trim();
  expect(pass3).not.toBe(pass1);
  const three = await readDir('e2e-dir');
  expect(three).toHaveLength(3);
  const got = [];
  for (const f of three) {
    expect(f.name).toMatch(RANDOM_CZD);
    const o = await openInPage(page, Buffer.from(f.b64, 'base64'), pass3);
    got.push({ name: o.name, sha: o.sha });
  }
  expect(got.sort((a, b) => (a.name < b.name ? -1 : 1))).toEqual(['doc.pdf', 'image.png', 'notes.txt'].map((n) => ({ name: n, sha: sha(fixture(n)) })));
  expect(await page.evaluate(() => window.__pickers.map((p) => p[0]))).toEqual(['save', 'dir']);
  await check();
});

test('a cZEROde 1 desktop .czd opens with its PIN', async ({ page }) => {
  const check = await watch(page);
  await noPickers(page);
  const vectors = JSON.parse(readFileSync(path.join(ROOT, 'tests/vectors/legacy-desktop-vectors.json'), 'utf8'));
  const v = vectors.czd_files.find((x) => x.id === 'czd-1-red-dot');
  await openSend(page, '#/open');
  await chooseToOpen(page, { name: v.expected.saved_filename, buffer: Buffer.from(v.expected.file_text, 'utf8') });
  await expect(page.locator('.sd-card-open .label')).toHaveText('PIN');
  await expect(page.locator('.sd-card-open .sd-chip-meta')).toContainText('cZEROde 1 file');
  await unlockWith(page, '0000', 'czd-legacy-pass');
  await expect(page.locator('.sd-card-open .pass-err')).toHaveText('Wrong PIN.', { timeout: 30_000 });
  await unlockWith(page, v.pin, 'czd-legacy-pass');
  const entry = page.locator('.sd-entry-single');
  await expect(entry.locator('.sd-entry-name')).toHaveText('red-dot.png', { timeout: 30_000 });
  await entry.locator('.sd-act-preview').click();
  await expect(page.locator('.vw-root .vw-img')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.vw-root')).toHaveCount(0);
  const saved = await saveDecryptedFrom(page, '.sd-entry-single .sd-act-save');
  expect(saved.name).toBe('red-dot.png');
  expect(saved.buffer.toString('base64')).toBe(v.input.file_bytes_b64);
  await check();
});

test('#/incoming: files from the share target are listed; a locked one opens, a plain one goes to Lock', async ({ page, context, baseURL }) => {
  if (precache({ check: true }).stale) throw new Error('sw-assets.js is stale: run `node scripts/precache.mjs` first');
  const golden = JSON.parse(readFileSync(path.join(ROOT, 'tests/vectors/czd2/czd2.json'), 'utf8'));
  const batch = golden.vectors.find((x) => x.id === 'batch-0');
  await page.goto('/');
  await page.evaluate(async () => {
    (await import('/app/pwa.js')).registerServiceWorker();
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  // Submit like the OS share sheet (a navigation POST to ./share-target); the app then loads in that tab.
  const sharer = await context.newPage();
  const check = await watch(sharer);
  await sharer.setContent(`<form method="post" enctype="multipart/form-data" action="${baseURL}/share-target">
    <input type="file" name="files" multiple><button type="submit">share</button></form>`);
  await sharer.setInputFiles('input[type=file]', [
    { name: 'from-chat.czd', mimeType: 'application/octet-stream', buffer: readFileSync(path.join(ROOT, 'tests/vectors/czd2', batch.file)) },
    { name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('hello from the share sheet') },
  ]);
  await Promise.all([sharer.waitForURL(/#\/incoming/), sharer.click('button')]);
  const rows = sharer.locator('.sd-incoming .sd-in-row');
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  await expect(sharer).toHaveURL(/#\/incoming$/); // the share id is consumed
  await expect(rows.nth(0).locator('.sd-in-meta')).toContainText('Locked file');
  await expect(rows.nth(1).locator('.sd-in-name')).toHaveText('hello.txt');

  await rows.nth(1).getByRole('button', { name: 'Lock to send' }).click();
  await expect(sharer.locator('.sd-card-lock .sd-file-name')).toHaveText('hello.txt');
  await rows.nth(0).getByRole('button', { name: 'Open' }).click();
  await expect(sharer.locator('.sd-incoming')).toBeHidden();
  await unlockWith(sharer, batch.passphrase);
  await expect(sharer.locator('.sd-entry-single .sd-entry-name')).toHaveText(batch.meta.name, { timeout: 60_000 });
  await check();
});
