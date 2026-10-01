// Review regressions for the viewer and the player (area F), run in the browser runner (app CSP, no service
// worker → Blob paths): every DecryptSource a getSource() hands out is disposed exactly once, however fast the
// user moves (player controls racing the next-track prepare, viewer arrows racing slow sources); photos above
// CAPS.image say "too big", not "can't show"; an open "More" menu never outlives the action bar it belongs to.
import * as C from '../../app/crypto/container.js';
import { CAPS } from '../../app/config.js';
import { userMessage } from '../../app/errors.js';
import { openViewer, closeViewer } from '../../app/ui/viewer.js';
import { mountPlayer, playQueue, stop, isPlaying } from '../../app/ui/player.js';
import * as state from '../../app/state.js';
import { blobSource } from '../../app/util/stream.js';
import { NOTE_TYPE } from '../../app/util/format.js';

const FAST = { m: 64, t: 1, p: 1 };
let passKek = null;

async function fixture(name) {
  const res = await fetch(`../fixtures/${name}`);
  if (!res.ok) throw new Error(`fixture ${name}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function sealed(bytes, meta) {
  passKek ??= await C.makePassKek('pw', FAST);
  const parts = [];
  for await (const p of C.encryptStream(bytes, { size: bytes.length, meta, chunkExp: 14, stanzasFor: async (fk) => [await C.passStanza(fk, passKek)] })) parts.push(p);
  const src = blobSource(new Blob(parts));
  return { kind: 'container', src, opened: await C.openSource(src, { passphrase: 'pw' }) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await sleep(20);
  }
};

/** getSource() factories that record every source handed out and how often each was released. */
function ledger() {
  const out = [];
  const make = (bytes, meta, delay = 0) => async () => {
    await sleep(delay);
    const s = await sealed(bytes, meta);
    const rec = { key: meta.name, released: 0 };
    out.push(rec);
    return { ...s, release() { rec.released++; C.release(s.opened); } };
  };
  const leaks = () => out.filter((r) => r.released !== 1).map((r) => `${r.key}×${r.released}`);
  return { out, make, leaks };
}

const key = (k) => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });

export default async function (t) {
  const wav = await fixture('tone.wav');
  const audio = await fixture('audio.webm');
  const png = await fixture('image.png');
  const notes = await fixture('notes.txt');

  await t.test('player: every source is disposed exactly once when the controls race the next-track prepare', async () => {
    const dock = document.createElement('div');
    document.body.append(dock);
    mountPlayer(dock);
    const L = ledger();
    const mk = (k, name, type, bytes, delay) => ({ key: k, name, type, kind: 'audio', size: bytes.length, getSource: L.make(bytes, { name, type }, delay) });
    playQueue([mk('1', 'a.wav', 'audio/wav', wav, 0), mk('2', 'b.webm', 'audio/webm', audio, 300), mk('3', 'c.wav', 'audio/wav', wav, 300)]);
    const root = dock.querySelector('.pl-root');
    await until(() => !root.hidden && !root.classList.contains('pl-loading') && L.out.length === 1);
    // the next track's prepare is now waiting on its (slow) getSource: repeat and shuffle start their own
    root.querySelector('.pl-controls .pl-btn[aria-label^="Repeat"]').click();
    root.querySelector('.pl-controls .pl-btn[aria-label="Shuffle"]').click();
    await sleep(900);
    stop();
    await sleep(50);
    t.assert(L.out.length >= 2, `prepares ran (${L.out.length} sources)`);
    t.deepEqual(L.leaks(), [], 'sources not released exactly once');
    dock.remove();
  });

  await t.test('player: an album auto-advance is still "media playing" (no false blip between tracks for autolock)', async () => {
    const dock = document.createElement('div');
    document.body.append(dock);
    mountPlayer(dock);
    const L = ledger();
    const mk = (k, name, type, bytes, delay) => ({ key: k, name, type, kind: 'audio', size: bytes.length, getSource: L.make(bytes, { name, type }, delay) });
    playQueue([mk('1', 'a.wav', 'audio/wav', wav, 0), mk('2', 'b.webm', 'audio/webm', audio, 400)]);
    const root = dock.querySelector('.pl-root');
    const a = root.querySelector('.pl-audio');
    await until(() => !root.classList.contains('pl-loading') && a.readyState >= 1);
    if (a.paused) root.querySelector('.pl-play').click();
    await until(() => isPlaying());
    await sleep(500); // the next track's prepare (slow getSource) has finished
    const seen = [];
    const off = state.on('player', (v) => seen.push(v.playing));
    const samples = [];
    const sampler = setInterval(() => samples.push(isPlaying()), 10);
    a.currentTime = Math.max(0, a.duration - 0.05);
    await until(() => root.querySelector('.pl-name').textContent === 'b.webm' && !a.paused && a.currentTime > 0.05);
    clearInterval(sampler);
    off();
    t.deepEqual(seen.filter((x) => x === false), [], `state 'player' went false between tracks (${JSON.stringify(seen)})`);
    t.assert(samples.length > 3 && samples.every(Boolean), `isPlaying() during the advance: ${JSON.stringify(samples)}`);
    // the end of the queue (repeat off) is the end of playback
    const ended = new Promise((r) => {
      const o = state.on('player', (v) => {
        if (!v.playing) {
          o();
          r(true);
        }
      });
    });
    a.currentTime = Math.max(0, a.duration - 0.05);
    t.equal(await Promise.race([ended, sleep(5000).then(() => false)]), true, 'not playing after the last track');
    t.equal(isPlaying(), false);
    stop();
    dock.remove();
  });

  await t.test('viewer: every source is disposed exactly once while the arrows race slow sources', async () => {
    const L = ledger();
    const items = [0, 1, 2, 3, 4].map((i) => ({
      key: `k${i}`, name: `n${i}.txt`, type: 'text/plain', kind: 'doc', size: notes.length,
      getSource: L.make(notes, { name: `n${i}.txt`, type: 'text/plain' }, 60 + 40 * (i % 2)),
    }));
    openViewer({ items, index: 0 });
    const root = document.querySelector('.vw-root');
    for (let i = 0; i < 4; i++) {
      root.dispatchEvent(key('ArrowRight'));
      await sleep(15);
    }
    root.dispatchEvent(key('ArrowLeft'));
    await until(() => root.querySelector('.vw-text'));
    closeViewer();
    await sleep(250);
    t.equal(L.out.length, 6, 'one getSource per show');
    t.deepEqual(L.leaks(), [], 'sources not released exactly once');
  });

  await t.test('viewer: saving a note (new id, DESIGN §1.5) keeps showing that note after the caller\'s update()', async () => {
    const note = (k, title, body) => ({
      key: k, name: title, type: NOTE_TYPE, kind: 'note', size: 10, actions: ['editNote', 'delete'],
      getSource: async () => ({ kind: 'plain', blob: new Blob([JSON.stringify({ v: 1, title, body })]), name: title, type: NOTE_TYPE }),
    });
    const pic = { key: 'p', name: 'pic.png', type: 'image/png', kind: 'image', size: png.length, getSource: async () => ({ kind: 'plain', blob: new Blob([png]), name: 'pic.png', type: 'image/png' }) };
    // 'after': the list update comes after the save resolved {key}; 'before': the vault's 'items' event rebuilds the
    // list first and the save then resolves with the new ItemInfo {id}. (Routed mode: tests/e2e/media.spec.js.)
    for (const order of ['after', 'before']) {
      let items = [pic, note('n1', 'Plan', 'one')];
      let v = null;
      const shown = [];
      const wrap = (it) => ({ ...it, getSource: () => (shown.push(it.key), it.getSource()) });
      v = openViewer({
        items: items.map(wrap),
        index: 1,
        onAction: async (a, it, p) => {
          if (a !== 'editNote') return undefined;
          await sleep(20);
          items = [note('n2', p.title, p.body), pic]; // the new note sorts first
          if (order === 'before') {
            v.update(items.map(wrap));
            return { id: 'n2', name: p.title };
          }
          setTimeout(() => v.update(items.map(wrap)), 0);
          return { key: 'n2' };
        },
      });
      const root = document.querySelector('.vw-root');
      await until(() => root.querySelector('.vw-note-body'));
      const body = root.querySelector('.vw-note-body');
      body.value = 'one two';
      body.dispatchEvent(new Event('input'));
      root.querySelector('.vw-note-save').click();
      await until(() => root.querySelector('.vw-note-status').textContent === 'Saved');
      await sleep(100);
      t.equal(root.dataset.mode, 'note', `${order}: still the note`);
      t.equal(root.querySelector('.vw-note-body')?.value, 'one two', `${order}: editor kept`);
      t.equal(root.querySelector('.vw-count').textContent, '1 / 2', `${order}: its new place in the list`);
      t.deepEqual(shown, ['n1'], `${order}: no other item was loaded`);
      closeViewer();
    }
  });

  await t.test('viewer: a photo above CAPS.image says it is too big to preview (not "can\'t show .jpg")', async () => {
    const big = {
      key: 'big', name: 'huge.jpg', type: 'image/jpeg', kind: 'image', size: CAPS.image + 1, actions: ['save', 'share'],
      getSource: async () => ({ kind: 'plain', blob: new Blob([png]), name: 'huge.jpg', type: 'image/jpeg' }),
    };
    openViewer({ items: [big] });
    await until(() => document.querySelector('.vw-card-text'));
    t.equal(document.querySelector('.vw-card-text').textContent, userMessage('too-big-to-preview'));
    t.assert(document.querySelector('.vw-card-actions .btn'), 'Save/Share offered');
    closeViewer();
  });

  await t.test('viewer: an open "More" menu closes when the action bar is repainted or the viewer closes', async () => {
    const item = {
      key: 'x', name: 'pic.png', type: 'image/png', kind: 'image', size: png.length, actions: ['fav', 'save', 'rename', 'delete'],
      getSource: async () => ({ kind: 'plain', blob: new Blob([png], { type: 'image/png' }), name: 'pic.png', type: 'image/png' }),
    };
    const v = openViewer({ items: [item] });
    document.querySelector('.vw-act-more').click();
    t.equal(document.querySelectorAll('.menu').length, 1, 'menu open');
    v.update([{ ...item, fav: true }]);
    t.equal(document.querySelectorAll('.menu').length, 0, 'stale menu closed by the repaint');
    t.equal(document.querySelector('.vw-act-fav').getAttribute('aria-pressed'), 'true');
    document.querySelector('.vw-act-more').click();
    t.equal(document.querySelectorAll('.menu').length, 1, 'new menu open');
    const more = document.querySelector('.vw-act-more');
    closeViewer();
    t.equal(more.getAttribute('aria-expanded'), 'false', 'menu closed with the viewer');
  });
}
