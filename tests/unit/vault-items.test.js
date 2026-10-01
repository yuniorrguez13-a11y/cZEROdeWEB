// app/vault/vault.js items (DESIGN §1.5, §1.7, §4.1): addFile/addStream (thumbnails, progress, jobs, failures leave
// nothing behind: abort, quota, size mismatch, commit failure, lock mid-job), notes (saveNote = new id carrying fav,
// addedAt and albums), rename/favorite, remove (+albums, from a 'locking' listener), open (tamper, swap, missing),
// sourceFor, thumbUrl, albums CRUD, and exportCzd (single, notes, bundle, dates, sizes, interruption).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import { MemoryStore } from '../../app/vault/store.js';
import * as state from '../../app/state.js';
import { BUNDLE_TYPE, decryptRange, decryptSource, makePassKek, openSource } from '../../app/crypto/container.js';
import { NOTE_TYPE } from '../../app/util/format.js';
import { blobSource, bytesSource } from '../../app/util/stream.js';
import { FAST, PASS, T0, bytes, collectBytes, file, gatedSource, isCzd, recordEvents, same, unlockedVault } from './vault-helpers.js';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const thumbnailer = async (f, type) => {
  if (type.startsWith('image/')) return { jpeg: JPEG, w: 640, h: 480 };
  if (type.startsWith('audio/')) return { jpeg: null, w: 0, h: 0, duration: 61.5 };
  return null;
};

async function plaintextOf(v, id) {
  const { src, opened } = await v.open(id);
  return collectBytes(decryptSource(src, opened));
}

async function assertNothingStored(v, store, db) {
  assert.deepEqual(await store.list(), [], 'no container left behind');
  assert.deepEqual(await db.getAll('items'), [], 'no index record');
  assert.deepEqual(await db.getAll('thumbs'), [], 'no thumbnail record');
  assert.deepEqual(v.items(), []);
}

test('addFile: ItemInfo, container written and verified, round trip, thumbnail, events, job tracking', async () => {
  const { v, store, db } = await unlockedVault({ thumbnailer });
  const log = recordEvents(v, ['items', 'job']);
  const data = bytes(700_000, 7);
  const progress = [];
  const info = await v.addFile(file(data, 'holiday.JPG', 'image/jpeg', T0 - 5000), { onProgress: (d, t) => progress.push([d, t]) });
  assert.match(info.id, /^[0-9a-f]{32}$/);
  assert.equal(info.name, 'holiday.JPG');
  assert.equal(info.type, 'image/jpeg');
  assert.equal(info.kind, 'image');
  assert.equal(info.size, data.length);
  assert.equal(info.mtime, T0 - 5000);
  assert.equal(info.fav, false);
  assert.equal(info.hasThumb, true);
  assert.equal(info.w, 640);
  assert.equal(info.h, 480);
  assert.ok(info.addedAt > T0);
  const [{ size }] = await store.list();
  assert.equal(info.storedBytes, size);
  assert.deepEqual(progress.at(-1), [data.length, data.length]);
  assert.ok(same(await plaintextOf(v, info.id), data));
  assert.deepEqual(v.item(info.id), info);
  assert.deepEqual(log.filter((e) => e.type === 'job').map((e) => e.detail.running), [true, false]);
  assert.deepEqual(log.find((e) => e.type === 'items').detail, { added: [info.id], removed: [], updated: [] });
  assert.equal(state.get('busy'), 0);
  const url = await v.thumbUrl(info.id);
  assert.match(url, /^blob:/);
  assert.equal(await v.thumbUrl(info.id), url, 'cached per id');
  assert.ok(same(new Uint8Array(await resolveObjectURL(url).arrayBuffer()), JPEG));
  assert.equal(resolveObjectURL(url).type, 'image/jpeg');
  const rec = await db.get('thumbs', info.id);
  assert.ok(!same(rec.enc.subarray(0, JPEG.length), JPEG), 'thumbnail stored encrypted');
});

