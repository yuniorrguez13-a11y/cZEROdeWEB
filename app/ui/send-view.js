// Send · Open screen (routes 'send', 'open', 'incoming'; DESIGN §1.7, §3.6, §5.1, §12). Owner: V2a.
// Two big cards: "Lock files to send" (picked/dropped files, or vault items handed over through state
// 'send.pending', locked into one passphrase .czd per batch — a bundle for ≥ 2 files unless "One .czd per file")
// and "Open a .czd" (czd2 with a passphrase, a cZEROde 1 desktop .czd with its PIN; a .czb goes to Restore). A
// locked vault can be unlocked right in the Open card to keep the files (leaving this screen would close the file);
// a .czd dropped on the Lock card is offered to the Open card instead of being locked again.
// '#/open' focuses the Open card; '#/incoming' (share target, file handlers, Tauri associations, files sniffed in
// the vault via state 'incoming.files') lists what arrived with the fitting actions.
// Activation rule (§1.7): every picker / save / share call is the FIRST await of its click handler.
// Locking clears everything here (passphrases, decrypted previews, open files: every Opened is released).
// Node-importable: the DOM is only touched inside functions.

import { APP_URL, CAPS } from '../config.js';
import { CzdError, isCancel, toCzdError, userMessage } from '../errors.js';
import * as state from '../state.js';
import * as settings from '../settings.js';
import * as platform from '../platform.js';
import * as router from '../router.js';
import { takeSharedFiles } from '../pwa.js';
import * as container from '../crypto/container.js';
import { FLOOR, POLICY } from '../crypto/kdf.js';
import { generatePassphrase, strength } from '../crypto/passphrase.js';
import { isCzb } from '../vault/backup.js';
import { isOldCzd, openOldCzd } from '../legacy/oldczd.js';
import { blobSource, fileChunks, withProgress } from '../util/stream.js';
import { announce, confirmDialog, h, icon, modal, sheet, toast } from '../util/dom.js';
import { dedupeName, extOf, fmtDate, fmtSize, kindOf, mimeFromExt, randomExportName, safeFilename, viewerMode } from '../util/format.js';
import { banner, copyButton, dropZone, kindIcon, passphraseField, progressRow } from './components.js';
import { openViewer } from './viewer.js';
import { decryptToBlob, prepareShare, saveDecrypted } from '../media/media.js';

const MiB = 2 ** 20;
const WORDS = 6;
/** Image entries up to this size get a decrypted row thumbnail (on demand, while visible). */
const THUMB_MAX = 16 * MiB;
const THUMB_PARALLEL = 3;
/** Media added to the vault through a Blob (so the vault can make a thumbnail/poster) up to this size. */
const MEDIA_BLOB_MAX = CAPS.image;
/** cZEROde 1 desktop .czd files are JSON text read whole. */
const LEGACY_MAX = 256 * MiB;
const LIST_MAX = 60;
const MIME_RE = /^[a-z0-9.+-]{1,60}\/[a-z0-9.+-]{1,60}$/i;
const RANDOM_NAME = /^cz-[a-z2-7]{8}$/;
const KIND_LABEL = { image: 'Photo', video: 'Video', audio: 'Music', doc: 'Document', note: 'Note', other: 'File' };

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shortName = (name, max = 42) => {
  const s = safeFilename(name);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const receiverMessage = () => `I sent you a locked file 🔒 Open it at ${APP_URL}#/open — I'll send the passphrase separately.`;
const canShareText = () => typeof globalThis.navigator?.share === 'function';
const canShareFiles = () => platform.caps.mobile() && typeof globalThis.navigator?.share === 'function';

/** The declared type when it is a plausible MIME type, else the one implied by the extension. */
function fileType(type, name) {
  const t = String(type ?? '').split(';')[0].trim().toLowerCase();
  return MIME_RE.test(t) ? t : mimeFromExt(extOf(name));
}

function errorText(e) {
  const err = toCzdError(e);
  if ((err.code === 'too-big-to-preview' && err.detail === 'too-big-to-save') || (err.code === 'quota-exceeded' && err.detail === 'staging limit')) {
    return 'Too big to save in this browser — use the desktop app or Chrome.';
  }
  if (err.code === 'picker-needs-gesture') return 'Tap the button again to continue.';
  // Only a bundle's list of names can outgrow the metadata limit (§3.3: ≤ 1 MiB).
  if (err.code === 'bad-meta' && err.detail === 'too long') return 'Too many file names for one .czd — turn on “One .czd per file” or pick fewer files.';
  return userMessage(err);
}

/** Format errors of a .czd that is not openable get the plain "damaged" / "newer app" copy, not "Something went wrong". */
const DAMAGED_CODES = new Set(['bad-meta', 'bad-stanza', 'bad-stanza-count', 'too-many-stanzas', 'bad-chunk-size', 'source-size-mismatch', 'source-larger-than-size']);

function openErrorText(code, e) {
  if (code === 'legacy-not-ciphertext' || code === 'legacy-bad-record') return "This old cZEROde file is damaged and can't be opened.";
  if (DAMAGED_CODES.has(code)) return userMessage('truncated');
  if (code === 'unsupported-kdf') return userMessage('unsupported-version');
  if (code === 'no-usable-stanza') return "This .czd isn't locked with a passphrase — only the vault that made it can open it.";
  return userMessage(e);
}

function report(e) {
  if (isCancel(e)) return;
  if (toCzdError(e).code === 'internal') globalThis.console?.error?.('[send]', e);
  toast(errorText(e), { kind: 'err' });
}

/** Runs fn as a job (state 'busy': autolock counts it as activity, updates wait). */
async function asJob(fn) {
  state.busy(1);
  try {
    return await fn();
  } finally {
    state.busy(-1);
  }
}

const confirmKdf = (p) => confirmDialog({
  title: 'Heavy file',
  message: `This file needs ~${p.mib} MiB and ~${p.seconds} s to unlock. Continue?`,
  confirmLabel: 'Continue',
});

const confirmVaultKdf = (p) => confirmDialog({
  title: 'Heavy unlock',
  message: `This vault needs ~${p.mib} MiB of memory to unlock. Continue?`,
  confirmLabel: 'Continue',
});

const lowMemory = () => confirmDialog({
  title: 'Low memory',
  message: 'Low memory: use lighter protection? The .czd still needs the passphrase, but guessing it gets cheaper.',
  confirmLabel: 'Use lighter protection',
});

// ───────── delivering files (object URLs revoked after a minute and on lock)

const liveUrls = new Set();
state.onPurge(() => {
  for (const u of liveUrls) globalThis.URL?.revokeObjectURL?.(u);
  liveUrls.clear();
});

/** Saves a File through <a download> (its own click, or right after one). */
function downloadFile(file) {
  const url = URL.createObjectURL(file);
  liveUrls.add(url);
  const a = h('a', { href: url, download: safeFilename(file.name), class: 'visually-hidden', tabIndex: -1 });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => {
    if (liveUrls.delete(url)) URL.revokeObjectURL(url);
  }, 60_000);
}

/** Decrypted copies on a 'stage' target: saved right away while the click's activation lasts, else one Save click each. */
function deliverStaged(files) {
  const list = files.filter(Boolean);
  if (!list.length) return;
  const active = globalThis.navigator?.userActivation?.isActive;
  if (list.length === 1 && active !== false) {
    downloadFile(list[0]);
    toast(`Saved “${shortName(list[0].name, 30)}” to your downloads`, { kind: 'ok' });
    return;
  }
  const rows = list.map((f) => {
    const label = h('span', { text: 'Save' });
    const btn = h('button', { type: 'button', class: 'btn btn-sm btn-primary' }, icon('download'), label);
    btn.addEventListener('click', () => {
      downloadFile(f);
      btn.disabled = true;
      label.textContent = 'Saved';
    });
    return h('li', { class: 'sd-ready-row' }, h('span', { class: 'sd-ready-name', text: safeFilename(f.name) }), h('span', { class: 'sd-ready-size', text: fmtSize(f.size) }), btn);
  });
  const p = modal({
    title: list.length === 1 ? 'Ready to save' : `${list.length} files ready`,
    className: 'sd-ready',
    body: h('div', { class: 'stack' }, h('p', { text: list.length === 1 ? 'Your decrypted copy is ready to save.' : 'Your decrypted copies are ready. Save each one.' }), h('ul', { class: 'sd-ready-list' }, rows)),
    actions: [{ label: 'Done', kind: 'ghost', value: null }],
  });
  p.then(() => list.splice(0));
}

/** Two-step share (§5.1): the File is ready; the Share button's own click opens the share sheet. */
function offerShare(file) {
  let p = null;
  const btn = h('button', { type: 'button', class: 'btn btn-primary btn-block sd-share-go' }, icon('share'), h('span', { text: 'Share' }));
  btn.addEventListener('click', async () => {
    try {
      const ok = await platform.shareFiles([file]);
      if (ok) p?.close(true);
    } catch (e) {
      report(e);
    }
  });
  p = modal({
    title: 'Ready to share',
    className: 'sd-ready',
    body: h('div', { class: 'stack' },
      h('p', { class: 'sd-ready-file' }, kindIcon(kindOf(file.type, file.name)), h('span', { class: 'sd-ready-name', text: safeFilename(file.name) }), h('span', { class: 'sd-ready-size', text: fmtSize(file.size) })),
      h('p', { text: 'This shares a decrypted copy. Whoever receives it can read it.' }),
      btn),
    actions: [{ label: 'Cancel', kind: 'ghost', value: null }],
  });
  return p;
}

// ───────── sniffing and hand-offs to other views

let uploadMod = null;

/** 'czd2' | 'czb' | 'oldczd' | null — upload.js's sniffer when it is available, else the same checks here. */
async function sniff(file) {
  try {
    uploadMod ??= await import('./upload.js');
    if (typeof uploadMod.sniffFile === 'function') return await uploadMod.sniffFile(file);
  } catch {
    // the vault upload module is optional for this view
  }
  try {
    if (typeof Blob === 'undefined' || !(file instanceof Blob) || file.size < 8) return null;
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    const first8 = head.subarray(0, 8);
    if (container.isCzd2(first8)) return 'czd2';
    if (isCzb(first8)) return 'czb';
    if (isOldCzd(head)) return 'oldczd';
  } catch {
    // unreadable: treated as an ordinary file
  }
  return null;
}

