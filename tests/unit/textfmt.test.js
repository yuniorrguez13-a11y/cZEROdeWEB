// Text format v2 (DESIGN §3.4): round trips, unicode, whitespace tolerance, tamper/commit behaviour,
// an independent decoder written from the spec, and detectText ('v2' / 'v4' / null outcomes).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT } from './helpers-phase0.js';
import * as T from '../../app/crypto/textfmt.js';
import * as K from '../../app/crypto/kdf.js';
import { SA, SSET, bytesToScript, scriptToBytes } from '../../app/crypto/stealth.js';
import { CzdError } from '../../app/errors.js';
import { ascii, fromUtf8, toB64, utf8 } from '../../app/util/bytes.js';

const code = (c) => (e) => {
  assert.ok(e instanceof CzdError, `expected CzdError(${c}), got ${e?.name}: ${e?.message}`);
  assert.equal(e.code, c);
  return true;
};
const subtle = globalThis.crypto.subtle;
const web = JSON.parse(readFileSync(path.join(ROOT, 'tests/vectors/legacy-web-vectors.json'), 'utf8'));

let runs = 0;
function useFakeArgon() {
  runs = 0;
  K.__setArgon2ForTests((pw, salt, prm) => {
    runs++;
    return new Uint8Array(createHash('sha256').update(pw).update(salt).update(`${prm.m},${prm.t},${prm.p}`).digest());
  });
}
afterEach(() => {
  K.__setArgon2ForTests(null);
  K.clearKdfCache();
});

const blobOf = (text) => scriptToBytes(text.slice(1), { allowRawBase64: false });
const textOf = (blob) => T.TEXT_MARKER + bytesToScript(blob);

/** Independent decoder written from DESIGN §3.4 (real Argon2id via kdf.argon2id). */
async function referenceDecrypt(text, pass) {
  const blob = blobOf(text.replace(/\s+/gu, ''));
  const params = { 1: K.POLICY, 2: K.FLOOR }[blob[1]];
  const bits = await K.argon2id(K.passphraseBytes(pass), blob.subarray(2, 18), params);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const commit = new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: ascii('cZEROde text v2 commit') }, hk, 128));
  assert.deepEqual(commit, blob.subarray(30, 46), 'commit = HKDF(bits, ∅, "cZEROde text v2 commit")[0..16)');
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: ascii('cZEROde text v2 key') }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pt = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(18, 30), additionalData: blob.subarray(0, 2) }, key, blob.subarray(46)));
  assert.equal(pt.length % 16, 0);
  let i = pt.length - 1;
  while (pt[i] === 0) i--;
  assert.equal(pt[i], 0x80);
  return fromUtf8(pt.subarray(0, i));
}

test('round trip with real Argon2id (POLICY and FLOOR); format checked by an independent decoder', async () => {
  const msg = 'Meet at 9 — bring the 🔑.\n  indented line\twith tab  ';
  const t1 = await T.encryptText(msg, 'correct horse battery staple');
  assert.ok(t1.startsWith(T.TEXT_MARKER));
  assert.ok([...t1.slice(1)].every((c) => SSET.has(c)), 'body is pure stealth alphabet');
  const b1 = blobOf(t1);
  assert.deepEqual([b1[0], b1[1]], [2, 1]);
  assert.equal(b1.length, 46 + (Math.floor(utf8(msg).length / 16) + 1) * 16 + 16);
  assert.equal(await T.decryptText(t1, 'correct horse battery staple'), msg);
  assert.equal(await referenceDecrypt(t1, 'correct horse battery staple'), msg);
  const t2 = await T.encryptText(msg, 'pw', { params: K.FLOOR });
  assert.equal(blobOf(t2)[1], 2);
  assert.equal(await T.decryptText(t2, 'pw'), msg);
  assert.equal(await referenceDecrypt(t2, 'pw'), msg);
});

test('unicode, empty and long messages survive exactly as typed', async () => {
  useFakeArgon();
  const msgs = ['', ' ', '\n', 'a', 'x'.repeat(15), 'x'.repeat(16), 'ძალიან საიდუმლო', 'שלום עולם', 'e\u0301 (NFD kept)', '\u0000nul\u0000', '👩\u200d👩\u200d👧\u200d👦🏳\ufe0f\u200d🌈', 'Ж'.repeat(100000)];
  for (const m of msgs) {
    const t = await T.encryptText(m, 'pw');
    assert.equal(await T.decryptText(t, 'pw'), m, JSON.stringify(m.slice(0, 20)));
  }
});

test('whitespace anywhere is ignored on decrypt; passphrase canonicalization applies', async () => {
  useFakeArgon();
  const t = await T.encryptText('hello', 'Café au lait');
  const spaced = `\n  ${t.slice(0, 1)} \u00a0${t.slice(1, 10)}\r\n\t${t.slice(10, 30)}\u2028${t.slice(30)}  \ufeff`;
  assert.equal(await T.decryptText(spaced, '  Cafe\u0301   au lait '), 'hello');
  await assert.rejects(T.decryptText(t, 'café au lait'), code('wrong-passphrase'));
});

