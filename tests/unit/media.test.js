// app/media/media.js in Node (DESIGN §5.1): text previews (truncation, UTF-8), notes, Blob caps and types, share
// Files, provisional saves into SaveTargets (abort on damaged data, stage cap), Blob URLs and releaseAll, bundle
// entries and plain (legacy) sources, the SW 'need' responder, and the streamed → Blob fallback of attachMedia.
// Browser behaviour (real media elements, the service worker) is in tests/browser/media.test.js and
// tests/e2e/media.spec.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import * as C from '../../app/crypto/container.js';
import * as media from '../../app/media/media.js';
import * as state from '../../app/state.js';
import * as platform from '../../app/platform.js';
import { CAPS } from '../../app/config.js';
import { bytesSource, blobSource } from '../../app/util/stream.js';
import { concat, utf8 } from '../../app/util/bytes.js';
import { NOTE_TYPE } from '../../app/util/format.js';
import { same, seal } from './container-helpers.js';
import { prngBytes } from '../../scripts/gen-vectors.mjs';

async function source(data, { name = 'clip.webm', type = 'video/webm', chunkExp = 12, blob = false } = {}) {
  const file = await seal(data, { chunkExp, meta: { name, type } });
  const src = blob ? blobSource(new Blob([file])) : bytesSource(file);
  const opened = await C.openSource(src, { passphrase: 'pw' });
  return { kind: 'container', src, opened, file };
}

function fakeTarget(kind = 'fs-handle') {
  const t = {
    kind,
    count: 1,
    written: [],
    aborted: 0,
    async write(name, src, opts) {
      const parts = [];
      if (src instanceof Blob) parts.push(new Uint8Array(await src.arrayBuffer()));
      else for await (const c of src) parts.push(c);
      const bytes = concat(...parts);
      t.written.push({ name, bytes, opts });
      return { name, where: 'fake' };
    },
    async abort() {
      t.aborted++;
    },
  };
  return t;
}

const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

test('sourceInfo: container, bundle entry and plain sources (names sanitized); bad sources are TypeErrors', async () => {
  const s = await source(prngBytes(1, 100), { name: 'a/b\u202e.webm' });
  assert.deepEqual(media.sourceInfo(s), { name: 'a_b.webm', type: 'video/webm', size: 100 });
  assert.deepEqual(media.sourceInfo({ ...s, entry: { off: 10, size: 20, name: 'x:y.png', type: 'image/png' } }), { name: 'x_y.png', type: 'image/png', size: 20 });
  assert.deepEqual(media.sourceInfo({ kind: 'plain', blob: new Blob(['hey'], { type: 'text/plain' }), name: 'n.txt' }), { name: 'n.txt', type: 'text/plain', size: 3 });
  for (const bad of [null, {}, { kind: 'plain' }, { kind: 'container', src: s.src }, { ...s, entry: { off: 90, size: 20, name: 'x' } }]) {
    assert.throws(() => media.sourceInfo(bad), TypeError);
  }
});

test('readText: whole text, truncation at maxBytes without a broken character, invalid UTF-8 replaced', async () => {
  const text = `héllo wörld ✓ ${'ab'.repeat(3000)}`;
  const s = await source(utf8(text), { name: 'n.txt', type: 'text/plain' });
  assert.deepEqual(await media.readText(s), { text, truncated: false });
  // cut inside "✓" (3 bytes at offset 14): the partial character is dropped
  const cut = await media.readText(s, { maxBytes: 16 });
  assert.equal(cut.truncated, true);
  assert.equal(cut.text, 'héllo wörld ');
  const bad = await source(new Uint8Array([0x61, 0xff, 0x62]), { name: 'b.txt', type: 'text/plain' });
  assert.deepEqual(await media.readText(bad), { text: 'a�b', truncated: false });
  const plain = { kind: 'plain', blob: new Blob([utf8('plain ✓ text')]), name: 'p.txt', type: 'text/plain' };
  assert.deepEqual(await media.readText(plain, { maxBytes: 8 }), { text: 'plain ', truncated: true });
  const empty = await source(new Uint8Array(0), { name: 'e.txt', type: 'text/plain' });
  assert.deepEqual(await media.readText(empty), { text: '', truncated: false });
});