const SNIFF_PARALLEL = 8;
/** A file the browser typed as media/text/PDF… is not a .czd (those come as '' or application/octet-stream). */
const maybeLocked = (f) => f.size >= 8 && (!f.type || f.type === 'application/octet-stream' || /czd|json/i.test(f.type));

/** sniff() for a list (a few files at a time) → kinds in the same order. */
async function sniffAll(files) {
  const out = new Array(files.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      out[i] = await sniff(files[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SNIFF_PARALLEL, files.length) }, worker));
  return out;
}

/** The Restore/Merge flow of the settings view (DESIGN §12), or a pointer to it while it isn't available. */
async function openRestore(file) {
  let mod = null;
  try {
    mod = await import('./settings-view.js');
  } catch (e) {
    globalThis.console?.warn?.('[send] settings view unavailable', e);
  }
  if (typeof mod?.openRestoreDialog === 'function') {
    try {
      await mod.openRestoreDialog(file);
    } catch (e) {
      report(e);
    }
    return;
  }
  const go = await modal({
    title: 'cZEROde backup',
    body: 'This is a cZEROde backup (.czb). Backups are restored, not opened — use Settings → Vault → Restore backup.',
    actions: [{ label: 'Not now', kind: 'ghost', value: false }, { label: 'Open Settings', kind: 'primary', value: true, autofocus: true }],
  });
  if (go === true) router.navigate('#/settings');
}

/** Imports plain files into the unlocked vault through the upload queue (upload.js), else one by one. */
async function importToVault(vault, files) {
  try {
    uploadMod ??= await import('./upload.js');
    if (typeof uploadMod.importFiles === 'function') {
      await uploadMod.importFiles({ vault, files });
      return;
    }
  } catch (e) {
    if (isCancel(e)) return;
    globalThis.console?.warn?.('[send] upload queue unavailable', e);
  }
  await asJob(async () => {
    for (const f of files) await vault.addFile(f);
  });
  toast(`Added ${plural(files.length, 'file')} to your vault`, { kind: 'ok' });
}

// ───────── small building blocks

/**
 * Runs render() (which rebuilds `container`'s content) and keeps keyboard focus: the element with the same
 * data-fk key gets it back, else the view's [data-fk-fallback]. Only when focus was inside before.
 */
function keepFocus(container, render) {
  const d = globalThis.document;
  const before = d?.activeElement;
  const had = Boolean(before && before !== d.body && container.contains(before));
  const key = had ? before.closest('[data-fk]')?.dataset.fk : null;
  render();
  if (!had) return;
  const now = d.activeElement;
  if (now && now !== d.body && container.contains(now)) return;
  let t = (key && container.querySelector(`[data-fk="${key}"]`)) || container.querySelector('[data-fk-fallback]');
  if (t && !t.matches('input, button, a, textarea, select, [tabindex]')) t = t.querySelector('input, button');
  t?.focus({ preventScroll: true });
}

function cardHead(iconId, title, sub, id) {
  return h('header', { class: 'sd-card-head' },
    h('span', { class: 'sd-card-icon', aria: { hidden: 'true' } }, icon(iconId)),
    h('div', { class: 'sd-card-titles' },
      h('h2', { class: 'sd-card-title', id, text: title }),
      h('p', { class: 'sd-card-sub', text: sub })));
}

function secHead(label, ...extra) {
  return h('div', { class: 'sd-sec-head' }, h('h3', { class: 'sd-label', text: label }), ...extra);
}

function indeterminate(label) {
  return h('div', { class: 'sd-working', role: 'status' },
    h('div', { class: 'progress sd-indet' }, h('div', { class: 'progress-fill' })),
    h('span', { class: 'sd-working-text', text: label }));
}

/** The 6 words of a generated passphrase, hyphens dimmed (copying the text gives the exact passphrase). */
function phraseView(phrase) {
  const parts = [];
  String(phrase).split('-').forEach((w, i) => {
    if (i) parts.push(h('span', { class: 'sd-phrase-sep', text: '-' }));
    parts.push(h('span', { class: 'sd-phrase-word', text: w }));
  });
  return h('p', { class: 'sd-phrase-text', attrs: { translate: 'no' } }, parts);
}

function checkOption(label, key, hint, onChange) {
  const input = h('input', { type: 'checkbox', checked: settings.get(key) === true });
  input.addEventListener('change', () => {
    try {
      settings.set(key, input.checked);
    } catch (e) {
      globalThis.console?.warn?.(e);
    }
    onChange?.();
  });
  return h('label', { class: 'check sd-opt', dataset: { opt: key, fk: `opt-${key}` } }, input,
    h('span', { class: 'sd-opt-text' }, h('span', { class: 'sd-opt-label', text: label }), hint ? h('span', { class: 'sd-opt-hint', text: hint }) : null));
}

// ───────── Lock card

