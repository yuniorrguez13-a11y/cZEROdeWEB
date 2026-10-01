// Vault screen (route 'vault'; DESIGN §1.3–§1.6, §4.3, §4.5, §12). Owner: V1a.
// One view, one screen per vault status: loading · unsupported browser · first run ('none': hero, iOS install gate,
// create form) · locked (unlock, forgot → recovery code / delete) · other tab · storage unavailable · unlocked
// (toolbar, banners, album strip, grid, storage bar, viewer at #/vault/item/<id>, album mode at #/vault/album/<id>).
// Pickers, save targets, persist() and shares are always the FIRST await of their click handler (§1.7); the modules
// those clicks need (upload, albums, settings) are preloaded so their entry points can be called synchronously.
// Deletes are hidden at once and committed after TIMES.undoMs, on lock ('locking', keys still present), on purge
// and on pagehide. Node-importable: the DOM is only touched inside functions.

import { h, icon, toast, modal, sheet, confirmDialog, promptDialog, announce } from '../util/dom.js';
import { passphraseField, banner, storageBar, emptyState, copyButton, dropZone } from './components.js';
import * as state from '../state.js';
import * as settings from '../settings.js';
import * as router from '../router.js';
import * as platform from '../platform.js';
import * as pwa from '../pwa.js';
import { isCancel, userMessage } from '../errors.js';
import { CAPS, TIMES } from '../config.js';
import { FLOOR, passphraseBytes } from '../crypto/kdf.js';
import { meetsVaultMinimum } from '../crypto/passphrase.js';
import { fmtSize, safeFilename } from '../util/format.js';
import { ctEqual } from '../util/bytes.js';
import { disposeSource, prepareShare, saveDecrypted } from '../media/media.js';
import { openViewer } from './viewer.js';
import { playQueue } from './player.js';
import { grid as makeGrid, FILTERS, SORTS, displayName, labelText, matchesKind, visibleItems } from './vault-grid.js';

const DAY = 86_400_000;
const GIB = 2 ** 30;
const BACKUP_NAG_DAYS = 7;
const PERSIST_SNOOZE = 14 * DAY;
const CZD2_MAGIC = [0x89, 0x43, 0x5a, 0x44, 0x0d, 0x0a, 0x1a, 0x0a];
const CZB_MAGIC = [0x89, 0x43, 0x5a, 0x42, 0x0d, 0x0a, 0x1a, 0x0a];

// ───────── lazily loaded neighbours (owned by other views; any of them may be missing or a stub)

const LOADERS = {
  upload: () => import('./upload.js'),
  albums: () => import('./albums.js'),
  settings: () => import('./settings-view.js'),
  tutorial: () => import('./tutorial.js'),
};
const mods = {};
const loading = {};

function load(name) {
  loading[name] ??= LOADERS[name]().then((m) => {
    mods[name] = m;
    return m;
  }, (e) => {
    globalThis.console?.warn?.(`[vault] ${name} module unavailable`, e);
    loading[name] = null;
    return null;
  });
  return loading[name];
}

/** An export of a loaded module, or null (not loaded yet / missing). */
function fn(name, exp) {
  const m = mods[name];
  return m && typeof m[exp] === 'function' ? m[exp] : null;
}

/** Calls a neighbour's entry point; null when it is missing or still a phase-0 stub. */
function tryCall(name, exp, ...args) {
  const f = fn(name, exp);
  if (!f) return null;
  try {
    const r = f(...args);
    if (r && typeof r.then === 'function') {
      return r.then((v) => v, (e) => {
        if (e?.code === 'not-implemented') throw Object.assign(new Error('missing'), { missing: true });
        throw e;
      });
    }
    return r;
  } catch (e) {
    if (e?.code === 'not-implemented') return null;
    throw e;
  }
}

function report(e) {
  if (!e || isCancel(e) || e.missing) return;
  if (e?.code === 'internal' || !e?.code) globalThis.console?.error?.('[vault]', e);
  toast(saveMessage(e), { kind: 'err' });
}

/** userMessage plus the "too big to save" case (§11). */
function saveMessage(e) {
  if ((e?.code === 'too-big-to-preview' && e?.detail === 'too-big-to-save') || (e?.code === 'quota-exceeded' && e?.detail === 'staging limit')) {
    return 'Too big to save in this browser — use the desktop app or Chrome.';
  }
  return userMessage(e);
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A name for toasts and dialogs: a file name through safeFilename (label: already a clean label), an ItemInfo as the grid shows it. */
const shortName = (s, max = 42, label = false) => {
  const n = typeof s !== 'string' ? displayName(s) : label ? s : safeFilename(s);
  return n.length > max ? `${n.slice(0, max - 1)}…` : n;
};
const finePointer = () => {
  try {
    return globalThis.matchMedia?.('(pointer: fine)').matches === true;
  } catch {
    return false;
  }
};
const canPickFolder = () => finePointer() && typeof HTMLInputElement === 'function' && 'webkitdirectory' in HTMLInputElement.prototype;
const canShare = () => platform.caps.mobile() && typeof globalThis.navigator?.share === 'function';
const isEditable = (t) => t instanceof Element && Boolean(t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));

/** Pasted files; the browser's generic "image.png" becomes "Pasted image <date>.png". */
function pasted(e) {
  const files = [...(e?.clipboardData?.files ?? [])];
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.');
  return files.map((f, i) => {
    if (!/^image\.[a-z0-9]+$/i.test(f.name)) return f;
    const ext = f.name.split('.').pop();
    return new File([f], `Pasted image ${stamp}${files.length > 1 ? ` (${i + 1})` : ''}.${ext}`, { type: f.type, lastModified: Date.now() });
  });
}

/** Same passphrase after canonicalization (§3.1: spaces at the ends and runs of spaces don't count). */
function samePass(a, b) {
  try {
    return ctEqual(passphraseBytes(a), passphraseBytes(b));
  } catch {
    return a === b;
  }
}

function dismissed(key) {
  const d = settings.get('dismissed');
  return d && Object.hasOwn(d, key) ? d[key] : undefined;
}

function dismiss(key, value) {
  try {
    settings.set('dismissed', { ...settings.get('dismissed'), [key]: value });
  } catch {
    // storage unavailable: dismissed for this page load only
  }
}

const PRIVATE_TEXT = 'Private window or limited storage: your vault may disappear when you close this window.';

/**
 * §1.3: the store probe fails or the quota is under 1 GiB. With a vault, its store kind tells (IndexedDB blobs although
 * OPFS exists = the OPFS probe failed); before one exists, OPFS refusing to open (Firefox/Safari private windows).
 * @param {{storeKind?: string|null}|null} v
 * @param {{quota?: number}|null} est platform.storage.estimate()
 */
async function limitedStorage(v, est) {
  // Desktop app: the vault lives in files under the app's data folder, not in the webview's storage quota.
  if (platform.isTauri) return false;
  if (Number.isFinite(est?.quota) && est.quota < GIB) return true;
  const getDir = globalThis.navigator?.storage?.getDirectory;
  if (typeof getDir !== 'function') return false;
  if (v?.storeKind) return v.storeKind === 'idb';
  try {
    await globalThis.navigator.storage.getDirectory();
    return false;
  } catch {
    return true;
  }
}

/** "KDF needs more than usual" confirmation (§3.2). */
function confirmKdf(params) {
  const mib = Math.round((Number(params?.m) || 0) / 1024);
  return confirmDialog({
    title: 'Heavy unlock',
    message: `This vault needs ~${mib} MiB of memory to unlock. Continue?`,
    confirmLabel: 'Continue',
  });
}

// ───────── delivering decrypted files (plaintext stays in memory; revoked on lock)

const liveUrls = new Set();
let urlPurgeHooked = false;

function downloadFile(file) {
  if (!urlPurgeHooked) {
    urlPurgeHooked = true;
    state.onPurge(() => {
      for (const u of liveUrls) URL.revokeObjectURL(u);
      liveUrls.clear();
    });
  }
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

/** Staged outputs: saved right away while the click's activation lasts, else one Save click each. */
function deliverStaged(files) {
  const list = files.filter(Boolean);
  if (!list.length) return;
  const active = globalThis.navigator?.userActivation?.isActive;
  if (list.length === 1 && active !== false) {
    downloadFile(list[0]);
    toast(`Saved “${shortName(list[0].name)}” to your downloads`, { kind: 'ok' });
    return;
  }
  const rows = list.map((f, i) => {
    const btn = h('button', { type: 'button', class: 'btn btn-sm btn-primary', dataset: { autofocus: i === 0 ? '' : undefined }, aria: { label: `Save ${safeFilename(f.name)}` } }, icon('download'), h('span', { text: 'Save' }));
    btn.addEventListener('click', () => {
      downloadFile(f);
      btn.disabled = true;
      btn.lastChild.textContent = 'Saved';
      // The next one is a Tab away (a disabled button drops the focus).
      rowsEl.querySelector('.btn-primary:not(:disabled)')?.focus();
    });
    return h('li', { class: 'vv-ready-row' }, h('span', { class: 'vv-ready-name', text: safeFilename(f.name) }), h('span', { class: 'vv-ready-size', text: fmtSize(f.size) }), btn);
  });
  const rowsEl = h('ul', { class: 'vv-ready' }, rows);
  const p = modal({
    title: list.length === 1 ? 'Ready to save' : `${list.length} files ready`,
    body: h('div', { class: 'stack' }, h('p', { text: list.length === 1 ? 'Your decrypted copy is ready.' : 'Your decrypted copies are ready. Save each one.' }), rowsEl),
    actions: [{ label: 'Done', kind: 'ghost', value: null }],
  });
  p.then(() => list.splice(0));
}

// ───────── recovery code sheet (after create; also usable by other views through this module)

/** The open recovery-code sheet (closed when the vault view unmounts). */
let recoverySheet = null;
/** True while the view closes the sheet itself (unmount, a newer code): no "no recovery code saved" toast. */
let closing = false;

function closeRecoverySheet() {
  closing = true;
  try {
    recoverySheet?.close();
  } finally {
    closing = false;
  }
}

/**
 * Shows a freshly created recovery code (8 groups of 4) with Copy / Download .txt / "I saved it" / Skip.
 * @param {string} code
 */
export function showRecoveryCode(code) {
  if (typeof code !== 'string' || !code) return null;
  const groups = code.split('-');
  const codeEl = h('div', { class: 'vv-code', role: 'group', aria: { label: 'Recovery code' } },
    groups.map((g, i) => h('span', { class: 'vv-code-group', dataset: { n: String(i + 1) }, text: g })));
  // Closed without "I saved it", Copy or Download (Skip, ×, Back, a click outside): say where a new code can be made.
  let saved = false;
  const download = h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => saveCode() } }, icon('download'), h('span', { text: 'Download .txt' }));
  const done = h('button', {
    type: 'button',
    class: 'btn btn-primary',
    on: {
      click: () => {
        saved = true;
        s.close();
      },
    },
  }, icon('check'), h('span', { text: 'I saved it' }));
  const skip = h('button', { type: 'button', class: 'btn btn-ghost', text: 'Skip', on: { click: () => s.close() } });
  const body = h('div', { class: 'vv-recovery-body' },
    h('p', { class: 'vv-lead', text: "If you ever forget your passphrase, this code opens your vault. It's shown only this once." }),
    codeEl,
    h('div', { class: 'vv-recovery-tools' }, copyButton(() => {
      saved = true;
      return code;
    }, { secret: true, label: 'Copy code' }), download),
    banner({ kind: 'warn', text: 'Save it somewhere safe. Anyone with this code can open your vault.' }),
    h('div', { class: 'vv-recovery-foot' }, skip, done));
  closeRecoverySheet();
  const s = sheet({
    title: 'Your recovery code',
    className: 'vv-recovery',
    body,
    onClose: () => {
      codeEl.replaceChildren();
      if (recoverySheet === s) recoverySheet = null;
      // Not after a lock (the purge closes the sheet and clears every toast) nor when the view goes away.
      if (!saved && !closing && state.get('vault.status') === 'unlocked') {
        toast('No recovery code saved — you can make one later in Settings → Vault.', { timeout: 6000 });
      }
    },
  });
  recoverySheet = s;
  done.focus({ preventScroll: true });

  // Set before the picker opens (a second click while it is open would fall back to a staged download).
  let saving = false;
  async function saveCode() {
    if (saving) return;
    saving = true;
    const name = 'cZEROde-recovery-code.txt';
    let target;
    try {
      target = await platform.chooseSaveTarget({ name, mime: 'text/plain', count: 1 });
    } catch (e) {
      saving = false;
      report(e);
      return;
    }
    if (!target) {
      saving = false;
      return;
    }
    const text = `cZEROde vault recovery code\n\n${code}\n\nAnyone with this code can open your vault.\nKeep it somewhere safe and private.\n`;
    const blob = new Blob([text], { type: 'text/plain' });
    try {
      const r = await target.write(name, blob, { size: blob.size, mime: 'text/plain' });
      saved = true;
      // Locked meanwhile: the code is not handed out on a locked screen (Settings makes a new one).
      if (state.get('vault.status') !== 'unlocked') return;
      if (r?.staged) deliverStaged([r.staged]);
      else toast('Recovery code saved', { kind: 'ok' });
    } catch (e) {
      await target.abort().catch(() => {});
      report(e);
    } finally {
      saving = false;
    }
  }
  return s;
}

