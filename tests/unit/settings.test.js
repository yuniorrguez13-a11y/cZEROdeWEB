// app/settings.js with a fake localStorage injected via globalThis: czd2.* JSON keys, validation,
// defaults on corrupt values, legacy theme migration, storage failures, state 'settings' events.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as settings from '../../app/settings.js';
import * as state from '../../app/state.js';

class FakeStorage {
  constructor() {
    this.map = new Map();
    this.failWrites = false;
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    if (this.failWrites) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}

let ls;
beforeEach(() => {
  ls = new FakeStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true });
});

test('defaults when nothing is stored', () => {
  assert.deepEqual(settings.all(), { ...settings.DEFAULTS, dismissed: {} });
  assert.equal(settings.get('theme'), 'gothic');
  assert.equal(settings.get('idleLockMin'), 5);
  assert.equal(settings.get('hiddenLock'), '3m');
  assert.equal(settings.get('clipboardClearSec'), 30);
  assert.equal(settings.get('unknownThing'), undefined);
});

test('set stores JSON under czd2.<name> and get reads it back', () => {
  settings.set('theme', 'minimal-black');
  settings.set('idleLockMin', 0);
  settings.set('keepAudioWhenHidden', false);
  settings.set('dismissed', { legacy: true, backupAt: 123 });
  assert.equal(ls.getItem('czd2.theme'), '"minimal-black"');
  assert.equal(ls.getItem('czd2.idleLockMin'), '0');
  assert.equal(ls.getItem('czd2.keepAudioWhenHidden'), 'false');
  assert.equal(settings.get('theme'), 'minimal-black');
  assert.equal(settings.get('idleLockMin'), 0);
  assert.equal(settings.get('keepAudioWhenHidden'), false);
  assert.deepEqual(settings.get('dismissed'), { legacy: true, backupAt: 123 });
});

test('returned objects are copies', () => {
  settings.set('dismissed', { a: true });
  const d = settings.get('dismissed');
  d.b = true;
  assert.deepEqual(settings.get('dismissed'), { a: true });
  const def = settings.get('dismissed');
  def.x = 1;
  assert.deepEqual(settings.DEFAULTS.dismissed, {});
});

test('invalid values are rejected on set (known settings)', () => {
  assert.throws(() => settings.set('theme', 'neon'), TypeError);
  assert.throws(() => settings.set('idleLockMin', 7), TypeError);
  assert.throws(() => settings.set('hiddenLock', '2m'), TypeError);
  assert.throws(() => settings.set('clipboardClearSec', 45), TypeError);
  assert.throws(() => settings.set('vaultSort', 'random'), TypeError);
  assert.throws(() => settings.set('privacyCover', 'yes'), TypeError);
  assert.throws(() => settings.set('dismissed', []), TypeError);
  assert.throws(() => settings.set('dismissed', { x: { nested: 1 } }), TypeError);
  assert.throws(() => settings.set('', 1), TypeError);
  assert.throws(() => settings.set('custom', undefined), TypeError);
  assert.equal(ls.map.size, 0);
});

test('corrupt or invalid stored values read as the default', () => {
  ls.setItem('czd2.theme', '{not json');
  ls.setItem('czd2.idleLockMin', '"5"');
  ls.setItem('czd2.vaultView', '"mosaic"');
  ls.setItem('czd2.dismissed', '[1,2]');
  assert.equal(settings.get('theme'), 'gothic');
  assert.equal(settings.get('idleLockMin'), 5);
  assert.equal(settings.get('vaultView'), 'grid');
  assert.deepEqual(settings.get('dismissed'), {});
});

test('unknown settings round-trip any JSON value', () => {
  settings.set('lastSeenVersion', '2.0.0');
  assert.equal(settings.get('lastSeenVersion'), '2.0.0');
  settings.set('someList', [1, 2]);
  assert.deepEqual(settings.get('someList'), [1, 2]);
});

test('set emits state "settings" {key, value}', () => {
  const seen = [];
  const off = state.on('settings', (v) => seen.push(v));
  settings.set('vaultSort', 'size');
  settings.set('vaultSort', 'name');
  off();
  assert.deepEqual(seen, [{ key: 'vaultSort', value: 'size' }, { key: 'vaultSort', value: 'name' }]);
});

