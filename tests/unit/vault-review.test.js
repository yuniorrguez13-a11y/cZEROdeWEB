// Review regressions for app/vault/vault.js: concurrent unlocks, writes started by 'locking' listeners when the lock
// comes from a lost tab lock, lock() re-entrancy, and per-card thumbnail URL release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import * as state from '../../app/state.js';
import { PASS, file, isCzd, unlockedVault } from './vault-helpers.js';

test('two overlapping unlock() calls: work started after the first one finished is not lost by the second', async () => {
  const { v } = await unlockedVault();
  await v.addNote({ title: 'one', body: 'x' });
  v.lock('user');
  let adding = null;
  v.addEventListener('status', (e) => {
    if (e.detail.status === 'unlocked' && !adding) adding = v.addNote({ title: 'two', body: 'y' });
  });
  await Promise.all([v.unlock(PASS), v.unlock(PASS)]);
  const added = await adding;
  assert.ok(v.items().some((i) => i.id === added.id), 'the note added between the two unlocks is visible');
  assert.equal(v.items().length, 2);
});

test('a dirty note saved from a locking listener survives a lock caused by losing the tab lock', async () => {
  let holder = true;
  const { v } = await unlockedVault({ isHolder: () => holder });
  const n = await v.addNote({ title: 'Draft', body: 'v1' });
  const del = await v.addNote({ title: 'Delete me', body: '' });
  let pending = null;
  v.addEventListener('locking', () => {
    pending = Promise.all([v.saveNote(n.id, { title: 'Draft', body: 'v2' }), v.remove([del.id])]);
  });
  holder = false; // another tab said "Use it here": the tab lock is gone before the vault locks
  v.lock('remote');
  assert.equal(v.status, 'other-tab');
  const [saved] = await pending;
  // Writes that were not started from a locking listener are still refused.
  await assert.rejects(v.addNote({ title: 'late' }), isCzd('vault-locked'));
  holder = true;
  await v.init();
  await v.unlock(PASS);
  assert.deepEqual(v.items().map((i) => i.id), [saved.id]);
  assert.deepEqual(await v.readNote(saved.id), { title: 'Draft', body: 'v2' });
});

test('lock() called again from a locking listener (or a purge it triggers) emits locking once and does not recurse', async () => {
  const { v } = await unlockedVault();
  const seen = [];
  v.addEventListener('locking', (e) => {
    seen.push(e.detail.reason);
    v.lock('nested');
  });
  const reasons = [];
  const off = state.onPurge((r) => reasons.push(r));
  try {
    v.lock('user');
  } finally {
    off();
  }
  assert.deepEqual(seen, ['user']);
  assert.equal(v.status, 'locked');
  assert.deepEqual(reasons, ['user']);
});

test('releaseThumb(id) revokes one card\'s thumbnail URL; the next thumbUrl(id) makes a fresh one', async () => {
  const { v } = await unlockedVault({ thumbnailer: async () => ({ jpeg: new Uint8Array([0xff, 0xd8, 1, 2]), w: 4, h: 3 }) });
  const a = await v.addFile(file(new Uint8Array(10), 'p.png', 'image/png'));
  const u1 = await v.thumbUrl(a.id);
  assert.ok(resolveObjectURL(u1));
  v.releaseThumb(a.id);
  assert.equal(resolveObjectURL(u1), undefined, 'revoked');
  const u2 = await v.thumbUrl(a.id);
  assert.notEqual(u2, u1);
  assert.ok(resolveObjectURL(u2));
  v.releaseThumb('unknown');
  v.lock('user');
  assert.equal(resolveObjectURL(u2), undefined);
  v.releaseThumb(a.id); // no throw while locked
});

test('a file whose MIME type claims to be a czd bundle is stored as an ordinary file (not refused as bad-meta)', async () => {
  const { v } = await unlockedVault();
  const a = await v.addFile(file(new Uint8Array([1, 2, 3]), 'weird.bin', 'application/x-czd-bundle'));
  assert.equal(a.type, 'application/octet-stream');
  const b = await v.addStream({ name: 'clip.mp4', type: 'Application/X-CZD-Bundle', size: 2 }, [new Uint8Array([7, 8])]);
  assert.equal(b.type, 'video/mp4', 'the extension decides, like for a missing type');
  const { src, opened } = await v.open(b.id);
  assert.equal(opened.isBundle, false);
  v.lock('user');
  assert.equal(src.size > 0, true);
});

test('an imported file can not pose as a vault note (binary content survives Send byte for byte)', async () => {
  const { makePassKek, openSource, decryptSource } = await import('../../app/crypto/container.js');
  const { collectBytes } = await import('./vault-helpers.js');
  const { v } = await unlockedVault();
  const data = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]); // not UTF-8
  const a = await v.addStream({ name: 'blob.bin', type: 'application/x-czd-note', size: data.length }, [data]);
  assert.notEqual(a.kind, 'note');
  const b = await v.addFile(file(data, 'x.dat', 'application/x-czd-note'));
  assert.notEqual(b.kind, 'note');
  const kek = await makePassKek('send pass phrase', { m: 64, t: 1, p: 1 });
  const [out] = await v.exportCzd([a.id], kek, {});
  const bytes = await collectBytes(out.stream);
  const { bytesSource } = await import('../../app/util/stream.js');
  const src = bytesSource(bytes);
  const opened = await openSource(src, { passphrase: 'send pass phrase' });
  assert.deepEqual([...await collectBytes(decryptSource(src, opened))], [...data]);
  // Real notes keep their type.
  const n = await v.addNote({ title: 'real', body: 'note' });
  assert.equal(n.kind, 'note');
});
