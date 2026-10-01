// app/platform.js in web mode (Node, no DOM; browser APIs faked where needed): capabilities, storage wrappers,
// hidden-lock suspension, the 'stage' save target (stager or in-memory Blob up to the cap), sharing,
// launchQueue, openExternal. FS Access pickers are covered by tests/browser/platform.test.js.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../app/platform.js';
import * as state from '../../app/state.js';
import { CAPS } from '../../app/config.js';
import { chunks, pattern, concatBytes } from './platform-fakes.js';

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const restore = [];
function setGlobal(name, value) {
  const before = Object.getOwnPropertyDescriptor(globalThis, name);
  restore.push(() => (before ? Object.defineProperty(globalThis, name, before) : delete globalThis[name]));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
afterEach(() => {
  while (restore.length) restore.pop()();
  P.setStager(null);
});

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code} (${e.message})`);
    return true;
  });
}

test('web mode in Node: no Tauri, no pickers, no SW, not mobile, no share', () => {
  assert.equal(P.isTauri, false);
  assert.equal(P.caps.savePicker(), false);
  assert.equal(P.caps.dirPicker(), false);
  assert.equal(P.caps.sw(), false);
  assert.equal(P.caps.mobile(), false);
  assert.equal(P.caps.share([new File(['x'], 'x.txt')]), false);
  assert.ok(realNavigator, 'Node 22 has a navigator global');
});

test('caps follow matchMedia and the FS Access globals at call time', () => {
  let coarse = false;
  setGlobal('matchMedia', (q) => ({ matches: q === '(pointer: coarse)' ? coarse : q === '(pointer: fine)' ? !coarse : false }));
  setGlobal('showSaveFilePicker', async () => null);
  setGlobal('showDirectoryPicker', async () => null);
  assert.equal(P.caps.savePicker(), true);
  assert.equal(P.caps.dirPicker(), true);
  assert.equal(P.caps.mobile(), false);
  coarse = true;
  assert.equal(P.caps.savePicker(), false, 'touch devices stage instead');
  assert.equal(P.caps.mobile(), true);
});

test('caps.share uses navigator.canShare and never throws', () => {
  setGlobal('navigator', { share: async () => {}, canShare: (d) => d.files.length === 1 });
  assert.equal(P.caps.share([new File(['a'], 'a')]), true);
  assert.equal(P.caps.share([new File(['a'], 'a'), new File(['b'], 'b')]), false);
  setGlobal('navigator', { share: async () => {}, canShare: () => { throw new TypeError('nope'); } });
  assert.equal(P.caps.share([new File(['a'], 'a')]), false);
});

test('storage wrappers resolve null when missing or throwing, values otherwise', async () => {
  setGlobal('navigator', {});
  assert.equal(await P.storage.estimate(), null);
  assert.equal(await P.storage.persisted(), null);
  assert.equal(await P.storage.persist(), null);
  setGlobal('navigator', { storage: { estimate: async () => ({ usage: 1, quota: 2 }), persisted: async () => false, persist: async () => { throw new Error('denied'); } } });
  assert.deepEqual(await P.storage.estimate(), { usage: 1, quota: 2 });
  assert.equal(await P.storage.persisted(), false);
  assert.equal(await P.storage.persist(), null);
});

test('suspendHiddenLock: picker.pending while any wrapped promise is pending; returns the same promise', async () => {
  const seen = [];
  const off = state.on('picker.pending', (v) => seen.push(v));
  let r1;
  let r2;
  const p1 = new Promise((r) => (r1 = r));
  const p2 = new Promise((_, rej) => (r2 = rej));
  assert.equal(P.suspendHiddenLock(p1), p1);
  P.suspendHiddenLock(p2).catch(() => {});
  assert.equal(P.isPickerPending(), true);
  r1('done');
  await p1;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(P.isPickerPending(), true, 'still one pending');
  r2(new Error('cancel'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(P.isPickerPending(), false);
  assert.equal(state.get('picker.pending'), false);
  assert.deepEqual(seen, [true, false]);
  off();
});

test('pickFiles without a DOM resolves []', async () => {
  assert.deepEqual(await P.pickFiles(), []);
});

test('chooseSaveTarget without pickers returns a stage target: in-memory File with safe name and type', async () => {
  const target = await P.chooseSaveTarget({ name: 'x.czd', count: 2 });
  assert.equal(target.kind, 'stage');
  assert.equal(target.count, 2);
  const parts = [pattern(1000), pattern(5, 2)];
  const r1 = await target.write('../photo<1>.jpg', chunks(parts), { mime: 'image/jpeg' });
  assert.equal(r1.name, '_photo_1_.jpg');
  assert.ok(r1.staged instanceof File);
  assert.equal(r1.staged.name, r1.name);
  assert.equal(r1.staged.type, 'image/jpeg');
  assert.deepEqual(new Uint8Array(await r1.staged.arrayBuffer()), concatBytes(parts));
  const r2 = await target.write('page.html', new Blob(['<b>hi</b>']), { mime: 'text/html' });
  assert.equal(r2.staged.type, 'application/octet-stream', 'MIME types pass safeMediaType');
  assert.equal(await r2.staged.text(), '<b>hi</b>');
});

test('stage target uses the stager when set (and keeps its File when name/type already match)', async () => {
  const calls = [];
  P.setStager(async (name, source, { signal }) => {
    calls.push({ name, signal: signal instanceof AbortSignal });
    const parts = [];
    for await (const c of source) parts.push(c);
    return new File(parts, name, { type: '' });
  });
  const target = await P.chooseSaveTarget({ name: 'cz-abc.czd' });
  // Only cZEROde containers are staged through the store (see the plaintext test below): a czd2 header here.
  const czd = concatBytes([new Uint8Array([0x89, 0x43, 0x5a, 0x44, 0x0d, 0x0a, 0x1a, 0x0a]), pattern(10)]);
  const r = await target.write('cz-abc.czd', chunks([czd]), { mime: 'application/x-czeroode' });
  assert.deepEqual(calls, [{ name: 'cz-abc.czd', signal: true }]);
  assert.equal(r.staged.name, 'cz-abc.czd');
  assert.equal(r.staged.type, 'application/octet-stream');
  assert.deepEqual(new Uint8Array(await r.staged.arrayBuffer()), czd);
  P.setStager(async () => 'not a file');
  await rejectsCode(target.write('y', chunks([czd])), 'internal');
});

test('stage target without a stager stops at the Blob cap (desktop 512 MiB) with quota-exceeded', async () => {
  const target = await P.chooseSaveTarget({ name: 'big.bin' });
  const piece = new Uint8Array(64 * 2 ** 20); // the same buffer repeated: no real memory use
  async function* huge() {
    for (let i = 0; i <= CAPS.blobDesktop / piece.length; i++) yield piece;
  }
  await rejectsCode(target.write('big.bin', huge()), 'quota-exceeded');
});

test('stage target: abort() rejects later writes; a pre-aborted caller signal rejects with aborted', async () => {
  const target = await P.chooseSaveTarget({ name: 'x', count: 3 });
  const ac = new AbortController();
  ac.abort();
  await rejectsCode(target.write('a', chunks([pattern(3)]), { signal: ac.signal }), 'aborted');
  await target.write('b', chunks([pattern(3)]));
  await target.abort();
  await rejectsCode(target.write('c', chunks([pattern(3)])), 'aborted');
});

test('FS Access save picker: AbortError → null, SecurityError → stage, other errors → CzdError', async () => {
  setGlobal('matchMedia', (q) => ({ matches: q === '(pointer: fine)' }));
  let err = Object.assign(new Error('user cancelled'), { name: 'AbortError' });
  setGlobal('showSaveFilePicker', async () => { throw err; });
  assert.equal(await P.chooseSaveTarget({ name: 'a.czd' }), null);
  err = Object.assign(new Error('Must be handling a user gesture'), { name: 'SecurityError' });
  assert.equal((await P.chooseSaveTarget({ name: 'a.czd' })).kind, 'stage');
  err = Object.assign(new Error('boom'), { name: 'TypeError' });
  await rejectsCode(P.chooseSaveTarget({ name: 'a.czd' }), 'internal');
});

test('FS Access picker is opened synchronously (first await rule) with the sanitized suggested name', async () => {
  setGlobal('matchMedia', (q) => ({ matches: q === '(pointer: fine)' }));
  const opened = [];
  setGlobal('showSaveFilePicker', (opts) => {
    opened.push(opts);
    return new Promise(() => {});
  });
  setGlobal('showDirectoryPicker', (opts) => {
    opened.push(opts);
    return new Promise(() => {});
  });
  P.chooseSaveTarget({ name: 'my:file?.czd' });
  P.chooseSaveTarget({ name: 'x', count: 3 });
  assert.deepEqual(opened, [{ suggestedName: 'my_file_.czd', id: 'czeroode-save' }, { mode: 'readwrite', id: 'czeroode-folder' }]);
});

test('shareFiles / shareText: true on success, false when unavailable or cancelled, gesture errors mapped', async () => {
  assert.equal(await P.shareFiles([new File(['a'], 'a')]), false);
  assert.equal(await P.shareText('hi'), false);
  let behaviour = 'ok';
  const shared = [];
  setGlobal('navigator', {
    canShare: () => true,
    share: async (d) => {
      if (behaviour !== 'ok') throw Object.assign(new Error(behaviour), { name: behaviour });
      shared.push(d);
    },
  });
  assert.equal(await P.shareFiles([new File(['a'], 'a.txt')]), true);
  assert.equal(await P.shareText('passphrase words'), true);
  assert.equal(shared[0].files[0].name, 'a.txt');
  assert.deepEqual(shared[1], { text: 'passphrase words' });
  behaviour = 'AbortError';
  assert.equal(await P.shareFiles([new File(['a'], 'a')]), false);
  assert.equal(await P.shareText('x'), false);
  behaviour = 'NotAllowedError';
  await rejectsCode(P.shareFiles([new File(['a'], 'a')]), 'picker-needs-gesture');
  behaviour = 'DataError';
  await rejectsCode(P.shareText('x'), 'share-unavailable');
  assert.equal(await P.shareFiles([]), false);
});

// launchQueue.setConsumer is called once per page (the first onOpenFiles); later subscribers share it.
let consumer = null;
test('onOpenFiles (web): launchQueue consumer turns file handles into Files; off() stops delivery', async () => {
  setGlobal('launchQueue', { setConsumer: (fn) => (consumer = fn) });
  const got = [];
  const off = P.onOpenFiles((files) => got.push(files.map((f) => f.name)));
  assert.equal(typeof consumer, 'function');
  const handle = (name) => ({ kind: 'file', getFile: async () => new File(['x'], name) });
  await consumer({ files: [handle('a.czd'), { kind: 'directory' }, handle('b.czb')] });
  await consumer({ files: [] });
  assert.deepEqual(got, [['a.czd', 'b.czb']]);
  off();
  await consumer({ files: [handle('c.czd')] });
  assert.deepEqual(got, [['a.czd', 'b.czb']]);
});

test('onOpenFiles (web) without launchQueue is a no-op with an off()', () => {
  const off = P.onOpenFiles(() => assert.fail('never'));
  assert.equal(typeof off, 'function');
  off();
});

test('openExternal (web): http(s) only, new tab without opener/referrer', async () => {
  const opened = [];
  setGlobal('window', { open: (...a) => (opened.push(a), null) });
  assert.equal(await P.openExternal('https://github.com/yuniorrguez13-a11y/cZEROdeWEB/releases'), true);
  assert.deepEqual(opened, [['https://github.com/yuniorrguez13-a11y/cZEROdeWEB/releases', '_blank', 'noopener,noreferrer']]);
  await rejectsCode(P.openExternal('javascript:alert(1)'), 'internal');
  await rejectsCode(P.openExternal('not a url'), 'internal');
  assert.equal(opened.length, 1);
});

test('legacy desktop helpers on the web', async () => {
  assert.deepEqual(await P.listLegacyDesktopCzd(), []);
  await rejectsCode(P.readLegacyDesktopCzd('/x.czd'), 'internal');
});

// ───────── review additions (C2 adversarial review)

const CZD2_MAGIC = [0x89, 0x43, 0x5a, 0x44, 0x0d, 0x0a, 0x1a, 0x0a];
const CZB_MAGIC = [0x89, 0x43, 0x5a, 0x42, 0x0d, 0x0a, 0x1a, 0x0a];

test('stage target: only cZEROde containers (czd2/czb magic) go to the store stager; plaintext stays in memory', async () => {
  const staged = [];
  P.setStager(async (name, source) => {
    const parts = [];
    for await (const c of source) parts.push(c);
    staged.push(name);
    return new File(parts, name);
  });
  const target = await P.chooseSaveTarget({ name: 'x', count: 5 });
  // A decrypted save (plaintext JPEG bytes) must never be written to OPFS staging (DESIGN §4.2 "never store plaintext").
  const jpeg = [new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), pattern(5000)];
  const r1 = await target.write('photo.jpg', chunks(jpeg), { mime: 'image/jpeg' });
  assert.deepEqual(staged, [], 'plaintext not staged on disk');
  assert.deepEqual(new Uint8Array(await r1.staged.arrayBuffer()), concatBytes(jpeg));
  assert.equal(r1.staged.type, 'image/jpeg');
  // A czd2 container whose magic is split over several chunks still counts as a container.
  const czd = [new Uint8Array(CZD2_MAGIC.slice(0, 3)), new Uint8Array(CZD2_MAGIC.slice(3, 5)), new Uint8Array([...CZD2_MAGIC.slice(5), 2, 0, 18]), pattern(300)];
  const r2 = await target.write('cz-abcdefgh.czd', chunks(czd));
  assert.deepEqual(staged, ['cz-abcdefgh.czd']);
  assert.deepEqual(new Uint8Array(await r2.staged.arrayBuffer()), concatBytes(czd), 'peeked bytes are not lost');
  const czb = [new Uint8Array([...CZB_MAGIC, 1, 0]), pattern(100)];
  const r3 = await target.write('backup.czb', chunks(czb));
  assert.deepEqual(staged, ['cz-abcdefgh.czd', 'backup.czb']);
  assert.deepEqual(new Uint8Array(await r3.staged.arrayBuffer()), concatBytes(czb));
  // Short and empty plaintext.
  const r4 = await target.write('tiny.txt', chunks([new Uint8Array([0x89, 0x43])]));
  assert.deepEqual(new Uint8Array(await r4.staged.arrayBuffer()), new Uint8Array([0x89, 0x43]));
  const r5 = await target.write('empty.txt', chunks([]));
  assert.equal(r5.staged.size, 0);
  assert.equal(staged.length, 2);
});

test('stage target: a plaintext stream over the cap still fails even when a stager is set', async () => {
  P.setStager(async () => assert.fail('plaintext must not reach the stager'));
  const target = await P.chooseSaveTarget({ name: 'big.bin' });
  const piece = new Uint8Array(64 * 2 ** 20);
  async function* huge() {
    for (let i = 0; i <= CAPS.blobDesktop / piece.length; i++) yield piece;
  }
  await rejectsCode(target.write('big.bin', huge()), 'quota-exceeded');
});

test('onOpenFiles (web): every subscriber gets the launched files; off() removes only its own callback', async () => {
  assert.equal(typeof consumer, 'function', 'consumer installed by the first subscriber');
  const a = [];
  const b = [];
  const offA = P.onOpenFiles((files) => a.push(files.map((f) => f.name)));
  const offB = P.onOpenFiles((files) => b.push(files.map((f) => f.name)));
  const handle = (name) => ({ kind: 'file', getFile: async () => new File(['x'], name) });
  await consumer({ files: [handle('one.czd')] });
  assert.deepEqual(a, [['one.czd']]);
  assert.deepEqual(b, [['one.czd']], 'a second onOpenFiles must not replace the first consumer');
  offA();
  await consumer({ files: [handle('two.czb')] });
  assert.deepEqual(a, [['one.czd']]);
  assert.deepEqual(b, [['one.czd'], ['two.czb']]);
  offB();
});

test('chooseSaveTarget() without options still returns a target', async () => {
  const target = await P.chooseSaveTarget();
  assert.equal(target.kind, 'stage');
  assert.equal(target.count, 1);
});
