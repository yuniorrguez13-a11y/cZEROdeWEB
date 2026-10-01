// Browser units for the vault (runner: tests/browser/index.html?suite=vault, app CSP): a real Vault on real
// IndexedDB + OpfsStore (opfs-worker) with the KDF in its module worker — create/unlock at POLICY, add an image with
// a real thumbnail, open/decrypt, lock (keys, URLs), export a .czd, backup → destroy → restore; makeThumb on the real
// fixtures (large JPEG, PNG, VP8 video poster + duration, audio duration, junk, SVG); the privacy cover on <html>.
import { Vault } from '../../app/vault/vault.js';
import { openVaultDb } from '../../app/vault/db.js';
import { openStore, probeBestKind } from '../../app/vault/store.js';
import { makeThumb } from '../../app/vault/thumbs.js';
import { startAutolock } from '../../app/vault/autolock.js';
import { decryptSource, makePassKek, openSource } from '../../app/crypto/container.js';
import { CzdError } from '../../app/errors.js';
import { blobSource, bytesSource } from '../../app/util/stream.js';

const PASS = 'browser vault passphrase';
const FAST = { m: 64, t: 1, p: 1 };

async function resetStorage() {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry('czd', { recursive: true });
  } catch (e) {
    if (e.name !== 'NotFoundError') throw e;
  }
  await new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase('czd-vault');
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('czd-vault delete blocked'));
  });
}

async function collect(it) {
  const parts = [];
  for await (const p of it) parts.push(p);
  return new Uint8Array(await new Blob(parts).arrayBuffer());
}

function same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function fixture(name, type) {
  const res = await fetch(`../fixtures/${name}`);
  if (!res.ok) throw new Error(`fixture ${name}: ${res.status}`);
  return new File([await res.blob()], name.split('/').pop(), { type });
}

async function rejectsWith(p, code) {
  try {
    await p;
  } catch (e) {
    return e instanceof CzdError && e.code === code ? true : `${e?.name} ${e?.code ?? e?.message}`;
  }
  return 'did not reject';
}

/** A 1200×800 PNG drawn on a canvas. */
async function pngFile() {
  const c = new OffscreenCanvas(1200, 800);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 1200, 800);
  grad.addColorStop(0, '#cc2200');
  grad.addColorStop(1, '#2244aa');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1200, 800);
  g.fillStyle = '#ffd700';
  for (let i = 0; i < 40; i++) g.fillRect((i * 97) % 1150, (i * 53) % 760, 40, 30);
  return new File([await c.convertToBlob({ type: 'image/png' })], 'drawn.png', { type: 'image/png', lastModified: 1_700_000_000_000 });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed to load'));
    img.src = url;
  });
}

