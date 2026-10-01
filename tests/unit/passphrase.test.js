// Passphrase generation and strength estimate (DESIGN §3.9) + the BIP39 wordlist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as P from '../../app/crypto/passphrase.js';
import { WORDS } from '../../app/crypto/wordlist.js';

test('wordlist: 2048 BIP39 English words, frozen, the canonical list', () => {
  assert.equal(WORDS.length, 2048);
  assert.ok(Object.isFrozen(WORDS));
  assert.equal(new Set(WORDS).size, 2048);
  assert.equal(WORDS[0], 'abandon');
  assert.equal(WORDS[2047], 'zoo');
  assert.ok(WORDS.every((w) => /^[a-z]{3,8}$/.test(w)));
  assert.deepEqual([...WORDS].sort(), [...WORDS], 'sorted');
  assert.ok(new Set(WORDS.map((w) => w.slice(0, 4))).size === 2048, 'unique 4-letter prefixes');
  assert.equal(createHash('sha256').update(WORDS.join('\n')).digest('hex'), '187db04a869dd9bc7be80d21a86497d692c0db6abd3aa8cb6be5d618ff757fae');
});

test('generatePassphrase: lowercase words joined by "-", every word from the list, random', () => {
  for (const n of [1, 5, 6, 12]) {
    const p = P.generatePassphrase(n);
    const words = p.split('-');
    assert.equal(words.length, n);
    assert.ok(words.every((w) => WORDS.includes(w)));
    assert.equal(p, p.toLowerCase());
  }
  const seen = new Set(Array.from({ length: 200 }, () => P.generatePassphrase(5)));
  assert.equal(seen.size, 200);
  // Rough uniformity: 20000 words should touch most of the list.
  const used = new Set(P.generatePassphrase(64).split('-'));
  for (let i = 0; i < 311; i++) for (const w of P.generatePassphrase(64).split('-')) used.add(w);
  assert.ok(used.size > 2000, `${used.size} distinct words`);
  for (const bad of [0, -1, 1.5, 65, '5', undefined]) assert.throws(() => P.generatePassphrase(bad), TypeError, String(bad));
});

test('estimateBits: charset union × effective length', () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  close(P.estimateBits('zqxv'), 4 * Math.log2(26));
  close(P.estimateBits('ZqXv'), 4 * Math.log2(52));
  close(P.estimateBits('Zq7v'), 4 * Math.log2(62));
  close(P.estimateBits('Zq7!'), 4 * Math.log2(95));
  close(P.estimateBits('zq v'), 4 * Math.log2(26 + 33), );
  close(P.estimateBits('жqzv'), 4 * Math.log2(126));
  close(P.estimateBits('😀😀q'), 3 * Math.log2(126), );
  assert.equal(P.estimateBits(''), 0);
  assert.equal(P.estimateBits('    '), 0);
  assert.equal(P.estimateBits(null), 0);
});

test('estimateBits: runs and ±1 sequences longer than 3 count as one character', () => {
  const b26 = Math.log2(26);
  const close = (s, n, cs = b26) => assert.ok(Math.abs(P.estimateBits(s) - n * cs) < 1e-9, `${s}: ${P.estimateBits(s) / cs}`);
  close('zzz', 3);
  close('zzzz', 1);
  close('zzzzzzzzzzzz', 1);
  close('qabcdq', 3);
  close('qabcq', 5);
  close('qzyxwq', 3);
  close('mmmmnnnnxw', 4);
  close('abcdcbaz', 5, b26); // abcd → 1, then c b a z one each
  close('zq5678', 3, Math.log2(36));
  // Whitespace is canonicalized like the KDF input.
  assert.equal(P.estimateBits('  zq   xv  '), P.estimateBits('zq xv'));
});

test('common passwords: WEAK ∪ COMMON or one of them + ≤ 3 characters → at most 10 bits', () => {
  assert.equal(P.COMMON.size, 200);
  assert.ok(P.COMMON.has('123456') && P.COMMON.has('password') && P.COMMON.has('qwerty'));
  for (const s of ['password', 'PASSWORD', 'Password1', 'password123', 'qwerty!!!', 'admin', 'Admin123', 'abc', 'letmein', 'iloveyou', 'dragon99', ' 1234 ']) {
    assert.ok(P.estimateBits(s) <= 10, s);
  }
  assert.ok(P.estimateBits('password1234') <= 10, "'password1' is itself common, so '234' is within the 3-character tail");
  assert.ok(P.estimateBits('dragonfly42') > 10, 'five extra characters escape the cap');
  assert.ok(P.estimateBits('mypassword') > 10, 'only prefixes count');
});