function lockPanel({ getVault, toOpen }) {
  let files = [];
  let itemIds = [];
  let phrase = '';
  let useOwn = false;
  let job = null; // {ctl, target, row, phase}
  let result = null; // {outputs, pass, targetKind}
  let noteSaved = false;
  let noteSaving = false;
  let choosing = false; // the save picker of "Lock & save" is open
  let checking = 0; // large batches being sniffed
  let purgeGen = 0; // bumped by every lock: work started before it is dropped
  const own = passphraseField({ label: 'Type your own', mode: 'new', purpose: 'send', autocomplete: 'off', onChange: () => paintOwnHint(), onSubmit: () => lockAndSave() });
  own.el.dataset.fk = 'own';
  const ownHint = h('p', { class: 'hint hint-warn sd-weak', hidden: true }, icon('warning'),
    h('span', { text: 'Under 40 bits — someone who gets the .czd could guess this. Add words, or use a generated one.' }));
  const body = h('div', { class: 'sd-card-body' });
  const el = h('section', { class: 'card sd-card sd-card-lock', aria: { labelledby: 'sd-lock-title' } },
    cardHead('lock', 'Lock files to send', 'Turn files into one passphrase-protected .czd for WhatsApp, Discord, email or USB.', 'sd-lock-title'),
    body);
  const offDrop = dropZone(el, { multiple: true, onFiles: (list) => addFiles(list) });

  const vaultOf = () => {
    const v = getVault();
    return v && v.status === 'unlocked' ? v : null;
  };
  const fromVault = () => itemIds.length > 0;
  const count = () => (fromVault() ? itemIds.length : files.length);
  const onePerFile = () => settings.get('sendOnePerFile') === true;
  const bundled = () => count() > 1 && !onePerFile();
  const outputsCount = () => (bundled() ? 1 : count());

  function freshPhrase() {
    try {
      phrase = generatePassphrase(WORDS);
    } catch {
      phrase = '';
      useOwn = true;
    }
  }
  freshPhrase();

  function vaultItems() {
    const v = vaultOf();
    if (!v) return [];
    const out = [];
    for (const id of itemIds) {
      try {
        out.push(v.item(id));
      } catch {
        // deleted meanwhile
      }
    }
    return out;
  }

  /**
   * Adds picked/dropped files. Files that are already locked (.czd) are not locked again: they are offered to the
   * Open card instead (a received .czd dropped on the wrong card).
   */
  async function addFiles(list, { sniffed = false } = {}) {
    let add = [...(list ?? [])].filter((f) => typeof Blob !== 'undefined' && f instanceof Blob);
    if (!add.length) return false;
    if (job) {
      toast('Wait until these files are locked.', { kind: 'warn' });
      return false;
    }
    if (!sniffed) {
      const gen = purgeGen;
      // Only files without a known type can be a .czd (photos, videos, PDFs… are not read here).
      const unknown = add.filter(maybeLocked);
      const big = unknown.length > 200;
      if (big) {
        checking++;
        render();
      }
      let found;
      try {
        found = await sniffAll(unknown);
      } finally {
        if (big) checking--;
      }
      if (gen !== purgeGen) {
        if (big) render(); // locked meanwhile: the card is empty again
        return false;
      }
      const kindOfFile = new Map(unknown.map((f, i) => [f, found[i]]));
      const kinds = add.map((f) => kindOfFile.get(f) ?? null);
      const locked = add.map((f, i) => ({ file: f, kind: kinds[i] })).filter((x) => x.kind === 'czd2' || x.kind === 'oldczd');
      if (locked.length) {
        add = add.filter((f, i) => kinds[i] !== 'czd2' && kinds[i] !== 'oldczd');
        offerOpen(locked);
      }
      if (!add.length) {
        if (big) render();
        return true;
      }
      if (job) {
        toast('Wait until these files are locked.', { kind: 'warn' });
        return false;
      }
    }
    if (result) clearResult();
    if (fromVault()) {
      itemIds = [];
      toast('Switched to files from this device.', { kind: 'info' });
    }
    const have = new Set(files.map((f) => `${f.name}|${f.size}|${f.lastModified}`));
    for (const f of add) {
      const k = `${f.name}|${f.size}|${f.lastModified}`;
      if (!have.has(k)) {
        have.add(k);
        files.push(f);
      }
    }
    render();
    return true;
  }

  function offerOpen(locked) {
    const one = locked.length === 1;
    toast(one ? `“${shortName(locked[0].file.name, 26)}” is already locked.` : `${locked.length} files are already locked.`, {
      kind: 'info',
      timeout: 10_000,
      action: { label: 'Open', onClick: () => toOpen?.(locked) },
    });
  }

  function setVaultItems(ids) {
    if (job) {
      toast('Wait until these files are locked.', { kind: 'warn' });
      return;
    }
    if (!vaultOf()) {
      toast(userMessage('vault-locked'), { kind: 'warn' });
      return;
    }
    if (result) clearResult();
    files = [];
    itemIds = [...new Set(ids)];
    if (!vaultItems().length) itemIds = [];
    render();
    el.scrollIntoView?.({ block: 'nearest' });
  }

  function clearResult() {
    result = null;
    noteSaved = false;
    noteSaving = false;
    freshPhrase();
  }

  /** Back to the empty card (also on lock): files, items, passphrases and results are dropped. */
  function reset() {
    if (job) {
      job.cancelled = true;
      job.ctl.abort(new CzdError('aborted'));
      job.target?.abort().catch(() => {});
      job = null;
    }
    files = [];
    itemIds = [];
    result = null;
    noteSaved = false;
    noteSaving = false;
    useOwn = false;
    own.clear();
    freshPhrase();
    render();
  }

  function pick() {
    platform.pickFiles({ multiple: true }).then(addFiles, report);
  }

  function paintOwnHint() {
    const v = own.value;
    let weak = false;
    if (v) {
      try {
        weak = strength(v).bits < 40;
      } catch {
        weak = v.length < 8;
      }
    }
    ownHint.hidden = !weak;
  }

  function currentPass() {
    return useOwn ? own.value : phrase;
  }

  // ── views

  function emptyView() {
    return h('div', { class: 'sd-empty' },
      h('div', { class: 'dropzone sd-drop' },
        icon('upload'),
        h('p', { class: 'dropzone-title', text: 'Drop files here' }),
        h('p', { class: 'dropzone-sub', text: 'Photos, videos, documents — anything.' }),
        h('button', { type: 'button', class: 'btn btn-primary sd-pick', dataset: { fk: 'pick', fkFallback: '' }, on: { click: pick } }, icon('plus'), h('span', { text: 'Choose files' }))),
      h('p', { class: 'sd-fine' }, icon('info'), h('span', { text: 'Nothing leaves this device. You send the .czd yourself.' })));
  }

  function fileRows() {
    if (fromVault()) {
      return vaultItems().map((it) => ({ key: it.id, name: it.kind === 'note' ? `${it.name}.txt` : it.name, size: it.size, kind: it.kind }));
    }
    return files.map((f, i) => ({ key: String(i), name: f.name, size: f.size, kind: kindOf(fileType(f.type, f.name), f.name), file: f }));
  }

  function remove(row) {
    if (fromVault()) itemIds = itemIds.filter((id) => id !== row.key);
    else files = files.filter((f) => f !== row.file);
    render();
  }

  function readyView() {
    const rows = fileRows();
    const total = rows.reduce((n, r) => n + (Number(r.size) || 0), 0);
    const list = h('ul', { class: 'sd-files' }, rows.slice(0, LIST_MAX).map((r) => h('li', { class: 'sd-file' },
      kindIcon(r.kind),
      h('span', { class: 'sd-file-name', text: safeFilename(r.name), title: safeFilename(r.name) }),
      h('span', { class: 'sd-file-size', text: fmtSize(r.size) }),
      h('button', { type: 'button', class: 'btn-icon sd-file-x', dataset: { fk: 'rm' }, aria: { label: `Remove ${safeFilename(r.name)}` }, title: 'Remove', on: { click: () => remove(r) } }, icon('close')))));
    const more = rows.length > LIST_MAX ? h('p', { class: 'sd-more', text: `and ${rows.length - LIST_MAX} more` }) : null;
    const addBtn = fromVault() ? null : h('button', { type: 'button', class: 'btn btn-sm btn-ghost sd-add', dataset: { fk: 'add' }, on: { click: pick } }, icon('plus'), h('span', { text: 'Add' }));
    const filesSec = h('div', { class: 'sd-sec' },
      secHead(fromVault() ? `From your vault · ${rows.length}` : `Files · ${rows.length}`, h('span', { class: 'sd-total', text: fmtSize(total) }), addBtn),
      list, more);

    const n = rows.length;
    const outs = outputsCount();
    const summary = h('p', { class: 'sd-summary' }, icon('lock'),
      h('span', { text: n > 1 && outs === 1 ? `${plural(n, 'file')} → one .czd bundle` : `${plural(n, 'file')} → ${plural(outs, '.czd file')}` }));
    const go = h('button', { type: 'button', class: 'btn btn-primary btn-block sd-go', dataset: { fk: 'go', fkFallback: '' }, disabled: n === 0, on: { click: () => lockAndSave() } },
      icon('lock'), h('span', { text: 'Lock & save' }));
    return h('div', { class: 'sd-ready-view' }, filesSec, passSection(), optionsSection(), h('div', { class: 'sd-go-wrap' }, summary, go));
  }

  function passSection() {
    const toggle = h('button', {
      type: 'button',
      class: 'btn-link sd-switch',
      dataset: { fk: 'switch' },
      text: useOwn ? 'Use a generated one' : 'Use my own',
      on: {
        click: () => {
          useOwn = !useOwn;
          if (!useOwn && !phrase) freshPhrase();
          render();
          if (useOwn) own.focus();
        },
      },
    });
    const sec = h('div', { class: 'sd-sec sd-pass' }, secHead('Passphrase', toggle));
    if (useOwn) {
      own.setMode('new');
      sec.append(own.el, ownHint);
      paintOwnHint();
    } else {
      sec.append(
        h('div', { class: 'sd-phrase' }, phraseView(phrase)),
        h('div', { class: 'sd-phrase-tools' },
          copyButton(() => phrase, { secret: true }),
          h('button', { type: 'button', class: 'btn btn-sm sd-regen', dataset: { fk: 'regen' }, on: { click: () => {
            freshPhrase();
            render();
          } } }, icon('refresh'), h('span', { text: 'Regenerate' })),
          h('span', { class: 'sd-strong' }, icon('check'), h('span', { text: `${WORDS} random words · strong` }))));
    }
    return sec;
  }

  function optionsSection() {
    const opts = [];
    const n = count();
    if (n > 1) opts.push(checkOption('One .czd per file', 'sendOnePerFile', `Off: all ${n} files go into one .czd.`, render));
    opts.push(checkOption('Hide the file name in the .czd’s name', 'sendHideName', 'Saved as cz-xxxxxxxx.czd — the real name stays inside, encrypted.'));
    opts.push(checkOption('Keep file dates', 'sendKeepDates', 'Off: the receiver doesn’t see when the files were last changed.'));
    return h('div', { class: 'sd-sec sd-opts' }, secHead('Options'), ...opts);
  }

  function jobView() {
    // The phase line holds keyboard focus while the job runs (the Lock & save button is gone; Cancel must not
    // take it: a second Enter would cancel).
    return h('div', { class: 'sd-job', role: 'status' },
      h('p', { class: 'sd-phase', tabIndex: -1, dataset: { fkFallback: '' } }, h('span', { class: 'sd-spin', aria: { hidden: 'true' } }), h('span', { text: job.phase })),
      job.kdf ? indeterminate('Argon2id · 64 MiB') : null,
      job.row.el,
      h('p', { class: 'sd-fine' }, icon('info'), h('span', { text: 'Keep this tab open until it finishes.' })));
  }

  function outputRow(o) {
    const actions = [];
    if (o.file) {
      actions.push(h('button', { type: 'button', class: 'btn btn-sm btn-primary sd-save', on: { click: () => downloadFile(o.file) } }, icon('download'), h('span', { text: 'Save' })));
      if (platform.caps.share([o.file])) {
        actions.push(h('button', {
          type: 'button',
          class: 'btn btn-sm sd-share',
          on: {
            click: async () => {
              try {
                await platform.shareFiles([o.file]);
              } catch (e) {
                report(e);
              }
            },
          },
        }, icon('share'), h('span', { text: 'Share' })));
      }
    } else {
      actions.push(h('span', { class: 'badge badge-ok' }, icon('check'), h('span', { text: 'Saved' })));
    }
    return h('li', { class: 'sd-output' },
      h('span', { class: 'sd-output-icon', aria: { hidden: 'true' } }, icon('lock')),
      h('span', { class: 'sd-output-info' },
        h('span', { class: 'sd-output-name', text: safeFilename(o.name), title: safeFilename(o.name) }),
        h('span', { class: 'sd-output-meta', text: [Number.isFinite(o.size) ? fmtSize(o.size) : null, o.dir && o.where ? `in ${safeFilename(String(o.where).split(/[\\/]/).filter(Boolean).pop() ?? '')}` : null].filter(Boolean).join(' · ') })),
      h('span', { class: 'sd-output-actions' }, actions));
  }

  function resultView() {
    const r = result;
    const staged = r.outputs.some((o) => o.file);
    const n = r.outputs.length;
    const v = vaultOf();
    const noteBtn = v ? h('button', {
      type: 'button',
      class: 'btn btn-sm sd-note',
      disabled: noteSaved || noteSaving,
      on: { click: () => savePassNote() },
      dataset: { fk: 'note' },
    }, icon(noteSaved ? 'check' : 'note'), h('span', { text: noteSaved ? 'Saved to your vault' : noteSaving ? 'Saving…' : 'Save passphrase to my vault as a note' })) : null;
    const sharePass = canShareText() ? h('button', {
      type: 'button',
      class: 'btn btn-sm sd-share-pass',
      on: {
        click: async () => {
          try {
            await platform.shareText(r.pass);
          } catch (e) {
            report(e);
          }
        },
      },
    }, icon('share'), h('span', { text: 'Share passphrase' })) : null;
    return h('div', { class: 'sd-result' },
      h('div', { class: 'sd-result-head' },
        h('span', { class: 'sd-ok', aria: { hidden: 'true' } }, icon('check')),
        h('div', null,
          h('h3', { class: 'sd-result-title', tabIndex: -1, dataset: { fkFallback: '' }, text: n === 1 ? 'Locked. Ready to send.' : `Locked into ${n} files. Ready to send.` }),
          h('p', { class: 'sd-result-sub', text: staged ? (n === 1 ? 'Save it, then send it any way you like.' : 'Save each one, then send them any way you like.') : 'Saved. Send it any way you like.' }))),
      h('ul', { class: 'sd-outputs' }, r.outputs.map(outputRow)),
      h('div', { class: 'sd-sec sd-pass' },
        secHead('Passphrase'),
        h('div', { class: 'sd-phrase' }, r.generated ? phraseView(r.pass) : h('p', { class: 'sd-phrase-text', text: r.pass })),
        h('div', { class: 'sd-phrase-tools' }, copyButton(() => r.pass, { secret: true }), sharePass, noteBtn)),
      h('div', { class: 'sd-sec sd-msg' },
        secHead('Message for the receiver'),
        h('blockquote', { class: 'sd-quote', text: receiverMessage() }),
        h('div', { class: 'sd-phrase-tools' }, copyButton(() => receiverMessage(), { label: 'Copy message for the receiver' }))),
      banner({ kind: 'info', text: 'Send the passphrase through a different app than the file.' }),
      h('button', { type: 'button', class: 'btn btn-ghost sd-again', on: { click: () => reset() } }, icon('plus'), h('span', { text: 'Lock more files' })));
  }

  async function savePassNote() {
    const v = vaultOf();
    if (!v || !result || noteSaving || noteSaved) return;
    const r = result;
    noteSaving = true;
    render();
    const names = r.outputs.map((o) => safeFilename(o.name));
    try {
      await v.addNote({
        title: `Passphrase · ${shortName(names[0], 60)}`,
        body: `Passphrase: ${r.pass}\n\nFor: ${names.join(', ')}\nLocked: ${new Date().toLocaleString()}`,
      });
      if (result !== r) return; // reset or locked meanwhile
      noteSaving = false;
      noteSaved = true;
      toast('Passphrase saved to your vault as a note', { kind: 'ok' });
      render();
    } catch (e) {
      if (result !== r) return;
      noteSaving = false;
      render();
      report(e);
    }
  }

  function render() {
    let view;
    if (job) view = jobView();
    else if (result) view = resultView();
    else if (!count() && checking) view = indeterminate('Checking the files…');
    else if (!count()) view = emptyView();
    else view = readyView();
    keepFocus(body, () => body.replaceChildren(view));
    el.dataset.phase = job ? 'working' : result ? 'result' : count() ? 'ready' : 'empty';
  }

  // ── locking

  /** Output names for the batch (decided before the save picker: its suggestion and the folder/stage names). */
  function plannedNames(hide) {
    const n = count();
    if (bundled()) return [hide ? randomExportName() : `${plural(n, 'file')}.czd`];
    if (hide) return Array.from({ length: n }, () => randomExportName());
    return fileRows().map((r) => safeFilename(`${safeFilename(r.name)}.czd`));
  }

  async function lockAndSave() {
    if (job || choosing) return;
    const n = count();
    if (!n) return;
    const pass = currentPass();
    if (!pass || !pass.trim()) {
      if (useOwn) own.setError('Type a passphrase first.');
      return;
    }
    if (fromVault() && !vaultOf()) {
      toast(userMessage('vault-locked'), { kind: 'warn' });
      return;
    }
    const bundle = bundled();
    if (bundle && n > CAPS.bundleEntries) {
      toast(`Up to ${CAPS.bundleEntries} files fit in one .czd — turn on “One .czd per file” or pick fewer files.`, { kind: 'warn' });
      return;
    }
    const hide = settings.get('sendHideName') === true;
    const keepDates = settings.get('sendKeepDates') === true;
    const names = plannedNames(hide);
    const generated = !useOwn;
    const gen = purgeGen;
    // FIRST await of the click: the save picker (§1.7). Cancel ends the flow before Argon2. A second click while
    // the picker is open (double click) is ignored: it would open a second picker, or stage the outputs instead.
    choosing = true;
    let target;
    try {
      target = await platform.chooseSaveTarget({ name: names[0], count: names.length });
    } catch (e) {
      report(e);
      return;
    } finally {
      choosing = false;
    }
    if (!target) return;
    if (job || gen !== purgeGen || !count()) {
      target.abort().catch(() => {});
      return;
    }
    const total = fromVault() ? vaultItems().reduce((s, it) => s + it.size, 0) : files.reduce((s, f) => s + f.size, 0);
    const ctl = new AbortController();
    const row = progressRow({ name: bundle || n === 1 ? names[0] : `${plural(n, 'file')} → ${plural(names.length, '.czd file')}`, total });
    const my = { ctl, target, row, phase: 'Making the key…', kdf: true, cancelled: false };
    row.onCancel(() => ctl.abort(new CzdError('aborted')));
    job = my;
    render();
    const progress = (done) => {
      if (job === my) row.update(done);
    };
    try {
      const outputs = await asJob(async () => {
        let passKek;
        try {
          passKek = await container.makePassKek(pass, POLICY, { signal: ctl.signal });
        } catch (e) {
          if (toCzdError(e).code !== 'kdf-out-of-memory' || job !== my || !(await lowMemory())) throw e;
          passKek = await container.makePassKek(pass, FLOOR, { signal: ctl.signal });
        }
        if (job !== my) throw new CzdError('aborted');
        my.phase = n === 1 ? 'Encrypting…' : `Encrypting ${plural(n, 'file')}…`;
        my.kdf = false;
        render();
        const isDir = target.kind === 'fs-dir' || target.kind === 'tauri-dir';
        const taken = new Set();
        const outName = (i, real) => dedupeName(hide ? names[i] ?? randomExportName() : safeFilename(`${real}.czd`), taken);
        const out = [];
        if (fromVault()) {
          const list = await vaultOf()?.exportCzd(itemIds, passKek, { bundle, keepDates, signal: ctl.signal, onProgress: progress });
          if (!list || job !== my) throw new CzdError('aborted');
          for (const [i, o] of list.entries()) {
            const r = await target.write(outName(i, o.name), o.stream, { size: o.size, mime: 'application/octet-stream', signal: ctl.signal });
            out.push({ name: r.name, size: o.size, file: r.staged ?? null, where: r.where, dir: isDir });
          }
        } else {
          const groups = bundle ? [files.slice()] : files.map((f) => [f]);
          let done = 0;
          for (const [i, g] of groups.entries()) {
            const plan = plainBatch(g, keepDates);
            const base = done;
            const pt = withProgress(plan.source, (d) => progress(base + d), plan.size);
            const enc = container.encryptStream(pt, {
              size: plan.size,
              meta: plan.meta,
              signal: ctl.signal,
              stanzasFor: async (fk) => [await container.passStanza(fk, passKek)],
            });
            const counter = { bytes: 0 };
            const r = await target.write(outName(i, plan.meta.name), counted(enc, counter), { mime: 'application/octet-stream', signal: ctl.signal });
            done += plan.size;
            out.push({ name: r.name, size: r.staged?.size ?? counter.bytes, file: r.staged ?? null, where: r.where, dir: isDir });
          }
        }
        return out;
      });
      if (job !== my) return;
      job = null;
      result = { outputs, pass, generated, targetKind: target.kind };
      useOwn = false;
      own.clear();
      render();
      (el.querySelector('.sd-save') ?? el.querySelector('.sd-result-title'))?.focus({ preventScroll: true });
      el.scrollIntoView?.({ block: 'nearest' });
      announce(outputs.length === 1 ? 'Locked. Ready to send.' : `Locked into ${outputs.length} files.`);
    } catch (e) {
      await target.abort().catch(() => {});
      if (job !== my) return; // reset or lock: already cleaned up
      job = null;
      render();
      report(e);
    }
  }

  const offPurge = state.onPurge(() => {
    purgeGen++;
    noteSaving = false;
    reset();
  });
  render();

  return {
    el,
    addFiles,
    setVaultItems,
    refresh() {
      if (fromVault() && !vaultOf()) itemIds = [];
      render();
    },
    destroy() {
      offPurge();
      offDrop();
      if (job) {
        job.cancelled = true;
        job.ctl.abort(new CzdError('aborted'));
        job.target?.abort().catch(() => {});
        job = null;
      }
      own.clear();
      phrase = '';
      result = null;
    },
  };
}

