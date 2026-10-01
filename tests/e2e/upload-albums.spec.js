// Import queue and albums e2e (DESIGN §1.5, §10, §12): ui/upload.js and ui/albums.js in the real app shell.
// The page gets a small harness with what the vault view wires to these modules: "Add files"/"Add folder" buttons
// (pickAndImport, so the pickers open from real clicks), a drop zone (components.dropZone → importFiles) and the
// album strip whose cards open the album editor. It sits on the #/codzilla route so no other view under
// construction is involved. The tests after "in the real vault view" run inside the vault view itself (toolbar,
// lock page, album route, phone selection toolbar). Vaults are created with tiny KDF parameters.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FX = (n) => path.join(ROOT, 'tests/fixtures', n);
const PASS = 'correct horse battery staple';
const MiB = 2 ** 20;

/** Page errors and CSP violations. */
async function watch(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return errors;
}

/** Fresh unlocked vault + the harness. window.__handoffs records state 'incoming.files' / 'legacy.files'. */
async function openVault(page) {
  await page.goto('/#/codzilla');
  await expect.poll(() => page.evaluate(async () => {
    const m = await import('/app/vault/vault.js');
    return m.vault?.status ?? null;
  }), { timeout: 20000 }).toBe('none');
  await page.evaluate(async (pass) => {
    const { vault } = await import('/app/vault/vault.js');
    await vault.create(pass, { params: { m: 64, t: 1, p: 1 }, recovery: false });
    const state = await import('/app/state.js');
    window.__handoffs = [];
    for (const key of ['incoming.files', 'legacy.files']) {
      state.on(key, (v) => {
        if (v) window.__handoffs.push({ key, names: v.map((f) => f.name) });
      });
    }
    const { h } = await import('/app/util/dom.js');
    const { dropZone } = await import('/app/ui/components.js');
    const U = await import('/app/ui/upload.js');
    const A = await import('/app/ui/albums.js');
    Object.assign(window, { __U: U, __A: A, __vault: vault });
    const drop = h('div', { class: 'dropzone', id: 'up-drop' }, h('span', { text: 'Drop files here' }));
    dropZone(drop, { folders: true, onFiles: (files, { folders }) => {
      window.__dropped = U.importFiles({ vault, files, folders });
    } });
    const strip = A.albumStrip({ vault, onOpen: (id) => A.albumEditor({ vault, id }) });
    const root = h('div', {
      id: 'up-harness',
      style: { position: 'fixed', top: '64px', left: '8px', width: '720px', maxHeight: '420px', overflow: 'auto', zIndex: '115', background: 'var(--bg)', padding: '8px' },
    },
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', id: 'up-add', text: 'Add files', on: { click: () => {
        window.__picked = U.pickAndImport({ vault });
      } } }),
      h('button', { type: 'button', class: 'btn', id: 'up-add-folder', text: 'Add folder', on: { click: () => {
        window.__picked = U.pickAndImport({ vault, folder: true });
      } } })),
    drop,
    strip);
    document.body.append(root);
    // In-page helpers
    window.__fx = async (name, as = name, type) => {
      const buf = await (await fetch(`/tests/fixtures/${name}`)).arrayBuffer();
      return new File([buf], as, { type: type ?? (name.endsWith('.png') ? 'image/png' : name.endsWith('.txt') ? 'text/plain' : '') });
    };
    // Big files are one 1 MiB chunk repeated (cheap in memory; the sandbox disk is small, so they stay small too).
    const chunk = new Uint8Array(2 ** 20).map((_, i) => (i * 7 + 3) & 255);
    window.__big = (mb, name) => new File(Array(mb).fill(chunk), name, { type: 'application/octet-stream' });
    window.__drop = (files) => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      const el = document.getElementById('up-drop');
      el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    };
    /** Runs fn() once the named file's row reports progress (in-page, so a fast import can't slip past). */
    window.__whenRunning = (name, fn) => new Promise((resolve) => {
      const tick = () => {
        for (const row of document.querySelectorAll('.up-row[data-state="running"]')) {
          const bar = row.querySelector('.up-row-bar');
          if (row.querySelector('.up-row-name')?.textContent === name && Number(bar?.getAttribute('aria-valuenow')) >= 1) {
            resolve(fn(row));
            return;
          }
        }
        setTimeout(tick, 1);
      };
      tick();
    });
  }, PASS);
}

const items = (page) => page.evaluate(() => window.__vault.items().map((i) => i.name).sort());