test('crackTime: 2^(bits−1) / 1e6 guesses per second', () => {
  assert.equal(P.crackTime(0), 'instantly');
  assert.equal(P.crackTime(20), 'instantly');
  assert.equal(P.crackTime(21), 'minutes'); // 1.05 s
  assert.equal(P.crackTime(32), 'minutes'); // 2147 s
  assert.equal(P.crackTime(33), 'hours');
  assert.equal(P.crackTime(37), 'hours'); // 19 h
  assert.equal(P.crackTime(38), 'days');
  assert.equal(P.crackTime(45), 'days'); // 203 days
  assert.equal(P.crackTime(46), 'years');
  assert.equal(P.crackTime(52), 'years'); // 71 years
  assert.equal(P.crackTime(53), 'centuries');
  assert.equal(P.crackTime(200), 'centuries');
  assert.equal(P.crackTime(NaN), 'instantly');
});

test('strength: labels at 40/60 bits; generated phrases count 11 bits per word', () => {
  assert.deepEqual(P.strength(''), { bits: 0, label: 'weak', crack: 'instantly' });
  assert.equal(P.strength('password').label, 'weak');
  const g5 = P.strength(P.generatePassphrase(5), { generated: true, words: 5 });
  assert.deepEqual(g5, { bits: 55, label: 'ok', crack: 'centuries' });
  assert.deepEqual(P.strength('a-b-c-d-e-f', { generated: true }), { bits: 66, label: 'strong', crack: 'centuries' });
  assert.equal(P.strength('zqxvkwjm').label, 'weak'); // 37.6
  assert.equal(P.strength('zqxvkwjmh').label, 'ok'); // 42.3
  assert.equal(P.strength('zqxvkwjmhpfg').label, 'ok'); // 56.4
  assert.equal(P.strength('zqxvkwjmhpfgy').label, 'strong'); // 61.1
  const b = P.strength('Zq7!Kw9#').bits;
  assert.equal(b, Math.floor(8 * Math.log2(95)));
  assert.equal(P.strength('Zq7!Kw9#').label, 'ok');
  assert.equal(P.strength('Zq7!Kw9#Lm2$').label, 'strong');
});

test('meetsVaultMinimum: generated, or ≥ 10 characters and ≥ 45 bits', () => {
  assert.deepEqual(P.meetsVaultMinimum('x', { generated: true }), { ok: true, reason: null });
  assert.deepEqual(P.meetsVaultMinimum('Zq7!Kw9#L'), { ok: false, reason: 'too-short' });
  assert.deepEqual(P.meetsVaultMinimum('   zqxvkw   '), { ok: false, reason: 'too-short' }, 'ends trimmed');
  assert.deepEqual(P.meetsVaultMinimum('aaaaaaaaaaaaaaaaaaaa'), { ok: false, reason: 'too-weak' });
  assert.deepEqual(P.meetsVaultMinimum('password12'), { ok: false, reason: 'too-weak' });
  assert.deepEqual(P.meetsVaultMinimum('zqxvkwjmhp'), { ok: true, reason: null }); // 10 × 4.7 = 47
  assert.deepEqual(P.meetsVaultMinimum('zqxvkwjmh p'), { ok: true, reason: null });
  assert.deepEqual(P.meetsVaultMinimum('abcdefghijklmnopqrstuvwxyz'), { ok: false, reason: 'too-weak' });
  assert.deepEqual(P.meetsVaultMinimum(P.generatePassphrase(5)), { ok: true, reason: null }, 'typed phrase of 5 words is long enough');
  assert.deepEqual(P.meetsVaultMinimum(undefined), { ok: false, reason: 'too-short' });
});

test('WEAK (old app set), isWeak, isEasterEggPin', () => {
  assert.deepEqual([...P.WEAK].sort(), ['0000', '1111', '123', '1234', '12345', 'abc', 'admin', 'pass', 'password', 'qwerty']);
  for (const s of ['1234', 'PASSWORD', 'Admin', ' qwerty ', 'abc']) assert.equal(P.isWeak(s), true, s);
  for (const s of ['12346', 'passwords', '', 'abcd', null]) assert.equal(P.isWeak(s), false, String(s));
  for (const s of ['123', '1234', '12345']) assert.equal(P.isEasterEggPin(s), true, s);
  for (const s of ['12', '123456', '0123', 'abc', '', null, 1234, ' 1234', '1234 ', ' 123 ']) assert.equal(P.isEasterEggPin(s), false, String(s));
});

test('weak warning and easter egg match the old app (legacy-web-vectors easter_egg), except trimmed weak PINs', async () => {
  const { readFileSync } = await import('node:fs');
  const web = JSON.parse(readFileSync(new URL('../vectors/legacy-web-vectors.json', import.meta.url), 'utf8'));
  for (const v of web.easter_egg.chkEE_results) {
    assert.equal(P.isEasterEggPin(v.pin), v.modal_shown, `modal ${JSON.stringify(v.pin)}`);
    // Deliberate difference: passphraseBytes() trims, so ' 1234' is the weak passphrase '1234' and warns.
    const weak = v.pin.trim() !== v.pin && P.WEAK.has(v.pin.trim().toLowerCase()) ? true : v.warning_banner_shown;
    assert.equal(P.isWeak(v.pin), weak, `warning ${JSON.stringify(v.pin)}`);
  }
});