// ───────── pending deletes (module level: they outlive a remount, commit on lock/purge/pagehide)

/**
 * The vault's (cleartext, device-local) kv key listing the ids of deletes still in their undo window. A commit started
 * by pagehide (or by the lock that pagehide causes) rarely reaches IndexedDB before the page is gone; whatever is
 * still listed here at the next unlock is deleted then. Item ids are the index's cleartext keys: nothing new leaks.
 */
const PENDING_KEY = 'pending-deletes';

let deleter = null;

function deletes(vault) {
  if (deleter?.vault === vault) return deleter;
  const hidden = new Set();
  const batches = new Set();
  const subs = new Set();
  // kv writes run one after another, so the last one written is the latest set.
  let kvChain = Promise.resolve();
  const remember = () => {
    const ids = [...hidden];
    kvChain = kvChain
      .then(() => vault.kvSet?.(PENDING_KEY, ids.length ? ids : undefined))
      .catch(() => {}); // no database (tests) or storage gone: best effort
  };
  const notify = (info) => {
    for (const fn2 of [...subs]) {
      try {
        fn2(info);
      } catch (e) {
        globalThis.console?.error?.(e);
      }
    }
  };
  function schedule(ids, label) {
    const fresh = [...new Set(ids)].filter((id) => !hidden.has(id));
    if (!fresh.length) return;
    const b = { ids: fresh, timer: null, toast: null, done: false };
    for (const id of fresh) hidden.add(id);
    batches.add(b);
    remember();
    notify();
    b.toast = toast(label, { timeout: TIMES.undoMs, action: { label: 'Undo', onClick: () => undo(b) } });
    b.timer = setTimeout(() => commit(b), TIMES.undoMs);
  }
  function undo(b) {
    if (b.done) return;
    b.done = true;
    clearTimeout(b.timer);
    batches.delete(b);
    for (const id of b.ids) hidden.delete(id);
    remember();
    notify({ restored: b.ids });
    announce('Restored');
  }
  function commit(b) {
    if (b.done) return;
    b.done = true;
    clearTimeout(b.timer);
    batches.delete(b);
    b.toast?.close();
    let p;
    try {
      p = vault.remove(b.ids);
    } catch (e) {
      p = Promise.reject(e);
    }
    Promise.resolve(p)
      .catch((e) => {
        if (!isCancel(e) && e?.code !== 'vault-locked') toast(userMessage(e), { kind: 'err' });
      })
      .finally(() => {
        for (const id of b.ids) hidden.delete(id);
        remember();
        notify();
      });
  }
  const commitAll = () => {
    for (const b of [...batches]) commit(b);
  };
  /** After an unlock: deletes left over from a page that went away inside the undo window are committed now. */
  async function resume() {
    let ids;
    try {
      ids = await vault.kvGet?.(PENDING_KEY);
    } catch {
      return;
    }
    if (!Array.isArray(ids) || vault.status !== 'unlocked') return;
    const left = [...new Set(ids)].filter((id) => {
      if (typeof id !== 'string' || hidden.has(id)) return false;
      try {
        vault.item(id);
        return true;
      } catch {
        return false;
      }
    });
    if (!left.length) {
      remember(); // already gone: forget them
      return;
    }
    const b = { ids: left, timer: null, toast: null, done: false };
    for (const id of left) hidden.add(id);
    batches.add(b);
    notify();
    commit(b);
  }
  vault.addEventListener('locking', commitAll);
  state.onPurge(commitAll);
  globalThis.addEventListener?.('pagehide', commitAll);
  deleter = {
    vault,
    isHidden: (id) => hidden.has(id),
    schedule,
    commitAll,
    resume,
    subscribe(f) {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
  return deleter;
}

// ───────── view

/** Chip and other choices that survive remounts (the search text does not). */
const memory = { kind: 'all' };

/**
 * ViewModule.mount.
 * @param {HTMLElement} root
 * @param {import('../types.js').Route} route
 * @param {{vault: any, state: any}} ctx
 */
export function mount(root, route, ctx) {
  const getVault = () => ctx?.vault ?? null;
  let current = route;
  let screen = null;
  let destroyed = false;
  const el = h('div', { class: 'vv' });
  root.append(el);

  function key() {
    if (state.get('browser.ok') === false) return 'unsupported';
    const v = getVault();
    if (!v) return 'unavailable';
    return SCREENS[v.status] ? v.status : 'loading';
  }

  function render() {
    if (destroyed) return;
    const k = key();
    // On lock an item/album route goes back to #/vault (no history entry). A deep link that arrives while locked
    // stays: the item opens once the vault is unlocked.
    if (screen?.key === 'unlocked' && k !== 'unlocked' && current.parts.length) {
      router.navigate('#/vault', { replace: true });
    }
    if (screen && screen.key === k) {
      screen.update?.(current);
      return;
    }
    const prev = screen;
    screen = null;
    try {
      prev?.destroy();
    } catch (e) {
      globalThis.console?.error?.(e);
    }
    el.replaceChildren();
    el.dataset.screen = k;
    const made = SCREENS[k]({ vault: getVault(), route: current, host: el });
    screen = { key: k, ...made };
    el.append(made.el);
    if (prev && prev.key === 'unlocked') announce('Vault locked');
    made.focus?.();
  }

  const offs = [
    state.on('vault.status', () => render()),
    state.on('browser.ok', () => render()),
  ];
  render();

  return {
    update(r) {
      current = r;
      render();
    },
    unmount() {
      if (destroyed) return;
      destroyed = true;
      for (const off of offs.splice(0)) off();
      closeRecoverySheet();
      try {
        screen?.destroy();
      } catch (e) {
        globalThis.console?.error?.(e);
      }
      screen = null;
      el.remove();
    },
  };
}

// ───────── shared screen pieces

function emblem(id, tone) {
  return h('div', { class: ['vv-emblem', tone ? `vv-emblem-${tone}` : null], aria: { hidden: 'true' } }, icon(id));
}

function backButton(onClick, label = 'Back') {
  return h('button', { type: 'button', class: 'vv-back', on: { click: onClick } }, icon('back'), h('span', { text: label }));
}

/** A centred status page: emblem, blackletter title, optional micro line, lead text, body, actions. */
function statusPage({ id, tone, title, micro, lead, body, actions, className }) {
  return h('section', { class: ['vv-status', className] },
    emblem(id, tone),
    h('h1', { class: 'vv-title', text: title }),
    micro ? h('p', { class: 'vv-micro', text: micro }) : null,
    lead ? h('p', { class: 'vv-lead', text: lead }) : null,
    body ?? null,
    actions?.length ? h('div', { class: 'vv-status-actions' }, actions) : null);
}

function checkRow(label, onChange) {
  const input = h('input', { type: 'checkbox', on: { change: () => onChange?.() } });
  const el = h('label', { class: 'check vv-checkrow' }, input, h('span', { text: label }));
  return { el, input, get checked() {
    return input.checked;
  } };
}

function workingRow(text) {
  const label = h('span', { class: 'vv-working-text', text });
  const el = h('div', { class: 'vv-working', role: 'status', hidden: true },
    h('div', { class: 'progress vv-indet' }, h('div', { class: 'progress-fill' })), label);
  return {
    el,
    show(msg) {
      if (msg) label.textContent = msg;
      el.hidden = false;
    },
    hide() {
      el.hidden = true;
    },
  };
}

/** Hidden username field so password managers file the passphrase under "cZEROde vault" (§1.4). */
function usernameField() {
  return h('input', {
    type: 'text',
    class: 'visually-hidden',
    name: 'username',
    autocomplete: 'username',
    value: 'cZEROde vault',
    readOnly: true,
    tabIndex: -1,
    aria: { hidden: 'true' },
  });
}

/**
 * A new-passphrase block (create / recovery): passphrase with Generate, "type it again" (or "I saved it" when
 * generated), the no-reset acknowledgement, and the reason the submit button is disabled.
 */
function newPassphraseBlock({ purpose, label = 'Passphrase', ack = true, onChange }) {
  const pass = passphraseField({ label, mode: 'new', purpose, generateWords: 5, name: `czd-${purpose}-new`, onChange: () => changed() });
  const confirm = passphraseField({ label: 'Type it again', mode: 'enter', purpose, autocomplete: 'new-password', name: `czd-${purpose}-confirm`, onChange: () => changed() });
  // "I saved it" vouches for the words shown when it was ticked: new words (Generate again) untick it.
  let savedFor = null;
  const saved = checkRow('I saved it (password manager, paper or screenshot)', () => {
    savedFor = saved.checked ? pass.value : null;
    changed();
  });
  const ackRow = ack ? checkRow('If I forget this passphrase AND lose my recovery code, my files are gone.', () => changed()) : null;
  const reason = h('p', { class: 'hint vv-reason', aria: { live: 'polite' } });
  saved.el.hidden = true;
  function problem() {
    const v = pass.value;
    if (!v) return { text: 'Pick a passphrase — or tap Generate for five random words.', soft: true };
    const min = meetsVaultMinimum(v, { generated: pass.generated });
    if (!min.ok) {
      return { text: min.reason === 'too-short' ? 'Use at least 10 characters — or tap Generate.' : 'Too easy to guess. Add a few more words, or tap Generate.' };
    }
    if (pass.generated) {
      if (!saved.checked) return { text: 'Tick “I saved it” once the words are stored somewhere safe.', soft: true };
    } else if (!confirm.value) {
      return { text: 'Type it again to confirm.', soft: true };
    } else if (!samePass(confirm.value, v)) {
      return { text: "The two passphrases don't match." };
    }
    if (ackRow && !ackRow.checked) return { text: 'Tick the box to confirm there is no reset.', soft: true };
    return null;
  }
  function changed() {
    if (saved.checked && (!pass.generated || savedFor !== pass.value)) {
      saved.input.checked = false;
      savedFor = null;
    }
    confirm.el.hidden = pass.generated;
    saved.el.hidden = !pass.generated;
    const p = problem();
    reason.textContent = p?.text ?? 'Ready.';
    reason.classList.toggle('hint-warn', Boolean(p && !p.soft));
    reason.classList.toggle('vv-ready-ok', !p);
    onChange?.(!p);
  }
  changed();
  return {
    els: [pass.el, confirm.el, saved.el, ackRow?.el ?? null, reason],
    pass,
    confirm,
    get ok() {
      return !problem();
    },
    disable(b) {
      pass.setDisabled(b);
      confirm.setDisabled(b);
      saved.input.disabled = b;
      if (ackRow) ackRow.input.disabled = b;
      reason.hidden = b; // the progress row says what is going on
    },
    clear() {
      pass.clear();
      confirm.clear();
      saved.input.checked = false;
      savedFor = null;
      if (ackRow) ackRow.input.checked = false;
      changed();
    },
    focus: () => pass.focus(),
  };
}

// ───────── screens

const SCREENS = {
  loading: loadingScreen,
  unsupported: unsupportedScreen,
  unavailable: unavailableScreen,
  'other-tab': otherTabScreen,
  none: noneScreen,
  locked: lockedScreen,
  unlocked: unlockedScreen,
};

function loadingScreen() {
  const el = statusPage({ id: 'lock', title: 'Opening vault', micro: 'One moment…', className: 'vv-loading' });
  el.append(h('div', { class: 'progress vv-indet vv-loading-bar', aria: { hidden: 'true' } }, h('div', { class: 'progress-fill' })));
  return { el, destroy() {} };
}

function unsupportedScreen() {
  const el = statusPage({
    id: 'warning',
    tone: 'warn',
    title: 'This browser is too old for cZEROde 2',
    lead: 'Update your browser (Chrome, Edge, Firefox or Safari 16.4 and newer) or get the desktop app. Old cZEROde messages and files can still be decoded here.',
    actions: [h('a', { class: 'btn btn-primary', href: '#/legacy' }, icon('key'), h('span', { text: 'Open the Legacy decoders' }))],
  });
  return { el, destroy() {} };
}

function unavailableScreen({ vault }) {
  const retry = h('button', {
    type: 'button',
    class: 'btn btn-primary',
    on: {
      click: async () => {
        retry.disabled = true;
        try {
          await vault?.init();
          if (vault?.status === 'unavailable') toast('Still no luck. Try a normal (not private) window.', { kind: 'warn' });
        } catch (e) {
          report(e);
        } finally {
          retry.disabled = false;
        }
      },
    },
  }, icon('refresh'), h('span', { text: 'Try again' }));
  const el = statusPage({
    id: 'warning',
    tone: 'warn',
    title: "Can't reach your vault",
    lead: userMessage('store-unavailable'),
    body: h('p', { class: 'vv-note-text', text: 'Private windows and strict privacy settings can block the storage cZEROde needs. Try a normal window, or allow site data for this page. Send · Open and Text still work.' }),
    actions: vault ? [retry, h('a', { class: 'btn btn-ghost', href: '#/send', text: 'Go to Send · Open' })] : [h('a', { class: 'btn btn-ghost', href: '#/send', text: 'Go to Send · Open' })],
  });
  return { el, destroy() {} };
}

function otherTabScreen({ vault }) {
  const use = h('button', {
    type: 'button',
    class: 'btn btn-primary',
    on: {
      click: async () => {
        use.disabled = true;
        use.lastChild.textContent = 'Switching…';
        try {
          await vault.useHere();
        } catch (e) {
          report(e);
        } finally {
          if (use.isConnected) {
            use.disabled = false;
            use.lastChild.textContent = 'Use it here';
          }
        }
      },
    },
  }, icon('unlock'), h('span', { text: 'Use it here' }));
  const el = statusPage({
    id: 'lock',
    title: 'Open in another tab',
    lead: 'cZEROde is open in another tab. Only one tab can use the vault at a time — the other one locks when you switch.',
    body: h('p', { class: 'vv-micro', text: 'Send · Open, Text and Legacy keep working here' }),
    actions: [use],
  });
  return { el, destroy() {}, focus: () => (finePointer() ? use.focus() : null) };
}

// ───────── first run (status 'none')

function noneScreen({ vault }) {
  const ios = pwa.isIOS() && !pwa.isStandalone();
  load('settings');
  load('tutorial');
  const box = h('div', { class: 'vv-none' });
  let sub = null;
  let alive = true;

  function show(name, arg) {
    try {
      sub?.destroy?.();
    } catch (e) {
      globalThis.console?.error?.(e);
    }
    sub = SUB[name](arg);
    box.replaceChildren(sub.el);
    globalThis.scrollTo?.(0, 0);
    sub.focus?.();
  }

  function restore() {
    let p;
    try {
      p = tryCall('settings', 'openRestoreDialog');
    } catch (e) {
      report(e);
      return;
    }
    if (p === null) {
      toast('Restoring a backup is not available in this version yet.', { kind: 'warn' });
      return;
    }
    Promise.resolve(p).catch(report);
  }

  const SUB = {
    hero() {
      // Before a vault exists is when this matters most (§1.3): shown above the choices, not dismissible.
      const warnBox = h('div', { class: 'vv-hero-warn' });
      platform.storage.estimate().then((est) => limitedStorage(null, est)).then((limited) => {
        if (limited) warnBox.replaceChildren(banner({ kind: 'warn', text: PRIVATE_TEXT }));
      }, () => {});
      const legacyBox = h('div', { class: 'vv-hero-legacy' });
      const paintLegacy = () => {
        const found = state.get('legacy.found');
        legacyBox.replaceChildren(found ? h('a', { class: 'vv-legacy-link', href: '#/legacy' }, icon('info'), h('span', { text: 'Coming from cZEROde 1? Your old stuff is safe →' })) : '');
      };
      paintLegacy();
      const off = state.on('legacy.found', paintLegacy);
      const choice = ({ id, title, text, foot, onClick, primary, tag }) => h('button', {
        type: 'button',
        class: ['vv-choice', primary ? 'vv-choice-primary' : null],
        dataset: { choice: tag },
        on: { click: onClick },
      },
      h('span', { class: 'vv-choice-icon' }, icon(id)),
      h('span', { class: 'vv-choice-title', text: title }),
      h('span', { class: 'vv-choice-text', text }),
      h('span', { class: 'vv-choice-foot' }, h('span', { text: foot }), icon('back', { className: 'vv-arrow' })));
      const tour = h('button', {
        type: 'button',
        class: 'btn btn-ghost btn-sm vv-tour',
        on: {
          click: () => {
            const open = fn('tutorial', 'openTutorial');
            if (open) open();
            else load('tutorial').then((m) => m?.openTutorial?.());
          },
        },
      }, icon('info'), h('span', { text: 'Quick tour' }));
      const el = h('section', { class: 'vv-hero' },
        h('p', { class: 'vv-eyebrow', text: 'Private · offline · yours' }),
        h('h1', { class: 'vv-title vv-hero-title', text: 'Your stuff. Locked.' }),
        h('p', { class: 'vv-lead', text: 'Photos, videos, music and notes — encrypted right here on this device. No accounts, no servers, no cloud.' }),
        warnBox,
        h('div', { class: 'vv-choices' },
          choice({
            id: 'lock',
            tag: 'create',
            primary: true,
            title: 'Hide my photos & files',
            text: ios ? 'Install cZEROde first, then create your vault inside the app.' : 'Create an encrypted vault on this device.',
            foot: ios ? 'Install first' : 'Start here',
            onClick: () => show(ios ? 'gate' : 'create', 'create'),
          }),
          choice({
            id: 'download',
            tag: 'open',
            title: 'Open a file someone sent me',
            text: 'Got a .czd over WhatsApp, Discord or email? Unlock it here.',
            foot: 'Open a .czd',
            onClick: () => router.navigate('#/open'),
          }),
          choice({
            id: 'refresh',
            tag: 'restore',
            title: 'I have a backup (.czb)',
            text: ios ? 'Install cZEROde first, then restore inside the app.' : 'Bring your vault back from a backup file.',
            foot: 'Restore',
            onClick: () => (ios ? show('gate', 'restore') : restore()),
          })),
        h('div', { class: 'vv-hero-links' }, tour, legacyBox),
        h('p', { class: 'vv-trust' }, ['AES-256-GCM', 'Argon2id', 'Works offline', 'No accounts'].map((t) => h('span', { text: t }))));
      return { el, destroy: off };
    },

    gate(what) {
      const understood = checkRow('I understand: a vault in a Safari tab can be erased after 7 days without use.', () => {
        anyway.disabled = !understood.checked;
      });
      const anyway = h('button', {
        type: 'button',
        class: 'btn btn-ghost',
        disabled: true,
        text: what === 'restore' ? 'Restore it in Safari anyway' : 'Create it in Safari anyway',
        on: { click: () => (what === 'restore' ? restore() : show('create')) },
      });
      const step = (n, ...parts) => h('li', { class: 'vv-step' }, h('span', { class: 'vv-step-n', text: String(n) }), h('span', { class: 'vv-step-text' }, parts));
      const el = h('section', { class: 'vv-panel-page' },
        backButton(() => show('hero')),
        h('div', { class: 'vv-status vv-status-left' },
          emblem('download'),
          h('h1', { class: 'vv-title', text: 'Install cZEROde first' }),
          h('p', { class: 'vv-lead', text: 'Your vault lives inside the installed app. A vault made in a Safari tab can be erased after 7 days without use. Already have a vault here? Export a backup first and restore it in the installed app.' })),
        h('ol', { class: 'vv-steps' },
          step(1, 'Tap ', h('span', { class: 'vv-inline-icon' }, icon('share')), h('strong', { text: 'Share' }), ' in Safari’s toolbar.'),
          step(2, 'Choose ', h('strong', { text: 'Add to Home Screen' }), '.'),
          step(3, 'Open cZEROde from your Home Screen and ', what === 'restore' ? 'restore your backup there.' : 'create your vault there.')),
        h('div', { class: 'card vv-anyway' }, understood.el, anyway));
      return { el, destroy() {} };
    },

    create() {
      const working = workingRow('Creating your vault…');
      const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block vv-submit' }, icon('lock'), h('span', { text: 'Create vault' }));
      let busy = false;
      const block = newPassphraseBlock({ purpose: 'vault', onChange: (ok) => (submit.disabled = !ok || busy) });
      const form = h('form', { class: 'card vv-form', noValidate: true, on: { submit: (e) => onSubmit(e) } },
        usernameField(), ...block.els, submit, working.el);
      submit.disabled = !block.ok;
      const back = backButton(() => show('hero'));
      const el = h('section', { class: 'vv-panel-page' },
        back,
        h('div', { class: 'vv-form-head' },
          h('h1', { class: 'vv-title', text: 'Create your vault' }),
          h('p', { class: 'vv-lead', text: "Pick a passphrase. It's the only key — nobody, not even us, can reset it." })),
        form,
        h('p', { class: 'vv-fineprint', text: 'Unlocking takes a moment on purpose: that is what makes guessing slow. Next you get a recovery code, just in case.' }));

      async function make(pass, params) {
        return vault.create(pass, params ? { params, recovery: true } : { recovery: true });
      }

      async function onSubmit(e) {
        e.preventDefault();
        if (busy || !block.ok) return;
        const pass = block.pass.value;
        busy = true;
        submit.disabled = true;
        back.disabled = true; // a second create from the hero would race this one
        block.disable(true);
        working.show('Creating your vault…');
        let res = null;
        try {
          res = await make(pass);
        } catch (err) {
          if (err?.code === 'kdf-out-of-memory') {
            working.hide();
            const ok = await confirmDialog({
              title: 'Low memory: use lighter protection?',
              message: 'This device ran out of memory while protecting your passphrase. Lighter protection still works, but guessing your passphrase gets easier — so make it a long one.',
              confirmLabel: 'Use lighter protection',
            });
            if (ok) {
              working.show('Creating your vault (lighter protection)…');
              try {
                res = await make(pass, FLOOR);
              } catch (err2) {
                if (alive) fail(err2);
              }
            }
          } else if (alive) {
            fail(err);
          }
        }
        if (res) {
          block.clear();
          // Locked meanwhile (panic, another tab): the code is not shown on a locked screen; Settings makes a new one.
          if (vault.status === 'unlocked') showRecoveryCode(res.recoveryCode);
          else toast('Your vault is ready. Make a recovery code later in Settings → Vault.', { timeout: 8000 });
          return;
        }
        if (!alive) return;
        busy = false;
        back.disabled = false;
        block.disable(false);
        working.hide();
        submit.disabled = !block.ok;
      }

      function fail(err) {
        if (isCancel(err)) return;
        report(err);
      }

      return {
        el,
        destroy() {
          block.clear();
        },
        focus: () => (finePointer() ? block.focus() : null),
      };
    },
  };

  show('hero');
  return {
    el: box,
    destroy() {
      alive = false;
      sub?.destroy?.();
    },
  };
}

// ───────── locked

function lockedScreen({ vault }) {
  const box = h('div', { class: 'vv-locked' });
  let sub = null;
  let alive = true;

  function show(name) {
    try {
      sub?.destroy?.();
    } catch (e) {
      globalThis.console?.error?.(e);
    }
    sub = SUB[name]();
    box.replaceChildren(sub.el);
    sub.focus?.();
  }

  const SUB = {
    unlock() {
      const field = passphraseField({ label: 'Passphrase', mode: 'enter', purpose: 'unlock', name: 'czd-vault-unlock' });
      const working = workingRow('Unlocking…');
      const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block vv-submit' }, icon('unlock'), h('span', { text: 'Unlock' }));
      const micro = h('p', { class: 'vv-micro', text: 'Locked' });
      let busy = false;
      const forgot = h('button', { type: 'button', class: 'btn-link vv-forgot', text: 'Forgot it?', on: { click: () => show('forgot') } });
      const form = h('form', { class: 'card vv-form vv-unlock-form', noValidate: true, on: { submit: (e) => onSubmit(e) } },
        usernameField(), field.el, submit, working.el, forgot);
      const el = h('section', { class: 'vv-status vv-lockpage' },
        emblem('lock', 'acc'),
        h('h1', { class: 'vv-title', text: 'Vault locked' }),
        micro,
        form,
        h('p', { class: 'vv-fineprint', text: "Locking drops keys and clears the screen; JavaScript can't guarantee every secret is wiped from memory." }));
      vault.storage().then((s) => {
        if (!alive || !Number.isFinite(s?.count)) return;
        micro.textContent = s.count ? `Locked · ${plural(s.count, 'item')} · ${fmtSize(s.itemBytes ?? 0)}` : 'Locked · empty';
      }, () => {});

      async function onSubmit(e) {
        e.preventDefault();
        if (busy) return;
        const pass = field.value;
        if (!pass.trim()) {
          field.setError('Type your passphrase first.');
          return;
        }
        busy = true;
        submit.disabled = true;
        forgot.disabled = true;
        field.setDisabled(true);
        working.show('Unlocking…');
        try {
          await vault.unlock(pass, { confirmKdf });
          field.clear();
          return;
        } catch (err) {
          if (!alive) return;
          field.setDisabled(false);
          if (err?.code === 'wrong-passphrase') field.setError(userMessage(err));
          else if (!isCancel(err)) field.setError(userMessage(err));
        } finally {
          busy = false;
          if (alive) {
            submit.disabled = false;
            forgot.disabled = false;
            field.setDisabled(false);
            working.hide();
          }
        }
      }
      return {
        el,
        destroy: () => field.clear(),
        focus: () => (finePointer() ? field.focus() : null),
      };
    },

    forgot() {
      const option = ({ id, title, text, onClick, danger, disabled, tag }) => h('button', {
        type: 'button',
        class: ['vv-choice', 'vv-option', danger ? 'vv-choice-danger' : null],
        disabled: !!disabled,
        dataset: { choice: tag },
        on: { click: onClick },
      }, h('span', { class: 'vv-choice-icon' }, icon(id)), h('span', { class: 'vv-choice-title', text: title }), h('span', { class: 'vv-choice-text', text }));
      const el = h('section', { class: 'vv-panel-page' },
        backButton(() => show('unlock')),
        h('div', { class: 'vv-form-head' },
          h('h1', { class: 'vv-title', text: 'Forgot your passphrase?' }),
          h('p', { class: 'vv-lead', text: 'Nobody can reset it — not even us. You have two ways out:' })),
        h('div', { class: 'vv-options' },
          option({
            id: 'key',
            tag: 'recovery',
            title: 'Use recovery code',
            text: vault.hasRecovery ? 'Enter the code you saved when you created the vault, then pick a new passphrase.' : 'No recovery code was set up for this vault.',
            disabled: !vault.hasRecovery,
            onClick: () => show('recovery'),
          }),
          option({
            id: 'trash',
            tag: 'delete',
            danger: true,
            title: 'Delete vault and start over',
            text: 'Erases every file and note of this vault on this device. Backups (.czb) you exported keep working.',
            onClick: () => destroyVault(),
          })));
      async function destroyVault() {
        const ok = await confirmDialog({
          title: 'Delete this vault?',
          message: 'Everything in it is erased from this device. This cannot be undone.',
          confirmLabel: 'Delete vault',
          danger: true,
          typed: 'DELETE',
        });
        if (!ok) return;
        try {
          await vault.destroy();
          toast('Vault deleted. Fresh start.', { kind: 'ok' });
        } catch (e) {
          report(e);
        }
      }
      return { el, destroy() {} };
    },

    recovery() {
      const code = passphraseField({ label: 'Recovery code', mode: 'enter', purpose: 'unlock', autocomplete: 'off', name: 'czd-recovery-code', placeholder: 'XXXX-XXXX-…' });
      const working = workingRow('Unlocking…');
      const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block vv-submit' }, icon('unlock'), h('span', { text: 'Unlock & set new passphrase' }));
      let busy = false;
      const block = newPassphraseBlock({ purpose: 'change', label: 'New passphrase', ack: false, onChange: (ok) => (submit.disabled = !ok || busy) });
      submit.disabled = !block.ok;
      const form = h('form', { class: 'card vv-form', noValidate: true, on: { submit: (e) => onSubmit(e) } },
        usernameField(), code.el, h('hr', { class: 'divider vv-form-div' }), ...block.els, submit, working.el);
      const back = backButton(() => show('forgot'));
      const el = h('section', { class: 'vv-panel-page' },
        back,
        h('div', { class: 'vv-form-head' },
          h('h1', { class: 'vv-title', text: 'Use your recovery code' }),
          h('p', { class: 'vv-lead', text: 'The code opens your vault and sets a new passphrase. The code itself keeps working.' })),
        form);
      async function onSubmit(e) {
        e.preventDefault();
        if (busy || !block.ok) return;
        if (!code.value.trim()) {
          code.setError('Type your recovery code.');
          return;
        }
        busy = true;
        submit.disabled = true;
        back.disabled = true;
        block.disable(true);
        code.setDisabled(true);
        working.show('Unlocking…');
        try {
          await vault.unlockWithRecovery(code.value, block.pass.value);
          code.clear();
          block.clear();
          toast('Unlocked — your new passphrase is set.', { kind: 'ok' });
          return;
        } catch (err) {
          if (!alive) return;
          code.setDisabled(false);
          if (err?.code === 'recovery-wrong') code.setError(userMessage(err));
          else if (!isCancel(err)) report(err);
        } finally {
          busy = false;
          if (alive) {
            back.disabled = false;
            working.hide();
            block.disable(false);
            code.setDisabled(false);
            submit.disabled = !block.ok;
          }
        }
      }
      return {
        el,
        destroy() {
          code.clear();
          block.clear();
        },
        focus: () => (finePointer() ? code.focus() : null),
      };
    },
  };

  show('unlock');
  return {
    el: box,
    destroy() {
      alive = false;
      sub?.destroy?.();
    },
    focus: () => sub?.focus?.(),
  };
}

// ───────── unlocked

function unlockedScreen({ vault: v, route, host }) {
  const del = deletes(v);
  del.resume();
  load('upload');
  load('albums');
  load('settings');
  const spec = { kind: memory.kind, query: '', sort: settings.get('vaultSort'), view: settings.get('vaultView'), albumId: null };
  const offs = [];
  let alive = true;
  /** {id, scope, handle, keys} while the viewer shows an item of this view (keys: the list it was last given). */
  let viewer = null;
  /** The current item route was pushed by this view (closing goes Back instead of replacing). */
  let fromGrid = false;
  let gridHash = '#/vault';
  /** Notes whose save is running (they come back under a new id; the viewer follows them itself). */
  const noteSaving = new Set();
  /** A note made by "New note" that has not been saved yet: removed again when the viewer closes. */
  let fresh = null;
  let stripMode = null;

  // ── head
  const sub = h('p', { class: 'vv-sub' });
  const backupChip = h('button', { type: 'button', class: 'chip vv-backup-chip', hidden: true, on: { click: () => backupNow() } }, icon('warning'), h('span'));
  // Lock: the shell header's lock button is on screen whenever the vault is unlocked (no second one here).
  const head = h('header', { class: 'vv-head' },
    h('div', { class: 'vv-head-main' }, h('h1', { class: 'vv-title', text: 'Vault' }), sub),
    h('div', { class: 'vv-head-side' }, backupChip));
  const albumHead = h('header', { class: 'vv-head vv-album-head', hidden: true });

  // ── banners, album strip
  const banners = h('div', { class: 'vv-banners' });
  const strip = h('div', { class: 'vv-strip' });

  // ── toolbar
  const addBtn = h('button', { type: 'button', class: 'btn btn-primary vv-add', on: { click: () => addFiles({ folder: false }) } }, icon('upload'), h('span', { text: 'Add files' }));
  const folderBtn = h('button', { type: 'button', class: 'btn vv-tool', hidden: !canPickFolder(), title: 'Add a folder', aria: { label: 'Add a folder' }, on: { click: () => addFiles({ folder: true }) } }, icon('folder'), h('span', { class: 'vv-tool-label', text: 'Folder' }));
  const noteBtn = h('button', { type: 'button', class: 'btn vv-tool', title: 'New note', aria: { label: 'New note' }, on: { click: () => newNote() } }, icon('note'), h('span', { class: 'vv-tool-label', text: 'New note' }));
  const albumBtn = h('button', { type: 'button', class: 'btn vv-tool', title: 'New album', aria: { label: 'New album' }, on: { click: () => newAlbum() } }, icon('album'), h('span', { class: 'vv-tool-label', text: 'New album' }));
  let searchTimer = null;
  const search = h('input', {
    type: 'search',
    class: 'input vv-search-input',
    placeholder: 'Search',
    autocomplete: 'off',
    spellcheck: false,
    aria: { label: 'Search your vault' },
    on: {
      input: () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          spec.query = search.value;
          refresh();
        }, 120);
      },
      keydown: (e) => {
        if (e.key === 'Escape' && search.value) {
          e.preventDefault();
          e.stopPropagation();
          search.value = '';
          spec.query = '';
          refresh();
        }
      },
    },
  });
  const searchBox = h('label', { class: 'vv-search' }, icon('search'), search);
  const toolbar = h('div', { class: 'vv-toolbar' },
    h('div', { class: 'vv-actions' }, addBtn, folderBtn, noteBtn, albumBtn),
    searchBox);

  // ── filters
  const chips = FILTERS.map((f) => h('button', {
    type: 'button',
    class: ['chip', 'vv-chip', f.value === 'fav' ? 'vv-chip-fav' : null],
    dataset: { kind: f.value },
    aria: { pressed: 'false', label: f.aria },
    title: f.aria,
    on: { click: () => setKind(f.value) },
  }, h('span', { class: 'vv-chip-label', text: f.label }), h('span', { class: 'vv-chip-n' })));
  const playAll = h('button', { type: 'button', class: 'btn btn-sm vv-playall', hidden: true, on: { click: () => playVisible() } }, icon('play'), h('span', { text: 'Play all' }));
  const sortSel = h('select', {
    class: 'input select vv-sort',
    aria: { label: 'Sort by' },
    on: {
      change: () => {
        spec.sort = sortSel.value;
        try {
          settings.set('vaultSort', spec.sort);
        } catch {
          // invalid: ignore
        }
        refresh();
      },
    },
  }, SORTS.map((o) => h('option', { value: o.value, text: o.label })));
  sortSel.value = spec.sort;
  const viewBtn = (mode, id, label) => h('button', {
    type: 'button',
    class: 'btn-icon vv-viewbtn',
    dataset: { view: mode },
    aria: { label, pressed: String(spec.view === mode) },
    title: label,
    on: { click: () => setView(mode) },
  }, icon(id));
  const viewBtns = [viewBtn('grid', 'grid', 'Grid'), viewBtn('list', 'list', 'List')];
  const selectBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost vv-selectbtn', on: { click: () => setSelecting(true) } }, icon('check'), h('span', { text: 'Select' }));
  const filters = h('div', { class: 'vv-filters' },
    h('div', { class: 'vv-chips', role: 'group', aria: { label: 'Show' } }, chips),
    h('div', { class: 'vv-filter-side' }, playAll, h('label', { class: 'vv-sortwrap' }, h('span', { class: 'visually-hidden', text: 'Sort by' }), sortSel),
      h('div', { class: 'vv-viewtoggle', role: 'group', aria: { label: 'Layout' } }, viewBtns), selectBtn));

  // ── selection bar
  const selCount = h('span', { class: 'vv-selcount', aria: { live: 'polite' } });
  const selBtn = (id, label, onClick, cls) => h('button', { type: 'button', class: ['btn', 'btn-sm', 'vv-selact', cls], title: label, aria: { label }, on: { click: onClick } }, icon(id), h('span', { class: 'vv-selact-label', text: label }));
  const selAll = h('button', { type: 'button', class: 'btn-link vv-selall', text: 'Select all', on: { click: () => g.select(g.items().map((i) => i.id)) } });
  const selActs = [
    selBtn('star', 'Favorite', () => toggleFav(g.selected())),
    selBtn('album', 'Album', () => addToAlbum(g.selected())),
    selBtn('download', 'Save', () => saveItems(g.selected())),
    selBtn('send', 'Send', () => sendItems(g.selected())),
    selBtn('trash', 'Delete', () => {
      deleteItems(g.selected());
      setSelecting(false);
    }, 'btn-danger'),
  ];
  const selBar = h('div', { class: 'vv-selbar', hidden: true, role: 'toolbar', aria: { label: 'Selected items' } },
    h('button', { type: 'button', class: 'btn-icon vv-selclose', aria: { label: 'Cancel selection' }, title: 'Cancel (Esc)', on: { click: () => setSelecting(false) } }, icon('close')),
    h('div', { class: 'vv-selinfo' }, selCount, selAll),
    h('div', { class: 'vv-selacts' }, selActs));

  // ── grid + storage
  const g = makeGrid({
    vault: v,
    filter: () => spec,
    onOpen: (id) => openFromGrid(id),
    onSelect: () => paintSelection(),
    menuItems,
    isHidden: del.isHidden,
    renderEmpty,
  });
  const storageBox = h('div', { class: 'vv-storage' });

  const el = h('section', { class: 'vv-unlocked' }, head, albumHead, banners, strip, toolbar, filters, selBar, g.el, storageBox);

  // ───────── state painting

  function safeItem(id) {
    try {
      return v.item(id);
    } catch {
      return null;
    }
  }

  function allItems() {
    try {
      return v.items().filter((i) => !del.isHidden(i.id));
    } catch {
      return [];
    }
  }

  function albumItems() {
    if (!spec.albumId) return null;
    try {
      const l = v.list(spec.albumId);
      const map = new Map(allItems().map((i) => [i.id, i]));
      return { list: l, items: l.itemIds.map((id) => map.get(id)).filter(Boolean) };
    } catch {
      return null;
    }
  }

  let queued = false;
  /** A card to focus after the next paint (restored by Undo). */
  let restoredFocus = null;
  function refresh() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (alive && v.status === 'unlocked') paint();
    });
  }

  function paint() {
    const all = allItems();
    const album = albumItems();
    if (spec.albumId && !album) {
      spec.albumId = null;
      router.navigate('#/vault', { replace: true });
    }
    g.update();
    // Nothing to search or filter yet: a calmer first screen.
    const bare = all.length === 0 && !spec.albumId && !spec.query;
    filters.hidden = bare;
    searchBox.hidden = bare;
    const total = all.reduce((n, i) => n + (i.size || 0), 0);
    sub.textContent = all.length ? `${plural(all.length, 'item')} · ${fmtSize(total)} · encrypted` : 'Empty · encrypted on this device';
    const base = album ? album.items : all;
    search.placeholder = album ? 'Search this album' : all.length ? `Search ${plural(all.length, 'item')}` : 'Search';
    for (const c of chips) {
      const k = c.dataset.kind;
      const n = base.filter((i) => matchesKind(i, k)).length;
      c.setAttribute('aria-pressed', String(spec.kind === k));
      c.querySelector('.vv-chip-n').textContent = n ? String(n) : '';
      if (k === 'fav') c.setAttribute('aria-label', n ? `Favorites, ${n}` : 'Favorites');
      c.classList.toggle('is-zero', n === 0 && k !== 'all');
    }
    const media = g.items().filter((i) => i.kind === 'audio');
    playAll.hidden = Boolean(spec.albumId) || spec.kind !== 'audio' || media.length === 0;
    sortSel.disabled = Boolean(spec.albumId);
    sortSel.closest('.vv-sortwrap').hidden = Boolean(spec.albumId);
    for (const b of viewBtns) b.setAttribute('aria-pressed', String(spec.view === b.dataset.view));
    paintAlbumHead(album);
    paintSelection();
    paintBackupChip(all);
    if (stripMode === 'fallback') paintFallbackStrip();
    if (viewer) syncViewer();
    if (restoredFocus) {
      const id = restoredFocus;
      restoredFocus = null;
      const d = globalThis.document;
      const a = d?.activeElement;
      if (!viewer && (!a || a === d.body || a.closest?.('.toast'))) g.focusItem(id);
    }
    scheduleStorage();
  }

  let albumSig = '';
  function paintAlbumHead(album) {
    if (!album) {
      albumHead.hidden = true;
      head.hidden = false;
      el.classList.remove('is-album');
      albumSig = '';
      return;
    }
    head.hidden = true;
    albumHead.hidden = false;
    el.classList.add('is-album');
    const { list, items } = album;
    const playable = items.filter((i) => i.kind === 'audio' || i.kind === 'video');
    const size = items.reduce((n, i) => n + (i.size || 0), 0);
    const sig = [list.id, list.name, items.length, size, playable.length].join('|');
    if (sig === albumSig) return; // unchanged: keep focus on its buttons
    albumSig = sig;
    albumHead.replaceChildren(
      h('div', { class: 'vv-head-main' },
        h('a', { class: 'vv-back', href: '#/vault' }, icon('back'), h('span', { text: 'All items' })),
        h('p', { class: 'vv-eyebrow', text: 'Album' }),
        h('h1', { class: 'vv-title', text: labelText(list.name) || 'Album' }),
        h('p', { class: 'vv-sub', text: items.length ? `${plural(items.length, 'item')} · ${fmtSize(size)}` : 'Empty' })),
      h('div', { class: 'vv-head-side vv-album-actions' },
        playable.length ? h('button', { type: 'button', class: 'btn btn-primary btn-sm vv-album-play', on: { click: () => playAlbumItems(list.id, playable, list.name) } }, icon('play'), h('span', { text: 'Play' })) : null,
        h('button', { type: 'button', class: 'btn btn-sm vv-album-edit', on: { click: () => editAlbum(list.id) } }, icon('settings'), h('span', { text: 'Edit' })),
        h('button', { type: 'button', class: 'btn btn-sm btn-danger vv-album-delete', on: { click: () => deleteAlbum(list.id) } }, icon('trash'), h('span', { text: 'Delete album' }))));
  }

  function paintSelection() {
    const on = g.selecting;
    el.classList.toggle('is-selecting', on);
    selBar.hidden = !on;
    selectBtn.hidden = on || g.items().length === 0;
    const n = g.selected().length;
    selCount.textContent = n ? `${n} selected` : 'Tap items to select';
    for (const b of selActs) b.disabled = n === 0;
    selAll.hidden = n === g.items().length;
  }

  function setSelecting(on) {
    const inBar = selBar.contains(globalThis.document?.activeElement);
    g.setSelecting(on);
    paintSelection();
    if (on) selBar.querySelector('.vv-selclose')?.focus({ preventScroll: true });
    else if (inBar) selectBtn.focus({ preventScroll: true });
  }

  function setKind(kind) {
    spec.kind = kind;
    memory.kind = kind;
    refresh();
  }

  function setView(mode) {
    spec.view = mode;
    try {
      settings.set('vaultView', mode);
    } catch {
      // ignore
    }
    refresh();
  }

  function renderEmpty(s, total) {
    if (s.albumId) {
      const album = albumItems();
      if (!album?.items.length) {
        return emptyState({ icon: 'album', title: 'This album is empty', text: 'Add items to it from their ⋯ menu → Add to album, or drop files here.' });
      }
    }
    if (searchKey(s.query)) {
      const q = searchKey(s.query);
      return emptyState({ icon: 'search', title: 'Nothing found', text: `No names match “${q.length > 60 ? `${q.slice(0, 59)}…` : q}”.` });
    }
    if (!s.albumId && total === 0) {
      return emptyState({
        icon: 'lock',
        title: 'Your vault is empty',
        text: 'Add photos, videos, music or documents. They are encrypted on this device before they are stored — you can also drop files anywhere here.',
        action: { label: 'Add files', icon: 'upload', onClick: () => addFiles({ folder: false }) },
      });
    }
    const KIND_EMPTY = {
      fav: { icon: 'star', title: 'No favorites yet', text: 'Tap ★ on anything you want to find quickly.' },
      image: { icon: 'image', title: 'No photos yet', text: 'Photos you add show up here.' },
      video: { icon: 'video', title: 'No videos yet', text: 'Videos you add show up here.' },
      audio: { icon: 'music', title: 'No music yet', text: 'Songs and recordings you add show up here.' },
      doc: { icon: 'file', title: 'No documents yet', text: 'PDFs, text files and everything else land here.' },
      note: { icon: 'note', title: 'No notes yet', text: 'Notes are encrypted like everything else.', action: { label: 'New note', icon: 'note', onClick: () => newNote() } },
    };
    const e = KIND_EMPTY[s.kind] ?? { icon: 'file', title: 'Nothing here', text: 'Try another filter.' };
    if (s.albumId) e.title = `${e.title.replace(/ yet$/, '')} in this album`;
    return emptyState(e);
  }

  // ───────── banners, backup chip, storage

  let bannerSeq = 0;
  async function paintBanners() {
    const seq = ++bannerSeq;
    const [persisted, est] = await Promise.all([platform.storage.persisted(), platform.storage.estimate()]);
    if (!alive || seq !== bannerSeq) return;
    const list = [];
    const legacy = state.get('legacy.found');
    if (legacy && state.get('legacy.importDone') !== true) {
      const sig = `${legacy.notes | 0}/${legacy.files | 0}/${legacy.playlists | 0}`;
      if (dismissed('legacy') !== sig) {
        list.push(banner({
          kind: 'info',
          text: 'Coming from cZEROde 1? Your old notes and files are safe — bring them into this vault.',
          actions: [{ label: 'Open Legacy', onClick: () => router.navigate('#/legacy') }],
          onDismiss: () => dismiss('legacy', sig),
        }));
      }
    }
    if (persisted !== true && !platform.isTauri && !pwa.isStandalone() && Date.now() - (Number(dismissed('persist')) || 0) > PERSIST_SNOOZE) {
      const actions = [];
      if (state.get('install.prompt') || pwa.isIOS()) actions.push({ label: 'Install app', onClick: () => install() });
      actions.push({ label: 'Keep my data', kind: 'primary', onClick: () => keepData() });
      actions.push({ label: 'Back up now', onClick: () => backupNow() });
      list.push(banner({
        kind: 'warn',
        text: h('span', null, h('strong', { text: 'Not protected from cleanup. ' }), 'Your browser may clear the vault when space runs low. Install the app or keep a backup.'),
        actions,
        onDismiss: () => dismiss('persist', Date.now()),
      }));
    }
    // OPFS exists but its probe failed (e.g. a Firefox private window), or little quota: likely a throwaway store.
    const limited = await limitedStorage(v, est);
    if (!alive || seq !== bannerSeq) return;
    if (limited && dismissed('private') !== true) {
      list.push(banner({ kind: 'warn', text: PRIVATE_TEXT, onDismiss: () => dismiss('private', true) }));
    }
    for (const b of list) b.classList.add('vv-banner');
    banners.replaceChildren(...list);
  }

  let persisting = false;
  async function keepData() {
    if (persisting) return;
    persisting = true;
    let ok = null;
    try {
      ok = await platform.storage.persist();
    } finally {
      persisting = false;
    }
    if (!alive) return;
    if (ok === true) toast("Protected — the browser won't clear your vault on its own.", { kind: 'ok' });
    else toast("The browser didn't allow it. Install the app or back up regularly.", { kind: 'warn', timeout: 6000 });
    paintBanners();
    scheduleStorage(0);
  }

  async function install() {
    if (state.get('install.prompt')) {
      const ok = await pwa.promptInstall();
      if (ok) toast('Installed. Open cZEROde from your apps.', { kind: 'ok' });
      paintBanners();
      return;
    }
    modal({
      title: 'Install cZEROde',
      body: h('ol', { class: 'vv-steps vv-steps-compact' },
        h('li', { class: 'vv-step' }, h('span', { class: 'vv-step-n', text: '1' }), h('span', { class: 'vv-step-text' }, 'Tap ', h('strong', { text: 'Share' }), ' in Safari’s toolbar.')),
        h('li', { class: 'vv-step' }, h('span', { class: 'vv-step-n', text: '2' }), h('span', { class: 'vv-step-text' }, 'Choose ', h('strong', { text: 'Add to Home Screen' }), '.')),
        h('li', { class: 'vv-step' }, h('span', { class: 'vv-step-n', text: '3' }), h('span', { class: 'vv-step-text', text: 'Export a backup here, then restore it in the installed app.' }))),
      actions: [{ label: 'Got it', kind: 'primary', value: true }],
    });
  }

  function backupNow() {
    let p;
    try {
      p = tryCall('settings', 'openBackupExport');
    } catch (e) {
      report(e);
      return;
    }
    if (p === null) {
      toast('Backups live in Settings → Vault.', { kind: 'info' });
      router.navigate('#/settings');
      return;
    }
    Promise.resolve(p).then(() => paintBackupChip(allItems()), report);
  }

  function paintBackupChip(all) {
    if (!all.length) {
      backupChip.hidden = true;
      return;
    }
    const last = Number.isFinite(v.lastBackupAt) ? v.lastBackupAt : null;
    const oldest = all.reduce((m, i) => Math.min(m, i.addedAt || Date.now()), Date.now());
    const days = Math.floor((Date.now() - (last ?? oldest)) / DAY);
    backupChip.hidden = days < BACKUP_NAG_DAYS;
    backupChip.lastChild.textContent = last ? `Last backup ${plural(days, 'day')} ago` : 'Not backed up yet';
    backupChip.title = 'Export a backup (.czb)';
  }

  let storageTimer = null;
  /** Throttled, not debounced: a long import repaints all the time, and the bar must still move along. */
  function scheduleStorage(ms = 400) {
    if (storageTimer !== null && ms > 0) return; // a refresh is already on its way
    clearTimeout(storageTimer);
    storageTimer = setTimeout(async () => {
      storageTimer = null;
      let info = null;
      try {
        info = await v.storage();
      } catch {
        info = null;
      }
      if (!alive || !info) return;
      const shown = platform.isTauri ? { count: info.count, itemBytes: info.itemBytes } : info;
      storageBox.replaceChildren(storageBar(shown));
    }, ms);
  }

  // ───────── album strip

  function mountStrip() {
    if (!alive) return;
    let s = null;
    try {
      s = tryCall('albums', 'albumStrip', { vault: v, onOpen: (id) => openAlbum(id) });
    } catch (e) {
      globalThis.console?.warn?.('[vault] album strip failed', e);
      s = null;
    }
    if (s && typeof s === 'object' && typeof s.nodeType === 'number') {
      stripMode = 'module';
      strip.replaceChildren(s);
      return;
    }
    stripMode = 'fallback';
    paintFallbackStrip();
  }

  function paintFallbackStrip() {
    let lists = [];
    try {
      lists = v.lists();
    } catch {
      lists = [];
    }
    if (!lists.length) {
      strip.replaceChildren();
      return;
    }
    strip.replaceChildren(h('div', { class: 'vv-albums', role: 'list', aria: { label: 'Albums' } },
      lists.map((l) => h('a', {
        class: ['vv-album-chip', spec.albumId === l.id ? 'active' : null],
        role: 'listitem',
        href: router.hrefFor('vault', 'album', l.id),
        aria: { current: spec.albumId === l.id ? 'page' : undefined },
      }, icon('album'), h('span', { class: 'vv-album-name', text: labelText(l.name) || 'Album' }), h('span', { class: 'vv-album-n', text: String(l.itemIds.filter((id) => !del.isHidden(id)).length) }))),
      h('button', { type: 'button', class: 'vv-album-chip vv-album-new', aria: { label: 'New album' }, on: { click: () => newAlbum() } }, icon('plus'))));
  }

  // ───────── adding

  function addFiles({ folder }) {
    const album = spec.albumId ?? undefined;
    const pick = fn('upload', 'pickAndImport');
    if (pick) {
      let p;
      try {
        p = pick({ vault: v, folder, album });
      } catch (e) {
        p = Promise.reject(e);
      }
      Promise.resolve(p).catch((e) => {
        if (e?.code === 'not-implemented') fallbackPick(folder, album);
        else report(e);
      });
      return;
    }
    fallbackPick(folder, album);
  }

  async function fallbackPick(folder, album) {
    const files = await platform.pickFiles({ multiple: true, folder });
    if (files.length) fallbackImport(files, album);
  }

  function importFiles(files, folders) {
    const album = spec.albumId ?? undefined;
    const f = fn('upload', 'importFiles');
    const loose = files ?? [];
    const dirs = folders ?? [];
    if (f) {
      let p;
      try {
        p = f({ vault: v, files: loose, folders: dirs, album });
      } catch (e) {
        p = Promise.reject(e);
      }
      Promise.resolve(p).catch((e) => {
        if (e?.code === 'not-implemented') fallbackImport([...loose, ...dirs.flatMap((d) => d.files)], album);
        else report(e);
      });
      return;
    }
    fallbackImport([...loose, ...dirs.flatMap((d) => d.files)], album);
  }

  /** Minimal importer used only while ui/upload.js is unavailable: sequential, special files skipped. */
  async function fallbackImport(files, album) {
    const t = toast(`Encrypting ${plural(files.length, 'file')}…`, { timeout: 0 });
    const msg = t.el.querySelector('.toast-msg');
    let added = 0;
    let skipped = 0;
    for (let i = 0; i < files.length; i++) {
      if (v.status !== 'unlocked') break;
      if (msg) msg.textContent = `Encrypting ${i + 1} of ${files.length}…`;
      const file = files[i];
      try {
        if (await isSpecial(file)) {
          skipped++;
          continue;
        }
        await v.addFile(file, { album });
        added++;
      } catch (e) {
        if (isCancel(e) || e?.code === 'interrupted') break;
        report(e);
      }
    }
    t.close();
    if (added) toast(`Added ${plural(added, 'item')}`, { kind: 'ok' });
    if (skipped) toast(`Skipped ${plural(skipped, 'locked cZEROde file')} — open them from Send · Open.`, { kind: 'warn', timeout: 6000 });
  }

  async function isSpecial(file) {
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    const is = (m) => head.length === 8 && m.every((b, k) => head[k] === b);
    return is(CZD2_MAGIC) || is(CZB_MAGIC);
  }

  // ───────── notes and albums

  let noteBusy = false;
  async function newNote() {
    if (noteBusy) return; // a double click makes one note
    noteBusy = true;
    try {
      const info = await v.addNote({ title: '', body: '' });
      if (!alive) return;
      cleanupFresh();
      fresh = { id: info.id, saved: false };
      // Made inside an album: it belongs there (saving the note keeps the membership).
      if (spec.albumId) {
        try {
          const l = v.list(spec.albumId);
          await v.updateList(spec.albumId, { itemIds: [...l.itemIds, info.id] });
        } catch (e) {
          report(e);
        }
        if (!alive) return;
      }
      fromGrid = true;
      router.navigate(router.hrefFor('vault', 'item', info.id));
      focusNoteTitle();
    } catch (e) {
      if (alive) report(e); // locked meanwhile: nothing to say
    } finally {
      noteBusy = false;
    }
  }

  function focusNoteTitle() {
    const t0 = Date.now();
    const tick = () => {
      const input = globalThis.document?.querySelector('.vw-root .vw-note-title');
      if (input) {
        // A blank note: say what goes where (the editor itself is the viewer's).
        if (!input.placeholder) input.placeholder = 'Title';
        const body = globalThis.document.querySelector('.vw-root .vw-note-body');
        if (body && !body.placeholder) body.placeholder = 'Write something… it is encrypted when you save.';
        input.focus();
        return;
      }
      if (Date.now() - t0 < 3000 && alive) globalThis.requestAnimationFrame?.(tick);
    };
    globalThis.requestAnimationFrame?.(tick);
  }

  function cleanupFresh() {
    const f = fresh;
    if (!f) return;
    fresh = null;
    if (f.saved) return;
    try {
      v.remove([f.id]).catch(() => {});
    } catch {
      // locked: an empty note stays behind
    }
  }

  async function newAlbum(itemIds = []) {
    let viaModule = null;
    try {
      viaModule = tryCall('albums', 'createAlbumDialog', { vault: v, itemIds });
    } catch (e) {
      report(e);
      return null;
    }
    if (viaModule !== null) {
      try {
        const l = await viaModule;
        if (l?.id && !itemIds.length && alive) openAlbum(l.id);
        return l ?? null;
      } catch (e) {
        if (!e?.missing) {
          report(e);
          return null;
        }
      }
    }
    const name = await promptDialog({ title: 'New album', label: 'Album name', placeholder: 'e.g. Summer 2026' });
    if (name === null) return null;
    try {
      const l = await v.createList({ name: name.trim() || 'Album', itemIds });
      if (alive) toast(`Album “${shortName(labelText(l.name) || 'Album', 42, true)}” created`, { kind: 'ok' });
      if (!itemIds.length && alive) openAlbum(l.id);
      return l;
    } catch (e) {
      report(e);
      return null;
    }
  }

  function openAlbum(id) {
    router.navigate(router.hrefFor('vault', 'album', id));
  }

  function editAlbum(id) {
    let r;
    try {
      r = tryCall('albums', 'albumEditor', { vault: v, id });
    } catch (e) {
      report(e);
      return;
    }
    if (r !== null && r !== undefined) {
      if (typeof r.then === 'function') r.then(undefined, (e) => (e?.missing ? renameAlbum(id) : report(e)));
      return;
    }
    renameAlbum(id);
  }

  async function renameAlbum(id) {
    let l;
    try {
      l = v.list(id);
    } catch {
      return;
    }
    const name = await promptDialog({ title: 'Rename album', label: 'Album name', value: l.name });
    if (name === null || !name.trim() || name.trim() === l.name) return;
    try {
      await v.updateList(id, { name: name.trim() });
    } catch (e) {
      report(e);
    }
  }

  async function deleteAlbum(id) {
    let viaModule = null;
    try {
      viaModule = tryCall('albums', 'deleteAlbumDialog', { vault: v, id });
    } catch (e) {
      report(e);
      return;
    }
    if (viaModule !== null) {
      try {
        await viaModule;
        return;
      } catch (e) {
        if (!e?.missing) {
          report(e);
          return;
        }
      }
    }
    let l;
    try {
      l = v.list(id);
    } catch {
      return;
    }
    const ok = await confirmDialog({
      title: 'Delete album?',
      message: `“${shortName(labelText(l.name) || 'Album', 42, true)}” is removed. The items in it stay in your vault.`,
      confirmLabel: 'Delete album',
      danger: true,
    });
    if (!ok) return;
    try {
      await v.removeList(id);
      router.navigate('#/vault', { replace: true });
      toast('Album deleted', { kind: 'ok' });
    } catch (e) {
      report(e);
    }
  }

  async function addToAlbum(ids) {
    if (!ids.length) return;
    let r;
    try {
      r = tryCall('albums', 'addToAlbumDialog', { vault: v, itemIds: ids });
    } catch (e) {
      report(e);
      return;
    }
    if (r !== null) {
      try {
        await r;
        if (g.selecting) setSelecting(false);
        return;
      } catch (e) {
        if (!e?.missing) {
          report(e);
          return;
        }
      }
    }
    await albumPicker(ids);
  }

  /** Fallback album picker (ui/albums.js unavailable). */
  async function albumPicker(ids) {
    let lists = [];
    try {
      lists = v.lists();
    } catch {
      return;
    }
    const input = h('input', { class: 'input', id: 'vv-newalbum', placeholder: 'New album name', autocomplete: 'off' });
    const body = h('div', { class: 'stack' },
      lists.length ? h('div', { class: 'vv-albumpick' }, lists.map((l) => h('button', {
        type: 'button',
        class: 'vv-albumpick-item',
        on: { click: () => p.close(l.id) },
      }, icon('album'), h('span', { class: 'vv-album-name', text: labelText(l.name) || 'Album' }), h('span', { class: 'vv-album-n', text: String(l.itemIds.length) })))) : null,
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'vv-newalbum', text: lists.length ? 'Or a new album' : 'New album' }), input));
    const p = modal({ title: ids.length === 1 ? 'Add to album' : `Add ${ids.length} items to album`, body, actions: [{ label: 'Cancel', kind: 'ghost', value: null }, { label: 'Create & add', kind: 'primary', value: '__new__' }] });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) p.close('__new__');
    });
    const r = await p;
    try {
      if (r === '__new__') {
        const l = await v.createList({ name: input.value.trim() || 'Album', itemIds: ids });
        if (alive) toast(`Added to “${shortName(labelText(l.name) || 'Album', 42, true)}”`, { kind: 'ok' });
      } else if (r) {
        const l = v.list(r);
        await v.updateList(r, { itemIds: [...l.itemIds, ...ids] });
        if (alive) toast(`Added to “${shortName(labelText(l.name) || 'Album', 42, true)}”`, { kind: 'ok' });
      } else {
        return;
      }
      if (g.selecting) setSelecting(false);
    } catch (e) {
      report(e);
    }
  }

  async function removeFromAlbum(ids) {
    if (!spec.albumId) return;
    try {
      const l = v.list(spec.albumId);
      const drop = new Set(ids);
      await v.updateList(spec.albumId, { itemIds: l.itemIds.filter((x) => !drop.has(x)) });
      toast(ids.length === 1 ? 'Removed from album' : `Removed ${ids.length} items from album`, { kind: 'ok' });
    } catch (e) {
      report(e);
    }
  }

  // ───────── item actions

  function menuItems(info) {
    const media = info.kind === 'image' || info.kind === 'video';
    return [
      { label: 'Open', icon: 'eye', onClick: () => openFromGrid(info.id) },
      { label: 'Rename', icon: 'note', onClick: () => renameItem(info.id) },
      { label: info.fav ? 'Unfavorite' : 'Favorite', icon: info.fav ? 'star-filled' : 'star', onClick: () => toggleFav([info.id]) },
      { label: 'Add to album', icon: 'album', onClick: () => addToAlbum([info.id]) },
      { label: 'Remove from album', icon: 'close', hidden: !spec.albumId, onClick: () => removeFromAlbum([info.id]) },
      { label: 'Save decrypted copy', icon: 'download', onClick: () => saveItems([info.id]) },
      { label: media ? 'Share / Save to Photos' : 'Share', icon: 'share', hidden: !canShare(), onClick: () => shareItem(info.id) },
      { label: 'Send as .czd', icon: 'send', onClick: () => sendItems([info.id]) },
      { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteItems([info.id]) },
    ];
  }

  async function renameItem(id) {
    const info = safeItem(id);
    if (!info) return;
    const name = await promptDialog({ title: info.kind === 'note' ? 'Rename note' : 'Rename', label: 'Name', value: info.name });
    if (name === null) return;
    const next = name.trim();
    if (!next || next === info.name) return;
    try {
      await v.rename(id, next);
      toast('Renamed', { kind: 'ok' });
    } catch (e) {
      report(e);
    }
  }

  async function toggleFav(ids) {
    const infos = ids.map(safeItem).filter(Boolean);
    if (!infos.length) return;
    const on = !infos.every((i) => i.fav);
    try {
      await Promise.all(infos.map((i) => v.setFavorite(i.id, on)));
      if (infos.length > 1) toast(on ? `Added ${infos.length} to favorites` : `Removed ${infos.length} from favorites`, { kind: 'ok' });
    } catch (e) {
      report(e);
    }
  }

  function deleteItems(ids) {
    const infos = ids.map(safeItem).filter(Boolean);
    if (!infos.length) return;
    del.schedule(infos.map((i) => i.id), infos.length === 1 ? `Deleted “${shortName(infos[0], 22)}”` : `Deleted ${infos.length} items`);
  }

  function sendItems(ids) {
    const list = ids.filter((id) => safeItem(id));
    if (!list.length) return;
    state.set('send.pending', { itemIds: list });
    router.navigate('#/send');
  }

  /**
   * Save decrypted copies. FIRST await: the save target (§1.7). 'picking' is set before the picker opens: a second
   * click while it is open would be refused a picker and fall back to a staged copy (a second, unasked-for save).
   * Staged copies are plaintext held in memory: together they stay within one Blob cap (more → "smaller groups").
   */
  let saveState = null; // null | 'picking' | 'saving'
  async function saveItems(ids) {
    const infos = ids.map(safeItem).filter(Boolean);
    if (!infos.length || saveState === 'picking') return;
    if (saveState === 'saving') {
      toast('Still saving the last ones — one moment.', { kind: 'info' });
      return;
    }
    saveState = 'picking';
    const one = infos.length === 1;
    const name = one ? (infos[0].kind === 'note' ? `${infos[0].name}.txt` : infos[0].name) : 'cZEROde files';
    let target;
    try {
      target = await platform.chooseSaveTarget({ name, mime: one ? infos[0].type : undefined, count: infos.length });
    } catch (e) {
      saveState = null;
      report(e);
      return;
    }
    if (!target) {
      saveState = null;
      return;
    }
    saveState = 'saving';
    const ctl = new AbortController();
    const progress = toast(one ? `Decrypting “${shortName(infos[0], 30)}”…` : `Decrypting ${infos.length} items…`, {
      timeout: 0,
      action: { label: 'Cancel', onClick: () => ctl.abort() },
    });
    const progressMsg = progress.el.querySelector('.toast-msg');
    const budget = platform.caps.mobile() ? CAPS.blobMobile : CAPS.blobDesktop;
    const staged = [];
    let held = 0;
    let left = 0;
    let saved = 0;
    let lastName = null;
    let viaDownloads = false;
    let error = null;
    for (const [i, info] of infos.entries()) {
      if (ctl.signal.aborted) break;
      // One more staged copy would go over what this browser can hold at once: the rest waits for another round.
      if (target.kind === 'stage' && staged.length && info.size <= budget && held + info.size > budget) {
        left = infos.length - i;
        break;
      }
      if (!one && progressMsg) progressMsg.textContent = `Decrypting ${i + 1} of ${infos.length}…`;
      let src = null;
      try {
        src = await v.sourceFor(info.id);
        const r = await saveDecrypted(target, src, { name: info.name, type: info.type, signal: ctl.signal });
        if (r?.staged) {
          staged.push(r.staged);
          held += r.staged.size;
        }
        if (r?.where === 'downloads') viaDownloads = true;
        lastName = r?.name ?? lastName;
        saved++;
      } catch (e) {
        error = e;
        break;
      } finally {
        if (src) disposeSource(src);
      }
    }
    progress.close();
    saveState = null;
    // Locked meanwhile or cancelled: decrypted copies are not handed out (and "unlock first" says nothing new).
    if (error || ctl.signal.aborted || v.status !== 'unlocked') {
      staged.length = 0;
      if (error && !ctl.signal.aborted && v.status === 'unlocked') report(error);
      return;
    }
    if (g.selecting && !left) setSelecting(false);
    if (left) {
      toast(`${left} more didn't fit in this round (this browser holds only so much at once). ${left === 1 ? "It's still selected — save it next." : "They're still selected — save them next."}`, { kind: 'warn', timeout: 10_000 });
      if (g.selecting) g.select(infos.slice(saved).map((i) => i.id));
    }
    if (staged.length) deliverStaged(staged);
    else if (viaDownloads) toast('Download started', { kind: 'ok' });
    else if (!left) toast(one ? `Saved “${shortName(lastName ?? name)}”` : `Saved ${infos.length} files`, { kind: 'ok' });
  }

  /** Share (coarse pointers): decrypt first, then a Share button whose own click calls navigator.share (§5.1). */
  let preparing = false; // a second tap while one copy is decrypting does not decrypt another
  async function shareItem(id) {
    const info = safeItem(id);
    if (!info || preparing) return;
    preparing = true;
    const t = toast(`Preparing “${shortName(info, 30)}”…`, { timeout: 0 });
    let src = null;
    let file = null;
    try {
      src = await v.sourceFor(id);
      file = await prepareShare(src, { name: info.name, type: info.type });
    } catch (e) {
      if (alive && v.status === 'unlocked') report(e);
      return;
    } finally {
      preparing = false;
      t.close();
      if (src) disposeSource(src);
    }
    if (!alive || v.status !== 'unlocked') return; // locked meanwhile: drop the decrypted copy
    if (!platform.caps.share([file])) {
      toast(userMessage('share-unavailable'), { kind: 'warn' });
      return;
    }
    const media = info.kind === 'image' || info.kind === 'video';
    const go = h('button', { type: 'button', class: 'btn btn-primary btn-block', dataset: { autofocus: '' } }, icon('share'), h('span', { text: media ? 'Share / Save to Photos' : 'Share' }));
    const p = modal({
      title: 'Ready to share',
      body: h('div', { class: 'stack' }, h('p', { text: `“${shortName(info)}” is decrypted and ready. Whatever app you share it with gets the normal, unencrypted file.` }), go),
      actions: [{ label: 'Cancel', kind: 'ghost', value: null }],
    });
    go.addEventListener('click', () => {
      platform.shareFiles([file]).catch(report);
      p.close(true);
    });
    await p;
    file = null;
  }

  function playAlbumItems(id, items, title) {
    try {
      if (tryCall('albums', 'playAlbum', { vault: v, id }) === true) return;
    } catch (e) {
      report(e);
      return;
    }
    playItems(items, title);
  }

  function playItems(items, title) {
    const list = items.map(viewerItem);
    if (list.length) playQueue(list, { title });
  }

  function playVisible() {
    playItems(g.items().filter((i) => i.kind === 'audio' || i.kind === 'video'), 'Music');
  }

  // ───────── viewer (#/vault/item/<id>)

  function viewerItem(info) {
    const actions = ['fav', 'save'];
    if (canShare()) actions.push('share');
    actions.push('send', 'rename', 'album', 'delete');
    if (info.kind === 'note') actions.push('editNote');
    return {
      key: info.id,
      name: info.name,
      type: info.type,
      kind: info.kind,
      size: info.size,
      mtime: info.mtime,
      addedAt: info.addedAt,
      fav: info.fav,
      actions,
      getSource: () => v.sourceFor(info.id),
    };
  }

  /** 'grid': what the grid shows; 'all': every item in the current sort (deep links, items outside the filter). */
  function viewerList(scope) {
    const items = scope === 'grid' ? g.items() : visibleItems(v, { sort: spec.sort }, { isHidden: del.isHidden });
    return items.map(viewerItem);
  }

  /**
   * The viewer's list: what its scope shows, plus the item on screen when an action took it out of the filter (★ off
   * in the ★ filter, a rename under a search): it stays where it was until the viewer moves on.
   */
  function viewerListFor(rec) {
    const list = viewerList(rec.scope);
    if (!list.some((x) => x.key === rec.id) && !del.isHidden(rec.id) && !noteSaving.has(rec.id)) {
      const info = safeItem(rec.id);
      if (info) list.splice(Math.min(Math.max(0, rec.keys.indexOf(rec.id)), list.length), 0, viewerItem(info));
    }
    return list;
  }

  /**
   * viewer.update() repaints its action bar: the button that had keyboard focus (★ after a toggle) is replaced and
   * focus would fall to <body>, where Esc and ← → no longer reach the viewer. Focus goes to the new twin (or the viewer).
   */
  function keepViewerFocus(run) {
    const d = globalThis.document;
    const had = d?.activeElement;
    const inViewer = had instanceof Element && had.closest('.vw-root');
    run();
    if (!inViewer || had.isConnected) return;
    const root = d.querySelector('.vw-root');
    if (!root) return;
    const label = had.querySelector?.('.vw-act-label')?.textContent;
    const twin = label ? [...root.querySelectorAll('.vw-act')].find((b) => b.querySelector('.vw-act-label')?.textContent === label) : null;
    (twin ?? root).focus({ preventScroll: true });
  }

  /** The index changed while the viewer is open: new list; when the item on screen went away the route follows. */
  function syncViewer() {
    const rec = viewer;
    const list = viewerListFor(rec);
    if (!list.length) {
      viewer = null;
      rec.handle.close();
      leaveItem();
      return;
    }
    const before = rec.keys;
    rec.keys = list.map((x) => x.key);
    keepViewerFocus(() => rec.handle.update(list));
    // Deleted (or gone otherwise): the viewer shows the item now at its place (viewer.update keeps the index). A note
    // being saved is the exception: it comes back under a new id and the viewer follows it by itself.
    if (!rec.keys.includes(rec.id) && !noteSaving.has(rec.id)) {
      rec.id = rec.keys[Math.min(Math.max(0, before.indexOf(rec.id)), rec.keys.length - 1)];
      router.navigate(router.hrefFor('vault', 'item', rec.id), { replace: true });
    }
  }

  function openFromGrid(id) {
    fromGrid = true;
    router.navigate(router.hrefFor('vault', 'item', id));
  }

  function showItem(id) {
    const info = safeItem(id);
    if (!info || del.isHidden(id)) {
      if (viewer && viewer.id !== id) return; // the viewer moved on (a delete inside it): keep it
      toast("That item isn't in your vault anymore.", { kind: 'warn' });
      leaveItem();
      return;
    }
    if (viewer) {
      if (viewer.id === id) return;
      // Prev/next inside the viewer (it replaced the route): same list, new position.
      const i = viewer.keys.indexOf(id);
      if (i >= 0) {
        viewer.id = id;
        viewer.handle.setIndex(i);
        return;
      }
      const old = viewer;
      viewer = null;
      old.handle.close();
    }
    const scope = g.items().some((i) => i.id === id) ? 'grid' : 'all';
    const list = viewerList(scope);
    const index = Math.max(0, list.findIndex((x) => x.key === id));
    const rec = { id, scope, handle: null, keys: list.map((x) => x.key) };
    viewer = rec;
    rec.handle = openViewer({
      items: list,
      index,
      routed: true,
      onAction: (action, item, payload) => onViewerAction(action, item, payload),
      onClose: (reason) => onViewerClose(rec, reason),
    });
  }

  function onViewerClose(rec, reason) {
    if (viewer === rec) viewer = null;
    cleanupFresh();
    if (!alive || reason === 'replaced' || reason === 'purge') return;
    refocusCard(rec.id);
    if (reason === 'closed') return;
    leaveItem();
  }

  /**
   * After the viewer closes, keyboard focus (and the scroll position) follow the item it showed last, not the card
   * that opened it — unless focus already went somewhere else on purpose (a dialog, a toast's Undo).
   */
  function refocusCard(id) {
    const raf = globalThis.requestAnimationFrame ?? ((f) => setTimeout(f, 16));
    raf(() => {
      if (!alive || viewer || v.status !== 'unlocked') return;
      const d = globalThis.document;
      const a = d?.activeElement;
      if (a && a !== d.body && !g.el.contains(a)) return;
      g.focusItem(id);
    });
  }

  function leaveItem() {
    if (router.current().parts[0] !== 'item') return;
    if (fromGrid) {
      fromGrid = false;
      globalThis.history?.back();
    } else {
      router.navigate(gridHash, { replace: true });
    }
  }

  function onViewerAction(action, item, payload) {
    const id = item?.key;
    if (typeof id !== 'string') return undefined;
    switch (action) {
      case 'fav':
        return toggleFav([id]);
      case 'save':
        return saveItems([id]);
      case 'share':
        return shareItem(id);
      case 'send':
        return sendItems([id]);
      case 'rename':
        return renameItem(id);
      case 'album':
        return addToAlbum([id]);
      case 'delete':
        // Hidden at once: syncViewer moves the viewer (and the route) to the next item, or closes it.
        deleteItems([id]);
        return undefined;
      case 'editNote':
        return saveNote(id, payload ?? {});
      default:
        return undefined;
    }
  }

  /** The viewer's note Save (and the hand-over of an unsaved edit): resolves to saveNote's ItemInfo (new id). */
  function saveNote(id, { title, body, reason }) {
    // Deleted with unsaved edits: the viewer hands the edit over as it moves on (reason set) — it goes with the note
    // instead of saving it again under a new id (Undo brings back the last saved version).
    if (reason && del.isHidden(id)) return Promise.resolve(null);
    if (fresh?.id === id) fresh.saved = true;
    noteSaving.add(id);
    const p = v.saveNote(id, { title: String(title ?? ''), body: String(body ?? '') });
    p.then((info) => {
      noteSaving.delete(id);
      if (viewer?.id === id) {
        viewer.id = info.id;
        viewer.keys = viewer.keys.map((k) => (k === id ? info.id : k));
      }
      if (reason) toast('Note saved', { kind: 'ok' });
    }, (e) => {
      noteSaving.delete(id);
      if (reason) report(e);
    });
    return p;
  }

  // ───────── routing

  function syncRoute(r) {
    const [a, b] = r.parts;
    if (a === 'item' && b) {
      showItem(b);
      return;
    }
    if (viewer) {
      const old = viewer;
      viewer = null;
      old.handle.close();
    }
    fromGrid = false;
    if (a === 'album' && b) {
      if (spec.albumId !== b) {
        spec.albumId = b;
        if (g.selecting) setSelecting(false);
      }
      gridHash = router.hrefFor('vault', 'album', b);
    } else if (!a) {
      if (spec.albumId) {
        spec.albumId = null;
        if (g.selecting) setSelecting(false);
      }
      gridHash = '#/vault';
    } else {
      router.navigate('#/vault', { replace: true });
      return;
    }
    refresh();
  }

  // ───────── wiring

  const onItems = () => refresh();
  const onMeta = () => paintBackupChip(allItems());
  const onLocking = () => {
    // Keys still exist: a dirty note in the viewer is handed over (viewer close → editNote) and saved now.
    if (viewer) {
      const old = viewer;
      viewer = null;
      old.handle.close();
    }
    cleanupFresh();
  };
  v.addEventListener('items', onItems);
  v.addEventListener('lists', onItems);
  v.addEventListener('meta', onMeta);
  v.addEventListener('locking', onLocking);
  offs.push(() => {
    v.removeEventListener('items', onItems);
    v.removeEventListener('lists', onItems);
    v.removeEventListener('meta', onMeta);
    v.removeEventListener('locking', onLocking);
  });
  offs.push(del.subscribe((info) => {
    // Undo from the toast: the toast (and its focused button) is gone; focus goes to the restored card.
    if (info?.restored?.length) restoredFocus = info.restored[0];
    refresh();
  }));
  offs.push(state.on('legacy.found', () => paintBanners()));
  offs.push(state.on('legacy.importDone', () => paintBanners()));
  offs.push(state.on('install.prompt', () => paintBanners()));
  // vault.lock() switches the screen before it purges; this also covers a purge that comes first (decrypted names,
  // thumbnails and the search text must not outlive a lock).
  offs.push(state.onPurge(() => {
    search.value = '';
    spec.query = '';
    if (v.status !== 'unlocked') {
      alive = false;
      g.destroy();
      el.replaceChildren();
    }
  }));

  offs.push(dropZone(host, { folders: true, onFiles: (files, { folders }) => importFiles(files, folders) }));

  const onPaste = (e) => {
    const root = globalThis.document?.documentElement;
    if (v.status !== 'unlocked' || isEditable(e.target) || root?.classList.contains('has-overlay') || root?.classList.contains('vw-open')) return;
    let files = [];
    try {
      files = fn('upload', 'pastedFiles')?.(e) ?? pasted(e);
    } catch {
      files = pasted(e);
    }
    if (!files.length) return;
    e.preventDefault();
    importFiles(files, []);
  };
  const onKey = (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const d = globalThis.document;
    if (d?.documentElement.classList.contains('has-overlay') || d?.documentElement.classList.contains('vw-open')) return;
    if (e.key === '/' && !isEditable(e.target)) {
      e.preventDefault();
      search.focus();
    } else if (e.key === 'Escape' && g.selecting) {
      setSelecting(false);
    }
  };
  globalThis.document?.addEventListener('paste', onPaste);
  globalThis.document?.addEventListener('keydown', onKey);
  offs.push(() => {
    globalThis.document?.removeEventListener('paste', onPaste);
    globalThis.document?.removeEventListener('keydown', onKey);
  });

  Promise.all([load('albums')]).then(() => mountStrip());
  paintBanners();
  scheduleStorage(0);
  syncRoute(route);
  paint();

  return {
    el,
    update: (r) => syncRoute(r),
    // Unlocked from the keyboard: focus lands on the main action instead of <body> (the unlock form is gone).
    focus: () => {
      const a = globalThis.document?.activeElement;
      if (!viewer && finePointer() && (!a || a === globalThis.document.body)) addBtn.focus({ preventScroll: true });
    },
    destroy() {
      alive = false;
      clearTimeout(searchTimer);
      clearTimeout(storageTimer);
      for (const off of offs.splice(0)) {
        try {
          off();
        } catch (e) {
          globalThis.console?.error?.(e);
        }
      }
      if (viewer) {
        const old = viewer;
        viewer = null;
        old.handle.close();
      }
      cleanupFresh();
      g.destroy();
      for (const c of [...strip.children]) {
        try {
          c.destroy?.();
        } catch {
          // ignore
        }
      }
      strip.replaceChildren();
      el.replaceChildren();
    },
  };
}

function searchKey(s) {
  return String(s ?? '').trim();
}
