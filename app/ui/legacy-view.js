// Legacy screen (route 'legacy'; DESIGN §1.9, §3.8, §4.4, §11). Owner: V2b.
// Decode-only access to everything cZEROde 1 made:
// - Old messages: Mixed Script v1–v3 and v4 AES text (auto-detected, "Read as" override, PIN when needed), the
//   letter Legend with the q/y note.
// - Old web vault (only when legacy/oldvault finds czeroode_db; never creates it): names were never encrypted, so
//   the list shows right away; "Unlock with your old PIN" (repeatable) unlocks what that PIN opens; per item
//   Preview / Save / Import, "Import all unlocked" (each import re-opened and verified; old playlists → albums),
//   "Delete old data" (asks first, never automatic).
// - Old desktop .czd: picked or dropped files (web), the old app folder (desktop), state 'legacy.files' (handed
//   over by other views) → PIN → Preview / Save / Import.
// Every lock forgets the old PINs and drops decoded outputs. Node-importable: the DOM is only touched inside functions.

import { CzdError, isCancel, userMessage } from '../errors.js';
import * as state from '../state.js';
import * as platform from '../platform.js';
import * as router from '../router.js';
import * as vaultModule from '../vault/vault.js';
import * as oldvault from '../legacy/oldvault.js';
import { LEGEND, decodeV1, decodeV2, decodeV3, detectLegacyText } from '../legacy/mixed.js';
import { decryptV4Text } from '../legacy/v4.js';
import { isOldCzd, openOldCzd } from '../legacy/oldczd.js';
import { TEXT_MARKER } from '../crypto/textfmt.js';
import { isCzd2, release, verifySource } from '../crypto/container.js';
import { NOTE_TYPE, extOf, fmtDate, fmtSize, kindOf, mimeFromExt, safeFilename } from '../util/format.js';
import { saveDecrypted } from '../media/media.js';
import { announce, h, icon, modal, toast } from '../util/dom.js';
import { banner, copyButton, dropZone, kindIcon, passphraseField, segmented } from './components.js';
import { openViewer } from './viewer.js';
import { openBackupExport } from './settings-view.js';

const VERSIONS = Object.freeze({
  v1: { num: 'I', name: 'origin', title: 'Mixed Script v1', pin: false },
  v2: { num: 'II', name: 'rip 💀', title: 'Mixed Script v2', pin: false },
  v3: { num: 'III', name: 'old cipher', title: 'Mixed Script v3', pin: true },
  v4: { num: 'IV', name: 'cZEROde v1 AES', title: 'cZEROde v4 AES', pin: true },
});
const MAX_MESSAGE = 4 * 2 ** 20;
const LIVE_MS = 150;
const KV_IMPORTED = 'legacy-imported';
const KV_ALBUMS = 'legacy-albums';

const WARN_COPY = 'v1–v3 were never real encryption and v4 used a weak PIN key. Re-encrypt anything important in the new vault.';
const QY_NOTE = 'q and y share a letter in this old format; some letters may be ambiguous.';
const NOTES = Object.freeze({
  v1: 'v1 was a letter swap, not encryption. Capitals became lower case.',
  v2: 'v2 had no key at all — it got cracked in 30 seconds. Noise symbols are dropped.',
  v3: 'v3 can’t tell a wrong PIN: any PIN gives some output. Gibberish means the PIN was wrong.',
  v4: 'Decrypted with the old PIN key (PBKDF2). Save what matters in your new vault.',
});
const FORMAT_LABEL = Object.freeze({ v4: 'v4 AES', v3: 'v3', v2: 'v2', plain: 'not encrypted', bad: 'damaged' });
const KIND_LABEL = Object.freeze({ image: 'Photo', video: 'Video', audio: 'Music', doc: 'Document', note: 'Note', other: 'File' });

// Remembered old PINs never outlive a lock, wherever the user is.
state.onPurge(() => oldvault.forgetPins());

const getVault = () => vaultModule.vault;
const unlocked = () => getVault()?.status === 'unlocked';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function errorText(e) {
  if ((e?.code === 'too-big-to-preview' && e?.detail === 'too-big-to-save') || (e?.code === 'quota-exceeded' && e?.detail === 'staging limit')) {
    return 'Too big to save in this browser — use the desktop app or Chrome.';
  }
  return userMessage(e);
}

function report(e) {
  if (!e || isCancel(e)) return;
  if (!e.code || e.code === 'internal') globalThis.console?.error?.('[legacy]', e);
  toast(errorText(e), { kind: 'err', timeout: 6000 });
}

function needVault() {
  toast(userMessage('vault-locked'), { kind: 'warn', action: { label: 'Open vault', onClick: () => router.navigate('#/vault') } });
}

const btn = (label, iconId, { kind, small = true, onClick, disabled, className, title } = {}) => h('button', {
  type: 'button',
  class: ['btn', small ? 'btn-sm' : null, kind ? `btn-${kind}` : null, className],
  disabled: Boolean(disabled),
  title,
  on: { click: onClick },
}, iconId ? icon(iconId) : null, h('span', { class: 'lg-btn-label', text: label }));

function versionBadge(ver, { small = false } = {}) {
  const v = VERSIONS[ver];
  if (!v) return null;
  return h('span', { class: ['lg-ver', `lg-ver-${ver}`, small ? 'lg-ver-sm' : null], title: v.title },
    h('span', { class: 'lg-ver-num', text: v.num }), h('span', { class: 'lg-ver-name', text: v.name }));
}

const liveUrls = new Set();
state.onPurge(() => {
  for (const u of liveUrls) globalThis.URL?.revokeObjectURL?.(u);
  liveUrls.clear();
});

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

/** A decrypted copy on a 'stage' target: saved right away while the click's activation lasts, else one Save click. */
function deliverStaged(file) {
  const active = globalThis.navigator?.userActivation?.isActive;
  if (active !== false) {
    downloadFile(file);
    toast(`Saved “${safeFilename(file.name)}” to your downloads`, { kind: 'ok' });
    return;
  }
  const save = btn('Save', 'download', { kind: 'primary', small: false, className: 'lg-ready-save', onClick: () => {
    downloadFile(file);
    p.close(true);
  } });
  const p = modal({
    title: 'Ready to save',
    className: 'lg-modal',
    body: h('div', { class: 'stack' }, h('p', { text: 'Your decrypted copy is ready.' }),
      h('div', { class: 'lg-ready' }, h('span', { class: 'lg-ready-name', text: safeFilename(file.name) }), h('span', { class: 'lg-ready-size', text: fmtSize(file.size) }), save)),
    actions: [{ label: 'Close', kind: 'ghost', value: null }],
  });
}