test('readNote / prepareShare / saveDecrypted: notes are their JSON {title, body}; exports are "<title>.txt" with the body', async () => {
  const s = await source(utf8(JSON.stringify({ v: 1, title: 'Shopping: list', body: 'milk\neggs ✓' })), { name: 'Shopping: list', type: NOTE_TYPE });
  assert.deepEqual(await media.readNote(s), { title: 'Shopping: list', body: 'milk\neggs ✓' });
  const f = await media.prepareShare(s);
  assert.equal(f.name, 'Shopping_ list.txt');
  assert.equal(f.type, 'text/plain;charset=utf-8');
  assert.equal(await f.text(), 'milk\neggs ✓');
  const t = fakeTarget();
  assert.deepEqual(await media.saveDecrypted(t, s), { name: 'Shopping_ list.txt', where: 'fake' });
  assert.equal(new TextDecoder().decode(t.written[0].bytes), 'milk\neggs ✓');
  assert.equal(t.written[0].opts.mime, 'text/plain;charset=utf-8');
  // not JSON → the text is the body
  const raw = await source(utf8('just text'), { name: 'Old note', type: NOTE_TYPE });
  assert.deepEqual(await media.readNote(raw), { title: 'Old note', body: 'just text' });
});

test('decryptToBlob: safe media type, caps (too-big-to-preview), bundle entries, plain Blobs', async () => {
  const data = prngBytes(2, 20000);
  const s = await source(data);
  const b = await media.decryptToBlob(s);
  assert.equal(b.type, 'video/webm');
  assert.ok(same(await bytesOf(b), data));
  assert.equal((await media.decryptToBlob(s, { type: 'text/html' })).type, 'application/octet-stream');
  assert.equal((await media.decryptToBlob(s, { type: 'image/jpg' })).type, 'image/jpeg');
  await assert.rejects(media.decryptToBlob(s, { maxBytes: 19999 }), { code: 'too-big-to-preview' });
  const svg = await source(utf8('<svg/>'), { name: 'x.svg', type: 'image/svg+xml' });
  assert.equal((await media.decryptToBlob(svg)).type, 'application/octet-stream', 'SVG is never given an image type');
  const byExt = await source(utf8('ID3'), { name: 'song.mp3', type: 'application/octet-stream' });
  assert.equal((await media.decryptToBlob(byExt)).type, 'audio/mpeg', 'generic type: the extension decides');
  const entry = { ...s, entry: { off: 5000, size: 7000, name: 'part.bin', type: 'audio/ogg' } };
  const eb = await media.decryptToBlob(entry);
  assert.equal(eb.type, 'audio/ogg');
  assert.ok(same(await bytesOf(eb), data.subarray(5000, 12000)));
  const plain = { kind: 'plain', blob: new Blob([data]), name: 'p.webm', type: 'video/webm' };
  assert.ok(same(await bytesOf(await media.decryptToBlob(plain)), data));
  // a released Opened is a (silent) cancellation
  const gone = await source(prngBytes(3, 10));
  C.release(gone.opened);
  await assert.rejects(media.decryptToBlob(gone), { code: 'aborted' });
});

test('saveDecrypted streams into the target with progress; damaged data → target.abort() and a CzdError', async () => {
  const data = prngBytes(4, 50000);
  const s = await source(data, { name: 'movie.webm' });
  const t = fakeTarget();
  const progress = [];
  const res = await media.saveDecrypted(t, s, { onProgress: (done, total) => progress.push([done, total]) });
  assert.deepEqual(res, { name: 'movie.webm', where: 'fake' });
  assert.ok(same(t.written[0].bytes, data));
  assert.deepEqual(t.written[0].opts.size, 50000);
  assert.deepEqual(progress.at(-1), [50000, 50000]);
  assert.equal(t.aborted, 0);
  // explicit name and type
  const t2 = fakeTarget();
  await media.saveDecrypted(t2, s, { name: 'my<copy>.webm', type: 'video/webm' });
  assert.equal(t2.written[0].name, 'my_copy_.webm');

  for (const at of [s.opened.headerLen + 100, s.file.length - 5]) { // chunk 0 → chunk-auth; last tag → truncated-or-corrupt
    const damaged = s.file.slice();
    damaged[at] ^= 1;
    const src = bytesSource(damaged);
    const bad = { kind: 'container', src, opened: s.opened };
    const t3 = fakeTarget();
    await assert.rejects(media.saveDecrypted(t3, bad), (e) => ['chunk-auth', 'truncated-or-corrupt'].includes(e.code));
    assert.equal(t3.aborted, 1, 'provisional output removed');
  }
});

test("saveDecrypted on a 'stage' target: plaintext above this device's Blob cap is refused before any decrypt", async () => {
  const s = await source(prngBytes(5, 1000));
  const huge = { ...s, opened: { ...s.opened, size: CAPS.blobDesktop + 1 } };
  const t = fakeTarget('stage');
  await assert.rejects(media.saveDecrypted(t, huge), (e) => e.code === 'too-big-to-preview' && e.detail === 'too-big-to-save');
  assert.equal(t.aborted, 1);
  assert.equal(t.written.length, 0);
  // the real stage target keeps small outputs in memory
  const stage = await platform.chooseSaveTarget({ name: 'x.webm' });
  assert.equal(stage.kind, 'stage');
  const res = await media.saveDecrypted(stage, s);
  assert.equal(res.name, 'clip.webm');
  assert.ok(same(await bytesOf(res.staged), await bytesOf(await media.decryptToBlob(s))));
});