test('addFile: names sanitized, type from the extension when missing, octet-stream for unknown; audio duration', async () => {
  const { v } = await unlockedVault({ thumbnailer });
  const a = await v.addFile(file(new Uint8Array(3), 'a/b:c?.txt'));
  assert.equal(a.name, 'a_b_c_.txt');
  assert.equal(a.type, 'text/plain');
  assert.equal(a.kind, 'doc');
  const b = await v.addFile(file(new Uint8Array(3), 'weird.zzz'));
  assert.equal(b.type, 'application/octet-stream');
  assert.equal(b.kind, 'other');
  const c = await v.addFile(file(new Uint8Array(30), 'song', 'Audio/MPEG; codecs=x'));
  assert.equal(c.type, 'audio/mpeg');
  assert.equal(c.duration, 61.5);
  assert.equal(c.hasThumb, false);
  const d = await v.addFile(file(new Uint8Array(0), 'empty.bin', 'application/octet-stream'), { name: 'renamed.bin' });
  assert.equal(d.name, 'renamed.bin');
  assert.equal(d.size, 0);
  assert.equal((await plaintextOf(v, d.id)).length, 0);
  await assert.rejects(v.addFile('not a file'), TypeError);
});

test('thumbnailer misbehaving (throws, oversized jpeg, junk) never fails the import', async () => {
  for (const t of [async () => { throw new Error('x'); }, async () => ({ jpeg: new Uint8Array(40_000), w: 1, h: 1 }), async () => 'junk', () => null]) {
    const { v } = await unlockedVault({ thumbnailer: t });
    const info = await v.addFile(file(new Uint8Array(5), 'p.png', 'image/png'));
    assert.equal(info.hasThumb, false);
    assert.equal(await v.thumbUrl(info.id), null);
  }
});

test('addStream: async iterable, ByteSource and Blob sources; thumbFrom; album membership', async () => {
  const { v } = await unlockedVault({ thumbnailer });
  const album = await v.createList({ name: 'Album' });
  const data = bytes(300_000, 3);
  async function* gen() {
    for (let o = 0; o < data.length; o += 70_001) yield data.subarray(o, o + 70_001);
  }
  const a = await v.addStream({ name: 'x.bin', type: 'application/octet-stream', size: data.length, mtime: 5 }, gen(), { album: album.id });
  assert.ok(same(await plaintextOf(v, a.id), data));
  assert.equal(a.mtime, 5);
  const b = await v.addStream({ name: 'y.png', type: 'image/png', size: data.length }, bytesSource(data), { thumbFrom: new Blob([new Uint8Array(4)]) });
  assert.equal(b.hasThumb, true);
  const c = await v.addStream({ name: 'z.bin', size: 4 }, new Blob([new Uint8Array([9, 8, 7, 6])]));
  assert.ok(same(await plaintextOf(v, c.id), new Uint8Array([9, 8, 7, 6])));
  assert.deepEqual(v.list(album.id).itemIds, [a.id]);
});

test('addStream: wrong size / bad source → error and nothing left behind', async () => {
  const { v, store, db } = await unlockedVault();
  await assert.rejects(v.addStream({ name: 'a', size: 10 }, [new Uint8Array(5)]), isCzd('source-size-mismatch'));
  await assert.rejects(v.addStream({ name: 'a', size: 2 }, [new Uint8Array(5)]), isCzd('source-larger-than-size'));
  await assert.rejects(v.addStream({ name: 'a', size: 2 }, 'nope'), TypeError);
  await assert.rejects(v.addStream({ name: 'a', size: -1 }, []), TypeError);
  await assertNothingStored(v, store, db);
  assert.equal(state.get('busy'), 0);
});

test('abort mid-add → aborted, nothing left behind', async () => {
  const { v, store, db } = await unlockedVault();
  const ac = new AbortController();
  const src = gatedSource(new Uint8Array(100), new Uint8Array(100));
  const p = v.addStream({ name: 'a.bin', size: 200 }, src, { signal: ac.signal });
  await src.started;
  ac.abort();
  src.release();
  await assert.rejects(p, isCzd('aborted'));
  await assertNothingStored(v, store, db);
  // Already aborted before it starts.
  await assert.rejects(v.addFile(file(new Uint8Array(3), 'b.bin'), { signal: AbortSignal.abort() }), isCzd('aborted'));
  await assertNothingStored(v, store, db);
});

