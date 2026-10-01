// Shared UI components (DESIGN §7, §10). Untrusted names are passed through safeFilename and only
// ever rendered as text. passphraseField is the only secret input in the app.

import { CAPS } from '../config.js';
import { h, icon, toast, onOutside } from '../util/dom.js';
import { fmtSize, safeFilename } from '../util/format.js';
import * as state from '../state.js';
import * as settings from '../settings.js';
import * as passphrase from '../crypto/passphrase.js';
import { maybeEasterEgg, EGG_PURPOSES } from './easter.js';

let seq = 0;
const uid = (p) => `${p}-${++seq}`;
const FALLBACK_WEAK = new Set(['123', '1234', '12345', 'password', 'qwerty', 'abc', '0000', '1111', 'pass', 'admin']);

// passphrase.js is built in parallel; every call is defensive so a missing/throwing helper
// degrades the meter instead of breaking the form.
function safeStrength(value, opts) {
  try {
    const r = passphrase.strength(value, opts);
    if (r && typeof r.bits === 'number' && ['weak', 'ok', 'strong'].includes(r.label)) return r;
  } catch {
    // fall through
  }
  const bits = opts?.generated ? (opts.words || String(value).split('-').length) * 11 : Math.round(String(value).length * 3);
  return { bits, label: bits < 40 ? 'weak' : bits < 60 ? 'ok' : 'strong', crack: '' };
}

function safeIsWeak(value) {
  try {
    return passphrase.isWeak(value) === true;
  } catch {
    return FALLBACK_WEAK.has(String(value).trim().toLowerCase());
  }
}

// ───────── passphrase field

const liveFields = new Set(); // WeakRef<api>
let purgeHooked = false;
function trackField(api) {
  // Dead refs are otherwise only dropped on purge: without a vault there may be none for a long time.
  if (liveFields.size >= 64) for (const ref of [...liveFields]) if (!ref.deref()) liveFields.delete(ref);
  liveFields.add(new WeakRef(api));
  if (purgeHooked) return;
  purgeHooked = true;
  state.onPurge(() => {
    for (const ref of [...liveFields]) {
      const f = ref.deref();
      if (!f) liveFields.delete(ref);
      else f.clear();
    }
  });
}

/** §3.1: password managers only for the vault passphrase; one-off secrets (send/text/open/legacy) get 'off'. */
function defaultAutocomplete(purpose, mode) {
  if (purpose === 'unlock') return 'current-password';
  if (purpose === 'vault' || purpose === 'change') return mode === 'new' ? 'new-password' : 'current-password';
  return 'off';
}

/**
 * The ONLY allowed secret input (DESIGN §3.1, §10). mode 'new' shows the strength meter, the inline
 * WEAK warning and (purposes vault/send/text/change only) the skull easter egg; mode 'enter' shows
 * none of them. generateWords > 0 adds a "Generate" button (BIP39 words; shown in clear by default).
 * Enter calls onSubmit(value); submitting exactly "codzilla" also dispatches a bubbling 'codzilla'
 * event on el. The field is cleared on every purge (lock).
 * Extra over §10: setMode(mode) (Text switches between Encrypt and Decrypt), input (the element).
 * @param {{label?: string, mode?: 'new'|'enter', purpose?: string, generateWords?: number, autocomplete?: string,
 *   onChange?: (value: string, info: {generated: boolean}) => void, onSubmit?: (value: string) => void, placeholder?: string, name?: string}} opts
 */