/** Passes a byte stream through, counting its bytes into counter.bytes. */
async function* counted(source, counter) {
  for await (const piece of source) {
    counter.bytes += piece.byteLength;
    yield piece;
  }
}

/** Meta, size and plaintext stream for one output from picked files (one file, or a bundle of several). */
function plainBatch(list, keepDates) {
  const entry = (f) => {
    const name = safeFilename(f.name);
    const e = { name, type: fileType(f.type, name), size: f.size };
    if (keepDates && Number.isSafeInteger(f.lastModified) && f.lastModified > 0) e.mtime = f.lastModified;
    return e;
  };
  if (list.length === 1) {
    const meta = entry(list[0]);
    const size = meta.size;
    delete meta.size;
    return { meta, size, source: fileChunks(list[0]) };
  }
  const taken = new Set();
  const meta = container.bundleMeta(list.map((f) => {
    const e = entry(f);
    e.name = dedupeName(e.name, taken);
    return e;
  }));
  async function* concat() {
    for (const f of list) {
      let got = 0;
      for await (const c of fileChunks(f)) {
        got += c.length;
        yield c;
      }
      if (got !== f.size) throw new CzdError('source-size-mismatch');
    }
  }
  return { meta, size: meta.size, source: concat() };
}

// ───────── Open card