test('imports several picked files with per-file progress; the queue dock survives a route change', async ({ page }) => {
  const errors = await watch(page);
  await openVault(page);
  await page.evaluate(() => {
    window.__seen = { pct: 0, status: [] };
    new MutationObserver(() => {
      for (const b of document.querySelectorAll('.up-row-bar')) window.__seen.pct = Math.max(window.__seen.pct, Number(b.getAttribute('aria-valuenow')) || 0);
      for (const s of document.querySelectorAll('.up-row[data-state="running"] .up-row-status')) window.__seen.status.push(s.textContent);
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#up-add');
  const fc = await chooser;
  expect(fc.isMultiple()).toBe(true);
  await fc.setFiles([FX('image.png'), FX('notes.txt'), FX('doc.pdf'), FX('large.jpg'), FX('audio.webm')]);
  const dock = page.locator('.up-dock');
  await expect(dock).toBeVisible();
  await expect(dock.locator('.up-row')).toHaveCount(5);
  await page.evaluate(() => {
    location.hash = '#/text';
  });
  await expect(dock).toHaveAttribute('data-state', 'done', { timeout: 30000 });
  await expect(dock).toBeVisible();
  await expect(dock.locator('.up-title')).toHaveText('Import done');
  await expect(dock.locator('.up-status')).toHaveText('5 files added');
  await expect(dock.locator('.up-row[data-state="done"]')).toHaveCount(5);
  await expect(dock.locator('.up-row', { hasText: 'large.jpg' }).locator('.up-row-status')).toHaveText('Added');
  await expect(dock.locator('.up-row', { hasText: 'large.jpg' }).locator('.up-row-size')).toHaveText('5.9 MB');
  const seen = await page.evaluate(() => window.__seen);
  expect(seen.pct).toBeGreaterThan(0);
  expect(seen.status.some((s) => / of 5\.9 MB/.test(s))).toBe(true);
  expect(await items(page)).toEqual(['audio.webm', 'doc.pdf', 'image.png', 'large.jpg', 'notes.txt']);
  // unprotected storage and no backup yet: no "originals are still in your Photos" hint
  await expect(dock.locator('.up-hint')).toBeHidden();
  await dock.getByRole('button', { name: 'Done' }).click();
  await expect(dock).toHaveCount(0);
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
  void errors; // other views (#/text) are still being built: their errors are theirs
});

test('cancelling one file mid-import: it is not stored, the others are', async ({ page }) => {
  const errors = await watch(page);
  await openVault(page);
  const r = await page.evaluate(async () => {
    const files = [await window.__fx('image.png'), window.__big(12, 'huge.bin'), await window.__fx('notes.txt')];
    const clicked = window.__whenRunning('huge.bin', (row) => {
      row.querySelector('.up-row-btn').click();
      return true;
    });
    const res = await window.__U.importFiles({ vault: window.__vault, files });
    const stored = await window.__vault._store.list();
    return { clicked: await clicked, added: res.added.map((i) => i.name).sort(), cancelled: res.cancelled, failed: res.failed, stored: stored.length };
  });
  expect(r).toEqual({ clicked: true, added: ['image.png', 'notes.txt'], cancelled: 1, failed: 0, stored: 2 });
  const row = page.locator('.up-row', { hasText: 'huge.bin' });
  await expect(row).toHaveAttribute('data-state', 'cancelled');
  await expect(row.locator('.up-row-status')).toHaveText('Cancelled');
  await expect(page.locator('.up-status')).toHaveText('2 files added · 1 cancelled');
  expect(await items(page)).toEqual(['image.png', 'notes.txt']);
  // a cancelled file can be retried from its row
  await row.getByRole('button', { name: 'Retry huge.bin' }).click();
  await expect(row).toHaveAttribute('data-state', 'done', { timeout: 30000 });
  expect(await items(page)).toEqual(['huge.bin', 'image.png', 'notes.txt']);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
});

test('folder import (webkitdirectory) creates an album named after the folder; the option can be unticked', async ({ page }) => {
  const errors = await watch(page);
  await openVault(page);
  const chooser = page.waitForEvent('filechooser');
  await page.click('#up-add-folder');
  await (await chooser).setFiles(FX('folder'));
  const dock = page.locator('.up-dock');
  await expect(dock).toHaveAttribute('data-state', 'done', { timeout: 30000 });
  await expect(dock.locator('.up-group-name')).toHaveText('folder');
  await expect(dock.locator('.up-group-count')).toHaveText('3 files');
  const opt = dock.locator('.up-group-opt input');
  await expect(opt).toBeChecked();
  const lists = () => page.evaluate(() => window.__vault.lists().map((l) => ({ name: l.name, items: l.itemIds.map((id) => window.__vault.item(id).name).sort() })));
  // dotfiles are skipped; nested files are kept; directories never become items
  expect(await items(page)).toEqual(['deep.txt', 'dot.png', 'readme.txt']);
  expect(await lists()).toEqual([{ name: 'folder', items: ['deep.txt', 'dot.png', 'readme.txt'] }]);
  await expect(page.locator('#up-harness .al-card[data-id]')).toHaveCount(1);
  await expect(page.locator('#up-harness .al-card[data-id] .al-card-name')).toHaveText('folder');
  // unticking removes the album (the files stay), ticking makes it again with the imported files
  await opt.uncheck();
  await expect.poll(lists).toEqual([]);
  await expect(page.locator('#up-harness .al-card[data-id]')).toHaveCount(0);
  await opt.check();
  await expect.poll(lists).toEqual([{ name: 'folder', items: ['deep.txt', 'dot.png', 'readme.txt'] }]);
  expect(await items(page)).toEqual(['deep.txt', 'dot.png', 'readme.txt']);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
});

test('a locked .czd dropped in the vault goes to #/open and is not stored (detected by content, not name)', async ({ page }) => {
  await watch(page);
  await openVault(page);
  await page.evaluate(async () => {
    const C = await import('/app/crypto/container.js');
    const pk = await C.makePassKek('pw', { m: 64, t: 1, p: 1 });
    const bytes = new TextEncoder().encode('hello there');
    const parts = [];
    for await (const p of C.encryptStream(bytes, { size: bytes.length, meta: { name: 'hi.txt', type: 'text/plain' }, stanzasFor: async (fk) => [await C.passStanza(fk, pk)] })) parts.push(p);
    // a misleading name: sniffing looks at the bytes
    window.__drop([new File(parts, 'holiday.jpg', { type: 'image/jpeg' })]);
  });
  const dlg = page.getByRole('dialog', { name: 'Locked cZEROde file' });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('This is a locked cZEROde file — Open it?');
  await expect(dlg).toContainText('holiday.jpg');
  await dlg.getByRole('button', { name: 'Open it' }).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/open');
  expect(await page.evaluate(() => window.__handoffs)).toEqual([{ key: 'incoming.files', names: ['holiday.jpg'] }]);
  const r = await page.evaluate(async () => ({ res: await window.__dropped, n: window.__vault.items().length, stored: (await window.__vault._store.list()).length }));
  expect(r.n).toBe(0);
  expect(r.stored).toBe(0);
  expect(r.res).toMatchObject({ added: [], routed: 1 });
  await expect(page.locator('.up-dock .up-row')).toHaveCount(0);
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
});

test('a .czb dropped in the vault opens the restore dialog and is not stored', async ({ page }) => {
  await watch(page);
  await openVault(page);
  await page.evaluate(async () => {
    const v = window.__vault;
    await v.addFile(await window.__fx('image.png'));
    const b = await v.exportBackup();
    const parts = [];
    for await (const p of b.stream) parts.push(p);
    window.__drop([new File(parts, 'my-backup.czb')]);
  });
  // the settings view's Restore/Merge flow (§12 openRestoreDialog), with the dropped file already inspected
  const dlg = page.getByRole('dialog').last();
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('my-backup.czb');
  await expect(dlg).toContainText('This backup comes from the vault you have open');
  await expect(dlg.getByRole('button', { name: 'Merge' })).toBeVisible();
  expect(await page.evaluate(async () => ({ n: window.__vault.items().length, stored: (await window.__vault._store.list()).length }))).toEqual({ n: 1, stored: 1 });
  await expect(page.locator('.up-dock .up-row')).toHaveCount(0);
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
});

test('an old cZEROde 1 desktop .czd goes to #/legacy and is not stored', async ({ page }) => {
  await watch(page);
  await openVault(page);
  await page.evaluate(async () => {
    window.__drop([await window.__fx('legacy/red-dot.czd', 'red-dot.czd'), await window.__fx('image.png')]);
  });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/legacy');
  expect(await page.evaluate(() => window.__handoffs)).toEqual([{ key: 'legacy.files', names: ['red-dot.czd'] }]);
  const r = await page.evaluate(async () => {
    const res = await window.__dropped;
    return { routed: res.routed, added: res.added.map((i) => i.name), items: window.__vault.items().map((i) => i.name) };
  });
  // the ordinary file in the same drop is imported
  expect(r).toEqual({ routed: 1, added: ['image.png'], items: ['image.png'] });
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
});

test('pre-flight space check: "Not enough space" with per-file skip', async ({ page }) => {
  const errors = await watch(page);
  await openVault(page);
  const origin = new URL(page.url()).origin;
  const cdp = await page.context().newCDPSession(page);
  const usage = await page.evaluate(async () => (await navigator.storage.estimate()).usage);
  await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: usage + 8 * MiB });
  await page.evaluate(async () => {
    window.__res = window.__U.importFiles({ vault: window.__vault, files: [window.__big(20, 'movie.mkv'), await window.__fx('image.png'), await window.__fx('notes.txt')] });
  });
  const dlg = page.getByRole('dialog', { name: 'Not enough space' });
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.up-space-lead')).toHaveText(/^Not enough space: needs 2\d(\.\d)? MB, [0-9.]+ MB free\.$/);
  await expect(dlg.locator('.up-space-row')).toHaveCount(3);
  await expect(dlg.locator('.up-space-row').first()).toContainText('movie.mkv');
  await expect(dlg.locator('.up-space-fit')).toContainText('still too much');
  await dlg.locator('.up-space-row', { hasText: 'movie.mkv' }).locator('input').uncheck();
  await expect(dlg.locator('.up-space-fit')).toContainText('2 files selected');
  await expect(dlg.locator('.up-space-fit')).toContainText('fits');
  await dlg.getByRole('button', { name: 'Import 2 files' }).click();
  const r = await page.evaluate(async () => {
    const res = await window.__res;
    return { added: res.added.map((i) => i.name).sort(), skipped: res.skipped };
  });
  expect(r).toEqual({ added: ['image.png', 'notes.txt'], skipped: 1 });
  expect(await items(page)).toEqual(['image.png', 'notes.txt']);

  // "Keep what fits" selects as many files as fit; Cancel imports nothing
  await page.evaluate(async () => {
    window.__res = window.__U.importFiles({ vault: window.__vault, files: [window.__big(20, 'a.bin'), window.__big(30, 'b.bin'), await window.__fx('doc.pdf')] });
  });
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Keep what fits' }).click();
  await expect(dlg.locator('.up-space-row', { hasText: 'doc.pdf' }).locator('input')).toBeChecked();
  await expect(dlg.locator('.up-space-row', { hasText: 'a.bin' }).locator('input')).not.toBeChecked();
  await expect(dlg.getByRole('button', { name: 'Import 1 file' })).toBeEnabled();
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  expect(await page.evaluate(async () => (await window.__res).skipped)).toBe(3);
  expect(await items(page)).toEqual(['image.png', 'notes.txt']);
  await cdp.send('Storage.overrideQuotaForOrigin', { origin });
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
});

test('albums: create, rename, reorder (buttons and drag), cover, remove + undo, delete', async ({ page }) => {
  const errors = await watch(page);
  await openVault(page);
  const ids = await page.evaluate(async () => {
    const res = await window.__U.importFiles({ vault: window.__vault, files: [await window.__fx('image.png', 'a.png'), await window.__fx('image.png', 'b.png'), await window.__fx('image.png', 'c.png')] });
    const by = Object.fromEntries(res.added.map((i) => [i.name, i.id]));
    return [by['a.png'], by['b.png'], by['c.png']];
  });
  const [a, b, c] = ids;
  const list = () => page.evaluate(() => {
    const l = window.__vault.lists()[0];
    return l ? { name: l.name, itemIds: l.itemIds, cover: l.cover ?? null } : null;
  });
  const harness = page.locator('#up-harness');

  // create from the strip's "+ New album" (opens the editor of the new, empty album)
  await expect(harness.locator('.al-strip-none')).toHaveCount(1);
  await harness.getByRole('button', { name: 'New album' }).click();
  const prompt = page.getByRole('dialog', { name: 'New album' });
  await prompt.getByLabel('Album name').fill('Trip');
  await prompt.getByRole('button', { name: 'OK' }).click();
  const editor = page.locator('.sheet.al-editor');
  await expect(editor).toBeVisible();
  await expect(editor.locator('.sheet-title')).toHaveText('Trip');
  await expect(editor.locator('.al-ed-empty')).toBeVisible();
  expect(await list()).toEqual({ name: 'Trip', itemIds: [], cover: null });
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);

  const albumId = await page.evaluate(async (all) => {
    const l = window.__vault.lists()[0];
    await window.__vault.updateList(l.id, { itemIds: all });
    return l.id;
  }, ids);
  const card = harness.locator(`.al-card[data-id="${albumId}"]`);
  await expect(card.locator('.al-card-count')).toHaveText('3 items');
  await expect(card.locator('.al-card-frame img')).toHaveCount(1); // cover thumbnail (first item with a thumbnail)
  await card.click();
  await expect(editor).toBeVisible();
  await expect(editor.locator('.al-ed-row')).toHaveCount(3);
  await expect(editor.locator('.al-ed-row img')).toHaveCount(3);

  // rename
  await editor.getByLabel('Name').fill('Road trip');
  await editor.getByLabel('Name').press('Enter');
  await expect.poll(async () => (await list()).name).toBe('Road trip');
  await expect(editor.locator('.sheet-title')).toHaveText('Road trip');
  await expect(card.locator('.al-card-name')).toHaveText('Road trip');

  // reorder with the arrow buttons (focus stays on the moved row's button)
  await editor.getByRole('button', { name: 'Move a.png down' }).click();
  await expect(editor.getByRole('button', { name: 'Move a.png down' })).toBeFocused();
  await expect.poll(async () => (await list()).itemIds).toEqual([b, a, c]);
  // still focused after the debounced save came back as a 'lists' event
  await expect(editor.getByRole('button', { name: 'Move a.png down' })).toBeFocused();
  await expect(editor.getByRole('button', { name: 'Move b.png up' })).toBeDisabled();

  // reorder by dragging c.png's handle to the top
  const handle = editor.locator(`.al-ed-row[data-id="${c}"] .al-ed-handle`);
  const first = editor.locator('.al-ed-row').first();
  const hb = await handle.boundingBox();
  const fb = await first.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  for (let y = hb.y + hb.height / 2; y > fb.y + 4; y -= 12) await page.mouse.move(hb.x + hb.width / 2, y);
  await page.mouse.move(hb.x + hb.width / 2, fb.y + 4);
  await page.mouse.up();
  await expect.poll(async () => (await list()).itemIds).toEqual([c, b, a]);
  await expect(editor.locator('.al-ed-row').first()).toHaveAttribute('data-id', c);

  // cover
  await editor.getByRole('button', { name: 'Use b.png as the cover' }).click();
  await expect.poll(async () => (await list()).cover).toBe(b);
  await expect(editor.getByRole('button', { name: 'b.png is the cover' })).toHaveAttribute('aria-pressed', 'true');
  await expect(editor.locator(`.al-ed-row[data-id="${b}"] .al-ed-badge`)).toBeVisible();

  // remove from the album, then undo
  await editor.getByRole('button', { name: 'Remove a.png from the album' }).click();
  await expect.poll(async () => (await list()).itemIds).toEqual([c, b]);
  await expect(editor.locator('.al-ed-row')).toHaveCount(2);
  await page.locator('.toast', { hasText: 'Removed “a.png” from the album.' }).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await list()).itemIds).toEqual([c, b, a]);
  await expect(editor.locator('.al-ed-row')).toHaveCount(3);
  expect(await items(page)).toEqual(['a.png', 'b.png', 'c.png']);

  // delete the album (items stay)
  await editor.getByRole('button', { name: 'Delete album' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete album?' });
  await expect(confirm).toContainText('Its 3 items stay in your vault.');
  await confirm.getByRole('button', { name: 'Delete album' }).click();
  await expect(editor).toHaveCount(0);
  expect(await list()).toBeNull();
  await expect(harness.locator('.al-card[data-id]')).toHaveCount(0);
  expect(await items(page)).toEqual(['a.png', 'b.png', 'c.png']);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
});

test('add to album from a multi-select: existing album, "already in", and a new album', async ({ page }) => {
  const errors = await watch(page);
  await openVault(page);
  const [x, y, z] = await page.evaluate(async () => {
    const res = await window.__U.importFiles({ vault: window.__vault, files: [await window.__fx('image.png', 'x.png'), await window.__fx('notes.txt', 'y.txt'), await window.__fx('doc.pdf', 'z.pdf')] });
    const by = Object.fromEntries(res.added.map((i) => [i.name, i.id]));
    await window.__vault.createList({ name: 'Faves', itemIds: [by['x.png']] });
    return [by['x.png'], by['y.txt'], by['z.pdf']];
  });
  const lists = () => page.evaluate(() => window.__vault.lists().map((l) => ({ name: l.name, itemIds: l.itemIds })));
  const open = (sel) => page.evaluate((ids) => {
    window.__added = window.__A.addToAlbumDialog({ vault: window.__vault, itemIds: ids });
  }, sel);

  await open([x, y]);
  let dlg = page.getByRole('dialog', { name: 'Add to album' });
  await expect(dlg).toContainText('2 items selected');
  const faves = dlg.locator('.al-pick', { hasText: 'Faves' });
  await expect(faves).toBeEnabled();
  await expect(faves).toBeFocused();
  await faves.click();
  expect(await page.evaluate(() => window.__added)).toBeTruthy();
  expect(await lists()).toEqual([{ name: 'Faves', itemIds: [x, y] }]);
  await expect(page.locator('.toast', { hasText: 'Added 1 item to “Faves”.' })).toBeVisible();

  await open([x, y]);
  dlg = page.getByRole('dialog', { name: 'Add to album' });
  await expect(dlg.locator('.al-pick', { hasText: 'Faves' })).toBeDisabled();
  await expect(dlg.locator('.al-pick', { hasText: 'Faves' })).toContainText('Already in this album');
  await dlg.getByLabel('Or a new album').fill('Fresh');
  await dlg.getByLabel('Or a new album').press('Enter');
  await expect(dlg).toHaveCount(0);
  await expect.poll(lists).toEqual([{ name: 'Faves', itemIds: [x, y] }, { name: 'Fresh', itemIds: [x, y] }]);

  await open([z]);
  dlg = page.getByRole('dialog', { name: 'Add to album' });
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  expect(await page.evaluate(() => window.__added)).toBeNull();
  await expect(page.locator('#up-harness .al-card[data-id]')).toHaveCount(2);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
});

test('lock during an import: rows show "Interrupted" without names; retry after unlock finishes it', async ({ page }) => {
  const errors = await watch(page);
  await openVault(page);
  const r = await page.evaluate(async () => {
    const files = [window.__big(12, 'concert.bin'), await window.__fx('image.png'), await window.__fx('notes.txt')];
    const locked = window.__whenRunning('concert.bin', () => {
      window.__vault.lock('user');
      return true;
    });
    const res = await window.__U.importFiles({ vault: window.__vault, files });
    return { locked: await locked, interrupted: res.interrupted, added: res.added.length, stored: (await window.__vault._store.list()).length };
  });
  expect(r).toEqual({ locked: true, interrupted: 3, added: 0, stored: 0 });
  const dock = page.locator('.up-dock');
  await expect(dock).toHaveAttribute('data-state', 'interrupted');
  await expect(dock.locator('.up-title')).toHaveText('Import interrupted');
  await expect(dock.locator('.up-row[data-state="interrupted"]')).toHaveCount(3);
  await expect(dock.locator('.up-row-status').first()).toHaveText('Interrupted — retry after unlock.');
  await expect(dock.locator('.up-row-name').first()).toHaveText('Hidden while locked');
  for (const name of ['concert.bin', 'image.png', 'notes.txt']) await expect(dock).not.toContainText(name);
  await expect(dock.locator('.up-foot-text')).toHaveText('Unlock your vault to retry.');
  await expect(dock.getByRole('button', { name: /Retry/ })).toHaveCount(0);

  await page.evaluate((pass) => window.__vault.unlock(pass), PASS);
  await expect(dock.locator('.up-title')).toHaveText('Import paused');
  await expect(dock).toContainText('concert.bin');
  await dock.locator('.up-foot').getByRole('button', { name: 'Retry' }).click();
  await expect(dock).toHaveAttribute('data-state', 'done', { timeout: 30000 });
  await expect(dock.locator('.up-status')).toHaveText('3 files added');
  expect(await items(page)).toEqual(['concert.bin', 'image.png', 'notes.txt']);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
});

test('after-batch hint: not while unprotected without a backup; once per session after a backup', async ({ page }) => {
  const errors = await watch(page);
  await openVault(page);
  const dock = page.locator('.up-dock');
  const add = (name) => page.evaluate(async (n) => {
    await window.__U.importFiles({ vault: window.__vault, files: [await window.__fx('notes.txt', n)] });
  }, name);
  await add('one.txt');
  await expect(dock).toHaveAttribute('data-state', 'done');
  await page.waitForTimeout(300);
  await expect(dock.locator('.up-hint')).toBeHidden();
  await dock.getByRole('button', { name: 'Done' }).click();

  await page.evaluate(async () => {
    const b = await window.__vault.exportBackup();
    for await (const p of b.stream) void p;
  });
  await add('two.txt');
  const hint = dock.locator('.up-hint');
  await expect(hint).toBeVisible();
  await expect(hint).toContainText('Your originals are still in your Photos/Downloads.');
  await expect(hint.getByRole('button', { name: 'Back up now' })).toBeVisible();
  await hint.getByRole('button', { name: 'Got it' }).click();
  await expect(hint).toBeHidden();
  await dock.getByRole('button', { name: 'Done' }).click();

  await add('three.txt');
  await expect(dock).toHaveAttribute('data-state', 'done');
  await page.waitForTimeout(300);
  await expect(dock.locator('.up-hint')).toBeHidden();
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
});

test('album play helpers: playable check and playAlbum queues the album in the player', async ({ page }) => {
  const errors = await watch(page);
  await openVault(page);
  const r = await page.evaluate(async () => {
    const v = window.__vault;
    const res = await window.__U.importFiles({ vault: v, files: [await window.__fx('tone.wav', 'tone.wav', 'audio/wav'), await window.__fx('image.png'), await window.__fx('audio.webm', 'song.webm', 'audio/webm')] });
    const by = Object.fromEntries(res.added.map((i) => [i.name, i.id]));
    const mix = await v.createList({ name: 'Mix', itemIds: [by['image.png'], by['song.webm'], by['tone.wav']] });
    const pics = await v.createList({ name: 'Pics', itemIds: [by['image.png']] });
    const A = window.__A;
    return {
      mixPlayable: A.albumHasPlayable(v, mix.id),
      picsPlayable: A.albumHasPlayable(v, pics.id),
      items: A.albumViewerItems({ vault: v, id: mix.id }).map((i) => [i.name, i.kind, typeof i.getSource]),
      picsPlayed: A.playAlbum({ vault: v, id: pics.id }),
      played: A.playAlbum({ vault: v, id: mix.id }),
    };
  });
  expect(r).toEqual({
    mixPlayable: true,
    picsPlayable: false,
    items: [['image.png', 'image', 'function'], ['song.webm', 'audio', 'function'], ['tone.wav', 'audio', 'function']],
    picsPlayed: false,
    played: true,
  });
  await expect(page.locator('#player-dock .pl-name')).toHaveText('song.webm');
  await expect(page.locator('#player-dock .pl-sub')).toContainText('Mix');
  await page.evaluate(async () => (await import('/app/ui/player.js')).stop());
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
});

// ───────── in the real vault view (review additions)

/** Fresh unlocked vault on #/vault (the real vault view) plus in-page helpers. */
async function openVaultView(page) {
  await page.goto('/#/vault');
  await expect.poll(() => page.evaluate(async () => (await import('/app/vault/vault.js')).vault?.status ?? null), { timeout: 20000 }).toBe('none');
  await page.evaluate(async (pass) => {
    const { vault } = await import('/app/vault/vault.js');
    await vault.create(pass, { params: { m: 64, t: 1, p: 1 }, recovery: false });
    Object.assign(window, { __vault: vault, __U: await import('/app/ui/upload.js'), __A: await import('/app/ui/albums.js') });
    window.__fx = async (name, as = name, type = '') => new File([await (await fetch(`/tests/fixtures/${name}`)).arrayBuffer()], as, { type });
    const chunk = new Uint8Array(2 ** 20).map((_, i) => (i * 7 + 3) & 255);
    window.__big = (mb, name) => new File(Array(mb).fill(chunk), name, { type: 'application/octet-stream' });
    window.__whenRunning = (name, fn) => new Promise((resolve) => {
      const tick = () => {
        for (const row of document.querySelectorAll('.up-row[data-state="running"]')) {
          if (row.querySelector('.up-row-name')?.textContent === name && Number(row.querySelector('.up-row-bar')?.getAttribute('aria-valuenow')) >= 1) {
            resolve(fn(row));
            return;
          }
        }
        setTimeout(tick, 1);
      };
      tick();
    });
  }, PASS);
  await expect(page.locator('.vv-unlocked')).toBeVisible();
}

/** True when the element's centre is not covered by anything else (e.g. the queue dock). */
const uncovered = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return Boolean(hit && (hit === el || el.contains(hit)));
}, sel);