function delivered(out, fallbackName) {
  if (out?.staged) deliverStaged(out.staged);
  else if (out?.where === 'downloads') toast('Download started', { kind: 'ok' });
  else toast(`Saved “${safeFilename(out?.name ?? fallbackName)}”`, { kind: 'ok' });
}

/** decodeOldItem / openOldCzd output → a plain DecryptSource (notes as note JSON, so the viewer/saver treat them as notes). */
function plainSource(r) {
  if (r.note) {
    const title = String(r.note.title ?? '') || 'Note';
    const blob = new Blob([JSON.stringify({ v: 1, title, body: String(r.note.body ?? '') })], { type: NOTE_TYPE });
    return { kind: 'plain', blob, name: title, type: NOTE_TYPE };
  }
  return { kind: 'plain', blob: r.blob, name: safeFilename(r.name), type: String(r.type || 'application/octet-stream') };
}

/**
 * A plain source for the viewer. Image items must really start like an image the browser decodes: an undecodable
 * blob: image makes Chromium refetch the URL (refused by the CSP), so such bytes get the honest "can't show" card.
 */
async function viewerSource(r, kind) {
  const src = plainSource(r);
  if (kind === 'image' && !(await looksLikeImage(src.blob))) throw new CzdError('unsupported-media');
  return src;
}

