// czd2 container (DESIGN §3.3): the 36 checks of the research prototype (proto/czd2.test.mjs, ported to
// FORMAT v2), layout conformance against an independent builder, writer rules, bundles, decryptRange.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, listFiles } from './helpers-phase0.js';
import * as C from '../../app/crypto/container.js';
import * as K from '../../app/crypto/kdf.js';
import { CzdError } from '../../app/errors.js';
import { bytesSource, blobSource, collect } from '../../app/util/stream.js';
import { ascii, concat, fromUtf8, readU32, toHex, utf8 } from '../../app/util/bytes.js';
import { FAST, craft, nonce, open, padmeRef, passKekFor, pieces, rnd, same, seal, subkeys } from './container-helpers.js';

const code = (c) => (e) => {
  assert.ok(e instanceof CzdError, `expected CzdError(${c}), got ${e?.name}: ${e?.message}`);
  assert.equal(e.code, c);
  return true;
};
const isCzd = (e) => {
  assert.ok(e instanceof CzdError, `expected a CzdError, got ${e?.name}: ${e?.message}`);
  return true;
};

afterEach(() => K.__setArgon2ForTests(null));

// ---- 1. proto port: round trips + exact size formula (16 checks) ----------------------------------
for (const n of [0, 1, 4095, 4096, 4097, 3 * 4096, 100000, 1 << 20]) {
  test(`proto: round trip ${n} bytes (4 KiB chunks) and exact container size`, async () => {
    const d = rnd(n);
    const f = await seal(d);
    const { pt, opened } = await open(f);
    assert.ok(same(pt, d), `roundtrip ${n}`);
    assert.equal(f.length, opened.headerLen + C.padme(n) + 16 * Math.max(1, Math.ceil(C.padme(n) / 4096)), `size formula ${n}`);
    assert.equal(f.length, C.containerSize(n, 12, opened.headerLen));
  });
}

test('proto: wrong passphrase, truncation, extension, reorder, transplant (7 checks)', async () => {
  const d = rnd(50000);
  const f = await seal(d);
  await assert.rejects(open(f, { passphrase: 'nope' }), code('wrong-passphrase'));
  const { opened: o1 } = await open(f);
  const CT = o1.chunkSize + 16;
  const nCh = Math.ceil(o1.paddedSize / o1.chunkSize);
  const lastLen = o1.paddedSize - (nCh - 1) * o1.chunkSize + 16;
  await assert.rejects(open(f.subarray(0, f.length - lastLen)), code('truncated'), 'drop final chunk');
  await assert.rejects(open(f.subarray(0, f.length - 1)), code('truncated'), 'cut 1 byte');
  await assert.rejects(open(f.subarray(0, o1.headerLen)), code('truncated'), 'header only');
  await assert.rejects(open(concat(f, new Uint8Array([0]))), code('trailing-data'), 'trailing byte');
  {
    const g = f.slice();
    const a = g.slice(o1.headerLen, o1.headerLen + CT);
    const b = g.slice(o1.headerLen + CT, o1.headerLen + 2 * CT);
    g.set(b, o1.headerLen);
    g.set(a, o1.headerLen + CT);
    await assert.rejects(open(g), code('chunk-auth'), 'swap chunk 0/1');
  }
  {
    const f2 = await seal(rnd(50000));
    const { opened: o2 } = await open(f2);
    const g = f.slice();
    g.set(f2.subarray(o2.headerLen + CT, o2.headerLen + 2 * CT), o1.headerLen + CT);
    await assert.rejects(open(g), code('chunk-auth'), 'transplant chunk from another file with the same passphrase');
  }
});

