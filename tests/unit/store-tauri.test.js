// TauriFsStore (app/vault/store.js) against the in-memory window.__TAURI__ of tests/unit/platform-fakes.js, through
// the real platform.tauriFs wrappers: the shared conformance suite, the on-disk layout ($APPDATA/vault2/items),
// 8 MiB append batches, cleanup after failures, and probeBestKind/openStore under Tauri.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeTauri } from './platform-fakes.js';
import { CzdError } from '../../app/errors.js';
import { randomBytes } from '../../app/util/bytes.js';
import { collectBytes, makeAssert, newId, pieces, storeCases } from './store-conformance.js';

const fake = fakeTauri();
// isTauri is decided when platform.js is first imported: the fake must exist before.
const { TauriFsStore, openStore, probeBestKind } = await import('../../app/vault/store.js');

const MiB = 2 ** 20;
const H = 3600 * 1000;
const FAKE_MTIME = 1_700_000_000_000; // what the fake's stat() reports for every file
const ITEMS = `${fake.appData}/vault2/items`;
const isCzd = (code) => (e) => e instanceof CzdError && e.code === code;
const a = makeAssert({ ok: (c, m) => assert.ok(c, m), equal: (x, y, m) => assert.equal(x, y, m) });

beforeEach(() => {
  fake.files.clear();
  fake.calls.length = 0;
  fake.failWrite = () => false;
});

async function make() {
  const c = { offset: 0 };
  const store = new TauriFsStore({ now: () => FAKE_MTIME + c.offset });
  await store.init();
  return { store, advance: (ms) => { c.offset += ms; } };
}

for (const c of storeCases({ blob: false, stage: false, big: true })) {
  test(`TauriFsStore: ${c.name}`, async () => {
    fake.files.clear();
    await c.fn(a, await make());
  });
}

test('probeBestKind → tauri-fs; openStore(tauri-fs) creates $APPDATA/vault2/items', async () => {
  assert.equal(await probeBestKind(), 'tauri-fs');
  const s = await openStore('tauri-fs');
  assert.equal(s.kind, 'tauri-fs');
  assert.ok(fake.dirs.has(ITEMS));
  assert.ok(fake.calls.some((x) => x[0] === 'mkdir' && x[1] === ITEMS));
  assert.deepEqual(await s.estimate(), { usage: 0, quota: null, persisted: true });
});

test('layout and batches: <id>.czd, first 8 MiB creates, the rest is appended', async () => {
  const { store } = await make();
  const id = newId();
  const data = randomBytes(19 * MiB + 7);
  await store.write(id, pieces(data, [3 * MiB + 1]));
  const path = `${ITEMS}/${id}.czd`;
  assert.deepEqual(fake.files.get(path), data);
  const writes = fake.calls.filter((x) => x[0] === 'writeFile' && x[1] === path).map((x) => [x[2], x[3]]);
  assert.deepEqual(writes, [[8 * MiB, null], [8 * MiB, { append: true }], [3 * MiB + 7, { append: true }]]);
  assert.deepEqual(await store.list(), [{ id, size: data.length, mtime: FAKE_MTIME }]);
  assert.deepEqual(await store.estimate(), { usage: data.length, quota: null, persisted: true });
  // other files in the folder are not items
  fake.files.set(`${ITEMS}/notes.txt`, new Uint8Array(3));
  fake.files.set(`${ITEMS}/${id.toUpperCase()}.czd`, new Uint8Array(3));
  assert.deepEqual((await store.list()).map((r) => r.id), [id]);
});

test('a fresh store finds existing files (size from the listing); external removal → item-file-missing', async () => {
  const { store } = await make();
  const id = newId();
  const data = randomBytes(10 * MiB + 3);
  await store.write(id, data);
  const other = new TauriFsStore();
  const src = await other.source(id);
  assert.equal(src.size, data.length);
  assert.deepEqual(await collectBytes(src.stream()), data);
  fake.files.delete(`${ITEMS}/${id}.czd`);
  await assert.rejects(src.readAt(0, 10), isCzd('item-file-missing'));
  await assert.rejects(collectBytes(src.stream()), isCzd('item-file-missing'));
  await assert.rejects(new TauriFsStore().source(id), isCzd('item-file-missing'));
  await store.delete(id);
});

test('a failed disk write (disk full) removes the partial file and rejects quota-exceeded', async () => {
  const { store } = await make();
  const id = newId();
  const path = `${ITEMS}/${id}.czd`;
  fake.failWrite = (p, { opts }) => (p === path && opts?.append ? 'No space left on device (os error 28)' : false);
  await assert.rejects(store.write(id, randomBytes(9 * MiB)), isCzd('quota-exceeded'));
  assert.equal(fake.files.has(path), false);
  assert.ok(fake.calls.some((x) => x[0] === 'remove' && x[1] === path));
  await assert.rejects(store.source(id), isCzd('item-file-missing'));
});

