// app/platform.js in Tauri mode, against an in-memory window.__TAURI__ (tests/unit/platform-fakes.js):
// save targets (dialog file / folder, 8 MiB append batches, createNew + " (2)" names, provisional cleanup),
// tauriFs wrappers, legacy desktop .czd, files opened with the app, and the opener allowlist.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeTauri, chunks, pattern, concatBytes } from './platform-fakes.js';
import * as state from '../../app/state.js';
import { RELEASES_URL } from '../../app/config.js';

const fake = fakeTauri();
// A separate module instance: isTauri is decided at import time.
const P = await import('../../app/platform.js?tauri-mode');
const MiB = 2 ** 20;
const OUT = '/home/bob/Downloads';

beforeEach(() => {
  fake.files.clear();
  fake.calls.length = 0;
  fake.dialogCalls.length = 0;
  fake.dirs.add(OUT);
  fake.saveAnswer = null;
  fake.openAnswer = null;
  fake.failWrite = () => false;
  fake.pending.length = 0;
  fake.opened.length = 0;
});

const writes = (path) => fake.calls.filter((c) => c[0] === 'writeFile' && c[1] === path);

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code} (${e.message})`);
    return true;
  });
}

test('isTauri and caps under Tauri', () => {
  assert.equal(P.isTauri, true);
  assert.equal(P.caps.savePicker(), true);
  assert.equal(P.caps.dirPicker(), true);
  assert.equal(P.caps.sw(), false);
});

test('one output: dialog.save with a sanitized default name, 8 MiB batches (create, then append)', async () => {
  fake.saveAnswer = `${OUT}/out.czd`;
  const pending = [];
  const off = state.on('picker.pending', (v) => pending.push(v));
  const target = await P.chooseSaveTarget({ name: 'a/b:c.czd', mime: 'application/x-czeroode' });
  off();
  assert.deepEqual(pending, [true, false], 'hidden lock suspended while the dialog was open');
  assert.equal(fake.dialogCalls[0][0], 'save');
  assert.equal(fake.dialogCalls[0][1].defaultPath, 'a_b_c.czd');
  assert.equal(target.kind, 'tauri-file');
  assert.equal(target.count, 1);
  const parts = [pattern(3 * MiB), pattern(7 * MiB, 2), pattern(9 * MiB, 3), pattern(5, 4)];
  const res = await target.write('ignored.czd', chunks(parts), { size: 19 * MiB + 5 });
  assert.deepEqual(res, { name: 'out.czd', where: `${OUT}/out.czd` });
  assert.deepEqual(fake.files.get(`${OUT}/out.czd`), concatBytes(parts));
  const w = writes(`${OUT}/out.czd`);
  assert.deepEqual(w.map((c) => [c[2], c[3]]), [[8 * MiB, null], [8 * MiB, { append: true }], [3 * MiB + 5, { append: true }]]);
  await rejectsCode(target.write('again', chunks([pattern(1)])), 'internal');
});

test('one output: a Blob source and an empty source', async () => {
  fake.saveAnswer = `${OUT}/b.bin`;
  let target = await P.chooseSaveTarget({ name: 'b.bin' });
  await target.write('b.bin', new Blob([pattern(1000)]));
  assert.deepEqual(fake.files.get(`${OUT}/b.bin`), pattern(1000));
  fake.saveAnswer = `${OUT}/empty.bin`;
  target = await P.chooseSaveTarget({ name: 'empty.bin' });
  await target.write('empty.bin', chunks([]));
  assert.deepEqual(fake.files.get(`${OUT}/empty.bin`), new Uint8Array(0));
});

test('cancelled dialogs resolve null', async () => {
  assert.equal(await P.chooseSaveTarget({ name: 'x.czd' }), null);
  assert.equal(await P.chooseSaveTarget({ name: 'x', count: 3 }), null);
  assert.deepEqual(fake.dialogCalls.map((c) => c[0]), ['save', 'open']);
  assert.deepEqual(fake.dialogCalls[1][1], { directory: true, multiple: false, recursive: false });
});

test('one output: a failing source removes the provisional file (truncate, then remove)', async () => {
  fake.saveAnswer = `${OUT}/secret.jpg`;
  const target = await P.chooseSaveTarget({ name: 'secret.jpg' });
  await assert.rejects(target.write('secret.jpg', chunks([pattern(9 * MiB), pattern(9 * MiB)], { failAfter: 1 })));
  assert.equal(fake.files.has(`${OUT}/secret.jpg`), false);
  const order = fake.calls.filter((c) => c[1] === `${OUT}/secret.jpg` && (c[0] === 'truncate' || c[0] === 'remove')).map((c) => c[0]);
  assert.deepEqual(order, ['truncate', 'remove']);
});

test('several outputs: folder dialog, direct children, " (2)" names for existing files and repeats', async () => {
  fake.openAnswer = OUT;
  fake.files.set(`${OUT}/a.txt`, pattern(3));
  const target = await P.chooseSaveTarget({ name: 'ignored', count: 3 });
  assert.equal(target.kind, 'tauri-dir');
  assert.equal(target.count, 3);
  const r1 = await target.write('a.txt', chunks([pattern(10, 1)]));
  const r2 = await target.write('a.txt', chunks([pattern(10, 2)]));
  const r3 = await target.write('..\\evil/name?.txt', chunks([pattern(10, 3)]));
  assert.deepEqual([r1, r2, r3].map((r) => r.name), ['a (2).txt', 'a (3).txt', '_evil_name_.txt']);
  assert.equal(r1.where, OUT);
  assert.deepEqual(fake.files.get(`${OUT}/a.txt`), pattern(3), 'the existing file is untouched');
  assert.deepEqual(fake.files.get(`${OUT}/a (2).txt`), pattern(10, 1));
  assert.deepEqual(fake.files.get(`${OUT}/a (3).txt`), pattern(10, 2));
  for (const c of fake.calls.filter((x) => x[0] === 'writeFile' && !x[3]?.append)) assert.deepEqual(c[3], { createNew: true });
});

test('several outputs: createNew never overwrites a file that appears after the existence check', async () => {
  fake.openAnswer = OUT;
  const target = await P.chooseSaveTarget({ name: 'x', count: 2 });
  fake.failWrite = (path, { opts }) => {
    if (path === `${OUT}/race.txt` && opts?.createNew) fake.files.set(path, pattern(4, 9)); // appears just before the create
    return false;
  };
  await assert.rejects(target.write('race.txt', chunks([pattern(10)])));
  assert.deepEqual(fake.files.get(`${OUT}/race.txt`), pattern(4, 9), 'the other file is kept');
});

test('several outputs: a failed write removes only its partial file; abort() removes every output', async () => {
  fake.openAnswer = OUT;
  const target = await P.chooseSaveTarget({ name: 'x', count: 3 });
  await target.write('one.bin', chunks([pattern(100)]));
  await assert.rejects(target.write('two.bin', chunks([pattern(9 * MiB), pattern(9 * MiB)], { failAfter: 1 })));
  assert.equal(fake.files.has(`${OUT}/two.bin`), false);
  assert.equal(fake.files.has(`${OUT}/one.bin`), true);
  await target.abort();
  assert.equal(fake.files.has(`${OUT}/one.bin`), false);
  await rejectsCode(target.write('three.bin', chunks([pattern(1)])), 'aborted');
});

test('abort() during a write stops it and removes the partial file; a caller signal works too', async () => {
  fake.openAnswer = OUT;
  const target = await P.chooseSaveTarget({ name: 'x', count: 2 });
  let release;
  const gate = new Promise((r) => (release = r));
  async function* slow() {
    yield pattern(9 * MiB);
    await gate;
    yield pattern(9 * MiB);
  }
  const p = target.write('big.bin', slow());
  await new Promise((r) => setTimeout(r, 10));
  const aborting = target.abort();
  release();
  await rejectsCode(p, 'aborted');
  await aborting;
  assert.equal(fake.files.has(`${OUT}/big.bin`), false);

  fake.saveAnswer = `${OUT}/c.bin`;
  const t2 = await P.chooseSaveTarget({ name: 'c.bin' });
  const ac = new AbortController();
  ac.abort();
  await rejectsCode(t2.write('c.bin', chunks([pattern(10)]), { signal: ac.signal }), 'aborted');
  assert.equal(fake.files.has(`${OUT}/c.bin`), false);
});

test('tauriFs: readAt (open + seek + read, short reads), truncated past EOF, writeStream, list, rename', async () => {
  const p = `${fake.appData}/vault2/items/x.czd`;
  fake.dirs.add(`${fake.appData}/vault2`);
  fake.dirs.add(`${fake.appData}/vault2/items`);
  const data = pattern(12 * MiB + 7);
  const n = await P.tauriFs.writeStream(p, chunks([data.subarray(0, 5 * MiB), data.subarray(5 * MiB)]));
  assert.equal(n, data.length);
  assert.deepEqual(fake.files.get(p), data);
  assert.deepEqual(await P.tauriFs.readAt(p, 0, 16), data.subarray(0, 16));
  assert.deepEqual(await P.tauriFs.readAt(p, 6 * MiB - 3, 6 * MiB), data.subarray(6 * MiB - 3, 12 * MiB - 3));
  assert.deepEqual(await P.tauriFs.readAt(p, data.length, 0), new Uint8Array(0));
  await rejectsCode(P.tauriFs.readAt(p, data.length - 2, 3), 'truncated');
  assert.ok(fake.calls.filter((c) => c[0] === 'open').length === fake.calls.filter((c) => c[0] === 'close').length, 'every handle closed');

  const listed = await P.tauriFs.list(`${fake.appData}/vault2/items`);
  assert.deepEqual(listed, [{ name: 'x.czd', path: p, isFile: true, isDirectory: false, size: data.length, mtime: 1700000000000 }]);
  await P.tauriFs.rename(p, `${p}.moved`);
  assert.equal(await P.tauriFs.exists(p), false);
  assert.equal(await P.tauriFs.exists(`${p}.moved`), true);
  await P.tauriFs.remove(`${p}.moved`);
  assert.equal(fake.files.size, 0);
  await P.tauriFs.mkdir(`${fake.appData}/vault2/tmp`);
  assert.deepEqual(fake.calls.at(-1), ['mkdir', `${fake.appData}/vault2/tmp`, { recursive: true }]);
  assert.equal(await P.tauriFs.appDataDir(), fake.appData);
});

test('tauriFs.writeStream removes the file when the source fails', async () => {
  const p = `${fake.appData}/x.part`;
  await assert.rejects(P.tauriFs.writeStream(p, chunks([pattern(9 * MiB), pattern(1)], { failAfter: 1 })));
  assert.equal(fake.files.has(p), false);
});

test('legacy desktop .czd: lists $APPDATA/vault/*.czd only, reads them as text; [] without the folder', async () => {
  assert.deepEqual(await P.listLegacyDesktopCzd(), []);
  const dir = `${fake.appData}/vault`;
  fake.dirs.add(dir);
  fake.dirs.add(`${dir}/sub.czd`);
  const text = '{"v":1,"type":"image","cipher":"ზЕე"}';
  fake.files.set(`${dir}/red-dot.czd`, new TextEncoder().encode(text));
  fake.files.set(`${dir}/B.CZD`, pattern(5));
  fake.files.set(`${dir}/notes.txt`, pattern(5));
  const list = await P.listLegacyDesktopCzd();
  assert.deepEqual(list, [
    { name: 'B.CZD', path: `${dir}/B.CZD`, size: 5 },
    { name: 'red-dot.czd', path: `${dir}/red-dot.czd`, size: new TextEncoder().encode(text).length },
  ]);
  assert.equal(await P.readLegacyDesktopCzd(`${dir}/red-dot.czd`), text);
});

test('onOpenFiles: listens for open-files, drains take_open_files once listening and on every event', async () => {
  fake.files.set('/home/bob/a.czd', pattern(10 * MiB + 1));
  fake.files.set('/home/bob/b.czb', pattern(3));
  fake.pending.push('/home/bob/a.czd');
  const got = [];
  const off = P.onOpenFiles((files) => got.push(files));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fake.listenerCount('open-files'), 1);
  assert.equal(got.length, 1);
  assert.equal(got[0][0].name, 'a.czd');
  assert.equal(got[0][0].size, 10 * MiB + 1);
  assert.deepEqual(new Uint8Array(await got[0][0].arrayBuffer()), pattern(10 * MiB + 1));
  assert.equal(got[0][0].lastModified, 1700000000000);

  fake.pending.push('/home/bob/b.czb', '/home/bob/missing.czd');
  fake.emit('open-files', ['/home/bob/b.czb', '/home/bob/missing.czd']);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(got.length, 2);
  assert.deepEqual(got[1].map((f) => f.name), ['b.czb'], 'unreadable paths are skipped');

  fake.emit('open-files', []); // nothing queued: no callback
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(got.length, 2);

  off();
  assert.equal(fake.listenerCount('open-files'), 0);
  fake.pending.push('/home/bob/b.czb');
  fake.emit('open-files', ['/home/bob/b.czb']);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(got.length, 2);
});

test('openExternal: only the releases page through the opener', async () => {
  assert.equal(await P.openExternal(RELEASES_URL), true);
  assert.deepEqual(fake.opened, [RELEASES_URL]);
  await rejectsCode(P.openExternal('https://example.com/'), 'internal');
  await rejectsCode(P.openExternal(`${RELEASES_URL}/../evil`), 'internal');
  assert.deepEqual(fake.opened, [RELEASES_URL]);
});

test('czstream helpers stay stubs for G', async () => {
  await rejectsCode(P.tauriStreamRegister({}), 'not-implemented');
});

// ───────── review additions (C2 adversarial review)

test('one output: a source that fails before the first write leaves an existing file alone', async () => {
  const p = `${OUT}/keep.czd`;
  fake.files.set(p, pattern(64, 7));
  fake.saveAnswer = p; // the user confirmed "replace" in the dialog
  const target = await P.chooseSaveTarget({ name: 'keep.czd' });
  await assert.rejects(target.write('keep.czd', chunks([pattern(10)], { failAfter: 0 })));
  assert.deepEqual(fake.files.get(p), pattern(64, 7), 'nothing was written, so nothing is removed');
  assert.deepEqual(fake.calls.filter((c) => c[1] === p).map((c) => c[0]), [], 'no truncate/remove of the untouched file');
});

test('disk full (Tauri string errors) maps to quota-exceeded; other Tauri errors are CzdError internal with the cause', async () => {
  fake.openAnswer = OUT;
  const target = await P.chooseSaveTarget({ name: 'x', count: 2 });
  fake.failWrite = (path, { opts }) => (opts?.append ? 'failed to write file: No space left on device (os error 28)' : false);
  await rejectsCode(target.write('big.bin', chunks([pattern(9 * MiB), pattern(9 * MiB)])), 'quota-exceeded');
  assert.equal(fake.files.has(`${OUT}/big.bin`), false, 'partial output removed');
  fake.failWrite = () => 'There is not enough space on the disk. (os error 112)';
  await rejectsCode(P.tauriFs.writeStream(`${OUT}/w.bin`, chunks([pattern(3)])), 'quota-exceeded');
  fake.failWrite = () => 'forbidden path: /etc/passwd';
  await assert.rejects(P.tauriFs.writeStream(`${OUT}/w.bin`, chunks([pattern(3)])), (e) => {
    assert.equal(e.name, 'CzdError');
    assert.equal(e.code, 'internal');
    assert.equal(e.cause, 'forbidden path: /etc/passwd');
    return true;
  });
});

test('tauriFs wrappers and the legacy reader reject with CzdError only', async () => {
  const isCzd = (code) => (e) => {
    assert.equal(e.name, 'CzdError', `CzdError, got ${e && e.name} ${e}`);
    if (code) assert.equal(e.code, code);
    return true;
  };
  await assert.rejects(P.tauriFs.readAt('/nope.czd', -1, 4), isCzd('internal'));
  await assert.rejects(P.tauriFs.readAt('/nope.czd', 0, 2 ** 60), isCzd('internal'));
  await assert.rejects(P.tauriFs.readAt('/nope.czd', 0, 4), isCzd('internal'));
  await assert.rejects(P.tauriFs.remove('/nope.czd'), isCzd('internal'));
  await assert.rejects(P.tauriFs.list('/no/such/dir'), isCzd('internal'));
  await assert.rejects(P.readLegacyDesktopCzd('/nope.czd'), isCzd('internal'));
});

test('onOpenFiles: several subscribers all get each batch; the listener goes away with the last off()', async () => {
  fake.files.set('/home/bob/a.czd', pattern(5));
  fake.files.set('/home/bob/b.czd', pattern(6));
  const a = [];
  const b = [];
  const offA = P.onOpenFiles((files) => a.push(files.map((f) => f.name)));
  const offB = P.onOpenFiles((files) => b.push(files.map((f) => f.name)));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fake.listenerCount('open-files'), 1, 'one Tauri listener for all subscribers');
  fake.pending.push('/home/bob/a.czd');
  fake.emit('open-files', ['/home/bob/a.czd']);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(a, [['a.czd']]);
  assert.deepEqual(b, [['a.czd']], 'the second subscriber is not starved by the first one draining the queue');
  offA();
  fake.pending.push('/home/bob/b.czd');
  fake.emit('open-files', ['/home/bob/b.czd']);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(a, [['a.czd']]);
  assert.deepEqual(b, [['a.czd'], ['b.czd']]);
  offB();
  assert.equal(fake.listenerCount('open-files'), 0);
  fake.pending.push('/home/bob/a.czd');
  const c = [];
  const offC = P.onOpenFiles((files) => c.push(files.map((f) => f.name)));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(c, [['a.czd']], 'paths queued while nobody listened are drained by the next subscriber');
  offC();
});
