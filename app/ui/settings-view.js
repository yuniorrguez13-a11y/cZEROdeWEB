// Settings and About screens (routes 'settings', 'about'; DESIGN §1.10, §3.5, §3.7, §3.10, §4.3, §6, §12). Owner: V2b.
// Settings: Appearance (theme cards with live previews), Security (lock timers, background music, app-switcher
// cover, clipboard clearing, unlock time), Vault (storage + "Keep my data", backup export, restore/merge, change
// passphrase, recovery code, delete) and App (version, update, tour, desktop releases).
// About: the plain-language security model of DESIGN §6 (web-origin warning on the web, the Linux media limit on
// the desktop).
// Also exports the backup flows other views call from a click (§12): openBackupExport() — its FIRST await is
// platform.chooseSaveTarget — and openRestoreDialog(file?) — without a file its first await is the file picker.
// Node-importable: the DOM is only touched inside functions.

import { CzdError, isCancel, userMessage } from '../errors.js';
import { RELEASES_URL, VERSION } from '../config.js';
import * as state from '../state.js';
import * as settings from '../settings.js';
import * as platform from '../platform.js';
import * as pwa from '../pwa.js';
import * as router from '../router.js';
import * as kdf from '../crypto/kdf.js';
import { meetsVaultMinimum } from '../crypto/passphrase.js';
import * as vaultModule from '../vault/vault.js';
import { blobSource } from '../util/stream.js';
import { fmtDate, fmtSize, safeFilename } from '../util/format.js';
import { announce, confirmDialog, h, icon, modal, toast } from '../util/dom.js';
import { banner, copyButton, passphraseField, progressRow, segmented, storageBar } from './components.js';
import { openTutorial } from './tutorial.js';

const DAY = 86400000;
const CZB_MIME = 'application/x-czeroode-backup';
const CZB_MAGIC = [0x89, 0x43, 0x5a, 0x42, 0x0d, 0x0a, 0x1a, 0x0a];

const THEMES = Object.freeze([
  { id: 'gothic', name: 'Gothic', text: 'Blackletter, blood red, hairlines. The original.' },
  { id: 'minimal-white', name: 'Minimal White', text: 'Clean and bright, for daylight.' },
  { id: 'minimal-black', name: 'Minimal Black', text: 'Clean and dark, no frills.' },
]);
const IDLE_OPTS = [{ value: 1, label: '1 min' }, { value: 5, label: '5 min' }, { value: 15, label: '15 min' }, { value: 30, label: '30 min' }, { value: 0, label: 'Never' }];
const HIDDEN_OPTS = [{ value: 'immediate', label: 'At once' }, { value: '1m', label: '1 min' }, { value: '3m', label: '3 min' }, { value: '15m', label: '15 min' }, { value: 'never', label: 'Never' }];
const CLIP_OPTS = [{ value: 0, label: 'Off' }, { value: 15, label: '15 s' }, { value: 30, label: '30 s' }, { value: 60, label: '60 s' }];
const STORE_LABEL = Object.freeze({ opfs: 'browser file storage (OPFS)', idb: 'browser database (IndexedDB)', 'tauri-fs': 'the app data folder', memory: 'memory' });
const STATUS_LABEL = Object.freeze({
  loading: 'Checking…', none: 'No vault yet', locked: 'Locked', unlocked: 'Unlocked', 'other-tab': 'Open in another tab', unavailable: 'Unavailable',
});
const SECTIONS = Object.freeze([
  { id: 'appearance', label: 'Appearance', icon: 'eye' },
  { id: 'security', label: 'Security', icon: 'key' },
  { id: 'vault', label: 'Vault', icon: 'lock' },
  { id: 'app', label: 'App', icon: 'settings' },
]);

const LOCK_COPY = "Locking drops keys and clears the screen; JavaScript can't guarantee every secret is wiped from memory.";
const CHANGE_COPY = 'This changes what unlocks the vault on this device. If someone may know your old passphrase AND has a copy of your vault or a backup, changing it is not enough — they could still open what they copied.';
const WEB_ORIGIN_COPY = 'Every GitHub Pages site of this account shares https://yuniorrguez13-a11y.github.io. Any page published there (or a bug in one) can take over cZEROde web: replace its cached code so your passphrase is stolen at the next unlock, control an open cZEROde tab, and read, replace or delete vault data. Never publish another GitHub Pages project from this account. The desktop app is not affected.';

const getVault = () => vaultModule.vault;

// ───────── small helpers

/** "Too big to save" (§11) or the §7.1 copy. */
function errorText(e) {
  if ((e?.code === 'too-big-to-preview' && e?.detail === 'too-big-to-save') || (e?.code === 'quota-exceeded' && e?.detail === 'staging limit')) {
    return 'Too big to save in this browser — use the desktop app or Chrome.';
  }
  return userMessage(e);
}

function report(e) {
  if (!e || isCancel(e)) return;
  if (!e.code || e.code === 'internal') globalThis.console?.error?.('[settings]', e);
  toast(errorText(e), { kind: 'err', timeout: 6000 });
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function ago(ms) {
  const d = Math.floor((Date.now() - ms) / DAY);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  return `${d} days ago`;
}

function yyyymmdd(ms = Date.now()) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** File name of a new backup: czerode-backup-YYYYMMDD.czb */
function backupFileName() {
  return `czerode-backup-${yyyymmdd()}.czb`;
}

function platformLabel() {
  if (platform.isTauri) return 'Desktop app';
  return pwa.isStandalone() ? 'Web app · installed' : 'Web app · in the browser';
}

const liveUrls = new Set();
state.onPurge(() => {
  for (const u of liveUrls) globalThis.URL?.revokeObjectURL?.(u);
  liveUrls.clear();
});

/** Saves a staged File through <a download> (call from a click, or right after one). */
function downloadFile(file) {
  const url = URL.createObjectURL(file);
  liveUrls.add(url);
  const a = h('a', { href: url, download: safeFilename(file.name), class: 'visually-hidden', tabIndex: -1 });
  globalThis.document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => {
    if (liveUrls.delete(url)) URL.revokeObjectURL(url);
  }, 60_000);
}

/** A labelled section with a hairline header (used by Settings and About). */
function section({ id, iconId, title, sub }, ...children) {
  const titleId = `st-${id}-title`;
  return h('section', { class: 'st-sec', id: `st-${id}`, aria: { labelledby: titleId }, dataset: { section: id } },
    h('header', { class: 'st-sec-head' },
      h('span', { class: 'st-sec-icon', aria: { hidden: 'true' } }, icon(iconId)),
      h('div', { class: 'st-sec-titles' },
        h('h2', { class: 'st-sec-title', id: titleId, text: title }),
        sub ? h('p', { class: 'st-sec-sub', text: sub }) : null)),
    h('div', { class: 'st-sec-body' }, children));
}

let rowSeq = 0;
/**
 * One settings row: label + hint on the left, the control on the right (stacked on phones).
 * `labelFor` makes the label a <label> of that control.
 */
function row({ label, hint, control, labelFor, wide = false, className }) {
  const id = `st-row-${++rowSeq}`;
  return h('div', { class: ['st-row', wide ? 'st-row-wide' : null, className] },
    h('div', { class: 'st-row-text' },
      labelFor ? h('label', { class: 'st-row-label', for: labelFor, id, text: label }) : h('p', { class: 'st-row-label', id, text: label }),
      hint ? (typeof hint === 'string' ? h('p', { class: 'st-row-hint', text: hint }) : hint) : null),
    control ? h('div', { class: 'st-row-ctl' }, control) : null);
}

/** A switch (checkbox role=switch) whose track is part of the click target. */
function toggle({ checked, onChange, label }) {
  const id = `st-switch-${++rowSeq}`;
  const input = h('input', {
    type: 'checkbox',
    class: 'st-switch-input',
    id,
    role: 'switch',
    checked: Boolean(checked),
    aria: { label },
    on: { change: () => onChange(input.checked) },
  });
  const el = h('span', { class: 'st-switch' }, input, h('span', { class: 'st-switch-track', aria: { hidden: 'true' } }, h('span', { class: 'st-switch-thumb' })));
  return { el, input, id };
}

function setOrWarn(name, value) {
  try {
    settings.set(name, value);
  } catch (e) {
    globalThis.console?.warn?.('[settings] could not store', name, e);
  }
}

