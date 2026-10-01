// app/vault/backup.js + Vault backup methods (DESIGN §3.7): export → replace round trip (passphrase, recovery code,
// code + new passphrase), merge into the same vault (skip existing ids) and into another vault (re-encrypt, new ids,
// album remap, idempotent repeats), inspectBackup, bounds checks before allocation, tamper of every section,
// truncation/trailing data, cleanup on failure, and export edge cases (missing container, change during export, lock).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import { MemoryStore } from '../../app/vault/store.js';
import { readBackupHeader, isCzb, CZB_MAGIC } from '../../app/vault/backup.js';
import * as state from '../../app/state.js';
import { decryptSource } from '../../app/crypto/container.js';
import { u32 } from '../../app/util/bytes.js';
import { bytesSource } from '../../app/util/stream.js';
import { PASS, backupBytes, bytes, collectBytes, file, isCzd, makeVault, same, unlockedVault } from './vault-helpers.js';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
const thumbnailer = async (f, type) => (type.startsWith('image/') ? { jpeg: JPEG, w: 2, h: 1 } : null);

async function plaintextOf(v, id) {
  const { src, opened } = await v.open(id);
  return collectBytes(decryptSource(src, opened));
}

/** A source vault with a photo (thumbnail, favorite), a renamed file, a note and an album with a cover. */
async function sourceVault(opts = {}) {
  const r = await unlockedVault({ thumbnailer, ...opts });
  const { v } = r;
  const photoData = bytes(300_000, 21);
  const docData = bytes(1234, 22);
  const photo = await v.addFile(file(photoData, 'photo.png', 'image/png'));
  const doc = await v.addFile(file(docData, 'doc.pdf', 'application/pdf'));
  const note = await v.addNote({ title: 'Secret plan', body: 'step 1' });
  await v.setFavorite(photo.id, true);
  await v.rename(doc.id, 'contract.pdf');
  const album = await v.createList({ name: 'Best', itemIds: [photo.id, note.id] });
  await v.updateList(album.id, { cover: photo.id });
  return { ...r, photo, doc, note, album, photoData, docData };
}

async function assertEmpty(v, store, db) {
  assert.deepEqual(await store.list(), [], 'no containers left');
  assert.equal(await db.getMeta(), undefined, 'no vault record');
  assert.deepEqual(await db.getAll('items'), []);
  assert.equal(v.status, 'none');
}

function mutate(u8, fn) {
  const c = u8.slice();
  fn(c);
  return bytesSource(c);
}

test('isCzb / CZB_MAGIC', () => {
  assert.ok(isCzb(CZB_MAGIC));
  assert.ok(!isCzb(new Uint8Array([0x89, 0x43, 0x5a, 0x44, 0x0d, 0x0a, 0x1a, 0x0a])));
  assert.ok(!isCzb(new Uint8Array(3)));
});

