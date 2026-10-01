// MemoryStore (app/vault/store.js): the ContainerStore used by vault/backup unit tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../../app/vault/store.js';
import { CzdError } from '../../app/errors.js';
import { randomBytes, toHex } from '../../app/util/bytes.js';
import { collect } from '../../app/util/stream.js';

const isCzd = (code) => (e) => e instanceof CzdError && e.code === code;
const newId = () => toHex(randomBytes(16));
async function* chunks(u8, size) {
  for (let p = 0; p < u8.length; p += size) yield u8.subarray(p, p + size);
}

test('write → source (ByteSource with .blob) → delete', async () => {
  const s = new MemoryStore();
  assert.equal(s.kind, 'memory');
  await s.init();
  const id = newId();
  const data = randomBytes(300000);
  assert.equal(await s.write(id, chunks(data, 65536)), data.length);
  const src = await s.source(id);
  assert.equal(src.size, data.length);
  assert.ok(src.blob instanceof Blob);
  assert.equal(src.blob.size, data.length);
  assert.deepEqual(await src.readAt(1000, 50), data.subarray(1000, 1050));
  assert.deepEqual(await collect(src.stream()), data);
  assert.deepEqual(new Uint8Array(await src.blob.arrayBuffer()), data);
  await s.delete(id);
  await assert.rejects(s.source(id), isCzd('item-file-missing'));
  await s.delete(id);
});

test('write accepts Blob, Uint8Array, sync iterables; input is copied', async () => {
  const s = new MemoryStore();
  const a = newId();
  const b = newId();
  const c = newId();
  const bytes = randomBytes(1000);
  await s.write(a, new Blob([bytes]));
  await s.write(b, bytes);
  await s.write(c, [bytes.subarray(0, 10), bytes.subarray(10)]);
  bytes.fill(0);
  const ref = new Uint8Array(await (await s.source(a)).blob.arrayBuffer());
  assert.ok(ref.some((x) => x !== 0));
  assert.deepEqual(new Uint8Array(await (await s.source(b)).blob.arrayBuffer()), ref);
  assert.deepEqual(new Uint8Array(await (await s.source(c)).blob.arrayBuffer()), ref);
  assert.equal(await s.write(newId(), new Uint8Array(0)), 0);
});

test('invalid ids are rejected', async () => {
  const s = new MemoryStore();
  for (const bad of ['../x', 'ABCDEF0123456789ABCDEF0123456789', 'abc', '', 42]) {
    await assert.rejects(s.write(bad, new Uint8Array(1)), TypeError);
  }
  await assert.rejects(s.write(newId(), 'not bytes'), TypeError);
  await assert.rejects(s.write(newId(), [new Uint8Array(1), 'x']), TypeError);
});

test('abort and source errors leave nothing behind', async () => {
  const s = new MemoryStore();
  const id = newId();
  const ac = new AbortController();
  async function* slow() {
    yield new Uint8Array(10);
    ac.abort();
    yield new Uint8Array(10);
  }
  await assert.rejects(s.write(id, slow(), { signal: ac.signal }), isCzd('aborted'));
  await assert.rejects(s.source(id), isCzd('item-file-missing'));
  async function* broken() {
    yield new Uint8Array(10);
    throw new Error('disk on fire');
  }
  await assert.rejects(s.write(id, broken()), /disk on fire/);
  assert.deepEqual(await s.list(), []);
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(s.write(id, new Uint8Array(1), { signal: pre.signal }), isCzd('aborted'));
  await assert.rejects(s.stage('x.czd', new Uint8Array(1), { signal: pre.signal }), isCzd('aborted'));
});

test('quota-exceeded and estimate', async () => {
  const s = new MemoryStore({ quota: 1000 });
  await s.write(newId(), new Uint8Array(600));
  await assert.rejects(s.write(newId(), new Uint8Array(500)), isCzd('quota-exceeded'));
  assert.deepEqual(await s.estimate(), { usage: 600, quota: 1000, persisted: false });
  await s.stage('a.czd', new Uint8Array(300));
  await assert.rejects(s.stage('b.czd', new Uint8Array(200)), isCzd('quota-exceeded'));
  assert.deepEqual(await s.estimate(), { usage: 900, quota: 1000, persisted: false });
  assert.deepEqual(await new MemoryStore().estimate(), { usage: 0, quota: null, persisted: false });
});

test('list reports id, size, mtime', async () => {
  let t = 1000;
  const s = new MemoryStore({ now: () => t });
  const a = newId();
  await s.write(a, new Uint8Array(7));
  t = 2000;
  const b = newId();
  await s.write(b, new Uint8Array(9));
  const rows = (await s.list()).sort((x, y) => x.mtime - y.mtime);
  assert.deepEqual(rows, [{ id: a, size: 7, mtime: 1000 }, { id: b, size: 9, mtime: 2000 }]);
});

test('stage returns a File', async () => {
  const s = new MemoryStore();
  const data = randomBytes(5000);
  const f = await s.stage('cz-abcdefgh.czd', chunks(data, 999));
  assert.ok(f instanceof File);
  assert.equal(f.name, 'cz-abcdefgh.czd');
  assert.equal(f.size, 5000);
  assert.deepEqual(new Uint8Array(await f.arrayBuffer()), data);
  assert.deepEqual(await s.list(), [], 'staged files are not items');
});

test('sweep: tmp older than 24 h, orphans older than 1 h', async () => {
  const H = 3600 * 1000;
  let t = 0;
  const s = new MemoryStore({ now: () => t });
  const known = newId();
  const oldOrphan = newId();
  const youngOrphan = newId();
  await s.write(known, new Uint8Array(1));
  await s.write(oldOrphan, new Uint8Array(1));
  await s.stage('old.czd', new Uint8Array(1));
  t = 30 * H;
  await s.write(youngOrphan, new Uint8Array(1));
  await s.stage('new.czd', new Uint8Array(1));
  t = 30 * H + 30 * 60 * 1000;
  assert.deepEqual(await s.sweep({ knownIds: [known] }), { tmp: 1, orphans: 1 });
  assert.deepEqual((await s.list()).map((r) => r.id).sort(), [known, youngOrphan].sort());
  t += 2 * H;
  assert.deepEqual(await s.sweep({ knownIds: new Set([known]) }), { tmp: 0, orphans: 1 });
  assert.deepEqual((await s.list()).map((r) => r.id), [known]);
  t += 30 * H;
  assert.deepEqual(await s.sweep({ knownIds: [known] }), { tmp: 1, orphans: 0 });
});