const btn = (label, iconId, { kind, small = true, onClick, disabled, className, dataset } = {}) => h('button', {
  type: 'button',
  class: ['btn', small ? 'btn-sm' : null, kind ? `btn-${kind}` : null, className],
  disabled: Boolean(disabled),
  dataset,
  on: { click: onClick },
}, iconId ? icon(iconId) : null, h('span', { text: label }));

const confirmKdf = (p) => confirmDialog({
  title: 'Heavy backup',
  message: `This backup needs ~${p.mib} MiB and ~${p.seconds} s to unlock. Continue?`,
  confirmLabel: 'Continue',
});

// ───────── backup export (§3.7, §12)

let exporting = false;
let restoring = false;

/**
 * Exports the unlocked vault to a .czb: FIRST await is the save picker (call it from a click), then the export
 * streams into the chosen target with progress, size and free space shown. Resolves when its dialog closes; never
 * rejects (errors are shown). A second call while one runs does nothing.
 * @returns {Promise<void>}
 */
export async function openBackupExport() {
  const v = getVault();
  if (!v || v.status !== 'unlocked') {
    toast(userMessage('vault-locked'), { kind: 'warn', action: { label: 'Open vault', onClick: () => router.navigate('#/vault') } });
    return;
  }
  if (exporting) return;
  exporting = true;
  try {
    const name = backupFileName();
    let target;
    try {
      target = await platform.chooseSaveTarget({ name, mime: CZB_MIME, count: 1 });
    } catch (e) {
      report(e);
      return;
    }
    if (!target) return;
    await runExport(v, target, name);
  } finally {
    exporting = false;
  }
}

async function runExport(v, target, name) {
  const ctl = new AbortController();
  let running = true;
  const title = h('p', { class: 'st-job-title', text: 'Preparing your backup…' });
  const sub = h('p', { class: 'st-job-sub', text: 'Checking every item first. Nothing is decrypted.' });
  const slot = h('div', { class: 'st-job-slot' }, h('div', { class: 'progress st-indet' }, h('div', { class: 'progress-fill' })));
  const errLine = h('p', { class: 'hint hint-err st-error', role: 'alert', hidden: true });
  const cancel = btn('Cancel', 'close', { kind: 'ghost', small: false, className: 'st-backup-cancel', onClick: () => ctl.abort(new CzdError('aborted')) });
  const foot = h('div', { class: 'st-job-foot' }, cancel);
  const body = h('div', { class: 'st-job', dataset: { state: 'running' } },
    h('div', { class: 'st-job-head' }, h('span', { class: 'st-job-icon' }, icon('download')), h('div', { class: 'st-job-titles' }, title, sub)),
    slot, errLine, foot);
  // Not dismissible by a stray click or Esc: Cancel stops the job, and a staged backup must not be thrown away
  // by accident (Esc = Cancel / Done below). A lock or a route change still closes it.
  const dlg = modal({ title: 'Back up vault', body, className: 'st-modal st-backup-modal', dismissible: false });
  let closed = false;
  let onEsc = () => ctl.abort(new CzdError('aborted'));
  dlg.el.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    onEsc();
  });
  dlg.then(() => {
    closed = true;
    if (running) ctl.abort(new CzdError('aborted'));
  });
  let prog = null;
  let plan;
  try {
    // The backup counts as made (lastBackupAt; the reminder goes quiet) only once the file is really kept: a real
    // file target when write() resolves, a staged one when the user taps "Save backup".
    plan = await v.exportBackup({ signal: ctl.signal, onProgress: (d) => prog?.update(d), markDone: false });
  } catch (e) {
    running = false;
    await target.abort().catch(() => {});
    fail(e);
    await dlg;
    return;
  }
  const est = await platform.storage.estimate().catch(() => null);
  const free = est && Number.isFinite(est.quota) && Number.isFinite(est.usage) ? Math.max(0, est.quota - est.usage) : null;
  title.textContent = `Writing ${name}`;
  sub.textContent = [`${fmtSize(plan.size)} backup`, free !== null && target.kind === 'stage' ? `~${fmtSize(free)} free` : null].filter(Boolean).join(' · ');
  prog = progressRow({ name, total: plan.size });
  slot.replaceChildren(prog.el);
  let res;
  try {
    res = await target.write(name, plan.stream, { size: plan.size, mime: CZB_MIME, signal: ctl.signal });
  } catch (e) {
    running = false;
    await target.abort().catch(() => {});
    fail(e);
    await dlg;
    return;
  }
  running = false;
  const markSaved = () => {
    if (typeof v.markBackedUp === 'function') v.markBackedUp(plan.createdAt).catch(() => {});
  };
  if (!res?.staged) markSaved();
  prog.done(`Done · ${fmtSize(plan.size)}`);
  body.dataset.state = 'done';
  title.textContent = 'Backup ready';
  const lines = [`${fmtSize(plan.size)} · ${plural(Math.max(0, safeCount(v) - (plan.skipped || 0)), 'item')}`];
  if (res?.where && target.kind !== 'stage') lines.push(`Saved as ${safeFilename(res.name ?? name)}`);
  sub.textContent = lines.join(' · ');
  const tips = h('p', { class: 'st-job-tip', text: 'It opens with your passphrase or your recovery code. Keep it somewhere other than this device.' });
  const warn = plan.skipped > 0 ? banner({ kind: 'warn', text: `${plural(plan.skipped, 'damaged item')} could not be included.` }) : null;
  // A staged backup only exists in this tab until "Save backup" hands it to the browser's downloads.
  let saved = !res?.staged;
  let warned = false;
  const unsaved = h('p', { class: 'hint st-unsaved', role: 'alert', hidden: true }, icon('warning'),
    h('span', { text: 'Not saved yet — it disappears when this closes. Tap “Save backup”, or “Discard” to throw it away.' }));
  const finish = () => {
    if (saved || warned) {
      dlg.close(true);
      return;
    }
    warned = true;
    unsaved.hidden = false;
    done.querySelector('.icon')?.replaceWith(icon('trash'));
    done.querySelector('span').textContent = 'Discard';
    done.classList.add('st-discard');
    save?.focus();
  };
  onEsc = finish;
  const done = btn('Done', 'check', { kind: res?.staged ? 'ghost' : 'primary', small: false, className: 'st-backup-done', onClick: finish });
  const save = res?.staged ? btn('Save backup', 'download', {
    kind: 'primary',
    small: false,
    className: 'st-save-backup',
    onClick: () => {
      downloadFile(res.staged);
      if (!saved) markSaved();
      saved = true;
      unsaved.hidden = true;
      save.disabled = true;
      save.lastChild.textContent = 'Saved';
      done.querySelector('.icon')?.replaceWith(icon('check'));
      done.querySelector('span').textContent = 'Done';
      done.classList.remove('btn-ghost', 'st-discard');
      done.classList.add('btn-primary');
      done.focus();
    },
  }) : null;
  slot.after(tips);
  if (warn) tips.after(warn);
  foot.before(unsaved);
  foot.replaceChildren(done, save ?? '');
  (save ?? done).focus();
  announce('Backup ready');
  await dlg;

  function fail(e) {
    body.dataset.state = 'failed';
    if (isCancel(e)) {
      dlg.close(null);
      return;
    }
    if (closed) {
      // The dialog went away (a lock closes it): say what happened anyway.
      report(e);
      return;
    }
    title.textContent = "The backup didn't finish";
    sub.textContent = 'Nothing was saved.';
    slot.replaceChildren();
    errLine.replaceChildren(icon('warning'), h('span', { text: errorText(e) }));
    errLine.hidden = false;
    const close = btn('Close', null, { kind: 'primary', small: false, onClick: () => dlg.close(null) });
    foot.replaceChildren(close);
    close.focus();
    onEsc = () => dlg.close(null);
  }
}

function safeCount(v) {
  try {
    return v.items().length;
  } catch {
    return 0;
  }
}

// ───────── restore / merge (§3.7, §12)

async function isCzbFile(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    return head.length === 8 && CZB_MAGIC.every((b, i) => head[i] === b);
  } catch {
    return false;
  }
}

/**
 * Restore (no vault yet → the backup becomes this device's vault) or merge (unlocked → its items are added,
 * duplicates skipped). Without `file` the FIRST await is the file picker (call it from a click). Resolves when its
 * dialog closes; never rejects. A second call while one is open does nothing.
 * @param {File} [file]
 * @returns {Promise<void>}
 */