test('proto: bit flips in every header region and the payload (7 checks)', async () => {
  const f = await seal(rnd(50000));
  const { opened: o1 } = await open(f);
  const macOffset = o1.headerLen - 32;
  const cases = [[9, 'flags', 'unknown-flags'], [10, 'chunkExp', null], [12, 'streamSalt', 'header-mac'], [28 + 3 + 2, 'kdf m param', null],
    [macOffset - 5, 'meta ciphertext', 'header-mac'], [macOffset + 3, 'mac', 'header-mac'], [o1.headerLen + 10, 'payload', 'chunk-auth']];
  for (const [pos, name, c] of cases) {
    const g = f.slice();
    g[pos] ^= 0x01;
    await assert.rejects(open(g), c ? code(c) : isCzd, `flip ${name}`);
  }
});

test('proto: KDF DoS guard — m = 4 GiB rejected before Argon2 runs', async () => {
  const f = await seal(rnd(5000));
  const g = f.slice();
  new DataView(g.buffer).setUint32(28 + 3 + 1, 0xffffffff);
  let runs = 0;
  K.__setArgon2ForTests(() => { runs++; return new Uint8Array(32); });
  await assert.rejects(open(g, { passphrase: 'pw-not-cached' }), code('kdf-params-out-of-range'));
  assert.equal(runs, 0);
});

test('proto: vault stanza round trip, item binding, export by re-encryption (4 checks)', async () => {
  const vmk = await crypto.subtle.importKey('raw', rnd(32), 'HKDF', false, ['deriveKey']);
  const vaultId = rnd(16);
  const itemId = rnd(16);
  const wrapKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: vaultId, info: ascii('cZEROde czd2 vault item-wrap') }, vmk,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const data = rnd(30000);
  const vf = await seal(data, { stanzasFor: async (fk) => [await C.vaultStanza(fk, wrapKey, vaultId, itemId)] });
  const { pt, opened } = await open(vf, { vault: { wrapKey, vaultId, itemId } });
  assert.ok(same(pt, data), 'vault stanza roundtrip');
  assert.equal(opened.via, 'vault');
  await assert.rejects(open(vf, { vault: { wrapKey, vaultId, itemId: rnd(16) } }), code('item-mismatch'), 'vault stanza bound to itemId');
  // 2.0 has no O(1) re-wrap: "send" = decrypt → encrypt with fresh keys and a pass stanza only.
  const pk = await passKekFor('send-pw');
  const exported = await collect(C.encryptStream(C.decryptStream(pieces(vf.subarray(opened.headerLen)), opened), {
    size: opened.size, meta: { name: opened.meta.name, type: opened.meta.type }, chunkExp: 12, stanzasFor: async (fk) => [await C.passStanza(fk, pk)],
  }));
  const r = await open(exported, { passphrase: 'send-pw' });
  assert.ok(same(r.pt, data), 'exported copy decrypts');
  assert.ok(!r.opened.stanzas.some((s) => s.type === C.ST_VAULT), 'export carries no vault stanza (no vault/item ids leak)');
  assert.ok(!same(exported.subarray(r.opened.headerLen), vf.subarray(opened.headerLen)), 'payload re-encrypted under a fresh key');
});

test('proto: legacy JSON .czd rejected by magic', async () => {
  await assert.rejects(C.openHeader(utf8('{"v":1,"type":"image","cipher":"ბ..."}'), { passphrase: 'x' }), code('not-czd2'));
});

// ---- layout conformance (independent reader) -----------------------------------------------------

