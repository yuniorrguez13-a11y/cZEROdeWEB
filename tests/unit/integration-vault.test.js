// Vault details settled in the integration phase: thumbnail URLs are reference-counted per item (the grid, the album
// strip, the album editor and the picker can show the same thumbnail; one view letting go must not revoke it under
// the others), and a backup counts as made only when the caller confirms it (exportBackup({markDone:false}) +
// markBackedUp): a staged backup the user never saved must not silence the backup reminder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import { readBackupHeader } from '../../app/vault/backup.js';
import { bytesSource } from '../../app/util/stream.js';
import { collectBytes, file, unlockedVault } from './vault-helpers.js';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const thumbnailer = async () => ({ jpeg: JPEG, w: 2, h: 1 });
const alive = (url) => Boolean(resolveObjectURL(url));

test('thumbUrl/releaseThumb: one reference per handed-out URL; revoked when the last one goes, and on lock', async () => {
  const { v } = await unlockedVault({ thumbnailer });
  const a = await v.addFile(file(new Uint8Array(10), 'p.png', 'image/png'));
  const [u1, u2] = await Promise.all([v.thumbUrl(a.id), v.thumbUrl(a.id)]); // grid card + album cover, same decrypt
  assert.equal(u1, u2);
  const u3 = await v.thumbUrl(a.id); // album picker
  assert.equal(u3, u1);
  v.releaseThumb(a.id);
  assert.ok(alive(u1), 'two views still show it');
  v.releaseThumb(a.id);
  assert.ok(alive(u1), 'one view still shows it');
  v.releaseThumb(a.id);
  assert.ok(!alive(u1), 'revoked with the last reference');
  v.releaseThumb(a.id); // over-release: no-op
  v.releaseThumb('f'.repeat(32));

  const u4 = await v.thumbUrl(a.id);
  assert.notEqual(u4, u1, 'a fresh URL after the last release');
  await v.thumbUrl(a.id);
  v.lock('user');
  assert.ok(!alive(u4), 'lock revokes whatever the references');
  v.releaseThumb(a.id); // no throw while locked
});

test('thumbUrl: an item without a thumbnail resolves null and takes no reference; removal revokes', async () => {
  const { v } = await unlockedVault({ thumbnailer: async (f, type) => (type.startsWith('image/') ? { jpeg: JPEG, w: 2, h: 1 } : null) });
  const doc = await v.addFile(file(new Uint8Array(10), 'd.pdf', 'application/pdf'));
  assert.equal(await v.thumbUrl(doc.id), null);
  const p = await v.addFile(file(new Uint8Array(10), 'p.png', 'image/png'));
  const u = await v.thumbUrl(p.id);
  await v.thumbUrl(p.id);
  await v.remove([p.id]);
  assert.ok(!alive(u), 'removing the item revokes its thumbnail');
});

test('exportBackup({markDone:false}) leaves lastBackupAt alone until markBackedUp(createdAt)', async () => {
  const { v } = await unlockedVault({ thumbnailer });
  await v.addFile(file(new Uint8Array(100), 'p.png', 'image/png'));
  const metas = [];
  v.addEventListener('meta', () => metas.push(v.lastBackupAt));
  const b = await v.exportBackup({ markDone: false });
  const out = await collectBytes(b.stream);
  assert.equal(out.length, b.size);
  const hdr = await readBackupHeader(bytesSource(out));
  assert.equal(b.createdAt, hdr.createdAt);
  assert.equal(v.lastBackupAt, null, 'a finished stream alone does not count (a staged file may be discarded)');
  assert.deepEqual(metas, []);
  await v.markBackedUp(b.createdAt);
  assert.equal(v.lastBackupAt, hdr.createdAt);
  assert.deepEqual(metas, [hdr.createdAt]);
  await v.markBackedUp(-1); // ignored
  assert.equal(v.lastBackupAt, hdr.createdAt);
  // The default (markDone true) still records it when the stream completes.
  const b2 = await v.exportBackup();
  await collectBytes(b2.stream);
  assert.equal(v.lastBackupAt, b2.createdAt);
  // And it survives a lock (meta is not secret).
  v.lock('user');
  assert.equal(v.lastBackupAt, b2.createdAt);
});
