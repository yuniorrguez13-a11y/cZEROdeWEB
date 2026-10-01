// Per-device settings in localStorage ('czd2.' + name, JSON). The only module (besides the classic
// theme-boot script) that touches localStorage; every access is wrapped because storage can be
// missing, blocked (private windows, sandboxed iframes) or full. Values that fail validation read
// as the default, so a corrupted entry never breaks the app.

import * as state from './state.js';

/** Default values for every setting. */
export const DEFAULTS = Object.freeze({
  theme: 'gothic',
  idleLockMin: 5,
  hiddenLock: '3m',
  keepAudioWhenHidden: true,
  privacyCover: true,
  clipboardClearSec: 30,
  vaultView: 'grid',
  vaultSort: 'new',
  sendHideName: true,
  sendOnePerFile: false,
  sendKeepDates: false,
  tutorialDone: false,
  dismissed: Object.freeze({}),
});

/** Valid theme names (also accepted from the legacy 'czd_theme' key). */
export const THEMES = Object.freeze(['gothic', 'minimal-white', 'minimal-black']);

const PREFIX = 'czd2.';
const THEME_COLOR = Object.freeze({ gothic: '#0d0d0d', 'minimal-white': '#f5f5f5', 'minimal-black': '#0a0a0a' });
const isPlainObject = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const oneOf = (...xs) => (v) => xs.includes(v);
const VALID = Object.freeze({
  theme: oneOf(...THEMES),
  idleLockMin: oneOf(1, 5, 15, 30, 0),
  hiddenLock: oneOf('immediate', '1m', '3m', '15m', 'never'),
  keepAudioWhenHidden: (v) => typeof v === 'boolean',
  privacyCover: (v) => typeof v === 'boolean',
  clipboardClearSec: oneOf(0, 15, 30, 60),
  vaultView: oneOf('grid', 'list'),
  vaultSort: oneOf('new', 'old', 'name', 'size'),
  sendHideName: (v) => typeof v === 'boolean',
  sendOnePerFile: (v) => typeof v === 'boolean',
  sendKeepDates: (v) => typeof v === 'boolean',
  tutorialDone: (v) => typeof v === 'boolean',
  dismissed: (v) => isPlainObject(v) && Object.values(v).every((x) => ['boolean', 'number', 'string'].includes(typeof x)),
});

// Values written this session when storage refused them (private mode, quota): reads still see them.
const memory = new Map();

function storage() {
  try {
    const ls = globalThis.localStorage;
    return ls && typeof ls.getItem === 'function' ? ls : null;
  } catch {
    return null;
  }
}

function copy(v) {
  return isPlainObject(v) ? { ...v } : v;
}

function read(name) {
  if (memory.has(name)) return { found: true, value: memory.get(name) };
  const ls = storage();
  if (!ls) return { found: false };
  try {
    const raw = ls.getItem(PREFIX + name);
    if (raw === null) return { found: false };
    return { found: true, value: JSON.parse(raw) };
  } catch {
    return { found: false };
  }
}

/**
 * Setting value; the default when unset, unreadable or invalid. Unknown names return the stored
 * JSON value or undefined. Objects are returned as copies.
 * @param {string} name
 * @returns {any}
 */
export function get(name) {
  const known = Object.hasOwn(DEFAULTS, name);
  const r = read(name);
  if (r.found && (!known || VALID[name](r.value))) return copy(r.value);
  return known ? copy(DEFAULTS[name]) : undefined;
}

/**
 * Stores a setting (JSON) and emits state 'settings' {key, value}. Known settings are validated
 * (TypeError on an invalid value). Setting the theme also applies it to <html>.
 * Storage failures are swallowed: the value then lives in memory for this page load.
 * @param {string} name
 * @param {any} value
 */
export function set(name, value) {
  if (typeof name !== 'string' || !name) throw new TypeError('settings.set(): name must be a non-empty string');
  if (Object.hasOwn(VALID, name) && !VALID[name](value)) throw new TypeError(`settings.set(): invalid value for ${name}`);
  if (value === undefined) throw new TypeError('settings.set(): value must not be undefined');
  const json = JSON.stringify(value);
  const stored = copy(JSON.parse(json));
  let ok = false;
  const ls = storage();
  if (ls) {
    try {
      ls.setItem(PREFIX + name, json);
      ok = true;
    } catch {
      ok = false;
    }
  }
  if (ok) memory.delete(name);
  else memory.set(name, stored);
  if (name === 'theme') applyTheme(value);
  state.set('settings', { key: name, value: copy(stored) });
}

/**
 * Every known setting with its current value.
 * @returns {typeof DEFAULTS}
 */
export function all() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = get(k);
  return out;
}

/**
 * One-time migration from cZEROde 1: copies a valid legacy 'czd_theme' to 'czd2.theme' when the
 * new key is absent. The legacy key is left alone ('czd_launched' is ignored on purpose).
 * @returns {boolean} true when something was migrated
 */
export function migrateLegacy() {
  const ls = storage();
  if (!ls) return false;
  try {
    if (ls.getItem(PREFIX + 'theme') !== null) return false;
    const legacy = ls.getItem('czd_theme');
    if (!THEMES.includes(legacy)) return false;
    ls.setItem(PREFIX + 'theme', JSON.stringify(legacy));
    return true;
  } catch {
    return false;
  }
}

/**
 * Applies a theme (default: the stored one) to <html data-theme> and the theme-color meta.
 * No-op without a DOM.
 * @param {string} [theme]
 * @returns {string} the applied theme
 */
export function applyTheme(theme = get('theme')) {
  const t = THEMES.includes(theme) ? theme : DEFAULTS.theme;
  const doc = globalThis.document;
  if (doc?.documentElement) {
    doc.documentElement.dataset.theme = t;
    const meta = doc.querySelector?.('meta[name="theme-color"]');
    if (meta) meta.content = THEME_COLOR[t];
  }
  return t;
}
