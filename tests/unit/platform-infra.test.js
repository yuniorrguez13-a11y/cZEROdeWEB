// Platform & infra configuration (DESIGN §2.3, §2.5, §2.6, §8): Tauri config and capabilities, the PWA manifest
// and icons, test pages carrying the app CSP, the static server, committed fixtures and the CI workflows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-phase0.js';
import { RELEASES_URL } from '../../app/config.js';
import { mimeFor, parseRange } from '../../scripts/serve.mjs';
import { FIXTURES, listFixtureFiles } from '../../scripts/gen-fixtures.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));
const conf = json('src-tauri/tauri.conf.json');
const caps = json('src-tauri/capabilities/default.json');
const pkg = json('package.json');

function pngSize(rel) {
  const b = readFileSync(path.join(ROOT, rel));
  assert.deepEqual([...b.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${rel} is a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

const cspOf = (html) => /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];

test('tauri.conf.json: identity, build, window, plugins-facing settings (§2.5)', () => {
  assert.equal(conf.identifier, 'com.czeroode.app');
  assert.equal(conf.productName, 'cZEROde');
  assert.equal(conf.version, '../package.json');
  assert.equal(pkg.version, '2.0.0');
  assert.equal(conf.build.frontendDist, '../dist');
  assert.deepEqual(conf.build.beforeDevCommand, { script: 'node scripts/stage-web.mjs', wait: true });
  assert.equal(conf.build.beforeBuildCommand, 'node scripts/stage-web.mjs');
  assert.equal(conf.app.withGlobalTauri, true);
  assert.equal(conf.app.windows.length, 1);
  const w = conf.app.windows[0];
  assert.equal(w.label, 'main');
  assert.equal(w.useHttpsScheme, true);
  assert.equal(w.dragDropEnabled, false);
});

test('Linux packaging: package/file names follow the czeroode binary, the menu entry still says cZEROde', () => {
  // Tauri names the .deb package after kebab-case(productName): 'cZEROde' would ship as "c-zer-ode".
  const linux = json('src-tauri/tauri.linux.conf.json');
  const crate = /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/m.exec(read('src-tauri/Cargo.toml'))?.[1];
  assert.equal(crate, 'czeroode');
  assert.deepEqual(Object.keys(linux).filter((k) => k !== '$schema'), ['productName'], 'the Linux override changes nothing else');
  assert.equal(linux.productName, crate);
  assert.equal(conf.productName, 'cZEROde', 'Windows/macOS keep the product name');
  const tpl = read(`src-tauri/${conf.bundle.linux.deb.desktopTemplate}`);
  assert.match(tpl, /^Name=cZEROde$/m, 'menu entry name is not the Linux product name');
  assert.doesNotMatch(tpl, /\{\{name\}\}/);
});

test('tauri.conf.json: bundle (file associations, NSIS per user, deb recommends, macOS 12, icons)', () => {
  const b = conf.bundle;
  assert.deepEqual(b.fileAssociations.map((a) => ({ ext: a.ext, name: a.name, mimeType: a.mimeType, role: a.role })), [
    { ext: ['czd'], name: 'cZEROde locked file', mimeType: 'application/x-czeroode', role: 'Viewer' },
    { ext: ['czb'], name: 'cZEROde backup', mimeType: 'application/x-czeroode-backup', role: 'Viewer' },
  ]);
  assert.equal(b.windows.nsis.installMode, 'currentUser');
  assert.deepEqual(b.linux.deb.recommends, ['gstreamer1.0-plugins-good', 'gstreamer1.0-libav']);
  assert.equal(b.macOS.minimumSystemVersion, '12.0');
  for (const icon of b.icon) assert.ok(existsSync(path.join(ROOT, 'src-tauri', icon)), icon);
  const tpl = read(`src-tauri/${b.linux.deb.desktopTemplate}`);
  assert.match(tpl, /^Exec=\{\{exec\}\} %F$/m, 'desktop entry passes the opened files');
  assert.match(tpl, /^MimeType=application\/x-czeroode;application\/x-czeroode-backup;$/m);
  for (const src of Object.values(b.linux.deb.files)) assert.ok(existsSync(path.join(ROOT, 'src-tauri', src)), src);
  assert.match(read('src-tauri/linux/czeroode-mime.xml'), /<glob pattern="\*\.czd"\/>[\s\S]*<glob pattern="\*\.czb"\/>/);
  assert.ok(!existsSync(path.join(ROOT, 'src-tauri/icons/android')) && !existsSync(path.join(ROOT, 'src-tauri/icons/ios')), 'no mobile icon sets');
});

test('capabilities: main window only; fs commands, the vault scopes and deny-default; scoped opener; dialogs', () => {
  assert.deepEqual(caps.windows, ['main']);
  const ids = caps.permissions.map((p) => (typeof p === 'string' ? p : p.identifier));
  for (const p of ['core:default', 'dialog:allow-open', 'dialog:allow-save', 'fs:deny-default', 'fs:allow-write-file', 'fs:allow-open', 'fs:allow-read',
    'fs:allow-seek', 'fs:allow-stat', 'fs:allow-read-dir', 'fs:allow-mkdir', 'fs:allow-remove', 'fs:allow-rename', 'fs:allow-exists', 'fs:allow-read-file']) {
    assert.ok(ids.includes(p), `missing ${p}`);
  }
  for (const banned of ['opener:default', 'opener:allow-open-path', 'opener:allow-default-urls', 'opener:allow-reveal-item-in-dir', 'fs:default',
    'fs:allow-write-text-file', 'fs:allow-read-text-file', 'shell:default', 'dialog:default']) {
    assert.ok(!ids.includes(banned), `must not grant ${banned}`);
  }
  assert.ok(!ids.some((p) => /^fs:(allow|scope)-(app|home|desktop|document|download|picture|video|audio|temp|exe|resource)/.test(p)), 'no broad fs presets');
  const scope = caps.permissions.find((p) => p.identifier === 'fs:scope');
  // The old cZEROde 1 folder is not in the global scope: only the read commands reach it (security-audit.test.js).
  assert.deepEqual(scope.allow, [{ path: '$APPDATA/vault2' }, { path: '$APPDATA/vault2/**' }]);
  assert.equal(scope.deny, undefined);
  const opener = caps.permissions.filter((p) => typeof p === 'object' && p.identifier.startsWith('opener:'));
  assert.deepEqual(opener, [{ identifier: 'opener:allow-open-url', allow: [{ url: RELEASES_URL }] }]);
});

test('Rust shell: single-instance first, open-files event + take_open_files, scoped paths, vault2/items', () => {
  const cargo = read('src-tauri/Cargo.toml');
  for (const dep of ['tauri = { version = "2.12"', 'tauri-plugin-dialog = "2.8"', 'tauri-plugin-fs = "2.6"', 'tauri-plugin-opener = "2.7"', 'tauri-plugin-single-instance = "2.5"']) {
    assert.ok(cargo.includes(dep), dep);
  }
  assert.match(read('src-tauri/Cargo.lock'), /name = "tauri-plugin-single-instance"/);
  const lib = read('src-tauri/src/lib.rs');
  const plugins = [...lib.matchAll(/\.plugin\((tauri_plugin_[a-z_]+)::init/g)].map((m) => m[1]);
  assert.equal(plugins[0], 'tauri_plugin_single_instance');
  assert.deepEqual(plugins.slice(1).sort(), ['tauri_plugin_dialog', 'tauri_plugin_fs', 'tauri_plugin_opener']);
  assert.match(lib, /const OPEN_FILES_EVENT: &str = "open-files";/);
  assert.match(lib, /fn take_open_files\(/);
  assert.match(lib, /allow_file\(/);
  assert.match(lib, /join\("vault2"\)\.join\("items"\)/);
  assert.match(lib, /RunEvent::Opened/);
});

test('manifest.webmanifest (§2.6) and its icons', () => {
  const m = json('manifest.webmanifest');
  assert.equal(m.id, './');
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  assert.equal(m.display, 'standalone');
  assert.equal(m.theme_color, '#0d0d0d');
  assert.equal(m.background_color, '#0d0d0d');
  assert.deepEqual(m.file_handlers, [{ action: './#/incoming', accept: { 'application/x-czeroode': ['.czd'], 'application/x-czeroode-backup': ['.czb'] } }]);
  assert.deepEqual(m.share_target, { action: './share-target', method: 'POST', enctype: 'multipart/form-data', params: { files: [{ name: 'files', accept: ['*/*'] }] } });
  const bySize = {};
  for (const icon of m.icons) {
    const [w, h] = pngSize(icon.src);
    assert.equal(`${w}x${h}`, icon.sizes, icon.src);
    bySize[`${icon.sizes} ${icon.purpose}`] = icon.src;
  }
  assert.ok(bySize['192x192 any'] && bySize['512x512 any'] && bySize['512x512 maskable']);
  assert.deepEqual(pngSize('assets/icons/apple-touch-icon.png'), [180, 180]);
});

test('favicon.ico holds 16, 32 and 48 px PNG images', () => {
  const b = readFileSync(path.join(ROOT, 'favicon.ico'));
  assert.equal(b.readUInt16LE(0), 0);
  assert.equal(b.readUInt16LE(2), 1);
  const n = b.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < n; i++) {
    const e = 6 + i * 16;
    sizes.push(b[e] || 256);
    const off = b.readUInt32LE(e + 12);
    const len = b.readUInt32LE(e + 8);
    assert.ok(off + len <= b.length);
    assert.deepEqual([...b.subarray(off, off + 4)], [0x89, 0x50, 0x4e, 0x47]);
  }
  assert.deepEqual(sizes, [16, 32, 48]);
});

test('test pages run under the app CSP', () => {
  const app = cspOf(read('index.html'));
  assert.ok(app);
  assert.equal(cspOf(read('tests/browser/index.html')), app, 'browser runner');
  assert.equal(cspOf(read('tests/e2e/seed.html')), app, 'legacy seed page');
});

test('serve.mjs: MIME types and single ranges', () => {
  assert.equal(mimeFor('a.js'), 'text/javascript; charset=utf-8');
  assert.equal(mimeFor('a.mjs'), 'text/javascript; charset=utf-8');
  assert.equal(mimeFor('a.wasm'), 'application/wasm');
  assert.equal(mimeFor('manifest.webmanifest'), 'application/manifest+json; charset=utf-8');
  assert.equal(mimeFor('x.CZD'), 'application/x-czeroode');
  assert.equal(mimeFor('x.czb'), 'application/x-czeroode-backup');
  assert.equal(mimeFor('clip.webm'), 'video/webm');
  assert.equal(mimeFor('noext'), 'application/octet-stream');
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=50-500', 100), { start: 50, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), 'invalid');
  assert.equal(parseRange('bytes=-0', 100), 'invalid');
  assert.equal(parseRange('bytes=0-1,5-6', 100), null);
  assert.equal(parseRange(undefined, 100), null);
});

test('committed fixtures match fixtures.json', () => {
  const index = json('tests/fixtures/fixtures.json').files;
  assert.deepEqual(Object.keys(index).sort(), Object.keys(FIXTURES).sort());
  assert.deepEqual(listFixtureFiles().filter((f) => f !== 'fixtures.json'), Object.keys(FIXTURES).sort());
  for (const [name, meta] of Object.entries(index)) {
    const data = readFileSync(path.join(ROOT, 'tests/fixtures', name));
    assert.equal(data.length, meta.size, name);
    assert.equal(createHash('sha256').update(data).digest('hex'), meta.sha256, name);
  }
  assert.ok(index['large.jpg'].size > 5e6 && index['large.jpg'].size < 8e6, 'large JPEG is ~6 MB');
  const legacy = JSON.parse(read('tests/vectors/legacy-desktop-vectors.json')).czd_files[0];
  assert.equal(read('tests/fixtures/legacy/red-dot.czd'), legacy.expected.file_text);
  assert.equal(index['legacy/red-dot.czd'].pin, legacy.pin);
});

test('CI workflows: unit + precache check + browser/e2e on ubuntu, cargo test/clippy, desktop installers', () => {
  const ci = read('.github/workflows/ci.yml');
  for (const s of ['npm ci', 'node scripts/precache.mjs --check', 'npm run test:unit', 'npx playwright install --with-deps chromium', 'npx playwright test',
    'cargo test', 'cargo clippy', 'libwebkit2gtk-4.1-dev']) {
    assert.ok(ci.includes(s), `ci.yml: ${s}`);
  }
  const desk = read('.github/workflows/desktop.yml');
  for (const s of ['tauri-apps/tauri-action@1deb371b0cd8bd54025b384f1cd735e725c4060f # v1', '--bundles nsis', 'windows-latest', 'ubuntu-22.04', 'macos-latest', 'aarch64-apple-darwin', "tags: ['v*']",
    'workflow_dispatch', 'src-tauri/**', 'scripts/**', 'package*.json']) {
    assert.ok(desk.includes(s), `desktop.yml: ${s}`);
  }
});
