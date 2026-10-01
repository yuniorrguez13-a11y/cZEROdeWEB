// app/crypto/stealth.js against every legacy v4 vector (web + desktop), plus codec edge cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-phase0.js';
import { SA, SSET, bytesToScript, scriptToBytes, stealthRatio, stripWs } from '../../app/crypto/stealth.js';
import { CzdError } from '../../app/errors.js';
import { fromB64, fromHex, randomBytes, toHex, utf8 } from '../../app/util/bytes.js';

const web = JSON.parse(readFileSync(path.join(ROOT, 'tests/vectors/legacy-web-vectors.json'), 'utf8'));
const desk = JSON.parse(readFileSync(path.join(ROOT, 'tests/vectors/legacy-desktop-vectors.json'), 'utf8'));
const notCipher = (e) => e instanceof CzdError && e.code === 'legacy-not-ciphertext';
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Legacy v4 decryption (PBKDF2-SHA256 100k + AES-GCM), used only to prove that decoded bytes are right
// for records whose blob was not recorded.
async function v4Plain(blob, pin) {
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey('raw', utf8(pin), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'PBKDF2', salt: blob.subarray(0, 16), iterations: 100000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  return new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(16, 28) }, key, blob.subarray(28)));
}

test('SA alphabet matches the recorded constants', () => {
  assert.equal(SA.length, 64);
  assert.equal(SSET.size, 64);
  assert.ok(Object.isFrozen(SA));
  for (const row of web.constants.SA) {
    assert.equal(SA[row.index], row.char);
    assert.equal(B64[row.index], row.base64_char);
  }
  assert.equal(SA.join(''), desk.meta.SA);
  for (let i = 0; i < 64; i++) assert.equal(SA[i].charCodeAt(0), i <= 32 ? 0x10d0 + i : 0x0410 + i - 33);
  assert.ok(!SSET.has('ჶ'), 'the text-v2 marker U+10F6 is outside the alphabet');
});

test('web v4 vectors: scriptToBytes = recorded blob; bytesToScript round trip', () => {
  assert.equal(web.v4.vectors.length, 9);
  for (const v of web.v4.vectors) {
    const blob = scriptToBytes(v.ciphertext);
    assert.deepEqual(blob, fromB64(v.base64_intermediate), v.plaintext.slice(0, 20));
    assert.equal(blob.length, v.blob_len);
    assert.equal(toHex(blob.subarray(0, 16)), v.salt_hex);
    assert.equal(toHex(blob.subarray(16, 28)), v.iv_hex);
    assert.equal(blob.length - 28, v.ct_and_tag_len);
    assert.equal(bytesToScript(blob), v.ciphertext);
    assert.deepEqual(scriptToBytes(v.ciphertext, { allowRawBase64: false }), blob);
    assert.equal(stealthRatio(v.ciphertext), 1);
  }
  const ui = web.v4.ui_roundtrip.ui_encrypt.output;
  assert.equal(bytesToScript(scriptToBytes(ui)), ui);
});

test('desktop v4 text vectors: blob, salt, iv, tag', () => {
  assert.equal(desk.v4_text.length, 7);
  for (const v of desk.v4_text) {
    const blob = scriptToBytes(v.ciphertext);
    assert.deepEqual(blob, fromB64(v.blob_b64), v.id);
    assert.equal(blob.length, v.blob_len);
    assert.equal(toHex(blob.subarray(0, 16)), v.salt_hex);
    assert.equal(toHex(blob.subarray(16, 28)), v.iv_hex);
    assert.equal(toHex(blob.subarray(blob.length - 16)), v.tag_hex);
    assert.equal(blob.length - 44, v.ct_len);
    assert.equal(bytesToScript(blob), v.ciphertext);
  }
});

test('desktop .czd vectors: the cipher field decodes to the recorded blob', () => {
  assert.equal(desk.czd_files.length, 7);
  for (const v of desk.czd_files) {
    const outer = JSON.parse(v.expected.file_text);
    const blob = scriptToBytes(outer.cipher);
    assert.deepEqual(blob, fromB64(v.expected.blob_b64), v.id);
    assert.equal(blob.length, v.expected.blob_len);
    assert.equal(toHex(blob.subarray(0, 16)), v.expected.salt_hex);
    assert.equal(toHex(blob.subarray(16, 28)), v.expected.iv_hex);
    assert.equal(toHex(blob.subarray(blob.length - 16)), v.expected.tag_hex);
    assert.equal(bytesToScript(blob), outer.cipher);
  }
});