for (const vp of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'phone', width: 390, height: 844 }]) {
  test(`vault view (${vp.name}): a lock mid-import folds the queue off the unlock form; unlocking reopens it and Retry finishes`, async ({ page }) => {
    const errors = await watch(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await openVaultView(page);
    const done = page.evaluate(async () => {
      const files = [window.__big(12, 'concert.bin'), await window.__fx('image.png', 'beach.png', 'image/png'), await window.__fx('notes.txt', 'notes.txt', 'text/plain')];
      window.__whenRunning('concert.bin', () => document.querySelector('.sh-lock').click());
      return (await window.__U.importFiles({ vault: window.__vault, files })).interrupted;
    });
    expect(await done).toBe(3);
    await expect(page.locator('.vv-lockpage')).toBeVisible();
    const dock = page.locator('.up-dock');
    await expect(dock).toHaveAttribute('data-state', 'interrupted');
    await expect(dock).toHaveClass(/up-collapsed/);
    await expect(dock.locator('.up-body')).toBeHidden();
    await expect(dock.locator('.up-status')).toHaveText('3 files · unlock to retry');
    for (const name of ['concert.bin', 'beach.png', 'notes.txt']) await expect(dock).not.toContainText(name);
    // the folded panel leaves the unlock form usable
    expect(await uncovered(page, 'input[name="czd-vault-unlock"]')).toBe(true);
    expect(await uncovered(page, '.vv-unlock-form .vv-submit')).toBe(true);
    await page.fill('input[name="czd-vault-unlock"]', PASS);
    await page.click('.vv-unlock-form .vv-submit');
    await expect(page.locator('.vv-unlocked')).toBeVisible();
    // unlocked: the panel opens again and names come back
    await expect(dock.locator('.up-body')).toBeVisible();
    await expect(dock.locator('.up-title')).toHaveText('Import paused');
    await expect(dock.locator('.up-row', { hasText: 'concert.bin' }).locator('.up-row-status')).toHaveText('Interrupted by the lock');
    await dock.locator('.up-foot').getByRole('button', { name: 'Retry' }).click();
    await expect(dock).toHaveAttribute('data-state', 'done', { timeout: 30000 });
    await expect(page.locator('.vv-card')).toHaveCount(3);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => window.__csp)).toEqual([]);
  });
}

