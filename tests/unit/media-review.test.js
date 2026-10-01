// Review regressions for app/media/media.js (area F): a disposed source never yields plaintext from a finished
// prefetch; SW downloads refuse notes (they are saved as "<title>.txt" bodies, never as raw JSON); the streamed →
// Blob fallback of attachMedia when the Blob path is impossible (above this device's cap): a media error is
// 'unsupported-media' (not 'too-big-to-preview') and a slow stream keeps loading; attachMedia's signal stops the
// Blob decrypt itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../app/crypto/container.js';
import * as media from '../../app/media/media.js';
import { CAPS, TIMES } from '../../app/config.js';
import { bytesSource, blobSource, rechunk } from '../../app/util/stream.js';
import { utf8 } from '../../app/util/bytes.js';
import { NOTE_TYPE } from '../../app/util/format.js';
import { seal } from './container-helpers.js';
import { prngBytes } from '../../scripts/gen-vectors.mjs';

async function source(data, { name = 'clip.webm', type = 'video/webm', chunkExp = 12, blob = false } = {}) {
  const file = await seal(data, { chunkExp, meta: { name, type } });
  const src = blob ? blobSource(new Blob([file])) : bytesSource(file);
  const opened = await C.openSource(src, { passphrase: 'pw' });
  return { kind: 'container', src, opened, file };
}

/** Installs a fake navigator.serviceWorker whose controller answers {ok:true}. */
function fakeServiceWorker() {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const posted = [];
  const container = new EventTarget();
  container.controller = {
    postMessage(msg, transfer) {
      posted.push(msg);
      if (transfer && transfer[0]) {
        transfer[0].postMessage({ ok: true });
        transfer[0].close();
      }
    },
  };
  container.ready = Promise.resolve({ scope: 'https://example.test/app/' });
  container.startMessages = () => {};
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Mozilla/5.0 Chrome/140', serviceWorker: container } });
  return { posted, restore: () => Object.defineProperty(globalThis, 'navigator', desc) };
}

/** A fake media element: `behave(url)` → 'ok' | 'error' | 'never' (the test dispatches later). */
function fakeEl(behave) {
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
      if (what === 'never') return;
      setTimeout(() => el.dispatchEvent(new Event(what === 'ok' ? 'loadedmetadata' : 'error')), 1);
    },
  });
  return el;
}

test('disposeSource: a finished prefetch of that source is dropped (no plaintext from a disposed source)', async () => {
  const s = await source(prngBytes(1, 9000), { name: 'p.png', type: 'image/png' });
  media.prefetch(s);
  await new Promise((r) => setTimeout(r, 50));
  media.disposeSource(s);
  assert.equal(s.opened.keys, null);
  await assert.rejects(media.playableUrl(s, { mode: 'image' }), { code: 'aborted' });
  media.releaseAll();
});

test('downloadViaSw refuses notes (a note is saved as "<title>.txt" holding the body, never the raw JSON payload)', async () => {
  const sw = fakeServiceWorker();
  try {
    const note = await source(utf8(JSON.stringify({ v: 1, title: 'Plan', body: 'b' })), { name: 'Plan', type: NOTE_TYPE, blob: true });
    await assert.rejects(media.downloadViaSw(note), (e) => e.name === 'CzdError');
    assert.equal(sw.posted.length, 0, 'nothing registered');
  } finally {
    sw.restore();
    media.releaseAll();
  }
});

test('attachMedia above the Blob cap: a streamed media error → unsupported-media (no Blob retry possible)', async () => {
  const sw = fakeServiceWorker();
  try {
    const s = await source(prngBytes(2, 3000), { blob: true });
    const huge = { ...s, opened: { ...s.opened, size: CAPS.blobDesktop + 1 } };
    const el = fakeEl(() => 'error');
    await assert.rejects(media.attachMedia(el, huge, { mode: 'video' }), { code: 'unsupported-media' });
    assert.equal(el.srcs.length, 1, 'no Blob attempt');
  } finally {
    sw.restore();
    media.releaseAll();
  }
});

