// sw-stream.js (DESIGN §5.2) in node:vm with minimal service-worker globals: every media/download response is
// compared with container.decryptRange / the plaintext for sizes {0, 1, CS−1, CS, CS+1, 266240 @ chunkExp 12
// (padding-only extra chunk), 17,039,359 @ 18} and random ranges (suffix, open-ended, 416, ignored headers),
// bundle entry ranges, the 'need' handshake, access rules, single-use downloads and the lock epoch.
// The real worker in Chromium is covered by tests/e2e/media.spec.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers-phase0.js';
import * as C from '../../app/crypto/container.js';
import { bytesSource } from '../../app/util/stream.js';
import { toBase32, randomBytes } from '../../app/util/bytes.js';
import { craft, same, seal } from './container-helpers.js';
import { prngBytes } from '../../scripts/gen-vectors.mjs';

const CODE = readFileSync(path.join(ROOT, 'sw-stream.js'), 'utf8');
const SCOPE = 'https://example.test/app/';

/** Deterministic PRNG for ranges (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Loads sw-stream.js into a fresh realm. Timers run fast (≤ 30 ms) so the 2 s 'need' timeout is quick. */
function loadStream() {
  const clock = { now: Date.now() };
  const clients = new Map();
  const posted = []; // [clientId, msg]
  const sandbox = {
    self: {
      clients: {
        get: async (id) => clients.get(id) ?? null,
        matchAll: async () => [...clients.values()],
      },
    },
    crypto: globalThis.crypto,
    CryptoKey: globalThis.CryptoKey,
    Blob,
    Response,
    ReadableStream,
    URL,
    MessageChannel,
    Uint8Array,
    ArrayBuffer,
    Promise,
    Map,
    Set,
    Error,
    TypeError,
    Number,
    Math,
    Object,
    Array,
    String,
    encodeURIComponent,
    Date: { now: () => clock.now },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 30)),
    clearTimeout,
  };
  vm.runInNewContext(CODE, sandbox, { filename: 'sw-stream.js' });
  const stream = sandbox.self.czStream;

  /** A window client; `onNeed(token)` returns the reply for a 'need' message (undefined = never answer). */
  function addClient(id, onNeed = () => ({ deny: true })) {
    const c = {
      id,
      needs: [],
      postMessage(msg, transfer) {
        posted.push([id, msg]);
        if (msg && msg.cmd === 'need') {
          c.needs.push(msg.token);
          const reply = onNeed(msg.token);
          if (reply !== undefined) transfer[0].postMessage(reply);
          else setTimeout(() => transfer[0].close(), 100).unref();
        }
      },
    };
    clients.set(id, c);
    return c;
  }

  function message(data, clientId = 'client-1') {
    let reply;
    const waits = [];
    stream.onMessage({ data, ports: [{ postMessage: (m) => (reply = m) }], source: clientId === null ? null : { id: clientId }, waitUntil: (p) => waits.push(p) });
    return plain(reply);
  }

  async function fetch(token, { range, clientId = 'client-1', mode = 'cors', method = 'GET', download = false } = {}) {
    const url = `${SCOPE}czstream/${token}${download ? '?download=1' : ''}`;
    const headers = new Headers(range === undefined ? {} : { Range: range });
    const waits = [];
    const res = await stream.handle({ request: { url, method, mode, headers }, clientId, waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    return res;
  }

  addClient('client-1'); // the page every test registers from (register sweeps tokens of pages that are gone)
  return { stream, clock, clients, posted, addClient, message, fetch };
}

const newToken = () => toBase32(randomBytes(16));
/** Copies a vm-realm object into this realm (deepStrictEqual compares prototypes). */
const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

/** A sealed container + opened header + register payload. */
async function fixture(size, { chunkExp = 12, data, mime = 'video/webm', name = 'clip.webm', seed = size } = {}) {
  const plain = data ?? prngBytes(seed, size);
  const file = await seal(plain, { chunkExp, meta: { name, type: mime } });
  const src = bytesSource(file);
  const opened = await C.openSource(src, { passphrase: 'pw' });
  const payload = (extra = {}) => ({
    cmd: 'register',
    token: newToken(),
    blob: new Blob([file]),
    payKey: opened.keys.pay,
    headerLen: opened.headerLen,
    chunkExp: opened.chunkExp,
    size: opened.size,
    paddedSize: opened.paddedSize,
    mime,
    filename: name,
    download: false,
    ...extra,
  });
  return { plain, file, src, opened, payload };
}

const bytesOf = async (res) => new Uint8Array(await res.arrayBuffer());

/** Expected outcome of one Range header for a plaintext of `total` bytes (independent of sw-stream.js). */
function expectRange(header, total) {
  if (header === undefined) return { status: 200, start: 0, end: total - 1 };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return { status: 200, start: 0, end: total - 1 };
  if (m[1] === '') {
    const k = Number(m[2]);
    if (k === 0 || total === 0) return { status: 416 };
    return { status: 206, start: Math.max(0, total - k), end: total - 1 };
  }
  const a = Number(m[1]);
  const b = m[2] === '' ? Infinity : Number(m[2]);
  if (b < a) return { status: 200, start: 0, end: total - 1 };
  if (a >= total) return { status: 416 };
  return { status: 206, start: a, end: Math.min(b, total - 1) };
}

function rangeHeaders(total, n, seed) {
  const r = rng(seed);
  const pick = (max) => Math.floor(r() * (max + 1));
  const out = [undefined, 'bytes=0-', 'bytes=0-0', `bytes=${total}-`, `bytes=${total + 5}-${total + 9}`, 'bytes=-1', `bytes=-${total + 10}`,
    'bytes=-0', 'bytes=5-2', 'bytes=0-1,4-5', 'items=0-1', 'bytes=-', `bytes=0-${total * 3 + 1}`];
  if (total > 0) out.push(`bytes=${total - 1}-`, `bytes=${total - 1}-${total - 1}`, `bytes=-${total}`);
  for (let i = 0; i < n; i++) {
    const a = pick(Math.max(0, total - 1));
    const kind = i % 4;
    if (kind === 0) out.push(`bytes=${a}-${a + pick(Math.max(0, total - a))}`);
    else if (kind === 1) out.push(`bytes=${a}-`);
    else if (kind === 2) out.push(`bytes=-${1 + pick(total)}`);
    else out.push(`bytes=${a}-${a + pick(3 * 4096)}`);
  }
  return out;
}

async function checkRanges(w, fx, token, total, base, seed, n = 24) {
  for (const header of rangeHeaders(total, n, seed)) {
    const exp = expectRange(header, total);
    const res = await w.fetch(token, { range: header });
    assert.equal(res.status, exp.status, `status for ${header} (total ${total})`);
    assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
    if (exp.status === 416) {
      assert.equal(res.headers.get('Content-Range'), `bytes */${total}`);
      assert.equal((await bytesOf(res)).length, 0);
      continue;
    }
    const got = await bytesOf(res);
    const len = Math.max(0, exp.end - exp.start + 1);
    assert.equal(res.headers.get('Content-Length'), String(len), `Content-Length for ${header}`);
    if (exp.status === 206) assert.equal(res.headers.get('Content-Range'), `bytes ${exp.start}-${exp.end}/${total}`);
    else assert.equal(res.headers.get('Content-Range'), null);
    const want = len ? await C.decryptRange(fx.src, fx.opened, base + exp.start, base + exp.end) : new Uint8Array(0);
    assert.ok(same(got, want), `body for ${header} (total ${total}, base ${base})`);
  }
}

const SIZES = [
  [0, 12], [1, 12], [4095, 12], [4096, 12], [4097, 12], [266240, 12],
  [2 ** 18 - 1, 18], [2 ** 18, 18], [2 ** 18 + 1, 18],
];

for (const [size, chunkExp] of SIZES) {
  test(`media ranges match decryptRange: size ${size}, chunkExp ${chunkExp}`, async () => {
    const w = loadStream();
    const fx = await fixture(size, { chunkExp });
    if (size === 266240) {
      assert.equal(fx.opened.n, 66, 'padme adds one padding-only chunk');
      assert.ok(Math.ceil(size / 4096) < fx.opened.n);
    }
    const p = fx.payload();
    assert.deepEqual(w.message(p), { ok: true });
    await checkRanges(w, fx, p.token, size, 0, size + chunkExp);
  });
}

test('media ranges match decryptRange: size 17,039,359 (default chunk size, padding-only last chunk)', async () => {
  const w = loadStream();
  const fx = await fixture(17039359, { chunkExp: 18 });
  assert.equal(fx.opened.n, 66);
  const p = fx.payload();
  assert.deepEqual(w.message(p), { ok: true });
  await checkRanges(w, fx, p.token, 17039359, 0, 7, 16);
  // download mode: the whole plaintext, padding chunk authenticated
  const d = fx.payload({ download: true, filename: 'big.bin' });
  assert.deepEqual(w.message(d), { ok: true });
  const res = await w.fetch(d.token, { mode: 'navigate', download: true, clientId: '' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Length'), '17039359');
  assert.ok(same(await bytesOf(res), fx.plain));
});

test('response headers: safe media type, CSP sandbox, nosniff, CORP, no-store; HEAD has no body', async () => {
  const w = loadStream();
  for (const [mime, want] of [['video/webm', 'video/webm'], ['Audio/Ogg; codecs=opus', 'audio/ogg'], ['image/jpg', 'image/jpeg'],
    ['image/svg+xml', 'application/octet-stream'], ['text/html', 'application/octet-stream'], ['nonsense', 'application/octet-stream']]) {
    const fx = await fixture(5000, { mime });
    const p = fx.payload();
    w.message(p);
    const res = await w.fetch(p.token, { range: 'bytes=0-9' });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('Content-Type'), want, mime);
    assert.equal(res.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox");
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(res.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('Content-Range'), 'bytes 0-9/5000');
  }
  const fx = await fixture(5000);
  const p = fx.payload();
  w.message(p);
  const head = await w.fetch(p.token, { method: 'HEAD', range: 'bytes=10-' });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('Content-Length'), '4990');
  assert.equal(head.body, null);
  assert.equal((await w.fetch(p.token, { method: 'POST' })).status, 405);
});

test('register validates the payload and binds the token to the registering client', async () => {
  const w = loadStream();
  const fx = await fixture(10000);
  const bad = [
    { token: 'short' }, { token: newToken().toLowerCase() }, { blob: new Blob([fx.file.subarray(1)]) }, { blob: fx.file },
    { payKey: 'key' }, { payKey: fx.opened.keys.mac }, { chunkExp: 11 }, { chunkExp: 25 }, { size: -1 }, { paddedSize: 5 },
    { headerLen: 3 }, { entry: { off: 9000, size: 2000 } }, { entry: { off: -1, size: 1 } },
  ];
  for (const extra of bad) assert.deepEqual(w.message(fx.payload(extra)), { ok: false, error: 'bad-register' }, JSON.stringify(Object.keys(extra)));
  assert.deepEqual(w.message(fx.payload(), null), { ok: false, error: 'bad-register' }, 'no source client');
  const p = fx.payload();
  assert.deepEqual(w.message(p), { ok: true });
  assert.equal((await w.fetch(p.token, { range: 'bytes=0-1' })).status, 206);
  assert.equal((await w.fetch(p.token, { range: 'bytes=0-1', clientId: 'client-2' })).status, 403, 'other client');
  assert.equal((await w.fetch(p.token, { range: 'bytes=0-1', mode: 'navigate' })).status, 403, 'navigation');
  assert.equal((await w.fetch(p.token, { download: true, mode: 'navigate', clientId: '' })).status, 204, 'a media token is not a download');
  // unknown messages are ignored; unregister only by the owner
  assert.equal(w.message({ cmd: 'nope' }), undefined);
  assert.deepEqual(w.message({ cmd: 'unregister', token: p.token }, 'client-2'), { ok: true });
  assert.equal((await w.fetch(p.token, { range: 'bytes=0-1' })).status, 206, 'still registered');
  assert.deepEqual(w.message({ cmd: 'unregister', token: p.token }), { ok: true });
  w.addClient('client-1'); // denies 'need'
  assert.equal((await w.fetch(p.token, { range: 'bytes=0-1' })).status, 403, 'unregistered');
});

test("'need' handshake: an unknown token is fetched from the requesting page (shared by parallel requests)", async () => {
  const w = loadStream();
  const fx = await fixture(9000);
  const p = fx.payload();
  const page = w.addClient('client-1', (token) => (token === p.token ? p : { deny: true }));
  const [a, b] = await Promise.all([w.fetch(p.token, { range: 'bytes=100-199' }), w.fetch(p.token, { range: 'bytes=8000-' })]);
  assert.equal(a.status, 206);
  assert.equal(b.status, 206);
  assert.ok(same(await bytesOf(a), fx.plain.subarray(100, 200)));
  assert.ok(same(await bytesOf(b), fx.plain.subarray(8000)));
  assert.deepEqual(page.needs, [p.token], 'one round trip for parallel requests');
  assert.equal((await w.fetch(p.token, { range: 'bytes=0-0' })).status, 206, 'remembered');
  assert.deepEqual(page.needs, [p.token]);

  // deny, a reply for another token, a download payload, silence (2 s timeout), no such client, malformed token
  const q = fx.payload();
  w.addClient('client-2', () => ({ deny: true }));
  assert.equal((await w.fetch(q.token, { clientId: 'client-2' })).status, 403);
  w.addClient('client-3', () => fx.payload());
  assert.equal((await w.fetch(q.token, { clientId: 'client-3' })).status, 403);
  w.addClient('client-4', () => ({ ...q, download: true }));
  assert.equal((await w.fetch(q.token, { clientId: 'client-4' })).status, 403);
  w.addClient('client-5', () => undefined);
  assert.equal((await w.fetch(q.token, { clientId: 'client-5' })).status, 403);
  assert.equal((await w.fetch(q.token, { clientId: 'gone' })).status, 403);
  const before = w.posted.length;
  assert.equal((await w.fetch('not-a-token', { clientId: 'client-1' })).status, 403);
  assert.equal(w.posted.length, before, 'no need for a malformed token');
});

test('bundle entries: ranges are offset by entry.off and clipped to entry.size; entry downloads', async () => {
  const w = loadStream();
  const parts = [prngBytes(1, 5000), prngBytes(2, 0), prngBytes(3, 9001), prngBytes(4, 4096)];
  const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) {
    all.set(x, o);
    o += x.length;
  }
  const meta = C.bundleMeta(parts.map((x, i) => ({ name: `f${i}.webm`, type: 'video/webm', size: x.length })));
  const file = await seal(all, { chunkExp: 12, meta });
  const src = bytesSource(file);
  const opened = await C.openSource(src, { passphrase: 'pw' });
  assert.equal(opened.isBundle, true);
  const bfx = { file, src, opened };
  for (const e of opened.meta.entries) {
    const p = {
      cmd: 'register', token: newToken(), blob: new Blob([file]), payKey: opened.keys.pay, headerLen: opened.headerLen, chunkExp: 12,
      size: opened.size, paddedSize: opened.paddedSize, mime: e.type, filename: e.name, download: false, entry: { off: e.off, size: e.size },
    };
    assert.deepEqual(w.message(p), { ok: true });
    await checkRanges(w, bfx, p.token, e.size, e.off, e.off + 11, 12);
    const d = { ...p, token: newToken(), download: true };
    assert.deepEqual(w.message(d), { ok: true });
    const res = await w.fetch(d.token, { mode: 'navigate', download: true, clientId: '' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Length'), String(e.size));
    assert.ok(same(await bytesOf(res), all.subarray(e.off, e.off + e.size)), `entry ${e.name}`);
  }
});

test('downloads: navigations only, single use, 60 s TTL, attachment name, whole plaintext incl. padding chunks', async () => {
  const w = loadStream();
  const page = w.addClient('client-1');
  for (const [size, chunkExp] of [[0, 12], [1, 12], [4096, 12], [266240, 12], [2 ** 18 + 1, 18]]) {
    const fx = await fixture(size, { chunkExp });
    const p = fx.payload({ download: true, filename: 'Ünïcode name (1).mp4', mime: 'text/html' });
    assert.deepEqual(w.message(p), { ok: true });
    assert.equal((await w.fetch(p.token, { download: true, mode: 'cors' })).status, 403, 'not a navigation');
    assert.equal((await w.fetch(p.token, { range: 'bytes=0-0' })).status, 403, 'a download token is not media');
    const res = await w.fetch(p.token, { download: true, mode: 'navigate', clientId: '' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'application/octet-stream');
    assert.equal(res.headers.get('Content-Disposition'), "attachment; filename*=UTF-8''%C3%9Cn%C3%AFcode%20name%20%281%29.mp4");
    assert.equal(res.headers.get('Content-Length'), String(size));
    assert.equal(res.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox");
    assert.ok(same(await bytesOf(res), fx.plain), `download ${size}`);
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(w.posted.some(([id, m]) => id === 'client-1' && m.type === 'download-started' && m.token === p.token));
    assert.ok(w.posted.some(([id, m]) => id === 'client-1' && m.type === 'download-done' && m.token === p.token));
    const again = await w.fetch(p.token, { download: true, mode: 'navigate', clientId: '' });
    assert.equal(again.status, 204, 'single use');
    assert.ok(w.posted.some(([, m]) => m.type === 'download-failed' && m.token === p.token));
  }
  // TTL
  const fx = await fixture(100);
  const p = fx.payload({ download: true });
  w.message(p);
  w.clock.now += 60 * 1000 + 1;
  assert.equal((await w.fetch(p.token, { download: true, mode: 'navigate', clientId: '' })).status, 204);
  assert.ok(page.needs.length === 0);
});

test('downloads fail (stream error + download-failed) on damaged ciphertext or non-zero padding', async () => {
  const w = loadStream();
  w.addClient('client-1');
  const fx = await fixture(20000);
  const damaged = fx.file.slice();
  damaged[fx.opened.headerLen + 3 * (4096 + 16) + 7] ^= 1;
  const p = fx.payload({ download: true, blob: new Blob([damaged]) });
  assert.deepEqual(w.message(p), { ok: true });
  const res = await w.fetch(p.token, { download: true, mode: 'navigate', clientId: '' });
  assert.equal(res.status, 200);
  await assert.rejects(res.arrayBuffer());
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(w.posted.some(([id, m]) => id === 'client-1' && m.type === 'download-failed' && m.token === p.token));

  // valid GCM, but a non-zero byte in the padding (crafted with the key): media ranges never see it, downloads refuse
  const data = prngBytes(9, 5000);
  const padded = new Uint8Array(C.padme(5000));
  padded.set(data);
  padded[padded.length - 1] = 7;
  const { file } = await craft({ data, paddedPT: padded });
  const src = bytesSource(file);
  const opened = await C.openSource(src, { passphrase: 'pw' });
  const base = {
    cmd: 'register', blob: new Blob([file]), payKey: opened.keys.pay, headerLen: opened.headerLen, chunkExp: 12, size: 5000,
    paddedSize: opened.paddedSize, mime: 'video/webm', filename: 'x',
  };
  const m = { ...base, token: newToken(), download: false };
  w.message(m);
  assert.ok(same(await bytesOf(await w.fetch(m.token)), data));
  const d = { ...base, token: newToken(), download: true };
  w.message(d);
  await assert.rejects((await w.fetch(d.token, { download: true, mode: 'navigate', clientId: '' })).arrayBuffer());
});

test('lock: tokens dropped, streams in flight error at their next pull, a racing need reply is discarded', async () => {
  const w = loadStream();
  w.addClient('client-1');
  const fx = await fixture(50000);
  const p = fx.payload();
  w.message(p);
  const res = await w.fetch(p.token);
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.ok(same(first.value, fx.plain.subarray(0, first.value.length)));
  assert.deepEqual(w.message({ cmd: 'lock' }), { ok: true });
  let failed = false;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
    }
  } catch {
    failed = true;
  }
  assert.ok(failed, 'the stream errors after the lock');
  assert.equal((await w.fetch(p.token, { range: 'bytes=0-0' })).status, 403, 'token gone (the page denies need)');

  // a need reply that arrives after a lock is not used
  let release;
  const gate = new Promise((r) => (release = r));
  const q = fx.payload();
  const c = {
    id: 'client-9',
    postMessage(msg, transfer) {
      gate.then(() => transfer[0].postMessage(q));
    },
  };
  w.clients.set('client-9', c);
  const pending = w.fetch(q.token, { clientId: 'client-9' });
  await new Promise((r) => setTimeout(r, 5));
  w.message({ cmd: 'lock' });
  release();
  assert.equal((await pending).status, 403);
});

test("client-scoped lock (one tab's passive lock): only that page's tokens, streams and needs; others keep streaming", async () => {
  const w = loadStream();
  w.addClient('client-1');
  w.addClient('client-2');
  const fx = await fixture(50000);
  const mine = fx.payload();
  const theirs = fx.payload();
  w.message(mine, 'client-1');
  w.message(theirs, 'client-2');
  const readAll = async (reader) => {
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) return true;
      }
    } catch {
      return false;
    }
  };
  const a = (await w.fetch(mine.token, { clientId: 'client-1' })).body.getReader();
  const b = (await w.fetch(theirs.token, { clientId: 'client-2' })).body.getReader();
  assert.equal((await a.read()).done, false);
  assert.equal((await b.read()).done, false);
  // client-2 locks passively (idle in a background tab): client-1's stream and token are untouched.
  assert.deepEqual(w.message({ cmd: 'lock', scope: 'client' }, 'client-2'), { ok: true });
  assert.equal(await readAll(b), false, "the locking page's own stream errors");
  assert.equal(await readAll(a), true, "the other page's stream completes");
  assert.equal((await w.fetch(mine.token, { clientId: 'client-1', range: 'bytes=0-9' })).status, 206, 'token still known (no need)');
  assert.equal(w.clients.get('client-1').needs.length, 0);
  assert.equal((await w.fetch(theirs.token, { clientId: 'client-2', range: 'bytes=0-0' })).status, 403, 'its token is gone (the page denies need)');
  assert.deepEqual(w.clients.get('client-2').needs, [theirs.token]);
  // A later stream of the locked page works again (its epoch moved on once, not for good).
  const again = fx.payload();
  w.message(again, 'client-2');
  assert.ok(same(await bytesOf(await w.fetch(again.token, { clientId: 'client-2' })), fx.plain));
  // A client lock without a known sender is a full lock (never weaker than asked).
  w.message({ cmd: 'lock', scope: 'client' }, null);
  assert.equal((await w.fetch(mine.token, { clientId: 'client-1', range: 'bytes=0-0' })).status, 403);
});

