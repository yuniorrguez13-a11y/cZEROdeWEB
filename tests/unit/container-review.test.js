// Adversarial-review regressions for the czd2 container (DESIGN §3.3): bundle type case, whole-buffer
// sources, non-byte pieces, and a release() that races a running decrypt.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../app/crypto/container.js';
import * as K from '../../app/crypto/kdf.js';
import { CzdError } from '../../app/errors.js';
import { bytesSource, collect } from '../../app/util/stream.js';
import { utf8 } from '../../app/util/bytes.js';
import { craft, open, passKekFor, rnd, same, seal } from './container-helpers.js';

const code = (c) => (e) => {
  assert.ok(e instanceof CzdError, `expected CzdError(${c}), got ${e?.name}: ${e?.message}`);
  assert.equal(e.code, c, `expected ${c}, got ${e.code} (${JSON.stringify(e.detail)})`);
  return true;
};

afterEach(() => K.__setArgon2ForTests(null));

const passOpts = async () => {
  const pk = await passKekFor('pw');
  return { meta: { name: 'a.bin', type: 'application/octet-stream' }, chunkExp: 12, stanzasFor: async (fk) => [await C.passStanza(fk, pk)] };
};

test('bundle type is recognized case-insensitively: never meta.type === BUNDLE_TYPE without entries', async () => {
  // Before: 'Application/X-CZD-Bundle' skipped the bundle rules but was cleaned to BUNDLE_TYPE → a "bundle" with no entries.
  for (const type of ['Application/X-CZD-Bundle', 'APPLICATION/X-CZD-BUNDLE']) {
    const bad = await craft({ json: JSON.stringify({ v: 1, name: 'x', type, size: 0 }) });
    await assert.rejects(C.openHeader(bad.file, { passphrase: 'pw' }), code('bad-meta'), type);
    const data = rnd(10);
    const entries = [{ name: 'a', type: 'text/plain', size: 4, off: 0 }, { name: 'b', type: 'text/plain', size: 6, off: 4 }];
    const ok = await craft({ data, size: 10, json: JSON.stringify({ v: 1, name: '2 files', type, size: 10, entries }) });
    const o = await C.openHeader(ok.file, { passphrase: 'pw' });
    assert.equal(o.isBundle, true, type);
    assert.equal(o.meta.type, C.BUNDLE_TYPE);
    assert.equal(o.meta.entries.length, 2);
  }
  // The writer applies the same rule.
  const opts = await passOpts();
  await assert.rejects(collect(C.encryptStream([rnd(3)], { ...opts, size: 3, meta: { type: 'Application/X-Czd-Bundle' } })), code('bad-meta'));
  // A bundle-looking type that is not the bundle type stays a plain file.
  const plain = await craft({ json: JSON.stringify({ v: 1, name: 'x', type: 'application/x-czd-bundle2', size: 0 }) });
  const po = await C.openHeader(plain.file, { passphrase: 'pw' });
  assert.equal(po.isBundle, false);
  assert.equal(po.meta.type, 'application/x-czd-bundle2');
});

test('encryptStream: a whole Uint8Array / ArrayBuffer / view is one piece (never a stream of numbers)', async () => {
  const opts = await passOpts();
  const data = rnd(10000);
  for (const src of [data, data.buffer.slice(0), new DataView(data.buffer.slice(0)), [new DataView(data.buffer.slice(0))], [data.buffer.slice(0, 5000), data.subarray(5000)]]) {
    const f = await collect(C.encryptStream(src, { ...opts, size: data.length }));
    assert.ok(same((await open(f)).pt, data), Object.prototype.toString.call(src));
  }
  // Before: [3, 2] became 3 + 2 zero bytes and size 5 "worked", silently encrypting zeros.
  await assert.rejects(collect(C.encryptStream(new Uint8Array([3, 2]), { ...opts, size: 5 })), code('source-size-mismatch'));
  await assert.rejects(collect(C.encryptStream([3, 2], { ...opts, size: 5 })), TypeError);
  await assert.rejects(collect(C.encryptStream(['abc'], { ...opts, size: 3 })), TypeError);
  await assert.rejects(collect(C.encryptStream('abc', { ...opts, size: 3 })), TypeError);
});

test('decryptStream: a whole payload Uint8Array works; non-byte pieces are an error, not a damaged file', async () => {
  const data = rnd(20000);
  const f = await seal(data);
  const o = await C.openHeader(f, { passphrase: 'pw' });
  assert.ok(same(await collect(C.decryptStream(f.subarray(o.headerLen), o)), data), 'Uint8Array ctSource');
  assert.ok(same(await collect(C.decryptStream([f.slice(o.headerLen).buffer], o)), data), 'ArrayBuffer pieces');
  const e = await collect(C.decryptStream([1, 2, 3], o)).catch((x) => x);
  assert.ok(e instanceof CzdError && e.code === 'internal', `got ${e?.code}`);
});

test('release() racing a running decrypt → CzdError("aborted"), not chunk-auth ("damaged file")', async () => {
  const data = rnd(5 * 4096 + 17);
  const f = await seal(data);
  const src = bytesSource(f);
  for (const run of [
    (o) => C.decryptSource(src, o),
    (o) => C.decryptStream([f.subarray(o.headerLen)], o),
    (o) => C.decryptSource(src, o, { entry: { off: 0, size: data.length } }),
  ]) {
    const o = await C.openSource(src, { passphrase: 'pw' });
    let got = 0;
    const err = await (async () => {
      for await (const p of run(o)) {
        got += p.length;
        C.release(o);
      }
    })().catch((x) => x);
    assert.ok(got > 0, 'the first chunk was delivered');
    assert.ok(err instanceof CzdError && err.code === 'aborted', `got ${err?.name} ${err?.code}`);
  }
  const o = await C.openSource(src, { passphrase: 'pw' });
  const pending = C.verifySource(src, o, { onProgress: () => C.release(o) });
  await assert.rejects(pending, code('aborted'));
});

test('Opened keeps working for concurrent readers until release (no shared mutable state)', async () => {
  const data = rnd(9 * 4096);
  const f = await seal(data);
  const src = bytesSource(f);
  const o = await C.openSource(src, { passphrase: 'pw' });
  const [a, b, c] = await Promise.all([collect(C.decryptSource(src, o)), C.decryptRange(src, o, 100, 30000), C.decryptRange(src, o, 4095, 4096)]);
  assert.ok(same(a, data));
  assert.ok(same(b, data.subarray(100, 30001)));
  assert.ok(same(c, data.subarray(4095, 4097)));
  C.release(o);
});

test('meta name and entry names stay plain strings after sanitizing (no prototype tricks)', async () => {
  const json = '{"v":1,"name":"x","type":"application/x-czd-bundle","size":2,"__proto__":{"isBundle":false},"entries":[{"name":"../../a","type":"text/plain","size":2,"off":0,"__proto__":{"off":5}}]}';
  const { file } = await craft({ data: utf8('hi'), size: 2, json });
  const o = await C.openHeader(file, { passphrase: 'pw' });
  assert.equal(o.isBundle, true);
  assert.equal(Object.getPrototypeOf(o.meta), Object.prototype);
  assert.equal(o.meta.entries[0].off, 0);
  assert.ok(!o.meta.entries[0].name.includes('/'), o.meta.entries[0].name);
});