test('quota exceeded → quota-exceeded, nothing left behind', async () => {
  const { v, store, db } = await unlockedVault({ store: new MemoryStore({ quota: 50_000 }) });
  await assert.rejects(v.addFile(file(bytes(100_000), 'big.bin')), isCzd('quota-exceeded'));
  await assertNothingStored(v, store, db);
  await v.addFile(file(bytes(1000), 'small.bin'));
  assert.equal(v.items().length, 1);
});

test('a failing index commit deletes the written container', async () => {
  let fail = false;
  const { v, store, db } = await unlockedVault({
    wrapDb: (real) => Object.assign(Object.create(real), {
      async commit(ops, opts) {
        if (fail) throw new Error('disk on fire');
        return real.commit(ops, opts);
      },
    }),
  });
  fail = true;
  await assert.rejects(v.addFile(file(bytes(1000), 'a.bin')), isCzd('internal'));
  fail = false;
  await assertNothingStored(v, store, db);
});

test('lock during a job → interrupted (silent abort, nothing left behind, busy back to 0)', async () => {
  const { v, store, db } = await unlockedVault();
  const src = gatedSource(new Uint8Array(100), new Uint8Array(100));
  const p = v.addStream({ name: 'a.bin', size: 200 }, src);
  await src.started;
  assert.equal(state.get('busy'), 1);
  v.lock('idle');
  src.release();
  await assert.rejects(p, isCzd('interrupted'));
  assert.equal(state.get('busy'), 0);
  await v.unlock(PASS);
  await assertNothingStored(v, store, db);
});

test('notes: addNote/readNote; saveNote = new id carrying fav, addedAt, album membership and cover; old removed', async () => {
  const { v, store } = await unlockedVault();
  const n = await v.addNote({ title: 'Groceries', body: 'milk\neggs' });
  assert.equal(n.type, NOTE_TYPE);
  assert.equal(n.kind, 'note');
  assert.equal(n.name, 'Groceries');
  assert.deepEqual(await v.readNote(n.id), { title: 'Groceries', body: 'milk\neggs' });
  const other = await v.addFile(file(new Uint8Array(3), 'x.bin'));
  await v.setFavorite(n.id, true);
  const al = await v.createList({ name: 'A', itemIds: [other.id, n.id] });
  await v.updateList(al.id, { cover: n.id });
  const al2 = await v.createList({ name: 'B', itemIds: [n.id] });
  const log = recordEvents(v, ['items', 'lists']);
  const saved = await v.saveNote(n.id, { title: 'Groceries: week 2/3', body: 'bread' });
  assert.notEqual(saved.id, n.id);
  assert.equal(saved.fav, true);
  assert.equal(saved.addedAt, n.addedAt);
  assert.equal(saved.name, 'Groceries: week 2/3', 'note titles are labels, not file names');
  assert.deepEqual(await v.readNote(saved.id), { title: 'Groceries: week 2/3', body: 'bread' });
  assert.throws(() => v.item(n.id), isCzd('item-not-found'));
  assert.deepEqual(v.list(al.id).itemIds, [other.id, saved.id]);
  assert.equal(v.list(al.id).cover, saved.id);
  assert.deepEqual(v.list(al2.id).itemIds, [saved.id]);
  assert.deepEqual(log.find((e) => e.type === 'items').detail, { added: [saved.id], removed: [n.id], updated: [] });
  assert.ok(log.some((e) => e.type === 'lists'));
  assert.deepEqual((await store.list()).map((e) => e.id).sort(), [other.id, saved.id].sort());
  await assert.rejects(v.saveNote(other.id, { title: 'x', body: 'y' }), TypeError);
  await assert.rejects(v.saveNote('0'.repeat(32), { title: 'x', body: 'y' }), isCzd('item-not-found'));
  const blank = await v.addNote({ title: '  ', body: '' });
  assert.equal(blank.name, 'Note');
  v.lock('x');
  await v.unlock(PASS);
  assert.deepEqual(await v.readNote(saved.id), { title: 'Groceries: week 2/3', body: 'bread' });
});

