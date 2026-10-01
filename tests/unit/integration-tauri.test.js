// Desktop (Tauri) integration details against the in-memory window.__TAURI__ (tests/unit/platform-fakes.js):
// tauriFs.stat (plugin-fs stat → {size, mtime}) and TauriFsStore using it instead of listing the items folder, and
// media.playLimit / playableUrl where czstream is unavailable (Linux WebKitGTK, or after Rust refused a registration:
// DESIGN §12) — the import-time "too big to play on this device" warning needs the Blob cap there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeTauri } from './platform-fakes.js';
import { CzdError } from '../../app/errors.js';
import { CAPS } from '../../app/config.js';
import { randomBytes } from '../../app/util/bytes.js';
import { seal } from './container-helpers.js';
import * as C from '../../app/crypto/container.js';
import { bytesSource } from '../../app/util/stream.js';

const fake = fakeTauri();
const WINDOWS = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', platform: 'Win32' };
const LINUX = { userAgent: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)', platform: 'Linux x86_64' };
const nav = { ...WINDOWS };
Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
const useNav = (n) => Object.assign(nav, n);

// stream_register / convertFileSrc on top of the fake (the fake knows only take_open_files).
const invoked = [];
let refuse = false;
const baseInvoke = globalThis.__TAURI__.core.invoke;
globalThis.__TAURI__.core.invoke = async (cmd, args) => {
  invoked.push(cmd);
  if (cmd === 'stream_register') {
    if (refuse) throw 'czstream: unsupported: this webview cannot play media from a custom URI scheme';
    return undefined;
  }
  if (cmd === 'stream_unregister' || cmd === 'stream_clear') return undefined;
  return baseInvoke(cmd, args);
};
globalThis.__TAURI__.core.convertFileSrc = (path, protocol) => `${protocol}://localhost/${encodeURIComponent(path)}`;

// isTauri is decided when platform.js is first evaluated: the fake exists by now.
const platform = await import('../../app/platform.js');
const media = await import('../../app/media/media.js');
const { TauriFsStore } = await import('../../app/vault/store.js');

const ID = '0123456789abcdef0123456789abcdef';

async function vaultItemSource(bytes) {
  const file = await seal(bytes, { chunkExp: 12, meta: { name: 'clip.webm', type: 'video/webm' } });
  const src = bytesSource(file);
  const opened = await C.openSource(src, { passphrase: 'pw' });
  return { kind: 'container', src, opened, itemId: ID };
}

test('tauriFs.stat: {size, mtime} through plugin-fs stat; a missing file rejects CzdError', async () => {
  assert.equal(platform.isTauri, true);
  const path = `${fake.appData}/vault2/items/${ID}.czd`;
  fake.dirs.add(`${fake.appData}/vault2`);
  fake.dirs.add(`${fake.appData}/vault2/items`);
  fake.files.set(path, randomBytes(1234));
  assert.deepEqual(await platform.tauriFs.stat(path), { size: 1234, mtime: 1_700_000_000_000 });
  await assert.rejects(platform.tauriFs.stat(`${path}.nope`), (e) => e instanceof CzdError && e.code === 'internal');
  fake.files.delete(path);
});

test('TauriFsStore (default fs) sizes an item with tauriFs.stat, without listing the items folder', async () => {
  const store = new TauriFsStore();
  await store.init();
  const data = randomBytes(5000);
  await store.write(ID, data);
  const fresh = new TauriFsStore(); // a cold size cache, like the first source() of a session
  await fresh.init();
  const realReadDir = globalThis.__TAURI__.fs.readDir;
  let listed = 0;
  globalThis.__TAURI__.fs.readDir = async (dir) => {
    listed++;
    return realReadDir(dir);
  };
  try {
    const src = await fresh.source(ID);
    assert.equal(src.size, 5000);
    assert.deepEqual(await src.readAt(100, 10), data.subarray(100, 110));
    assert.equal(listed, 0, 'no folder listing');
    await assert.rejects(fresh.source('f'.repeat(32)), (e) => e instanceof CzdError && e.code === 'item-file-missing');
  } finally {
    globalThis.__TAURI__.fs.readDir = realReadDir;
    await store.delete(ID);
  }
});