export function passphraseField({ label = 'Passphrase', mode = 'enter', purpose = 'unlock', generateWords = 0, autocomplete, onChange, onSubmit, placeholder, name } = {}) {
  const id = uid('pass');
  const errId = `${id}-err`;
  const warnId = `${id}-warn`;
  let curMode = mode === 'new' ? 'new' : 'enter';
  let generated = false;
  let shown = false;
  let eggShownThisFocus = false;
  let skullUp = false; // the skull returns focus to this field when it closes: that is not a new focus

  const input = h('input', {
    class: 'input pass-input',
    id,
    type: 'password',
    name: name ?? `czd-${purpose}-pass`,
    placeholder,
    autocomplete: autocomplete ?? defaultAutocomplete(purpose, curMode),
    spellcheck: false,
    attrs: { autocapitalize: 'none', autocorrect: 'off' },
    aria: { describedby: `${warnId} ${errId}` },
  });
  const toggleIcon = h('span', { class: 'pass-toggle-icon' }, icon('eye'));
  const toggle = h('button', {
    type: 'button',
    class: 'btn-icon pass-toggle',
    aria: { label: 'Show passphrase', pressed: 'false', controls: id },
    on: { click: () => setShown(!shown) },
  }, toggleIcon);
  const genBtn = generateWords > 0 ? h('button', {
    type: 'button',
    class: 'btn btn-ghost pass-gen',
    on: { click: () => generate() },
  }, icon('refresh'), h('span', { text: 'Generate' })) : null;
  const meter = strengthMeter();
  const warn = h('p', { class: 'hint pass-weak', id: warnId, hidden: true, role: 'status' }, icon('warning'), h('span', { text: 'Very common password — seriously?' }));
  const err = h('p', { class: 'hint hint-err pass-err', id: errId, hidden: true, role: 'alert' });
  const el = h('div', { class: ['field', 'pass'], dataset: { purpose, mode: curMode } },
    h('label', { class: 'label', for: id, text: label }),
    h('div', { class: 'pass-row' }, input, toggle, genBtn),
    meter.el,
    warn,
    err);

  function setShown(v) {
    shown = !!v;
    input.type = shown ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(shown));
    toggle.setAttribute('aria-label', shown ? 'Hide passphrase' : 'Show passphrase');
    toggleIcon.replaceChildren(icon(shown ? 'eye-off' : 'eye'));
  }

  function refresh() {
    const v = input.value;
    const isNew = curMode === 'new';
    meter.el.hidden = !isNew;
    if (isNew) meter.update(v, { generated, words: generated ? generateWords : 0 });
    warn.hidden = !(isNew && EGG_PURPOSES.includes(purpose) && v !== '' && !generated && safeIsWeak(v));
  }

  function changed() {
    refresh();
    try {
      onChange?.(input.value, { generated });
    } catch (e) {
      globalThis.console?.error?.(e);
    }
  }

  function generate() {
    let phrase;
    try {
      phrase = passphrase.generatePassphrase(generateWords);
    } catch {
      toast("Couldn't generate a passphrase here — type your own.", { kind: 'warn' });
      return;
    }
    api.setValue(phrase, { generated: true });
    input.focus();
  }

  input.addEventListener('input', () => {
    generated = false;
    setError(null);
    changed();
    if (curMode === 'new' && !eggShownThisFocus) {
      const typed = input.value;
      // Dropped when, by the end of the debounce, the field was cleared (lock), removed, switched to an
      // enter-mode field or holds something else.
      const isCurrent = () => input.isConnected && curMode === 'new' && input.value === typed;
      maybeEasterEgg(typed, purpose, { isCurrent }).then((didShow) => {
        if (didShow) {
          eggShownThisFocus = true;
          skullUp = true;
        }
      });
    }
  });
  input.addEventListener('focus', () => {
    if (skullUp) skullUp = false;
    else eggShownThisFocus = false;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    if (input.value.trim().toLowerCase() === 'codzilla') el.dispatchEvent(new CustomEvent('codzilla', { bubbles: true }));
    if (onSubmit) {
      e.preventDefault();
      onSubmit(input.value);
    }
  });

  function setError(msg) {
    err.textContent = msg ?? '';
    err.hidden = !msg;
    if (msg) {
      input.setAttribute('aria-invalid', 'true');
      el.classList.add('has-error');
    } else {
      input.removeAttribute('aria-invalid');
      el.classList.remove('has-error');
    }
  }

  const api = {
    el,
    input,
    get value() {
      return input.value;
    },
    get generated() {
      return generated;
    },
    focus() {
      input.focus();
    },
    /** Empties the field (also on every purge); onChange('') runs when something was cleared. */
    clear() {
      const had = input.value !== '' || generated;
      input.value = '';
      generated = false;
      setShown(false);
      setError(null);
      if (had) changed();
      else refresh();
    },
    /** Shows an inline error and selects the field (null hides it). */
    setError(msg) {
      setError(msg);
      if (msg) {
        input.focus();
        input.select();
      }
    },
    setDisabled(b) {
      input.disabled = !!b;
      toggle.disabled = !!b;
      if (genBtn) genBtn.disabled = !!b;
    },
    setValue(s, { generated: gen = false } = {}) {
      input.value = String(s ?? '');
      generated = !!gen;
      setError(null);
      if (generated) setShown(true);
      changed();
    },
    setMode(m) {
      curMode = m === 'new' ? 'new' : 'enter';
      el.dataset.mode = curMode;
      refresh();
    },
  };
  refresh();
  trackField(api);
  return api;
}