test('a note saved from a locking listener (dirty editor) is committed; the lock still wins for the UI', async () => {
  const { v } = await unlockedVault();
  const n = await v.addNote({ title: 'Draft', body: 'v1' });
  let pending = null;
  v.addEventListener('locking', () => {
    pending = v.saveNote(n.id, { title: 'Draft', body: 'v2' });
  });
  v.lock('hidden');
  assert.equal(v.status, 'locked');
  const saved = await pending;
  await v.unlock(PASS);
  assert.deepEqual(v.items().map((i) => i.id), [saved.id]);
  assert.deepEqual(await v.readNote(saved.id), { title: 'Draft', body: 'v2' });
});

test('rename and setFavorite persist; concurrent edits of one item both survive', async () => {
  const { v } = await unlockedVault();
  const a = await v.addFile(file(new Uint8Array(3), 'a.txt', 'text/plain'));
  const log = recordEvents(v, ['items']);
  const [r1, r2] = await Promise.all([v.rename(a.id, 'b/c.txt'), v.setFavorite(a.id, true)]);
  assert.equal(r1.name, 'b_c.txt');
  assert.equal(r2.fav, true);
  assert.deepEqual(log.map((e) => e.detail.updated), [[a.id], [a.id]]);
  v.lock('x');
  await v.unlock(PASS);
  const got = v.item(a.id);
  assert.equal(got.name, 'b_c.txt');
  assert.equal(got.fav, true);
  await v.setFavorite(a.id, false);
  assert.equal(v.item(a.id).fav, false);
  await assert.rejects(v.rename('f'.repeat(32), 'x'), isCzd('item-not-found'));
  // The container keeps its original name; the index name is what everything shows.
  const { opened } = await v.open(a.id);
  assert.equal(opened.meta.name, 'a.txt');
});

test('remove: records, thumbnails, containers and album membership (one commit); unknown ids ignored', async () => {
  const { v, store, db } = await unlockedVault({ thumbnailer });
  const a = await v.addFile(file(new Uint8Array(3), 'a.png', 'image/png'));
  const b = await v.addFile(file(new Uint8Array(3), 'b.txt'));
  const al = await v.createList({ name: 'A', itemIds: [a.id, b.id] });
  await v.updateList(al.id, { cover: a.id });
  const url = await v.thumbUrl(a.id);
  const log = recordEvents(v, ['items', 'lists']);
  assert.deepEqual(await v.remove([a.id, 'f'.repeat(32), a.id]), [a.id]);
  assert.deepEqual(log.find((e) => e.type === 'items').detail, { added: [], removed: [a.id], updated: [] });
  assert.ok(log.some((e) => e.type === 'lists'));
  assert.deepEqual(v.list(al.id).itemIds, [b.id]);
  assert.equal(v.list(al.id).cover, undefined);
  assert.equal(resolveObjectURL(url), undefined);
  assert.deepEqual((await store.list()).map((e) => e.id), [b.id]);
  assert.equal(await db.get('thumbs', a.id), undefined);
  assert.equal(await db.get('items', a.id), undefined);
  assert.deepEqual(await v.remove([]), []);
  v.lock('x');
  await v.unlock(PASS);
  assert.deepEqual(v.items().map((i) => i.id), [b.id]);
  assert.deepEqual(v.list(al.id).itemIds, [b.id]);
});

test('remove started from a locking listener (pending Undo delete) completes after the lock', async () => {
  const { v, store } = await unlockedVault();
  const a = await v.addFile(file(new Uint8Array(3), 'a.bin'));
  const b = await v.addFile(file(new Uint8Array(3), 'b.bin'));
  let p = null;
  v.addEventListener('locking', () => {
    p = v.remove([a.id]);
  });
  v.lock('pagehide');
  await p;
  assert.deepEqual((await store.list()).map((e) => e.id), [b.id]);
  await v.unlock(PASS);
  assert.deepEqual(v.items().map((i) => i.id), [b.id]);
});