test('export → replace restore: identical items, names, favorites, albums, thumbnails, notes; vault left unlocked', async () => {
  const s = await sourceVault();
  assert.equal(s.v.lastBackupAt, null);
  const b = await s.v.exportBackup();
  assert.match(b.name, /^cZEROde-backup-\d{4}-\d{2}-\d{2}\.czb$/);
  assert.equal(b.skipped, 0);
  const progress = [];
  const out = await collectBytes((async function* () {
    for await (const p of b.stream) {
      progress.push(p.length);
      yield p;
    }
  })());
  assert.equal(out.length, b.size);
  assert.ok(isCzb(out));
  const hdr = await readBackupHeader(bytesSource(out));
  assert.equal(s.v.lastBackupAt, hdr.createdAt, 'lastBackupAt set when the stream completed');
  assert.deepEqual(hdr.counts, { items: 3, lists: 1, thumbs: 1 });

  const t = await makeVault();
  assert.deepEqual(await t.v.inspectBackup(bytesSource(out)), { sameVault: false, items: 3, lists: 1, thumbs: 1, createdAt: hdr.createdAt, hasRecovery: true });
  const r = await t.v.restoreBackup(bytesSource(out), { pass: PASS }, { mode: 'replace' });
  assert.deepEqual(r, { added: 3, skipped: 0 });
  assert.equal(t.v.status, 'unlocked');
  assert.equal(t.v.lastBackupAt, hdr.createdAt);
  assert.equal(t.v.storeKind, 'memory');
  const strip = (i) => ({ ...i, storedBytes: 0 });
  assert.deepEqual(t.v.items().map(strip), s.v.items().map(strip));
  assert.deepEqual(t.v.lists(), s.v.lists());
  assert.equal(t.v.item(s.photo.id).fav, true);
  assert.equal(t.v.item(s.doc.id).name, 'contract.pdf');
  assert.ok(same(await plaintextOf(t.v, s.photo.id), s.photoData));
  assert.ok(same(await plaintextOf(t.v, s.doc.id), s.docData));
  assert.deepEqual(await t.v.readNote(s.note.id), { title: 'Secret plan', body: 'step 1' });
  const url = await t.v.thumbUrl(s.photo.id);
  assert.ok(same(new Uint8Array(await resolveObjectURL(url).arrayBuffer()), JPEG));
  assert.equal(t.v.list(s.album.id).cover, s.photo.id);
  t.v.lock('x');
  await t.v.unlock(PASS);
  assert.equal(t.v.items().length, 3);
  // A vault exists now: replace is refused.
  await assert.rejects(t.v.restoreBackup(bytesSource(out), { pass: PASS }, { mode: 'replace' }), isCzd('vault-exists'));
  t.v.lock('x');
  await assert.rejects(t.v.restoreBackup(bytesSource(out), { pass: PASS }, { mode: 'replace' }), isCzd('vault-exists'));
});

test('replace with the recovery code (keeps the passphrase) and with code + newPass (sets a new one)', async () => {
  const s = await sourceVault();
  const { out } = await backupBytes(s.v);
  const t1 = await makeVault();
  await t1.v.restoreBackup(bytesSource(out), { code: s.code.toLowerCase() }, { mode: 'replace' });
  assert.equal(t1.v.status, 'unlocked');
  t1.v.lock('x');
  await t1.v.unlock(PASS);
  const t2 = await makeVault();
  await t2.v.restoreBackup(bytesSource(out), { code: s.code, newPass: 'brand new passphrase' }, { mode: 'replace' });
  t2.v.lock('x');
  await assert.rejects(t2.v.unlock(PASS), isCzd('wrong-passphrase'));
  await t2.v.unlock('brand new passphrase');
  assert.equal(t2.v.items().length, 3);
  t2.v.lock('x');
  await t2.v.unlockWithRecovery(s.code, 'third passphrase here');
});