test('FORMAT v2 layout: header fields, stanza encoding, HKDF subkeys, MAC, metaNonce, metaPT, chunk nonces', async () => {
  const fileKey = rnd(32);
  const streamSalt = rnd(16);
  const pk = await passKekFor('pw');
  const data = rnd(10000);
  const file = await collect(C._encryptStreamWith(pieces(data), {
    size: data.length, meta: { name: 'a.txt', type: 'text/plain', mtime: 1700000000000 }, chunkExp: 12, fileKey, streamSalt,
    stanzasFor: async (fk) => [await C.passStanza(fk, pk)],
  }));
  assert.deepEqual([...file.subarray(0, 8)], [0x89, 0x43, 0x5a, 0x44, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual([...file.subarray(8, 12)], [2, 0, 12, 1]);
  assert.deepEqual(file.subarray(12, 28), streamSalt);
  assert.equal(file[28], C.ST_PASS);
  assert.equal((file[29] << 8) | file[30], 86);
  const body = file.subarray(31, 31 + 86);
  assert.equal(body[0], 1, 'kdfId');
  assert.deepEqual([readU32(body, 1), readU32(body, 5), body[9]], [FAST.m, FAST.t, FAST.p]);
  assert.deepEqual(body.subarray(10, 26), pk.salt);
  const fk = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: body.subarray(26, 38), additionalData: ascii('cZEROde czd2 pass') }, pk.kek, body.subarray(38)));
  assert.deepEqual(fk, fileKey, 'wrapped = AES-GCM(KEK, wrapNonce, fileKey, "cZEROde czd2 pass")');
  let off = 31 + 86;
  const metaNonce = file.subarray(off, off + 12);
  const metaLen = readU32(file, off + 12);
  off += 16;
  assert.equal((metaLen - 16) % 256, 0);
  const keys = await subkeys(fileKey, streamSalt);
  assert.equal(keys.macRaw.length, 32);
  const macOff = off + metaLen;
  assert.ok(await crypto.subtle.verify('HMAC', keys.mac, file.subarray(macOff, macOff + 32), file.subarray(0, macOff)), 'headerMAC = HMAC(macKey, header[0..mac))');
  const mpt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: metaNonce }, keys.meta, file.subarray(off, macOff)));
  assert.equal(mpt.length % 256, 0);
  const jl = readU32(mpt, 0);
  assert.deepEqual(JSON.parse(fromUtf8(mpt.subarray(4, 4 + jl))), { name: 'a.txt', type: 'text/plain', mtime: 1700000000000, v: 1, size: 10000 });
  assert.ok(mpt.subarray(4 + jl).every((x) => x === 0));
  const headerLen = macOff + 32;
  const n = Math.ceil(padmeRef(10000) / 4096);
  for (let i = 0; i < n; i++) {
    const len = (i < n - 1 ? 4096 : padmeRef(10000) - (n - 1) * 4096) + 16;
    const ct = file.subarray(headerLen + i * 4112, headerLen + i * 4112 + len);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce(i, i === n - 1) }, keys.pay, ct));
    assert.ok(same(pt.subarray(0, Math.max(0, Math.min(4096, 10000 - i * 4096))), data.subarray(i * 4096, Math.min(10000, (i + 1) * 4096))));
  }
  const h = C.parseHeader(file);
  assert.equal(h.headerLen, headerLen);
  assert.deepEqual(h.metaNonce, metaNonce);
  assert.deepEqual(h.mac, file.subarray(macOff, macOff + 32));
  h.streamSalt[0] ^= 1;
  assert.deepEqual(file.subarray(12, 28), streamSalt, 'parseHeader copies');
});

test('an independently built container opens with the real reader', async () => {
  const data = rnd(9000);
  const { file } = await craft({ data, meta: { v: 1, name: 'ok.bin', type: 'application/octet-stream', size: 9000 } });
  const { pt, opened } = await open(file);
  assert.ok(same(pt, data));
  assert.equal(opened.meta.name, 'ok.bin');
});

// ---- writer rules ------------------------------------------------------------------------------