test('open: header tamper / swapped containers / truncation → item-tampered; payload tamper → chunk-auth; missing → item-file-missing', async () => {
  const { v, store } = await unlockedVault();
  const data = bytes(600_000, 9);
  const a = await v.addFile(file(data, 'a.bin'));
  const b = await v.addFile(file(bytes(1000, 2), 'b.bin'));
  const orig = new Uint8Array(await store.items.get(a.id).blob.arrayBuffer());
  const put = (id, u8) => store.items.set(id, { blob: new Blob([u8]), mtime: 0 });
  const flip = (u8, i) => {
    const c = u8.slice();
    c[i] ^= 1;
    return c;
  };
  put(a.id, flip(orig, 40)); // inside the vault stanza
  await assert.rejects(v.open(a.id), isCzd('item-tampered'));
  put(a.id, flip(orig, 300)); // metadata ciphertext → header MAC
  await assert.rejects(v.open(a.id), isCzd('item-tampered'));
  put(a.id, orig.slice(0, orig.length - 1));
  await assert.rejects(v.open(a.id), isCzd('item-tampered'));
  put(a.id, flip(orig, orig.length - 100)); // payload: opens, fails while decrypting
  await assert.rejects(plaintextOf(v, a.id), isCzd('truncated-or-corrupt'));
  put(a.id, flip(orig, 600)); // first chunk
  await assert.rejects(plaintextOf(v, a.id), isCzd('chunk-auth'));
  // Swap the two containers: each opens only under its own item id.
  const bBytes = new Uint8Array(await store.items.get(b.id).blob.arrayBuffer());
  put(a.id, bBytes);
  put(b.id, orig);
  await assert.rejects(v.open(a.id), isCzd('item-tampered'));
  await assert.rejects(v.open(b.id), isCzd('item-tampered'));
  put(a.id, orig);
  assert.ok(same(await plaintextOf(v, a.id), data));
  store.items.delete(a.id);
  await assert.rejects(v.open(a.id), isCzd('item-file-missing'));
  await assert.rejects(v.open('0'.repeat(32)), isCzd('item-not-found'));
});

test('open: a container whose header MAC differs from the index hmac → item-tampered', async () => {
  const { v, db } = await unlockedVault();
  const a = await v.addFile(file(new Uint8Array(10), 'a.bin'));
  // Re-encrypt the index record with a different hmac through the vault's own rename path, then compare.
  const rec = await db.get('items', a.id);
  await v.rename(a.id, 'renamed.bin');
  assert.ok(!same(rec.enc, (await db.get('items', a.id)).enc));
  const { opened } = await v.open(a.id);
  assert.ok(opened.mac.length === 32);
  // Corrupt the in-memory hmac (as a stale/forged index would) and open again.
  v._items.get(a.id).ix.hmac = 'AAAA';
  await assert.rejects(v.open(a.id), isCzd('item-tampered'));
});

test('sourceFor: DecryptSource with itemId/name/type and release(); lock releases every handed-out Opened', async () => {
  const { v } = await unlockedVault();
  const data = bytes(1000, 4);
  const a = await v.addFile(file(data, 'a.bin'));
  await v.rename(a.id, 'now.bin');
  const s = await v.sourceFor(a.id);
  assert.equal(s.kind, 'container');
  assert.equal(s.itemId, a.id);
  assert.equal(s.name, 'now.bin');
  assert.ok(same(await collectBytes(decryptSource(s.src, s.opened)), data));
  s.release();
  assert.equal(s.opened.keys, null);
  const { src, opened } = await v.open(a.id);
  v.lock('user');
  assert.equal(opened.keys, null);
  await assert.rejects(collectBytes(decryptSource(src, opened)), isCzd('aborted'));
});