function openPanel({ getVault, toLock, onMany }) {
  let file = null;
  let kind = null;
  let phase = 'empty'; // empty | pass | bad | opened
  let src = null;
  let opened = null;
  let legacy = null; // {name, type, blob}
  let pf = null;
  let unlocking = false;
  let errorMsg = null;
  let seq = 0;
  let ctl = new AbortController();
  let activity = null; // {label, row}
  let viewer = null;
  let choosing = false; // a save picker is open
  const pending = new Set(); // 'save:<idx>' / 'share:<idx>' running for an entry
  let vaultUnlock = null; // {field, busy} while the inline vault unlock form is open
  const thumbs = new Map(); // entry index → object URL
  const thumbQueue = [];
  let thumbsRunning = 0;
  let observer = null;
  const body = h('div', { class: 'sd-card-body' });
  const el = h('section', { class: 'card sd-card sd-card-open', id: 'sd-open', tabIndex: -1, aria: { labelledby: 'sd-open-title' } },
    cardHead('unlock', 'Open a .czd', 'Unlock a file someone sent you — then preview, save or keep it in your vault.', 'sd-open-title'),
    body);
  const offDrop = dropZone(el, {
    multiple: true,
    onFiles: (list) => {
      if (list.length > 1) onMany(list);
      else if (list.length) load(list[0]);
    },
  });

  const vaultOf = () => {
    const v = getVault();
    return v && v.status === 'unlocked' ? v : null;
  };

  function revokeThumbs() {
    for (const url of thumbs.values()) URL.revokeObjectURL(url);
    thumbs.clear();
    thumbQueue.length = 0;
    observer?.disconnect();
    observer = null;
  }

  /** Drops the open file: viewer closed, previews revoked, the Opened released, passphrase cleared. */
  function reset() {
    seq++;
    ctl.abort(new CzdError('aborted'));
    ctl = new AbortController();
    if (viewer) {
      const v = viewer;
      viewer = null;
      v.close();
    }
    revokeThumbs();
    if (opened) container.release(opened);
    opened = null;
    src = null;
    legacy = null;
    pf?.clear();
    pf = null;
    file = null;
    kind = null;
    unlocking = false;
    errorMsg = null;
    activity = null;
    pending.clear();
    if (vaultUnlock) {
      vaultUnlock.field.clear();
      vaultUnlock = null;
    }
    phase = 'empty';
  }

  async function load(f, k) {
    reset();
    const my = seq;
    file = f;
    phase = 'pass';
    kind = k ?? null;
    if (!kind) {
      body.replaceChildren(indeterminate('Checking the file…'));
      kind = await sniff(f);
      if (my !== seq) return;
    }
    if (kind === 'czb') {
      reset();
      render();
      openRestore(f);
      return;
    }
    if (kind !== 'czd2' && kind !== 'oldczd') {
      phase = 'bad';
      render();
      return;
    }
    pf = kind === 'oldczd'
      ? passphraseField({ label: 'PIN', mode: 'enter', purpose: 'legacy', onSubmit: () => unlock() })
      : passphraseField({ label: 'Passphrase', mode: 'enter', purpose: 'open', onSubmit: () => unlock() });
    render();
    pf.focus();
  }

  function pick() {
    platform.pickFiles({ multiple: false }).then((list) => {
      if (list.length) load(list[0]);
    }, report);
  }

  async function unlock() {
    if (unlocking || !pf || !file) return;
    const pass = pf.value;
    if (!pass.trim()) {
      pf.setError(kind === 'oldczd' ? 'Type the PIN.' : 'Type the passphrase.');
      return;
    }
    const my = seq;
    const signal = ctl.signal;
    unlocking = true;
    errorMsg = null;
    render();
    try {
      if (kind === 'czd2') {
        const s = blobSource(file);
        const o = await container.openSource(s, { passphrase: pass, confirmKdf, signal });
        if (my !== seq) {
          container.release(o);
          return;
        }
        src = s;
        opened = o;
      } else {
        if (file.size > LEGACY_MAX) throw new CzdError('legacy-bad-record');
        const r = await openOldCzd(await file.text(), pass);
        if (my !== seq) return;
        legacy = { name: safeFilename(r.name), type: fileType(r.type, r.name), blob: r.blob };
      }
      unlocking = false;
      pf.clear();
      pf = null;
      phase = 'opened';
      render();
      const n = entries().length;
      // No decrypted name here: the live region's text outlives a lock.
      announce(n > 1 ? `Unlocked: ${n} files` : 'File unlocked');
      el.querySelector('.sd-entry .sd-act-preview')?.focus({ preventScroll: true });
    } catch (e) {
      if (my !== seq) return;
      unlocking = false;
      const code = toCzdError(e).code;
      render();
      if (isCancel(e)) {
        pf?.focus();
        return;
      }
      if (code === 'wrong-passphrase' || code === 'legacy-wrong-pin') {
        pf?.setError(userMessage(code));
        return;
      }
      if (code === 'internal') globalThis.console?.error?.('[send] open failed', e);
      errorMsg = openErrorText(code, e);
      render();
    }
  }

  // ── entries

  function entries() {
    if (legacy) return [{ idx: 0, name: legacy.name, type: legacy.type, size: legacy.blob.size }];
    if (!opened) return [];
    if (opened.isBundle && Array.isArray(opened.meta.entries)) {
      return opened.meta.entries.map((e, i) => ({ idx: i, name: e.name, type: e.type, size: e.size, mtime: e.mtime, entry: { off: e.off, size: e.size, name: e.name, type: e.type } }));
    }
    return [{ idx: 0, name: opened.meta.name, type: opened.meta.type, size: opened.size, mtime: opened.meta.mtime }];
  }

  /** DecryptSource for an entry. The Opened stays ours (release() is a no-op): the viewer must not drop it. */
  function sourceOf(en) {
    if (legacy) return { kind: 'plain', blob: legacy.blob, name: legacy.name, type: legacy.type };
    if (!opened?.keys) throw new CzdError('aborted', { detail: 'released' });
    const ds = { kind: 'container', src, opened, release() {} };
    if (en.entry) ds.entry = en.entry;
    return ds;
  }

  function actionsFor() {
    const a = ['save'];
    if (canShareFiles()) a.push('share');
    if (vaultOf()) a.push('addToVault');
    return a;
  }

  function preview(en) {
    const list = entries();
    const my = seq;
    const items = list.map((x) => ({
      key: String(x.idx),
      name: x.name,
      type: x.type,
      kind: kindOf(x.type, x.name),
      size: x.size,
      mtime: x.mtime,
      getSource: async () => {
        if (my !== seq) throw new CzdError('aborted');
        return sourceOf(x);
      },
      actions: actionsFor(),
    }));
    const handle = openViewer({
      items,
      index: list.findIndex((x) => x.idx === en.idx),
      onAction: (action, item) => {
        const target = list.find((x) => String(x.idx) === item.key);
        if (!target || my !== seq) return undefined;
        if (action === 'save') return saveOne(target);
        if (action === 'share') return shareOne(target);
        if (action === 'addToVault') return addOne(target);
        return undefined;
      },
      onClose: () => {
        if (viewer === handle) viewer = null;
      },
    });
    viewer = handle;
  }

  async function saveOne(en) {
    // One save per entry at a time, and never while a save picker is open (a double click must not open two
    // pickers or download twice).
    const key = `save:${en.idx}`;
    if (choosing || pending.has(key)) return;
    const my = seq;
    let target;
    choosing = true;
    pending.add(key);
    try {
      try {
        target = await platform.chooseSaveTarget({ name: en.name, mime: en.type, count: 1 });
      } catch (e) {
        report(e);
        return;
      } finally {
        choosing = false;
      }
      if (!target) return;
      if (my !== seq) {
        target.abort().catch(() => {});
        return;
      }
      const t = toast(`Decrypting “${shortName(en.name, 30)}”…`, { timeout: 0 });
      try {
        const r = await asJob(() => saveDecrypted(target, sourceOf(en), { name: en.name, type: en.type, signal: ctl.signal }));
        t.close();
        if (my !== seq) return;
        if (r?.staged) deliverStaged([r.staged]);
        else if (r?.where === 'downloads') toast('Download started', { kind: 'ok' });
        else toast(`Saved “${shortName(r?.name ?? en.name, 30)}”`, { kind: 'ok' });
      } catch (e) {
        t.close();
        if (my === seq) report(e);
      }
    } finally {
      if (my === seq) pending.delete(key);
    }
  }

  async function saveAll() {
    if (choosing || activity) return;
    const list = entries();
    const my = seq;
    let target;
    choosing = true;
    try {
      target = await platform.chooseSaveTarget({ name: list[0]?.name ?? 'files', count: list.length });
    } catch (e) {
      report(e);
      return;
    } finally {
      choosing = false;
    }
    if (!target) return;
    if (my !== seq || activity) {
      target.abort().catch(() => {});
      return;
    }
    const total = list.reduce((s, x) => s + x.size, 0);
    const row = progressRow({ name: `Saving ${plural(list.length, 'file')}`, total });
    row.onCancel(() => ctl.abort(new CzdError('aborted')));
    activity = { row };
    render();
    const staged = [];
    let viaDownloads = false;
    try {
      await asJob(async () => {
        let done = 0;
        for (const en of list) {
          const base = done;
          const r = await saveDecrypted(target, sourceOf(en), { name: en.name, type: en.type, signal: ctl.signal, onProgress: (d) => row.update(base + d) });
          done += en.size;
          row.update(done);
          if (r?.staged) staged.push(r.staged);
          if (r?.where === 'downloads') viaDownloads = true;
        }
      });
      if (my !== seq) return;
      activity = null;
      render();
      if (staged.length) deliverStaged(staged);
      else if (viaDownloads) toast('Downloads started', { kind: 'ok' });
      else toast(`Saved ${plural(list.length, 'file')}`, { kind: 'ok' });
    } catch (e) {
      if (my !== seq) return;
      activity = null;
      render();
      report(e);
    }
  }

  async function shareOne(en) {
    const key = `share:${en.idx}`;
    if (pending.has(key)) return;
    pending.add(key);
    const my = seq;
    const t = toast(`Preparing “${shortName(en.name, 30)}”…`, { timeout: 0 });
    try {
      const f = await prepareShare(sourceOf(en), { name: en.name, type: en.type });
      t.close();
      if (my === seq) await offerShare(f);
    } catch (e) {
      t.close();
      if (my === seq) report(e);
    } finally {
      if (my === seq) pending.delete(key);
    }
  }

  /** Full re-encrypt of one entry into a fresh vault container (media through a Blob so the vault makes a thumbnail). */
  async function addEntry(v, en, { album, signal, onProgress } = {}) {
    if (legacy) return v.addFile(new File([legacy.blob], legacy.name, { type: legacy.type }), { album, signal, onProgress });
    const meta = { name: en.name, type: en.type, size: en.size, mtime: en.mtime };
    const k = kindOf(en.type, en.name);
    if ((k === 'image' || k === 'video' || k === 'audio') && en.size <= MEDIA_BLOB_MAX) {
      const blob = await decryptToBlob(sourceOf(en), { maxBytes: MEDIA_BLOB_MAX, type: en.type, signal });
      return v.addStream(meta, blob, { album, signal, onProgress, thumbFrom: blob });
    }
    const ds = sourceOf(en);
    return v.addStream(meta, container.decryptSource(ds.src, ds.opened, { signal, entry: en.entry }), { album, signal, onProgress });
  }

  async function addOne(en) {
    const v = vaultOf();
    if (!v) {
      toast(userMessage('vault-locked'), { kind: 'warn' });
      return;
    }
    if (activity) {
      toast('Wait until the current job finishes.', { kind: 'warn' });
      return;
    }
    const my = seq;
    const row = progressRow({ name: `Adding “${shortName(en.name, 34)}”`, total: en.size });
    row.onCancel(() => ctl.abort(new CzdError('aborted')));
    activity = { row };
    render();
    try {
      await asJob(() => addEntry(v, en, { signal: ctl.signal, onProgress: (d) => row.update(d) }));
      if (my !== seq) return;
      activity = null;
      render();
      toast(`Added “${shortName(en.name, 30)}” to your vault`, { kind: 'ok', action: { label: 'Open vault', onClick: () => router.navigate('#/vault') } });
    } catch (e) {
      if (my !== seq) return;
      activity = null;
      render();
      report(e);
    }
  }

  /** The album for "Add all": the .czd's own name, or "Received <date>" for a hidden (random) name. */
  function albumName() {
    const stem = safeFilename(file?.name ?? '').replace(/\.czd$/i, '').trim();
    if (!stem || RANDOM_NAME.test(stem.toLowerCase()) || stem === 'file') return `Received ${fmtDate(Date.now())}`;
    return stem;
  }

  async function addAll() {
    const v = vaultOf();
    if (!v) {
      toast(userMessage('vault-locked'), { kind: 'warn' });
      return;
    }
    if (activity) return;
    const list = entries();
    const my = seq;
    const total = list.reduce((s, x) => s + x.size, 0);
    const row = progressRow({ name: `Adding ${plural(list.length, 'file')} to your vault`, total });
    row.onCancel(() => ctl.abort(new CzdError('aborted')));
    activity = { row };
    render();
    const name = albumName();
    try {
      const album = await asJob(async () => {
        const l = await v.createList({ name });
        let added = 0;
        try {
          let done = 0;
          for (const en of list) {
            const base = done;
            await addEntry(v, en, { album: l.id, signal: ctl.signal, onProgress: (d) => row.update(base + d) });
            added++;
            done += en.size;
            row.update(done);
          }
        } catch (e) {
          // Cancelled or failed before anything was added: no empty album left behind.
          if (!added && v.status === 'unlocked') await v.removeList(l.id).catch(() => {});
          throw e;
        }
        return l;
      });
      if (my !== seq) return;
      activity = null;
      render();
      toast(`Added ${plural(list.length, 'file')} to your vault · album “${shortName(name, 28)}”`, {
        kind: 'ok',
        timeout: 8000,
        action: { label: 'Open album', onClick: () => router.navigate(router.hrefFor('vault', 'album', album.id)) },
      });
    } catch (e) {
      if (my !== seq) return;
      activity = null;
      render();
      report(e);
    }
  }

  // ── thumbnails (image entries, decrypted while visible)

  function wantThumb(en) {
    return viewerMode(en.type, en.name, en.size) === 'image' && en.size <= THUMB_MAX;
  }

  function pumpThumbs() {
    while (thumbsRunning < THUMB_PARALLEL && thumbQueue.length) {
      const { en, box } = thumbQueue.shift();
      if (thumbs.has(en.idx) || !box.isConnected) continue;
      let ds;
      try {
        ds = sourceOf(en);
      } catch {
        return; // released (lock or close)
      }
      thumbsRunning++;
      const my = seq;
      decryptToBlob(ds, { maxBytes: THUMB_MAX, type: en.type, signal: ctl.signal })
        .then((blob) => {
          if (my !== seq) return;
          const url = URL.createObjectURL(blob);
          thumbs.set(en.idx, url);
          for (const b of el.querySelectorAll(`.sd-thumb[data-idx="${en.idx}"]`)) showThumb(b, url);
        })
        .catch(() => {})
        .finally(() => {
          thumbsRunning--;
          if (my === seq) pumpThumbs();
        });
    }
  }

  function showThumb(box, url) {
    const img = h('img', { class: 'sd-thumb-img', src: url, alt: '', decoding: 'async', draggable: false });
    img.addEventListener('error', () => img.remove(), { once: true });
    box.replaceChildren(img);
    box.classList.add('has-img');
  }

  function thumbBox(en) {
    const box = h('div', { class: 'sd-thumb', dataset: { idx: en.idx }, aria: { hidden: 'true' } }, kindIcon(kindOf(en.type, en.name)));
    const have = thumbs.get(en.idx);
    if (have) {
      showThumb(box, have);
    } else if (wantThumb(en)) {
      if (typeof IntersectionObserver === 'function') {
        observer ??= new IntersectionObserver((list) => {
          for (const it of list) {
            if (!it.isIntersecting) continue;
            observer.unobserve(it.target);
            const x = entries().find((e) => String(e.idx) === it.target.dataset.idx);
            if (x) thumbQueue.push({ en: x, box: it.target });
          }
          pumpThumbs();
        }, { rootMargin: '200px' });
        observer.observe(box);
      } else {
        thumbQueue.push({ en, box });
        pumpThumbs();
      }
    }
    return box;
  }

  // ── views

  function emptyView() {
    return h('div', { class: 'sd-empty' },
      h('div', { class: 'dropzone sd-drop' },
        icon('download'),
        h('p', { class: 'dropzone-title', text: 'Drop a .czd here' }),
        h('p', { class: 'dropzone-sub', text: 'Any name works — cZEROde checks what’s inside.' }),
        h('button', { type: 'button', class: 'btn btn-primary sd-pick-open', dataset: { fk: 'pick-open', fkFallback: '' }, on: { click: pick } }, icon('unlock'), h('span', { text: 'Choose file' }))),
      h('button', { type: 'button', class: 'btn-link sd-help-link', on: { click: () => openHelp() } }, icon('info'), h('span', { text: 'Got a .czd in WhatsApp or Discord?' })));
  }

  function fileChip(extra) {
    return h('div', { class: 'sd-chip' },
      h('span', { class: 'sd-chip-icon', aria: { hidden: 'true' } }, icon('lock')),
      h('span', { class: 'sd-chip-info' },
        h('span', { class: 'sd-chip-name', text: safeFilename(file?.name ?? ''), title: safeFilename(file?.name ?? '') }),
        h('span', { class: 'sd-chip-meta', text: [fmtSize(file?.size ?? 0), kind === 'oldczd' ? 'cZEROde 1 file' : null].filter(Boolean).join(' · ') })),
      extra);
  }

  function closeBtn(label) {
    return h('button', { type: 'button', class: 'btn-icon sd-close', dataset: { fk: 'close' }, aria: { label }, title: label, on: { click: () => {
      reset();
      render();
    } } }, icon('close'));
  }

  function passView() {
    const go = h('button', { type: 'button', class: 'btn btn-primary btn-block sd-unlock', dataset: { fk: 'unlock' }, disabled: unlocking, on: { click: () => unlock() } },
      icon('unlock'), h('span', { text: unlocking ? 'Unlocking…' : 'Open' }));
    pf.setDisabled(unlocking);
    pf.el.dataset.fk = 'pass';
    pf.el.dataset.fkFallback = '';
    return h('div', { class: 'sd-open-pass' },
      fileChip(closeBtn('Choose another file')),
      kind === 'oldczd' ? h('p', { class: 'hint' }, icon('info'), h('span', { text: 'This is a cZEROde 1 desktop file. The PIN it was locked with opens it.' })) : null,
      pf.el,
      go,
      unlocking ? indeterminate(kind === 'oldczd' ? 'Checking the PIN…' : 'Unlocking — this takes a moment') : null,
      errorMsg ? h('p', { class: 'hint hint-err sd-error', role: 'alert' }, icon('warning'), h('span', { text: errorMsg })) : null);
  }

  function badView() {
    return h('div', { class: 'sd-open-bad' },
      fileChip(closeBtn('Choose another file')),
      h('p', { class: 'hint hint-err sd-error', role: 'alert' }, icon('warning'), h('span', { text: userMessage('not-czd2') })),
      h('div', { class: 'sd-row' },
        h('button', { type: 'button', class: 'btn btn-sm', on: { click: pick } }, icon('unlock'), h('span', { text: 'Choose another file' })),
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost', on: { click: () => {
          const f = file;
          reset();
          render();
          if (f) toLock([f]);
        } } }, icon('lock'), h('span', { text: 'Lock it to send instead' }))));
  }

  function entryActions(en, single) {
    const name = safeFilename(en.name);
    // Bundle rows show icon-only buttons: their accessible name (and tooltip) says which file they act on.
    const btn = (cls, ic, label, fn, primary, full) => h('button', {
      type: 'button',
      class: ['btn', single ? null : 'btn-sm', primary ? 'btn-primary' : null, 'sd-act', cls],
      dataset: { fk: `${cls}-${en.idx}`, fkFallback: cls === 'sd-act-preview' && en.idx === 0 ? '' : undefined },
      title: single ? label : full,
      aria: { label: single ? undefined : full },
      on: { click: () => fn(en) },
    }, icon(ic), h('span', { class: 'sd-act-label', text: label }));
    const v = vaultOf();
    return h('div', { class: 'sd-entry-actions' },
      btn('sd-act-preview', 'eye', 'Preview', preview, single, `Preview ${name}`),
      btn('sd-act-save', 'download', 'Save', saveOne, false, `Save ${name}`),
      canShareFiles() ? btn('sd-act-share', 'share', 'Share', shareOne, false, `Share ${name}`) : null,
      v ? btn('sd-act-add', 'lock', single ? 'Add to my vault' : 'Add', addOne, false, `Add ${name} to my vault`) : null);
  }

  function entryRow(en, single) {
    const k = kindOf(en.type, en.name);
    const meta = [KIND_LABEL[k], fmtSize(en.size), Number.isFinite(en.mtime) ? fmtDate(en.mtime) : null].filter(Boolean).join(' · ');
    return h('li', { class: ['sd-entry', single ? 'sd-entry-single' : null] },
      thumbBox(en),
      h('div', { class: 'sd-entry-info' },
        h('span', { class: 'sd-entry-name', text: safeFilename(en.name), title: safeFilename(en.name) }),
        h('span', { class: 'sd-entry-meta', text: meta })),
      entryActions(en, single));
  }

  function openedView() {
    const list = entries();
    const bundle = Boolean(opened?.isBundle);
    const total = list.reduce((s, x) => s + x.size, 0);
    const v = vaultOf();
    const head = h('div', { class: 'sd-opened-head' },
      h('span', { class: 'badge badge-ok' }, icon('unlock'), h('span', { text: 'Unlocked' })),
      h('span', { class: 'sd-opened-from', text: safeFilename(file?.name ?? ''), title: safeFilename(file?.name ?? '') }),
      closeBtn('Close this file'));
    const bar = bundle ? h('div', { class: 'sd-bundle-bar' },
      h('p', { class: 'sd-label', text: `Bundle · ${plural(list.length, 'file')} · ${fmtSize(total)}` }),
      h('div', { class: 'sd-row' },
        h('button', { type: 'button', class: 'btn btn-sm sd-save-all', dataset: { fk: 'save-all' }, disabled: Boolean(activity), on: { click: () => saveAll() } }, icon('download'), h('span', { text: 'Save all' })),
        v ? h('button', { type: 'button', class: 'btn btn-sm btn-primary sd-add-all', dataset: { fk: 'add-all' }, disabled: Boolean(activity), on: { click: () => addAll() } }, icon('lock'), h('span', { text: 'Add all to my vault' })) : null)) : null;
    const rows = list.slice(0, CAPS.bundleEntries).map((en) => entryRow(en, !bundle));
    return h('div', { class: 'sd-opened' },
      head,
      bar,
      h('ul', { class: ['sd-entries', bundle ? 'sd-entries-bundle' : null] }, rows),
      activity ? h('div', { class: 'sd-activity' }, activity.row.el) : null,
      v ? null : vaultBox(list.length));
  }

  // ── keeping the files: the vault is unlocked right here (leaving this screen would close the file)

  function vaultBox(n) {
    const g = getVault();
    const st = g?.status;
    const these = n === 1 ? 'this file' : 'these files';
    if (st === 'locked') {
      if (!vaultUnlock) {
        return h('div', { class: 'sd-vault-hint sd-vault-locked' },
          icon('lock'),
          h('span', { class: 'sd-vault-text', text: `Want to keep ${these}? Unlock your vault here — the file stays open.` }),
          h('button', { type: 'button', class: 'btn btn-sm sd-vault-open', dataset: { fk: 'vault-open' }, on: { click: () => openVaultUnlock() } }, icon('unlock'), h('span', { text: 'Unlock vault' })));
      }
      const u = vaultUnlock;
      u.field.setDisabled(u.busy);
      u.field.el.dataset.fk = 'vault-pass';
      return h('form', { class: 'sd-vault-form', noValidate: true, aria: { label: 'Unlock your vault' }, on: { submit: (e) => {
        e.preventDefault();
        unlockVault();
      } } },
        h('input', { type: 'text', class: 'visually-hidden', name: 'username', autocomplete: 'username', value: 'cZEROde vault', readOnly: true, tabIndex: -1, attrs: { 'aria-hidden': 'true' } }),
        h('p', { class: 'sd-vault-text', text: `Unlock your vault to keep ${these}. The file stays open.` }),
        u.field.el,
        h('div', { class: 'sd-row' },
          h('button', { type: 'submit', class: 'btn btn-sm btn-primary sd-vault-go', dataset: { fk: 'vault-go' }, disabled: u.busy }, icon('unlock'), h('span', { text: u.busy ? 'Unlocking…' : 'Unlock' })),
          h('button', { type: 'button', class: 'btn btn-sm btn-ghost sd-vault-cancel', dataset: { fk: 'vault-cancel' }, disabled: u.busy, on: { click: () => closeVaultUnlock(true) } }, h('span', { text: 'Not now' }))));
    }
    if (st === 'none') {
      return h('p', { class: 'sd-fine sd-vault-hint' }, icon('info'),
        h('span', null, `To keep ${these}, create a vault in the `, h('a', { href: '#/vault', text: 'Vault tab' }), ' first — leaving this screen closes the file.'));
    }
    if (st === 'other-tab') {
      return h('p', { class: 'sd-fine sd-vault-hint' }, icon('info'),
        h('span', { text: `Your vault is open in another cZEROde tab — add ${these} there.` }));
    }
    return null;
  }

  function openVaultUnlock() {
    if (vaultUnlock) return;
    vaultUnlock = {
      busy: false,
      field: passphraseField({ label: 'Vault passphrase', mode: 'enter', purpose: 'unlock', name: 'czd-vault-unlock' }),
    };
    render();
    vaultUnlock.field.focus();
  }

  function closeVaultUnlock(focus) {
    const u = vaultUnlock;
    if (!u) return;
    vaultUnlock = null;
    u.field.clear();
    render();
    if (focus) el.querySelector('.sd-vault-open')?.focus({ preventScroll: true });
  }

  async function unlockVault() {
    const u = vaultUnlock;
    const g = getVault();
    if (!u || u.busy || !g) return;
    const pass = u.field.value;
    if (!pass.trim()) {
      u.field.setError('Type your vault passphrase first.');
      return;
    }
    u.busy = true;
    render();
    try {
      await g.unlock(pass, { confirmKdf: confirmVaultKdf });
      if (vaultUnlock !== u) return;
      vaultUnlock = null;
      u.field.clear();
      render();
      announce('Vault unlocked');
      (el.querySelector('.sd-add-all') ?? el.querySelector('.sd-act-add'))?.focus({ preventScroll: true });
    } catch (e) {
      if (vaultUnlock !== u) return;
      u.busy = false;
      render();
      if (isCancel(e)) u.field.focus();
      else u.field.setError(userMessage(e));
    }
  }

  function render() {
    let view;
    if (phase === 'opened' && (opened || legacy)) view = openedView();
    else if (phase === 'pass' && pf) view = passView();
    else if (phase === 'bad') view = badView();
    else view = emptyView();
    keepFocus(body, () => body.replaceChildren(view));
    el.dataset.phase = phase;
  }

  const offPurge = state.onPurge(() => {
    reset();
    render();
  });
  render();

  return {
    el,
    load,
    refresh: () => render(),
    focus() {
      const t = el.querySelector('.sd-pick-open') ?? pf?.input ?? el;
      t.focus({ preventScroll: true });
    },
    destroy() {
      offPurge();
      offDrop();
      reset();
    },
  };
}