test('encryptStream always uses a fresh fileKey, streamSalt and metaNonce (key/salt options are ignored)', async () => {
  const pk = await passKekFor('pw');
  const data = rnd(5000);
  const run = () => collect(C.encryptStream(pieces(data), {
    size: data.length, meta: { name: 'n' }, chunkExp: 12, stanzasFor: async (fk) => [await C.passStanza(fk, pk)],
    fileKey: new Uint8Array(32), streamSalt: new Uint8Array(16),
  }));
  const a = await run();
  const b = await run();
  const ha = C.parseHeader(a);
  const hb = C.parseHeader(b);
  assert.notDeepEqual(ha.streamSalt, hb.streamSalt);
  assert.notDeepEqual(ha.streamSalt, new Uint8Array(16));
  assert.notDeepEqual(ha.metaNonce, hb.metaNonce);
  assert.ok(!same(a.subarray(ha.headerLen), b.subarray(hb.headerLen)));
  let seen = null;
  await collect(C.encryptStream(pieces(data), { size: data.length, meta: {}, chunkExp: 12, stanzasFor: async (fk) => { seen = fk; return [await C.passStanza(fk, pk)]; } }));
  assert.ok(seen.every((x) => x === 0), 'raw fileKey wiped after use');
});

test('metaNonce is random even when fileKey and streamSalt repeat (_encryptStreamWith)', async () => {
  const pk = await passKekFor('pw');
  const fileKey = rnd(32);
  const streamSalt = rnd(16);
  const nonces = new Set();
  for (let i = 0; i < 4; i++) {
    const f = await collect(C._encryptStreamWith([new Uint8Array(10)], {
      size: 10, meta: { name: 'same' }, chunkExp: 12, fileKey, streamSalt, stanzasFor: async (fk) => [await C.passStanza(fk, pk)],
    }));
    nonces.add(toHex(C.parseHeader(f).metaNonce));
  }
  assert.equal(nonces.size, 4);
});

test('no app module except container.js references _encryptStreamWith', () => {
  for (const f of listFiles('app')) {
    if (f === 'app/crypto/container.js') continue;
    assert.ok(!readFileSync(path.join(ROOT, f), 'utf8').includes('_encryptStreamWith'), f);
  }
});

test('writer: source size checks, stanza rules, meta rules, argument errors', async () => {
  const pk = await passKekFor('pw');
  const st = async (fk) => [await C.passStanza(fk, pk)];
  const enc = (src, o) => collect(C.encryptStream(src, { size: 10, meta: {}, chunkExp: 12, stanzasFor: st, ...o }));
  await assert.rejects(enc([new Uint8Array(11)]), code('source-larger-than-size'));
  await assert.rejects(enc([new Uint8Array(9)]), code('source-size-mismatch'));
  await assert.rejects(enc([new Uint8Array(10)], { stanzasFor: async () => [] }), code('bad-stanza-count'));
  await assert.rejects(enc([new Uint8Array(10)], { stanzasFor: async (fk) => [await st(fk), await st(fk), await st(fk)].flat() }), code('too-many-stanzas'));
  await assert.rejects(enc([new Uint8Array(10)], { stanzasFor: async () => Array.from({ length: 5 }, () => ({ type: 9, body: new Uint8Array(4) })) }), code('too-many-stanzas'));
  await assert.rejects(enc([new Uint8Array(10)], { stanzasFor: async () => [{ type: C.ST_PASS, body: new Uint8Array(85) }] }), code('bad-stanza'));
  await assert.rejects(enc([new Uint8Array(10)], { meta: { name: 'x'.repeat(70000) } }), code('bad-meta'));
  await assert.rejects(enc([new Uint8Array(10)], { meta: { type: C.BUNDLE_TYPE, entries: [{ name: 'a', size: 9, off: 0 }] } }), code('bad-meta'));
  await assert.rejects(enc([new Uint8Array(10)], { size: -1 }), TypeError);
  await assert.rejects(enc([new Uint8Array(10)], { chunkExp: 11 }), TypeError);
  await assert.rejects(enc([new Uint8Array(10)], { stanzasFor: undefined }), TypeError);
  await assert.rejects(enc(42), TypeError);
  await assert.rejects(C.makePassKek('   ', FAST), TypeError);
  await assert.rejects(C.passStanza(new Uint8Array(31), pk), TypeError);
  await assert.rejects(C.vaultStanza(rnd(32), pk.kek, rnd(15), rnd(16)), TypeError);
});