test('replace: wrong passphrase / wrong or missing code / no secret → nothing written', async () => {
  const s = await sourceVault();
  const { out } = await backupBytes(s.v);
  const t = await makeVault();
  await assert.rejects(t.v.restoreBackup(bytesSource(out), { pass: 'wrong wrong wrong' }, { mode: 'replace' }), isCzd('wrong-passphrase'));
  await assert.rejects(t.v.restoreBackup(bytesSource(out), { code: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA' }, { mode: 'replace' }), isCzd('recovery-wrong'));
  await assert.rejects(t.v.restoreBackup(bytesSource(out), { code: 'short' }, { mode: 'replace' }), isCzd('recovery-wrong'));
  await assert.rejects(t.v.restoreBackup(bytesSource(out), {}, { mode: 'replace' }), TypeError);
  await assert.rejects(t.v.restoreBackup(bytesSource(out), { pass: PASS }, { mode: 'other' }), TypeError);
  await assertEmpty(t.v, t.store, t.db);
  const u = await unlockedVault({ recovery: false });
  const { out: noRec } = await backupBytes(u.v);
  assert.equal((await readBackupHeader(bytesSource(noRec))).rwrap, null);
  await assert.rejects(t.v.restoreBackup(bytesSource(noRec), { code: s.code }, { mode: 'replace' }), isCzd('recovery-wrong'));
  await assertEmpty(t.v, t.store, t.db);
});

test('merge into the same vault: no secret needed, existing ids skipped, deleted items come back with their ids', async () => {
  const s = await sourceVault();
  const { out } = await backupBytes(s.v);
  assert.equal((await s.v.inspectBackup(bytesSource(out))).sameVault, true);
  await s.v.remove([s.photo.id, s.note.id]);
  const extra = await s.v.addFile(file(new Uint8Array(9), 'new.bin'));
  const r = await s.v.restoreBackup(bytesSource(out), null, { mode: 'merge' });
  assert.deepEqual(r, { added: 2, skipped: 1 });
  assert.deepEqual(s.v.items().map((i) => i.id).sort(), [s.photo.id, s.doc.id, s.note.id, extra.id].sort());
  assert.ok(same(await plaintextOf(s.v, s.photo.id), s.photoData));
  assert.equal(s.v.item(s.photo.id).hasThumb, true);
  assert.ok(await s.v.thumbUrl(s.photo.id));
  assert.equal(s.v.lists().length, 1, 'the existing album is not duplicated');
  assert.deepEqual(await s.v.restoreBackup(bytesSource(out), null, { mode: 'merge' }), { added: 0, skipped: 3 });
  s.v.lock('x');
  await assert.rejects(s.v.restoreBackup(bytesSource(out), null, { mode: 'merge' }), isCzd('vault-locked'));
});

test('merge another vault: re-encrypted under new ids, albums remapped, thumbnails re-keyed, repeat merges skip', async () => {
  const s = await sourceVault();
  const { out } = await backupBytes(s.v);
  const c = await unlockedVault({ pass: 'the other vault pass' });
  const mine = await c.v.addFile(file(new Uint8Array(4), 'mine.bin'));
  assert.equal((await c.v.inspectBackup(bytesSource(out))).sameVault, false);
  await assert.rejects(c.v.restoreBackup(bytesSource(out), { pass: 'the other vault pass' }, { mode: 'merge' }), isCzd('wrong-passphrase'));
  await assert.rejects(c.v.restoreBackup(bytesSource(out), null, { mode: 'merge' }), TypeError);
  const r = await c.v.restoreBackup(bytesSource(out), { pass: PASS }, { mode: 'merge' });
  assert.deepEqual(r, { added: 3, skipped: 0 });
  const items = c.v.items();
  assert.equal(items.length, 4);
  const byName = new Map(items.map((i) => [i.name, i]));
  for (const old of [s.photo, s.doc, s.note]) assert.ok(!items.some((i) => i.id === old.id), 'new ids');
  const photo = byName.get('photo.png');
  assert.equal(photo.fav, true);
  assert.equal(photo.hasThumb, true);
  assert.ok(same(await plaintextOf(c.v, photo.id), s.photoData));
  assert.ok(same(await plaintextOf(c.v, byName.get('contract.pdf').id), s.docData));
  assert.deepEqual(await c.v.readNote(byName.get('Secret plan').id), { title: 'Secret plan', body: 'step 1' });
  assert.ok(same(new Uint8Array(await resolveObjectURL(await c.v.thumbUrl(photo.id)).arrayBuffer()), JPEG));
  const [album] = c.v.lists();
  assert.notEqual(album.id, s.album.id);
  assert.equal(album.name, 'Best');
  assert.deepEqual(album.itemIds, [photo.id, byName.get('Secret plan').id]);
  assert.equal(album.cover, photo.id);
  // Idempotent: the passphrase, then the recovery code of the same backup.
  assert.deepEqual(await c.v.restoreBackup(bytesSource(out), { pass: PASS }, { mode: 'merge' }), { added: 0, skipped: 3 });
  assert.deepEqual(await c.v.restoreBackup(bytesSource(out), { code: s.code }, { mode: 'merge' }), { added: 0, skipped: 3 });
  assert.equal(c.v.items().length, 4);
  assert.equal(c.v.lists().length, 1);
  assert.ok(c.v.item(mine.id));
  c.v.lock('x');
  await c.v.unlock('the other vault pass');
  assert.equal(c.v.items().length, 4);
});

test('readBackupHeader: bounds before allocation, truncation, trailing data, versions, KDF parameters', async () => {
  const u = await unlockedVault({ recovery: false });
  await u.v.addFile(file(new Uint8Array(10), 'a.bin'));
  await u.v.createList({ name: 'L' });
  const { out } = await backupBytes(u.v);
  const hdr = await readBackupHeader(bytesSource(out));
  const COUNT = hdr.prefixLen - 32 - hdr.count * 93 - 4; // offset of count (no recovery wrap)
  const E0 = COUNT + 4; // first entry
  const bad = async (src, code) => assert.rejects(readBackupHeader(src), isCzd(code), code);
  await bad(bytesSource(new Uint8Array(0)), 'not-czb');
  await bad(bytesSource(out.slice(0, 5)), 'not-czb');
  await bad(mutate(out, (c) => (c[1] = 0x41)), 'not-czb');
  await bad(bytesSource(out.slice(0, 9)), 'czb-truncated');
  await bad(bytesSource(out.slice(0, 60)), 'czb-truncated');
  await bad(mutate(out, (c) => (c[8] = 2)), 'czb-version');
  await bad(mutate(out, (c) => (c[9] = 1)), 'czb-version');
  await bad(mutate(out, (c) => (c[26] = 2)), 'unsupported-kdf');
  await bad(mutate(out, (c) => c.set(u32(2 ** 31), 27)), 'kdf-params-out-of-range');
  await bad(mutate(out, (c) => (c[112] = 2)), 'not-czb');
  await bad(mutate(out, (c) => (c[113] = 2)), 'not-czb');
  await bad(mutate(out, (c) => (c[114] = 0xff)), 'not-czb'); // createdAt above 2^53
  await bad(mutate(out, (c) => c.set(u32(2_000_001), COUNT)), 'not-czb');
  await bad(mutate(out, (c) => c.set(u32(1_999_999), COUNT)), 'czb-truncated'); // checked before reading 186 MB
  await bad(mutate(out, (c) => (c[E0] = 9)), 'not-czb');
  await bad(mutate(out, (c) => c.set(u32(0), E0 + 57)), 'not-czb'); // recLen
  await bad(mutate(out, (c) => c.set(u32(2 ** 20 + 1), E0 + 57)), 'not-czb');
  await bad(mutate(out, (c) => (c[E0 + 17] = 0xff)), 'not-czb'); // containerLen ≥ 2^53
  await bad(mutate(out, (c) => c.set(u32(10), E0 + 21)), 'not-czb'); // container too small
  const listEntry = E0 + 93 * hdr.entries.findIndex((e) => e.kind === 2);
  await bad(mutate(out, (c) => (c[listEntry + 24] = 1)), 'not-czb'); // a list with a container
  await bad(mutate(out, (c) => (c[listEntry + 30] = 1)), 'not-czb'); // a list with a header MAC
  await bad(bytesSource(out.slice(0, out.length - 1)), 'czb-truncated');
  await bad(bytesSource(out.slice(0, hdr.prefixLen - 1)), 'czb-truncated');
  const longer = new Uint8Array(out.length + 1);
  longer.set(out);
  await bad(bytesSource(longer), 'trailing-data');
  // Duplicate entry (same kind and id twice).
  const dup = new Uint8Array(out.length + 93);
  dup.set(out.subarray(0, E0 + 93));
  dup.set(out.subarray(E0, E0 + 93), E0 + 93);
  dup.set(out.subarray(E0 + 93), E0 + 186);
  dup.set(u32(hdr.count + 1), COUNT);
  await bad(bytesSource(dup), 'not-czb');
});

test('tamper with every section → restore refused, nothing written', async () => {
  const s = await sourceVault();
  const { out } = await backupBytes(s.v);
  const hdr = await readBackupHeader(bytesSource(out));
  const E0 = hdr.prefixLen - 32 - hdr.count * 93;
  const item = hdr.entries.find((e) => e.kind === 1 && e.containerLen > 300_000);
  const cases = [
    ['vaultId', (c) => (c[12] ^= 1), 'wrong-passphrase'],
    ['salt', (c) => (c[40] ^= 1), 'wrong-passphrase'],
    ['wrap ct', (c) => (c[80] ^= 1), 'wrong-passphrase'],
    ['createdAt', (c) => (c[hdr.prefixLen - 32 - hdr.count * 93 - 5] ^= 1), 'czb-mac'],
    ['entry id', (c) => (c[E0 + 5] ^= 1), 'czb-mac'],
    ['entry container length', (c) => new DataView(c.buffer).setUint32(E0 + 21, new DataView(c.buffer).getUint32(E0 + 21) + 1), 'czb-truncated'],
    ['entry header MAC', (c) => (c[E0 + 30] ^= 1), 'czb-mac'],
    ['entry hash', (c) => (c[E0 + 70] ^= 1), 'czb-mac'],
    ['entriesMAC', (c) => (c[hdr.prefixLen - 1] ^= 1), 'czb-mac'],
    ['a record', (c) => (c[hdr.recordsOffset + 20] ^= 1), 'czb-mac'],
    ['last record', (c) => (c[hdr.containersOffset - 1] ^= 1), 'czb-mac'],
    ['container stanza', (c) => (c[item.contOff + 50] ^= 1), 'czb-mac'],
    ['container meta', (c) => (c[item.contOff + 200] ^= 1), 'czb-mac'],
  ];
  for (const [what, fn, code] of cases) {
    const t = await makeVault();
    await assert.rejects(t.v.restoreBackup(mutate(out, fn), { pass: PASS }, { mode: 'replace' }), isCzd(code), what);
    await assertEmpty(t.v, t.store, t.db);
  }
  // Payload damage is not visible in the header: replace restores it and the item fails when read…
  const payload = mutate(out, (c) => (c[item.contOff + item.containerLen - 40] ^= 1));
  const t = await makeVault();
  await t.v.restoreBackup(payload, { pass: PASS }, { mode: 'replace' });
  await assert.rejects(plaintextOf(t.v, item.id), isCzd('truncated-or-corrupt'));
  // …while a merge into another vault decrypts every item and refuses it.
  const c = await unlockedVault({ pass: 'merge target pass' });
  await assert.rejects(c.v.restoreBackup(mutate(out, (x) => (x[item.contOff + item.containerLen - 40] ^= 1)), { pass: PASS }, { mode: 'merge' }), isCzd('czb-mac'));
  const stored = (await c.store.list()).map((e) => e.id).sort();
  assert.deepEqual(stored, (await c.db.getAll('items')).map((r) => r.id).sort(), 'the half-written container was deleted');
});

test('replace cleans up when the store or the final commit fails', async () => {
  const s = await sourceVault();
  const { out } = await backupBytes(s.v);
  const t = await makeVault({ store: new MemoryStore({ quota: 5000 }) });
  await assert.rejects(t.v.restoreBackup(bytesSource(out), { pass: PASS }, { mode: 'replace' }), isCzd('quota-exceeded'));
  await assertEmpty(t.v, t.store, t.db);
  let fail = true;
  const u = await makeVault({
    wrapDb: (db) => Object.assign(Object.create(db), {
      async commit(ops, opts) {
        if (fail) throw new Error('commit failed');
        return db.commit(ops, opts);
      },
    }),
  });
  await assert.rejects(u.v.restoreBackup(bytesSource(out), { pass: PASS }, { mode: 'replace' }), isCzd('internal'));
  fail = false;
  await assertEmpty(u.v, u.store, u.db);
  assert.equal(state.get('busy'), 0);
  await u.v.restoreBackup(bytesSource(out), { pass: PASS }, { mode: 'replace' });
  assert.equal(u.v.items().length, 3);
});

test('export: a missing container is skipped (and reported); the rest restores', async () => {
  const s = await sourceVault();
  s.store.items.delete(s.doc.id);
  const b = await backupBytes(s.v);
  assert.equal(b.skipped, 1);
  const t = await makeVault();
  assert.deepEqual(await t.v.restoreBackup(b.src, { pass: PASS }, { mode: 'replace' }), { added: 2, skipped: 0 });
});

test('export: a record changed between planning and streaming → vault-changed; locked → vault-locked; lock mid-stream → interrupted', async () => {
  const s = await sourceVault();
  const b1 = await s.v.exportBackup();
  await s.v.rename(s.doc.id, 'changed.pdf');
  await assert.rejects(collectBytes(b1.stream), isCzd('vault-changed'));
  assert.equal(s.v.lastBackupAt, null);
  const b2 = await s.v.exportBackup();
  const it = b2.stream[Symbol.asyncIterator]();
  await it.next();
  s.v.lock('user');
  await assert.rejects((async () => {
    for (;;) if ((await it.next()).done) break;
  })(), isCzd('interrupted'));
  await assert.rejects(s.v.exportBackup(), isCzd('vault-locked'));
  assert.equal(state.get('busy'), 0);
});
