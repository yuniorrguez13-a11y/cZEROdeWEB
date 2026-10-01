// Golden vectors (DESIGN §8): decrypt-only checks of the committed czd2 containers and text v2 messages
// (real POLICY Argon2id), plus the 17,039,359-byte padmé case rebuilt from its seed (encrypt → decrypt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-phase0.js';
import * as C from '../../app/crypto/container.js';
import { POLICY } from '../../app/crypto/kdf.js';
import { decryptText, detectText } from '../../app/crypto/textfmt.js';
import { scriptToBytes } from '../../app/crypto/stealth.js';
import { bytesSource } from '../../app/util/stream.js';
import { ascii, fromHex, toHex } from '../../app/util/bytes.js';
import { BIG, PASSPHRASE, prngBytes, sha256 } from '../../scripts/gen-vectors.mjs';

const DIR = path.join(ROOT, 'tests/vectors/czd2');
const spec = JSON.parse(readFileSync(path.join(DIR, 'czd2.json'), 'utf8'));
const textSpec = JSON.parse(readFileSync(path.join(ROOT, 'tests/vectors/text-v2.json'), 'utf8'));

async function streamSha(it) {
  const h = createHash('sha256');
  let n = 0;
  for await (const p of it) {
    h.update(p);
    n += p.length;
  }
  return { hex: h.digest('hex'), n };
}

async function vaultOpts(v) {
  const vaultId = fromHex(v.vaultIdHex);
  const hk = await crypto.subtle.importKey('raw', fromHex(v.vmkHex), 'HKDF', false, ['deriveKey']);
  const wrapKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: vaultId, info: ascii('cZEROde czd2 vault item-wrap') }, hk,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { vault: { wrapKey, vaultId, itemId: fromHex(v.itemIdHex) } };
}

/** Payload decrypt from fileKey + streamSalt only (what src-tauri/src/stream.rs does). */
async function payloadFromFileKey(file, v) {
  const hk = await crypto.subtle.importKey('raw', fromHex(v.fileKeyHex), 'HKDF', false, ['deriveKey']);
  const pay = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: fromHex(v.streamSaltHex), info: ascii('cZEROde czd2 payload') }, hk,
    { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const CS = 2 ** v.chunkExp;
  const h = createHash('sha256');
  let left = v.size;
  for (let i = 0; i < v.n; i++) {
    const len = (i < v.n - 1 ? CS : v.paddedSize - (v.n - 1) * CS) + 16;
    const off = v.headerLen + i * (CS + 16);
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setUint32(7, i);
    iv[11] = i === v.n - 1 ? 1 : 0;
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, pay, file.subarray(off, off + len)));
    h.update(pt.subarray(0, Math.min(pt.length, left)));
    left -= Math.min(pt.length, left);
  }
  return h.digest('hex');
}

test('czd2.json lists every committed vector kind from DESIGN §8', () => {
  const ids = spec.vectors.map((v) => v.id);
  const CS = 2 ** 18;
  for (const s of [0, 1, CS - 1, CS, CS + 1, 3 * CS + 7]) assert.ok(ids.includes(`size-${s}`), `size-${s}`);
  assert.equal(spec.vectors.filter((v) => v.kind === 'batch').length, 2);
  assert.equal(spec.vectors.filter((v) => v.kind === 'bundle').length, 1);
  assert.deepEqual(spec.kdf, POLICY);
  assert.equal(spec.passphrase, PASSPHRASE);
  assert.equal(spec.generated[0].size, 17039359);
});