export async function openRestoreDialog(file) {
  let f = file;
  if (!f) {
    // The picker itself isn't guarded: a pick the browser never reports as cancelled is only settled by the next
    // pickFiles() call, which a guard here would block forever.
    let picked;
    try {
      picked = await platform.pickFiles({ multiple: false });
    } catch (e) {
      report(e);
      return;
    }
    f = picked?.[0];
    if (!f) return;
  }
  if (restoring) return;
  restoring = true;
  try {
    await restoreFrom(f);
  } finally {
    restoring = false;
  }
}

async function restoreFrom(f) {
  const v = getVault();
  if (!v) {
    report(new CzdError('store-unavailable'));
    return;
  }
  if (!(await isCzbFile(f))) {
    report(new CzdError('not-czb'));
    return;
  }
  const src = blobSource(f);
  let info;
  try {
    info = await v.inspectBackup(src);
  } catch (e) {
    report(e);
    return;
  }
  await restoreFlow(v, f, src, info);
}

function backupSummary(f, info) {
  const facts = [
    ['Made', info.createdAt ? fmtDate(info.createdAt) : 'unknown'],
    ['Items', String(info.items)],
    ['Albums', String(info.lists)],
    ['Recovery', info.hasRecovery ? 'Code set' : 'None'],
  ];
  return h('div', { class: 'st-czb' },
    h('div', { class: 'st-czb-head' },
      h('span', { class: 'st-czb-icon' }, icon('file')),
      h('div', { class: 'st-czb-titles' },
        h('p', { class: 'st-czb-name', text: safeFilename(f.name) }),
        h('p', { class: 'st-czb-size', text: `${fmtSize(f.size)} · cZEROde backup` })),
      info.sameVault ? h('span', { class: 'badge badge-ok' }, icon('check'), h('span', { text: 'This vault' })) : null),
    h('dl', { class: 'st-facts' }, facts.map(([k, val]) => h('div', { class: 'st-fact' }, h('dt', { text: k }), h('dd', { text: val })))));
}

async function restoreFlow(v, f, src, info) {
  const status = v.status;
  if (status === 'locked' || status === 'other-tab' || status === 'unavailable' || status === 'loading') {
    const msg = status === 'locked'
      ? 'Unlock your vault first to merge this backup into it. To replace your vault with it instead, delete this vault in Settings → Vault, then restore.'
      : userMessage(status === 'other-tab' ? 'other-tab' : 'store-unavailable');
    const go = await modal({
      title: 'Restore backup',
      className: 'st-modal',
      body: h('div', { class: 'stack' }, backupSummary(f, info), banner({ kind: 'info', text: msg })),
      actions: status === 'locked'
        ? [{ label: 'Close', kind: 'ghost', value: false }, { label: 'Unlock vault', kind: 'primary', value: true, autofocus: true }]
        : [{ label: 'Close', kind: 'primary', value: false }],
    });
    if (go === true) router.navigate('#/vault');
    return;
  }
  const mode = status === 'none' ? 'replace' : 'merge';
  const needSecret = !(mode === 'merge' && info.sameVault);
  let secretKind = 'pass';
  let running = null;

  const orCode = info.hasRecovery ? ' — or its recovery code' : '';
  const lead = mode === 'replace'
    ? `This device has no vault yet: the backup becomes your vault. Unlock it with the backup's passphrase${orCode}.`
    : info.sameVault
      ? 'This backup comes from the vault you have open. Items you already have are skipped — nothing is overwritten.'
      : `This backup comes from another vault. Its items are copied into yours with fresh keys, and its albums come along. Enter that backup's passphrase${orCode}.`;

  const passF = passphraseField({ label: mode === 'replace' ? 'Backup passphrase' : "That backup's passphrase", mode: 'enter', purpose: 'unlock', autocomplete: 'off', name: 'czd-restore-pass', onSubmit: () => go() });
  const codeF = passphraseField({ label: 'Recovery code', mode: 'enter', purpose: 'open', autocomplete: 'off', name: 'czd-restore-code', placeholder: '8 groups of 4', onSubmit: () => go() });
  // Replace with the recovery code: the vault gets a new passphrase (the old one is the one that was forgotten).
  const newF = passphraseField({ label: 'New passphrase for this vault', mode: 'new', purpose: 'vault', generateWords: 5, name: 'czd-restore-new', onChange: () => paint() });
  // Generated words: like creating a vault (§1.4), a tick that they are stored somewhere.
  const savedBox = h('input', { type: 'checkbox', on: { change: () => paint() } });
  const saved = h('label', { class: 'check st-check', hidden: true }, savedBox, h('span', { text: 'I saved it (password manager, paper or screenshot)' }));
  const reason = h('p', { class: 'hint st-reason', aria: { live: 'polite' } });
  const seg = info.hasRecovery ? segmented({
    label: 'Unlock with',
    value: 'pass',
    options: [{ value: 'pass', label: 'Passphrase' }, { value: 'code', label: 'Recovery code' }],
    onChange: (val) => {
      secretKind = val;
      paint();
      (val === 'pass' ? passF : codeF).focus();
    },
  }) : null;
  const errLine = h('p', { class: 'hint hint-err st-error', role: 'alert', hidden: true });
  const progressSlot = h('div', { class: 'st-job-slot' });
  const goBtn = btn(mode === 'replace' ? 'Restore' : 'Merge', mode === 'replace' ? 'refresh' : 'plus', { kind: 'primary', small: false, className: 'st-restore-go', onClick: () => go() });
  const cancelBtn = btn('Cancel', null, { kind: 'ghost', small: false, onClick: () => (running ? running.abort(new CzdError('aborted')) : dlg.close(null)) });
  const secretBox = h('div', { class: 'st-secret' }, seg?.el ?? null, passF.el, codeF.el, newF.el, saved, reason);
  const body = h('div', { class: 'st-restore stack' },
    backupSummary(f, info),
    h('p', { class: 'st-lead-sm', text: lead }),
    needSecret ? secretBox : null,
    progressSlot,
    errLine,
    h('div', { class: 'st-job-foot' }, cancelBtn, goBtn));
  // A stray click outside while it restores must not cancel it (Cancel does).
  const dlg = modal({ title: mode === 'replace' ? 'Restore backup' : 'Merge backup', body, className: 'st-modal st-restore-modal', busy: () => Boolean(running) });
  let closed = false;
  dlg.then(() => {
    closed = true;
    running?.abort(new CzdError('aborted'));
  });
  paint();
  if (needSecret) passF.focus();
  else goBtn.focus();
  await dlg;

  function problem() {
    if (!needSecret) return null;
    if (secretKind === 'pass') return passF.value ? null : 'Enter the passphrase of this backup.';
    if (!codeF.value.trim()) return 'Enter the recovery code (8 groups of 4).';
    if (mode === 'replace') {
      if (!newF.value) return 'Pick a new passphrase for the restored vault — or tap Generate.';
      const min = meetsVaultMinimum(newF.value, { generated: newF.generated });
      if (!min.ok) return min.reason === 'too-short' ? 'Use at least 10 characters — or tap Generate.' : 'Too easy to guess. Add a few more words, or tap Generate.';
      if (newF.generated && !savedBox.checked) return 'Tick “I saved it” once the words are stored somewhere safe.';
    }
    return null;
  }

  function paint() {
    passF.el.hidden = secretKind !== 'pass';
    codeF.el.hidden = secretKind !== 'code';
    newF.el.hidden = !(secretKind === 'code' && mode === 'replace');
    saved.hidden = newF.el.hidden || !newF.generated;
    if (saved.hidden) savedBox.checked = false;
    const p = problem();
    reason.textContent = p ?? '';
    reason.hidden = !p || !(secretKind === 'code' && mode === 'replace');
  }

  function setError(msg) {
    errLine.replaceChildren(...(msg ? [icon('warning'), h('span', { text: msg })] : []));
    errLine.hidden = !msg;
  }

  async function go() {
    if (running) return;
    const p = problem();
    if (p) {
      setError(p);
      return;
    }
    setError(null);
    let secret = null;
    if (needSecret) {
      secret = secretKind === 'pass' ? { pass: passF.value } : { code: codeF.value };
      if (secretKind === 'code' && mode === 'replace') secret.newPass = newF.value;
    }
    const ctl = new AbortController();
    running = ctl;
    const row = progressRow({ name: mode === 'replace' ? 'Restoring' : 'Merging', total: f.size });
    progressSlot.replaceChildren(row.el);
    goBtn.disabled = true;
    for (const fld of [passF, codeF, newF]) fld.setDisabled(true);
    savedBox.disabled = true;
    if (seg) seg.el.inert = true;
    body.dataset.state = 'running';
    try {
      const r = await v.restoreBackup(src, secret ?? {}, { mode, signal: ctl.signal, onProgress: (d) => row.update(d), confirmKdf });
      running = null;
      dlg.close(true);
      if (mode === 'replace') {
        toast(`Restored ${plural(r.added, 'item')}. Your vault is open.`, { kind: 'ok', timeout: 6000 });
        router.navigate('#/vault');
      } else if (r.added === 0) {
        toast(`Nothing new — ${plural(r.skipped, 'item')} already in your vault.`, { kind: 'info', timeout: 6000 });
      } else {
        toast(`Merged ${plural(r.added, 'item')}${r.skipped ? ` · ${r.skipped} already there` : ''}.`, { kind: 'ok', timeout: 6000 });
      }
      announce('Backup restored');
    } catch (e) {
      running = null;
      progressSlot.replaceChildren();
      goBtn.disabled = false;
      for (const fld of [passF, codeF, newF]) fld.setDisabled(false);
      savedBox.disabled = false;
      if (seg) seg.el.inert = false;
      body.dataset.state = 'idle';
      if (isCancel(e)) return;
      if (closed) {
        report(e);
        return;
      }
      if (e?.code === 'wrong-passphrase' && secretKind === 'pass') passF.setError(userMessage(e));
      else if (e?.code === 'recovery-wrong') codeF.setError("That recovery code doesn't open this backup.");
      else if (e?.code === 'vault-exists') setError('This device has a vault now (made in another tab?). Close this and merge the backup into it instead.');
      else setError(errorText(e));
      if (!body.contains(globalThis.document?.activeElement)) goBtn.focus(); // it was disabled while running
    }
  }
}

