// app/util/bytes.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as B from '../../app/util/bytes.js';
import { CzdError } from '../../app/errors.js';

const isCzd = (code) => (e) => e instanceof CzdError && e.code === code;

test('concat joins views and buffers into a new array', () => {
  const a = new Uint8Array([1, 2]);
  const big = new Uint8Array([9, 3, 4, 9]);
  const out = B.concat(a, big.subarray(1, 3), new Uint8Array([5]).buffer, new DataView(new Uint8Array([6]).buffer));
  assert.deepEqual([...out], [1, 2, 3, 4, 5, 6]);
  assert.notEqual(out.buffer, a.buffer);
  assert.equal(B.concat().length, 0);
  assert.throws(() => B.concat('x'), TypeError);
});

test('utf8 / fromUtf8 round trip, BOM kept, fatal by default', () => {
  const s = '﻿hé 日本 😀 ქართ';
  assert.equal(B.fromUtf8(B.utf8(s)), s);
  assert.equal(B.fromUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])), '﻿A');
  assert.throws(() => B.fromUtf8(new Uint8Array([0xc3])), TypeError);
  assert.equal(B.fromUtf8(new Uint8Array([0x41, 0xff]), { fatal: false }), 'A�');
  assert.deepEqual([...B.utf8('\uD800')], [0xef, 0xbf, 0xbd]);
});

test('ascii', () => {
  assert.deepEqual([...B.ascii('cZEROde czd2 pass')], [...Buffer.from('cZEROde czd2 pass', 'latin1')]);
  assert.throws(() => B.ascii('é'), TypeError);
});

test('hex', () => {
  const u = new Uint8Array([0, 1, 0xab, 0xff, 0x10]);
  assert.equal(B.toHex(u), '0001abff10');
  assert.deepEqual([...B.fromHex('0001ABff10')], [...u]);
  assert.equal(B.fromHex('').length, 0);
  for (const bad of ['0', 'zz', '0x00', ' 00', 7]) assert.throws(() => B.fromHex(bad), TypeError);
  const r = B.randomBytes(1000);
  assert.deepEqual(B.fromHex(B.toHex(r)), r);
});

test('base64 standard + url', () => {
  for (let n = 0; n < 70; n++) {
    const r = B.randomBytes(n);
    const b64 = B.toB64(r);
    assert.equal(b64, Buffer.from(r).toString('base64'));
    assert.deepEqual(B.fromB64(b64), r);
    assert.deepEqual(B.fromB64(b64.replace(/=+$/, '')), r, 'padding optional');
    assert.equal(B.toB64url(r), Buffer.from(r).toString('base64url'));
  }
  assert.deepEqual([...B.fromB64(' QU\nJD ')], [65, 66, 67], 'ASCII whitespace ignored');
  assert.deepEqual([...B.fromB64('QR==')], [65], 'non-canonical trailing bits accepted');
  for (const bad of ['Q', 'QUJD=', 'QU=J', 'QU*J', 'QUJDé', 5]) assert.throws(() => B.fromB64(bad), TypeError, String(bad));
  const big = B.randomBytes(300000);
  assert.deepEqual(B.fromB64(B.toB64(big)), big);
});

test('base32 RFC 4648 vectors and tolerant decoding', () => {
  const vectors = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
  for (const [plain, enc] of vectors) {
    assert.equal(B.toBase32(B.utf8(plain)), enc);
    assert.equal(B.fromUtf8(B.fromBase32(enc)), plain);
    assert.equal(B.fromUtf8(B.fromBase32(enc.toLowerCase())), plain);
  }
  const code = B.randomBytes(20);
  const s = B.toBase32(code);
  assert.equal(s.length, 32);
  const grouped = s.match(/.{4}/g).join('-').toLowerCase();
  assert.deepEqual(B.fromBase32(grouped), code);
  assert.deepEqual(B.fromBase32(` ${s.match(/.{4}/g).join(' ')}\n`), code);
  assert.deepEqual(B.fromBase32('MZXW6YQ='), B.utf8('foob'));
  // 0→O, 1→I, 8→B
  assert.deepEqual(B.fromBase32('0I8A'), B.fromBase32('OIBA'));
  assert.deepEqual(B.fromBase32('1'.repeat(8)), B.fromBase32('I'.repeat(8)));
  for (const bad of ['MZ!W', 'MZXW9', 'é', null]) assert.throws(() => B.fromBase32(bad), TypeError);
  for (let n = 0; n < 50; n++) {
    const r = B.randomBytes(n);
    assert.deepEqual(B.fromBase32(B.toBase32(r)), r);
  }
});

test('randomBytes sizes (including > 65536)', () => {
  assert.equal(B.randomBytes(0).length, 0);
  const r = B.randomBytes(200000);
  assert.equal(r.length, 200000);
  assert.ok(r.subarray(150000).some((x) => x !== 0));
});

test('ctEqual and zeroize', () => {
  assert.equal(B.ctEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(B.ctEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(B.ctEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false);
  assert.equal(B.ctEqual(new Uint8Array(0), new Uint8Array(0)), true);
  const z = new Uint8Array([5, 6, 7]);
  B.zeroize(z.subarray(1));
  assert.deepEqual([...z], [5, 0, 0]);
  B.zeroize(null);
  B.zeroize(undefined);
});

test('big-endian integers', () => {
  assert.deepEqual([...B.u16(0x1234)], [0x12, 0x34]);
  assert.deepEqual([...B.u32(0xdeadbeef)], [0xde, 0xad, 0xbe, 0xef]);
  assert.deepEqual([...B.u64(2 ** 40 + 5)], [0, 0, 1, 0, 0, 0, 0, 5]);
  assert.deepEqual([...B.u64(Number.MAX_SAFE_INTEGER)], [0, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  for (const [fn, bad] of [[B.u16, 0x10000], [B.u16, -1], [B.u32, 2 ** 32], [B.u32, 1.5], [B.u64, 2 ** 53], [B.u64, -1]]) {
    assert.throws(() => fn(bad), RangeError);
  }
  const buf = B.concat(new Uint8Array([0xaa]), B.u16(513), B.u32(70000), B.u64(1234567890123));
  assert.equal(B.readU16(buf, 1), 513);
  assert.equal(B.readU32(buf, 3), 70000);
  assert.equal(B.readU64(buf, 7), 1234567890123);
  assert.equal(B.readU16(B.u16(7)), 7, 'offset defaults to 0');
  assert.equal(B.readU64(buf.subarray(7), 0), 1234567890123, 'respects byteOffset');
  assert.equal(B.readU64(B.u64(Number.MAX_SAFE_INTEGER), 0), Number.MAX_SAFE_INTEGER);
  assert.throws(() => B.readU32(buf, buf.length - 3), isCzd('truncated'));
  assert.throws(() => B.readU16(buf, -1), isCzd('truncated'));
  assert.throws(() => B.readU64(new Uint8Array([0, 0x20, 0, 0, 0, 0, 0, 0]), 0), isCzd('size-mismatch'));
});

test('be88 11-byte counter', () => {
  assert.deepEqual([...B.be88(0)], new Array(11).fill(0));
  assert.deepEqual([...B.be88(1)], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual([...B.be88(0x0102030405)], [0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5]);
  assert.deepEqual([...B.be88(Number.MAX_SAFE_INTEGER)], [0, 0, 0, 0, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  assert.throws(() => B.be88(-1), RangeError);
  assert.throws(() => B.be88(2 ** 53), RangeError);
});