test('files opened with the desktop app (argv / file association / second instance) land in incoming.files + #/incoming', async () => {
  const state = await import('../../app/state.js');
  const loc = { hash: '#/vault', href: 'tauri://localhost/index.html#/vault', hostname: 'tauri.localhost' };
  Object.defineProperty(globalThis, 'location', { value: loc, configurable: true, writable: true });
  fake.dirs.add('/home/bob');
  fake.files.set('/home/bob/sent.czd', randomBytes(300));
  fake.files.set('/home/bob/b.czb', randomBytes(100));
  fake.pending.push('/home/bob/sent.czd'); // the launch argv: queued in Rust before the page listens
  const until = async (fn) => {
    for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(fn(), 'timed out');
  };
  // main.js calls this once at startup; under Tauri it wires platform.onOpenFiles and registers no service worker.
  const pwa = await import('../../app/pwa.js');
  pwa.registerServiceWorker();
  await until(() => state.get('incoming.files'));
  const first = state.get('incoming.files');
  assert.deepEqual(first.map((f) => [f.name, f.size]), [['sent.czd', 300]]);
  assert.ok(first[0] instanceof File);
  assert.equal(loc.hash, '#/incoming');
  // The consuming view (send-view) takes the files and clears the key; a second instance forwards more later.
  state.set('incoming.files', null);
  loc.hash = '#/text';
  fake.pending.push('/home/bob/b.czb');
  fake.emit('open-files', ['/home/bob/b.czb']);
  await until(() => state.get('incoming.files'));
  assert.deepEqual(state.get('incoming.files').map((f) => f.name), ['b.czb']);
  assert.equal(loc.hash, '#/incoming');
  assert.equal(fake.listenerCount('open-files'), 1);
  state.set('incoming.files', null);
});

test('playLimit: unlimited audio/video with czstream (Windows/macOS), the Blob cap on Linux', () => {
  useNav(WINDOWS);
  assert.equal(platform.tauriStreamAvailable(), true);
  assert.equal(media.playLimit('image'), CAPS.image);
  assert.equal(media.playLimit('video'), Infinity);
  assert.equal(media.playLimit('audio'), Infinity);
  useNav(LINUX);
  try {
    assert.equal(platform.tauriStreamAvailable(), false);
    assert.equal(media.playLimit('video'), CAPS.blobDesktop);
    assert.equal(media.playLimit('audio'), CAPS.blobDesktop);
    assert.equal(media.playLimit('image'), CAPS.image);
  } finally {
    useNav(WINDOWS);
  }
});

test('playableUrl on Linux: a Blob URL, and the file key never goes to Rust', async () => {
  useNav(LINUX);
  invoked.length = 0;
  try {
    const s = await vaultItemSource(randomBytes(3000));
    const h = await media.playableUrl(s, { mode: 'video' });
    assert.equal(h.via, 'blob');
    assert.ok(h.url.startsWith('blob:'));
    h.release();
    assert.ok(!invoked.includes('stream_register'), 'no stream_register on Linux');
    C.release(s.opened);
  } finally {
    useNav(WINDOWS);
  }
});

// Last: the refusal is sticky for the page's lifetime.
test('after Rust refuses a registration, playLimit falls back to the Blob cap everywhere', async () => {
  useNav(WINDOWS);
  const s = await vaultItemSource(randomBytes(3000));
  const ok = await media.playableUrl(s, { mode: 'video' });
  assert.equal(ok.via, 'tauri');
  ok.release();
  refuse = true;
  const h = await media.playableUrl(s, { mode: 'video' });
  assert.equal(h.via, 'blob', 'refused → Blob within the cap');
  h.release();
  assert.equal(platform.tauriStreamAvailable(), false);
  assert.equal(media.playLimit('video'), CAPS.blobDesktop);
  invoked.length = 0;
  const again = await media.playableUrl(s, { mode: 'audio' });
  assert.equal(again.via, 'blob');
  again.release();
  assert.ok(!invoked.includes('stream_register'), 'no second request after the refusal');
  C.release(s.opened);
});