test('albums: create/update/remove, ids filtered and deduplicated, cover rules, events, persistence', async () => {
  const { v } = await unlockedVault();
  const a = await v.addFile(file(new Uint8Array(1), 'a'));
  const b = await v.addFile(file(new Uint8Array(1), 'b'));
  const log = recordEvents(v, ['lists']);
  const l = await v.createList({ name: '  Trip​ 2024/25 ', itemIds: [a.id, a.id, 'f'.repeat(32), b.id] });
  assert.equal(l.name, 'Trip 2024/25');
  assert.deepEqual(l.itemIds, [a.id, b.id]);
  assert.ok(Number.isSafeInteger(l.createdAt));
  const u = await v.updateList(l.id, { itemIds: [b.id, a.id], cover: a.id, name: 'Renamed' });
  assert.deepEqual(u.itemIds, [b.id, a.id]);
  assert.equal(u.cover, a.id);
  assert.equal(u.name, 'Renamed');
  assert.equal((await v.updateList(l.id, { cover: 'f'.repeat(32) })).cover, undefined);
  await v.updateList(l.id, { cover: b.id });
  assert.equal((await v.updateList(l.id, { itemIds: [a.id] })).cover, undefined, 'cover dropped with its item');
  const empty = await v.createList({});
  assert.equal(empty.name, 'Album');
  assert.equal(log.length, 6);
  await v.removeList(empty.id);
  assert.throws(() => v.list(empty.id), isCzd('item-not-found'));
  await assert.rejects(v.removeList(empty.id), isCzd('item-not-found'));
  await assert.rejects(v.updateList(empty.id, { name: 'x' }), isCzd('item-not-found'));
  v.lock('x');
  await v.unlock(PASS);
  assert.deepEqual(v.lists().map((x) => [x.id, x.name, x.itemIds]), [[l.id, 'Renamed', [a.id]]]);
});

test('items(): newest first; item()/list() unknown → item-not-found', async () => {
  const { v } = await unlockedVault();
  const a = await v.addFile(file(new Uint8Array(1), 'a'));
  const b = await v.addFile(file(new Uint8Array(1), 'b'));
  assert.deepEqual(v.items().map((i) => i.id), [b.id, a.id]);
  assert.throws(() => v.item('nope'), isCzd('item-not-found'));
  assert.throws(() => v.list('nope'), isCzd('item-not-found'));
});

test('exportCzd: one item → opens with the passphrase, CURRENT name/type, no mtime unless keepDates, exact size', async () => {
  const { v } = await unlockedVault();
  const data = bytes(400_000, 5);
  const a = await v.addFile(file(data, 'IMG_0001.jpg', 'image/jpeg', 1_600_000_000_000));
  await v.rename(a.id, 'beach.jpg');
  const kek = await makePassKek('send this file please', FAST);
  const [out] = await v.exportCzd([a.id], kek);
  assert.equal(out.name, 'beach.jpg');
  const ct = await collectBytes(out.stream);
  assert.equal(ct.length, out.size);
  const opened = await openSource(bytesSource(ct), { passphrase: 'send this file please' });
  assert.equal(opened.via, 'pass');
  assert.deepEqual(opened.meta, { v: 1, name: 'beach.jpg', type: 'image/jpeg', size: data.length });
  assert.ok(same(await collectBytes(decryptSource(bytesSource(ct), opened)), data));
  await assert.rejects(openSource(bytesSource(ct), { passphrase: PASS }), isCzd('wrong-passphrase'));
  const [dated] = await v.exportCzd([a.id], kek, { keepDates: true });
  const ct2 = await collectBytes(dated.stream);
  assert.equal(ct2.length, dated.size);
  assert.equal((await openSource(bytesSource(ct2), { passphrase: 'send this file please' })).meta.mtime, 1_600_000_000_000);
  assert.ok(!same(ct.subarray(0, 64), ct2.subarray(0, 64)), 'fresh fileKey/salt per output');
});