test('playableUrl without a service worker: Blob URLs within caps; release() and releaseAll() revoke them', async () => {
  const data = prngBytes(6, 3000);
  const s = await source(data, { name: 'pic.png', type: 'image/png' });
  const img = await media.playableUrl(s, { mode: 'image' });
  assert.equal(img.via, 'blob');
  const blob = resolveObjectURL(img.url);
  assert.equal(blob.type, 'image/png');
  assert.ok(same(await bytesOf(blob), data));
  img.release();
  img.release();
  assert.equal(resolveObjectURL(img.url), undefined);

  const v = await source(prngBytes(7, 4000));
  const a = await media.playableUrl(v, { mode: 'video' });
  const b = await media.playableUrl(v, { mode: 'audio' });
  const p = await media.playableUrl({ kind: 'plain', blob: new Blob([data]), name: 'old.png', type: 'image/png' }, { mode: 'image' });
  assert.equal(resolveObjectURL(p.url).type, 'image/png');
  state.purge('test'); // releaseAll is an onPurge handler
  for (const x of [a, b, p]) assert.equal(resolveObjectURL(x.url), undefined);

  await assert.rejects(media.playableUrl(v, { mode: 'pdf' }), TypeError);
  const big = { ...v, opened: { ...v.opened, size: CAPS.image + 1 } };
  await assert.rejects(media.playableUrl(big, { mode: 'image' }), { code: 'too-big-to-preview' });
});

test('playLimit: images CAPS.image; audio/video the Blob cap without streaming, unlimited with a service worker', () => {
  assert.equal(media.playLimit('image'), CAPS.image);
  assert.equal(media.playLimit('video'), CAPS.blobDesktop);
  const sw = fakeServiceWorker(() => {});
  try {
    assert.equal(media.playLimit('video'), Infinity);
    assert.equal(media.playLimit('audio'), Infinity);
  } finally {
    sw.restore();
  }
});

test('prefetch decrypts the next item in the background and playableUrl uses it (same source object)', async () => {
  const data = prngBytes(8, 9000);
  const s = await source(data, { name: 'a.ogg', type: 'audio/ogg' });
  media.prefetch(s);
  media.prefetch(s); // idempotent
  // once prefetched, playableUrl must not decrypt again: without the payload key a decrypt would fail
  await new Promise((r) => setTimeout(r, 50));
  const keys = s.opened.keys;
  s.opened.keys = {};
  const h = await media.playableUrl(s, { mode: 'audio' });
  assert.ok(same(await bytesOf(resolveObjectURL(h.url)), data));
  h.release();
  s.opened.keys = keys;
  assert.doesNotThrow(() => media.prefetch(null), 'never throws');
  media.releaseAll();
});

test('disposeSource: the source release() wins, else container.release(opened)', async () => {
  const s = await source(prngBytes(9, 10));
  let called = 0;
  media.disposeSource({ ...s, release: () => called++ });
  assert.equal(called, 1);
  assert.ok(s.opened.keys, 'a source with its own release() keeps the shared Opened');
  media.disposeSource(s);
  assert.equal(s.opened.keys, null);
  assert.equal(s.opened.fileKey, null);
  media.disposeSource(null);
  media.disposeSource({ kind: 'plain', blob: new Blob([]) });
});

/** Installs a fake navigator.serviceWorker controlled by `controller`. Returns {container, restore}. */
function fakeServiceWorker(onPost) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const container = new EventTarget();
  container.controller = { postMessage: onPost };
  container.ready = Promise.resolve({ scope: 'https://example.test/app/' });
  container.startMessages = () => {};
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Mozilla/5.0 Chrome/140', serviceWorker: container } });
  return { container, restore: () => Object.defineProperty(globalThis, 'navigator', desc) };
}

async function askNeed(container, token) {
  const ch = new MessageChannel();
  const reply = new Promise((r) => {
    ch.port1.onmessage = (e) => r(e.data);
  });
  const ev = new Event('message');
  Object.assign(ev, { data: { cmd: 'need', token }, ports: [ch.port2] });
  container.dispatchEvent(ev);
  const data = await reply;
  ch.port1.close();
  return data;
}

