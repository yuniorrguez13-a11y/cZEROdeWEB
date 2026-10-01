// Import queue and special-file sniffing (DESIGN §1.5, §10, §12). Owner: V1b.
// Every file is sniffed (first bytes) BEFORE import: czd2 → "Open it?" → #/open, .czb → Restore/Merge dialog
// (settings-view), old desktop .czd → #/legacy. Those are never stored. Everything else passes a pre-flight space
// check and joins ONE persistent queue dock (a fixed panel outside the routed view, so it survives route changes)
// that imports one file at a time with vault.addFile: per-file progress, speed, ETA, cancel, failure reasons, retry.
// A folder becomes an album "<folder>" (option, default on). While the queue runs it counts as a job (state.busy),
// which keeps autolock from idling out and holds the screen wake lock where available (vault/autolock.js).
// A lock interrupts the running file: interrupted rows keep their File refs, show no names while locked and can be
// retried after unlock; finished rows (they name vault items) are dropped, and the panel folds to its summary so
// the unlock form stays usable. Big queues (a folder holds up to 10,000 files) render a window of rows around the
// running file, with the rest summed up above and below it.
// Node-importable: the DOM is only touched inside functions.

import { CAPS } from '../config.js';
import { isCancel, userMessage } from '../errors.js';
import * as state from '../state.js';
import * as platform from '../platform.js';
import { isStandalone } from '../pwa.js';
import { navigate } from '../router.js';
import { isCzd2 } from '../crypto/container.js';
import { isCzb } from '../vault/backup.js';
import { isOldCzd } from '../legacy/oldczd.js';
import { playLimit } from '../media/media.js';
import { announce, h, icon, modal, toast } from '../util/dom.js';
import { extOf, fmtSize, kindOf, safeFilename } from '../util/format.js';
import { kindIcon } from './components.js';

const SNIFF_BYTES = 64;
const SNIFF_PARALLEL = 16;
const MiB = 2 ** 20;
/** Pre-flight: Σ size × 1.04 + 1 MiB must fit in quota − usage (DESIGN §1.5). */
const SPACE_FACTOR = 1.04;
const SPACE_SLACK = MiB;
/** The space dialog lists this many files one by one (largest first); the rest share one row. */
const SPACE_ROWS = 100;
/** Sniffing more files than this shows the dock in a "Checking files…" state first. */
const PREPARE_SHOW_MS = 300;
const AUTO_CLOSE_MS = 10000;
/** The dock renders at most this many file rows (a window around the running file): a 10,000-file folder must not
 * build 10,000 rows, whose layout would slow every progress frame (and so the whole import) down. */
const MAX_ROWS = 80;
/** Finished rows kept above the first active one when the window slides. */
const LEAD = 12;
/** The window slides once the running file is this close to its end. */
const TAIL = 10;
const JUNK = new Set(['thumbs.db', 'desktop.ini', '__macosx', '.ds_store']);
const TOO_BIG = 'Stored, but too big to play or save on this device. Send it as .czd or open it on a computer.';
const HINT = "Your originals are still in your Photos/Downloads. Delete them there if you only want them in the vault — after you've backed up.";
const UNREADABLE = "Couldn't read this file — it may have been moved or deleted.";
const NOTHING = 'Nothing to add: hidden and system files (like .DS_Store) are skipped.';
const UNREADABLE_NAMES = new Set(['NotReadableError', 'NotFoundError', 'NotAllowedError']);

const num = (n) => n.toLocaleString('en-US');
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const now = () => globalThis.performance?.now?.() ?? Date.now();
/** True for the 2nd+ click of a double click: buttons that change under the pointer act on the first one only. */
const once = (e) => Number(e?.detail) > 1;

// ───────── sniffing

/** "{"v":1,"type":"image"" or a "cipher" key in the first bytes (or a .czd name): an old desktop file, not any JSON. */
function looksOldDesktop(head, name) {
  if (extOf(String(name ?? '')) === 'czd') return true;
  const s = String.fromCharCode(...head);
  return /"type"\s*:\s*"image"|"cipher"\s*:/.test(s);
}

/**
 * Identifies files that must not be stored as opaque items, from their first bytes (never the name alone):
 * 'czd2' (locked cZEROde file), 'czb' (backup), 'oldczd' (cZEROde 1 desktop file) or null (an ordinary file).
 * @param {Blob} file
 * @returns {Promise<'czd2'|'czb'|'oldczd'|null>}
 */
export async function sniffFile(file) {
  if (typeof Blob === 'undefined' || !(file instanceof Blob) || file.size < 8) return null;
  let head;
  try {
    head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  } catch {
    return null; // unreadable here: the import reports the read error
  }
  if (head.length < 8) return null;
  const first8 = head.subarray(0, 8);
  if (isCzd2(first8)) return 'czd2';
  if (isCzb(first8)) return 'czb';
  if (isOldCzd(head) && looksOldDesktop(head, file.name)) return 'oldczd';
  return null;
}

async function sniffAll(files) {
  const out = new Array(files.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      out[i] = await sniffFile(files[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SNIFF_PARALLEL, files.length) }, worker));
  return out;
}

// ───────── special files → Open / Restore / Legacy

/**
 * Sends a sniffed special file where it belongs instead of importing it: 'czd2' → asks "Open it?" then hands it to
 * the Open view (state 'incoming.files', #/open); 'czb' → the Restore/Merge dialog; 'oldczd' → Legacy
 * (state 'legacy.files', #/legacy). Resolves true when the file was handed on.
 * @param {File} file
 * @param {'czd2'|'czb'|'oldczd'} kind
 * @returns {Promise<boolean>}
 */
export function routeSpecialFile(file, kind) {
  return routeSpecial([{ file, kind }]);
}

async function routeSpecial(list) {
  const of = (k) => list.filter((x) => x && x.kind === k && x.file).map((x) => x.file);
  const czb = of('czb');
  const czd = of('czd2');
  const old = of('oldczd');
  let handed = false;
  let moved = false;
  if (czb.length) {
    if (czb.length > 1) toast('One backup at a time — restore the others afterwards.', { kind: 'warn' });
    await openRestore(czb[0]);
    handed = true;
  }
  if (old.length) state.set('legacy.files', old);
  if (czd.length && await askOpen(czd)) {
    state.set('incoming.files', czd);
    navigate('#/open');
    moved = true;
    handed = true;
    if (old.length) {
      toast(`${plural(old.length, 'old cZEROde 1 file')} ${old.length === 1 ? 'is' : 'are'} waiting in Legacy.`, {
        timeout: 8000,
        action: { label: 'Open Legacy', onClick: () => navigate('#/legacy') },
      });
    }
  }
  if (old.length && !moved) {
    navigate('#/legacy');
    toast(old.length === 1 ? 'That is an old cZEROde 1 file — opened in Legacy.' : 'Those are old cZEROde 1 files — opened in Legacy.');
    handed = true;
  }
  return handed;
}

function askOpen(files) {
  const many = files.length > 1;
  const names = h('ul', { class: 'up-special-list' }, files.slice(0, 5).map((f) => h('li', { class: 'up-special-name' }, icon('lock'), h('span', { text: safeFilename(f.name) }))));
  return modal({
    title: many ? 'Locked cZEROde files' : 'Locked cZEROde file',
    className: 'up-special',
    body: h('div', { class: 'stack' },
      h('p', { class: 'up-special-lead', text: many ? `These are locked cZEROde files — Open them?` : 'This is a locked cZEROde file — Open it?' }),
      names,
      files.length > 5 ? h('p', { class: 'hint', text: `and ${files.length - 5} more` }) : null,
      h('p', { text: "Locked files are opened with their passphrase, not stored as they are. You can add what's inside to your vault afterwards." })),
    actions: [
      { label: 'Not now', kind: 'ghost', value: false },
      { label: many ? 'Open them' : 'Open it', kind: 'primary', value: true, autofocus: true },
    ],
  }).then((v) => v === true);
}