async function looksLikeImage(blob) {
  const b = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  if (b.length < 12) return false;
  const at = (o, s) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  return (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || (b[0] === 0x89 && at(1, 'PNG')) || at(0, 'GIF8')
    || (at(0, 'RIFF') && at(8, 'WEBP')) || at(0, 'BM') || (at(4, 'ftyp') && ['avif', 'avis'].includes(String.fromCharCode(...b.subarray(8, 12))));
}

/** Adds a decoded old item to the vault and re-opens it (header MAC + every chunk authenticated). -> ItemInfo */
async function importDecoded(v, r) {
  const info = r.note
    ? await v.addNote({ title: r.note.title, body: r.note.body })
    : await v.addFile(new File([r.blob], safeFilename(r.name), { type: r.type || '', lastModified: Number.isFinite(r.mtime) ? r.mtime : Date.now() }));
  const { src, opened } = await v.open(info.id);
  try {
    await verifySource(src, opened);
  } finally {
    release(opened);
  }
  return info;
}

function viewerHere(items, index, onAction) {
  // Never from inside a modal/sheet (the viewer sits below the modal layer).
  openViewer({ items, index, onAction });
}

// ───────── old messages

function messagesCard(ctx) {
  let override = 'auto';
  let detected = null;
  let seq = 0;
  let liveTimer = null;
  let output = null; // {text, version}

  const taId = 'lg-msg';
  const ta = h('textarea', {
    class: 'input lg-msg',
    id: taId,
    rows: 5,
    placeholder: 'Paste an old cZEROde message here — any version.',
    autocomplete: 'off',
    spellcheck: false,
    attrs: { autocapitalize: 'none', autocorrect: 'off', 'data-gramm': 'false' },
  });
  const detectEl = h('div', { class: 'lg-detect', aria: { live: 'polite' } });
  const seg = segmented({
    label: 'Read as',
    value: 'auto',
    options: [{ value: 'auto', label: 'Auto' }, { value: 'v1', label: 'I' }, { value: 'v2', label: 'II' }, { value: 'v3', label: 'III' }, { value: 'v4', label: 'IV' }],
    onChange: (val) => {
      override = val;
      changed();
    },
  });
  const pinF = passphraseField({ label: 'PIN', mode: 'enter', purpose: 'legacy', name: 'czd-legacy-msg-pin', placeholder: 'the PIN it was made with', onSubmit: () => decode() });
  const goBtn = btn('Decode', 'unlock', { kind: 'primary', small: false, className: 'lg-decode', onClick: () => decode() });
  const status = h('p', { class: 'lg-status', role: 'status' });
  const errLine = h('p', { class: 'hint hint-err lg-error', role: 'alert', hidden: true });
  const outSlot = h('div', { class: 'lg-out-slot' });

  const legend = h('details', { class: 'lg-legend' },
    h('summary', { class: 'lg-legend-sum' }, icon('list'), h('span', { text: 'Legend — the old letter chart' }), h('span', { class: 'lg-legend-chev', aria: { hidden: 'true' } }, icon('back'))),
    h('div', { class: 'lg-legend-body' },
      h('p', { class: 'lg-legend-lead', text: 'Mixed Script swapped every letter for a look-alike: lower case → Georgian, capitals → Cyrillic. v2 then scrambled the order and sprinkled noise; v3 shuffled the alphabet with your PIN.' }),
      h('ul', { class: 'lg-chart', aria: { label: 'Letter chart' } }, LEGEND.map((r) => h('li', {
        class: ['lg-cell', r.geoShared ? 'lg-cell-shared' : null, r.cyrShared ? 'lg-cell-cshared' : null],
        title: `${r.latin} → ${r.geo} (reads back as ${r.geoReadsAs}) · ${r.latin.toUpperCase()} → ${r.cyr} (reads back as ${r.cyrReadsAs})`,
      },
      h('span', { class: 'lg-cell-geo', text: r.geo }),
      h('span', { class: 'lg-cell-lat', text: r.latin }),
      h('span', { class: 'lg-cell-cyr', text: r.cyr })))),
      h('p', { class: 'lg-legend-note' }, icon('warning'), h('span', { text: `${QY_NOTE} ყ always reads back as y. Capitals share too — B/V → В, C/S → С, F/Q → Ф, H/N → Н, P/R → Р — and case is lost.` }))));

  const el = h('section', { class: 'card lg-card lg-msgs', aria: { labelledby: 'lg-msgs-title' } },
    h('header', { class: 'lg-card-head' },
      h('span', { class: 'lg-card-icon', aria: { hidden: 'true' } }, icon('note')),
      h('div', { class: 'lg-card-titles' },
        h('h2', { class: 'lg-card-title', id: 'lg-msgs-title', text: 'Old messages' }),
        h('p', { class: 'lg-card-sub', text: 'Paste a message from any old version — it figures out which one.' }))),
    h('div', { class: 'lg-card-body' },
      h('label', { class: 'label', for: taId, text: 'Old message' }),
      ta,
      h('div', { class: 'lg-msg-bar' }, detectEl, h('span', { class: 'lg-gap' }), h('span', { class: 'lg-readas micro', text: 'Read as' }), seg.el),
      pinF.el,
      h('div', { class: 'lg-actions' }, goBtn, status),
      errLine,
      outSlot,
      legend));

  ta.addEventListener('input', () => changed());
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      decode();
    }
  });

  const mode = () => (override !== 'auto' ? override : detected);

  function setError(msg) {
    errLine.replaceChildren(...(msg ? [icon('warning'), h('span', { text: msg })] : []));
    errLine.hidden = !msg;
  }

  function paintDetect() {
    const s = ta.value;
    const t = s.trim();
    detectEl.replaceChildren();
    if (!t) {
      detectEl.append(h('span', { class: 'lg-detect-idle', text: 'Waiting for a message' }));
      return;
    }
    if (t.startsWith(TEXT_MARKER)) {
      detectEl.append(h('span', { class: 'lg-detect-new' }, h('span', { text: 'This is a new cZEROde message. ' }), h('a', { href: '#/text', text: 'Open it in Text →' })));
      return;
    }
    const m = mode();
    if (!m) {
      detectEl.append(h('span', { class: 'lg-detect-none', text: 'Doesn’t look like an old message' }));
      return;
    }
    detectEl.append(h('span', { class: 'lg-detect-label', text: override === 'auto' ? 'Looks like' : 'Reading as' }), versionBadge(m));
  }

  function changed() {
    clearTimeout(liveTimer);
    const s = ta.value;
    detected = s.length > MAX_MESSAGE ? null : detectLegacyText(s);
    const m = mode();
    pinF.el.hidden = !(m && VERSIONS[m].pin);
    el.dataset.version = m ?? '';
    paintDetect();
    setError(null);
    seq++;
    status.textContent = '';
    goBtn.disabled = false;
    if (output && output.source !== s) clearOutput();
    // Keyless formats decode as you type.
    if ((m === 'v1' || m === 'v2') && s.trim()) liveTimer = setTimeout(() => decode({ quiet: true }), LIVE_MS);
    else if (m && VERSIONS[m].pin && s.trim()) status.textContent = 'Enter the PIN, then Decode.';
  }

  function clearOutput() {
    output = null;
    outSlot.replaceChildren();
  }

  async function decode({ quiet = false } = {}) {
    clearTimeout(liveTimer);
    const s = ta.value;
    const m = mode();
    setError(null);
    if (!s.trim()) {
      if (!quiet) setError('Paste an old message first.');
      return;
    }
    if (s.length > MAX_MESSAGE) {
      setError('That’s too long for an old cZEROde message.');
      return;
    }
    if (!m) {
      if (!quiet) setError('That doesn’t look like an old cZEROde message. Pick a version under “Read as” to force it.');
      return;
    }
    if (VERSIONS[m].pin && !pinF.value) {
      if (!quiet) pinF.setError('Enter the PIN it was made with.');
      return;
    }
    const my = ++seq;
    const notes = [];
    let extra = null;
    let text;
    try {
      if (m === 'v1') {
        const r = decodeV1(s);
        text = r.text;
        if (r.ambiguousQY) notes.push(QY_NOTE);
      } else if (m === 'v2') {
        const r = decodeV2(s);
        text = r.text;
        extra = `Method ${r.methodName}`;
      } else if (m === 'v3') {
        const r = decodeV3(s, pinF.value);
        text = r.text;
        if (r.ambiguousQY) notes.push(QY_NOTE);
      } else {
        goBtn.disabled = true;
        status.replaceChildren(h('span', { class: 'lg-spin', aria: { hidden: 'true' } }), h('span', { text: '◀ Decrypting' }));
        text = await decryptV4Text(s, pinF.value);
      }
    } catch (e) {
      if (my !== seq) return;
      goBtn.disabled = false;
      status.textContent = '';
      clearOutput();
      if (isCancel(e)) return;
      if (e?.code === 'legacy-wrong-pin') pinF.setError(userMessage(e));
      else if (!quiet || e?.code !== 'legacy-not-ciphertext') setError(userMessage(e));
      return;
    }
    if (my !== seq) return;
    goBtn.disabled = false;
    status.textContent = '';
    showOutput({ source: s, text, version: m, extra, notes });
  }

  function showOutput({ source, text, version, extra, notes }) {
    output = { source, text, version, extra, notes };
    const pre = h('pre', { class: 'lg-out-text', tabIndex: 0, text, aria: { label: 'Decoded message' } });
    const tools = h('div', { class: 'lg-out-tools' },
      copyButton(() => output?.text ?? '', { secret: true }),
      unlocked() ? btn('Save to vault as note', 'lock', { className: 'lg-save-note', onClick: () => saveNote() }) : null);
    const box = h('div', { class: 'lg-out', dataset: { version } },
      h('div', { class: 'lg-out-head' },
        h('span', { class: 'lg-out-title', text: 'Decoded' }),
        versionBadge(version, { small: true }),
        extra ? h('span', { class: 'lg-out-extra', text: extra }) : null),
      pre,
      [...notes, NOTES[version]].map((n, i) => h('p', { class: ['lg-out-note', i < notes.length ? 'lg-out-warn' : null] }, icon(i < notes.length ? 'warning' : 'info'), h('span', { text: n }))),
      tools);
    outSlot.replaceChildren(box);
    announce('Decoded');
  }

  async function saveNote() {
    const v = getVault();
    if (!v || v.status !== 'unlocked') {
      needVault();
      return;
    }
    if (!output) return;
    const ver = VERSIONS[output.version];
    try {
      await v.addNote({ title: `Old message (${ver.title})`, body: output.text });
      toast('Saved to your vault as a note.', { kind: 'ok' });
    } catch (e) {
      report(e);
    }
  }

  function purge() {
    clearTimeout(liveTimer);
    seq++;
    ta.value = '';
    pinF.clear();
    clearOutput();
    changed();
  }

  changed();
  return {
    el,
    purge,
    refresh() {
      if (output) showOutput(output);
    },
    destroy() {
      clearTimeout(liveTimer);
      purge();
    },
  };
}