// ───────── help sheet

let helpSheet = null;

function openHelp() {
  helpSheet?.close();
  const steps = (title, iconId, list) => h('section', { class: 'sd-help-sec' },
    h('h3', { class: 'sd-help-title' }, icon(iconId), h('span', { text: title })),
    h('ol', { class: 'sd-help-steps' }, list.map((s) => h('li', { text: s }))));
  const body = h('div', { class: 'sd-help' },
    h('p', { class: 'sd-help-lead', text: 'First save the file out of the chat app, then open it here with the passphrase the sender gave you.' }),
    steps('WhatsApp', 'send', [
      'iPhone: tap the file in the chat → Share → Save to Files.',
      'Android: tap the file — it lands in Downloads (or long-press → Save).',
      'WhatsApp Web / Desktop: hover the file → ⌄ menu → Download.',
    ]),
    steps('Discord', 'send', [
      'Phone: tap the file → Download (Android) or Share → Save to Files (iPhone).',
      'Computer: click the file name or the download arrow.',
    ]),
    steps('Email, Telegram, Signal, USB', 'download', [
      'Download or save the attachment to your files first.',
      'From a USB stick: copy the .czd to this device, or pick it straight from the stick.',
    ]),
    steps('Then, here', 'unlock', [
      'Tap Open a .czd → Choose file, and pick it (or drop it on the card).',
      'Type the passphrase. Capital letters matter; spaces at the ends are ignored.',
      'Preview, save, or add it to your vault.',
    ]),
    h('p', { class: 'sd-fine' }, icon('info'), h('span', { text: 'Renamed file? No problem — cZEROde recognises a .czd by what’s inside, not by its name. If you installed cZEROde, you can also share a .czd straight to it.' })));
  helpSheet = sheet({ title: 'Got a .czd in WhatsApp or Discord?', body, className: 'sd-help-sheet', onClose: () => {
    helpSheet = null;
  } });
}