/** The Restore/Merge flow of the settings view (DESIGN §12), or a pointer to it while that view is unavailable. */
async function openRestore(file) {
  let mod = null;
  try {
    mod = await import('./settings-view.js');
  } catch (e) {
    globalThis.console?.warn?.('[upload] settings view unavailable', e);
  }
  if (typeof mod?.openRestoreDialog === 'function') {
    try {
      await mod.openRestoreDialog(file);
    } catch (e) {
      if (!isCancel(e)) toast(userMessage(e), { kind: 'err' });
    }
    return;
  }
  const go = await modal({
    title: 'cZEROde backup',
    body: 'This is a cZEROde backup (.czb). Backups are restored or merged, not stored as files — use Settings → Vault → Restore backup.',
    actions: [{ label: 'Not now', kind: 'ghost', value: false }, { label: 'Open Settings', kind: 'primary', value: true, autofocus: true }],
  });
  if (go === true) navigate('#/settings');
}

// ───────── public entry points

/**
 * True where "Add folder" makes sense: a fine pointer (desktop) and a file input that takes directories.
 * @returns {boolean}
 */
export function canPickFolder() {
  try {
    if (!globalThis.matchMedia?.('(pointer: fine)').matches) return false;
    return 'webkitdirectory' in globalThis.document.createElement('input');
  } catch {
    return false;
  }
}

/**
 * Files pasted into the page (images from the clipboard), renamed when the browser gave them a generic name.
 * @param {ClipboardEvent} e
 * @returns {File[]}
 */
export function pastedFiles(e) {
  const files = [...(e?.clipboardData?.files ?? [])].filter((f) => typeof File === 'function' && f instanceof File);
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.');
  return files.map((f, i) => {
    if (!/^image\.[a-z0-9]+$/i.test(f.name)) return f;
    const ext = extOf(f.name) || 'png';
    return new File([f], `Pasted image ${stamp}${files.length > 1 ? ` (${i + 1})` : ''}.${ext}`, { type: f.type, lastModified: Date.now() });
  });
}

/**
 * "Add files" / "Add folder": opens the picker (its FIRST await, so it runs inside the click's activation), then
 * imports what was chosen. folder: a webkitdirectory pick whose top folder becomes an album (option); only with a
 * fine pointer (canPickFolder), else the ordinary file picker opens.
 * @param {{vault: object, folder?: boolean, album?: string}} opts
 * @returns {Promise<object|void>} the import summary (see importFiles)
 */
export async function pickAndImport({ vault, folder = false, album } = {}) {
  // Folder picking is a desktop (fine pointer) feature; elsewhere this is the ordinary multi-file picker.
  const dir = Boolean(folder) && canPickFolder();
  const picked = await platform.pickFiles({ multiple: true, folder: dir });
  if (!picked?.length) return undefined;
  if (!dir) return importFiles({ vault, files: picked, album });
  const { files, folders } = groupByFolder(picked);
  if (!files.length && !folders.length) {
    toast(NOTHING, { kind: 'warn' });
    return undefined;
  }
  return importFiles({ vault, files, folders, album });
}

/**
 * Imports files: sniffs every file first and routes special ones (never stored), checks free space, then queues
 * the rest in the dock. folders: [{name, files}] (dropZone's shape) → album "<name>" per folder unless unticked.
 * album: an existing album id the loose files (and folders without their own album) go into.
 * Resolves when this batch is finished (or interrupted) with {added: ItemInfo[], failed, cancelled, interrupted,
 * routed, skipped}; §12 declares Promise<void>, so callers may ignore the value.
 * @param {{vault: object, files?: File[], folders?: Array<{name: string, files: File[]}>, album?: string}} opts
 * @returns {Promise<object>}
 */
export async function importFiles({ vault, files, folders, album } = {}) {
  return startImport({ vault, files, folders, album }).done;
}

/**
 * Starts an import (see importFiles) and returns at once. el: the queue dock (shown once something is queued).
 * @param {{vault: object, files?: File[], folders?: Array<{name: string, files: File[]}>, album?: string}} opts
 * @returns {{el: HTMLElement|null, done: Promise<object>}}
 */
export function startImport({ vault, files, folders, album } = {}) {
  const d = globalThis.document ? ensureDock() : null;
  const done = runImport({ vault, files, folders, album });
  return { el: d?.el ?? null, done };
}

// ───────── preparing a batch

const isFile = (f) => typeof Blob !== 'undefined' && f instanceof Blob;
const skipSeg = (s) => !s || s.startsWith('.') || JUNK.has(s.toLowerCase());

/** A webkitdirectory pick → loose files + [{name, files}] per top folder (dotfiles/junk skipped, depth and count capped). */
function groupByFolder(picked) {
  const files = [];
  const map = new Map();
  let count = 0;
  for (const f of picked) {
    if (count >= CAPS.folderFiles) break;
    const segs = String(f.webkitRelativePath || '').split('/').filter(Boolean);
    if (segs.length < 2) {
      if (!skipSeg(f.name)) {
        files.push(f);
        count++;
      }
      continue;
    }
    if (segs.some(skipSeg) || segs.length - 1 > CAPS.folderDepth) continue;
    const top = segs[0];
    if (!map.has(top)) map.set(top, { name: safeFilename(top), files: [] });
    map.get(top).files.push(f);
    count++;
  }
  return { files, folders: [...map.values()] };
}

/** Flattens the input into [{file, folder}] (folder: {name} | null), at most CAPS.folderFiles files per call. */
function entriesOf(files, folders) {
  const out = [];
  for (const f of Array.isArray(files) ? files : files ? [...files] : []) if (isFile(f)) out.push({ file: f, folder: null });
  for (const g of Array.isArray(folders) ? folders : []) {
    if (!g || !Array.isArray(g.files)) continue;
    const folder = { name: safeFilename(g.name || 'Folder') };
    for (const f of g.files) {
      if (out.length >= CAPS.folderFiles) break;
      if (isFile(f) && !skipSeg(f.name)) out.push({ file: f, folder });
    }
  }
  return out;
}

async function runImport({ vault, files, folders, album }) {
  const result = { added: [], failed: 0, cancelled: 0, interrupted: 0, routed: 0, skipped: 0 };
  const entries = entriesOf(files, folders);
  if (!entries.length) {
    // A folder of nothing but hidden/system files (.DS_Store, Thumbs.db…): say so instead of doing nothing.
    if (Array.isArray(folders) && folders.some((g) => g?.files?.length)) toast(NOTHING, { kind: 'warn' });
    return result;
  }
  let prepTimer = null;
  if (dock && entries.length > 1) prepTimer = setTimeout(() => dock?.setPreparing(entries.length), PREPARE_SHOW_MS);
  let kinds;
  try {
    kinds = await sniffAll(entries.map((e) => e.file));
  } finally {
    clearTimeout(prepTimer);
    dock?.setPreparing(0);
  }
  const special = [];
  let plain = [];
  entries.forEach((e, i) => (kinds[i] ? special.push({ file: e.file, kind: kinds[i] }) : plain.push(e)));
  result.routed = special.length;
  let batches = [];
  if (plain.length) {
    if (!vault || vault.status !== 'unlocked') {
      toast(notReady(vault), { kind: 'warn' });
      result.skipped = plain.length;
      plain = [];
    } else {
      const kept = await spaceCheck(vault, plain);
      result.skipped = plain.length - kept.length;
      if (kept.length) batches = enqueue(vault, kept, { album });
    }
  }
  const routing = special.length ? routeSpecial(special).catch((e) => globalThis.console?.error?.('[upload] routing failed', e)) : null;
  await Promise.all([routing, ...batches.map((b) => b.done)]);
  for (const b of batches) {
    for (const j of b.jobs) {
      if (j.state === 'done' && j.info) result.added.push(j.info);
      else if (j.state === 'failed') result.failed++;
      else if (j.state === 'cancelled') result.cancelled++;
      else if (j.state === 'interrupted') result.interrupted++;
    }
  }
  return result;
}