test('exportCzd: notes become "<title>.txt" (text/plain, body only)', async () => {
  const { v } = await unlockedVault();
  const n = await v.addNote({ title: 'To do', body: 'call mom ☎' });
  const kek = await makePassKek('note send pass', FAST);
  const [out] = await v.exportCzd([n.id], kek, {});
  assert.equal(out.name, 'To do.txt');
  const ct = await collectBytes(out.stream);
  assert.equal(ct.length, out.size);
  const opened = await openSource(bytesSource(ct), { passphrase: 'note send pass' });
  assert.equal(opened.meta.type, 'text/plain');
  assert.equal(opened.meta.name, 'To do.txt');
  assert.equal(new TextDecoder().decode(await collectBytes(decryptSource(bytesSource(ct), opened))), 'call mom ☎');
});

test('exportCzd: bundle of several items (deduplicated entry names, offsets, entry ranges) and bundle:false', async () => {
  const { v } = await unlockedVault();
  const d1 = bytes(300_000, 11);
  const d2 = bytes(5, 12);
  const a = await v.addFile(file(d1, 'same.bin'));
  const b = await v.addFile(file(d2, 'same.bin'));
  const n = await v.addNote({ title: 'memo', body: 'hi' });
  const kek = await makePassKek('bundle pass phrase', FAST);
  const progress = [];
  const outs = await v.exportCzd([a.id, b.id, n.id], kek, { onProgress: (d, t) => progress.push([d, t]) });
  assert.equal(outs.length, 1);
  assert.equal(outs[0].name, '3 files');
  const ct = await collectBytes(outs[0].stream);
  assert.equal(ct.length, outs[0].size);
  assert.deepEqual(progress.at(-1), [d1.length + d2.length + 2, d1.length + d2.length + 2]);
  const src = blobSource(new Blob([ct]));
  const opened = await openSource(src, { passphrase: 'bundle pass phrase' });
  assert.equal(opened.isBundle, true);
  assert.equal(opened.meta.type, BUNDLE_TYPE);
  assert.deepEqual(opened.meta.entries.map((e) => [e.name, e.type, e.size, e.off]), [
    ['same.bin', 'application/octet-stream', d1.length, 0],
    ['same (2).bin', 'application/octet-stream', d2.length, d1.length],
    ['memo.txt', 'text/plain', 2, d1.length + d2.length],
  ]);
  assert.ok(same(await decryptRange(src, opened, d1.length, d1.length + d2.length - 1), d2));
  assert.ok(same(await collectBytes(decryptSource(src, opened, { entry: opened.meta.entries[0] })), d1));
  const each = await v.exportCzd([a.id, b.id], kek, { bundle: false });
  assert.deepEqual(each.map((o) => o.name), ['same.bin', 'same.bin']);
  for (const o of each) assert.equal((await collectBytes(o.stream)).length, o.size);
  await assert.rejects(v.exportCzd([], kek), TypeError);
  await assert.rejects(v.exportCzd(['f'.repeat(32)], kek), isCzd('item-not-found'));
  await assert.rejects(v.exportCzd([a.id], {}), TypeError);
});

test('exportCzd: a lock before/while the stream runs → interrupted; a tampered item fails the stream', async () => {
  const { v, store } = await unlockedVault();
  const a = await v.addFile(file(bytes(600_000, 1), 'a.bin'));
  const kek = await makePassKek('lock test pass', FAST);
  const [o1] = await v.exportCzd([a.id], kek);
  v.lock('user');
  await assert.rejects(collectBytes(o1.stream), isCzd('interrupted'));
  await v.unlock(PASS);
  const [o2] = await v.exportCzd([a.id], kek);
  const it = o2.stream[Symbol.asyncIterator]();
  await it.next();
  v.lock('idle');
  await assert.rejects((async () => {
    for (;;) if ((await it.next()).done) break;
  })(), isCzd('interrupted'));
  assert.equal(state.get('busy'), 0);
  await v.unlock(PASS);
  const orig = new Uint8Array(await store.items.get(a.id).blob.arrayBuffer());
  orig[orig.length - 10] ^= 1;
  store.items.set(a.id, { blob: new Blob([orig]), mtime: 0 });
  const [o3] = await v.exportCzd([a.id], kek);
  await assert.rejects(collectBytes(o3.stream), isCzd('truncated-or-corrupt'));
});