test('fresh salt and nonce for every message', async () => {
  useFakeArgon();
  const a = blobOf(await T.encryptText('same', 'pw'));
  const b = blobOf(await T.encryptText('same', 'pw'));
  assert.notDeepEqual(a.subarray(2, 18), b.subarray(2, 18), 'salt');
  assert.notDeepEqual(a.subarray(18, 30), b.subarray(18, 30), 'nonce');
  assert.equal(runs, 2, 'one Argon2 per message (no salt reuse)');
});

test('the derived-key cache makes repeated decrypts of the same message cheap', async () => {
  useFakeArgon();
  const t = await T.encryptText('m', 'pw');
  runs = 0;
  K.clearKdfCache();
  await T.decryptText(t, 'pw');
  await T.decryptText(t, ' pw ');
  assert.equal(runs, 1);
  await assert.rejects(T.decryptText(t, 'nope'), code('wrong-passphrase'));
  assert.equal(runs, 2);
});

test('wrong passphrase is detected by the commitment before AES-GCM', async () => {
  useFakeArgon();
  const t = await T.encryptText('secret', 'right');
  const decrypt = subtle.decrypt;
  let gcmCalls = 0;
  subtle.decrypt = function (...args) { gcmCalls++; return decrypt.apply(this, args); };
  try {
    await assert.rejects(T.decryptText(t, 'wrong'), code('wrong-passphrase'));
    assert.equal(gcmCalls, 0);
  } finally {
    subtle.decrypt = decrypt;
  }
});

test('tampering: every region maps to the right error', async () => {
  useFakeArgon();
  const t = await T.encryptText('tamper me please', 'pw');
  const blob = blobOf(t);
  const flip = (i, v) => { const b = blob.slice(); b[i] = v ?? b[i] ^ 1; return textOf(b); };
  await assert.rejects(T.decryptText(flip(0, 3), 'pw'), code('text-preset-unknown'), 'newer version');
  await assert.rejects(T.decryptText(flip(0, 1), 'pw'), code('not-cz-text'), 'older version');
  await assert.rejects(T.decryptText(flip(1, 3), 'pw'), code('text-preset-unknown'));
  await assert.rejects(T.decryptText(flip(1, 0), 'pw'), code('text-preset-unknown'));
  await assert.rejects(T.decryptText(flip(1, 2), 'pw'), code('wrong-passphrase'), 'preset swap changes the key');
  await assert.rejects(T.decryptText(flip(5), 'pw'), code('wrong-passphrase'), 'salt');
  await assert.rejects(T.decryptText(flip(20), 'pw'), code('not-cz-text'), 'nonce');
  await assert.rejects(T.decryptText(flip(35), 'pw'), code('wrong-passphrase'), 'commit');
  await assert.rejects(T.decryptText(flip(50), 'pw'), code('not-cz-text'), 'ciphertext');
  await assert.rejects(T.decryptText(flip(blob.length - 1), 'pw'), code('not-cz-text'), 'tag');
  await assert.rejects(T.decryptText(textOf(blob.subarray(0, blob.length - 16)), 'pw'), code('not-cz-text'), 'cut one block');
  await assert.rejects(T.decryptText(textOf(blob.subarray(0, blob.length - 1)), 'pw'), code('not-cz-text'), 'cut one byte');
  await assert.rejects(T.decryptText(textOf(blob.subarray(0, 61)), 'pw'), code('not-cz-text'), 'too short');
});

test('not a v2 message → not-cz-text (legacy v4, raw base64, foreign characters, junk)', async () => {
  useFakeArgon();
  const t = await T.encryptText('x', 'pw');
  const legacy = web.v4.vectors[0].ciphertext;
  for (const s of ['', '   ', 'hello', legacy, T.TEXT_MARKER, `${T.TEXT_MARKER}${toB64(blobOf(t))}`, `${t}!`, `${t}ჶ`, `x${t}`, `${T.TEXT_MARKER}${SA[0]}`]) {
    await assert.rejects(T.decryptText(s, 'pw'), code('not-cz-text'), JSON.stringify(s.slice(0, 20)));
  }
  await assert.rejects(T.decryptText(42, 'pw'), code('not-cz-text'));
  assert.equal(runs, 1, 'no Argon2 for any of them');
});

test('argument errors', async () => {
  useFakeArgon();
  await assert.rejects(T.encryptText('m', ''), TypeError);
  await assert.rejects(T.encryptText('m', '  '), TypeError);
  await assert.rejects(T.encryptText(5, 'pw'), TypeError);
  await assert.rejects(T.encryptText('m', 'pw', { params: { m: 64, t: 1, p: 1 } }), TypeError);
  await assert.rejects(T.decryptText(await T.encryptText('m', 'pw'), ''), code('wrong-passphrase'));
  await assert.rejects(T.decryptText('x', null), TypeError);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(T.encryptText('m', 'pw', { signal: ac.signal }), code('aborted'));
});