// ───────── vault dialogs

/** Hidden username so password managers file the passphrase under "cZEROde vault" (§1.4). */
function usernameField() {
  return h('input', { type: 'text', class: 'visually-hidden', name: 'username', autocomplete: 'username', value: 'cZEROde vault', readOnly: true, tabIndex: -1, aria: { hidden: 'true' } });
}

function changePassphraseDialog(v) {
  const oldF = passphraseField({ label: 'Current passphrase', mode: 'enter', purpose: 'change', name: 'czd-change-old', onChange: () => paint() });
  const newF = passphraseField({ label: 'New passphrase', mode: 'new', purpose: 'change', generateWords: 5, name: 'czd-change-new', onChange: () => paint() });
  const confF = passphraseField({ label: 'Type the new one again', mode: 'enter', purpose: 'change', autocomplete: 'new-password', name: 'czd-change-confirm', onChange: () => paint() });
  const savedBox = h('input', { type: 'checkbox', on: { change: () => paint() } });
  const saved = h('label', { class: 'check st-check', hidden: true }, savedBox, h('span', { text: 'I saved it (password manager, paper or screenshot)' }));
  const reason = h('p', { class: 'hint st-reason', aria: { live: 'polite' } });
  const errLine = h('p', { class: 'hint hint-err st-error', role: 'alert', hidden: true });
  const working = h('p', { class: 'st-working', role: 'status', hidden: true }, h('span', { class: 'st-spin', aria: { hidden: 'true' } }), h('span', { text: 'Changing… this takes a few seconds.' }));
  const goBtn = btn('Change passphrase', 'key', { kind: 'primary', small: false, className: 'st-change-go' });
  goBtn.type = 'submit';
  const form = h('form', { class: 'st-form', noValidate: true, attrs: { autocomplete: 'on' } },
    usernameField(),
    banner({ kind: 'info', text: CHANGE_COPY }),
    oldF.el, newF.el, confF.el, saved, reason, working, errLine,
    h('div', { class: 'st-job-foot' }, btn('Cancel', null, { kind: 'ghost', small: false, onClick: () => dlg.close(null) }), goBtn));
  let busy = false;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    go();
  });
  const dlg = modal({ title: 'Change passphrase', body: form, className: 'st-modal st-change-modal', busy: () => busy });
  paint();
  oldF.focus();

  function problem() {
    if (!oldF.value) return 'Enter your current passphrase.';
    if (!newF.value) return 'Pick a new passphrase — or tap Generate.';
    const min = meetsVaultMinimum(newF.value, { generated: newF.generated });
    if (!min.ok) return min.reason === 'too-short' ? 'Use at least 10 characters — or tap Generate.' : 'Too easy to guess. Add a few more words, or tap Generate.';
    if (newF.generated) return savedBox.checked ? null : 'Tick “I saved it” once the words are stored somewhere safe.';
    if (!confF.value) return 'Type the new passphrase again.';
    if (confF.value.normalize('NFC').trim().replace(/\s+/gu, ' ') !== newF.value.normalize('NFC').trim().replace(/\s+/gu, ' ')) return "The two new passphrases don't match.";
    return null;
  }

  function paint() {
    confF.el.hidden = newF.generated;
    saved.hidden = !newF.generated;
    const p = problem();
    reason.textContent = p ?? 'Ready.';
    reason.classList.toggle('st-ready', !p);
    goBtn.disabled = Boolean(p) || busy;
  }

  async function go() {
    if (busy || problem()) return;
    busy = true;
    errLine.hidden = true;
    working.hidden = false;
    paint();
    for (const fld of [oldF, newF, confF]) fld.setDisabled(true);
    try {
      await v.changePassphrase(oldF.value, newF.value);
      dlg.close(true);
      toast('Passphrase changed. Use the new one next time you unlock.', { kind: 'ok', timeout: 6000 });
    } catch (e) {
      busy = false;
      working.hidden = true;
      for (const fld of [oldF, newF, confF]) fld.setDisabled(false);
      paint();
      if (isCancel(e)) return;
      if (e?.code === 'wrong-passphrase') oldF.setError(userMessage(e));
      else {
        errLine.replaceChildren(icon('warning'), h('span', { text: errorText(e) }));
        errLine.hidden = false;
        goBtn.focus(); // it was disabled while working
      }
    }
  }
  return dlg;
}

/** Asks for the vault passphrase, then runs `run(pass)`; wrong passphrases stay in the dialog. */
function passphraseDialog({ title, text, confirmLabel, danger = false, run }) {
  const f = passphraseField({ label: 'Vault passphrase', mode: 'enter', purpose: 'unlock', name: 'czd-confirm-pass', onSubmit: () => go() });
  const errLine = h('p', { class: 'hint hint-err st-error', role: 'alert', hidden: true });
  const working = h('p', { class: 'st-working', role: 'status', hidden: true }, h('span', { class: 'st-spin', aria: { hidden: 'true' } }), h('span', { text: 'Checking…' }));
  const goBtn = btn(confirmLabel, null, { kind: danger ? 'danger' : 'primary', small: false, className: 'st-pass-go', onClick: () => go() });
  const body = h('div', { class: 'st-form' }, h('p', { class: 'st-lead-sm', text }), f.el, working, errLine,
    h('div', { class: 'st-job-foot' }, btn('Cancel', null, { kind: 'ghost', small: false, onClick: () => dlg.close(null) }), goBtn));
  let busy = false;
  const dlg = modal({ title, body, className: 'st-modal', busy: () => busy });
  f.focus();
  async function go() {
    if (busy) return;
    if (!f.value) {
      f.setError('Enter your vault passphrase.');
      return;
    }
    busy = true;
    goBtn.disabled = true;
    working.hidden = false;
    errLine.hidden = true;
    try {
      const out = await run(f.value);
      dlg.close(true);
      return out;
    } catch (e) {
      busy = false;
      goBtn.disabled = false;
      working.hidden = true;
      if (isCancel(e)) return undefined;
      if (e?.code === 'wrong-passphrase') f.setError(userMessage(e));
      else {
        errLine.replaceChildren(icon('warning'), h('span', { text: errorText(e) }));
        errLine.hidden = false;
        goBtn.focus(); // it was disabled while working
      }
    }
    return undefined;
  }
  return dlg;
}