test('writer accepts Blob, ByteSource and sync iterables as the source', async () => {
  const data = rnd(20000);
  const pk = await passKekFor('pw');
  const opts = { size: data.length, meta: {}, chunkExp: 12, stanzasFor: async (fk) => [await C.passStanza(fk, pk)] };
  for (const src of [new Blob([data]), bytesSource(data), [data.subarray(0, 7), data.subarray(7)]]) {
    const f = await collect(C.encryptStream(src, opts));
    assert.ok(same((await open(f)).pt, data));
  }
});

test('abort: encryptStream, decryptStream and openHeader stop with CzdError("aborted")', async () => {
  const ac = new AbortController();
  ac.abort();
  const pk = await passKekFor('pw');
  await assert.rejects(collect(C.encryptStream([new Uint8Array(10)], { size: 10, meta: {}, signal: ac.signal, stanzasFor: async (fk) => [await C.passStanza(fk, pk)] })), code('aborted'));
  const f = await seal(rnd(10000));
  await assert.rejects(C.openHeader(f, { passphrase: 'pw', signal: ac.signal }), code('aborted'));
  const o = await C.openHeader(f, { passphrase: 'pw' });
  await assert.rejects(collect(C.decryptStream([f.subarray(o.headerLen)], o, { signal: ac.signal })), code('aborted'));
  await assert.rejects(C.verifySource(bytesSource(f), o, { signal: ac.signal }), code('aborted'));
});

// ---- helpers ----------------------------------------------------------------------------------

test('padme: spec formula, exact near 2^53, bounded overhead', () => {
  for (let L = 0; L < 5000; L++) assert.equal(C.padme(L), padmeRef(L), String(L));
  for (const L of [65535, 65536, 65537, 1e6, 17039359, 2 ** 31 - 1, 2 ** 31, 2 ** 31 + 1, 2 ** 40 + 12345]) assert.equal(C.padme(L), padmeRef(L), String(L));
  assert.equal(C.padme(17039359), 17301504);
  for (let E = 2; E <= 53; E++) {
    const L = 2 ** E - 1;
    const p = C.padme(L);
    assert.ok(p >= L && p - L <= L * 0.12 + 1, `2^${E}-1`);
    const mask = 2 ** (E - 1 - (Math.floor(Math.log2(E - 1)) + 1)) - 1;
    assert.equal(p % (mask + 1), 0, `2^${E}-1 aligned`);
  }
  assert.ok(C.padme(Number.MAX_SAFE_INTEGER) >= Number.MAX_SAFE_INTEGER);
  assert.throws(() => C.padme(-1), TypeError);
  assert.throws(() => C.padme(1.5), TypeError);
});

test('containerSize, isCzd2, constants', () => {
  assert.equal(C.containerSize(0, 18, 400), 416);
  assert.equal(C.containerSize(17039359, 18, 425), 425 + 17301504 + 16 * 66);
  assert.equal(C.containerSize(262144, 18, 0), 262144 + 16);
  assert.equal(C.isCzd2(C.MAGIC), true);
  assert.equal(C.isCzd2(concat(C.MAGIC, new Uint8Array(4))), true);
  assert.equal(C.isCzd2(C.MAGIC.subarray(0, 7)), false);
  assert.equal(C.isCzd2(utf8('{"v":1,"type"')), false);
  assert.equal(C.isCzd2(null), false);
  assert.equal(C.BUNDLE_TYPE, 'application/x-czd-bundle');
  assert.equal(C.LIMITS.maxStanzas, 4);
  assert.equal(C.LIMITS.maxPassStanzas, 2);
  assert.equal(C.LIMITS.maxVaultStanzas, 1);
  assert.equal(C.LIMITS.metaLenMin, 272);
  assert.equal(C.LIMITS.metaLenMax, 2 ** 20 + 16);
});