test('a big queue renders a bounded window of rows around the running file and still imports everything', async ({ page }) => {
  const errors = await watch(page);
  await openVault(page);
  const during = await page.evaluate(async () => {
    const tiny = (i) => new File([`tiny ${i}`], `t${String(i).padStart(3, '0')}.txt`, { type: 'text/plain' });
    // big.bin is the 76th file: past the first window's end, so the window has slid to it
    const files = [...Array.from({ length: 75 }, (_, i) => tiny(i)), window.__big(12, 'big.bin'), ...Array.from({ length: 74 }, (_, i) => tiny(i + 75))];
    const seen = window.__whenRunning('big.bin', (row) => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const list = document.querySelector('.up-list').getBoundingClientRect();
      const r = row.getBoundingClientRect();
      resolve({
        rows: document.querySelectorAll('.up-dock .up-row').length,
        inView: r.top >= list.top - 1 && r.bottom <= list.bottom + 1,
        top: document.querySelector('.up-more-top')?.isConnected ? document.querySelector('.up-more-top').textContent : null,
        bottom: document.querySelector('.up-more-bottom')?.isConnected ? document.querySelector('.up-more-bottom').textContent : null,
      });
    }))));
    window.__res = window.__U.importFiles({ vault: window.__vault, files });
    return seen;
  });
  expect(during.rows).toBeLessThanOrEqual(80);
  expect(during.inView).toBe(true); // the list follows the running file
  expect(during.top).toMatch(/^\d+ earlier files · \d+ added$/);
  expect(during.bottom).toMatch(/^\d+ more files waiting$/);
  const res = await page.evaluate(async () => (await window.__res).added.length);
  expect(res).toBe(150);
  const dock = page.locator('.up-dock');
  await expect(dock).toHaveAttribute('data-state', 'done');
  await expect(dock.locator('.up-status')).toHaveText('150 files added');
  expect(await dock.locator('.up-row').count()).toBeLessThanOrEqual(80);
  await expect(dock.locator('.up-more-top')).toHaveText(/^\d+ earlier files · \d+ added$/);
  expect(await page.evaluate(() => window.__vault.items().length)).toBe(150);
  expect(errors).toEqual([]);
});