const CRACK = Object.freeze({
  instantly: 'cracked instantly', minutes: 'cracked in minutes', hours: 'cracked in hours', days: 'cracked in days',
  years: 'takes years to crack', centuries: 'takes centuries to crack',
});

/**
 * Strength meter (DESIGN §3.9): 3-segment bar + "Weak · cracked instantly" style label.
 * @returns {{el: HTMLElement, update(pass: string, opts?: {generated?: boolean, words?: number}): void}}
 */
export function strengthMeter() {
  const label = h('span', { class: 'meter-label' });
  const crack = h('span', { class: 'meter-crack' });
  const bar = h('div', { class: 'meter-bar', aria: { hidden: 'true' } }, h('span'), h('span'), h('span'));
  const el = h('div', { class: 'meter', dataset: { level: 'none' }, aria: { live: 'polite' } }, bar, h('div', { class: 'meter-text' }, label, crack));
  return {
    el,
    update(pass, { generated = false, words = 0 } = {}) {
      const v = String(pass ?? '');
      if (!v) {
        el.dataset.level = 'none';
        label.textContent = '';
        crack.textContent = '';
        return;
      }
      const s = safeStrength(v, { generated, words });
      el.dataset.level = s.label;
      label.textContent = { weak: 'Weak', ok: 'OK', strong: 'Strong' }[s.label];
      crack.textContent = CRACK[s.crack] ?? '';
    },
  };
}

// ───────── drop zone (files + folders)

const JUNK = new Set(['thumbs.db', 'desktop.ini', '__macosx']);
const skipName = (n) => !n || n.startsWith('.') || JUNK.has(n.toLowerCase());

function entryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** Reads a directory's entries, at most budget.entries in total over the whole drop (huge trees stay bounded). */
function readAll(dirEntry, budget) {
  const reader = dirEntry.createReader();
  const out = [];
  return new Promise((resolve, reject) => {
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) return resolve(out);
      const take = batch.slice(0, Math.max(0, budget.entries));
      budget.entries -= take.length;
      out.push(...take);
      if (take.length < batch.length || budget.entries <= 0) {
        budget.truncated = true;
        return resolve(out);
      }
      next();
    }, reject);
    next();
  });
}

/**
 * Walks a dropped directory (dotfiles/OS junk skipped, depth ≤ CAPS.folderDepth, ≤ budget.left files).
 * @returns {Promise<File[]>}
 */
async function walkDir(dirEntry, depth, budget) {
  const files = [];
  if (depth > CAPS.folderDepth) {
    budget.truncated = true;
    return files;
  }
  let entries;
  try {
    entries = await readAll(dirEntry, budget);
  } catch {
    return files;
  }
  for (const e of entries) {
    if (budget.left <= 0) {
      budget.truncated = true;
      break;
    }
    if (skipName(e.name)) continue;
    if (e.isFile) {
      try {
        files.push(await entryFile(e));
        budget.left--;
      } catch {
        // unreadable file: skip
      }
    } else if (e.isDirectory) {
      files.push(...await walkDir(e, depth + 1, budget));
    }
  }
  return files;
}

/**
 * Collects a drop: loose files + folders (only with folders=true; directories never become files).
 * @param {DataTransfer} dt
 * @param {{folders: boolean, multiple: boolean}} opts
 */