test('padme-induced extra chunk: the last chunk holds only padding (size 65·CS − 1, CS = 4 KiB)', async () => {
  const size = 65 * 4096 - 1;
  assert.equal(C.padme(size), 66 * 4096);
  const data = rnd(size);
  const f = await seal(data);
  const { pt, opened } = await open(f);
  assert.equal(opened.n, 66);
  assert.ok(same(pt, data));
  const src = bytesSource(f);
  assert.ok(same(await C.decryptRange(src, opened, size - 10, size - 1), data.subarray(size - 10)));
  // Dropping the padding-only final chunk is still detected.
  await assert.rejects(open(f.subarray(0, f.length - (4096 + 16))), code('truncated'));
});

test('readHeaderBytes reads exactly the header (also when it is larger than the first read)', async () => {
  const f = await seal(rnd(3000));
  const h = await C.readHeaderBytes(bytesSource(f));
  assert.equal(h.length, C.parseHeader(f).headerLen);
  const entries = Array.from({ length: 2000 }, (_, i) => ({ name: `file-${i}-${'n'.repeat(60)}.bin`, type: 'application/octet-stream', size: 1 }));
  const bm = C.bundleMeta(entries);
  const big = await seal(rnd(2000), { meta: bm });
  const hb = await C.readHeaderBytes(blobSource(new Blob([big])));
  assert.ok(hb.length > 8192);
  assert.equal(hb.length, C.parseHeader(big).headerLen);
  const opened = await C.openSource(bytesSource(big), { passphrase: 'pw' });
  assert.equal(opened.meta.entries.length, 2000);
  await assert.rejects(C.readHeaderBytes(bytesSource(f.subarray(0, 20))), code('short-header'));
  await assert.rejects(C.readHeaderBytes(bytesSource(f.subarray(0, h.length - 1))), code('short-header'));
  await assert.rejects(C.readHeaderBytes(bytesSource(new Uint8Array(0))), code('short-header'));
  await assert.rejects(C.readHeaderBytes(bytesSource(utf8('PK\u0003\u0004 zip file'))), code('not-czd2'));
  await assert.rejects(C.readHeaderBytes({}), TypeError);
});

test('openSource: size check against the source length; blob sources', async () => {
  const data = rnd(30000);
  const f = await seal(data);
  const o = await C.openSource(blobSource(new Blob([f])), { passphrase: 'pw' });
  assert.equal(o.size, 30000);
  assert.ok(same(await collect(C.decryptSource(blobSource(new Blob([f])), o)), data));
  await assert.rejects(C.openSource(bytesSource(concat(f, new Uint8Array(1))), { passphrase: 'pw' }), code('size-mismatch'));
  await assert.rejects(C.openSource(bytesSource(f.subarray(0, f.length - 1)), { passphrase: 'pw' }), code('size-mismatch'));
});

test('release drops the keys; later decrypts throw', async () => {
  const f = await seal(rnd(100));
  const o = await C.openSource(bytesSource(f), { passphrase: 'pw' });
  assert.equal(o.fileKey.length, 32, 'raw fileKey kept for the desktop stream');
  const fk = o.fileKey;
  C.release(o);
  assert.equal(o.keys, null);
  assert.equal(o.fileKey, null);
  assert.ok(fk.every((x) => x === 0), 'fileKey zero-filled');
  // A released Opened means a lock raced the decrypt: a silent cancellation, not a damaged file.
  await assert.rejects(C.decryptRange(bytesSource(f), o, 0, 1), code('aborted'));
  await assert.rejects(collect(C.decryptSource(bytesSource(f), o)), code('aborted'));
  await assert.rejects(collect(C.decryptStream([f.subarray(o.headerLen)], o)), code('aborted'));
  await assert.rejects(C.decryptRange(bytesSource(f), null, 0, 1), TypeError, 'not an Opened at all');
  await assert.rejects(C.decryptRange(bytesSource(f), {}, 0, 1), TypeError, 'not an Opened at all');
  C.release(null);
});