test('sweep keeps known ids and young files; deletes old orphans', async () => {
  const { store, advance } = await make();
  const known = newId();
  const orphan = newId();
  await store.write(known, new Uint8Array(4));
  await store.write(orphan, new Uint8Array(4));
  assert.deepEqual(await store.sweep({ knownIds: [] }), { tmp: 0, orphans: 0 });
  advance(H + 1);
  assert.deepEqual(await store.sweep({ knownIds: new Set([known]) }), { tmp: 0, orphans: 1 });
  assert.deepEqual((await store.list()).map((r) => r.id), [known]);
});

test('ids are validated before any path is built', async () => {
  const { store } = await make();
  fake.calls.length = 0;
  for (const bad of ['../../etc/passwd', `${'a'.repeat(32)}/../x`, 'A'.repeat(32)]) {
    await assert.rejects(store.write(bad, new Uint8Array(1)), TypeError);
    await assert.rejects(store.source(bad), TypeError);
    await assert.rejects(store.delete(bad), TypeError);
  }
  assert.deepEqual(fake.calls.filter((x) => x[0] !== 'mkdir'), []);
});

test('openStore(tauri-fs) → store-unavailable when the app data folder is unreachable', async () => {
  const real = globalThis.__TAURI__.path.appDataDir;
  globalThis.__TAURI__.path.appDataDir = async () => {
    throw 'path not allowed by scope';
  };
  try {
    await assert.rejects(openStore('tauri-fs'), isCzd('store-unavailable'));
  } finally {
    globalThis.__TAURI__.path.appDataDir = real;
  }
});

test('an injected fs with stat(): source() sizes one file without listing the folder', async () => {
  const { store } = await make();
  const id = newId();
  const data = randomBytes(1000);
  await store.write(id, data);
  const P = await import('../../app/platform.js');
  const calls = [];
  const fs = {
    ...P.tauriFs,
    async list(dir) {
      calls.push('list');
      return P.tauriFs.list(dir);
    },
    async stat(path) {
      calls.push('stat');
      return { size: fake.files.get(path).length };
    },
  };
  const s = new TauriFsStore({ fs });
  const src = await s.source(id);
  assert.equal(src.size, 1000);
  assert.deepEqual(await src.readAt(10, 5), data.subarray(10, 15));
  assert.deepEqual(calls, ['stat']);
});

/** A TauriFsStore whose list() can be held after the folder was read (so it overlaps other calls). */
async function gatedListStore() {
  const P = await import('../../app/platform.js');
  const ctl = { hold: null, entered: null };
  const fs = {
    ...P.tauriFs,
    async list(dir) {
      const rows = await P.tauriFs.list(dir);
      if (ctl.hold) {
        ctl.entered?.();
        await ctl.hold;
      }
      return rows;
    },
  };
  const store = new TauriFsStore({ fs });
  await store.init();
  return { store, ctl };
}

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test('a listing that overlaps a write never caches the partial size of that write', async () => {
  const { store, ctl } = await gatedListStore();
  const id = newId();
  const path = `${ITEMS}/${id}.czd`;
  const data = randomBytes(8 * MiB + 100);
  const gate = deferred();
  async function* src() {
    yield data.subarray(0, 8 * MiB);
    await gate.promise;
    yield data.subarray(8 * MiB);
  }
  const writing = store.write(id, src());
  for (let i = 0; i < 200 && fake.files.get(path)?.length !== 8 * MiB; i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(fake.files.get(path)?.length, 8 * MiB, 'first batch on disk');
  const hold = deferred();
  const entered = deferred();
  ctl.hold = hold.promise;
  ctl.entered = entered.resolve;
  const listing = store.list(); // reads the folder now (partial file), returns later
  await entered.promise;
  gate.resolve();
  assert.equal(await writing, data.length);
  hold.resolve();
  await listing;
  ctl.hold = null;
  const s = await store.source(id);
  assert.equal(s.size, data.length, 'size of the finished write, not the listing\'s snapshot');
  assert.deepEqual(await collectBytes(s.stream()), data);
});

test('a listing that overlaps a delete does not bring the deleted item back', async () => {
  const { store, ctl } = await gatedListStore();
  const id = newId();
  await store.write(id, randomBytes(1000));
  const hold = deferred();
  const entered = deferred();
  ctl.hold = hold.promise;
  ctl.entered = entered.resolve;
  const listing = store.list();
  await entered.promise;
  await store.delete(id);
  hold.resolve();
  await listing;
  ctl.hold = null;
  await assert.rejects(store.source(id), isCzd('item-file-missing'), 'source() of a deleted id');
});
