// The web precache (sw-assets.js) and the desktop stage (dist/) are the same allowlist (DESIGN §2.1, §2.6).
// sw-assets.js must list every staged file except the service worker scripts, with current hashes.
// When this fails after editing app files: run `node scripts/precache.mjs` (CI runs it with --check).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers-phase0.js';
import { INCLUDE, listStagedFiles, stage } from '../../scripts/stage-web.mjs';
import { EXCLUDE, computeAssets, render, run } from '../../scripts/precache.mjs';

const HINT = 'sw-assets.js is stale — run `node scripts/precache.mjs`';

/** Evaluates sw-assets.js like the worker does; values are copied out of the vm realm. */
function loadSwAssets(file = path.join(ROOT, 'sw-assets.js')) {
  const sandbox = { self: {} };
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: 'sw-assets.js' });
  const { ASSETS, INTEGRITY, ASSET_VERSION } = sandbox.self;
  return { ASSETS: [...ASSETS], INTEGRITY: { ...INTEGRITY }, ASSET_VERSION };
}

const sha = (file) => createHash('sha256').update(readFileSync(path.join(ROOT, file))).digest('base64');

test('stage allowlist is the DESIGN §2.1 app set', () => {
  assert.deepEqual([...INCLUDE], ['index.html', 'app', 'css', 'assets', 'favicon.ico', 'manifest.webmanifest']);
  const staged = listStagedFiles();
  assert.ok(staged.includes('index.html'));
  assert.ok(staged.includes('app/main.js'));
  for (const f of staged) {
    assert.doesNotMatch(f, /^(tests|scripts|src-tauri|node_modules|dist|docs)\//, f);
    assert.doesNotMatch(f, /(^|\/)\./, `dotfile staged: ${f}`);
    assert.ok(!['sw.js', 'sw-assets.js', 'sw-stream.js'].includes(f), `service worker script staged: ${f}`);
  }
});

test('sw-assets.js lists exactly the staged files (minus the worker scripts) and each exists', () => {
  const { ASSETS } = loadSwAssets();
  const expected = listStagedFiles().filter((f) => !EXCLUDE.includes(f));
  assert.deepEqual(ASSETS, expected, HINT);
  for (const f of ASSETS) assert.ok(existsSync(path.join(ROOT, f)), `${f} missing`);
  for (const f of EXCLUDE) assert.ok(!ASSETS.includes(f), `${f} must not be precached`);
});

test('sw-assets.js INTEGRITY holds the current SHA-256 of every asset and ASSET_VERSION matches', () => {
  const { ASSETS, INTEGRITY, ASSET_VERSION } = loadSwAssets();
  assert.deepEqual(Object.keys(INTEGRITY).sort(), [...ASSETS].sort(), HINT);
  const stale = ASSETS.filter((f) => INTEGRITY[f] !== sha(f));
  assert.deepEqual(stale, [], HINT);
  assert.match(ASSET_VERSION, /^[0-9a-f]{12}$/);
  assert.equal(ASSET_VERSION, computeAssets().version, HINT);
  assert.equal(run({ check: true }).stale, false, HINT);
});

test('precache: render is stable and --check detects a changed or added file', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'czd-precache-'));
  try {
    mkdirSync(path.join(root, 'app/sub'), { recursive: true });
    mkdirSync(path.join(root, 'css'));
    writeFileSync(path.join(root, 'index.html'), '<!doctype html>');
    writeFileSync(path.join(root, 'app/a.js'), 'export {};');
    writeFileSync(path.join(root, 'app/sub/b.js'), 'export const b = 1;');
    writeFileSync(path.join(root, 'app/.DS_Store'), 'junk');
    writeFileSync(path.join(root, 'sw.js'), '// worker');
    writeFileSync(path.join(root, 'README.md'), '# no');
    const out = path.join(root, 'sw-assets.js');

    const first = run({ root, out });
    assert.equal(first.stale, true);
    assert.equal(first.count, 3);
    const self = loadSwAssets(out);
    assert.deepEqual(self.ASSETS, ['app/a.js', 'app/sub/b.js', 'index.html']);
    assert.equal(self.INTEGRITY['app/a.js'], createHash('sha256').update('export {};').digest('base64'));
    assert.equal(readFileSync(out, 'utf8'), render(computeAssets(root)));
    assert.equal(run({ root, out, check: true }).stale, false);

    writeFileSync(path.join(root, 'app/a.js'), 'export const changed = true;');
    const changed = run({ root, out, check: true });
    assert.equal(changed.stale, true);
    assert.notEqual(changed.version, first.version);
    assert.equal(run({ root, out }).stale, true);
    assert.equal(run({ root, out, check: true }).stale, false);

    writeFileSync(path.join(root, 'favicon.ico'), 'ico');
    assert.equal(run({ root, out, check: true }).stale, true, 'a new staged file makes it stale');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stage-web copies exactly the allowlist, byte for byte', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'czd-stage-'));
  try {
    const files = stage({ out, quiet: true });
    assert.deepEqual(files, listStagedFiles());
    for (const f of files) assert.ok(readFileSync(path.join(out, f)).equals(readFileSync(path.join(ROOT, f))), f);
    assert.ok(!existsSync(path.join(out, 'sw.js')));
    assert.ok(!existsSync(path.join(out, 'tests')));
    assert.ok(!existsSync(path.join(out, 'src-tauri')));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('sw.js imports sw-assets.js and sw-stream.js and handles the §2.6 routes', () => {
  const sw = readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert.match(sw, /importScripts\('\.\/sw-assets\.js', '\.\/sw-stream\.js'\)/);
  for (const needle of ["cache: 'reload'", 'SKIP_WAITING', 'share-target', 'share-get', 'czstream/', 'self.czStream', 'clients.claim', '.localhost', 'INTEGRITY', 'Response.redirect']) {
    assert.ok(sw.includes(needle), `sw.js mentions ${needle}`);
  }
});