/** Why files can't be added right now. */
function notReady(vault) {
  switch (vault?.status) {
    case 'none':
      return 'Create your vault first — then add your files.';
    case 'other-tab':
      return userMessage('other-tab');
    case 'unavailable':
      return userMessage('store-unavailable');
    default:
      return userMessage('vault-locked');
  }
}

// ───────── pre-flight space check

async function spaceCheck(vault, entries) {
  let st = null;
  try {
    st = await vault.storage();
  } catch {
    st = null;
  }
  if (!st || !Number.isFinite(st.quota) || !Number.isFinite(st.usage) || st.quota <= 0) return entries;
  const queued = jobs.filter((j) => j.state === 'waiting' || j.state === 'running').reduce((n, j) => n + Math.max(0, j.size - j.done), 0);
  const free = Math.max(0, st.quota - st.usage - queued * SPACE_FACTOR);
  const need = (list) => list.reduce((n, e) => n + e.file.size, 0) * SPACE_FACTOR + SPACE_SLACK;
  if (need(entries) <= free) return entries;
  return spaceDialog(entries, free, need);
}

/** "Not enough space: needs X, Y free" with a checkbox per file (largest first). -> the files to import. */
function spaceDialog(entries, free, need) {
  const rows = entries
    .map((e) => ({ e, on: true, input: null }))
    .sort((a, b) => b.e.file.size - a.e.file.size);
  // The largest files get a row each (they are the ones worth skipping); a long tail shares one row.
  const own = rows.slice(0, SPACE_ROWS);
  const tail = rows.slice(SPACE_ROWS);
  const lead = h('p', { class: 'up-space-lead' });
  const fit = h('p', { class: 'hint up-space-fit', role: 'status' });
  const items = own.map((r) => {
    r.input = h('input', { type: 'checkbox', checked: true, on: { change: () => {
      r.on = r.input.checked;
      update();
    } } });
    const name = safeFilename(r.e.file.name);
    return h('li', null, h('label', { class: 'check up-space-row' },
      r.input,
      h('span', { class: 'up-space-name', text: name, title: name }),
      r.e.folder ? h('span', { class: 'up-space-folder' }, icon('folder'), h('span', { text: r.e.folder.name })) : null,
      h('span', { class: 'up-space-size', text: fmtSize(r.e.file.size) })));
  });
  let tailBox = null;
  if (tail.length) {
    tailBox = h('input', { type: 'checkbox', checked: true, on: { change: () => {
      for (const r of tail) r.on = tailBox.checked;
      update();
    } } });
    items.push(h('li', null, h('label', { class: 'check up-space-row up-space-rest' },
      tailBox,
      h('span', { class: 'up-space-name', text: `${plural(tail.length, 'smaller file')}` }),
      h('span', { class: 'up-space-size', text: fmtSize(tail.reduce((n, r) => n + r.e.file.size, 0)) }))));
  }
  const list = h('ul', { class: 'up-space-list', aria: { label: 'Files to import' } }, items);
  const fitBtn = h('button', {
    type: 'button',
    class: 'btn btn-sm btn-ghost up-space-auto',
    text: 'Keep what fits',
    dataset: { autofocus: '' },
    on: { click: () => {
      // Smallest first keeps the most files.
      let room = free - SPACE_SLACK;
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        const cost = r.e.file.size * SPACE_FACTOR;
        r.on = cost <= room;
        if (r.on) room -= cost;
      }
      update();
    } },
  });
  const p = modal({
    title: 'Not enough space',
    className: 'up-space',
    body: h('div', { class: 'stack' },
      lead,
      h('p', { text: 'Untick files to skip them, or free up space first.' }),
      h('div', { class: 'up-space-tools' }, fit, fitBtn),
      list),
    actions: [
      { label: 'Cancel', kind: 'ghost', value: null },
      { label: 'Import', kind: 'primary', value: 'go' },
    ],
  });
  const go = p.el.querySelector('.modal-actions .btn:last-child');
  function update() {
    for (const r of own) r.input.checked = r.on;
    if (tailBox) {
      const n = tail.filter((r) => r.on).length;
      tailBox.checked = n === tail.length;
      tailBox.indeterminate = n > 0 && n < tail.length;
    }
    const sel = rows.filter((r) => r.on).map((r) => r.e);
    lead.textContent = `Not enough space: needs ${fmtSize(need(entries))}, ${fmtSize(free)} free.`;
    const fits = need(sel) <= free;
    fit.textContent = sel.length
      ? `${plural(sel.length, 'file')} selected · needs ${fmtSize(need(sel))}${fits ? ' — fits' : ' — still too much'}`
      : 'Nothing selected';
    fit.classList.toggle('hint-warn', !fits && sel.length > 0);
    fit.classList.toggle('up-space-ok', fits && sel.length > 0);
    // Estimates are rough (browsers round them): importing more than fits stays possible, but says so.
    go.textContent = !sel.length ? 'Import' : fits ? `Import ${plural(sel.length, 'file')}` : `Import ${plural(sel.length, 'file')} anyway`;
    go.disabled = sel.length === 0;
  }
  update();
  return p.then((v) => (v === 'go' ? rows.filter((r) => r.on).map((r) => r.e) : []));
}

// ───────── the queue

/**
 * @typedef {{id: number, vault: object, file: File, name: string, size: number, kind: string, batch: Batch,
 *   state: 'waiting'|'running'|'done'|'failed'|'cancelled'|'interrupted', done: number, error: string|null,
 *   ctl: AbortController|null, cancelled: boolean, info: object|null, warn: string|null, row: object|null, gone: boolean}} Job
 * @typedef {{id: number, vault: object, folder: string|null, createAlbum: boolean, albumId: string|null, album: string|null,
 *   albumPending: Promise<string|null>|null, addedIds: string[], jobs: Job[], done: Promise<void>, resolve: () => void,
 *   settled: boolean, head: object|null}} Batch
 */

/** @type {Job[]} */
let jobs = [];
/** @type {Batch[]} */
let batches = [];
let seq = 0;
let pumping = false;
let dock = null;
let hintShown = false;
const hookedVaults = new WeakSet();
/** Queue-wide speed (EMA, bytes/s) for the header and per-file ETAs. */
const meter = { t: 0, bytes: 0, speed: 0 };