/** Shows a new recovery code: 8 groups of 4, Copy (cleared later), Download .txt, "I saved it". */
function showRecoveryCode(code, { replaced = false } = {}) {
  const groups = String(code).split('-');
  const codeEl = h('div', { class: 'st-code', role: 'group', aria: { label: 'Recovery code' } },
    groups.map((g, i) => h('span', { class: 'st-code-group', dataset: { n: String(i + 1) }, text: g })));
  const download = btn('Download .txt', 'download', { onClick: () => saveCode() });
  const body = h('div', { class: 'st-recovery' },
    h('p', { class: 'st-lead-sm', text: `If you ever forget your passphrase, this code opens your vault. It's shown only this once${replaced ? ' — the old code no longer works' : ''}.` }),
    codeEl,
    h('div', { class: 'st-recovery-tools' }, copyButton(() => code, { secret: true, label: 'Copy code' }), download),
    banner({ kind: 'warn', text: 'Save it somewhere safe. Anyone with this code can open your vault.' }));
  const dlg = modal({
    title: 'Your recovery code',
    body,
    className: 'st-modal st-recovery-modal',
    dismissible: false,
    actions: [{ label: 'I saved it', kind: 'primary', value: true, autofocus: true }],
  });
  dlg.then(() => codeEl.replaceChildren());
  return dlg;

  async function saveCode() {
    const name = 'czerode-recovery-code.txt';
    let target;
    try {
      target = await platform.chooseSaveTarget({ name, mime: 'text/plain', count: 1 });
    } catch (e) {
      report(e);
      return;
    }
    if (!target) return;
    const text = `cZEROde recovery code\n\n${code}\n\nAnyone with this code can open your vault. Keep it somewhere safe, away from this device.\n`;
    try {
      const r = await target.write(name, new Blob([text], { type: 'text/plain' }), { mime: 'text/plain' });
      if (r?.staged) downloadFile(r.staged);
      toast('Recovery code saved', { kind: 'ok' });
    } catch (e) {
      await target.abort().catch(() => {});
      report(e);
    }
  }
}

// ───────── settings page

function themePicker() {
  const current = settings.get('theme');
  const cards = THEMES.map((t) => {
    const input = h('input', {
      type: 'radio',
      class: 'visually-hidden st-theme-input',
      name: 'st-theme',
      value: t.id,
      checked: t.id === current,
      on: {
        change: () => {
          if (!input.checked) return;
          setOrWarn('theme', t.id);
          settings.applyTheme(t.id);
          paint();
        },
      },
    });
    const preview = h('span', { class: 'st-tp', dataset: { theme: t.id }, aria: { hidden: 'true' } },
      h('span', { class: 'st-tp-bar' },
        h('span', { class: 'st-tp-logo' }, h('span', { class: 'st-tp-c', text: 'c' }), 'ZER', h('span', { class: 'st-tp-o', text: 'O' }), 'de'),
        h('span', { class: 'st-tp-tabs' }, h('span'), h('span'), h('span'))),
      h('span', { class: 'st-tp-body' },
        h('span', { class: 'st-tp-title', text: 'Vault' }),
        h('span', { class: 'st-tp-grid' }, h('span'), h('span'), h('span')),
        h('span', { class: 'st-tp-btn', text: 'Unlock' })));
    return h('label', { class: 'st-theme', dataset: { theme: t.id } },
      input,
      preview,
      h('span', { class: 'st-theme-text' },
        h('span', { class: 'st-theme-name' }, h('span', { text: t.name }), h('span', { class: 'st-theme-check', aria: { hidden: 'true' } }, icon('check'))),
        h('span', { class: 'st-theme-desc', text: t.text })));
  });
  const el = h('div', { class: 'st-themes', role: 'radiogroup', aria: { label: 'Theme' } }, cards);
  function paint() {
    const now = settings.get('theme');
    for (const c of cards) {
      const on = c.dataset.theme === now;
      c.classList.toggle('st-theme-on', on);
      c.querySelector('input').checked = on;
    }
  }
  paint();
  const off = state.on('settings', (s) => {
    if (s?.key === 'theme') paint();
  });
  return { el, destroy: off };
}