for (const v of spec.vectors) {
  test(`golden czd2 ${v.id}: decrypts to the committed plaintext`, async () => {
    const file = new Uint8Array(readFileSync(path.join(DIR, v.file)));
    assert.equal(file.length, v.containerSize);
    assert.equal(sha256(file), v.containerSha256, 'container bytes unchanged');
    const src = bytesSource(file);
    const opts = v.kind === 'vault' ? await vaultOpts(v) : { passphrase: v.passphrase };
    const o = await C.openSource(src, opts);
    try {
      assert.equal(o.via, v.kind === 'vault' ? 'vault' : 'pass');
      if (o.via === 'pass') {
        assert.deepEqual(o.kdf, v.kdf);
        const body = o.stanzas.find((s) => s.type === C.ST_PASS).body;
        assert.equal(toHex(body.subarray(10, 26)), v.passSaltHex);
      }
      assert.deepEqual(o.meta, v.meta);
      assert.equal(o.headerLen, v.headerLen);
      assert.equal(o.size, v.size);
      assert.equal(o.paddedSize, v.paddedSize);
      assert.equal(o.n, v.n);
      assert.equal(o.chunkExp, v.chunkExp);
      assert.equal(toHex(o.fileKey), v.fileKeyHex);
      assert.equal(toHex(o.streamSalt), v.streamSaltHex);
      const full = await collectAll(C.decryptSource(src, o));
      assert.equal(full.length, v.size);
      assert.equal(sha256(full), v.plaintextSha256);
      if (v.kind === 'bundle') {
        assert.equal(o.isBundle, true);
        for (const [i, e] of o.meta.entries.entries()) {
          const got = await streamSha(C.decryptSource(src, o, { entry: e }));
          assert.equal(got.hex, v.entrySha256[i]);
          assert.equal(got.hex, sha256(prngBytes(v.entrySeeds[i], e.size)));
        }
      } else {
        assert.equal(v.plaintextSha256, sha256(prngBytes(v.seed, v.size)), 'plaintext = prng(seed, size)');
      }
      if (v.size > 0) {
        const a = Math.floor(v.size / 3);
        const b = Math.min(v.size - 1, a + 2 ** 18);
        assert.ok(Buffer.from(await C.decryptRange(src, o, a, b)).equals(full.subarray(a, b + 1)), 'decryptRange');
      }
      assert.equal(await payloadFromFileKey(file, v), v.plaintextSha256, 'fileKeyHex + streamSaltHex decrypt the payload directly');
    } finally {
      C.release(o);
    }
  });
}

async function collectAll(it) {
  const parts = [];
  for await (const p of it) parts.push(p);
  return Buffer.concat(parts);
}

test('golden batch: both containers share one Argon2 salt and params', () => {
  const b = spec.vectors.filter((v) => v.kind === 'batch');
  assert.equal(b[0].passSaltHex, b[1].passSaltHex);
  assert.notEqual(b[0].fileKeyHex, b[1].fileKeyHex);
  assert.notEqual(b[0].streamSaltHex, b[1].streamSaltHex);
});

test('golden czd2 size-17039359 (padmé adds a padding-only chunk): rebuilt from the seed, encrypted, decrypted', async (t) => {
  const g = spec.generated[0];
  assert.equal(g.size, BIG.size);
  const plain = prngBytes(g.seed, g.size);
  assert.equal(sha256(plain), g.plaintextSha256, 'PRNG reproduces the committed plaintext hash');
  assert.equal(C.padme(g.size), g.paddedSize);
  assert.equal(g.paddedSize, 66 * 2 ** 18);
  const t0 = performance.now();
  const pk = await C.makePassKek(g.passphrase, POLICY);
  const parts = [];
  for await (const p of C.encryptStream([plain], { size: g.size, meta: { name: g.meta.name, type: g.meta.type, mtime: g.meta.mtime }, stanzasFor: async (fk) => [await C.passStanza(fk, pk)] })) parts.push(p);
  const file = new Uint8Array(Buffer.concat(parts));
  const src = bytesSource(file);
  const o = await C.openSource(src, { passphrase: g.passphrase });
  assert.equal(o.n, g.n);
  assert.equal(file.length, C.containerSize(g.size, 18, o.headerLen));
  assert.deepEqual(o.meta, g.meta);
  const got = await streamSha(C.decryptSource(src, o));
  assert.equal(got.hex, g.plaintextSha256);
  assert.equal(sha256(await C.decryptRange(src, o, g.size - 5, g.size - 1)), sha256(plain.subarray(g.size - 5)));
  C.release(o);
  t.diagnostic(`17 MB vector: ${(performance.now() - t0).toFixed(0)} ms including one POLICY Argon2`);
});

for (const v of textSpec.vectors) {
  test(`golden text v2 ${v.id}`, async () => {
    assert.equal(detectText(v.text), 'v2');
    assert.equal(scriptToBytes(v.text.slice(1), { allowRawBase64: false })[1], v.preset);
    assert.equal(await decryptText(v.text, v.decryptWith), v.message);
  });
}