test('a file that changed on disk after it was picked fails with a readable reason', async ({ page }, testInfo) => {
  const errors = await watch(page);
  await openVault(page);
  const fs = await import('node:fs');
  const tmp = testInfo.outputPath('moved.txt');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, 'the original text');
  await page.evaluate(() => document.body.append(Object.assign(document.createElement('input'), { type: 'file', id: 'up-tmp-input' })));
  await page.setInputFiles('#up-tmp-input', tmp);
  // the browser takes its snapshot (size, date) of the picked file when it is first looked at
  expect(await page.evaluate(() => document.getElementById('up-tmp-input').files[0].size)).toBe(17);
  await new Promise((r) => setTimeout(r, 50));
  fs.writeFileSync(tmp, 'changed after picking, so the browser refuses to read it');
  const r = await page.evaluate(async () => {
    const res = await window.__U.importFiles({ vault: window.__vault, files: [document.getElementById('up-tmp-input').files[0], await window.__fx('notes.txt')] });
    return { failed: res.failed, added: res.added.map((i) => i.name), stored: (await window.__vault._store.list()).length };
  });
  expect(r).toEqual({ failed: 1, added: ['notes.txt'], stored: 1 });
  const row = page.locator('.up-row', { hasText: 'moved.txt' });
  await expect(row.locator('.up-row-status')).toHaveText("Couldn't read this file — it may have been moved or deleted.");
  await expect(page.locator('.up-dock .up-title')).toHaveText('Import finished');
  await expect(page.getByRole('button', { name: 'Retry failed' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('album editor: a typed name survives Esc, Enter keeps focus, and a lock right after a reorder keeps the order', async ({ page }) => {
  const errors = await watch(page);
  await openVault(page);
  const [a, b, c, albumId] = await page.evaluate(async () => {
    const res = await window.__U.importFiles({ vault: window.__vault, files: [await window.__fx('image.png', 'a.png'), await window.__fx('image.png', 'b.png'), await window.__fx('image.png', 'c.png')] });
    const by = Object.fromEntries(res.added.map((i) => [i.name, i.id]));
    const l = await window.__vault.createList({ name: 'Trip', itemIds: [by['a.png'], by['b.png'], by['c.png']] });
    return [by['a.png'], by['b.png'], by['c.png'], l.id];
  });
  const list = () => page.evaluate((id) => {
    const l = window.__vault.lists().find((x) => x.id === id);
    return l ? { name: l.name, itemIds: l.itemIds } : null;
  }, albumId);
  const openEditor = () => page.evaluate((id) => {
    window.__A.albumEditor({ vault: window.__vault, id });
  }, albumId);
  const editor = page.locator('.sheet.al-editor');

  await openEditor();
  await editor.getByLabel('Name').fill('Typed then Esc');
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect.poll(async () => (await list()).name).toBe('Typed then Esc');

  await openEditor();
  const name = editor.getByLabel('Name');
  await name.fill('Entered');
  await name.press('Enter');
  await expect.poll(async () => (await list()).name).toBe('Entered');
  await expect(name).toBeFocused();
  await expect(editor.locator('.sheet-title')).toHaveText('Entered');

  // reorder, then lock before the debounced save: the order is saved while the keys still exist
  await editor.getByRole('button', { name: 'Move a.png down' }).click();
  await page.evaluate(() => window.__vault.lock('user'));
  await expect(editor).toHaveCount(0);
  await page.evaluate((pass) => window.__vault.unlock(pass), PASS);
  expect(await list()).toEqual({ name: 'Entered', itemIds: [b, a, c] });
  expect(errors).toEqual([]);
});

test('album editor: Undo after the editor closed puts the item back without dropping later changes', async ({ page }) => {
  const errors = await watch(page);
  await openVault(page);
  const [a, b, c, albumId] = await page.evaluate(async () => {
    const res = await window.__U.importFiles({ vault: window.__vault, files: [await window.__fx('image.png', 'a.png'), await window.__fx('image.png', 'b.png'), await window.__fx('notes.txt', 'c.txt')] });
    const by = Object.fromEntries(res.added.map((i) => [i.name, i.id]));
    const l = await window.__vault.createList({ name: 'Trip', itemIds: [by['a.png'], by['b.png']] });
    window.__A.albumEditor({ vault: window.__vault, id: l.id });
    return [by['a.png'], by['b.png'], by['c.txt'], l.id];
  });
  const ids = () => page.evaluate((id) => window.__vault.list(id).itemIds, albumId);
  const editor = page.locator('.sheet.al-editor');
  await editor.getByRole('button', { name: 'Remove a.png from the album' }).click();
  await expect.poll(ids).toEqual([b]);
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  // the album changes elsewhere (e.g. "Add to album" from the grid) before Undo is clicked
  await page.evaluate(({ id, add }) => window.__vault.updateList(id, { itemIds: [...window.__vault.list(id).itemIds, add] }), { id: albumId, add: c });
  await expect.poll(ids).toEqual([b, c]);
  await page.locator('.toast', { hasText: 'Removed “a.png” from the album.' }).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(ids).toEqual([a, b, c]); // back at its old place, c kept
  expect(errors).toEqual([]);
});

test('vault view: the strip marks the open album; deleting it from its editor leaves for #/vault without bouncing back', async ({ page }) => {
  const errors = await watch(page);
  await openVaultView(page);
  const [trip, other] = await page.evaluate(async () => {
    const res = await window.__U.importFiles({ vault: window.__vault, files: [await window.__fx('image.png', 'a.png', 'image/png'), await window.__fx('audio.webm', 'song.webm', 'audio/webm')] });
    const l = await window.__vault.createList({ name: 'Trip', itemIds: [res.added[0].id] });
    const m = await window.__vault.createList({ name: 'Songs', itemIds: [res.added[1].id] });
    return [l.id, m.id];
  });
  const strip = page.locator('.al-strip');
  await expect(strip.locator('.al-card[data-id]')).toHaveCount(2);
  await expect(strip.locator('.al-card[aria-current]')).toHaveCount(0);
  // an album without thumbnails shows its first item's kind
  await expect(strip.locator(`.al-card[data-id="${other}"] .al-card-cover`)).toHaveAttribute('data-kind', 'audio');
  await strip.locator(`.al-card[data-id="${trip}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#/vault/album/${trip}$`));
  await expect(strip.locator(`.al-card[data-id="${trip}"]`)).toHaveAttribute('aria-current', 'page');
  await expect(strip.locator(`.al-card[data-id="${other}"]`)).not.toHaveAttribute('aria-current', 'page');

  await page.evaluate(() => {
    window.__hashes = [];
    window.addEventListener('hashchange', () => window.__hashes.push(location.hash));
  });
  await page.locator('.vv-album-edit').click();
  const editor = page.locator('.sheet.al-editor');
  await editor.getByRole('button', { name: 'Delete album' }).click();
  await page.getByRole('dialog', { name: 'Delete album?' }).getByRole('button', { name: 'Delete album' }).click();
  await expect(editor).toHaveCount(0);
  await expect(page).toHaveURL(/#\/vault$/);
  await page.waitForTimeout(600);
  await expect(page).toHaveURL(/#\/vault$/);
  expect(await page.evaluate(() => window.__hashes)).not.toContain(`#/vault/album/${trip}`);
  await expect(strip.locator('.al-card[data-id]')).toHaveCount(1);
  expect(await page.evaluate(() => window.__vault.items().length)).toBe(2);
  expect(errors).toEqual([]);
});

test('add to album: "Create" needs a name; the space dialog starts on "Keep what fits" and says when it would not fit', async ({ page }) => {
  const errors = await watch(page);
  await openVault(page);
  const ids = await page.evaluate(async () => (await window.__U.importFiles({ vault: window.__vault, files: [await window.__fx('image.png')] })).added.map((i) => i.id));
  await page.evaluate((x) => {
    window.__added = window.__A.addToAlbumDialog({ vault: window.__vault, itemIds: x });
  }, ids);
  const dlg = page.getByRole('dialog', { name: 'Add to album' });
  const input = dlg.getByLabel('New album');
  await expect(input).toBeFocused();
  await expect(dlg.getByRole('button', { name: 'Create' })).toBeDisabled();
  await input.press('Enter');
  await expect(dlg).toBeVisible();
  await input.fill('  ');
  await expect(dlg.getByRole('button', { name: 'Create' })).toBeDisabled();
  await input.fill('Pics');
  await dlg.getByRole('button', { name: 'Create' }).click();
  await expect(dlg).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__vault.lists().map((l) => l.name))).toEqual(['Pics']);

  const origin = new URL(page.url()).origin;
  const cdp = await page.context().newCDPSession(page);
  const usage = await page.evaluate(async () => (await navigator.storage.estimate()).usage);
  await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: usage + 8 * MiB });
  await page.evaluate(async () => {
    window.__res = window.__U.importFiles({ vault: window.__vault, files: [window.__big(20, 'movie.mkv'), await window.__fx('notes.txt')] });
  });
  const space = page.getByRole('dialog', { name: 'Not enough space' });
  await expect(space.getByRole('button', { name: 'Keep what fits' })).toBeFocused();
  await expect(space.getByRole('button', { name: 'Import 2 files anyway' })).toBeEnabled();
  await page.keyboard.press('Enter'); // Keep what fits
  await expect(space.getByRole('button', { name: 'Import 1 file' })).toBeEnabled();
  await space.getByRole('button', { name: 'Import 1 file' }).click();
  expect(await page.evaluate(async () => {
    const res = await window.__res;
    return { added: res.added.map((i) => i.name), skipped: res.skipped };
  })).toEqual({ added: ['notes.txt'], skipped: 1 });
  await cdp.send('Storage.overrideQuotaForOrigin', { origin });
  expect(errors).toEqual([]);
});

test('album thumbnails go back to the vault when the editor/picker close; a strip card keeps focus while its album grows', async ({ page }) => {
  const errors = await watch(page);
  await openVault(page);
  const [albumId, extra] = await page.evaluate(async () => {
    const res = await window.__U.importFiles({ vault: window.__vault, files: [await window.__fx('image.png', 'a.png'), await window.__fx('image.png', 'b.png'), await window.__fx('image.png', 'c.png'), await window.__fx('notes.txt', 'd.txt')] });
    const by = Object.fromEntries(res.added.map((i) => [i.name, i.id]));
    const l = await window.__vault.createList({ name: 'Pics', itemIds: [by['a.png'], by['b.png'], by['c.png']] });
    return [l.id, by['d.txt']];
  });
  const urls = () => page.evaluate(() => window.__vault._thumbUrls.size);
  const card = page.locator(`#up-harness .al-card[data-id="${albumId}"]`);
  await expect(card.locator('img')).toHaveCount(1);
  await page.evaluate((id) => {
    window.__A.albumEditor({ vault: window.__vault, id });
  }, albumId);
  const editor = page.locator('.sheet.al-editor');
  await expect(editor.locator('.al-ed-row img')).toHaveCount(3);
  expect(await urls()).toBe(3);
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  // Thumbnail URLs are reference-counted: the strip card still shows a.png (the album cover), so its URL stays —
  // the editor letting go of the same thumbnail must not revoke it under the strip.
  const coverAlive = () => page.evaluate(async (id) => {
    // A fresh image from the strip's URL decodes only while that URL is not revoked (img-src allows blob:).
    const probe = new Image();
    probe.src = document.querySelector(`#up-harness .al-card[data-id="${id}"] img`).src;
    try {
      await probe.decode();
      return true;
    } catch {
      return false;
    }
  }, albumId);
  expect(await urls()).toBe(1);
  expect(await coverAlive()).toBe(true);
  await page.evaluate((id) => {
    window.__added = window.__A.addToAlbumDialog({ vault: window.__vault, itemIds: [id] });
  }, extra);
  await expect(page.locator('.al-pick img')).toHaveCount(1);
  await page.getByRole('dialog', { name: 'Add to album' }).getByRole('button', { name: 'Cancel' }).click();
  expect(await page.evaluate(() => window.__added)).toBeNull();
  expect(await urls()).toBe(1);
  expect(await coverAlive()).toBe(true);

  // the card is updated in place: keyboard focus stays on it while the album changes
  await card.focus();
  await page.evaluate(({ id, add }) => window.__vault.updateList(id, { itemIds: [...window.__vault.list(id).itemIds, add] }), { id: albumId, add: extra });
  await expect(card.locator('.al-card-count')).toHaveText('4 items');
  await expect(card).toBeFocused();
  await expect(card).toHaveAttribute('aria-label', 'Pics, 4 items');
  expect(errors).toEqual([]);
});

test('album editor on a big album: shows the first 200 rows, more on demand, and moves across the boundary', async ({ page }) => {
  const errors = await watch(page);
  await openVault(page);
  const albumId = await page.evaluate(async () => {
    const files = Array.from({ length: 230 }, (_, i) => new File([`n${i}`], `n${String(i).padStart(3, '0')}.txt`, { type: 'text/plain' }));
    const res = await window.__U.importFiles({ vault: window.__vault, files });
    const ids = res.added.sort((a, b) => (a.name < b.name ? -1 : 1)).map((i) => i.id);
    const l = await window.__vault.createList({ name: 'Notes', itemIds: ids });
    window.__A.albumEditor({ vault: window.__vault, id: l.id });
    return l.id;
  });
  const editor = page.locator('.sheet.al-editor');
  await expect(editor.locator('.al-ed-count')).toHaveText('230');
  await expect(editor.locator('.al-ed-row')).toHaveCount(200);
  await expect(editor.getByRole('button', { name: 'Show 30 more' })).toBeVisible();
  // moving the last shown row down brings its new neighbour in, and focus stays on the button
  const down = editor.getByRole('button', { name: 'Move n199.txt down' });
  await down.click();
  await expect(down).toBeFocused();
  expect(await editor.locator('.al-ed-row').count()).toBeGreaterThanOrEqual(201);
  await expect.poll(() => page.evaluate((id) => window.__vault.list(id).itemIds.slice(198, 202).map((x) => window.__vault.item(x).name), albumId))
    .toEqual(['n198.txt', 'n200.txt', 'n199.txt', 'n201.txt']);
  // the rest comes in as the list scrolls to its end (or with the button)
  const more = editor.locator('.al-ed-more');
  if (await more.isVisible()) await editor.locator('.al-ed-more-btn').click();
  await expect(editor.locator('.al-ed-row')).toHaveCount(230);
  await expect(more).toBeHidden();
  expect(errors).toEqual([]);
});

test('"Cancel all" stops a long queue at once: nothing more is stored', async ({ page }) => {
  const errors = await watch(page);
  await openVault(page);
  const r = await page.evaluate(async () => {
    const files = [window.__big(12, 'first.bin'), ...Array.from({ length: 2000 }, (_, i) => new File([`c${i}`], `c${i}.txt`, { type: 'text/plain' }))];
    const p = window.__U.importFiles({ vault: window.__vault, files });
    const ms = await window.__whenRunning('first.bin', () => {
      const t0 = performance.now();
      document.querySelector('.up-cancel-all').click();
      return performance.now() - t0;
    });
    const res = await p;
    return { ms, added: res.added.length, cancelled: res.cancelled, stored: (await window.__vault._store.list()).length };
  });
  expect(r.ms).toBeLessThan(1000);
  expect({ added: r.added, cancelled: r.cancelled, stored: r.stored }).toEqual({ added: 0, cancelled: 2001, stored: 0 });
  const dock = page.locator('.up-dock');
  await expect(dock.locator('.up-status')).toHaveText('0 files added · 2,001 cancelled');
  expect(await dock.locator('.up-row').count()).toBeLessThanOrEqual(80);
  expect(errors).toEqual([]);
});

test('double clicks: cancelling a row is not undone by the second click; removing from an album removes one item', async ({ page }) => {
  const errors = await watch(page);
  await openVault(page);
  await page.evaluate(async () => {
    window.__p = window.__U.importFiles({ vault: window.__vault, files: [window.__big(12, 'slow.bin'), await window.__fx('notes.txt')] });
    await window.__whenRunning('slow.bin', () => true);
  });
  const row = page.locator('.up-row', { hasText: 'slow.bin' });
  await row.getByRole('button', { name: 'Cancel slow.bin' }).dblclick();
  const res = await page.evaluate(async () => {
    const r = await window.__p;
    return { cancelled: r.cancelled, added: r.added.map((i) => i.name) };
  });
  expect(res).toEqual({ cancelled: 1, added: ['notes.txt'] });
  await page.waitForTimeout(300);
  await expect(row).toHaveAttribute('data-state', 'cancelled');

  const albumId = await page.evaluate(async () => {
    const res2 = await window.__U.importFiles({ vault: window.__vault, files: [await window.__fx('image.png', 'a.png'), await window.__fx('image.png', 'b.png'), await window.__fx('image.png', 'c.png')] });
    const ids = res2.added.sort((x, y) => (x.name < y.name ? -1 : 1)).map((i) => i.id);
    const l = await window.__vault.createList({ name: 'Three', itemIds: ids });
    window.__A.albumEditor({ vault: window.__vault, id: l.id });
    return l.id;
  });
  const editor = page.locator('.sheet.al-editor');
  await editor.getByRole('button', { name: 'Remove a.png from the album' }).dblclick();
  await expect(editor.locator('.al-ed-row')).toHaveCount(2);
  await page.waitForTimeout(300);
  await expect.poll(() => page.evaluate((id) => window.__vault.list(id).itemIds.map((x) => window.__vault.item(x).name), albumId)).toEqual(['b.png', 'c.png']);
  // "Use as cover" is a toggle: a double click sets it (the second click doesn't clear it again)
  await editor.getByRole('button', { name: 'Use c.png as the cover' }).dblclick();
  await expect(editor.getByRole('button', { name: 'c.png is the cover' })).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(300);
  await expect.poll(() => page.evaluate((id) => window.__vault.item(window.__vault.list(id).cover).name, albumId)).toBe('c.png');
  expect(errors).toEqual([]);
});

test('vault view (phone): while an import runs, the queue panel does not cover the selection toolbar', async ({ page }) => {
  const errors = await watch(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openVaultView(page);
  await page.evaluate(async () => {
    await window.__U.importFiles({ vault: window.__vault, files: [await window.__fx('image.png', 'a.png', 'image/png')] });
    window.__p = window.__U.importFiles({ vault: window.__vault, files: [window.__big(12, 'long.bin')] });
    await window.__whenRunning('long.bin', () => true);
  });
  await page.locator('.vv-selectbtn').click();
  const bar = page.locator('.vv-selbar');
  await expect(bar).toBeVisible();
  for (const collapsed of [false, true]) {
    if (collapsed) await page.locator('.up-toggle').click();
    // wherever the vault view puts the toolbar (fixed above the nav, or sticky under the header), they don't overlap
    await expect.poll(async () => {
      const [d, b] = await Promise.all([page.locator('.up-dock').boundingBox(), bar.boundingBox()]);
      return d.y + d.height <= b.y || b.y + b.height <= d.y;
    }).toBe(true);
    expect(await uncovered(page, '.vv-selbar .vv-selclose')).toBe(true);
  }
  await page.evaluate(() => window.__p);
  expect(errors).toEqual([]);
});

// ───────── review round 2

test('album editor: items that land in the album while a reorder waits to be saved are kept', async ({ page }) => {
  const errors = await watch(page);
  await openVault(page);
  const [a, b, c, d, albumId] = await page.evaluate(async () => {
    const f = window.__fx;
    const res = await window.__U.importFiles({ vault: window.__vault, files: [await f('image.png', 'a.png'), await f('image.png', 'b.png'), await f('notes.txt', 'c.txt'), await f('notes.txt', 'd.txt')] });
    const by = Object.fromEntries(res.added.map((i) => [i.name, i.id]));
    const l = await window.__vault.createList({ name: 'Trip', itemIds: [by['a.png'], by['b.png']] });
    window.__A.albumEditor({ vault: window.__vault, id: l.id });
    return [by['a.png'], by['b.png'], by['c.txt'], by['d.txt'], l.id];
  });
  const ids = () => page.evaluate((id) => window.__vault.list(id).itemIds, albumId);
  const addElsewhere = (add) => page.evaluate(({ id, x }) => window.__vault.updateList(id, { itemIds: [...window.__vault.list(id).itemIds, x] }), { id: albumId, x: add });
  const editor = page.locator('.sheet.al-editor');
  // a reorder is waiting for its debounced save when an import adds c to the album
  await editor.getByRole('button', { name: 'Move a.png down' }).click();
  await addElsewhere(c);
  await expect.poll(ids).toEqual([b, a, c]);
  await expect(editor.locator('.al-ed-row')).toHaveCount(3);
  // same while a removal is saved right away
  await editor.getByRole('button', { name: 'Move a.png up' }).click();
  await addElsewhere(d);
  await editor.getByRole('button', { name: 'Remove b.png from the album' }).click();
  await expect.poll(ids).toEqual([a, c, d]);
  await expect(editor.locator('.al-ed-row')).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('a folder dropped inside an album view: ticking "Create album" keeps every file in the open album too', async ({ page }) => {
  const errors = await watch(page);
  await openVault(page);
  const tripId = await page.evaluate(async () => (await window.__vault.createList({ name: 'Trip' })).id);
  await page.evaluate(async (album) => {
    const f = window.__fx;
    window.__p = window.__U.importFiles({ vault: window.__vault, files: [], album, folders: [{ name: 'Paris', files: [await f('image.png', 'a.png', 'image/png'), window.__big(12, 'b.bin'), await f('notes.txt', 'c.txt')] }] });
    // inside an album the files go to that album; a folder album is opt-in: ticked while b.bin is being added
    window.__ticked = await window.__whenRunning('b.bin', () => {
      const box = document.querySelector('.up-group-opt input');
      const was = box.checked;
      box.click();
      return [was, box.checked];
    });
    await window.__p;
  }, tripId);
  expect(await page.evaluate(() => window.__ticked)).toEqual([false, true]);
  const lists = await page.evaluate(() => window.__vault.lists().map((l) => ({ name: l.name, items: l.itemIds.map((id) => window.__vault.item(id).name).sort() })));
  expect(lists).toEqual([
    { name: 'Trip', items: ['a.png', 'b.bin', 'c.txt'] },
    { name: 'Paris', items: ['a.png', 'b.bin', 'c.txt'] },
  ]);
  expect(errors).toEqual([]);
});

test('a folder album made for a batch that was interrupted before any file landed goes away when the queue is cleared', async ({ page }) => {
  const errors = await watch(page);
  await openVault(page);
  await page.evaluate(async () => {
    window.__p = window.__U.importFiles({ vault: window.__vault, files: [], folders: [{ name: 'Empty trip', files: [window.__big(12, 'b.bin')] }] });
    await window.__whenRunning('b.bin', () => true);
    window.__vault.lock('user');
    await window.__p;
  });
  await page.evaluate((pass) => window.__vault.unlock(pass), PASS);
  // the album was made when the first file started; nothing landed in it
  expect(await page.evaluate(() => window.__vault.lists().map((l) => [l.name, l.itemIds.length]))).toEqual([['Empty trip', 0]]);
  const dock = page.locator('.up-dock');
  await expect(dock).toHaveAttribute('data-state', 'interrupted');
  await dock.getByRole('button', { name: 'Clear' }).click();
  await expect(dock).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__vault.lists().length)).toBe(0);
  expect(errors).toEqual([]);
});

test('deleting the vault drops interrupted imports; adding files without a vault says to create one', async ({ page }) => {
  const errors = await watch(page);
  await openVault(page);
  await page.evaluate(async () => {
    window.__p = window.__U.importFiles({ vault: window.__vault, files: [window.__big(12, 'b.bin'), await window.__fx('notes.txt')] });
    await window.__whenRunning('b.bin', () => true);
    window.__vault.lock('user');
    await window.__p;
  });
  const dock = page.locator('.up-dock');
  await expect(dock).toHaveAttribute('data-state', 'interrupted');
  await page.evaluate(() => window.__vault.destroy());
  // the queue belonged to the deleted vault: a later "Retry" must not put its files into a new one
  await expect(dock).toHaveCount(0);
  const r = await page.evaluate(async () => {
    const res = await window.__U.importFiles({ vault: window.__vault, files: [await window.__fx('notes.txt')] });
    return { added: res.added.length, skipped: res.skipped };
  });
  expect(r).toEqual({ added: 0, skipped: 1 });
  await expect(page.locator('.toast').last()).toContainText('Create your vault first');
  expect(errors).toEqual([]);
});

test('a folder with nothing but hidden/system files says so (picked or dropped)', async ({ page }) => {
  const errors = await watch(page);
  await openVault(page);
  const r = await page.evaluate(async () => {
    const res = await window.__U.importFiles({ vault: window.__vault, files: [], folders: [{ name: 'Mac stuff', files: [new File(['x'], '.DS_Store'), new File(['y'], 'Thumbs.db')] }] });
    return { added: res.added.length, items: window.__vault.items().length };
  });
  expect(r).toEqual({ added: 0, items: 0 });
  await expect(page.locator('.toast').last()).toContainText('Nothing to add');
  await expect(page.locator('.up-dock .up-row')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('vault view (phone): new albums join the strip without scrolling it sideways (the first albums stay in view)', async ({ page }) => {
  const errors = await watch(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openVaultView(page);
  await page.evaluate(async () => {
    const v = window.__vault;
    for (const name of ['One', 'Two', 'Three', 'Four']) {
      await v.createList({ name });
      await new Promise((r) => setTimeout(r, 120)); // each one renders on its own
    }
  });
  const strip = page.locator('.al-strip-list');
  await expect(strip.locator('.al-card[data-id]')).toHaveCount(4);
  await page.waitForTimeout(300);
  expect(await strip.evaluate((el) => el.scrollLeft)).toBe(0);
  await expect(strip.locator('.al-card[data-id]').first()).toBeInViewport();
  expect(errors).toEqual([]);
});