function settingsPage(host, ctx, route) {
  const offs = [];
  const vaultOffs = [];
  let alive = true;
  const theme = themePicker();
  offs.push(theme.destroy);

  // Security
  const seg = (name, options, label) => segmented({ label, options, value: settings.get(name), onChange: (val) => setOrWarn(name, val) });
  const idle = seg('idleLockMin', IDLE_OPTS, 'Lock after inactivity');
  const hidden = seg('hiddenLock', HIDDEN_OPTS, 'Lock when in the background');
  const clip = seg('clipboardClearSec', CLIP_OPTS, 'Clear copied secrets');
  const music = toggle({ label: 'Keep music playing in the background', checked: settings.get('keepAudioWhenHidden'), onChange: (b) => setOrWarn('keepAudioWhenHidden', b) });
  const cover = toggle({ label: 'Hide content in the app switcher', checked: settings.get('privacyCover'), onChange: (b) => setOrWarn('privacyCover', b) });
  const unlockText = h('p', { class: 'st-value' });
  const unlockHint = h('p', { class: 'st-row-hint' });

  const vaultBody = h('div', { class: 'st-vault' });
  const appBody = h('div', { class: 'st-app' });

  const toc = h('nav', { class: 'st-toc', aria: { label: 'Settings sections' } },
    SECTIONS.map((s) => h('button', { type: 'button', class: 'st-toc-link', dataset: { target: s.id }, on: { click: () => jump(s.id, true) } }, icon(s.icon), h('span', { text: s.label }))),
    h('a', { class: 'st-toc-link st-toc-about', href: '#/about' }, icon('info'), h('span', { text: 'About & security' })));

  const sections = h('div', { class: 'st-sections' },
    section({ id: 'appearance', iconId: 'eye', title: 'Appearance', sub: 'Pick a look. It changes right away and stays on this device.' },
      h('div', { class: 'st-row st-row-wide' }, theme.el)),
    section({ id: 'security', iconId: 'key', title: 'Security', sub: 'When cZEROde locks itself, and what it clears.' },
      row({ label: 'Lock after inactivity', hint: 'No taps, keys or playing media for this long.', control: idle.el }),
      row({ label: 'Lock when in the background', hint: 'Switching apps or tabs counts. Open file pickers don’t.', control: hidden.el }),
      row({ label: 'Keep music playing in the background', labelFor: music.id, hint: 'Background time doesn’t count while music plays; it locks when the music stops.', control: music.el }),
      row({ label: 'Hide content in the app switcher', labelFor: cover.id, hint: 'Covers the screen with the logo when you switch away.', control: cover.el }),
      row({ label: 'Clear copied secrets', hint: 'cZEROde tries to clear the clipboard after the time you pick (only while it’s in front). Clipboard history apps may keep a copy.', control: clip.el }),
      row({ label: 'Unlock time', hint: unlockHint, control: unlockText, className: 'st-row-unlock' }),
      h('p', { class: 'st-note' }, icon('info'), h('span', { text: LOCK_COPY }))),
    section({ id: 'vault', iconId: 'lock', title: 'Vault', sub: 'Storage, backups and what unlocks your vault.' }, vaultBody),
    section({ id: 'app', iconId: 'settings', title: 'App', sub: 'Version, updates and help.' }, appBody));

  const el = h('div', { class: 'st-page st-page-settings' },
    h('header', { class: 'st-head' },
      h('p', { class: 'st-eyebrow', text: 'Your device, your rules' }),
      h('h1', { class: 'st-title', text: 'Settings' }),
      h('p', { class: 'st-lead', text: 'Everything here stays on this device. Each browser and each app install has its own vault and its own settings.' })),
    h('div', { class: 'st-layout' }, toc, sections));
  host.append(el);

  function markToc(id) {
    for (const b of toc.querySelectorAll('[data-target]')) {
      const on = b.dataset.target === id;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
      // Horizontal chips (tablet/phone): keep the current one in view without scrolling the page.
      if (on && toc.scrollWidth > toc.clientWidth) toc.scrollLeft = Math.max(0, b.offsetLeft - toc.offsetLeft - 16);
    }
  }

  function jump(id, smooth) {
    const target = el.querySelector(`#st-${id}`);
    if (!target) return;
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: smooth && !reduce ? 'smooth' : 'auto', block: 'start' });
    markToc(id);
    target.querySelector('.st-sec-title')?.setAttribute('tabindex', '-1');
    if (smooth) target.querySelector('.st-sec-title')?.focus({ preventScroll: true });
  }

  // The index follows the scroll: the first section whose top part is on screen is "current".
  let spy = null;
  if (typeof globalThis.IntersectionObserver === 'function') {
    const seen = new Map();
    spy = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(e.target.dataset.section, e.isIntersecting);
      const first = SECTIONS.find((sec) => seen.get(sec.id));
      if (first) markToc(first.id);
    }, { rootMargin: '-90px 0px -45% 0px' });
    for (const sec of sections.querySelectorAll('.st-sec')) spy.observe(sec);
  }

  // ───── security: unlock time
  function paintUnlock() {
    const v = ctx.vault;
    // kdf.lastMs is the last Argon2 run of any kind (the boot probe too): only trusted right after an unlock-type run.
    const ms = Number.isFinite(v?.lastUnlockMs) && v.lastUnlockMs > 0 ? v.lastUnlockMs
      : (v?.status === 'unlocked' && Number.isFinite(kdf.lastMs) && kdf.lastMs > 0 ? kdf.lastMs : null);
    unlockText.textContent = ms ? `~${Math.round(ms).toLocaleString()} ms` : '—';
    const p = v?.kdfParams;
    const params = p ? `Argon2id · ${Math.round(p.m / 1024)} MiB · ${plural(p.t, 'pass', 'passes')}${v.floor ? ' (lighter protection for low memory)' : ''}` : 'Argon2id';
    unlockHint.textContent = ms
      ? `Unlock takes ~${Math.round(ms).toLocaleString()} ms on this device. ${params}. Every guess costs an attacker the same.`
      : v?.status === 'locked' || v?.status === 'unlocked' ? `Unlock once to measure it on this device. ${params}.` : `Measured when you create or unlock a vault on this device. ${params}.`;
  }

  // ───── keyboard focus across repaints of the vault section (its rows are rebuilt on every vault change)
  const FOCUS_ALT = Object.freeze({ 'st-rec-remove': 'st-rec-create', 'st-delete': 'st-restore', 'st-keep': 'st-export' });
  let pendingFocus = null;
  const stClass = (el) => [...(el?.classList ?? [])].find((c) => c.startsWith('st-') && c !== 'st-row');
  /** After a dialog opened from `cls` closes (or a repaint dropped the focused button), focus its successor. */
  function wantFocus(cls) {
    if (!alive || !cls) return;
    pendingFocus = cls;
    tryFocus();
  }
  function tryFocus() {
    if (!pendingFocus) return;
    const d = globalThis.document;
    const a = d?.activeElement;
    if (a && d.getElementById('modals')?.contains(a)) return; // a dialog is up: when it closes
    if (a && a !== d.body && a.isConnected) {
      // Focus is somewhere real (back on its button, or the user moved on): a repaint records it again if needed.
      pendingFocus = null;
      return;
    }
    const want = pendingFocus;
    pendingFocus = null;
    const pick = (c) => (c ? vaultBody.querySelector(`.${c}:not([disabled])`) : null);
    const target = pick(want) ?? pick(FOCUS_ALT[want]) ?? d.getElementById('st-vault-title');
    if (target) {
      if (target.id === 'st-vault-title') target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  }
  /** Runs a dialog flow opened by the `cls` button; focus comes back to that button (or its successor). */
  const track = (p, cls) => Promise.resolve(p).finally(() => wantFocus(cls));

  // ───── vault section
  let paintSeq = 0;
  let paintQueued = false;
  function queueVault() {
    if (paintQueued) return;
    paintQueued = true;
    Promise.resolve().then(() => {
      paintQueued = false;
      paintVault();
      paintUnlock();
      paintApp();
    });
  }

  function hookVault() {
    for (const off of vaultOffs.splice(0)) off();
    const v = ctx.vault;
    if (!v || typeof v.addEventListener !== 'function') return;
    for (const type of ['status', 'meta', 'items']) {
      const fn = () => queueVault();
      v.addEventListener(type, fn);
      vaultOffs.push(() => v.removeEventListener(type, fn));
    }
  }

  async function paintVault() {
    const seq = ++paintSeq;
    const v = ctx.vault;
    const status = v?.status ?? 'unavailable';
    const unlocked = status === 'unlocked';
    let info = null;
    try {
      info = v ? await v.storage() : null;
    } catch {
      info = null;
    }
    const persisted = platform.isTauri ? true : await platform.storage.persisted();
    const est = await platform.storage.estimate();
    if (!alive || seq !== paintSeq) return;
    const rows = [];

    const pill = h('span', { class: ['st-status', `st-status-${status}`] }, icon(unlocked ? 'unlock' : status === 'locked' ? 'lock' : status === 'none' ? 'info' : 'warning'), h('span', { text: STATUS_LABEL[status] ?? status }));
    const where = v?.storeKind ? `Stored in ${STORE_LABEL[v.storeKind] ?? v.storeKind}.` : null;
    let statusHint = where;
    let statusCtl = null;
    if (status === 'none') {
      statusHint = 'There is no vault on this device yet. Create one, or restore a .czb backup.';
      statusCtl = h('a', { class: 'btn btn-sm btn-primary', href: '#/vault' }, icon('plus'), h('span', { text: 'Create a vault' }));
    } else if (status === 'locked') {
      statusHint = [where, 'Unlock it to back it up or change its passphrase.'].filter(Boolean).join(' ');
      statusCtl = h('a', { class: 'btn btn-sm btn-primary', href: '#/vault' }, icon('unlock'), h('span', { text: 'Unlock' }));
    } else if (status === 'other-tab') {
      statusHint = 'Another tab holds the vault. Only one tab can use it at a time.';
      statusCtl = btn('Use it here', 'refresh', {
        kind: 'primary',
        onClick: async () => {
          try {
            await v.useHere();
          } catch (e) {
            report(e);
          }
        },
      });
    } else if (status === 'unavailable') {
      statusHint = userMessage('store-unavailable');
    }
    rows.push(row({ label: 'Status', hint: statusHint, control: h('div', { class: 'st-ctl-row' }, pill, statusCtl ?? '') , className: 'st-row-status' }));

    // Storage (§4.3): count + bytes; quota/usage/persisted on the web; "N items · X" only on the desktop.
    if (status === 'locked' || status === 'unlocked') {
      const bar = storageBar(platform.isTauri ? { count: info?.count ?? 0, itemBytes: info?.itemBytes ?? 0 } : {
        count: info?.count ?? 0, itemBytes: info?.itemBytes ?? 0, usage: info?.usage ?? est?.usage ?? null, quota: info?.quota ?? est?.quota ?? null, persisted: info?.persisted ?? persisted,
      });
      bar.classList.add('st-storage');
      const keep = !platform.isTauri && persisted !== true ? btn('Keep my data', 'check', { kind: 'primary', className: 'st-keep', onClick: () => track(keepData(), 'st-keep') }) : null;
      const storageHint = platform.isTauri
        ? 'Your vault lives in this app’s data folder. Uninstalling may delete it — keep a backup.'
        : persisted === true
          ? 'The browser won’t clear your vault on its own. Clearing site data still deletes it — only a .czb backup survives that.'
          : 'The browser may clear storage when space runs low. “Keep my data” asks it not to; installing the app helps too.';
      rows.push(h('div', { class: 'st-row st-row-wide st-row-storage' }, bar, h('div', { class: 'st-storage-foot' }, h('p', { class: 'st-row-hint', text: storageHint }), keep ?? '')));
    } else if (status === 'none' && !platform.isTauri && persisted !== true) {
      rows.push(row({
        label: 'Keep my data',
        hint: 'The browser may clear storage when space runs low. This asks it not to; installing the app helps too.',
        control: btn('Keep my data', 'check', { className: 'st-keep', onClick: () => track(keepData(), 'st-keep') }),
      }));
    }

    if (status !== 'unavailable' && status !== 'loading') {
      // Backups
      const last = v?.lastBackupAt ? `Last backup ${ago(v.lastBackupAt)} (${fmtDate(v.lastBackupAt)}).` : status === 'none' ? null : 'Never backed up.';
      const free = est && Number.isFinite(est.quota) && Number.isFinite(est.usage) ? Math.max(0, est.quota - est.usage) : null;
      const sizeLine = unlocked && info && Number.isFinite(info.itemBytes) ? `About ${fmtSize(info.itemBytes)}${free !== null && !platform.isTauri ? ` · ~${fmtSize(free)} free` : ''}.` : null;
      if (status !== 'none') {
        rows.push(row({
          label: 'Back up',
          hint: [`One .czb file with everything — still encrypted, opens with your passphrase or recovery code.`, sizeLine, last].filter(Boolean).join(' '),
          control: btn('Export backup', 'download', { kind: unlocked ? 'primary' : undefined, disabled: !unlocked, className: 'st-export', onClick: () => track(openBackupExport(), 'st-export') }),
        }));
      }
      rows.push(row({
        label: status === 'none' ? 'Restore a backup' : 'Restore or merge a backup',
        hint: status === 'none' ? 'A .czb backup becomes this device’s vault.' : 'Adds the items of a .czb to this vault. Items you already have are skipped.',
        control: btn(status === 'none' ? 'Restore backup' : 'Merge backup', 'upload', { className: 'st-restore', disabled: status === 'other-tab', onClick: () => track(openRestoreDialog(), 'st-restore') }),
      }));
    }

    if (unlocked || status === 'locked') {
      rows.push(row({
        label: 'Passphrase',
        hint: unlocked ? 'Changes what unlocks the vault on this device. Old backups still open with the old one.' : 'Unlock first to change it.',
        control: btn('Change passphrase', 'key', { className: 'st-change', disabled: !unlocked, onClick: () => track(changePassphraseDialog(v), 'st-change') }),
      }));
      const rec = v.hasRecovery;
      rows.push(row({
        label: 'Recovery code',
        hint: rec ? 'On. The code opens the vault if you forget your passphrase — keep it away from this device.' : 'Off. Without a code, a forgotten passphrase means your files are gone.',
        control: h('div', { class: 'st-ctl-row' },
          h('span', { class: ['badge', rec ? 'badge-ok' : 'badge-warn', 'st-rec-badge'] }, icon(rec ? 'check' : 'warning'), h('span', { text: rec ? 'On' : 'Off' })),
          btn(rec ? 'Replace code' : 'Create code', rec ? 'refresh' : 'plus', { className: 'st-rec-create', onClick: () => track(createRecovery(v), 'st-rec-create') }),
          rec ? btn('Remove', 'trash', { kind: 'ghost', className: 'st-rec-remove', onClick: () => track(removeRecovery(v), 'st-rec-remove') }) : ''),
      }));
      rows.push(row({
        label: 'Delete vault',
        hint: 'Deletes every item in this vault on this device. There is no undo — only a .czb backup brings it back.',
        control: btn('Delete vault', 'trash', { kind: 'danger', className: 'st-delete', onClick: () => track(deleteVault(v), 'st-delete') }),
        className: 'st-row-danger',
      }));
    }
    const a = globalThis.document?.activeElement;
    if (a && vaultBody.contains(a)) pendingFocus = stClass(a) ?? null;
    vaultBody.replaceChildren(...rows);
    tryFocus();
  }

  async function keepData() {
    const ok = await platform.storage.persist();
    if (ok === true) toast("Protected — the browser won't clear your vault on its own.", { kind: 'ok' });
    else toast("The browser didn't allow it. Install the app or back up regularly.", { kind: 'warn', timeout: 6000 });
    queueVault();
  }

  function createRecovery(v) {
    return passphraseDialog({
      title: v.hasRecovery ? 'Replace recovery code' : 'Create recovery code',
      text: v.hasRecovery ? 'A new code replaces the old one; the old code stops working. Enter your passphrase to continue.' : 'The code opens your vault if you ever forget your passphrase. Enter your passphrase to continue.',
      confirmLabel: v.hasRecovery ? 'Replace code' : 'Create code',
      run: async (pass) => {
        const replaced = v.hasRecovery;
        const code = await v.setRecovery(pass);
        // Opened after the passphrase dialog has closed (same tick): one layer at a time.
        Promise.resolve().then(() => track(showRecoveryCode(code, { replaced }), 'st-rec-create'));
        return code;
      },
    });
  }

  function removeRecovery(v) {
    return passphraseDialog({
      title: 'Remove recovery code',
      text: 'After this, only your passphrase opens the vault. Forget it and your files are gone. Enter your passphrase to continue.',
      confirmLabel: 'Remove code',
      danger: true,
      run: async (pass) => {
        await v.removeRecovery(pass);
        toast('Recovery code removed.', { kind: 'ok' });
      },
    });
  }

  async function deleteVault(v) {
    const ok = await confirmDialog({
      title: 'Delete vault?',
      message: `This deletes every item in the vault on this device. There is no undo.\n\nMake a backup first if you might want anything back.`,
      confirmLabel: 'Delete vault',
      danger: true,
      typed: 'DELETE',
    });
    if (!ok) return;
    try {
      await v.destroy();
      toast('Vault deleted.', { kind: 'ok' });
    } catch (e) {
      report(e);
    }
    queueVault();
  }

  // ───── app section
  function paintApp() {
    const rows = [];
    rows.push(row({
      label: 'Version',
      hint: `${platformLabel()}. No accounts, no servers, no network requests.`,
      control: h('span', { class: 'st-version' }, h('span', { class: 'logo' }, h('span', { class: 'logo-c', text: 'c' }), 'ZER', h('span', { class: 'logo-o', text: 'O' }), 'de'), h('span', { class: 'pill', text: VERSION })),
    }));
    if (!platform.isTauri) {
      const ready = state.get('sw.updateReady') === true;
      const blocked = state.get('vault.status') === 'unlocked' || (Number(state.get('busy')) || 0) > 0;
      rows.push(row({
        label: 'Updates',
        hint: ready
          ? (blocked ? 'Update ready — it installs after you lock the vault and running jobs finish.' : 'Update ready — reload to get it.')
          : 'Updates download in the background and wait for your OK. Never while your vault is open.',
        control: ready
          ? btn(updateQueued ? 'Waiting for lock' : blocked ? 'Update after lock' : 'Reload to update', 'refresh', { kind: 'primary', className: 'st-update', disabled: updateQueued, onClick: () => applyUpdate() })
          : h('span', { class: 'badge' }, icon('check'), h('span', { text: 'No update waiting' })),
      }));
    } else {
      rows.push(row({
        label: 'Get the latest version',
        hint: 'The desktop app doesn’t update itself. New versions are on the releases page.',
        control: btn('Open releases', 'download', { onClick: () => platform.openExternal(RELEASES_URL).catch(report) }),
      }));
    }
    rows.push(row({ label: 'Quick tour', hint: 'Five short steps: vault, sending, messages, backups.', control: btn('Show tour', 'play', { onClick: () => openTutorial() }) }));
    rows.push(row({
      label: 'More',
      hint: 'What cZEROde protects, and old cZEROde 1 stuff.',
      control: h('div', { class: 'st-ctl-row' }, h('a', { class: 'btn btn-sm', href: '#/about' }, icon('info'), h('span', { text: 'About & security' })), h('a', { class: 'btn btn-sm btn-ghost', href: '#/legacy' }, icon('key'), h('span', { text: 'Legacy' }))),
    }));
    appBody.replaceChildren(...rows);
  }

  let updateQueued = false;
  async function applyUpdate() {
    if (updateQueued) return;
    const blocked = state.get('vault.status') === 'unlocked' || (Number(state.get('busy')) || 0) > 0;
    if (blocked) {
      // pwa.applyUpdate waits for a lock (and for running jobs); say so instead of looking stuck.
      updateQueued = true;
      paintApp();
      toast('The update installs as soon as you lock the vault (and running jobs finish).', { kind: 'info', timeout: 6000 });
    }
    try {
      const ok = await pwa.applyUpdate();
      if (!ok) toast('No update is waiting right now.', { kind: 'info' });
    } catch (e) {
      report(e);
    } finally {
      updateQueued = false;
      if (alive) paintApp();
    }
  }

  // ───── wiring
  hookVault();
  offs.push(state.on('vault.status', () => {
    hookVault();
    queueVault();
  }));
  offs.push(state.on('sw.updateReady', () => paintApp()));
  offs.push(state.on('busy', () => paintApp()));
  offs.push(state.on('settings', (s) => {
    if (!s) return;
    if (s.key === 'idleLockMin') idle.set(s.value);
    else if (s.key === 'hiddenLock') hidden.set(s.value);
    else if (s.key === 'clipboardClearSec') clip.set(s.value);
    else if (s.key === 'keepAudioWhenHidden') music.input.checked = Boolean(s.value);
    else if (s.key === 'privacyCover') cover.input.checked = Boolean(s.value);
  }));
  offs.push(state.onPurge(() => queueVault()));
  paintUnlock();
  paintVault();
  paintApp();
  if (route?.parts?.[0]) setTimeout(() => alive && jump(route.parts[0], false), 0);

  return {
    update(r) {
      if (r?.parts?.[0]) jump(r.parts[0], true);
    },
    destroy() {
      alive = false;
      spy?.disconnect();
      for (const off of offs.splice(0)) off();
      for (const off of vaultOffs.splice(0)) off();
      el.remove();
    },
  };
}