export async function collectDrop(dt, { folders = false, multiple = true } = {}) {
  const items = dt?.items ? [...dt.items].filter((i) => i.kind === 'file') : [];
  const entries = items.map((i) => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null));
  const hasEntries = entries.some(Boolean);
  const files = [];
  const outFolders = [];
  // entries: every directory entry read (files, folders, skipped junk) — bounds the walk of huge trees.
  const budget = { left: CAPS.folderFiles, entries: CAPS.folderFiles * 10, truncated: false };
  if (hasEntries) {
    // getAsFile() must run synchronously during the drop event; entries are read afterwards.
    const plain = items.map((i, k) => (entries[k]?.isDirectory ? null : i.getAsFile()));
    for (let k = 0; k < items.length; k++) {
      const entry = entries[k];
      if (entry?.isDirectory) {
        if (!folders || skipName(entry.name)) continue;
        const list = await walkDir(entry, 1, budget);
        if (list.length) outFolders.push({ name: safeFilename(entry.name), files: list });
      } else if (plain[k]) {
        files.push(plain[k]);
      }
    }
  } else {
    files.push(...(dt?.files ? [...dt.files] : []));
  }
  return { files: multiple ? files : files.slice(0, 1), folders: multiple ? outFolders : outFolders.slice(0, 1), truncated: budget.truncated };
}

/**
 * Makes `target` accept dropped files (and folders when folders=true, via webkitGetAsEntry).
 * onFiles(files, {folders: [{name, files}], truncated}) — `files` are the loose files only.
 * Adds class 'dragover' while dragging over. Returns off().
 * @param {HTMLElement} target
 * @param {{onFiles: Function, multiple?: boolean, folders?: boolean}} opts
 * @returns {() => void}
 */
export function dropZone(target, { onFiles, multiple = true, folders = false }) {
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  const enter = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    target.classList.add('dragover');
  };
  const over = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const leave = () => {
    depth = Math.max(0, depth - 1);
    if (!depth) target.classList.remove('dragover');
  };
  const drop = async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    depth = 0;
    target.classList.remove('dragover');
    try {
      const got = await collectDrop(e.dataTransfer, { folders, multiple });
      if (!got.files.length && !got.folders.length) return;
      await onFiles(got.files, { folders: got.folders, truncated: got.truncated });
    } catch (err) {
      globalThis.console?.error?.('[dropZone] drop failed', err);
    }
  };
  target.addEventListener('dragenter', enter);
  target.addEventListener('dragover', over);
  target.addEventListener('dragleave', leave);
  target.addEventListener('drop', drop);
  return () => {
    target.removeEventListener('dragenter', enter);
    target.removeEventListener('dragover', over);
    target.removeEventListener('dragleave', leave);
    target.removeEventListener('drop', drop);
    target.classList.remove('dragover');
  };
}

// ───────── progress row

/**
 * One job line: name, bar, "12 MB / 40 MB · 3.1 MB/s", cancel button (after onCancel).
 * @param {{name?: string, total?: number}} opts
 */
export function progressRow({ name = '', total = 0 } = {}) {
  const fill = h('div', { class: 'progress-fill' });
  const bar = h('div', { class: 'progress', role: 'progressbar', aria: { valuemin: '0', valuemax: '100', valuenow: '0', label: safeFilename(name) } }, fill);
  const status = h('span', { class: 'progress-status', text: total ? `0 B / ${fmtSize(total)}` : 'Waiting…' });
  const cancel = h('button', { type: 'button', class: 'btn-icon progress-cancel', hidden: true, aria: { label: 'Cancel' } }, icon('close'));
  const el = h('div', { class: 'progress-row', dataset: { state: 'running' } },
    h('div', { class: 'progress-head' }, h('span', { class: 'progress-name', text: safeFilename(name) }), cancel),
    bar,
    status);
  let t0 = 0;
  let lastT = 0;
  let lastDone = 0;
  let speed = 0;
  let cancelFn = null;
  cancel.addEventListener('click', () => {
    if (!cancelFn) return;
    cancel.disabled = true;
    cancelFn();
  });
  const set = (pct) => {
    const p = Math.max(0, Math.min(100, pct));
    fill.style.width = `${p}%`;
    bar.setAttribute('aria-valuenow', String(Math.round(p)));
  };
  const finish = (stateName, msg) => {
    el.dataset.state = stateName;
    status.textContent = msg;
    cancel.hidden = true;
  };
  return {
    el,
    update(done) {
      const now = globalThis.performance?.now?.() ?? Date.now();
      if (!t0) {
        t0 = now;
        lastT = now;
      }
      const dt = (now - lastT) / 1000;
      if (dt >= 0.25) {
        const inst = (done - lastDone) / dt;
        speed = speed ? speed * 0.7 + inst * 0.3 : inst;
        lastT = now;
        lastDone = done;
      }
      set(total > 0 ? (done / total) * 100 : 0);
      const parts = [total > 0 ? `${fmtSize(done)} / ${fmtSize(total)}` : fmtSize(done)];
      if (speed > 0) parts.push(`${fmtSize(speed)}/s`);
      status.textContent = parts.join(' · ');
    },
    done(msg) {
      set(100);
      finish('done', msg ?? 'Done');
    },
    fail(msg) {
      finish('failed', msg ?? 'Failed');
    },
    onCancel(fn) {
      cancelFn = fn;
      cancel.hidden = typeof fn !== 'function';
    },
  };
}