function enqueue(vault, entries, { album }) {
  hookVault(vault);
  const groups = new Map();
  for (const e of entries) {
    const key = e.folder ?? null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const made = [];
  for (const [folder, list] of groups) {
    let resolve;
    const done = new Promise((r) => {
      resolve = r;
    });
    /** @type {Batch} */
    const b = {
      id: ++seq,
      vault,
      folder: folder ? folder.name : null,
      // Inside an album view the files go to that album; a new folder album is then opt-in.
      createAlbum: Boolean(folder) && !(typeof album === 'string' && album),
      albumId: null,
      albumPending: null,
      album: typeof album === 'string' && album ? album : null,
      addedIds: [],
      jobs: [],
      done,
      resolve,
      settled: false,
      head: null,
    };
    for (const e of list) {
      const name = safeFilename(e.file.name);
      b.jobs.push({
        id: ++seq,
        vault,
        file: e.file,
        name,
        size: e.file.size,
        kind: kindOf(e.file.type, name),
        batch: b,
        state: 'waiting',
        done: 0,
        error: null,
        ctl: null,
        cancelled: false,
        info: null,
        warn: null,
        row: null,
        gone: false,
      });
    }
    batches.push(b);
    jobs.push(...b.jobs);
    made.push(b);
  }
  const d = ensureDock();
  d.added();
  d.show();
  startPump();
  return made;
}

function hookVault(vault) {
  if (!vault || typeof vault.addEventListener !== 'function' || hookedVaults.has(vault)) return;
  hookedVaults.add(vault);
  vault.addEventListener('status', () => {
    // The vault was deleted: what is left of the queue belongs to it (a later Retry must not fill a new vault).
    if (vault.status === 'none') forgetQueue(vault);
    dock?.repaint();
    if (vault.status === 'unlocked') dock?.unlocked();
  });
}

/** Drops the vault's unfinished imports (nothing of them runs: a lock came first) and closes the panel when empty. */
function forgetQueue(vault) {
  if (jobs.some((j) => j.vault === vault && (j.state === 'waiting' || j.state === 'running'))) return;
  for (const j of jobs) {
    if (j.vault !== vault) continue;
    j.gone = true;
    j.info = null;
    j.row = null;
  }
  jobs = jobs.filter((j) => j.vault !== vault);
  for (const b of batches) {
    if (b.vault !== vault) continue;
    b.albumId = null;
    b.resolve();
  }
  batches = batches.filter((b) => b.vault !== vault);
  if (!dock) return;
  if (!jobs.length) dock.close();
  else dock.rebuild();
}

const isLocked = () => {
  const v = jobs[0]?.vault ?? batches[0]?.vault;
  return !v || v.status !== 'unlocked';
};

function startPump() {
  pump().catch((e) => globalThis.console?.error?.('[upload] queue failed', e));
}

async function pump() {
  if (pumping) return;
  pumping = true;
  state.busy(1);
  meter.t = now();
  meter.bytes = 0;
  try {
    for (;;) {
      const job = jobs.find((j) => j.state === 'waiting');
      if (!job) break;
      if (job.vault.status !== 'unlocked') {
        for (const j of jobs) if (j.state === 'waiting') j.state = 'interrupted';
        break;
      }
      await runJob(job);
    }
  } finally {
    pumping = false;
    state.busy(-1);
    meter.speed = 0;
    settleBatches();
    dock?.repaint();
    dock?.idle();
  }
}

/**
 * The batch's folder album, created on first use (one creation at a time: the checkbox and the queue may both ask).
 * Dropped again when the option was unticked while it was being created.
 */
function ensureAlbum(b) {
  if (b.albumId) return Promise.resolve(b.albumId);
  b.albumPending ??= b.vault.createList({ name: b.folder, itemIds: b.addedIds }).then((l) => {
    b.albumPending = null;
    if (!b.createAlbum) {
      b.vault.removeList(l.id).catch(() => {});
      return null;
    }
    b.albumId = l.id;
    return l.id;
  }, (e) => {
    b.albumPending = null;
    throw e;
  });
  return b.albumPending;
}

/**
 * The album a file is added to: the album the import was started in (its view is open), else the batch's folder
 * album. A file that should be in both is added to the first and joins the folder album afterwards (joinAlbum).
 */
async function albumFor(job) {
  const b = job.batch;
  let own = null;
  if (b.folder && b.createAlbum) {
    try {
      own = await ensureAlbum(b);
    } catch (e) {
      globalThis.console?.warn?.('[upload] album not created', e);
    }
  }
  return b.album ?? own;
}

/**
 * The file landed outside its folder album (the option was ticked while it was being added, or the import was
 * started inside another album): put it in now.
 */
async function joinAlbum(b, id) {
  if (!b.folder || !b.createAlbum || !b.albumId || b.vault.status !== 'unlocked') return;
  try {
    const l = b.vault.list(b.albumId);
    if (!l.itemIds.includes(id)) await b.vault.updateList(b.albumId, { itemIds: [...l.itemIds, id] });
  } catch (e) {
    globalThis.console?.warn?.('[upload] album not updated', e);
  }
}

/**
 * Why a file failed. A file that was moved, deleted or changed after it was picked can't be read any more; browsers
 * report that differently (NotReadableError, or a bare "network error" TypeError from its stream), so a failure
 * that isn't one of ours is checked by reading the file's first byte again.
 */
async function failureText(e, file) {
  const names = [e?.name, e?.cause?.name, e?.cause?.cause?.name];
  if (names.some((n) => UNREADABLE_NAMES.has(n))) return UNREADABLE;
  if (!e?.code || e.code === 'internal') {
    try {
      await file.slice(0, 1).arrayBuffer();
    } catch {
      return UNREADABLE;
    }
  }
  return userMessage(e);
}

async function runJob(job) {
  job.state = 'running';
  job.done = 0;
  job.error = null;
  job.cancelled = false;
  job.ctl = new AbortController();
  dock?.started(job);
  dock?.paintJob(job);
  dock?.paintHead();
  const v = job.vault;
  try {
    const album = await albumFor(job);
    if (job.cancelled) throw new DOMException('cancelled', 'AbortError');
    const info = await v.addFile(job.file, {
      album: album ?? undefined,
      signal: job.ctl.signal,
      onProgress: (done) => progress(job, done),
    });
    job.state = 'done';
    job.info = info;
    job.done = job.size;
    job.batch.addedIds.push(info.id);
    if (album !== job.batch.albumId) await joinAlbum(job.batch, info.id);
    const k = info.kind;
    if ((k === 'video' || k === 'audio') && info.size > playLimit(k)) job.warn = TOO_BIG;
  } catch (e) {
    if (job.cancelled) job.state = 'cancelled';
    else if (e?.code === 'interrupted' || e?.code === 'vault-locked' || v.status !== 'unlocked') job.state = 'interrupted';
    else if (isCancel(e)) job.state = 'cancelled';
    else {
      job.state = 'failed';
      job.error = await failureText(e, job.file);
      if (e?.code === 'quota-exceeded') {
        // Everything after it would fail the same way: stop here; "Retry failed" picks them up after cleaning up.
        for (const j of jobs) {
          if (j.state !== 'waiting') continue;
          j.state = 'failed';
          j.error = userMessage('quota-exceeded');
          dock?.paintJob(j);
        }
      }
    }
    if (job.state !== 'done') job.done = 0;
  } finally {
    job.ctl = null;
    dock?.paintJob(job);
    dock?.paintHead();
  }
}

function progress(job, done) {
  const n = Math.max(0, Math.min(job.size, Number(done) || 0));
  const delta = n - job.done;
  job.done = n;
  if (delta > 0) {
    meter.bytes += delta;
    const t = now();
    const dt = (t - meter.t) / 1000;
    if (dt >= 0.25) {
      const inst = meter.bytes / dt;
      meter.speed = meter.speed ? meter.speed * 0.7 + inst * 0.3 : inst;
      meter.t = t;
      meter.bytes = 0;
    }
  }
  dock?.schedulePaint(job);
}

/** Resolves each batch whose jobs all reached a final (or interrupted) state; drops empty folder albums. */
function settleBatches() {
  for (const b of batches) {
    if (b.settled || b.jobs.some((j) => j.state === 'waiting' || j.state === 'running')) continue;
    b.settled = true;
    dropEmptyAlbum(b);
    b.resolve();
  }
}

/**
 * Removes the batch's folder album when none of its files landed (it is made when the first file starts) and nothing
 * else was put in it meanwhile. Locked: kept (a retry after unlock fills it; clearing the queue then drops it).
 */
function dropEmptyAlbum(b) {
  if (!b.albumId || b.addedIds.length || b.vault.status !== 'unlocked') return;
  let l = null;
  try {
    l = b.vault.list(b.albumId);
  } catch {
    l = null; // gone already
  }
  const id = b.albumId;
  b.albumId = null;
  if (l && !l.itemIds.length) b.vault.removeList(id).catch(() => {});
}

function cancelJob(job) {
  if (job.state === 'waiting') {
    job.state = 'cancelled';
    job.cancelled = true;
    dock?.paintJob(job);
    dock?.paintHead();
    settleBatches();
    if (!pumping) dock?.idle();
  } else if (job.state === 'running') {
    job.cancelled = true;
    job.ctl?.abort(new DOMException('cancelled', 'AbortError'));
  }
}

/** One pass for the whole queue (cancelling 10,000 waiting files one by one would repaint 10,000 times). */
function cancelAll() {
  for (const j of jobs) {
    if (j.state !== 'waiting') continue;
    j.state = 'cancelled';
    j.cancelled = true;
    dock?.paintJob(j);
  }
  const running = jobs.find((j) => j.state === 'running');
  if (running) cancelJob(running);
  dock?.paintHead();
  settleBatches();
  if (!pumping) dock?.idle();
}

function retry(list) {
  let any = false;
  for (const j of list) {
    if (!['failed', 'interrupted', 'cancelled'].includes(j.state)) continue;
    j.state = 'waiting';
    j.error = null;
    j.cancelled = false;
    j.done = 0;
    if (j.batch.settled) {
      j.batch.settled = false;
      const b = j.batch;
      b.done = new Promise((r) => {
        b.resolve = r;
      });
    }
    dock?.paintJob(j);
    any = true;
  }
  if (!any) return;
  dock?.paintHead();
  dock?.show();
  startPump();
}

async function setCreateAlbum(b, on) {
  b.createAlbum = on;
  if (b.vault.status !== 'unlocked') return;
  try {
    if (!on && b.albumId) {
      const id = b.albumId;
      b.albumId = null;
      await b.vault.removeList(id);
    } else if (on && b.addedIds.length) {
      await ensureAlbum(b);
    }
  } catch (e) {
    if (!isCancel(e)) toast(userMessage(e), { kind: 'err' });
  }
}

// Lock: the running file is interrupted (vault.lock aborts it), waiting ones too; finished rows go (they name vault
// items) and the rest show no names until the vault is unlocked again. The panel folds down to its summary so it
// doesn't cover the unlock form.
state.onPurge(() => {
  if (!jobs.length && !dock) return;
  for (const j of jobs) {
    if (j.state === 'waiting' || j.state === 'running') j.state = 'interrupted';
    if (j.ctl && !j.ctl.signal.aborted) j.ctl.abort(new DOMException('locked', 'AbortError'));
  }
  const keep = (j) => j.state === 'interrupted' || j.state === 'failed';
  for (const j of jobs) {
    if (keep(j)) continue;
    j.info = null;
    j.gone = true;
  }
  jobs = jobs.filter(keep);
  for (const b of batches) b.jobs = b.jobs.filter(keep);
  batches = batches.filter((b) => b.jobs.length || !b.settled);
  if (!dock) return;
  dock.hideHint();
  if (!jobs.length) dock.close();
  else {
    dock.rebuild();
    dock.locked();
  }
});

// ───────── formatting

function fmtEta(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  if (sec < 5) return 'a few seconds left';
  if (sec < 60) return `${Math.round(sec)} s left`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min left`;
  const hrs = Math.floor(m / 60);
  return `${hrs} h ${m % 60} min left`;
}

function jobStatus(job, locked) {
  switch (job.state) {
    case 'waiting':
      return 'Waiting';
    case 'running': {
      if (!job.done) return `Encrypting · ${fmtSize(job.size)}`;
      const parts = [`${fmtSize(job.done)} of ${fmtSize(job.size)}`];
      if (meter.speed > 0) {
        parts.push(`${fmtSize(meter.speed)}/s`);
        const eta = fmtEta((job.size - job.done) / meter.speed);
        if (eta) parts.push(eta);
      }
      return parts.join(' · ');
    }
    case 'done':
      return job.warn ?? 'Added';
    case 'failed':
      return job.error ?? userMessage('internal');
    case 'cancelled':
      return 'Cancelled';
    case 'interrupted':
      return locked ? userMessage('interrupted') : 'Interrupted by the lock';
    default:
      return '';
  }
}

// ───────── the dock (fixed panel; one per page)

function ensureDock() {
  if (dock && dock.el.isConnected) return dock;
  const had = Boolean(dock);
  dock = buildDock();
  if (had && jobs.length) {
    // The old panel was removed from the page: carry the queue over.
    for (const j of jobs) j.row = null;
    for (const b of batches) b.head = null;
    dock.rebuild();
    dock.show();
  }
  return dock;
}

function buildDock() {
  const d = globalThis.document;
  const bodyId = `up-body-${++seq}`;
  const fill = h('div', { class: 'up-bar-fill' });
  const bar = h('div', { class: 'up-bar', role: 'progressbar', aria: { label: 'Import progress', valuemin: '0', valuemax: '100', valuenow: '0' } }, fill);
  const headIcon = h('span', { class: 'up-head-icon' }, icon('upload'));
  const title = h('span', { class: 'up-title' });
  const status = h('span', { class: 'up-status' });
  const pct = h('span', { class: 'up-pct' });
  const live = h('span', { class: 'visually-hidden', aria: { live: 'polite' } });
  const toggle = h('button', {
    type: 'button',
    class: 'btn-icon up-toggle',
    aria: { label: 'Collapse import queue', expanded: 'true', controls: bodyId },
    on: { click: () => {
      autoCollapsed = false;
      setCollapsed(!collapsed);
    } },
  }, icon('back'));
  const closeBtn = h('button', { type: 'button', class: 'btn-icon up-close', aria: { label: 'Close import queue' }, on: { click: () => api.close() } }, icon('close'));
  const head = h('div', { class: 'up-head' },
    headIcon,
    h('div', { class: 'up-head-text' }, title, status),
    pct, toggle, closeBtn, live);
  const hintText = h('p', { class: 'up-hint-text', text: HINT });
  const hint = h('div', { class: 'up-hint', hidden: true, role: 'note' },
    h('span', { class: 'up-hint-icon' }, icon('info')),
    h('div', { class: 'up-hint-main' },
      hintText,
      h('div', { class: 'up-hint-actions' },
        h('button', { type: 'button', class: 'btn btn-sm btn-primary', text: 'Back up now', on: { click: () => backUpNow() } }),
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Got it', on: { click: () => api.hideHint() } }))));
  const list = h('ul', { class: 'up-list', aria: { label: 'Files' } });
  // Rows outside the rendered window are summed up in these two lines.
  const moreTop = h('li', { class: 'up-more up-more-top' });
  const moreBottom = h('li', { class: 'up-more up-more-bottom' });
  const footText = h('span', { class: 'up-foot-text' });
  const footBtns = h('div', { class: 'up-foot-actions' });
  const foot = h('div', { class: 'up-foot' }, footText, footBtns);
  const body = h('div', { class: 'up-body', id: bodyId }, hint, list, foot);
  const el = h('section', { class: 'up-dock', hidden: true, role: 'region', aria: { label: 'Import queue' }, dataset: { state: 'idle' } }, bar, head, body);
  (d.getElementById('app') ?? d.body).append(el);

  let collapsed = false;
  let autoCollapsed = false;
  let preparing = 0;
  const rafPending = new Set();
  let rafId = 0;
  let closeTimer = null;
  let hovered = false;
  let lastAnnounced = '';
  let settingsMod = null;
  let shownIcon = null;
  let footMode = null;
  /** Rendered slice of `jobs`: [start, end). */
  const win = { start: 0, end: 0 };
  /** Keep the running file in view until the user scrolls the list themselves. */
  let follow = true;
  /** Where keyboard focus came from (given back when the panel closes under it). */
  let returnFocus = null;

  // Lift the panel above what else sits at the bottom: the player dock, and on phones the vault's selection
  // toolbar (fixed above the nav; the panel would hide it while an import runs).
  const player = d.getElementById('player-dock');
  const win0 = globalThis.window;
  let ro = null;
  const lift = () => {
    const ph = player && player.offsetParent !== null ? player.getBoundingClientRect().height : 0;
    let bh = 0;
    const bar = d.querySelector('.vv-selbar');
    if (bar && !bar.hidden && bar.getClientRects().length && globalThis.getComputedStyle?.(bar).position === 'fixed') {
      const r = bar.getBoundingClientRect();
      if (r.bottom > (win0?.innerHeight ?? 0) - 200) bh = r.height + 8;
    }
    el.style.setProperty('--up-lift', `${Math.round(Math.max(ph, bh))}px`);
  };
  let liftRaf = 0;
  const liftSoon = () => {
    if (liftRaf || el.hidden) return; // a hidden panel (nothing queued yet) skips the work; show() lifts it
    const raf = globalThis.requestAnimationFrame ?? ((f) => setTimeout(f, 16));
    liftRaf = raf(() => {
      liftRaf = 0;
      if (el.isConnected) lift();
    });
  };
  if (player && typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(liftSoon);
    ro.observe(player);
  }
  const mo = typeof MutationObserver === 'function' ? new MutationObserver(liftSoon) : null;
  mo?.observe(d.getElementById('main') ?? d.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
  win0?.addEventListener?.('resize', liftSoon);
  lift();
  const offPlayer = state.on('player', liftSoon);

  el.addEventListener('pointerenter', () => {
    hovered = true;
    clearTimeout(closeTimer);
  });
  el.addEventListener('pointerleave', () => {
    hovered = false;
    api.idle();
  });
  el.addEventListener('focusin', (e) => {
    clearTimeout(closeTimer);
    const from = e.relatedTarget;
    if (from instanceof Element && !el.contains(from)) returnFocus = from;
  });
  el.addEventListener('focusout', (e) => {
    if (!el.contains(e.relatedTarget)) setTimeout(() => api.idle(), 0);
  });
  const stopFollowing = () => {
    follow = false;
  };
  list.addEventListener('wheel', stopFollowing, { passive: true });
  list.addEventListener('touchmove', stopFollowing, { passive: true });
  list.addEventListener('pointerdown', (e) => {
    if (e.target === list) stopFollowing(); // the scrollbar
  });
  list.addEventListener('keydown', (e) => {
    if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(e.key)) stopFollowing();
  });

  function setCollapsed(v) {
    collapsed = Boolean(v);
    el.classList.toggle('up-collapsed', collapsed);
    body.hidden = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Expand import queue' : 'Collapse import queue');
  }

  function backUpNow() {
    // Its first await is the save picker: call it right inside this click (module preloaded when the hint showed).
    api.hideHint();
    if (typeof settingsMod?.openBackupExport === 'function') {
      Promise.resolve(settingsMod.openBackupExport()).catch((e) => {
        if (!isCancel(e)) toast(userMessage(e), { kind: 'err' });
      });
    } else {
      navigate('#/settings');
    }
  }

  function rowFor(job) {
    const iconBox = h('span', { class: 'up-row-icon' });
    const name = h('span', { class: 'up-row-name' });
    const size = h('span', { class: 'up-row-size' });
    const fillEl = h('div', { class: 'progress-fill' });
    const pbar = h('div', { class: 'progress up-row-bar', role: 'progressbar', aria: { valuemin: '0', valuemax: '100', valuenow: '0' } }, fillEl);
    const st = h('span', { class: 'up-row-status' });
    const btn = h('button', { type: 'button', class: 'btn-icon up-row-btn', on: { click: (e) => {
      if (once(e)) return; // the second click of a double click would retry what the first one cancelled
      if (job.state === 'waiting' || job.state === 'running') cancelJob(job);
      else retry([job]);
    } } });
    const li = h('li', { class: 'up-row', dataset: { state: job.state } },
      iconBox,
      h('div', { class: 'up-row-main' }, h('div', { class: 'up-row-top' }, name, size), pbar, st),
      btn);
    return { li, iconBox, name, size, pbar, fill: fillEl, st, btn, kindShown: null, btnMode: null };
  }

  function headFor(b) {
    const box = h('input', {
      type: 'checkbox',
      checked: b.createAlbum,
      on: { change: () => setCreateAlbum(b, box.checked) },
    });
    const name = h('span', { class: 'up-group-name' });
    const count = h('span', { class: 'up-group-count' });
    const optText = h('span');
    const opt = h('label', { class: 'up-group-opt' }, box, optText);
    const li = h('li', { class: 'up-group' }, h('div', { class: 'up-group-top' }, h('span', { class: 'up-group-icon' }, icon('folder')), name, count), opt);
    return { li, box, name, count, optText, opt };
  }

  function paintGroup(b) {
    if (!b.head) return;
    const locked = isLocked();
    b.head.name.textContent = locked ? 'Folder' : b.folder;
    b.head.count.textContent = plural(b.jobs.length, 'file');
    b.head.optText.textContent = locked ? 'Create an album for this folder' : `Create album “${b.folder}”`;
    b.head.box.checked = b.createAlbum;
    b.head.box.disabled = locked;
  }

  /** Index of the job the window is built around: the first unfinished one, else the first failed one, else the last. */
  function anchor() {
    let firstBad = -1;
    for (let i = 0; i < jobs.length; i++) {
      const s = jobs[i].state;
      if (s === 'running' || s === 'waiting') return i;
      if (firstBad < 0 && (s === 'failed' || s === 'interrupted')) firstBad = i;
    }
    return firstBad >= 0 ? firstBad : jobs.length - 1;
  }

  /**
   * Puts the rows of the window (at most MAX_ROWS files around the anchor, with their folder headers) in the list,
   * reusing existing rows; the DOM is only touched when the sequence changed, and focus survives the move.
   */
  function syncList() {
    const n = jobs.length;
    let start = 0;
    let end = n;
    if (n > MAX_ROWS) {
      start = Math.max(0, Math.min(anchor() - LEAD, n - MAX_ROWS));
      end = start + MAX_ROWS;
    }
    win.start = start;
    win.end = end;
    const nodes = [];
    if (start > 0) nodes.push(moreTop);
    const shown = new Set();
    const heads = new Set();
    let last = null;
    for (let i = start; i < end; i++) {
      const j = jobs[i];
      if (j.batch !== last) {
        last = j.batch;
        if (last.folder) {
          last.head ??= headFor(last);
          heads.add(last);
          nodes.push(last.head.li);
        }
      }
      const fresh = !j.row;
      j.row ??= rowFor(j);
      shown.add(j);
      nodes.push(j.row.li);
      if (fresh) api.paintJob(j);
    }
    if (end < n) nodes.push(moreBottom);
    if (n > MAX_ROWS) {
      for (const j of jobs) if (j.row && !shown.has(j)) j.row = null;
      for (const b of batches) if (b.head && !heads.has(b)) b.head = null;
    }
    for (const b of heads) paintGroup(b);
    const cur = list.children;
    let same = cur.length === nodes.length;
    for (let i = 0; same && i < nodes.length; i++) same = cur[i] === nodes[i];
    if (!same) {
      const active = d.activeElement;
      list.replaceChildren(...nodes);
      if (active && active !== d.activeElement && list.contains(active)) active.focus({ preventScroll: true });
    }
  }

  /** Scrolls the list (never the page) so the job's row is in view, near the top: the next files show below it. */
  function reveal(job) {
    const li = job.row?.li;
    if (!li || collapsed || el.hidden || !li.isConnected) return;
    const lr = list.getBoundingClientRect();
    const r = li.getBoundingClientRect();
    if (r.top >= lr.top && r.bottom <= lr.bottom) return;
    list.scrollTop += r.top - lr.top - Math.min(r.height, lr.height / 4);
  }

  const api = {
    el,
    show() {
      if (el.hidden) {
        el.hidden = false;
        lift();
      }
      clearTimeout(closeTimer);
    },
    setPreparing(n) {
      preparing = n;
      if (n) api.show();
      api.paintHead();
      if (!n && !jobs.length) el.hidden = true;
      else if (!n) api.idle();
    },
    /** New batches were queued. */
    added() {
      follow = true;
      syncList();
      api.paintHead();
    },
    /** A job started: slide the window when it is near its end, and keep the job in view. */
    started(job) {
      if (jobs.length > MAX_ROWS) {
        const i = jobs.indexOf(job);
        if (i < win.start || i >= win.end - TAIL) syncList();
      }
      if (follow && job.row) {
        const raf = globalThis.requestAnimationFrame ?? ((f) => setTimeout(f, 16));
        raf(() => reveal(job));
      }
    },
    /** Rebuilds the list (after a lock dropped rows, or a new panel took the queue over). */
    rebuild() {
      syncList();
      api.repaint();
    },
    repaint() {
      for (const b of batches) paintGroup(b);
      for (let i = win.start; i < Math.min(win.end, jobs.length); i++) api.paintJob(jobs[i]);
      api.paintHead();
    },
    /** Locked: fold down to the summary (it would cover the unlock form otherwise). */
    locked() {
      if (collapsed) return;
      autoCollapsed = true;
      setCollapsed(true);
    },
    unlocked() {
      if (!autoCollapsed) return;
      autoCollapsed = false;
      setCollapsed(false);
    },
    schedulePaint(job) {
      rafPending.add(job);
      if (rafId) return;
      const raf = globalThis.requestAnimationFrame ?? ((f) => setTimeout(f, 16));
      rafId = raf(() => {
        rafId = 0;
        const list2 = [...rafPending];
        rafPending.clear();
        for (const j of list2) api.paintJob(j);
        api.paintHead();
      });
    },
    paintJob(job) {
      const r = job.row;
      if (!r || job.gone) return;
      const locked = isLocked();
      r.li.dataset.state = job.state;
      r.li.classList.toggle('up-row-warn', Boolean(job.warn) && job.state === 'done');
      const kind = locked ? 'locked' : job.kind;
      if (r.kindShown !== kind) {
        r.kindShown = kind;
        r.iconBox.replaceChildren(locked ? h('span', { class: 'kind-icon' }, icon('lock')) : kindIcon(job.kind));
      }
      r.name.textContent = locked ? 'Hidden while locked' : job.name;
      r.name.title = locked ? '' : job.name;
      r.name.classList.toggle('up-row-hidden', locked);
      r.size.textContent = locked ? '' : fmtSize(job.size);
      const pctv = job.size > 0 ? (job.done / job.size) * 100 : job.state === 'done' ? 100 : 0;
      r.fill.style.width = `${Math.max(0, Math.min(100, pctv)).toFixed(1)}%`;
      r.pbar.setAttribute('aria-valuenow', String(Math.round(pctv)));
      r.pbar.setAttribute('aria-label', locked ? 'File' : job.name);
      r.pbar.hidden = job.state !== 'running';
      r.st.textContent = jobStatus(job, locked);
      let mode = null;
      if (job.state === 'waiting' || job.state === 'running') mode = 'cancel';
      else if (['failed', 'interrupted', 'cancelled'].includes(job.state) && !locked) mode = 'retry';
      else if (job.state === 'done') mode = job.warn ? 'warn' : 'done';
      if (r.btnMode !== mode) {
        r.btnMode = mode;
        if (mode === 'cancel') r.btn.replaceChildren(icon('close'));
        else if (mode === 'retry') r.btn.replaceChildren(icon('refresh'));
        else if (mode === 'done') r.btn.replaceChildren(icon('check'));
        else if (mode === 'warn') r.btn.replaceChildren(icon('warning'));
        r.btn.hidden = mode === null;
        r.btn.disabled = mode === 'done' || mode === 'warn';
        r.btn.classList.toggle('up-row-ok', mode === 'done' || mode === 'warn');
      }
      const label = locked ? 'this file' : job.name;
      if (mode === 'cancel') r.btn.setAttribute('aria-label', `Cancel ${label}`);
      else if (mode === 'retry') r.btn.setAttribute('aria-label', `Retry ${label}`);
      else if (mode === 'done' || mode === 'warn') r.btn.setAttribute('aria-label', 'Added');
    },
    paintHead() {
      const locked = isLocked();
      // One pass over the queue (it can hold 10,000 files; this runs every progress frame).
      let running = 0;
      let waiting = 0;
      let added = 0;
      let failed = 0;
      let interrupted = 0;
      let cancelled = 0;
      let warned = 0;
      let total = 0;
      let doneBytes = 0;
      let pos = 0;
      let of = 0;
      const above = { done: 0, failed: 0, other: 0 };
      let belowWaiting = 0;
      for (let i = 0; i < jobs.length; i++) {
        const j = jobs[i];
        const s = j.state;
        if (s === 'running') running++;
        else if (s === 'waiting') waiting++;
        else if (s === 'done') {
          added++;
          if (j.warn) warned++;
        } else if (s === 'failed') failed++;
        else if (s === 'interrupted') interrupted++;
        else if (s === 'cancelled') cancelled++;
        if (s !== 'cancelled') {
          total += j.size;
          of++;
          if (!pos && (s === 'running' || s === 'waiting')) pos = of;
        }
        if (s === 'done') doneBytes += j.size;
        else if (s === 'running') doneBytes += j.done;
        if (i < win.start) {
          if (s === 'done') above.done++;
          else if (s === 'failed' || s === 'interrupted') above.failed++;
          else above.other++;
        } else if (i >= win.end && s === 'waiting') belowWaiting++;
      }
      const pctv = total > 0 ? (doneBytes / total) * 100 : 0;
      const active = running + waiting;
      let st = 'idle';
      let t = '';
      let s = '';
      if (preparing) {
        st = 'running';
        t = 'Checking files';
        s = `${plural(preparing, 'file')}…`;
      } else if (active) {
        st = 'running';
        t = 'Importing';
        const parts = [`${num(Math.max(1, pos))} of ${num(of)}`];
        if (meter.speed > 0) {
          parts.push(`${fmtSize(meter.speed)}/s`);
          const eta = fmtEta((total - doneBytes) / meter.speed);
          if (eta) parts.push(eta);
        }
        s = parts.join(' · ');
      } else if (interrupted) {
        st = 'interrupted';
        t = locked ? 'Import interrupted' : 'Import paused';
        s = locked ? `${plural(interrupted, 'file')} · unlock to retry` : `${plural(interrupted, 'file')} interrupted`;
      } else if (failed) {
        st = 'failed';
        t = 'Import finished';
        s = [added ? `${num(added)} added` : null, `${num(failed)} failed`, cancelled ? `${num(cancelled)} cancelled` : null].filter(Boolean).join(' · ');
      } else if (jobs.length) {
        st = warned ? 'warn' : 'done';
        t = 'Import done';
        s = [`${plural(added, 'file')} added`, warned ? `${num(warned)} too big to play here` : null, cancelled ? `${num(cancelled)} cancelled` : null].filter(Boolean).join(' · ');
      }
      el.dataset.state = st;
      title.textContent = t;
      status.textContent = s;
      pct.textContent = active ? `${Math.floor(pctv)}%` : '';
      fill.style.width = `${(active ? pctv : jobs.length ? 100 : 0).toFixed(1)}%`;
      bar.setAttribute('aria-valuenow', String(Math.round(active ? pctv : jobs.length ? 100 : 0)));
      bar.hidden = !active && !preparing;
      closeBtn.hidden = active > 0 || preparing > 0;
      const iconId = st === 'done' ? 'check' : st === 'failed' || st === 'interrupted' || st === 'warn' ? 'warning' : 'upload';
      if (shownIcon !== iconId) {
        shownIcon = iconId;
        headIcon.replaceChildren(icon(iconId));
      }
      if (win.start > 0) {
        moreTop.textContent = [plural(win.start, 'earlier file'), above.done ? `${num(above.done)} added` : null,
          above.failed ? `${num(above.failed)} not added` : null].filter(Boolean).join(' · ');
      }
      if (win.end < jobs.length) {
        const rest = jobs.length - win.end;
        moreBottom.textContent = belowWaiting === rest ? `${plural(rest, 'more file')} waiting` : plural(rest, 'more file');
      }
      // Footer: rebuilt only when its buttons change (a rebuild per progress frame would steal keyboard focus).
      const retryable = failed + interrupted;
      let mode = 'none';
      if (active) mode = 'running';
      else if (retryable && !locked) mode = failed ? 'retry-failed' : 'retry';
      else if (retryable) mode = 'locked';
      else if (jobs.length) mode = 'done';
      if (active) footText.textContent = added ? `${num(added)} added so far` : '';
      else if (mode === 'retry') footText.textContent = 'Pick up where it stopped.';
      else if (mode === 'locked') footText.textContent = 'Unlock your vault to retry.';
      else footText.textContent = '';
      if (footMode !== mode) {
        const hadFocus = foot.contains(d.activeElement);
        footMode = mode;
        footBtns.replaceChildren();
        if (mode === 'running') {
          footBtns.append(h('button', { type: 'button', class: 'btn btn-sm btn-ghost up-cancel-all', text: 'Cancel all', on: { click: (e) => once(e) || cancelAll() } }));
        } else if (mode === 'retry' || mode === 'retry-failed') {
          footBtns.append(
            h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Clear', on: { click: (e) => once(e) || api.close() } }),
            h('button', { type: 'button', class: 'btn btn-sm btn-primary up-retry', on: { click: (e) => once(e) || retry(jobs.filter((j) => ['failed', 'interrupted'].includes(j.state))) } },
              icon('refresh'), h('span', { text: mode === 'retry-failed' ? 'Retry failed' : 'Retry' })));
        } else if (mode === 'done') {
          footBtns.append(h('button', { type: 'button', class: 'btn btn-sm', text: 'Done', on: { click: (e) => once(e) || api.close() } }));
        }
        if (hadFocus) (footBtns.querySelector('button') ?? toggle).focus({ preventScroll: true });
      }
      foot.hidden = !footText.textContent && !footBtns.childElementCount;
      const say = `${t}${s ? `: ${s}` : ''}`;
      if (st !== 'running' && say !== lastAnnounced) {
        lastAnnounced = say;
        live.textContent = say;
      }
      if (st === 'running') lastAnnounced = '';
    },
    /** The queue went idle: re-centre the window, maybe the after-batch hint, then auto-close when all went fine. */
    idle() {
      if (pumping || preparing || el.hidden) return;
      if (jobs.length > MAX_ROWS) syncList();
      api.paintHead();
      maybeHint().then(() => {
        clearTimeout(closeTimer);
        const clean = jobs.length > 0 && jobs.every((j) => (j.state === 'done' && !j.warn) || j.state === 'cancelled');
        if (!clean || !hint.hidden || hovered || el.contains(d.activeElement)) return;
        closeTimer = setTimeout(() => {
          if (!pumping && !preparing && !hovered && hint.hidden && !el.contains(d.activeElement)) api.close();
        }, AUTO_CLOSE_MS);
      });
    },
    hideHint() {
      hint.hidden = true;
    },
    close() {
      if (jobs.some((j) => j.state === 'waiting' || j.state === 'running')) return;
      clearTimeout(closeTimer);
      ro?.disconnect();
      mo?.disconnect();
      win0?.removeEventListener?.('resize', liftSoon);
      offPlayer();
      const hadFocus = el.contains(d.activeElement);
      el.remove();
      for (const j of jobs) {
        j.gone = true;
        j.row = null;
      }
      jobs = [];
      for (const b of batches) {
        dropEmptyAlbum(b);
        b.resolve();
      }
      batches = [];
      if (dock === api) dock = null;
      if (hadFocus) {
        // Give focus back to where it came from (else the page), not to <body>.
        const back = returnFocus?.isConnected && !returnFocus.closest('[inert], [hidden]') ? returnFocus : d.getElementById('main');
        back?.focus?.({ preventScroll: true });
      }
    },
  };

  async function maybeHint() {
    if (hintShown || !hint.hidden) return;
    const added = jobs.filter((j) => j.state === 'done');
    if (!added.length) return;
    const v = added[0].vault;
    if (!v || v.status !== 'unlocked') return;
    // Not while the data could vanish and there is no backup: deleting the originals would be risky then.
    let persisted = null;
    try {
      persisted = await platform.storage.persisted();
    } catch {
      persisted = null;
    }
    const unprotected = !platform.isTauri && !isStandalone() && persisted !== true;
    if (unprotected && !v.lastBackupAt) return;
    if (hintShown || !el.isConnected || pumping) return;
    hintShown = true;
    hint.hidden = false;
    import('./settings-view.js').then((m) => {
      settingsMod = m;
    }, () => {});
    announce(HINT);
  }

  setCollapsed(false);
  return api;
}