// ───────── old web vault

function oldVaultCard(ctx, { onGone }) {
  let alive = true;
  let counts = null;
  let items = [];
  const imported = new Map(); // old id → new vault id
  const albums = new Map(); // old playlist id → vault list id
  const failed = new Map(); // old id → message
  let job = null; // {ctl, done, total, name}
  let pinBusy = false;

  const pinF = passphraseField({ label: 'Old PIN', mode: 'enter', purpose: 'legacy', name: 'czd-legacy-vault-pin', placeholder: 'one of your old PINs', onSubmit: () => unlockWithPin() });
  const pinBtn = btn('Unlock', 'unlock', { kind: 'primary', small: false, className: 'lg-pin-go', onClick: () => unlockWithPin() });
  const pinStatus = h('p', { class: 'lg-pin-status', role: 'status' });
  const sub = h('p', { class: 'lg-card-sub' });
  const stats = h('div', { class: 'lg-stats' });
  const toolbar = h('div', { class: 'lg-toolbar' });
  const jobSlot = h('div', { class: 'lg-job-slot' });
  const listSlot = h('div', { class: 'lg-items-slot' });
  const pinBar = h('div', { class: 'lg-pinbar' }, h('div', { class: 'lg-pinbar-field' }, pinF.el), pinBtn);
  const el = h('section', { class: 'card lg-card lg-oldvault', hidden: true, aria: { labelledby: 'lg-ov-title' } },
    h('header', { class: 'lg-card-head' },
      h('span', { class: 'lg-card-icon', aria: { hidden: 'true' } }, icon('album')),
      h('div', { class: 'lg-card-titles' }, h('h2', { class: 'lg-card-title', id: 'lg-ov-title', text: 'Old web vault' }), sub)),
    h('div', { class: 'lg-card-body' },
      stats,
      pinBar,
      pinStatus,
      toolbar,
      jobSlot,
      listSlot));

  async function load() {
    try {
      counts = await oldvault.probeOldVault();
    } catch {
      counts = null;
    }
    if (!alive) return;
    if (!counts) {
      el.hidden = true;
      onGone?.();
      return;
    }
    el.hidden = false;
    await loadMaps();
    await relist();
  }

  async function loadMaps() {
    const v = getVault();
    if (!v || typeof v.kvGet !== 'function') return;
    // Merged into what this page already knows (an import in progress is ahead of the stored copy).
    const merge = (map, obj) => {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, id] of Object.entries(obj)) if (typeof id === 'string' && !map.has(k)) map.set(k, id);
    };
    try {
      merge(imported, await v.kvGet(KV_IMPORTED));
      merge(albums, await v.kvGet(KV_ALBUMS));
    } catch {
      // the vault database is unavailable: nothing marked
    }
  }

  async function saveMaps() {
    const v = getVault();
    if (!v || typeof v.kvSet !== 'function') return;
    try {
      await v.kvSet(KV_IMPORTED, Object.fromEntries(imported));
      await v.kvSet(KV_ALBUMS, Object.fromEntries(albums));
    } catch (e) {
      globalThis.console?.warn?.('[legacy] could not remember imports', e);
    }
  }

  async function relist() {
    try {
      items = await oldvault.listOldItems();
    } catch (e) {
      if (e?.code === 'legacy-no-db') {
        el.hidden = true;
        onGone?.();
        return;
      }
      items = [];
      report(e);
    }
    if (!alive) return;
    paint();
  }

  /** Imported and still in the vault (when we can tell). */
  function isImported(id) {
    const nid = imported.get(id);
    if (!nid) return false;
    const st = getVault()?.status;
    if (st !== 'unlocked') return st === 'locked'; // can't check while locked; no vault → nothing imported
    try {
      getVault().item(nid);
      return true;
    } catch {
      return false;
    }
  }

  const importable = () => items.filter((e) => e.unlocked && e.format !== 'bad' && !isImported(e.id));

  function paint() {
    const notes = items.filter((e) => e.store === 'vault');
    const files = items.filter((e) => e.store === 'files');
    const open = items.filter((e) => e.unlocked).length;
    const done = items.filter((e) => isImported(e.id)).length;
    sub.textContent = `Found in this browser: ${[plural(counts?.notes ?? notes.length, 'note'), plural(counts?.files ?? files.length, 'file'), plural(counts?.playlists ?? 0, 'playlist')].join(' · ')}. Names were never encrypted.`;
    stats.replaceChildren(
      stat(String(items.length), 'items'),
      stat(String(open), 'unlocked', open ? 'ok' : null),
      stat(String(done), 'in your vault', done ? 'gold' : null),
      stat(String(items.length - open), 'still locked', items.length - open ? 'dim' : null));
    const allOpen = items.length > 0 && open === items.length;
    pinBar.hidden = allOpen;
    if (allOpen && !pinStatus.textContent) pinStatus.textContent = 'Everything is unlocked.';
    const n = importable().length;
    const canImport = unlocked() && n > 0 && !job;
    toolbar.replaceChildren(
      btn(n ? `Import all unlocked (${n})` : 'Import all unlocked', 'download', { kind: 'primary', small: false, className: 'lg-import-all', disabled: !canImport, onClick: () => importAll() }),
      !unlocked() ? h('p', { class: 'lg-toolbar-hint' }, icon('lock'), h('span', null, 'Imports go into your new vault — ', h('a', { href: '#/vault', text: 'unlock it first' }), '.')) : h('span', { class: 'lg-gap' }),
      btn('Delete old data', 'trash', { kind: 'danger', small: false, className: 'lg-delete-old', disabled: Boolean(job), onClick: () => deleteOld() }));
    listSlot.replaceChildren(
      notes.length ? group('Notes', notes) : '',
      files.length ? group('Files', files) : '',
      counts?.playlists ? h('p', { class: 'lg-playlists' }, icon('album'), h('span', { text: `${plural(counts.playlists, 'old playlist')} — they become albums when their songs are imported.` })) : '');
  }

  function stat(value, label, tone) {
    return h('div', { class: ['lg-stat', tone ? `lg-stat-${tone}` : null] }, h('span', { class: 'lg-stat-val', text: value }), h('span', { class: 'lg-stat-label', text: label }));
  }

  function group(title, list) {
    return h('div', { class: 'lg-group' },
      h('p', { class: 'lg-group-title micro', text: `${title} · ${list.length}` }),
      h('ul', { class: 'lg-items' }, list.map((e) => itemRow(e))));
  }

  function stateOf(e) {
    if (e.format === 'bad') return { key: 'bad', label: 'Damaged', icon: 'warning', badge: 'badge-err' };
    if (isImported(e.id)) return { key: 'imported', label: 'In vault', icon: 'check', badge: 'badge-gold' };
    if (!e.unlocked) return { key: 'locked', label: 'Locked', icon: 'lock', badge: '' };
    return { key: 'open', label: 'Unlocked', icon: 'unlock', badge: 'badge-ok' };
  }

  function itemRow(e) {
    const st = stateOf(e);
    const kind = e.store === 'vault' ? 'note' : e.kind;
    const meta = [KIND_LABEL[kind] ?? 'File', FORMAT_LABEL[e.format] ?? e.format, e.date ? fmtDate(e.date) : null, fmtSize(e.size), e.chunked ? 'batched' : null].filter(Boolean).join(' · ');
    const ready = e.unlocked && e.format !== 'bad';
    const fail = failed.get(e.id);
    const tags = [];
    if (e.format === 'v3') tags.push(h('span', { class: 'badge badge-warn lg-tag', title: 'v3 notes are decoded with a PIN that can’t be checked — the result may be gibberish.', text: 'best effort' }));
    if (e.format === 'plain') tags.push(h('span', { class: 'badge lg-tag', title: 'Saved by cZEROde 1 without encryption.', text: 'plain text' }));
    return h('li', { class: 'lg-item', dataset: { state: st.key, id: e.id } },
      h('span', { class: 'lg-item-icon' }, kindIcon(kind)),
      h('div', { class: 'lg-item-main' },
        h('p', { class: 'lg-item-name' }, h('span', { class: 'lg-item-text', text: e.name }), ...tags),
        h('p', { class: 'lg-item-meta', text: meta }),
        fail ? h('p', { class: 'lg-item-err' }, icon('warning'), h('span', { text: fail })) : null),
      h('span', { class: ['badge', st.badge, 'lg-item-state'].filter(Boolean) }, icon(st.icon), h('span', { text: st.label })),
      h('div', { class: 'lg-item-actions' },
        btn('Preview', 'eye', { kind: 'ghost', className: 'lg-act-preview', disabled: !ready, onClick: () => preview(e) }),
        btn('Save', 'download', { kind: 'ghost', className: 'lg-act-save', disabled: !ready, onClick: () => saveItem(e) }),
        btn(isImported(e.id) ? 'Imported' : 'Import', isImported(e.id) ? 'check' : 'plus', { className: 'lg-act-import', disabled: !ready || isImported(e.id) || Boolean(job), onClick: () => importOne(e) })));
  }

  function viewerItem(e) {
    const isNote = e.store === 'vault';
    const ext = extOf(e.name);
    return {
      key: `old:${e.id}`,
      name: e.name,
      type: isNote ? NOTE_TYPE : mimeFromExt(ext),
      kind: isNote ? 'note' : e.kind,
      size: e.size,
      mtime: e.date || undefined,
      getSource: async () => viewerSource(await oldvault.decodeOldItem(e.id), isNote ? 'note' : e.kind),
      actions: unlocked() && !isImported(e.id) ? ['save', 'addToVault'] : ['save'],
      entry: e,
    };
  }

  function preview(e) {
    const list = items.filter((x) => x.unlocked && x.format !== 'bad').map(viewerItem);
    const i = list.findIndex((x) => x.entry.id === e.id);
    viewerHere(list, Math.max(0, i), (action, item) => {
      if (action === 'save') saveItem(item.entry);
      else if (action === 'addToVault') importOne(item.entry);
    });
  }

  async function saveItem(e) {
    const isNote = e.store === 'vault';
    const name = isNote ? `${safeFilename(e.name)}.txt` : e.name;
    let target;
    try {
      target = await platform.chooseSaveTarget({ name, count: 1 });
    } catch (err) {
      report(err);
      return;
    }
    if (!target) return;
    try {
      const r = await oldvault.decodeOldItem(e.id);
      const src = plainSource(r);
      const out = await saveDecrypted(target, src, r.note ? {} : { name: src.name, type: src.type });
      delivered(out, name);
    } catch (err) {
      await target.abort().catch(() => {});
      report(err);
    }
  }

  async function importOne(e) {
    const v = getVault();
    if (!v || v.status !== 'unlocked') {
      needVault();
      return;
    }
    try {
      const r = await oldvault.decodeOldItem(e.id);
      const info = await importDecoded(v, r);
      imported.set(e.id, info.id);
      failed.delete(e.id);
      await saveMaps();
      await linkAlbums(v);
      toast(`“${e.name}” is in your vault now.`, { kind: 'ok' });
    } catch (err) {
      if (isCancel(err)) return;
      failed.set(e.id, errorText(err));
      report(err);
    }
    if (alive) paint();
  }

  /** Old playlists → albums for whatever of them is imported (repeatable: existing albums are extended). */
  async function linkAlbums(v) {
    let lists;
    try {
      lists = await oldvault.listOldPlaylists();
    } catch {
      return 0;
    }
    let made = 0;
    for (const pl of lists) {
      const ids = pl.itemIds.map((oid) => imported.get(oid)).filter((nid) => {
        if (!nid) return false;
        try {
          v.item(nid);
          return true;
        } catch {
          return false;
        }
      });
      if (!ids.length) continue;
      const have = albums.get(pl.id);
      let existing = null;
      if (have) {
        try {
          existing = v.list(have);
        } catch {
          existing = null;
        }
      }
      if (existing) {
        const merged = [...new Set([...existing.itemIds, ...ids])];
        if (merged.length !== existing.itemIds.length) await v.updateList(existing.id, { itemIds: merged });
      } else {
        const l = await v.createList({ name: pl.name, itemIds: ids });
        albums.set(pl.id, l.id);
        made++;
      }
    }
    await saveMaps();
    return made;
  }

  async function unlockWithPin() {
    if (pinBusy) return;
    const pin = pinF.value;
    if (!pin) {
      pinF.setError('Enter a PIN you used in cZEROde 1.');
      return;
    }
    pinBusy = true;
    pinBtn.disabled = true;
    const locked = items.filter((e) => !e.unlocked && e.format !== 'bad').length;
    pinStatus.replaceChildren(h('span', { class: 'lg-spin', aria: { hidden: 'true' } }), h('span', { text: `Trying that PIN on ${plural(locked, 'locked item')}…` }));
    try {
      const ids = await oldvault.tryPin(pin);
      if (!alive) return;
      await relist();
      if (ids.length) {
        pinF.clear();
        const left = items.filter((e) => !e.unlocked && e.format !== 'bad').length;
        pinStatus.textContent = `Unlocked ${plural(ids.length, 'item')}.${left ? ` ${plural(left, 'item')} still locked — try another PIN.` : ' Everything is unlocked.'}`;
        announce(pinStatus.textContent);
      } else {
        pinStatus.textContent = '';
        pinF.setError('That PIN didn’t open anything new. Old items can each have their own PIN.');
      }
    } catch (e) {
      pinStatus.textContent = '';
      if (!isCancel(e)) pinF.setError(userMessage(e));
    } finally {
      pinBusy = false;
      pinBtn.disabled = false;
    }
  }

  async function importAll() {
    const v = getVault();
    if (!v || v.status !== 'unlocked') {
      needVault();
      return;
    }
    if (job) return;
    const list = importable();
    if (!list.length) return;
    const ctl = new AbortController();
    job = { ctl, done: 0, total: list.length };
    const fill = h('div', { class: 'progress-fill' });
    const bar = h('div', { class: 'progress', role: 'progressbar', aria: { valuemin: '0', valuemax: String(list.length), valuenow: '0', label: 'Import progress' } }, fill);
    const text = h('p', { class: 'lg-job-text' });
    const cancel = btn('Cancel', 'close', { kind: 'ghost', className: 'lg-job-cancel', onClick: () => ctl.abort() });
    jobSlot.replaceChildren(h('div', { class: 'lg-job', role: 'status' }, h('div', { class: 'lg-job-head' }, text, cancel), bar));
    paint();
    let ok = 0;
    let bad = 0;
    for (const e of list) {
      if (ctl.signal.aborted || !alive || !unlocked()) break;
      text.textContent = `Importing ${job.done + 1} of ${list.length} · ${e.name}`;
      try {
        const r = await oldvault.decodeOldItem(e.id);
        if (ctl.signal.aborted) break;
        const info = await importDecoded(v, r);
        imported.set(e.id, info.id);
        failed.delete(e.id);
        ok++;
        await saveMaps();
      } catch (err) {
        if (isCancel(err) || err?.code === 'interrupted') break;
        failed.set(e.id, errorText(err));
        bad++;
      }
      job.done++;
      fill.style.width = `${(job.done / list.length) * 100}%`;
      bar.setAttribute('aria-valuenow', String(job.done));
    }
    let made = 0;
    try {
      await saveMaps();
      if (unlocked()) made = await linkAlbums(v);
    } catch (err) {
      report(err);
    }
    const stopped = ctl.signal.aborted || !unlocked();
    job = null;
    jobSlot.replaceChildren();
    if (!alive) return;
    if (ok > 0 && !stopped) {
      try {
        await v.kvSet('legacy-import-done', true);
      } catch {
        // the banner just stays
      }
      state.set('legacy.importDone', true);
    }
    paint();
    if (stopped && !unlocked()) toast(userMessage('interrupted'), { kind: 'warn' });
    else {
      const parts = [`Imported ${plural(ok, 'item')}`];
      if (made) parts.push(`${plural(made, 'album')} from old playlists`);
      toast(`${parts.join(' and ')}.${bad ? ` ${bad} couldn’t be imported.` : ''}`, { kind: bad ? 'warn' : 'ok', timeout: 6000 });
    }
  }

  async function deleteOld() {
    const canBackup = unlocked();
    const choice = await modal({
      title: 'Delete old cZEROde 1 data?',
      className: 'lg-modal',
      body: h('div', { class: 'stack' },
        h('p', { text: 'This removes the old web vault from this browser for good. Anything you haven’t imported is gone.' }),
        h('p', { text: canBackup ? 'Make a backup first? Imported items live in your new vault — a .czb backup keeps them safe.' : 'Make a backup first? Unlock your new vault and export a backup of what you imported.' })),
      actions: [
        { label: 'Cancel', kind: 'ghost', value: null },
        ...(canBackup ? [{ label: 'Back up first', value: 'backup' }] : []),
        { label: 'Delete old data', kind: 'danger', value: 'delete' },
      ],
    });
    if (choice === 'backup') {
      // Still inside the click's activation: the save picker can open (openBackupExport's first await is the picker).
      openBackupExport();
      return;
    }
    if (choice !== 'delete') return;
    try {
      await oldvault.deleteOldDb();
      toast('Old cZEROde 1 data deleted.', { kind: 'ok' });
      state.set('legacy.found', null);
      el.hidden = true;
      onGone?.();
    } catch (e) {
      if (e?.code === 'other-tab') toast('A cZEROde 1 tab still has the old data open. Close it — the old data is deleted as soon as it closes.', { kind: 'warn', timeout: 8000 });
      else report(e);
    }
  }

  function purge() {
    pinF.clear();
    pinStatus.textContent = '';
    job?.ctl.abort();
    if (!el.hidden) relist();
  }

  load();
  return {
    el,
    purge,
    refresh() {
      if (!el.hidden) {
        loadMaps().then(() => alive && paint());
      }
    },
    destroy() {
      alive = false;
      job?.ctl.abort();
      pinF.clear();
    },
  };
}