test('attachMedia above the Blob cap: a slow streamed load is not abandoned after 5 s (no Blob to fall back to)', async (t) => {
  const sw = fakeServiceWorker();
  try {
    const s = await source(prngBytes(3, 3000), { blob: true });
    const huge = { ...s, opened: { ...s.opened, size: CAPS.blobDesktop + 1 } };
    const el = fakeEl(() => 'never');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let settled = null;
    const p = media.attachMedia(el, huge, { mode: 'video' }).then((h) => (settled = { h }), (e) => (settled = { e }));
    for (let i = 0; i < 40 && el.srcs.length === 0; i++) await new Promise((r) => setImmediate(r));
    assert.equal(el.srcs.length, 1);
    t.mock.timers.tick(TIMES.mediaFallbackMs + 1000);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    assert.equal(settled, null, 'still loading the stream');
    el.dispatchEvent(new Event('loadedmetadata'));
    await p;
    t.mock.timers.reset();
    assert.equal(settled.e, undefined, String(settled.e));
    assert.equal(settled.h.via, 'sw');
    settled.h.release();

    // ... but not forever: a stream that never shows anything ends as "too big to preview" (no Blob possible)
    const stuck = fakeEl(() => 'never');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let out = null;
    const q = media.attachMedia(stuck, huge, { mode: 'video' }).then((h) => (out = { h }), (e) => (out = { e }));
    for (let i = 0; i < 40 && stuck.srcs.length === 0; i++) await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(TIMES.mediaFallbackMs * 10);
    await q;
    t.mock.timers.reset();
    assert.equal(out.e?.code, 'too-big-to-preview');
    assert.equal(stuck.srcs.length, 1, 'no Blob attempt');
  } finally {
    sw.restore();
    media.releaseAll();
  }
});

test('attachMedia: an abort stops the Blob decrypt itself (shared sources whose release() is a no-op)', async () => {
  const s = await source(prngBytes(4, 64 * 4096), { chunkExp: 12 });
  let pulled = 0;
  const counting = {
    ...s.src,
    size: s.src.size,
    readAt: (o, l) => s.src.readAt(o, l),
    async* stream(a, b) {
      for await (const piece of rechunk(s.src.stream(a, b), 4096 + 16)) {
        pulled++;
        yield piece;
        await new Promise((r) => setTimeout(r, 1));
      }
    },
  };
  const shared = { kind: 'container', src: counting, opened: s.opened, release() {} };
  const ctl = new AbortController();
  const el = fakeEl(() => 'ok');
  const p = media.attachMedia(el, shared, { mode: 'video', signal: ctl.signal });
  await new Promise((r) => setTimeout(r, 5));
  ctl.abort();
  await assert.rejects(p, { code: 'aborted' });
  const at = pulled;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(pulled, at, 'no more reads after the abort');
  assert.ok(pulled < 20, `stopped early (${pulled} pieces read)`);
  assert.equal(el.srcs.length, 0, 'no URL was given to the element');
  media.releaseAll();
});

test('attachMedia (Blob path): an element that does not preload (no loadedmetadata, no error) is handed over after 5 s', async (t) => {
  const s = await source(prngBytes(5, 3000), { name: 'a.ogg', type: 'audio/ogg' });
  const el = fakeEl(() => 'never');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let out = null;
  const p = media.attachMedia(el, s, { mode: 'audio' }).then((h) => (out = { h }), (e) => (out = { e }));
  for (let i = 0; i < 200 && el.srcs.length === 0; i++) await new Promise((r) => setImmediate(r));
  assert.equal(el.srcs.length, 1);
  assert.match(el.srcs[0], /^blob:/);
  t.mock.timers.tick(TIMES.mediaFallbackMs + 10);
  await p;
  t.mock.timers.reset();
  assert.equal(out.e, undefined, String(out.e));
  assert.equal(out.h.via, 'blob');
  assert.equal(el.srcs.length, 1, 'the same Blob URL stays (the play button loads it)');
  out.h.release();
  // images have no such grace: a broken <img> is still "can't show"
  const img = await source(prngBytes(6, 100), { name: 'x.png', type: 'image/png' });
  await assert.rejects(media.attachMedia(fakeEl(() => 'error'), img, { mode: 'image' }), { code: 'unsupported-media' });
  media.releaseAll();
});