// ───────── small pieces

const KIND_ICON = Object.freeze({ image: 'image', video: 'video', audio: 'music', doc: 'file', note: 'note', other: 'file' });

/**
 * Icon for a Kind (span.kind-icon.kind-<kind>).
 * @param {string} kind
 * @returns {HTMLElement}
 */
export function kindIcon(kind) {
  const k = Object.hasOwn(KIND_ICON, kind) ? kind : 'other';
  return h('span', { class: ['kind-icon', `kind-${k}`] }, icon(KIND_ICON[k]));
}

/**
 * Empty state: faded icon, title, text, optional action {label, onClick, kind, icon}.
 * @param {{icon?: string, title?: string, text?: string, action?: {label: string, onClick: () => void, kind?: string, icon?: string}}} opts
 * @returns {HTMLElement}
 */
export function emptyState({ icon: iconId, title, text, action } = {}) {
  return h('div', { class: 'empty' },
    iconId ? h('div', { class: 'empty-icon' }, icon(iconId)) : null,
    title ? h('p', { class: 'empty-title', text: title }) : null,
    text ? h('p', { class: 'empty-text', text }) : null,
    action ? h('button', { type: 'button', class: ['btn', `btn-${action.kind ?? 'primary'}`], on: { click: action.onClick } },
      action.icon ? icon(action.icon) : null, h('span', { text: action.label })) : null);
}

/**
 * Storage summary for vault.storage(): {count, itemBytes, usage, quota, persisted} (nulls when unknown).
 * @param {{count?: number, itemBytes?: number, usage?: number|null, quota?: number|null, persisted?: boolean|null}} info
 * @returns {HTMLElement}
 */
export function storageBar(info) {
  const i = info ?? {};
  const count = Number.isFinite(i.count) ? i.count : 0;
  const lines = [`${count} ${count === 1 ? 'item' : 'items'} · ${fmtSize(Number.isFinite(i.itemBytes) ? i.itemBytes : 0)}`];
  const known = Number.isFinite(i.usage) && Number.isFinite(i.quota) && i.quota > 0;
  const pct = known ? Math.min(100, (i.usage / i.quota) * 100) : 0;
  if (known) lines.push(`${fmtSize(i.usage)} used of ~${fmtSize(i.quota)}`);
  const fill = h('div', { class: 'storage-fill' });
  fill.style.width = `${pct.toFixed(1)}%`;
  const el = h('div', { class: 'storage', dataset: { level: pct > 90 ? 'high' : pct > 70 ? 'mid' : 'low' } },
    h('div', { class: 'storage-head' },
      h('span', { class: 'label', text: 'Storage' }),
      i.persisted === true ? h('span', { class: 'badge badge-ok' }, icon('check'), h('span', { text: 'Protected' }))
        : i.persisted === false ? h('span', { class: 'badge badge-warn' }, icon('warning'), h('span', { text: 'Not protected from cleanup' })) : null),
    known ? h('div', { class: 'storage-track', role: 'meter', aria: { valuemin: '0', valuemax: '100', valuenow: pct.toFixed(0), label: 'Storage used' } }, fill) : null,
    h('p', { class: 'storage-text', text: lines.join(' · ') }));
  return el;
}