test('web file records (single + batched): decode, round trip, decrypt to the recorded payload', async () => {
  for (const v of web.files.single_real_constants) {
    const blob = scriptToBytes(v.record.cipher);
    assert.equal(bytesToScript(blob), v.record.cipher);
    assert.equal(await v4Plain(blob, v.pin), v.decrypted_payload_json, v.label);
  }
  for (const v of web.files.batched_reduced_constants.vectors) {
    const ciphers = v.record.chunks ?? [v.record.cipher];
    assert.equal(ciphers.length, v.decrypted_payload_jsons.length, v.label);
    for (let i = 0; i < ciphers.length; i++) {
      const blob = scriptToBytes(ciphers[i]);
      assert.equal(bytesToScript(blob), ciphers[i]);
      assert.equal(await v4Plain(blob, v.pin), v.decrypted_payload_jsons[i], `${v.label} #${i}`);
    }
  }
});

test('web vault cz records: ciphertext decrypts; the plaintext BUG record is rejected', async () => {
  for (const v of web.vault) {
    if (v.record.ver !== 'cz') continue;
    if (v.label.startsWith('BUG')) {
      assert.throws(() => scriptToBytes(v.record.cipher), notCipher);
      continue;
    }
    const blob = scriptToBytes(v.record.cipher);
    assert.equal(bytesToScript(blob), v.record.cipher);
    assert.equal(await v4Plain(blob, v.pin), v.plaintext, v.label);
  }
});

test('web decode edge cases: lenient whitespace, raw base64, short blobs', () => {
  const hello = web.v4.vectors[0];
  const helloBlob = fromB64(hello.base64_intermediate);
  let specific = 0;
  for (const e of web.v4.decode_edge_cases) {
    const blob = scriptToBytes(e.input);
    assert.deepEqual(blob, scriptToBytes(stripWs(e.input)), e.description);
    if (e.original_result.ok) assert.ok(blob.length >= 45, e.description);
    if (/space inserted in the middle|raw base64/.test(e.description)) assert.deepEqual(blob, helloBlob, e.description);
    if (/raw base64/.test(e.description)) assert.throws(() => scriptToBytes(e.input, { allowRawBase64: false }), notCipher);
    if (/truncated to 12 chars/.test(e.description)) assert.equal(blob.length, 9);
    if (/EMPTY plaintext/.test(e.description)) assert.equal(blob.length, 44);
    const m = /plaintext utf8 len (\d)/.exec(e.description);
    if (m) assert.equal(blob.length, 44 + Number(m[1]), e.description);
    if (m || /space inserted|raw base64|truncated to 12|EMPTY plaintext/.test(e.description)) specific++;
  }
  assert.equal(web.v4.decode_edge_cases.length, 12);
  assert.equal(specific, 10);
});

test('desktop decode edge cases: whitespace anywhere and raw base64 give the base blob', async () => {
  const base = Object.fromEntries(desk.v4_text.map((v) => [v.id, v]));
  let matched = 0;
  let decrypted = 0;
  for (const e of desk.v4_text_edge) {
    const blob = scriptToBytes(e.ciphertext);
    assert.deepEqual(blob, scriptToBytes(stripWs(e.ciphertext)), e.id);
    const b = base[e.base];
    if (b && (stripWs(e.ciphertext) === b.ciphertext || e.id === 'edge-plain-base64-accepted')) {
      assert.deepEqual(blob, fromB64(b.blob_b64), e.id);
      assert.equal(await v4Plain(blob, b.pin), b.plaintext, e.id);
      matched++;
    }
    if (e.original_aesDecrypt.ok) {
      assert.equal(await v4Plain(blob, e.pin), e.original_aesDecrypt.result, e.id);
      decrypted++;
    }
  }
  assert.equal(desk.v4_text_edge.length, 12);
  assert.equal(matched, 7);
  assert.equal(decrypted, 4);
});

