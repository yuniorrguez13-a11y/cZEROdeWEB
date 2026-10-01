// app/platform.js czstream helpers (DESIGN §5.3) against a fake window.__TAURI__: the stream_register /
// stream_unregister / stream_clear invocations (camelCase arguments, JSON-friendly arrays, the key copy wiped),
// the convertFileSrc URL, input validation before any IPC, error mapping, and the web no-ops.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CzdError } from '../../app/errors.js';

// isTauri is decided when platform.js is evaluated: one instance before the Tauri globals exist (web), one after.
const W = await import('../../app/platform.js?tauri-stream-web');

const calls = [];
let reply = async () => undefined;
globalThis.__TAURI__ = {
  core: {
    async invoke(cmd, args) {
      // What would cross the IPC (JSON) at call time, plus the live args object.
      calls.push({ cmd, json: args === undefined ? undefined : JSON.parse(JSON.stringify(args)), args });
      return reply(cmd, args);
    },
    // Tauri 2 core.js on Linux/macOS: `${protocol}://localhost/${encodeURIComponent(path)}`.
    convertFileSrc(path, protocol = 'asset') {
      return `${protocol}://localhost/${encodeURIComponent(path)}`;
    },
  },
};
globalThis.isTauri = true;
const P = await import('../../app/platform.js?tauri-stream');

const TOKEN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ID = '0123456789abcdef0123456789abcdef';
const fileKey = () => Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const salt = () => Uint8Array.from({ length: 16 }, (_, i) => 200 + i);
const opts = (extra = {}) => ({
  token: TOKEN,
  id: ID,
  fileKey: fileKey(),
  streamSalt: salt(),
  headerLen: 437,
  chunkExp: 18,
  size: 670202,
  paddedSize: 671744,
  mime: 'video/webm',
  ...extra,
});

beforeEach(() => {
  calls.length = 0;
  reply = async () => undefined;
});

async function rejectsCode(promise, code, detail) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof CzdError, `CzdError expected, got ${e}`);
    assert.equal(e.code, code, `expected ${code}, got ${e.code} (${e.message})`);
    if (detail) assert.match(String(e.detail), detail);
    return true;
  });
}