/**
 * Segmented control (radio group with roving focus and arrow keys).
 * @param {{options: Array<{value: any, label: string}>, value?: any, onChange?: (v: any) => void, label?: string}} opts
 * @returns {{el: HTMLElement, set(v: any): void, get value(): any}}
 */
export function segmented({ options = [], value, onChange, label } = {}) {
  let current = value;
  const buttons = options.map((o) => h('button', {
    type: 'button',
    class: 'seg-btn',
    role: 'radio',
    text: o.label,
    dataset: { value: String(o.value) },
    on: { click: () => choose(o.value, true) },
  }));
  const el = h('div', { class: 'seg', role: 'radiogroup', aria: { label } }, buttons);
  const paint = () => {
    options.forEach((o, i) => {
      const on = Object.is(o.value, current);
      buttons[i].setAttribute('aria-checked', String(on));
      buttons[i].tabIndex = on ? 0 : -1;
    });
    if (!options.some((o) => Object.is(o.value, current)) && buttons[0]) buttons[0].tabIndex = 0;
  };
  function choose(v, user) {
    if (Object.is(v, current)) return;
    current = v;
    paint();
    if (user) onChange?.(v);
  }
  el.addEventListener('keydown', (e) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: 'first', End: 'last' };
    if (!(e.key in keys) || !options.length) return;
    e.preventDefault();
    let i = options.findIndex((o) => Object.is(o.value, current));
    const k = keys[e.key];
    if (k === 'first') i = 0;
    else if (k === 'last') i = options.length - 1;
    else i = (i + k + options.length) % options.length;
    choose(options[i].value, true);
    buttons[i].focus();
  });
  paint();
  return {
    el,
    set(v) {
      choose(v, false);
    },
    get value() {
      return current;
    },
  };
}

/**
 * Popup menu for `button` (keyboard: Enter/Space/ArrowDown opens, arrows/Home/End move, Esc/Tab close).
 * items: [{label, icon, onClick, danger, hidden}] or a function returning them (evaluated on open).
 * @param {HTMLElement} button
 * @param {Array<object>|(() => Array<object>)} items
 * @returns {() => void} off
 */