export default async function (t) {
  await resetStorage();
  const db = await openVaultDb();
  let vault = new Vault({ db, openStore: async (kind) => openStore(kind ?? (await probeBestKind()), { db }), thumbnailer: makeThumb });

  await t.test('create at POLICY on OPFS, unlock in the KDF worker, wrong passphrase refused', async () => {
    await vault.init();
    t.equal(vault.status, 'none');
    const r = await vault.create(PASS);
    t.assert(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/.test(r.recoveryCode), 'recovery code format');
    t.equal(vault.status, 'unlocked');
    t.equal(vault.storeKind, 'opfs');
    t.deepEqual(vault.kdfParams, { m: 65536, t: 3, p: 1 });
    vault.lock('test');
    t.equal(await rejectsWith(vault.unlock('not the passphrase'), 'wrong-passphrase'), true);
    const u = await vault.unlock(PASS);
    t.log(`unlock at POLICY: ${u.ms} ms`);
    t.equal(vault.status, 'unlocked');
  });

  let photo;
  let photoFile;
  await t.test('add a real image: thumbnail ≤ 320 px and ≤ 32 KiB, decrypts back to the same bytes', async () => {
    photoFile = await pngFile();
    photo = await vault.addFile(photoFile);
    t.equal(photo.kind, 'image');
    t.equal(photo.hasThumb, true);
    t.deepEqual([photo.w, photo.h], [1200, 800]);
    const url = await vault.thumbUrl(photo.id);
    t.assert(url.startsWith('blob:'), 'blob URL');
    const img = await loadImage(url);
    t.deepEqual([img.naturalWidth, img.naturalHeight], [320, 213]);
    const rec = await db.get('thumbs', photo.id);
    t.assert(rec.enc.length <= 32 * 1024 + 16, `thumb record ${rec.enc.length} bytes`);
    const { src, opened } = await vault.open(photo.id);
    t.assert(src.blob instanceof Blob, 'OPFS source has a Blob');
    t.assert(same(await collect(decryptSource(src, opened)), new Uint8Array(await photoFile.arrayBuffer())), 'round trip');
  });

  await t.test('lock: items unavailable, thumbnail URL revoked, handed-out Opened released', async () => {
    const url = await vault.thumbUrl(photo.id);
    const { src, opened } = await vault.open(photo.id);
    vault.lock('user');
    t.equal(vault.status, 'locked');
    let threw = false;
    try {
      vault.items();
    } catch (e) {
      threw = e.code === 'vault-locked';
    }
    t.assert(threw, 'items() → vault-locked');
    let loaded = true;
    try {
      await loadImage(url); // img-src allows blob: (connect-src does not, so no fetch)
    } catch {
      loaded = false;
    }
    t.assert(!loaded, 'revoked URL no longer loads');
    t.equal(await rejectsWith(collect(decryptSource(src, opened)), 'aborted'), true);
    await vault.unlock(PASS);
    t.equal(vault.items().length, 1);
  });

  await t.test('exportCzd: the output opens with its passphrase and holds the current name', async () => {
    await vault.rename(photo.id, 'sunset.png');
    const kek = await makePassKek('send to a friend', FAST);
    const [out] = await vault.exportCzd([photo.id], kek);
    const bytes = await collect(out.stream);
    t.equal(bytes.length, out.size);
    const src = blobSource(new Blob([bytes]));
    const opened = await openSource(src, { passphrase: 'send to a friend' });
    t.equal(opened.meta.name, 'sunset.png');
    t.assert(same(await collect(decryptSource(src, opened)), new Uint8Array(await photoFile.arrayBuffer())), 'payload');
  });

  await t.test('backup → destroy → restore (replace) on the real stores', async () => {
    const note = await vault.addNote({ title: 'kept', body: 'through a backup' });
    const b = await vault.exportBackup();
    const bytes = await collect(b.stream);
    t.equal(bytes.length, b.size);
    await vault.destroy();
    t.equal(vault.status, 'none');
    const root = await navigator.storage.getDirectory();
    const items = await (await (await root.getDirectoryHandle('czd')).getDirectoryHandle('v1')).getDirectoryHandle('items');
    let files = 0;
    for await (const _ of items.keys()) files++;
    t.equal(files, 0, 'containers deleted');
    vault = new Vault({ db, openStore: async (kind) => openStore(kind ?? (await probeBestKind()), { db }), thumbnailer: makeThumb });
    await vault.init();
    const r = await vault.restoreBackup(bytesSource(bytes), { pass: PASS }, { mode: 'replace' });
    t.deepEqual(r, { added: 2, skipped: 0 });
    t.equal(vault.status, 'unlocked');
    t.deepEqual(await vault.readNote(note.id), { title: 'kept', body: 'through a backup' });
    t.equal(vault.item(photo.id).name, 'sunset.png');
    t.assert(Boolean(await vault.thumbUrl(photo.id)), 'thumbnail restored');
  });

  await t.test('makeThumb: large JPEG, PNG, video poster + duration, audio duration, junk and SVG', async () => {
    const big = await makeThumb(await fixture('large.jpg', 'image/jpeg'), 'image/jpeg');
    t.deepEqual([big.w, big.h], [4000, 3000]);
    t.assert(big.jpeg.length <= 32 * 1024, `large.jpg thumb ${big.jpeg.length} bytes`);
    const bigImg = await loadImage(URL.createObjectURL(new Blob([big.jpeg], { type: 'image/jpeg' })));
    t.deepEqual([bigImg.naturalWidth, bigImg.naturalHeight], [320, 240]);
    const png = await makeThumb(await fixture('image.png', 'image/png'), 'image/png');
    t.deepEqual([png.w, png.h], [320, 200]);
    const video = await makeThumb(await fixture('clip.webm', 'video/webm'), 'video/webm');
    t.assert(video && video.jpeg instanceof Uint8Array && video.jpeg.length > 0, 'video poster');
    t.deepEqual([video.w, video.h], [640, 360]);
    t.assert(Math.abs(video.duration - 5) < 0.6, `video duration ${video.duration}`);
    const audio = await makeThumb(await fixture('tone.wav', 'audio/wav'), 'audio/wav');
    t.equal(audio.jpeg, null);
    t.assert(Math.abs(audio.duration - 1.5) < 0.1, `audio duration ${audio.duration}`);
    t.equal(await makeThumb(new File([new Uint8Array(500).fill(7)], 'junk.png', { type: 'image/png' }), 'image/png'), null);
    t.equal(await makeThumb(new File([new Uint8Array(500).fill(7)], 'junk.webm', { type: 'video/webm' }), 'video/webm'), null);
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'], 'x.svg', { type: 'image/svg+xml' });
    t.equal(await makeThumb(svg, 'image/svg+xml'), null);
    t.equal(document.querySelectorAll('video, audio').length, 0, 'media elements removed');
  });

  await t.test('autolock privacy cover toggles the class on <html> (real DOM events)', async () => {
    const settings = { get: (n) => ({ idleLockMin: 0, hiddenLock: 'never', privacyCover: true, keepAudioWhenHidden: true })[n] };
    const fakeState = { get: () => undefined, on: () => () => {}, purge: () => {} };
    const stop = startAutolock({ vault, settings, state: fakeState, isTauri: false });
    try {
      window.dispatchEvent(new Event('blur'));
      t.assert(document.documentElement.classList.contains('privacy-cover'), 'covered on blur');
      window.dispatchEvent(new Event('focus'));
      t.assert(!document.documentElement.classList.contains('privacy-cover'), 'uncovered on focus');
    } finally {
      stop();
    }
    vault.lock('done');
  });
}