test('whitespace: the full ECMAScript WhiteSpace + LineTerminator set is ignored', () => {
  const v = desk.v4_text[0];
  const blob = fromB64(v.blob_b64);
  const ws = ['\t', '\n', '\v', '\f', '\r', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', '　', '﻿'];
  const chars = [...v.ciphertext];
  const noisy = chars.map((c, i) => c + ws[i % ws.length]).join('');
  assert.deepEqual(scriptToBytes(noisy), blob);
  assert.deepEqual(scriptToBytes(`\r\n  ${v.ciphertext}\n\n`), blob);
  assert.equal(stripWs(noisy), v.ciphertext);
  assert.equal(stripWs(' a　b﻿ c '), 'abc');
  // not whitespace: zero-width space, NUL
  assert.throws(() => scriptToBytes(`${v.ciphertext}​`), notCipher);
  assert.throws(() => scriptToBytes(`${v.ciphertext}\u0000`), notCipher);
});

test('non-canonical trailing bits are accepted (forgiving base64)', () => {
  for (const v of desk.v4_text) {
    const blob = fromB64(v.blob_b64);
    const rem = blob.length % 3;
    if (rem === 0) continue;
    const last = SA.indexOf(v.ciphertext.at(-1));
    const spare = rem === 1 ? 0x0f : 0x03; // unused low bits of the final digit
    assert.equal(last & spare, 0, 'the recorded text is canonical');
    const tweaked = v.ciphertext.slice(0, -1) + SA[last | spare];
    assert.notEqual(tweaked, v.ciphertext);
    assert.deepEqual(scriptToBytes(tweaked), blob, v.id);
    assert.equal(bytesToScript(scriptToBytes(tweaked)), v.ciphertext, 'encoding is canonical');
  }
});

test('raw base64 with and without padding; padding rules', () => {
  const r = randomBytes(31);
  const b64 = Buffer.from(r).toString('base64');
  assert.ok(b64.endsWith('='));
  assert.deepEqual(scriptToBytes(b64), r);
  assert.deepEqual(scriptToBytes(b64.replace(/=+$/, '')), r);
  assert.deepEqual(scriptToBytes(`${b64.slice(0, 20)}\n${b64.slice(20)}`), r);
  assert.throws(() => scriptToBytes(b64, { allowRawBase64: false }), notCipher);
  // mixed SA + base64 is what the original accepted too
  const s = bytesToScript(r);
  assert.deepEqual(scriptToBytes(b64.slice(0, 10) + s.slice(10)), r);
  // '=' may supply some or all of the missing padding, never more, and never mid-text
  assert.deepEqual([...scriptToBytes('QQ')], [65]);
  assert.deepEqual([...scriptToBytes('QQ=')], [65]);
  assert.deepEqual([...scriptToBytes('QQ==')], [65]);
  assert.deepEqual([...scriptToBytes('QUI=')], [65, 66]);
  for (const bad of ['QQ===', 'QUI==', 'QUJD=', 'Q=Q=', '=', 'Q', 'QUJDQ', `${SA[1]}`]) assert.throws(() => scriptToBytes(bad), notCipher, bad);
});

test('invalid input throws legacy-not-ciphertext', () => {
  for (const bad of ['hello, world', 'meet at 6!', 'Я', 'ჶ' + bytesToScript(randomBytes(10)), '😀', 'abc-def_', 'ⴀⴁⴂⴃ']) {
    assert.throws(() => scriptToBytes(bad), notCipher, bad);
  }
  assert.throws(() => scriptToBytes(undefined), notCipher);
  assert.throws(() => scriptToBytes('ABCD', { allowRawBase64: false }), notCipher);
  assert.deepEqual(scriptToBytes(''), new Uint8Array(0));
  assert.deepEqual(scriptToBytes(' \n\t'), new Uint8Array(0));
});

test('random round trips for every length 0..600 and a 5 MiB blob', () => {
  for (let n = 0; n <= 600; n++) {
    const r = randomBytes(n);
    const s = bytesToScript(r);
    assert.equal(s.length, Math.ceil((4 * n) / 3));
    const expected = Buffer.from(r).toString('base64').replace(/=+$/, '').replace(/./g, (c) => SA[B64.indexOf(c)]);
    assert.equal(s, expected);
    const d = scriptToBytes(s);
    assert.deepEqual(d, r);
    assert.equal(d.buffer.byteLength, d.length, 'result owns an exact buffer');
  }
  const big = randomBytes(5 * 2 ** 20);
  const s = bytesToScript(big);
  const t0 = performance.now();
  assert.deepEqual(scriptToBytes(s), big);
  assert.ok(performance.now() - t0 < 2000, 'LUT decoder is fast');
});

test('stealthRatio', () => {
  assert.equal(stealthRatio(''), 0);
  assert.equal(stealthRatio('   '), 0);
  assert.equal(stealthRatio(bytesToScript(randomBytes(60))), 1);
  assert.equal(stealthRatio(`${SA[0]}${SA[1]} \n${SA[2]}x`), 0.75);
  assert.equal(stealthRatio('hello'), 0);
  assert.equal(stealthRatio(`😀${SA[0]}`), 0.5, 'counts code points');
  for (const d of web.detection) {
    const r = stealthRatio(d.input);
    if (d.isAES) assert.ok(r > 0.85, JSON.stringify(d.input));
  }
});

test('fromHex helper sanity for vector parsing', () => {
  assert.equal(toHex(fromHex(desk.v4_text[0].salt_hex)), desk.v4_text[0].salt_hex);
});
