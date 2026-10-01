// The czstream (src-tauri/src/stream.rs) test data seen from JS:
//  - tests/vectors/czd2/rust-*.czd (scripts/gen-rust-vectors.mjs) are valid vault items for the JS reader, and
//    rust-vectors.json describes them exactly (layout, keys, digests);
//  - tests/vectors/czd2/rust-ranges.json, the Range table the Rust tests use, is what sw-stream.js (DESIGN
//    §5.2) answers, so desktop and web streaming treat Range headers alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers-phase0.js';
import * as C from '../../app/crypto/container.js';
import { bytesSource } from '../../app/util/stream.js';
import { fromHex, toHex } from '../../app/util/bytes.js';
import { prngBytes } from '../../scripts/gen-vectors.mjs';
import { CASES, itemWrapKey } from '../../scripts/gen-rust-vectors.mjs';
import { seal } from './container-helpers.js';

const DIR = path.join(ROOT, 'tests/vectors/czd2');
const sha256 = (u8) => createHash('sha256').update(u8).digest('hex');
const json = (name) => JSON.parse(readFileSync(path.join(DIR, name), 'utf8'));

async function collect(it) {
  const parts = [];
  for await (const p of it) parts.push(p);
  return Buffer.concat(parts);
}

test('rust-vectors.json describes every rust-*.czd and the JS reader opens them as vault items', async () => {
  const spec = json('rust-vectors.json');
  assert.deepEqual(spec.vectors.map((v) => [v.id, v.size, v.chunkExp, v.meta.type]), CASES.map((c) => [...c]));
  const vaultId = fromHex(spec.vaultIdHex);
  const wrapKey = await itemWrapKey(fromHex(spec.vmkHex), vaultId);
  for (const v of spec.vectors) {
    const file = new Uint8Array(readFileSync(path.join(DIR, v.file)));
    assert.equal(file.length, v.containerSize, v.id);
    assert.equal(sha256(file), v.containerSha256, v.id);
    const src = bytesSource(file);
    const opened = await C.openSource(src, { vault: { wrapKey, vaultId, itemId: fromHex(v.itemIdHex) } });
    try {
      assert.equal(opened.via, 'vault');
      assert.deepEqual(
        [opened.headerLen, opened.chunkExp, opened.size, opened.paddedSize, opened.n],
        [v.headerLen, v.chunkExp, v.size, v.paddedSize, v.n],
        v.id,
      );
      assert.equal(C.padme(v.size), v.paddedSize);
      assert.equal(C.containerSize(v.size, v.chunkExp, v.headerLen), v.containerSize);
      assert.equal(toHex(opened.fileKey), v.fileKeyHex);
      assert.equal(toHex(opened.streamSalt), v.streamSaltHex);
      assert.deepEqual(opened.meta, v.meta);
      const plain = await collect(C.decryptSource(src, opened));
      assert.equal(sha256(plain), v.plaintextSha256, v.id);
      assert.ok(plain.equals(Buffer.from(prngBytes(v.seed, v.size))), `${v.id} plaintext = prng(seed)`);
      // The last data byte and a range across the final data chunk boundary.
      const last = await C.decryptRange(src, opened, v.size - 1, v.size - 1);
      assert.equal(last[0], plain[v.size - 1]);
    } finally {
      C.release(opened);
    }
  }
  // The padding-only extra chunk: 266,240 B = 65 chunks of 4 KiB, padded to 66.
  const pad = spec.vectors.find((v) => v.id === 'rust-pad-extra');
  assert.equal(pad.size, 65 * 4096);
  assert.equal(pad.n, 66);
});

/** sw-stream.js in a fresh realm with one live window client 'c1'. */
function loadSwStream() {
  const sandbox = {
    self: {
      clients: {
        get: async (id) => (id === 'c1' ? { id, postMessage() {} } : null),
        matchAll: async () => [{ id: 'c1', postMessage() {} }],
      },
    },
    crypto: globalThis.crypto,
    CryptoKey: globalThis.CryptoKey,
    Blob,
    Response,
    Headers,
    ReadableStream,
    URL,
    MessageChannel,
    Uint8Array,
    ArrayBuffer,
    Promise,
    Map,
    Set,
    Error,
    TypeError,
    Number,
    Math,
    Object,
    Array,
    String,
    encodeURIComponent,
    Date,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(readFileSync(path.join(ROOT, 'sw-stream.js'), 'utf8'), sandbox, { filename: 'sw-stream.js' });
  return sandbox.self.czStream;
}

test('rust-ranges.json is exactly what sw-stream.js answers', async () => {
  const sw = loadSwStream();
  const table = json('rust-ranges.json').cases;
  const totals = [...new Set(table.map((c) => c.total))];
  const tokens = new Map();
  const plains = new Map();
  for (const [i, total] of totals.entries()) {
    const plain = prngBytes(900 + i, total);
    const file = await seal(plain, { chunkExp: 12, meta: { name: 'clip.webm', type: 'video/webm' } });
    const opened = await C.openSource(bytesSource(file), { passphrase: 'pw' });
    const token = `ABCDEFGHIJKLMNOPQRSTUVWXY${'ABCDEFGH'[i]}`;
    let reply;
    sw.onMessage({
      data: {
        cmd: 'register', token, blob: new Blob([file]), payKey: opened.keys.pay, headerLen: opened.headerLen,
        chunkExp: opened.chunkExp, size: opened.size, paddedSize: opened.paddedSize, mime: 'video/webm', filename: 'clip.webm', download: false,
      },
      ports: [{ postMessage: (m) => (reply = m) }],
      source: { id: 'c1' },
      waitUntil() {},
    });
    assert.equal(reply?.ok, true, `register ${total}`);
    tokens.set(total, token);
    plains.set(total, plain);
  }
  for (const c of table) {
    const headers = new Headers(c.header === null ? {} : { Range: c.header });
    const request = { url: `https://example.test/app/czstream/${tokens.get(c.total)}`, method: 'GET', mode: 'cors', headers };
    const res = await sw.handle({ request, clientId: 'c1', waitUntil() {} });
    const what = `${JSON.stringify(c.header)} of ${c.total}`;
    assert.equal(res.status, c.status, `status for ${what}`);
    const body = new Uint8Array(await res.arrayBuffer());
    if (c.status === 416) {
      assert.equal(res.headers.get('Content-Range'), `bytes */${c.total}`, what);
      continue;
    }
    const want = c.start === undefined ? new Uint8Array(0) : plains.get(c.total).subarray(c.start, c.end + 1);
    assert.equal(res.headers.get('Content-Length'), String(want.length), `length for ${what}`);
    assert.equal(res.headers.get('Content-Range'), c.status === 206 ? `bytes ${c.start}-${c.end}/${c.total}` : null, what);
    assert.ok(Buffer.from(body).equals(Buffer.from(want)), `body for ${what}`);
  }
});
