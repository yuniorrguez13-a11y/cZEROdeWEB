// czd2 reader validation (DESIGN §3.3 "Reader validation"): every rule, the stanza limits, the
// confirmKdf flow, and the hostile-metadata cases from the design review. Containers are crafted with an
// independent builder (container-helpers.js) that recomputes a valid MAC, so only validation can catch them.
import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as C from '../../app/crypto/container.js';
import * as K from '../../app/crypto/kdf.js';
import { CzdError } from '../../app/errors.js';
import { bytesSource, collect } from '../../app/util/stream.js';
import { concat, u32, utf8 } from '../../app/util/bytes.js';
import { FAST, craft, metaPT, open, passKekFor, rawPassStanza, rnd, same, seal } from './container-helpers.js';

const code = (c) => (e) => {
  assert.ok(e instanceof CzdError, `expected CzdError(${c}), got ${e?.name}: ${e?.message}`);
  assert.equal(e.code, c, `expected ${c}, got ${e.code} (${JSON.stringify(e.detail)})`);
  return true;
};
const OCTET = 'application/octet-stream';

/** Deterministic fake Argon2 that counts runs (output = SHA-256(pw|salt|params)). */
let runs = 0;
function fakeBits(pw, salt, prm) {
  return new Uint8Array(createHash('sha256').update(pw).update(salt).update(`${prm.m},${prm.t},${prm.p}`).digest());
}
async function fakeKek(pass, salt, prm) {
  return crypto.subtle.importKey('raw', fakeBits(K.passphraseBytes(pass), salt, prm), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
beforeEach(() => {
  runs = 0;
  K.clearKdfCache();
});
afterEach(() => {
  K.__setArgon2ForTests(null);
  K.clearKdfCache();
});
function useFakeArgon() {
  K.__setArgon2ForTests((pw, salt, prm) => { runs++; return fakeBits(pw, salt, prm); });
}

async function openMeta(meta, extra = {}) {
  const size = Number.isSafeInteger(meta?.size) && meta.size >= 0 && meta.size < 1e6 ? meta.size : 0;
  const { file } = await craft({ data: rnd(size), size, json: JSON.stringify(meta), ...extra });
  return (await C.openHeader(file, { passphrase: 'pw' })).meta;
}

// ---- structure (checked before any KDF) ------------------------------------------------------

test('version, flags, chunkExp, stanza count, stanza lengths, metaLen', async () => {
  useFakeArgon();
  const fk = rnd(32);
  const salt = rnd(16);
  const pass = await rawPassStanza({ fileKey: fk, kek: await fakeKek('pw', salt, FAST), salt });
  const unknown = (len = 8) => ({ type: 7, body: rnd(len) });
  const cases = [
    [{ version: 1 }, 'unsupported-version'], [{ version: 3 }, 'unsupported-version'],
    [{ flags: 1 }, 'unknown-flags'], [{ flags: 0x80 }, 'unknown-flags'],
    [{ chunkExp: 11 }, 'bad-chunk-size'], [{ chunkExp: 25 }, 'bad-chunk-size'], [{ chunkExp: 0 }, 'bad-chunk-size'],
    [{ stanzas: [], k: 0 }, 'bad-stanza-count'],
    [{ stanzas: [pass, unknown(), unknown(), unknown(), unknown()] }, 'too-many-stanzas'],
    [{ stanzas: [pass, pass, pass] }, 'too-many-stanzas'],
    [{ stanzas: [pass, { type: 2, body: rnd(92) }, { type: 2, body: rnd(92) }] }, 'too-many-stanzas'],
    [{ stanzas: [{ type: 1, body: rnd(85) }] }, 'bad-stanza'], [{ stanzas: [{ type: 1, body: rnd(87) }] }, 'bad-stanza'],
    [{ stanzas: [pass, { type: 2, body: rnd(91) }] }, 'bad-stanza'], [{ stanzas: [pass, unknown(1025)] }, 'bad-stanza'],
    [{ metaLen: 16 }, 'bad-meta'], [{ metaLen: 0 }, 'bad-meta'], [{ metaLen: 271 }, 'bad-meta'], [{ metaLen: 273 }, 'bad-meta'],
    [{ metaLen: 2 ** 20 + 16 + 256 }, 'bad-meta'], [{ metaLen: 0xffffffff }, 'bad-meta'],
  ];
  for (const [o, c] of cases) {
    const { file } = await craft({ fileKey: fk, stanzas: [pass], ...o });
    await assert.rejects(C.openHeader(file, { passphrase: 'pw' }), code(c), JSON.stringify(Object.keys(o)) + JSON.stringify(o.version ?? o.flags ?? o.chunkExp ?? o.metaLen ?? ''));
    assert.throws(() => C.parseHeader(file), code(c));
  }
  assert.equal(runs, 0, 'no KDF ran for any structural error');
});

test('every truncation of a header is a CzdError (short-header / not-czd2), never RangeError', async () => {
  const f = await seal(rnd(100));
  const { headerLen } = C.parseHeader(f);
  for (let len = 0; len < headerLen; len++) {
    assert.throws(() => C.parseHeader(f.subarray(0, len)), code('short-header'), String(len));
    await assert.rejects(C.openHeader(f.subarray(0, len), { passphrase: 'pw' }), code('short-header'));
  }
  assert.throws(() => C.parseHeader(utf8('\u0089CZ')), code('not-czd2'));
  assert.throws(() => C.parseHeader(utf8('GIF89a')), code('not-czd2'));
  assert.throws(() => C.parseHeader('not bytes'), TypeError);
});

test('a declared stanza count larger than the stanzas present is rejected', async () => {
  const { file } = await craft({ k: 2 });
  await assert.rejects(C.openHeader(file, { passphrase: 'pw' }), (e) => e instanceof CzdError);
});

// ---- stanza semantics --------------------------------------------------------------------------

test('unknown stanza types are skipped; only unknown → no-usable-stanza', async () => {
  const fileKey = rnd(32);
  const pass = await C.passStanza(fileKey, await passKekFor('pw'));
  const { file } = await craft({ fileKey, stanzas: [{ type: 3, body: rnd(32) }, pass], data: rnd(10) });
  assert.equal((await open(file)).pt.length, 10);
  const { file: f2 } = await craft({ fileKey, stanzas: [{ type: 3, body: rnd(32) }] });
  await assert.rejects(C.openHeader(f2, { passphrase: 'pw' }), code('no-usable-stanza'));
});

test('unknown kdfId → unsupported-kdf (unless another pass stanza works)', async () => {
  useFakeArgon();
  const fileKey = rnd(32);
  const salt = rnd(16);
  const kek = await fakeKek('pw', salt, FAST);
  const bad = await rawPassStanza({ fileKey, kek, kdfId: 2, salt });
  const good = await rawPassStanza({ fileKey, kek, salt });
  await assert.rejects(C.openHeader((await craft({ fileKey, stanzas: [bad] })).file, { passphrase: 'pw' }), code('unsupported-kdf'));
  assert.equal(runs, 0);
  const o = await C.openHeader((await craft({ fileKey, stanzas: [bad, good] })).file, { passphrase: 'pw' });
  assert.equal(o.via, 'pass');
  assert.deepEqual(o.kdf, FAST);
});

test('two pass stanzas sharing salt+params cost one Argon2; distinct ones at most two', async () => {
  useFakeArgon();
  const fileKey = rnd(32);
  const salt = rnd(16);
  const kekA = await fakeKek('alpha', salt, FAST);
  const kekB = await fakeKek('bravo', salt, FAST);
  // Same salt/params, different passphrases: one Argon2 for the typed passphrase covers both stanzas.
  const { file } = await craft({ fileKey, stanzas: [await rawPassStanza({ fileKey, kek: kekA, salt }), await rawPassStanza({ fileKey, kek: kekB, salt })] });
  assert.equal((await C.openHeader(file, { passphrase: 'bravo' })).via, 'pass');
  assert.equal(runs, 1);
  K.clearKdfCache();
  runs = 0;
  await assert.rejects(C.openHeader(file, { passphrase: 'charlie' }), code('wrong-passphrase'));
  assert.equal(runs, 1);
  // Different salts: wrong passphrase → exactly two runs; first stanza right → one run.
  const s2 = rnd(16);
  const { file: f2 } = await craft({ fileKey, stanzas: [await rawPassStanza({ fileKey, kek: kekA, salt }), await rawPassStanza({ fileKey, kek: await fakeKek('bravo', s2, FAST), salt: s2 })] });
  K.clearKdfCache();
  runs = 0;
  await assert.rejects(C.openHeader(f2, { passphrase: 'charlie' }), code('wrong-passphrase'));
  assert.equal(runs, 2);
  K.clearKdfCache();
  runs = 0;
  await C.openHeader(f2, { passphrase: 'alpha' });
  assert.equal(runs, 1);
  K.clearKdfCache();
  runs = 0;
  await C.openHeader(f2, { passphrase: 'bravo' });
  assert.equal(runs, 2);
});

test('checkParams runs for every pass stanza before any Argon2', async () => {
  useFakeArgon();
  const fileKey = rnd(32);
  const salt = rnd(16);
  const ok = await rawPassStanza({ fileKey, kek: await fakeKek('pw', salt, FAST), salt });
  const huge = await rawPassStanza({ fileKey, kek: await fakeKek('pw', salt, FAST), m: 0xffffffff, salt: rnd(16) });
  const slow = await rawPassStanza({ fileKey, kek: await fakeKek('pw', salt, FAST), m: 1048576, t: 16, salt: rnd(16) });
  for (const stanzas of [[ok, huge], [huge, ok], [ok, slow]]) {
    await assert.rejects(C.openHeader((await craft({ fileKey, stanzas })).file, { passphrase: 'pw', confirmKdf: () => true }), code('kdf-params-out-of-range'));
  }
  const p0 = await rawPassStanza({ fileKey, kek: await fakeKek('pw', salt, FAST), p: 0, salt });
  await assert.rejects(C.openHeader((await craft({ fileKey, stanzas: [p0] })).file, { passphrase: 'pw' }), code('kdf-params-out-of-range'));
  assert.equal(runs, 0);
});

test('confirmKdf flow: costly params ask first; decline → kdf-declined; no callback → refused', async () => {
  useFakeArgon();
  const fileKey = rnd(32);
  const salt = rnd(16);
  const big = { m: 262144, t: 4, p: 1 };
  const stanza = await rawPassStanza({ fileKey, kek: await fakeKek('pw', salt, big), salt, ...big });
  const { file } = await craft({ fileKey, stanzas: [stanza], data: rnd(5) });
  await assert.rejects(C.openHeader(file, { passphrase: 'pw' }), code('kdf-params-out-of-range'));
  const asked = [];
  await assert.rejects(C.openHeader(file, { passphrase: 'pw', confirmKdf: (p) => { asked.push(p); return false; } }), code('kdf-declined'));
  assert.equal(runs, 0);
  assert.equal(asked[0].mib, 256);
  assert.equal(asked[0].t, 4);
  const o = await C.openHeader(file, { passphrase: 'pw', confirmKdf: async () => true });
  assert.equal(runs, 1);
  assert.deepEqual(o.kdf, big);
  assert.equal(o.size, 5);
});

test('vault option: itemId mandatory, ids compared unconditionally, wrong key, stanza mix', async () => {
  const vaultId = rnd(16);
  const itemId = rnd(16);
  const wrapKey = await crypto.subtle.importKey('raw', rnd(32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const pk = await passKekFor('pw');
  const vaultOnly = await seal(rnd(100), { stanzasFor: async (fk) => [await C.vaultStanza(fk, wrapKey, vaultId, itemId)] });
  const both = await seal(rnd(100), { stanzasFor: async (fk) => [await C.vaultStanza(fk, wrapKey, vaultId, itemId), await C.passStanza(fk, pk)] });
  const passOnly = await seal(rnd(100));
  const v = { wrapKey, vaultId, itemId };
  await assert.rejects(C.openHeader(vaultOnly, { vault: { wrapKey, vaultId } }), TypeError);
  await assert.rejects(C.openHeader(vaultOnly, { vault: { wrapKey, vaultId, itemId: rnd(15) } }), TypeError);
  await assert.rejects(C.openHeader(vaultOnly, { vault: { vaultId, itemId } }), TypeError);
  await assert.rejects(C.openHeader(vaultOnly, {}), TypeError);
  await assert.rejects(C.openHeader(vaultOnly, { passphrase: 5 }), TypeError);
  assert.equal((await C.openHeader(vaultOnly, { vault: v })).via, 'vault');
  await assert.rejects(C.openHeader(vaultOnly, { vault: { ...v, vaultId: rnd(16) } }), code('other-vault'));
  await assert.rejects(C.openHeader(vaultOnly, { vault: { ...v, itemId: rnd(16) } }), code('item-mismatch'));
  const otherKey = await crypto.subtle.importKey('raw', rnd(32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  await assert.rejects(C.openHeader(vaultOnly, { vault: { ...v, wrapKey: otherKey } }), code('vault-unwrap-failed'));
  await assert.rejects(C.openHeader(vaultOnly, { passphrase: 'pw' }), code('no-usable-stanza'));
  await assert.rejects(C.openHeader(passOnly, { vault: v }), code('no-usable-stanza'));
  assert.equal((await C.openHeader(both, { vault: v })).via, 'vault');
  assert.equal((await C.openHeader(both, { passphrase: 'pw' })).via, 'pass');
  assert.equal((await C.openHeader(both, { passphrase: 'pw', vault: { ...v, itemId: rnd(16) } })).via, 'pass', 'falls back to the passphrase');
  await assert.rejects(C.openHeader(vaultOnly, { passphrase: 'pw', vault: { ...v, itemId: rnd(16) } }), code('item-mismatch'));
});

test('empty passphrase never runs Argon2 → wrong-passphrase', async () => {
  const f = await seal(rnd(10));
  useFakeArgon();
  await assert.rejects(C.openHeader(f, { passphrase: '' }), code('wrong-passphrase'));
  await assert.rejects(C.openHeader(f, { passphrase: ' \t ' }), code('wrong-passphrase'));
  assert.equal(runs, 0);
});

test('passphrase canonicalization: spaces at the ends and NFD vs NFC do not matter; case does', async () => {
  const f = await seal(rnd(10), { pass: 'Caf\u00e9  au lait' });
  await C.openHeader(f, { passphrase: '  Cafe\u0301 au   lait ' });
  await assert.rejects(C.openHeader(f, { passphrase: 'café au lait' }), code('wrong-passphrase'));
});

// ---- MAC before metadata ---------------------------------------------------------------------

test('header MAC is checked before the metadata; valid MAC + bad metaCT → meta-auth', async () => {
  const { file } = await craft({ macOverride: rnd(32) });
  await assert.rejects(C.openHeader(file, { passphrase: 'pw' }), code('header-mac'));
  const { file: f2 } = await craft({ tamperMetaCT: true });
  await assert.rejects(C.openHeader(f2, { passphrase: 'pw' }), code('meta-auth'));
  const { file: f3 } = await craft({ metaNonce: new Uint8Array(12) });
  assert.equal((await C.openHeader(f3, { passphrase: 'pw' })).size, 0, 'any metaNonce value is fine for the reader');
});

// ---- metadata ------------------------------------------------------------------------------------

test('metaPT framing: jsonLen bound, zero tail, UTF-8, JSON, plain object', async () => {
  const json = utf8('{"v":1,"name":"a","type":"a/b","size":0}');
  const tooLong = metaPT(json);
  tooLong.set(u32(253));
  const tail = metaPT(json);
  tail[200] = 1;
  const badUtf8 = metaPT(concat(utf8('{"name":"'), new Uint8Array([0xff, 0xfe]), utf8('","size":0}')));
  const notJson = metaPT(utf8('{"size":0'));
  for (const m of [tooLong, tail, badUtf8, notJson]) await assert.rejects(C.openHeader((await craft({ metaPT: m })).file, { passphrase: 'pw' }), code('bad-meta'));
  for (const j of ['null', '[]', '[{"size":0}]', '"str"', '42', 'true', '']) {
    await assert.rejects(C.openHeader((await craft({ json: j })).file, { passphrase: 'pw' }), code('bad-meta'), j);
  }
  const exactFit = metaPT(json, 256);
  assert.equal((await C.openHeader((await craft({ metaPT: exactFit })).file, { passphrase: 'pw' })).meta.name, 'a');
});

test('size: safe integer ≥ 0 required; 2^53−1 in a tiny file → size-mismatch; length checked by openSource', async () => {
  for (const size of [undefined, null, -1, 1.5, '10', 2 ** 53, Infinity, [1]]) {
    const { file } = await craft({ json: JSON.stringify({ v: 1, name: 'n', type: 'a/b', size }) });
    await assert.rejects(C.openHeader(file, { passphrase: 'pw' }), code('bad-meta'), String(size));
  }
  const { file } = await craft({ json: JSON.stringify({ v: 1, name: 'a\u202egpj.exe', type: 'text/html', kind: 'video', size: Number.MAX_SAFE_INTEGER }) });
  assert.ok(file.length < 1000);
  await assert.rejects(C.openHeader(file, { passphrase: 'pw' }), code('size-mismatch'));
  await assert.rejects(C.openSource(bytesSource(file), { passphrase: 'pw' }), code('size-mismatch'));
  // A plausible size that does not match the bytes present.
  const { file: f2 } = await craft({ data: rnd(50), json: JSON.stringify({ v: 1, name: 'n', type: 'a/b', size: 100000 }) });
  await C.openHeader(f2, { passphrase: 'pw' });
  await assert.rejects(C.openSource(bytesSource(f2), { passphrase: 'pw' }), code('size-mismatch'));
});

test('names are sanitized (RLO, separators, controls, non-strings)', async () => {
  const names = ['a\u202egpj.exe', '../../etc/passwd', 'C:\\Windows\\x.dll', 'ok\u0000\u0007\u001f\u009f.txt', '\u200bzw\u200f.png', 'CON', 'x'.repeat(5000) + '.jpg', '', '   ...   '];
  for (const name of names) {
    const meta = await openMeta({ v: 1, name, type: 'a/b', size: 0 });
    assert.equal(typeof meta.name, 'string');
    assert.ok(meta.name.length > 0 && meta.name.length <= 200, JSON.stringify(meta.name));
    assert.ok(!/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff/\\:*?"<>|]/.test(meta.name), JSON.stringify(meta.name));
  }
  for (const name of [123, null, { toString: 'x' }, ['a'], true]) assert.equal(typeof (await openMeta({ v: 1, name, type: 'a/b', size: 0 })).name, 'string');
  assert.equal((await openMeta({ v: 1, name: 'holiday.jpg', type: 'image/jpeg', size: 0 })).name, 'holiday.jpg');
});

test('type: MIME syntax check, lowercased, else application/octet-stream', async () => {
  const cases = [['image/png', 'image/png'], ['IMAGE/PNG', 'image/png'], ['text/html', 'text/html'], ['image/svg+xml', 'image/svg+xml'],
    ['video/x-matroska', 'video/x-matroska'], ['application/vnd.ms-excel', 'application/vnd.ms-excel'],
    ['text/html; charset=utf-8', OCTET], ['', OCTET], ['image/', OCTET], ['/png', OCTET], ['image png', OCTET], ['a/b/c', OCTET],
    [`a/${'b'.repeat(61)}`, OCTET], [`${'a'.repeat(61)}/b`, OCTET], [42, OCTET], [null, OCTET], [undefined, OCTET], ['ima\u0430ge/png', OCTET]];
  for (const [type, want] of cases) assert.equal((await openMeta({ v: 1, name: 'n', type, size: 0 })).type, want, String(type));
});

test('mtime: safe integer in [0, now + 1 day] kept, else dropped; unknown keys ignored', async () => {
  const now = Date.now();
  for (const mtime of [0, 1600000000000, now, now + 3600000]) assert.equal((await openMeta({ v: 1, name: 'n', type: 'a/b', size: 0, mtime })).mtime, mtime);
  for (const mtime of [-1, 1.5, now + 2 * 86400000, '1600000000000', null, Number.MAX_SAFE_INTEGER + 2]) {
    assert.ok(!('mtime' in (await openMeta({ v: 1, name: 'n', type: 'a/b', size: 0, mtime }))), String(mtime));
  }
  const json = '{"v":1,"name":"n","type":"a/b","size":0,"kind":"video","__proto__":{"polluted":true},"constructor":{"x":1},"entries":[1]}';
  const { file } = await craft({ json });
  const meta = (await C.openHeader(file, { passphrase: 'pw' })).meta;
  assert.deepEqual(Object.keys(meta).sort(), ['name', 'size', 'type', 'v']);
  assert.equal({}.polluted, undefined);
});

test('meta JSON size limits: 64 KiB for single files, 1 MiB for bundles', async () => {
  const pad = (n) => {
    const base = JSON.stringify({ v: 1, name: 'n', type: 'a/b', size: 0, x: '' });
    return JSON.stringify({ v: 1, name: 'n', type: 'a/b', size: 0, x: 'y'.repeat(n - base.length) });
  };
  assert.equal(pad(65536).length, 65536);
  assert.equal((await C.openHeader((await craft({ json: pad(65536) })).file, { passphrase: 'pw' })).size, 0);
  await assert.rejects(C.openHeader((await craft({ json: pad(65537) })).file, { passphrase: 'pw' }), code('bad-meta'));
  const entries = Array.from({ length: 2000 }, (_, i) => ({ name: `${i}-${'z'.repeat(450)}`, type: 'a/b', size: 1, off: i }));
  const bundleJson = JSON.stringify({ v: 1, name: '2000 files', type: C.BUNDLE_TYPE, size: 2000, entries });
  assert.ok(bundleJson.length > 900000 && bundleJson.length < 2 ** 20 - 4);
  const o = await C.openHeader((await craft({ json: bundleJson, data: rnd(2000) })).file, { passphrase: 'pw' });
  assert.equal(o.meta.entries.length, 2000);
});

test('bundle entries: 1..2000, contiguous offsets from 0, sizes sum to size', async () => {
  const B = (entries, size) => JSON.stringify({ v: 1, name: 'b', type: C.BUNDLE_TYPE, size, entries });
  const e = (size, off, extra = {}) => ({ name: 'e', type: 'a/b', size, off, ...extra });
  const bad = [
    [undefined, 0], [[], 0], ['x', 0], [[null], 0], [[1], 1], [[e(1, 1)], 1], [[e(1, 0), e(1, 0)], 2], [[e(1, 0), e(2, 2)], 3],
    [[e(1, 0), e(1, 1)], 3], [[e(-1, 0)], 0], [[e(1.5, 0)], 1.5], [[e('1', 0)], 1], [Array.from({ length: 2001 }, (_, i) => e(1, i)), 2001],
  ];
  for (const [entries, size] of bad) {
    await assert.rejects(C.openHeader((await craft({ json: B(entries, size), data: rnd(Number.isSafeInteger(size) ? size : 0) })).file, { passphrase: 'pw' }), code('bad-meta'), JSON.stringify(entries)?.slice(0, 80));
  }
  const o = await C.openHeader((await craft({ json: B([e(0, 0, { name: 'a\u202etxt.exe', type: 'TEXT/HTML', mtime: -5 }), e(3, 0), e(0, 3)], 3), data: rnd(3) })).file, { passphrase: 'pw' });
  assert.equal(o.isBundle, true);
  assert.deepEqual(o.meta.entries.map((x) => [x.size, x.off, x.type]), [[0, 0, 'text/html'], [3, 0, 'a/b'], [0, 3, 'a/b']]);
  assert.ok(!o.meta.entries[0].name.includes('\u202e'));
  assert.ok(!('mtime' in o.meta.entries[0]));
  // entries on a non-bundle type are ignored, not trusted.
  const single = await C.openHeader((await craft({ json: JSON.stringify({ v: 1, name: 'n', type: 'a/b', size: 0, entries: [e(5, 0)] }) })).file, { passphrase: 'pw' });
  assert.equal(single.isBundle, false);
  assert.ok(!('entries' in single.meta));
});

// ---- payload ---------------------------------------------------------------------------------

test('payload: final flag only on the last chunk, zero padding, exact end', async () => {
  const data = rnd(9000); // 3 chunks of 4 KiB after padding
  const flagsAll = await craft({ data, chunkFlags: () => true });
  await assert.rejects(open(flagsAll.file), code('chunk-auth'));
  const flagsNone = await craft({ data, chunkFlags: () => false });
  await assert.rejects(open(flagsNone.file), code('truncated-or-corrupt'));
  const padded = new Uint8Array(C.padme(9000));
  padded.set(data);
  padded[padded.length - 1] = 7;
  await assert.rejects(open((await craft({ data, paddedPT: padded })).file), code('bad-padding'));
  const extra = await craft({ data, extraPayload: new Uint8Array(16) });
  await assert.rejects(open(extra.file), code('trailing-data'));
  await assert.rejects(C.openSource(bytesSource(extra.file), { passphrase: 'pw' }), code('size-mismatch'));
  // Padding-only final chunk (size 65·4096 − 1 → 66 chunks) with a non-zero byte in it.
  const size = 65 * 4096 - 1;
  const d2 = rnd(size);
  const p2 = new Uint8Array(C.padme(size));
  p2.set(d2);
  p2[p2.length - 100] = 1;
  const c2 = await craft({ data: d2, paddedPT: p2 });
  await assert.rejects(open(c2.file), code('bad-padding'));
  const src = bytesSource(c2.file);
  const o = await C.openSource(src, { passphrase: 'pw' });
  assert.ok(same(await C.decryptRange(src, o, size - 11, size - 1), d2.subarray(size - 11)), 'random access only checks the chunks it reads');
  // Non-zero padding inside the chunk that holds the last data byte is caught by random access too.
  const p3 = new Uint8Array(C.padme(size));
  p3.set(d2);
  p3[size] = 1;
  const c3 = await craft({ data: d2, paddedPT: p3 });
  const src3 = bytesSource(c3.file);
  const o3 = await C.openSource(src3, { passphrase: 'pw' });
  await assert.rejects(C.decryptRange(src3, o3, size - 1, size - 1), code('bad-padding'));
  await assert.rejects(C.verifySource(src3, o3), code('bad-padding'));
});

// ---- fuzz: anything the reader rejects is a CzdError -------------------------------------------

test('fuzz: 1500 mutated / truncated / random inputs only ever produce CzdError', async () => {
  useFakeArgon();
  const data = rnd(6000);
  const fileKey = rnd(32);
  const salt = rnd(16);
  const { file: f } = await craft({ data, fileKey, stanzas: [await rawPassStanza({ fileKey, kek: await fakeKek('pw', salt, FAST), salt })] });
  assert.ok(same((await open(f)).pt, data));
  const { headerLen } = C.parseHeader(f);
  let seed = 99;
  const rand = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  let rejected = 0;
  for (let i = 0; i < 1500; i++) {
    let g;
    const kind = i % 5;
    if (kind === 0) { g = f.slice(); g[rand(headerLen)] ^= 1 << rand(8); }
    else if (kind === 1) { g = f.slice(); g[rand(g.length)] = rand(256); g[rand(g.length)] = rand(256); }
    else if (kind === 2) g = f.slice(0, rand(f.length));
    else if (kind === 3) g = concat(f.subarray(0, rand(f.length)), rnd(rand(64)), f.subarray(rand(f.length)));
    else g = concat(C.MAGIC, new Uint8Array([2, 0, 12, 1 + rand(4)]), rnd(rand(600)));
    try {
      const src = bytesSource(g);
      const o = await C.openSource(src, { passphrase: 'pw', confirmKdf: () => false });
      await C.verifySource(src, o);
      const pt = await collect(C.decryptSource(src, o));
      assert.ok(same(pt, data), 'a mutation that is accepted must not change the plaintext');
    } catch (e) {
      assert.ok(e instanceof CzdError, `iteration ${i} kind ${kind}: ${e?.name}: ${e?.message}`);
      rejected++;
    }
  }
  assert.ok(rejected > 1400);
});