// ───────── Incoming (share target, file handlers, Tauri associations, sniffed vault drops)

/**
 * Files waiting for a decision; kept across visits (they came from outside, nothing here is decrypted) but not
 * across a lock: their names must not stay on screen, so every purge empties the list.
 */
const stash = [];
let stashSeq = 0;
const takenShares = new Set();
/** Repaint functions of mounted Incoming panels. */
const stashViews = new Set();
/** Bumped by every purge: files still being sniffed then are dropped instead of listed. */
let stashEpoch = 0;
state.onPurge(() => {
  stashEpoch++;
  stash.length = 0;
  for (const paint of [...stashViews]) paint();
});

function incomingPanel({ getVault, open, lock }) {
  const list = h('ul', { class: 'sd-in-list' });
  const countEl = h('span', { class: 'sd-total' });
  const bulk = h('div', { class: 'sd-row sd-in-bulk' });
  const el = h('section', { class: 'card sd-incoming', hidden: true, aria: { labelledby: 'sd-in-title' } },
    h('header', { class: 'sd-in-head' },
      h('span', { class: 'sd-card-icon', aria: { hidden: 'true' } }, icon('download')),
      h('div', { class: 'sd-card-titles' },
        h('h2', { class: 'sd-card-title', id: 'sd-in-title', text: 'Incoming' }),
        h('p', { class: 'sd-card-sub', text: 'Files sent to cZEROde. Locked files open here; anything else you can lock to send or keep in your vault.' })),
      countEl,
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost sd-in-clear', on: { click: () => {
        stash.length = 0;
        render();
      } } }, icon('close'), h('span', { text: 'Clear' }))),
    list,
    bulk);

  const vaultOf = () => {
    const v = getVault();
    return v && v.status === 'unlocked' ? v : null;
  };
  const drop = (entry) => {
    const i = stash.indexOf(entry);
    if (i >= 0) stash.splice(i, 1);
    render();
  };

  async function toVault(entries) {
    const v = vaultOf();
    if (!v) {
      const st = getVault()?.status;
      const what = entries.length === 1 ? 'it' : 'them';
      toast(st === 'none' ? `Create your vault first, then come back to Send to add ${what}.` : `Unlock your vault first, then come back to Send to add ${what}.`, { kind: 'warn', timeout: 6000 });
      router.navigate('#/vault');
      return;
    }
    for (const e of entries) drop(e);
    try {
      await importToVault(v, entries.map((e) => e.file));
    } catch (e) {
      report(e);
    }
  }

  async function toLock(entries) {
    // The files leave the list only when the Lock card took them (it refuses while it is locking).
    if (!(await lock.addFiles(entries.map((e) => e.file), { sniffed: true }))) return;
    for (const e of entries) drop(e);
    lock.el.scrollIntoView?.({ block: 'nearest' });
  }

  const LABEL = { czd2: 'Locked file', oldczd: 'cZEROde 1 file', czb: 'Backup' };

  function row(entry) {
    const f = entry.file;
    const k = entry.kind;
    const btn = (label, ic, fn, primary) => h('button', { type: 'button', class: ['btn', 'btn-sm', primary ? 'btn-primary' : null], on: { click: fn } }, icon(ic), h('span', { text: label }));
    let actions;
    if (k === undefined) actions = [h('span', { class: 'sd-in-wait', text: 'Checking…' })];
    else if (k === 'czd2' || k === 'oldczd') {
      actions = [btn('Open', 'unlock', () => {
        drop(entry);
        open.load(f, k);
        open.el.scrollIntoView?.({ block: 'nearest' });
        open.focus();
      }, true)];
    } else if (k === 'czb') {
      actions = [btn('Restore', 'refresh', () => {
        drop(entry);
        openRestore(f);
      }, true)];
    } else {
      actions = [btn('Lock to send', 'lock', () => toLock([entry]), true), btn('Add to vault', 'plus', () => toVault([entry]))];
    }
    return h('li', { class: 'sd-in-row', dataset: { kind: k ?? 'pending' } },
      k === 'czd2' || k === 'oldczd' || k === 'czb' ? h('span', { class: 'sd-in-icon', aria: { hidden: 'true' } }, icon(k === 'czb' ? 'refresh' : 'lock')) : kindIcon(kindOf(fileType(f.type, f.name), f.name)),
      h('span', { class: 'sd-in-info' },
        h('span', { class: 'sd-in-name', text: safeFilename(f.name), title: safeFilename(f.name) }),
        h('span', { class: 'sd-in-meta', text: [LABEL[k] ?? (k === null ? KIND_LABEL[kindOf(fileType(f.type, f.name), f.name)] : null), fmtSize(f.size)].filter(Boolean).join(' · ') })),
      h('span', { class: 'sd-in-actions' }, actions),
      h('button', { type: 'button', class: 'btn-icon sd-in-x', aria: { label: `Dismiss ${safeFilename(f.name)}` }, title: 'Dismiss', on: { click: () => drop(entry) } }, icon('close')));
  }

  function render() {
    el.hidden = stash.length === 0;
    list.replaceChildren(...stash.slice(0, LIST_MAX).map(row));
    countEl.textContent = plural(stash.length, 'file');
    const plain = stash.filter((e) => e.kind === null);
    bulk.replaceChildren(...(plain.length > 1 ? [
      h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => toLock(plain) } }, icon('lock'), h('span', { text: `Lock all ${plain.length} to send` })),
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', on: { click: () => toVault(plain) } }, icon('plus'), h('span', { text: `Add all ${plain.length} to vault` })),
    ] : []));
    bulk.hidden = plain.length < 2;
  }

  /**
   * New arrivals: sniffed; a single locked file goes straight into the Open card (autoOpen), everything else
   * waits in the list.
   */
  async function add(files, { autoOpen = true } = {}) {
    const list0 = [...(files ?? [])].filter((f) => typeof Blob !== 'undefined' && f instanceof Blob);
    if (!list0.length) return;
    const epoch = stashEpoch;
    const kinds = await Promise.all(list0.map((f) => sniff(f)));
    if (epoch !== stashEpoch) return; // a lock came while they were checked
    if (autoOpen && list0.length === 1 && (kinds[0] === 'czd2' || kinds[0] === 'oldczd')) {
      open.load(list0[0], kinds[0]);
      open.el.scrollIntoView?.({ block: 'nearest' });
      open.focus();
      return;
    }
    list0.forEach((f, i) => stash.push({ id: ++stashSeq, file: f, kind: kinds[i] }));
    render();
    el.scrollIntoView?.({ block: 'nearest' });
  }

  render();
  stashViews.add(render);
  return { el, add, refresh: render, destroy: () => stashViews.delete(render) };
}