test('register: one stream_register with camelCase JSON arguments, returns the czstream URL', async () => {
  const o = opts();
  const url = await P.tauriStreamRegister(o);
  assert.equal(url, `czstream://localhost/${TOKEN}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'stream_register');
  assert.deepEqual(calls[0].json, {
    token: TOKEN,
    id: ID,
    fileKey: [...fileKey()],
    streamSalt: [...salt()],
    headerLen: 437,
    chunkExp: 18,
    size: 670202,
    paddedSize: 671744,
    mime: 'video/webm',
  });
  assert.ok(Array.isArray(calls[0].args.fileKey), 'a plain array: Tauri serializes a Uint8Array as an object');
  assert.deepEqual(calls[0].args.fileKey, new Array(32).fill(0), 'the IPC copy of the key is wiped afterwards');
  assert.deepEqual(o.fileKey, fileKey(), "the caller's Opened.fileKey is left alone");
});

test('register: the key copy is wiped when Rust refuses too, and the refusal is a CzdError', async () => {
  reply = async () => {
    throw 'czstream: item file size does not match';
  };
  await rejectsCode(P.tauriStreamRegister(opts()), 'internal', /item file size/);
  assert.deepEqual(calls[0].args.fileKey, new Array(32).fill(0));
  reply = async () => {
    throw 'No space left on device (os error 28)';
  };
  await rejectsCode(P.tauriStreamRegister(opts()), 'quota-exceeded');
});

test('register: a fresh base32 token when none is given; unregister accepts the URL', async () => {
  const a = await P.tauriStreamRegister(opts({ token: undefined }));
  const b = await P.tauriStreamRegister(opts({ token: undefined }));
  const ta = calls[0].json.token;
  const tb = calls[1].json.token;
  assert.match(ta, /^[A-Z2-7]{26}$/);
  assert.notEqual(ta, tb);
  assert.equal(a, `czstream://localhost/${ta}`);
  assert.equal(b, `czstream://localhost/${tb}`);
  await P.tauriStreamUnregister(a);
  await P.tauriStreamUnregister(`https://czstream.localhost/${tb}`);
  assert.deepEqual(calls.slice(2).map((c) => [c.cmd, c.json]), [
    ['stream_unregister', { token: ta }],
    ['stream_unregister', { token: tb }],
  ]);
});

test('register: media types go through safeMediaType', async () => {
  for (const [mime, want] of [
    ['Video/WebM; codecs="vp8, vorbis"', 'video/webm'],
    ['audio/ogg', 'audio/ogg'],
    ['text/html', 'application/octet-stream'],
    ['image/svg+xml', 'application/octet-stream'],
    [undefined, 'application/octet-stream'],
    [42, 'application/octet-stream'],
  ]) {
    calls.length = 0;
    await P.tauriStreamRegister(opts({ mime }));
    assert.equal(calls[0].json.mime, want, String(mime));
  }
});

test('register: invalid values are refused before any IPC', async () => {
  const bad = [
    [null, 'options'],
    [opts({ token: 'abcdefghijklmnopqrstuvwxyz' }), 'token'],
    [opts({ token: 'ABCDEFGHIJKLMNOPQRSTUVWXY' }), 'token'],
    [opts({ token: 'ABCDEFGHIJKLMNOPQRSTUVWXY1' }), 'token'],
    [opts({ token: 42 }), 'token'],
    [opts({ id: ID.toUpperCase() }), 'id'],
    [opts({ id: `${ID}0` }), 'id'],
    [opts({ id: '../../vault/x' }), 'id'],
    [opts({ id: undefined }), 'id'],
    [opts({ fileKey: fileKey().subarray(1) }), 'fileKey'],
    [opts({ fileKey: [...fileKey()] }), 'fileKey'],
    [opts({ fileKey: null }), 'fileKey'],
    [opts({ streamSalt: new Uint8Array(15) }), 'streamSalt'],
    [opts({ headerLen: -1 }), 'headerLen'],
    [opts({ headerLen: 1.5 }), 'headerLen'],
    [opts({ headerLen: '437' }), 'headerLen'],
    [opts({ chunkExp: 11 }), 'chunkExp'],
    [opts({ chunkExp: 25 }), 'chunkExp'],
    [opts({ chunkExp: 18.5 }), 'chunkExp'],
    [opts({ size: -1 }), 'size'],
    [opts({ size: 2 ** 53 }), 'size'],
    [opts({ size: 10, paddedSize: 9 }), 'size'],
    [opts({ paddedSize: undefined }), 'size'],
  ];
  for (const [o, what] of bad) {
    await rejectsCode(P.tauriStreamRegister(o), 'internal', new RegExp(`bad ${what}`));
  }
  assert.equal(calls.length, 0);
});

test('unregister and clear invoke their commands; bad tokens never reach Rust', async () => {
  await P.tauriStreamUnregister(TOKEN);
  await P.tauriStreamClear();
  assert.deepEqual(calls.map((c) => [c.cmd, c.json]), [
    ['stream_unregister', { token: TOKEN }],
    ['stream_clear', undefined],
  ]);
  calls.length = 0;
  for (const t of [undefined, '', 'abc', `${TOKEN}A`, 'https://example.com/x', `https://example.com/${TOKEN}`]) {
    await rejectsCode(P.tauriStreamUnregister(t), 'internal');
  }
  assert.equal(calls.length, 0);
  reply = async () => {
    throw 'boom';
  };
  await rejectsCode(P.tauriStreamClear(), 'internal', /boom/);
});

test('web: register rejects, unregister and clear are no-ops', async () => {
  assert.equal(W.isTauri, false);
  await rejectsCode(W.tauriStreamRegister(opts()), 'internal', /desktop only/);
  assert.equal(await W.tauriStreamUnregister(TOKEN), undefined);
  assert.equal(await W.tauriStreamClear(), undefined);
  assert.equal(calls.length, 0);
});

test('Linux refusal: unsupported-media, and later registrations do not ask Rust again', async () => {
  const U = await import('../../app/platform.js?tauri-stream-unsupported');
  reply = async () => {
    throw 'czstream: unsupported: this webview cannot play media from a custom URI scheme';
  };
  await rejectsCode(U.tauriStreamRegister(opts()), 'unsupported-media', /unsupported/);
  assert.deepEqual(calls[0].args.fileKey, new Array(32).fill(0));
  await rejectsCode(U.tauriStreamRegister(opts()), 'unsupported-media');
  assert.equal(calls.length, 1, 'no second IPC');
  // Unregister/clear still reach Rust (lock must always clear).
  reply = async () => undefined;
  await U.tauriStreamClear();
  assert.equal(calls.at(-1).cmd, 'stream_clear');
});

test('the refusal prefix matches src-tauri/src/stream.rs', async () => {
  const { readFileSync } = await import('node:fs');
  const rs = readFileSync(new URL('../../src-tauri/src/stream.rs', import.meta.url), 'utf8');
  assert.match(rs, /const UNSUPPORTED: &str =\s*"czstream: unsupported: /);
  const js = readFileSync(new URL('../../app/platform.js', import.meta.url), 'utf8');
  assert.match(js, /const STREAM_UNSUPPORTED = 'czstream: unsupported:';/);
});

// ───────── races with lock / unregister while stream_register is in flight (adversarial review)
// Rust reads its clear epoch inside the async command, i.e. on a runtime thread some time after the IPC was
// dispatched; a stream_clear (sync, main thread) sent later can run first, and the late registration then
// survives the lock. The page side must drop it.

/** stream_register replies only when release() is called; the rest reply at once. */
function holdRegister() {
  const held = {};
  reply = (cmd) => (cmd === 'stream_register' ? new Promise((resolve, reject) => Object.assign(held, { resolve, reject })) : Promise.resolve());
  return held;
}

test('race: a clear (lock) during stream_register wins: the late registration is dropped, the call rejects aborted', async () => {
  const held = holdRegister();
  const p = P.tauriStreamRegister(opts());
  await P.tauriStreamClear();
  held.resolve();
  await rejectsCode(p, 'aborted');
  assert.deepEqual(calls.map((c) => [c.cmd, c.json?.token]), [
    ['stream_register', TOKEN],
    ['stream_clear', undefined],
    ['stream_unregister', TOKEN],
  ]);
  assert.deepEqual(calls[0].args.fileKey, new Array(32).fill(0), 'key copy still wiped');
});

test('race: unregistering a token whose registration is in flight drops it once Rust answers', async () => {
  const held = holdRegister();
  const p = P.tauriStreamRegister(opts());
  await P.tauriStreamUnregister(TOKEN);
  held.resolve();
  await rejectsCode(p, 'aborted');
  assert.deepEqual(calls.map((c) => [c.cmd, c.json?.token]), [
    ['stream_register', TOKEN],
    ['stream_unregister', TOKEN],
    ['stream_unregister', TOKEN],
  ]);
  // A later registration of a fresh token is unaffected.
  reply = async () => undefined;
  assert.equal(await P.tauriStreamRegister(opts({ token: 'ZYXWVUTSRQPONMLKJIHGFEDCBA' })), 'czstream://localhost/ZYXWVUTSRQPONMLKJIHGFEDCBA');
});

test('race: a clear before the call or after it resolved does not cancel it; a refused registration stays refused', async () => {
  await P.tauriStreamClear();
  assert.equal(await P.tauriStreamRegister(opts()), `czstream://localhost/${TOKEN}`);
  await P.tauriStreamClear();
  const held = holdRegister();
  const p = P.tauriStreamRegister(opts());
  await P.tauriStreamClear();
  held.reject('czstream: item file size does not match');
  await rejectsCode(p, 'internal', /item file size/);
  assert.deepEqual(calls.map((c) => c.cmd), ['stream_clear', 'stream_register', 'stream_clear', 'stream_register', 'stream_clear']);
});

test('race: the same token cannot be registered twice at once (no second IPC)', async () => {
  const held = holdRegister();
  const p = P.tauriStreamRegister(opts());
  await rejectsCode(P.tauriStreamRegister(opts()), 'internal', /token/);
  held.resolve();
  assert.equal(await p, `czstream://localhost/${TOKEN}`);
  assert.deepEqual(calls.map((c) => c.cmd), ['stream_register']);
});

test('no registration is left behind when the URL cannot be built', async () => {
  const conv = globalThis.__TAURI__.core.convertFileSrc;
  globalThis.__TAURI__.core.convertFileSrc = () => {
    throw new TypeError('convertFileSrc missing');
  };
  try {
    await rejectsCode(P.tauriStreamRegister(opts()), 'internal');
  } finally {
    globalThis.__TAURI__.core.convertFileSrc = conv;
  }
  const live = new Set();
  for (const c of calls) {
    if (c.cmd === 'stream_register') live.add(c.json.token);
    if (c.cmd === 'stream_unregister') live.delete(c.json.token);
  }
  assert.deepEqual([...live], [], 'every stream_register is undone');
});