export function menu(button, items) {
  const menuId = uid('menu');
  let pop = null;
  let offOutside = null;
  let offRoute = null;
  let offPurge = null;
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');

  const close = (focusButton = false) => {
    if (!pop) return;
    pop.remove();
    pop = null;
    offOutside?.();
    offRoute?.();
    offPurge?.();
    offOutside = offRoute = offPurge = null;
    globalThis.removeEventListener('resize', onResize);
    button.setAttribute('aria-expanded', 'false');
    button.removeAttribute('aria-controls');
    if (focusButton) button.focus();
  };
  const onResize = () => close(false);
  const entries = () => (typeof items === 'function' ? items() : items).filter((i) => i && !i.hidden);

  const position = () => {
    const r = button.getBoundingClientRect();
    const vw = globalThis.innerWidth;
    const vh = globalThis.innerHeight;
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let left = Math.min(r.left, vw - pw - 8);
    left = Math.max(8, left);
    let top = r.bottom + 4;
    if (top + ph > vh - 8 && r.top - ph - 4 > 8) top = r.top - ph - 4;
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(Math.max(8, top))}px`;
  };

  const open = (focusLast = false) => {
    if (pop) return;
    const list = entries();
    const btns = list.map((it) => h('button', {
      type: 'button',
      class: ['menu-item', it.danger ? 'menu-danger' : null],
      role: 'menuitem',
      tabIndex: -1,
      on: {
        click: () => {
          close(true);
          try {
            it.onClick?.();
          } catch (e) {
            globalThis.console?.error?.(e);
          }
        },
      },
    }, it.icon ? icon(it.icon) : null, h('span', { text: it.label })));
    pop = h('div', { class: 'menu', role: 'menu', id: menuId, aria: { label: button.getAttribute('aria-label') ?? undefined } }, btns);
    pop.addEventListener('keydown', (e) => {
      const i = btns.indexOf(globalThis.document.activeElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        btns[(i + 1) % btns.length]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        btns[(i - 1 + btns.length) % btns.length]?.focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        btns[0]?.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        btns.at(-1)?.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      } else if (e.key === 'Tab') {
        close(false);
      }
    });
    // Inside a dialog, attach to its (fixed, full-viewport) layer: not inert, not clipped by the panel's overflow.
    const host = button.closest('.modal-backdrop, .sheet-backdrop') ?? button.closest('[role="dialog"]') ?? globalThis.document.body;
    host.append(pop);
    position();
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-controls', menuId);
    offOutside = onOutside(pop, (e) => {
      if (button.contains(e.target)) return;
      close(false);
    });
    globalThis.addEventListener('resize', onResize);
    // Its actions belong to the current view and the unlocked state: a route change or a lock closes it.
    offRoute = state.on('route', () => close(false));
    offPurge = state.onPurge(() => close(false));
    (focusLast ? btns.at(-1) : btns[0])?.focus();
  };

  const onClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (pop && !pop.isConnected) close(false); // its dialog went away while it was open
    if (pop) close(true);
    else open();
  };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      open();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      open(true);
    }
  };
  button.addEventListener('click', onClick);
  button.addEventListener('keydown', onKey);
  return () => {
    close(false);
    button.removeEventListener('click', onClick);
    button.removeEventListener('keydown', onKey);
  };
}

const BANNER_ICON = { info: 'info', warn: 'warning', err: 'warning', ok: 'check' };

/**
 * Inline banner. actions: [{label, onClick, kind}]; onDismiss adds an X (the banner removes itself).
 * @param {{kind?: 'info'|'warn'|'err'|'ok', text?: string|Node, actions?: Array<object>, onDismiss?: () => void}} opts
 * @returns {HTMLElement}
 */
export function banner({ kind = 'info', text, actions = [], onDismiss } = {}) {
  const k = Object.hasOwn(BANNER_ICON, kind) ? kind : 'info';
  const el = h('div', { class: ['banner', `banner-${k}`], role: k === 'err' ? 'alert' : 'status' },
    icon(BANNER_ICON[k]),
    h('div', { class: 'banner-text' }, typeof text === 'string' ? h('span', { text }) : text),
    actions.length ? h('div', { class: 'banner-actions' }, actions.map((a) => h('button', {
      type: 'button',
      class: ['btn', 'btn-sm', a.kind ? `btn-${a.kind}` : null],
      text: a.label,
      on: { click: () => a.onClick?.() },
    }))) : null,
    onDismiss ? h('button', {
      type: 'button',
      class: 'btn-icon banner-close',
      aria: { label: 'Dismiss' },
      on: {
        click: () => {
          el.remove();
          onDismiss();
        },
      },
    }, icon('close')) : null);
  return el;
}

// ───────── clipboard (DESIGN §3.10)

let clipTimer = null;
let clipArmed = false; // a secret copy waits to be cleared
let clipHooks = false;

function clearClipboardNow() {
  if (!clipArmed) return;
  const d = globalThis.document;
  if (!d?.hasFocus?.()) return;
  clipArmed = false;
  globalThis.navigator?.clipboard?.writeText?.('').catch(() => {});
}

function hookClipboard() {
  if (clipHooks) return;
  clipHooks = true;
  const d = globalThis.document;
  const retry = () => {
    if (clipArmed && !clipTimer) clearClipboardNow();
  };
  globalThis.addEventListener?.('focus', retry);
  d?.addEventListener('visibilitychange', () => {
    if (d.visibilityState === 'visible') retry();
  });
  // The user copied something else in cZEROde: never wipe it.
  d?.addEventListener('copy', () => {
    if (!copying) cancelClear();
  }, true);
  state.onPurge(() => {
    clearTimeout(clipTimer);
    clipTimer = null;
    clearClipboardNow();
  });
}

let copying = false;
async function writeClipboard(text) {
  copying = true;
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall back below
  } finally {
    copying = false;
  }
  const d = globalThis.document;
  const ta = h('textarea', { class: 'visually-hidden', readOnly: true, value: text, attrs: { 'aria-hidden': 'true' } });
  d.body.append(ta);
  ta.select();
  copying = true;
  let ok = false;
  try {
    ok = d.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    copying = false;
    ta.value = '';
    ta.remove();
  }
  return ok;
}

/** A newer copy replaced the clipboard: the pending best-effort clear must not wipe it. */
function cancelClear() {
  clipArmed = false;
  clearTimeout(clipTimer);
  clipTimer = null;
}

function clipTitle() {
  const sec = Number(settings.get('clipboardClearSec')) || 0;
  return sec
    ? `cZEROde tries to clear the clipboard after ${sec} s (only while it's in front). Clipboard history apps may keep a copy.`
    : 'Clipboard clearing is off (Settings → Security). Clipboard history apps may keep a copy.';
}

function scheduleClear() {
  const sec = Number(settings.get('clipboardClearSec')) || 0;
  if (!sec) return;
  hookClipboard();
  clearTimeout(clipTimer);
  clipArmed = true;
  clipTimer = setTimeout(() => {
    clipTimer = null;
    clearClipboardNow(); // not focused: retried once on the next focus/visible
  }, sec * 1000);
}

/**
 * Copy button ("Copy" → "✓ Copied!" for 1.5 s). getText may be async (a sync getText keeps the clipboard
 * write inside the click, which Safari requires). secret=true schedules the best-effort clipboard clear
 * (settings.clipboardClearSec; only while cZEROde is in front); any other copy cancels a pending clear,
 * so ciphertext copied after a secret is never wiped (DESIGN §3.10).
 * @param {() => string|Promise<string>} getText
 * @param {{secret?: boolean, label?: string}} [opts]
 * @returns {HTMLButtonElement}
 */
export function copyButton(getText, { secret = false, label = 'Copy' } = {}) {
  const text = h('span', { text: label });
  let reset = null;
  const refreshTitle = () => {
    if (secret) btn.title = clipTitle();
  };
  async function copy(value) {
    if (!value) {
      toast('Nothing to copy yet', { kind: 'warn' });
      return;
    }
    const ok = await writeClipboard(String(value));
    if (!ok) {
      toast("Couldn't copy — select the text and copy it yourself.", { kind: 'warn' });
      return;
    }
    if (secret) scheduleClear();
    else cancelClear();
    btn.classList.add('copied');
    text.textContent = '✓ Copied!';
    clearTimeout(reset);
    reset = setTimeout(() => {
      btn.classList.remove('copied');
      text.textContent = label;
    }, 1500);
  }
  const btn = h('button', {
    type: 'button',
    class: ['btn', 'btn-sm', 'copy-btn'],
    on: {
      click: () => {
        let value;
        try {
          value = getText();
        } catch {
          value = '';
        }
        if (value && typeof value.then === 'function') value.then(copy, () => copy(''));
        else copy(value);
      },
      pointerenter: refreshTitle,
      focus: refreshTitle,
    },
  }, icon('copy'), text);
  refreshTitle();
  return btn;
}

// ───────── camouflage text

// Colour at most this many UTF-16 units: a 1 M-char ciphertext as ~500k spans freezes the page for seconds.
const STEALTH_COLOR_MAX = 30_000;

/**
 * Renders text with Georgian chars in span.geo and Cyrillic chars in span.cyr (runs of the same
 * class share a span); everything else is plain text. Rendered as text only. Past STEALTH_COLOR_MAX
 * units the rest is one plain text node (same font), so huge outputs stay responsive.
 * @param {string} text
 * @returns {HTMLElement}
 */
export function stealthText(text) {
  const el = h('span', { class: 'stealth', attrs: { translate: 'no' } });
  const s = String(text ?? '');
  let run = '';
  let runClass = null;
  const flush = () => {
    if (!run) return;
    el.append(runClass ? h('span', { class: runClass, text: run }) : run);
    run = '';
  };
  let i = 0;
  for (const ch of s) {
    if (i >= STEALTH_COLOR_MAX) break;
    const c = ch.codePointAt(0);
    const cls = c >= 0x10a0 && c <= 0x10ff ? 'geo' : c >= 0x0400 && c <= 0x04ff ? 'cyr' : null;
    if (cls !== runClass) {
      flush();
      runClass = cls;
    }
    run += ch;
    i += ch.length;
  }
  flush();
  if (i < s.length) el.append(s.slice(i));
  return el;
}