test('storage failures: writes stay in memory for this page load, reads never throw', () => {
  ls.failWrites = true;
  settings.set('vaultView', 'list');
  assert.equal(settings.get('vaultView'), 'list');
  assert.equal(ls.getItem('czd2.vaultView'), null);
  ls.failWrites = false;
  settings.set('vaultView', 'grid');
  assert.equal(ls.getItem('czd2.vaultView'), '"grid"');
  assert.equal(settings.get('vaultView'), 'grid');
});

test('missing or throwing localStorage falls back to defaults', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError');
    },
  });
  assert.equal(settings.get('theme'), 'gothic');
  assert.doesNotThrow(() => settings.set('sendHideName', false));
  assert.equal(settings.get('sendHideName'), false, 'kept in memory');
  assert.equal(settings.migrateLegacy(), false);
  Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true });
  assert.equal(settings.get('clipboardClearSec'), 30);
  // reset the in-memory override for the next tests
  Object.defineProperty(globalThis, 'localStorage', { value: new FakeStorage(), configurable: true, writable: true });
  settings.set('sendHideName', true);
});

test('migrateLegacy copies a valid czd_theme once, never overwrites czd2.theme', () => {
  ls.setItem('czd_theme', 'minimal-white');
  ls.setItem('czd_launched', '1');
  assert.equal(settings.migrateLegacy(), true);
  assert.equal(ls.getItem('czd2.theme'), '"minimal-white"');
  assert.equal(settings.get('theme'), 'minimal-white');
  assert.equal(ls.getItem('czd_theme'), 'minimal-white', 'legacy key left alone');
  assert.equal(settings.get('tutorialDone'), false, 'czd_launched is ignored');
  ls.setItem('czd_theme', 'minimal-black');
  assert.equal(settings.migrateLegacy(), false, 'only once: czd2.theme exists');
  assert.equal(settings.get('theme'), 'minimal-white');
});

test('migrateLegacy ignores invalid legacy values', () => {
  ls.setItem('czd_theme', 'hacker-green');
  assert.equal(settings.migrateLegacy(), false);
  assert.equal(ls.getItem('czd2.theme'), null);
  assert.equal(settings.get('theme'), 'gothic');
});

test('applyTheme without a DOM is a no-op that returns the theme', () => {
  assert.equal(settings.applyTheme('minimal-black'), 'minimal-black');
  assert.equal(settings.applyTheme('bogus'), 'gothic');
});

// ───────── review regressions (C1 adversarial review): app/theme-boot.js (classic script, run in node:vm)

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function runThemeBoot(store, { throwOnRead = false } = {}) {
  const attrs = {};
  const meta = { content: '#0d0d0d', setAttribute(k, v) { this[k] = v; } };
  const window = {
    get localStorage() {
      if (throwOnRead) throw new Error('SecurityError: storage blocked');
      return { getItem: (k) => (Object.hasOwn(store, k) ? store[k] : null) };
    },
  };
  const document = {
    documentElement: { setAttribute: (k, v) => { attrs[k] = v; } },
    querySelector: (sel) => (sel === 'meta[name="theme-color"]' ? meta : null),
  };
  const code = readFileSync(new URL('../../app/theme-boot.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { window, document });
  return { theme: attrs['data-theme'], color: meta.content };
}

test('theme-boot: czd2.theme first, legacy czd_theme as fallback, default on anything odd', () => {
  assert.deepEqual(runThemeBoot({}), { theme: 'gothic', color: '#0d0d0d' });
  assert.deepEqual(runThemeBoot({ 'czd2.theme': '"minimal-white"' }), { theme: 'minimal-white', color: '#f5f5f5' });
  assert.deepEqual(runThemeBoot({ czd_theme: 'minimal-black' }), { theme: 'minimal-black', color: '#0a0a0a' }, 'no theme flash for v1 users before migrateLegacy');
  assert.equal(runThemeBoot({ 'czd2.theme': '"gothic"', czd_theme: 'minimal-black' }).theme, 'gothic', 'new key wins');
  assert.equal(runThemeBoot({ 'czd2.theme': '{corrupt' }).theme, 'gothic');
  assert.equal(runThemeBoot({ 'czd2.theme': '"neon"' }).theme, 'gothic');
  assert.equal(runThemeBoot({ czd_theme: '"><script>' }).theme, 'gothic', 'legacy value validated');
  assert.equal(runThemeBoot({ czd_theme: 'minimal-white' }, { throwOnRead: true }).theme, 'gothic', 'blocked storage');
});