test('detectText: v2 marker, legacy v4 (≥ 85 % stealth and ≥ 60 chars), null', async () => {
  useFakeArgon();
  const v2 = await T.encryptText('hi', 'pw');
  assert.equal(T.detectText(v2), 'v2');
  assert.equal(T.detectText(`  \n${v2}\n`), 'v2');
  assert.equal(T.detectText(T.TEXT_MARKER), 'v2');
  for (const v of web.v4.vectors) assert.equal(T.detectText(v.ciphertext), 'v4', v.plaintext);
  const sa = (n) => Array.from({ length: n }, (_, i) => SA[(i * 7) % 64]).join('');
  assert.equal(T.detectText(sa(60)), 'v4');
  assert.equal(T.detectText(sa(59)), null, 'shorter than 60 → not v4 (legacy detection does not override)');
  assert.equal(T.detectText(sa(85) + 'abcdefghijklmno'), 'v4', '85 %');
  assert.equal(T.detectText(sa(30) + ' \n ' + sa(30)), 'v4', 'whitespace ignored');
  const georgianOnly = Array.from({ length: 70 }, (_, i) => SA[i % 33]).join('');
  assert.notEqual(T.detectText(georgianOnly), 'v4', 'all-Georgian text is Mixed Script, never v4');
  assert.notEqual(T.detectText('ჰელლო წორლდ '.repeat(8)), 'v4');
  for (const s of ['', '   \n\t', null, undefined, 42, {}]) assert.equal(T.detectText(s), null, String(s));
});

// ---- review regressions: detectText must not take Mixed Script or prose for v4 ------------------

const desktop = JSON.parse(readFileSync(path.join(ROOT, 'tests/vectors/legacy-desktop-vectors.json'), 'utf8'));

test('detectText: long Mixed Script v1 with capitals (Georgian + Cyrillic letters) is "mixed", not v4', async () => {
  const { decodeV1 } = await import('../../app/legacy/mixed.js');
  const v1 = desktop.legacy_text.v1.filter((v) => v.caps === 'cyrillic').map((v) => v.encoded).join(' ');
  const long = `${v1} ${v1} ${v1}`;
  assert.ok([...long.replace(/\s/g, '')].length >= 60);
  assert.equal(T.detectText(long), 'mixed');
  // Title Case English through the v1 map (capitals → Cyrillic) — 80+ letters, 100 % stealth alphabet.
  const title = 'Тჰე Qუიცკ Вროწნ Фოხ Жუმპს Оვერ Тჰე Лაზყ Дოგ Аნდ Тჰენ Рუნს Аწაყ Иნტო Тჰე Фორესტ';
  assert.equal(decodeV1(title).text.length, title.length);
  assert.equal(T.detectText(title.replace(/Q/g, 'Ф')), 'mixed');
});

test('detectText: Georgian prose (also with a Russian name in it) is never v4', () => {
  const prose = 'გამარჯობა, როგორ ხარ? დღეს ძალიან კარგი ამინდია და მინდა გავისეირნო პარკში შენთან ერთად საღამოს.';
  assert.notEqual(T.detectText(prose), 'v4');
  assert.notEqual(T.detectText(prose.replace('გამარჯობა,', 'გამარჯობა ИВАН,')), 'v4');
  assert.notEqual(T.detectText(`${prose} ${prose}`), 'v4');
});

test('detectText: the "Mixed never emits" letters are exactly SA minus the v1 maps (legacy/mixed.decodeV1)', async () => {
  const { decodeV1 } = await import('../../app/legacy/mixed.js');
  const never = SA.filter((c) => decodeV1(c).text === c);
  const emitted = SA.filter((c) => decodeV1(c).text !== c);
  assert.equal(never.length, 18);
  const geo = emitted.filter((c) => c >= 'ა' && c <= 'ჰ');
  const cyr = emitted.filter((c) => c >= 'А' && c <= 'Ю');
  // 64 balanced characters Mixed Script can produce: not v4 …
  const base = Array.from({ length: 64 }, (_, i) => (i % 2 ? cyr[i % cyr.length] : geo[i % geo.length])).join('');
  assert.notEqual(T.detectText(base), 'v4');
  // … until one letter Mixed Script never emits appears, whichever it is.
  for (const c of never) assert.equal(T.detectText(c + base.slice(1)), 'v4', `U+${c.codePointAt(0).toString(16)}`);
  for (const c of emitted) assert.notEqual(T.detectText(c + base.slice(1)), 'v4', `U+${c.codePointAt(0).toString(16)}`);
});

test('detectText: real ciphertext is v4 (vectors and 20 000 seeded random 60–200 digit strings)', () => {
  for (const v of web.v4.vectors) assert.equal(T.detectText(v.ciphertext), 'v4');
  for (const v of desktop.v4_text) assert.equal(T.detectText(v.ciphertext), 'v4', v.id);
  let a = 0x2545f491;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  for (let i = 0; i < 20000; i++) {
    const len = 60 + (next() % 141);
    let s = '';
    for (let j = 0; j < len; j++) s += SA[next() & 63];
    assert.equal(T.detectText(s), 'v4', s);
  }
});