test('verifySource: authenticates everything, reports progress, catches tampering', async () => {
  const data = rnd(40000);
  const f = await seal(data);
  const o = await C.openSource(bytesSource(f), { passphrase: 'pw' });
  const progress = [];
  assert.equal(await C.verifySource(bytesSource(f), o, { onProgress: (d, t) => progress.push([d, t]) }), true);
  assert.deepEqual(progress.at(-1), [40000, 40000]);
  const g = f.slice();
  g[g.length - 30] ^= 1;
  await assert.rejects(C.verifySource(bytesSource(g), o), code('truncated-or-corrupt'));
  const g2 = f.slice();
  g2[o.headerLen + 5] ^= 1;
  await assert.rejects(C.verifySource(bytesSource(g2), o), code('chunk-auth'));
});

// ---- decryptRange --------------------------------------------------------------------------------

test('decryptRange: chunk boundaries and 300 random ranges match the full decrypt', async () => {
  const size = 3 * 4096 * 7 + 1234;
  const data = rnd(size);
  const f = await seal(data);
  const src = bytesSource(f);
  const o = await C.openSource(src, { passphrase: 'pw' });
  const check = async (a, b) => assert.ok(same(await C.decryptRange(src, o, a, b), data.subarray(a, b + 1)), `${a}..${b}`);
  const CS = 4096;
  for (const [a, b] of [[0, 0], [0, size - 1], [CS - 1, CS - 1], [CS - 1, CS], [CS, CS], [CS, 2 * CS - 1], [CS + 1, 3 * CS + 1], [size - 1, size - 1], [0, CS - 1], [2 * CS - 1, 5 * CS]]) await check(a, b);
  let seed = 12345;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
  for (let i = 0; i < 300; i++) {
    const a = rand(size);
    const b = Math.min(size - 1, a + rand(i % 3 === 0 ? 3 * CS : 300));
    await check(a, b);
  }
  for (const [a, b] of [[-1, 2], [2, 1], [0, size], [0.5, 2], [size, size]]) await assert.rejects(C.decryptRange(src, o, a, b), RangeError, `${a}..${b}`);
  // Tampering one chunk breaks only ranges that touch it.
  const g = f.slice();
  g[o.headerLen + 2 * (CS + 16) + 7] ^= 1;
  const gs = bytesSource(g);
  assert.ok(same(await C.decryptRange(gs, o, 0, 2 * CS - 1), data.subarray(0, 2 * CS)));
  await assert.rejects(C.decryptRange(gs, o, 2 * CS - 1, 2 * CS), code('chunk-auth'));
});

test('decryptRange on an empty container is always out of range', async () => {
  const f = await seal(new Uint8Array(0));
  const o = await C.openSource(bytesSource(f), { passphrase: 'pw' });
  await assert.rejects(C.decryptRange(bytesSource(f), o, 0, 0), RangeError);
  assert.equal((await collect(C.decryptSource(bytesSource(f), o))).length, 0);
});

// ---- bundles -----------------------------------------------------------------------------------

test('bundleMeta: offsets, sizes, name; limits', () => {
  const m = C.bundleMeta([{ name: 'a.jpg', type: 'image/jpeg', size: 5, mtime: 1 }, { name: 'b.txt', type: 'text/plain', size: 0 }, { name: 'c', type: 'x/y', size: 7 }]);
  assert.deepEqual(m, {
    v: 1, name: '3 files', type: C.BUNDLE_TYPE, size: 12,
    entries: [{ name: 'a.jpg', type: 'image/jpeg', size: 5, off: 0, mtime: 1 }, { name: 'b.txt', type: 'text/plain', size: 0, off: 5 }, { name: 'c', type: 'x/y', size: 7, off: 5 }],
  });
  assert.throws(() => C.bundleMeta([]), code('bad-meta'));
  assert.throws(() => C.bundleMeta(Array.from({ length: 2001 }, () => ({ name: 'a', type: 'a/b', size: 1 }))), code('bad-meta'));
  assert.throws(() => C.bundleMeta([{ name: 'a', size: -1 }]), TypeError);
  assert.equal(C.bundleMeta(Array.from({ length: 2000 }, () => ({ name: 'a', type: 'a/b', size: 1 }))).entries.length, 2000);
});