// ───────── the page

function unsupportedView(host) {
  host.append(h('section', { class: 'sd-unsupported' },
    h('div', { class: 'sd-emblem', aria: { hidden: 'true' } }, icon('warning')),
    h('h1', { class: 'sd-title', text: 'This browser is too old for cZEROde 2' }),
    h('p', { class: 'sd-lead', text: 'Update it or use the desktop app to lock and open files. Old cZEROde 1 messages and files still open in Legacy.' }),
    h('a', { class: 'btn btn-primary', href: '#/legacy' }, icon('key'), h('span', { text: 'Open Legacy' }))));
  return { update() {}, destroy() {} };
}

function sendPage(host, { getVault }) {
  let incoming = null;
  let open = null;
  let alive = true;
  const lock = lockPanel({
    getVault,
    // From a toast's button: the toast may outlive this screen.
    toOpen: (locked) => {
      if (!alive) return;
      if (locked.length === 1) {
        open.load(locked[0].file, locked[0].kind);
        open.el.scrollIntoView?.({ block: 'nearest' });
        open.focus();
      } else {
        incoming.add(locked.map((x) => x.file), { autoOpen: false });
      }
    },
  });
  open = openPanel({ getVault, toLock: (files) => lock.addFiles(files, { sniffed: true }), onMany: (files) => incoming.add(files, { autoOpen: false }) });
  incoming = incomingPanel({ getVault, open, lock });
  const grid = h('div', { class: 'sd-grid' }, lock.el, open.el);
  const step = (n, title, text) => h('li', { class: 'sd-step' }, h('span', { class: 'sd-step-n', text: n }), h('span', { class: 'sd-step-text' }, h('strong', { text: title }), h('span', { text })));
  const page = h('div', { class: 'sd-page' },
    h('header', { class: 'sd-head' },
      h('p', { class: 'sd-eyebrow', text: 'Lock · Send · Open' }),
      h('h1', { class: 'sd-title', text: 'Send · Open' }),
      h('p', { class: 'sd-lead', text: 'Lock files into one passphrase-protected .czd to send over anything — and open the ones people send you. It all happens on this device.' })),
    incoming.el,
    grid,
    h('ol', { class: 'sd-steps', aria: { label: 'How sending works' } },
      step('1', 'Lock', 'Pick files, keep the generated passphrase.'),
      step('2', 'Send the .czd', 'WhatsApp, Discord, email, USB — any way works.'),
      step('3', 'Send the passphrase', 'Through a different app, or say it out loud.')));
  host.append(page);

  let lastTop = null;
  function consume(route) {
    const pending = state.get('send.pending');
    if (pending && Array.isArray(pending.itemIds) && pending.itemIds.length) {
      state.set('send.pending', null);
      lock.setVaultItems(pending.itemIds.filter((x) => typeof x === 'string'));
    }
    const files = state.get('incoming.files');
    if (Array.isArray(files) && files.length) {
      state.set('incoming.files', null);
      incoming.add(files);
    }
    const share = route?.top === 'incoming' ? route.query?.get('share') : null;
    if (share && !takenShares.has(share)) {
      takenShares.add(share);
      // Drop the used id from the address (no Back step). Deferred: navigating while the router is still
      // mounting this view would mount it a second time.
      setTimeout(() => {
        if (router.current()?.query?.get('share') === share) router.navigate('#/incoming', { replace: true });
      }, 0);
      takeSharedFiles(share).then((got) => {
        if (got.length) incoming.add(got);
        else toast('Those shared files are gone — share them again.', { kind: 'warn' });
      }, report);
    }
  }

  const offs = [
    state.on('send.pending', (v) => {
      if (v) consume(router.current());
    }),
    state.on('incoming.files', (v) => {
      if (Array.isArray(v) && v.length) consume(router.current());
    }),
    state.on('vault.status', () => {
      lock.refresh();
      open.refresh();
      incoming.refresh();
    }),
  ];

  return {
    update(route) {
      const top = route?.top ?? 'send';
      grid.classList.toggle('sd-focus-open', top === 'open');
      consume(route);
      if (top === 'open' && lastTop !== 'open') {
        // After the router's own scroll-to-top/focus of a freshly mounted view.
        setTimeout(() => {
          if (!open.el.isConnected) return;
          open.el.scrollIntoView?.({ block: 'nearest' });
          open.focus();
        }, 0);
      }
      lastTop = top;
    },
    destroy() {
      alive = false;
      for (const off of offs.splice(0)) off();
      helpSheet?.close();
      lock.destroy();
      open.destroy();
      incoming.destroy();
    },
  };
}

/** ViewModule.mount (tops 'send', 'open', 'incoming'). */
export function mount(root, route, ctx) {
  const getVault = () => ctx?.vault ?? null;
  const el = h('div', { class: 'sd' });
  root.append(el);
  let current = route;
  let page = null;
  let unsupported = null;

  function build() {
    const bad = state.get('browser.ok') === false;
    if (page && unsupported === bad) return;
    page?.destroy();
    el.replaceChildren();
    unsupported = bad;
    page = bad ? unsupportedView(el) : sendPage(el, { getVault });
    page.update(current);
  }
  const offBrowser = state.on('browser.ok', () => build());
  build();

  return {
    update(r) {
      current = r;
      page?.update(r);
    },
    unmount() {
      offBrowser();
      page?.destroy();
      page = null;
      el.remove();
    },
  };
}