// ───────── old desktop .czd

let entrySeq = 0;

function desktopCard(ctx) {
  let alive = true;
  /** @type {Array<{key: string, name: string, size: number, file?: File, path?: string, status: string, message?: string, result?: {name: string, type: string, blob: Blob}}>} */
  const entries = [];
  let busy = false;
  const pinF = passphraseField({ label: 'PIN', mode: 'enter', purpose: 'legacy', name: 'czd-legacy-czd-pin', placeholder: 'the PIN the image was locked with', onSubmit: () => openAll() });
  const openBtn = btn('Open', 'unlock', { kind: 'primary', small: false, className: 'lg-czd-open', onClick: () => openAll() });
  const listSlot = h('ul', { class: 'lg-items lg-czd-list' });
  const pinBar = h('div', { class: 'lg-pinbar', hidden: true }, h('div', { class: 'lg-pinbar-field' }, pinF.el), openBtn);
  const folderNote = h('p', { class: 'lg-czd-folder', hidden: true });
  const pick = btn('Choose .czd files', 'folder', { kind: platform.isTauri ? undefined : 'primary', small: false, className: 'lg-czd-pick', onClick: () => pickMore() });
  const drop = h('div', { class: 'dropzone lg-drop' },
    icon('upload'),
    h('p', { class: 'dropzone-title', text: platform.isTauri ? 'Other .czd files' : 'Drop old .czd files here' }),
    h('p', { class: 'dropzone-sub', text: 'Any name works — cZEROde checks what’s inside.' }),
    pick);
  const el = h('section', { class: 'card lg-card lg-desktop', aria: { labelledby: 'lg-czd-title' } },
    h('header', { class: 'lg-card-head' },
      h('span', { class: 'lg-card-icon', aria: { hidden: 'true' } }, icon('image')),
      h('div', { class: 'lg-card-titles' },
        h('h2', { class: 'lg-card-title', id: 'lg-czd-title', text: 'Old desktop .czd files' }),
        h('p', { class: 'lg-card-sub', text: 'Images locked by cZEROde 1 for desktop — text files full of Georgian and Cyrillic script.' }))),
    h('div', { class: 'lg-card-body' }, folderNote, listSlot, pinBar, drop));
  const offDrop = dropZone(el, { onFiles: (files) => addFiles(files), multiple: true });

  async function sniff(file) {
    try {
      const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
      if (isCzd2(head.subarray(0, 8))) return 'czd2';
      return isOldCzd(head) ? 'locked' : 'bad';
    } catch {
      return 'bad';
    }
  }

  async function addFiles(files) {
    for (const f of files) {
      if (!(f instanceof Blob)) continue;
      const status = await sniff(f);
      entries.push({ key: `f${++entrySeq}`, name: safeFilename(f.name), size: f.size, file: f, status, message: status === 'bad' ? 'Not an old cZEROde .czd' : undefined });
    }
    paint();
    el.scrollIntoView?.({ block: 'nearest' });
    if (entries.some((e) => e.status === 'locked')) pinF.focus();
  }

  async function pickMore() {
    let files;
    try {
      files = await platform.pickFiles({ multiple: true });
    } catch (e) {
      report(e);
      return;
    }
    if (files?.length) addFiles(files);
  }

  async function listFolder() {
    if (!platform.isTauri) return;
    let found = [];
    try {
      found = await platform.listLegacyDesktopCzd();
    } catch (e) {
      globalThis.console?.warn?.('[legacy] could not list the old app folder', e);
    }
    if (!alive) return;
    folderNote.hidden = false;
    folderNote.textContent = found.length ? `${plural(found.length, 'file')} found in the old app’s vault folder.` : 'No files in the old app’s vault folder.';
    for (const f of found) entries.push({ key: `p${++entrySeq}`, name: f.name, size: f.size, path: f.path, status: 'locked' });
    paint();
  }

  function paint() {
    pinBar.hidden = !entries.some((e) => e.status === 'locked' || e.status === 'wrong');
    listSlot.hidden = entries.length === 0;
    drop.classList.toggle('lg-drop-compact', entries.length > 0);
    listSlot.replaceChildren(...entries.map((e) => entryRow(e)));
  }

  function entryRow(e) {
    const r = e.result;
    const kind = r ? kindOf(r.type, r.name) : 'image';
    const label = { locked: ['Locked', 'lock', ''], wrong: ['Wrong PIN', 'warning', 'badge-warn'], open: ['Opened', 'unlock', 'badge-ok'], bad: ['Not a .czd', 'warning', 'badge-err'], czd2: ['New format', 'info', 'badge-gold'], busy: ['Opening…', 'refresh', ''] }[e.status] ?? ['?', 'info', ''];
    const meta = r ? [KIND_LABEL[kind], fmtSize(r.blob.size), `from ${e.name}`].join(' · ') : [fmtSize(e.size), e.message].filter(Boolean).join(' · ');
    const actions = [];
    if (e.status === 'open') {
      actions.push(
        btn('Preview', 'eye', { kind: 'ghost', className: 'lg-act-preview', onClick: () => preview(e) }),
        btn('Save', 'download', { kind: 'ghost', className: 'lg-act-save', onClick: () => saveEntry(e) }),
        btn(e.imported ? 'Imported' : 'Import', e.imported ? 'check' : 'plus', { className: 'lg-act-import', disabled: Boolean(e.imported), onClick: () => importEntry(e) }));
    } else if (e.status === 'czd2') {
      actions.push(btn('Open in Send · Open', 'unlock', { className: 'lg-act-open', onClick: () => {
        state.set('incoming.files', [e.file]);
        router.navigate('#/open');
      } }));
    }
    actions.push(h('button', { type: 'button', class: 'btn-icon lg-act-remove', aria: { label: `Remove ${e.name}` }, title: 'Remove from the list', on: { click: () => {
      entries.splice(entries.indexOf(e), 1);
      paint();
    } } }, icon('close')));
    return h('li', { class: 'lg-item', dataset: { state: e.status } },
      h('span', { class: 'lg-item-icon' }, kindIcon(r ? kind : 'other')),
      h('div', { class: 'lg-item-main' },
        h('p', { class: 'lg-item-name' }, h('span', { class: 'lg-item-text', text: r ? r.name : e.name })),
        h('p', { class: 'lg-item-meta', text: meta })),
      h('span', { class: ['badge', label[2], 'lg-item-state'].filter(Boolean) }, icon(label[1]), h('span', { text: label[0] })),
      h('div', { class: 'lg-item-actions' }, actions));
  }

  async function readText(e) {
    if (e.file) return e.file.text();
    return platform.readLegacyDesktopCzd(e.path);
  }

  async function openAll() {
    if (busy) return;
    const todo = entries.filter((e) => e.status === 'locked' || e.status === 'wrong');
    if (!todo.length) return;
    const pin = pinF.value;
    if (!pin) {
      pinF.setError('Enter the PIN the image was locked with.');
      return;
    }
    busy = true;
    openBtn.disabled = true;
    let opened = 0;
    for (const e of todo) {
      e.status = 'busy';
      paint();
      try {
        e.result = await openOldCzd(await readText(e), pin);
        e.status = 'open';
        e.message = undefined;
        opened++;
      } catch (err) {
        e.status = err?.code === 'legacy-wrong-pin' ? 'wrong' : 'bad';
        e.message = err?.code === 'legacy-wrong-pin' ? undefined : userMessage(err);
      }
      if (!alive) return;
    }
    busy = false;
    openBtn.disabled = false;
    paint();
    if (opened) {
      pinF.clear();
      announce(`Opened ${plural(opened, 'file')}`);
    } else {
      pinF.setError(userMessage('legacy-wrong-pin'));
    }
  }

  function viewerItem(e) {
    const r = e.result;
    return {
      key: `czd:${e.key}`,
      name: r.name,
      type: r.type,
      kind: kindOf(r.type, r.name),
      size: r.blob.size,
      getSource: async () => {
        if (!e.result) throw new CzdError('aborted');
        return viewerSource(e.result, kindOf(e.result.type, e.result.name));
      },
      actions: unlocked() && !e.imported ? ['save', 'addToVault'] : ['save'],
      entry: e,
    };
  }

  function preview(e) {
    const list = entries.filter((x) => x.status === 'open' && x.result).map(viewerItem);
    viewerHere(list, Math.max(0, list.findIndex((x) => x.entry === e)), (action, item) => {
      if (action === 'save') saveEntry(item.entry);
      else if (action === 'addToVault') importEntry(item.entry);
    });
  }

  async function saveEntry(e) {
    const r = e.result;
    if (!r) return;
    let target;
    try {
      target = await platform.chooseSaveTarget({ name: r.name, count: 1 });
    } catch (err) {
      report(err);
      return;
    }
    if (!target) return;
    try {
      const out = await saveDecrypted(target, plainSource(r), { name: r.name, type: r.type });
      delivered(out, r.name);
    } catch (err) {
      await target.abort().catch(() => {});
      report(err);
    }
  }

  async function importEntry(e) {
    const v = getVault();
    if (!v || v.status !== 'unlocked') {
      needVault();
      return;
    }
    if (!e.result) return;
    try {
      await importDecoded(v, { name: e.result.name, type: e.result.type, blob: e.result.blob, mtime: e.file?.lastModified });
      e.imported = true;
      toast(`“${e.result.name}” is in your vault now.`, { kind: 'ok' });
    } catch (err) {
      report(err);
    }
    if (alive) paint();
  }

  function take(files) {
    if (Array.isArray(files) && files.length) addFiles(files);
  }

  function purge() {
    pinF.clear();
    for (const e of entries) {
      if (e.result) {
        e.result = undefined;
        e.status = 'locked';
        e.imported = false;
      }
    }
    paint();
  }

  listFolder();
  paint();
  return {
    el,
    take,
    purge,
    refresh: () => paint(),
    destroy() {
      alive = false;
      offDrop();
      purge();
      entries.splice(0);
    },
  };
}