// ───────── about page (§6)

/** The Linux build (the desktop media limit of DESIGN §12 applies only there). */
function isLinuxDesktop() {
  const nav = globalThis.navigator;
  const s = `${nav?.userAgentData?.platform ?? ''} ${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`;
  return /linux/i.test(s) && !/android/i.test(s);
}

function aboutPage(host) {
  const clipSec = Number(settings.get('clipboardClearSec')) || 0;
  const li = (iconId, title, text) => h('li', { class: 'st-point' },
    h('span', { class: 'st-point-icon', aria: { hidden: 'true' } }, icon(iconId)),
    h('div', null, h('p', { class: 'st-point-title', text: title }), h('p', { class: 'st-point-text', text })));
  const protects = h('ul', { class: 'st-points st-points-ok' },
    li('lock', 'Your vault, at rest', 'Photos, videos, music, files and notes are encrypted with AES-256-GCM, each with its own random key. Names, types and sizes are encrypted too, sizes are padded, and any tampering, swapping or cutting short is detected.'),
    li('send', 'Files you send', 'A .czd is locked with your passphrase (Argon2id, 64 MiB), authenticated, and its header commits to the key — a wrong passphrase can never open it into garbage.'),
    li('note', 'Secret messages', 'Text messages use Argon2id + AES-GCM with key commitment. The Georgian/Cyrillic look is only camouflage.'));
  const notAgainst = h('ul', { class: 'st-points st-points-no' },
    li('key', 'Weak passphrases', 'We estimate strength and warn you, but a guessable passphrase can be guessed.'),
    li('warning', 'Malware and keyloggers', 'Anything that can watch your screen or keyboard can watch you unlock.'),
    li('unlock', 'Your unlocked device', 'Someone using your device while the vault is open sees what you see. Auto-lock helps; it isn’t magic.'),
    li('settings', 'The browser and the OS', 'cZEROde runs inside them and has to trust them.'),
    li('download', 'Whoever controls the code', 'The GitHub repository, GitHub Pages and the installer deliver the app. If they are compromised, so is the app.'),
    li('info', 'Metadata', 'How many items you have, roughly how big they are, when they were written — and that a file is a cZEROde file.'));
  const good = h('ul', { class: 'st-facts-list' },
    [
      'Previews are decrypted in memory. The browser may swap very large previews to its own temporary files.',
      'Deleting removes data from the app, but the browser may keep old copies on disk until it compacts its storage. The cZEROde 1 web vault also stored names and PIN lengths in plain text.',
      'Changing your passphrase doesn’t revoke the old one from anyone who already has a copy of your vault or a backup.',
      'The camouflage script is cosmetic. The protection is the passphrase.',
      'Old Mixed Script v1–v3 were never encryption, and v4 used a weak PIN key. Re-encrypt anything important in the new vault.',
      'Each browser and each app install has its own vault. Move with a backup (.czb) or Send it to yourself.',
      'Uninstalling or clearing site data deletes the vault. Only a .czb backup survives that.',
      LOCK_COPY,
      clipSec
        ? `Copied secrets: cZEROde tries to clear the clipboard after ${clipSec} s (only while it’s in front). Clipboard history apps may keep a copy.`
        : 'Copied secrets: clearing the clipboard is off (Settings → Security). Clipboard history apps may keep a copy.',
    ].map((t) => h('li', { text: t })));
  const originCard = platform.isTauri ? null : h('section', { class: 'st-origin', aria: { labelledby: 'st-origin-title' } },
    h('div', { class: 'st-origin-head' },
      h('span', { class: 'st-origin-icon', aria: { hidden: 'true' } }, icon('warning')),
      h('h2', { class: 'st-origin-title', id: 'st-origin-title', text: 'The web version shares its address' })),
    h('p', { class: 'st-origin-text', text: WEB_ORIGIN_COPY }),
    h('p', { class: 'st-origin-road', text: 'Roadmap: move cZEROde web to its own domain. Moving then = export a .czb backup on the old site, restore it on the new one.' }));
  const linuxCard = platform.isTauri && isLinuxDesktop() ? h('section', { class: 'st-origin st-origin-info', aria: { labelledby: 'st-linux-title' } },
    h('div', { class: 'st-origin-head' },
      h('span', { class: 'st-origin-icon', aria: { hidden: 'true' } }, icon('video')),
      h('h2', { class: 'st-origin-title', id: 'st-linux-title', text: 'Desktop media on Linux' })),
    h('p', { class: 'st-origin-text', text: 'On Linux the desktop app plays audio and video previews from memory, up to 512 MB. Bigger files: use “Save decrypted copy” and play them with your own player.' })) : null;
  const tech = h('dl', { class: 'st-tech' },
    [
      ['Vault', 'AES-256-GCM per file · random 256-bit file keys · HKDF-SHA256 · encrypted index'],
      ['Passphrase', 'Argon2id · 64 MiB · 3 passes (lighter on low-memory devices)'],
      ['.czd files', 'czd2: Argon2id-wrapped key · header MAC · 256 KiB chunks · padded size'],
      ['Messages', 'Text v2: Argon2id + AES-GCM + key commitment'],
      ['Backups', '.czb v1: the encrypted vault as-is, authenticated'],
      ['Network', 'None. No accounts, no analytics, no servers'],
    ].map(([k, val]) => h('div', { class: 'st-tech-row' }, h('dt', { text: k }), h('dd', { text: val }))));
  const el = h('div', { class: 'st-page st-page-about' },
    h('header', { class: 'st-head' },
      h('p', { class: 'st-eyebrow', text: 'About & security' }),
      h('h1', { class: 'st-title', text: 'Honest security' }),
      h('p', { class: 'st-lead', text: 'What cZEROde protects, what it can’t, and the fine print — in plain language.' })),
    originCard,
    linuxCard,
    h('div', { class: 'st-about-grid' },
      section({ id: 'protects', iconId: 'check', title: 'What it protects' }, protects),
      section({ id: 'limits', iconId: 'warning', title: 'What it can’t protect against' }, notAgainst)),
    section({ id: 'good', iconId: 'info', title: 'Good to know' }, good),
    section({ id: 'tech', iconId: 'settings', title: 'Under the hood' }, tech),
    h('footer', { class: 'st-foot' },
      h('span', { class: 'logo' }, h('span', { class: 'logo-c', text: 'c' }), 'ZER', h('span', { class: 'logo-o', text: 'O' }), 'de'),
      h('span', { class: 'st-foot-ver', text: `${VERSION} · ${platformLabel()}` }),
      h('a', { class: 'st-foot-link', href: '#/settings' }, icon('settings'), h('span', { text: 'Settings' }))));
  host.append(el);
  return { destroy: () => el.remove() };
}

// ───────── ViewModule

/**
 * ViewModule.mount for 'settings' and 'about'.
 * @param {HTMLElement} root
 * @param {import('../types.js').Route} route
 * @param {{vault: any, state: any}} ctx
 */
export function mount(root, route, ctx) {
  const c = ctx ?? { vault: getVault(), state };
  const host = h('div', { class: 'st' });
  root.append(host);
  let top = route?.top === 'about' ? 'about' : 'settings';
  let page = top === 'about' ? aboutPage(host) : settingsPage(host, c, route);
  return {
    update(r) {
      const next = r?.top === 'about' ? 'about' : 'settings';
      if (next !== top) {
        page.destroy();
        top = next;
        page = top === 'about' ? aboutPage(host) : settingsPage(host, c, r);
        return;
      }
      page.update?.(r);
    },
    unmount() {
      page.destroy();
      host.remove();
    },
  };
}
