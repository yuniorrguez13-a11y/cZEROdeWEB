// Browser units for media, viewer and player (runner: tests/browser/index.html?suite=media, app CSP, no service
// worker controller → the Blob paths). Real fixtures (tests/fixtures) are encrypted in the page and played back
// through media.playableUrl / attachMedia; readText, decryptToBlob caps, saveDecrypted into a fake SaveTarget
// (abort on a damaged container); the viewer's modes, keyboard and Back; the player's queue advance.
import * as C from '../../app/crypto/container.js';
import * as media from '../../app/media/media.js';
import * as state from '../../app/state.js';
import { openViewer, closeViewer } from '../../app/ui/viewer.js';
import { mountPlayer, playQueue, stop, isPlaying } from '../../app/ui/player.js';
import { blobSource } from '../../app/util/stream.js';
import { NOTE_TYPE } from '../../app/util/format.js';

const FAST = { m: 64, t: 1, p: 1 };
let passKek = null;

async function fixture(name) {
  const res = await fetch(`../fixtures/${name}`);
  if (!res.ok) throw new Error(`fixture ${name}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Encrypts bytes into a czd2 container Blob (chunkExp 14) and opens it: a container DecryptSource. */
async function sealed(bytes, meta, { chunkExp = 14 } = {}) {
  passKek ??= await C.makePassKek('pw', FAST);
  const parts = [];
  for await (const p of C.encryptStream(bytes, { size: bytes.length, meta, chunkExp, stanzasFor: async (fk) => [await C.passStanza(fk, passKek)] })) parts.push(p);
  const file = new Blob(parts);
  const src = blobSource(file);
  const opened = await C.openSource(src, { passphrase: 'pw' });
  return { kind: 'container', src, opened, file };
}

function same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function waitEvent(el, ok, { bad = 'error', ms = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => done(reject, new Error(`timeout waiting for ${ok}`)), ms);
    const onOk = () => done(resolve);
    const onBad = () => done(reject, new Error(`${bad} instead of ${ok} (${el.error?.code ?? ''})`));
    function done(fn, v) {
      clearTimeout(t);
      el.removeEventListener(ok, onOk);
      el.removeEventListener(bad, onBad);
      fn(v);
    }
    el.addEventListener(ok, onOk);
    el.addEventListener(bad, onBad);
  });
}

const until = async (fn, ms = 15000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
};

const key = (k) => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });

export default async function (t) {
  const png = await fixture('image.png');
  const webm = await fixture('clip.webm');
  const audio = await fixture('audio.webm');
  const wav = await fixture('tone.wav');
  const notes = await fixture('notes.txt');

  await t.test('playableUrl (Blob path): image, audio and video fixtures decode in real elements', async () => {
    const img = await sealed(png, { name: 'image.png', type: 'image/png' });
    const h1 = await media.playableUrl(img, { mode: 'image' });
    t.equal(h1.via, 'blob');
    t.assert(h1.url.startsWith('blob:'), 'blob URL');
    const el = document.createElement('img');
    const loaded = waitEvent(el, 'load');
    el.src = h1.url;
    await loaded;
    t.deepEqual([el.naturalWidth, el.naturalHeight], [320, 200], 'PNG size');
    h1.release();

    const vid = await sealed(webm, { name: 'clip.webm', type: 'video/webm' });
    const v = document.createElement('video');
    v.muted = true;
    const h2 = await media.attachMedia(v, vid, { mode: 'video' });
    t.equal(h2.via, 'blob');
    t.deepEqual([v.videoWidth, v.videoHeight], [640, 360], 'video size');
    t.assert(Math.abs(v.duration - 5) < 0.3, `video duration ${v.duration}`);
    media.detachMedia(v);
    h2.release();

    for (const [bytes, name, type] of [[audio, 'audio.webm', 'audio/webm'], [wav, 'tone.wav', 'audio/wav']]) {
      const a = document.createElement('audio');
      const src = await sealed(bytes, { name, type });
      const h3 = await media.attachMedia(a, src, { mode: 'audio' });
      t.assert(a.duration > 1, `${name} duration ${a.duration}`);
      media.detachMedia(a);
      h3.release();
    }
  });

  await t.test('attachMedia: a video the element cannot decode → unsupported-media (no retry on the Blob path)', async () => {
    const junk = await sealed(png, { name: 'fake.webm', type: 'video/webm' });
    const v = document.createElement('video');
    let code = null;
    try {
      await media.attachMedia(v, junk, { mode: 'video' });
    } catch (e) {
      code = e.code;
    }
    t.equal(code, 'unsupported-media');
    // (A broken <img> is covered by tests/unit/media.test.js: under Playwright tracing, Chromium reports a
    // connect-src violation for the failed blob: image, which the runner would count as a CSP failure.)
  });

  await t.test('readText and decryptToBlob caps; saveDecrypted into a SaveTarget; abort on a damaged container', async () => {
    const txt = await sealed(notes, { name: 'notes.txt', type: 'text/plain' });
    const r = await media.readText(txt);
    t.equal(r.truncated, false);
    t.equal(r.text, new TextDecoder().decode(notes));
    t.equal((await media.readText(txt, { maxBytes: 20 })).truncated, true);
    let code = null;
    try {
      await media.decryptToBlob(txt, { maxBytes: notes.length - 1 });
    } catch (e) {
      code = e.code;
    }
    t.equal(code, 'too-big-to-preview');
    const b = await media.decryptToBlob(txt, { type: 'text/html' });
    t.equal(b.type, 'application/octet-stream', 'never an HTML Blob');

    const vid = await sealed(webm, { name: 'clip.webm', type: 'video/webm' }, { chunkExp: 12 });
    const written = [];
    let aborted = 0;
    const target = {
      kind: 'fs-handle',
      count: 1,
      async write(name, source, opts) {
        const parts = [];
        for await (const p of source) parts.push(p);
        written.push({ name, blob: new Blob(parts), opts });
        return { name };
      },
      async abort() {
        aborted++;
      },
    };
    await media.saveDecrypted(target, vid, { name: 'copy.webm' });
    t.equal(written[0].name, 'copy.webm');
    t.assert(same(new Uint8Array(await written[0].blob.arrayBuffer()), webm), 'saved bytes = plaintext');
    t.equal(aborted, 0);

    const bytes = new Uint8Array(await vid.file.arrayBuffer());
    bytes[bytes.length - 100] ^= 0x40;
    const damaged = { kind: 'container', src: blobSource(new Blob([bytes])), opened: vid.opened };
    code = null;
    try {
      await media.saveDecrypted(target, damaged);
    } catch (e) {
      code = e.code;
    }
    t.equal(code, 'truncated-or-corrupt');
    t.equal(aborted, 1, 'target.abort() after the damaged chunk');
  });

  await t.test('viewer: image/text/note/none modes, arrows, Esc, Back; URLs released and sources disposed', async () => {
    const actions = [];
    const disposed = [];
    const mk = (k, name, type, bytes) => ({
      key: k,
      name,
      type,
      kind: 'other',
      size: bytes.length,
      actions: ['fav', 'save', 'share', 'send', 'rename', 'delete', 'editNote'],
      getSource: async () => ({ ...(await sealed(bytes, { name, type })), release() { disposed.push(k); } }),
    });
    const noteBytes = new TextEncoder().encode(JSON.stringify({ v: 1, title: 'Plan', body: 'line 1\nline 2' }));
    const items = [
      mk('a', 'image.png', 'image/png', png),
      mk('b', 'notes.txt', 'text/plain', notes),
      mk('c', 'Plan', NOTE_TYPE, noteBytes),
      mk('d', 'doc.pdf', 'application/pdf', new Uint8Array(10)),
    ];
    const histLen = history.length;
    let closedWith = null;
    const v = openViewer({ items, index: 0, onAction: (a, it, p) => actions.push([a, it.key, p]), onClose: (r) => (closedWith = r) });
    const root = document.querySelector('.vw-root');
    t.assert(root && root.parentElement === document.body, 'appended to <body>');
    t.assert(document.documentElement.classList.contains('vw-open'), 'html.vw-open');
    await until(() => root.querySelector('.vw-img')?.complete && root.querySelector('.vw-img').naturalWidth > 0);
    t.equal(root.dataset.mode, 'image');
    t.equal(root.querySelector('.vw-name').textContent, 'image.png');
    await until(() => history.length === histLen + 1);
    root.dispatchEvent(key('ArrowRight'));
    await until(() => root.querySelector('.vw-text'));
    t.equal(root.dataset.mode, 'text');
    t.equal(root.querySelector('.vw-text').textContent, new TextDecoder().decode(notes));
    t.equal(root.querySelector('.vw-count').textContent, '2 / 4');
    t.deepEqual(disposed, ['a'], 'previous source disposed');
    root.dispatchEvent(key('ArrowRight'));
    await until(() => root.querySelector('.vw-note-body'));
    t.equal(root.querySelector('.vw-note-title').value, 'Plan');
    t.equal(root.querySelector('.vw-note-body').value, 'line 1\nline 2');
    const body = root.querySelector('.vw-note-body');
    body.value = 'line 1\nline 2\nline 3';
    body.dispatchEvent(new Event('input'));
    root.querySelector('.vw-note-save').click();
    t.deepEqual(actions.at(-1), ['editNote', 'c', { title: 'Plan', body: 'line 1\nline 2\nline 3' }]);
    const saves = actions.length;
    root.dispatchEvent(key('ArrowLeft'));
    t.equal(actions.length, saves, 'a saved note is not handed over again');
    root.dispatchEvent(key('ArrowRight'));
    await until(() => root.querySelector('.vw-note-body'));
    // an unsaved edit is handed to the caller when the viewer moves on
    const title = root.querySelector('.vw-note-title');
    title.value = 'Plan B';
    title.dispatchEvent(new Event('input'));
    t.equal(root.querySelector('.vw-note-status').textContent, 'Unsaved changes');
    root.dispatchEvent(key('ArrowRight'));
    t.deepEqual(actions.at(-1), ['editNote', 'c', { title: 'Plan B', body: 'line 1\nline 2', reason: 'navigate' }]);
    await until(() => root.querySelector('.vw-card'));
    t.equal(root.dataset.mode, 'none');
    t.assert(root.querySelector('.vw-card-text').textContent.includes('No preview'), 'info card');
    root.dispatchEvent(key('ArrowRight'));
    t.equal(root.querySelector('.vw-count').textContent, '4 / 4', 'no wrap at the end');
    t.equal(history.length, histLen + 1, 'prev/next add no history entries');
    root.querySelector('.vw-act[aria-label="Favorite"]').click();
    t.deepEqual(actions.at(-1), ['fav', 'd', undefined]);
    v.update(items.map((x) => (x.key === 'd' ? { ...x, fav: true } : x)));
    t.equal(root.querySelector('.vw-act-fav').getAttribute('aria-pressed'), 'true');
    // Back closes (one entry)
    history.back();
    await until(() => !document.querySelector('.vw-root'));
    t.equal(closedWith, 'back');
    t.assert(!document.documentElement.classList.contains('vw-open'), 'class removed');
    t.equal(disposed.length, 6, 'every source disposed (one per show)');

    // Esc closes and removes its history entry
    closedWith = null;
    openViewer({ items, index: 3, onClose: (r) => (closedWith = r) });
    await until(() => document.querySelector('.vw-card'));
    await until(() => history.length === histLen + 1);
    document.querySelector('.vw-root').dispatchEvent(key('Escape'));
    t.equal(closedWith, 'user');
    t.equal(document.querySelector('.vw-root'), null);

    // a lock closes it
    openViewer({ items, index: 0 });
    state.purge('test');
    t.equal(document.querySelector('.vw-root'), null, 'closed on purge');
    closeViewer();
  });

  await t.test('player: queue plays, advances on ended, prev/next, stop clears; isPlaying and state "player"', async () => {
    const dock = document.createElement('div');
    document.body.append(dock);
    mountPlayer(dock);
    const mk = (k, name, type, bytes) => ({ key: k, name, type, kind: 'audio', size: bytes.length, getSource: () => sealed(bytes, { name, type }) });
    const items = [mk('1', 'tone.wav', 'audio/wav', wav), mk('img', 'image.png', 'image/png', png), mk('2', 'audio.webm', 'audio/webm', audio)];
    playQueue(items, { title: 'Mix' });
    const root = dock.querySelector('.pl-root');
    await until(() => !root.hidden && root.querySelector('.pl-name').textContent === 'tone.wav');
    t.equal(root.querySelector('.pl-sub').textContent, 'Mix · 1 / 2', 'non-audio items are left out');
    const a = root.querySelector('.pl-audio');
    await until(() => a.readyState >= 1);
    if (a.paused) root.querySelector('.pl-play').click(); // autoplay may need a "gesture"
    await until(() => isPlaying());
    t.deepEqual(state.get('player'), { playing: true });
    // jump to the end: auto-advance to the next track
    a.currentTime = Math.max(0, a.duration - 0.05);
    await until(() => root.querySelector('.pl-name').textContent === 'audio.webm');
    t.equal(root.querySelector('.pl-sub').textContent, 'Mix · 2 / 2');
    await until(() => a.readyState >= 1 && !a.paused);
    root.querySelector('.pl-btn[aria-label="Queue"]').click();
    t.equal(root.querySelectorAll('.pl-row').length, 2);
    t.assert(root.querySelector('.pl-current .pl-row-name').textContent === 'audio.webm', 'current row');
    root.querySelector('.pl-btn[aria-label="Previous track"]').click();
    await until(() => root.querySelector('.pl-name').textContent === 'tone.wav');
    stop();
    t.equal(root.hidden, true);
    t.equal(isPlaying(), false);
    t.deepEqual(state.get('player'), { playing: false });
    t.equal(a.getAttribute('src'), null, 'media detached');
    dock.remove();
  });
}