// ───────── ViewModule

/**
 * ViewModule.mount for 'legacy'.
 * @param {HTMLElement} root
 * @param {import('../types.js').Route} route
 * @param {{vault: any, state: any}} ctx
 */
export function mount(root, route, ctx) {
  void route;
  const c = ctx ?? { vault: getVault(), state };
  const offs = [];
  const vaultOffs = [];
  const msgs = messagesCard(c);
  const ov = oldVaultCard(c, { onGone: () => {} });
  const desk = desktopCard(c);

  const el = h('div', { class: 'lg' },
    h('div', { class: 'lg-page' },
      h('header', { class: 'lg-head' },
        h('p', { class: 'lg-eyebrow', text: 'cZEROde 1 · decode only' }),
        h('h1', { class: 'lg-title', text: 'Legacy' }),
        h('p', { class: 'lg-lead', text: 'Open what you made with cZEROde 1 — old messages, the old web vault and old desktop .czd files. Nothing new is ever made in these old formats.' })),
      banner({ kind: 'warn', text: WARN_COPY }),
      ov.el,
      msgs.el,
      desk.el));
  el.querySelector('.banner')?.classList.add('lg-warn');
  root.append(el);

  const takeFiles = () => {
    const files = state.get('legacy.files');
    if (Array.isArray(files) && files.length) {
      state.set('legacy.files', null);
      desk.take(files);
      desk.el.scrollIntoView?.({ block: 'start' });
    }
  };
  takeFiles();

  const refresh = () => {
    msgs.refresh?.();
    ov.refresh?.();
    desk.refresh?.();
  };
  const hookVault = () => {
    for (const off of vaultOffs.splice(0)) off();
    const v = c.vault;
    if (!v || typeof v.addEventListener !== 'function') return;
    for (const type of ['status', 'items']) {
      const fn = () => refresh();
      v.addEventListener(type, fn);
      vaultOffs.push(() => v.removeEventListener(type, fn));
    }
  };
  hookVault();
  offs.push(state.on('legacy.files', () => takeFiles()));
  offs.push(state.on('vault.status', () => {
    hookVault();
    refresh();
  }));
  offs.push(state.onPurge(() => {
    oldvault.forgetPins();
    msgs.purge();
    ov.purge();
    desk.purge();
  }));

  return {
    update() {
      takeFiles();
    },
    unmount() {
      for (const off of offs.splice(0)) off();
      for (const off of vaultOffs.splice(0)) off();
      oldvault.forgetPins();
      msgs.destroy();
      ov.destroy();
      desk.destroy();
      el.remove();
    },
  };
}