test('sw.js routes register/unregister/lock to czStream.onMessage and czstream fetches to czStream.handle', async () => {
  const SW = readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const listeners = {};
  const self = {
    location: { hostname: 'example.test' },
    registration: { scope: SCOPE, active: null },
    clients: { claim: async () => {}, get: async () => null, matchAll: async () => [] },
    skipWaiting: async () => {},
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
  };
  const sandbox = {
    self, URL, Request, Response, ReadableStream, Blob, File, Headers, MessageChannel, crypto: globalThis.crypto, CryptoKey: globalThis.CryptoKey,
    btoa, Date, Map, Set, Promise, Array, String, Error, Uint8Array, Number, Math, Object, console, decodeURIComponent, encodeURIComponent,
    setTimeout, clearTimeout,
    caches: { open: async () => ({}), keys: async () => [], delete: async () => true },
    importScripts(...urls) {
      for (const u of urls) {
        if (u === './sw-assets.js') Object.assign(self, { ASSETS: [], INTEGRITY: {}, ASSET_VERSION: '000000000000' });
        else if (u === './sw-stream.js') vm.runInContext(CODE, ctx, { filename: 'sw-stream.js' });
      }
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SW, ctx, { filename: 'sw.js' });
  assert.equal(typeof self.czStream.onMessage, 'function');

  const fx = await fixture(7000);
  const p = fx.payload();
  let reply;
  for (const fn of listeners.message) fn({ data: p, ports: [{ postMessage: (m) => (reply = m) }], source: { id: 'c1' }, waitUntil() {} });
  assert.deepEqual(plain(reply), { ok: true });
  const fetchVia = async (headers) => {
    let responded;
    const request = { url: `${SCOPE}czstream/${p.token}`, method: 'GET', mode: 'no-cors', headers: new Headers(headers) };
    for (const fn of listeners.fetch) fn({ request, clientId: 'c1', respondWith: (x) => (responded = x), waitUntil() {} });
    return responded;
  };
  const res = await fetchVia({ Range: 'bytes=10-19' });
  assert.equal(res.status, 206);
  assert.ok(same(new Uint8Array(await res.arrayBuffer()), fx.plain.subarray(10, 20)));
  for (const fn of listeners.message) fn({ data: { cmd: 'lock' }, ports: [{ postMessage: (m) => (reply = m) }], source: { id: 'c1' }, waitUntil() {} });
  assert.deepEqual(plain(reply), { ok: true });
  assert.equal((await fetchVia({ Range: 'bytes=0-0' })).status, 403);
});

test('register drops media tokens of pages that are gone (reloaded or closed tabs keep no keys in the worker)', async () => {
  const w = loadStream();
  const fx = await fixture(3000);
  w.addClient('old-tab');
  const p = fx.payload();
  w.message(p, 'old-tab');
  assert.equal((await w.fetch(p.token, { clientId: 'old-tab' })).status, 200);
  w.clients.delete('old-tab');
  w.message(fx.payload()); // any later register sweeps
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await w.fetch(p.token, { clientId: 'old-tab' })).status, 403);
});

test('download names that are not well-formed UTF-16 never break the response (a navigation must not fail)', async () => {
  const w = loadStream();
  const fx = await fixture(3000);
  // a lone surrogate, and a 221-unit name whose 200-unit cut would split a surrogate pair
  for (const [filename, want] of [['\uD800bad.mp4', '%EF%BF%BDbad.mp4'], [`a${'\u{1F600}'.repeat(110)}`, null]]) {
    const p = fx.payload({ download: true, filename });
    assert.deepEqual(w.message(p), { ok: true });
    const res = await w.fetch(p.token, { download: true, mode: 'navigate', clientId: '' });
    assert.equal(res.status, 200);
    const cd = res.headers.get('Content-Disposition');
    assert.match(cd, /^attachment; filename\*=UTF-8''/);
    if (want) assert.equal(cd, `attachment; filename*=UTF-8''${want}`);
    const name = decodeURIComponent(cd.slice("attachment; filename*=UTF-8''".length));
    assert.ok(name.length <= 200 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(name), name);
    assert.ok(same(await bytesOf(res), fx.plain));
  }
});
