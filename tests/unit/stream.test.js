// app/util/stream.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abortable, blobSource, bytesSource, collect, fileChunks, rechunk, take, withProgress } from '../../app/util/stream.js';
import { CzdError } from '../../app/errors.js';
import { randomBytes } from '../../app/util/bytes.js';

const isCzd = (code) => (e) => e instanceof CzdError && e.code === code;
async function toArray(it) {
  const out = [];
  for await (const x of it) out.push(x);
  return out;
}
function pieces(u8, sizes) {
  const out = [];
  let p = 0;
  for (const s of sizes) { out.push(u8.slice(p, p + s)); p += s; }
  if (p < u8.length) out.push(u8.slice(p));
  return out;
}

for (const [label, make] of [['blobSource', (u) => blobSource(new Blob([u]))], ['bytesSource', (u) => bytesSource(u)]]) {
  test(`${label}: size, readAt, stream ranges`, async () => {
    const data = randomBytes(700000);
    const src = make(data);
    assert.equal(src.size, data.length);
    assert.deepEqual(await src.readAt(0, 10), data.subarray(0, 10));
    assert.deepEqual(await src.readAt(123456, 300000), data.subarray(123456, 423456));
    assert.deepEqual(await src.readAt(data.length, 0), new Uint8Array(0));
    assert.deepEqual(await src.readAt(data.length - 1, 1), data.subarray(data.length - 1));
    await assert.rejects(src.readAt(data.length - 1, 2), isCzd('truncated'));
    await assert.rejects(src.readAt(-1, 2), TypeError);
    assert.deepEqual(await collect(src.stream()), data);
    assert.deepEqual(await collect(src.stream(5)), data.subarray(5));
    assert.deepEqual(await collect(src.stream(5, 300005)), data.subarray(5, 300005));
    assert.deepEqual(await collect(src.stream(9, 9)), new Uint8Array(0));
    await assert.rejects(collect(src.stream(0, data.length + 1)), isCzd('truncated'));
    await assert.rejects(collect(src.stream(10, 5)), TypeError);
    const copy = await src.readAt(0, 4);
    copy.fill(0);
    assert.notDeepEqual(await src.readAt(0, 4), copy, 'readAt returns a copy');
  });
}

test('blobSource exposes the Blob; bytesSource has none', () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])]);
  assert.equal(blobSource(blob).blob, blob);
  assert.equal(bytesSource(new Uint8Array(3)).blob, undefined);
});

test('rechunk: exact sizes, fresh transferable buffers, sync and async inputs', async () => {
  const data = randomBytes(10000);
  for (const sizes of [[1, 2, 3, 5000], [4096], [9999], [10000], [3, 4093, 4096, 1808], []]) {
    const out = await toArray(rechunk(pieces(data, sizes), 4096));
    assert.deepEqual(out.map((p) => p.length), [4096, 4096, 1808]);
    assert.deepEqual(await collect(out), data);
    for (const p of out) {
      assert.equal(p.byteOffset, 0);
      assert.equal(p.buffer.byteLength, p.length, 'each piece owns its whole buffer');
    }
    assert.equal(new Set(out.map((p) => p.buffer)).size, out.length);
  }
  async function* gen() { yield data.subarray(0, 100); yield data.subarray(100).buffer.slice(100); }
  assert.deepEqual(await collect(rechunk(gen(), 7)), data);
  assert.deepEqual(await toArray(rechunk([], 16)), []);
  assert.deepEqual(await toArray(rechunk([new Uint8Array(0)], 16)), []);
  assert.deepEqual((await toArray(rechunk([new Uint8Array(32)], 16))).map((p) => p.length), [16, 16]);
  await assert.rejects(toArray(rechunk([data], 0)), TypeError);
});

test('fileChunks reads a Blob in exact pieces and closes early', async () => {
  const data = randomBytes(1 << 20);
  const blob = new Blob([data]);
  const out = await toArray(fileChunks(blob, 300000));
  assert.deepEqual(out.map((p) => p.length), [300000, 300000, 300000, 148576]);
  assert.deepEqual(await collect(out), data);
  assert.deepEqual((await toArray(fileChunks(blob))).map((p) => p.length), [262144, 262144, 262144, 262144]);
  let n = 0;
  for await (const piece of fileChunks(blob, 1000)) { if (++n === 3) break; assert.equal(piece.length, 1000); }
  assert.deepEqual(await toArray(fileChunks(new Blob([]))), []);
});

test('collect: concatenation and max', async () => {
  const data = randomBytes(5000);
  assert.deepEqual(await collect(pieces(data, [1, 999, 2000])), data);
  assert.deepEqual(await collect(pieces(data, [1, 999, 2000]), { max: 5000 }), data);
  await assert.rejects(collect(pieces(data, [1, 999, 2000]), { max: 4999 }), isCzd('too-big-to-preview'));
  let pulled = 0;
  async function* endless() { for (;;) { pulled++; yield new Uint8Array(1000); } }
  await assert.rejects(collect(endless(), { max: 2500 }), isCzd('too-big-to-preview'));
  assert.equal(pulled, 3, 'stops pulling once over max');
  assert.deepEqual(await collect([]), new Uint8Array(0));
});

test('take: first n bytes, closes the source', async () => {
  const data = randomBytes(1000);
  assert.deepEqual(await collect(take(pieces(data, [100, 300, 600]), 450)), data.subarray(0, 450));
  assert.deepEqual(await collect(take(pieces(data, [100]), 5000)), data);
  assert.deepEqual(await collect(take(pieces(data, [100]), 0)), new Uint8Array(0));
  let closed = false;
  async function* src() { try { for (;;) yield new Uint8Array(10); } finally { closed = true; } }
  assert.equal((await collect(take(src(), 25))).length, 25);
  assert.equal(closed, true);
});

test('withProgress reports cumulative bytes after each chunk is consumed', async () => {
  const calls = [];
  const out = await toArray(withProgress([new Uint8Array(3), new Uint8Array(4)], (d, t) => calls.push([d, t]), 7));
  assert.equal(out.length, 2);
  assert.deepEqual(calls, [[3, 7], [7, 7]]);
});

test('abortable checkpoints', () => {
  const none = abortable(undefined);
  none.checkpoint();
  assert.equal(none.aborted, false);
  const ac = new AbortController();
  const a = abortable(ac.signal);
  a.checkpoint();
  assert.equal(a.aborted, false);
  ac.abort(new Error('why'));
  assert.equal(a.aborted, true);
  assert.throws(() => a.checkpoint(), (e) => isCzd('aborted')(e) && e.cause.message === 'why');
});