test("service worker path: register payload (§5.2), 'need' answered only for live tokens, unregister on release, purge denies", async () => {
  const posted = [];
  const sw = fakeServiceWorker((msg, transfer) => {
    posted.push(msg);
    if (transfer && transfer[0]) {
      transfer[0].postMessage({ ok: true });
      transfer[0].close();
    }
  });
  try {
    const data = prngBytes(10, 6000);
    const s = await source(data, { blob: true, name: 'v.webm', type: 'video/webm' });
    const hnd = await media.playableUrl(s, { mode: 'video' });
    assert.equal(hnd.via, 'sw');
    const token = hnd.url.split('/').pop();
    assert.match(hnd.url, /^https:\/\/example\.test\/app\/czstream\/[A-Z2-7]{26}$/);
    const reg = posted[0];
    assert.equal(reg.cmd, 'register');
    assert.equal(reg.token, token);
    assert.equal(reg.blob, s.src.blob);
    assert.equal(reg.payKey, s.opened.keys.pay);
    assert.deepEqual([reg.headerLen, reg.chunkExp, reg.size, reg.paddedSize, reg.mime, reg.filename, reg.download],
      [s.opened.headerLen, 12, 6000, s.opened.paddedSize, 'video/webm', 'v.webm', false]);
    const need = await askNeed(sw.container, token);
    assert.equal(need.token, token);
    assert.equal(need.cmd, 'register');
    assert.deepEqual(await askNeed(sw.container, 'AAAAAAAAAAAAAAAAAAAAAAAAAA'), { deny: true });
    // images never stream; a source without a Blob (Tauri fs) falls back to a Blob URL
    assert.equal((await media.playableUrl(s, { mode: 'image' })).via, 'blob');
    const noBlob = await source(data);
    assert.equal((await media.playableUrl(noBlob, { mode: 'video' })).via, 'blob');
    // entry payloads carry entry {off, size}
    const e = await media.playableUrl({ ...s, entry: { off: 100, size: 200, name: 'e.webm', type: 'video/webm' } }, { mode: 'video' });
    assert.deepEqual(posted.at(-1).entry, { off: 100, size: 200 });
    e.release();
    assert.deepEqual(posted.at(-1), { cmd: 'unregister', token: e.url.split('/').pop() });
    hnd.release();
    assert.deepEqual(await askNeed(sw.container, token), { deny: true }, 'released');
    const again = await media.playableUrl(s, { mode: 'audio' });
    state.purge('test');
    assert.deepEqual(await askNeed(sw.container, again.url.split('/').pop()), { deny: true }, 'purged');
  } finally {
    sw.restore();
    media.releaseAll();
  }
});

test('service worker that refuses or never answers → Blob URL', async (t) => {
  for (const post of [(m, tr) => tr?.[0]?.postMessage({ ok: false, error: 'bad-register' }), null]) {
    const sw = fakeServiceWorker(post ?? (() => {}));
    try {
      const s = await source(prngBytes(11, 500), { blob: true });
      if (!post) t.mock.timers.enable({ apis: ['setTimeout'] });
      const pending = media.playableUrl(s, { mode: 'audio' });
      if (!post) {
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setImmediate(r));
          t.mock.timers.tick(1000);
        }
        t.mock.timers.reset();
      }
      const hnd = await pending;
      assert.equal(hnd.via, 'blob');
      hnd.release();
    } finally {
      sw.restore();
    }
  }
});

test('attachMedia: a streamed URL that errors is retried once as a Blob; a Blob the element rejects → unsupported-media', async () => {
  const sw = fakeServiceWorker((m, t) => {
    t?.[0]?.postMessage({ ok: true });
    t?.[0]?.close();
  });
  try {
    const s = await source(prngBytes(12, 2000), { blob: true });
    /** A fake media element: `behave(url)` → 'ok' | 'error'. */
    const fakeEl = (behave) => {
      const el = new EventTarget();
      el.srcs = [];
      el.error = null;
      el.removeAttribute = () => {};
      el.load = () => {};
      el.pause = () => {};
      Object.defineProperty(el, 'src', {
        set(url) {
          el.srcs.push(url);
          const what = behave(url);
          setTimeout(() => el.dispatchEvent(new Event(what === 'ok' ? 'loadedmetadata' : 'error')), 1);
        },
      });
      return el;
    };
    const el = fakeEl((url) => (url.startsWith('blob:') ? 'ok' : 'error'));
    const hnd = await media.attachMedia(el, s, { mode: 'video' });
    assert.equal(hnd.via, 'blob');
    assert.equal(el.srcs.length, 2);
    assert.match(el.srcs[0], /czstream/);
    hnd.release();
    const never = fakeEl(() => 'error');
    await assert.rejects(media.attachMedia(never, s, { mode: 'video' }), { code: 'unsupported-media' });
    const img = fakeEl(() => 'error');
    await assert.rejects(media.attachMedia(img, s, { mode: 'image' }), { code: 'unsupported-media' });
    assert.equal(img.srcs.length, 1, 'no retry on the Blob path');
    const ctl = new AbortController();
    ctl.abort();
    await assert.rejects(media.attachMedia(fakeEl(() => 'ok'), s, { mode: 'audio', signal: ctl.signal }), { code: 'aborted' });
  } finally {
    sw.restore();
    media.releaseAll();
  }
});