test('bundle: 3 entries round trip; decryptSource({entry}) and decryptRange per entry', async () => {
  const parts = [rnd(5000), rnd(0), rnd(13000), rnd(1)];
  const entries = parts.map((p, i) => ({ name: `f${i}.bin`, type: 'application/octet-stream', size: p.length, mtime: 1600000000000 + i }));
  const meta = C.bundleMeta(entries);
  const data = concat(...parts);
  const f = await seal(data, { meta });
  const src = bytesSource(f);
  const o = await C.openSource(src, { passphrase: 'pw' });
  assert.equal(o.isBundle, true);
  assert.equal(o.meta.type, C.BUNDLE_TYPE);
  assert.equal(o.meta.name, '4 files');
  assert.deepEqual(o.meta.entries.map((e) => [e.name, e.size, e.off, e.mtime]), entries.map((e, i) => [e.name, e.size, meta.entries[i].off, e.mtime]));
  for (const [i, e] of o.meta.entries.entries()) {
    const got = await collect(C.decryptSource(src, o, { entry: e }));
    assert.ok(same(got, parts[i]), `entry ${i} stream`);
    if (e.size > 0) assert.ok(same(await C.decryptRange(src, o, e.off, e.off + e.size - 1), parts[i]), `entry ${i} range`);
  }
  assert.ok(same(await collect(C.decryptSource(src, o)), data), 'whole payload');
  await assert.rejects(collect(C.decryptSource(src, o, { entry: { off: 18000, size: 5 } })), RangeError);
  await assert.rejects(collect(C.decryptSource(src, o, { entry: { off: -1, size: 5 } })), RangeError);
  const single = await seal(rnd(10));
  assert.equal((await C.openSource(bytesSource(single), { passphrase: 'pw' })).isBundle, false);
});

// ---- performance (KDF excluded) ------------------------------------------------------------------

test('throughput: 64 MiB encrypt and decrypt ≥ 150 MiB/s in Node (default 256 KiB chunks, KDF excluded)', async (t) => {
  const size = 64 * 2 ** 20;
  const data = new Uint8Array(size);
  for (let o = 0; o < size; o += 65536) crypto.getRandomValues(data.subarray(o, o + 65536));
  const pk = await passKekFor('pw');
  let t0 = performance.now();
  const f = await collect(C.encryptStream(pieces(data, 1 << 20), { size, meta: { name: 'big.bin' }, stanzasFor: async (fk) => [await C.passStanza(fk, pk)] }));
  const encMs = performance.now() - t0;
  const src = bytesSource(f);
  const o = await C.openSource(src, { passphrase: 'pw' }); // KEK comes from the derived-key cache
  t0 = performance.now();
  let n = 0;
  for await (const pt of C.decryptSource(src, o)) n += pt.length;
  const decMs = performance.now() - t0;
  assert.equal(n, size);
  const enc = 64 / (encMs / 1000);
  const dec = 64 / (decMs / 1000);
  assert.ok(enc >= 150, `encrypt ${enc.toFixed(0)} MiB/s`);
  assert.ok(dec >= 150, `decrypt ${dec.toFixed(0)} MiB/s`);
  t.diagnostic(`czd2 throughput: encrypt ${enc.toFixed(0)} MiB/s, decrypt ${dec.toFixed(0)} MiB/s`);
});
