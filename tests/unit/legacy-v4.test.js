// app/legacy/v4.js against every v4 vector (web + desktop), PIN retries, the 1-block precheck and BOM handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pbkdf2Sync } from 'node:crypto';
import path from 'node:path';
import { ROOT } from './helpers-phase0.js';
import {
  MIN_BLOB, decryptV4Bytes, decryptV4Text, isAES, legacyUtf8, looksLikeV4, pbkdf2Legacy, pinMatchesV4, pinVariants,
  precheckV4, v4Blob, v4Head, v4Keys,
} from '../../app/legacy/v4.js';
import { SA, bytesToScript } from '../../app/crypto/stealth.js';
import { CzdError } from '../../app/errors.js';
import { fromB64, fromHex, toB64, utf8 } from '../../app/util/bytes.js';

const web = JSON.parse(readFileSync(path.join(ROOT, 'tests/vectors/legacy-web-vectors.json'), 'utf8'));
const desk = JSON.parse(readFileSync(path.join(ROOT, 'tests/vectors/legacy-desktop-vectors.json'), 'utf8'));
const code = (c) => (e) => e instanceof CzdError && e.code === c;

/** Original aesEncrypt with injectable salt/iv (only to build extra cases; the app never writes v4). */
async function sealV4(plain, pin, { salt = new Uint8Array(16).fill(7), iv = new Uint8Array(12).fill(9) } = {}) {
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey('raw', utf8(pin), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, typeof plain === 'string' ? utf8(plain) : plain));
  const blob = new Uint8Array(28 + ct.length);
  blob.set(salt, 0);
  blob.set(iv, 16);
  blob.set(ct, 28);
  return bytesToScript(blob);
}

test('web v4 vectors decrypt; isAES / looksLikeV4 match', async () => {
  assert.equal(web.v4.vectors.length, 9);
  for (const v of web.v4.vectors) {
    assert.equal(await decryptV4Text(v.ciphertext, v.pin), v.decrypted_by_original, v.plaintext.slice(0, 30));
    assert.equal(v.decrypted_by_original, v.plaintext);
    assert.deepEqual(await decryptV4Bytes(v.ciphertext, v.pin), utf8(v.plaintext));
    assert.equal(isAES(v.ciphertext), v.is_aes);
    assert.equal(looksLikeV4(v.ciphertext), true);
    assert.equal(v4Blob(v.ciphertext).length, v.blob_len);
    // Not a file payload: the 1-block check says no even with the right PIN.
    assert.equal(await pinMatchesV4(v.ciphertext, v.pin), false);
  }
});

test('web v4 UI round trip vector', async () => {
  const r = web.v4.ui_roundtrip;
  assert.equal(await decryptV4Text(r.ui_encrypt.output, r.pin), r.plaintext);
  assert.equal(r.ui_decrypt.output, r.plaintext);
});

test('web v4 decode edge cases (lenient whitespace, raw base64, 44-byte blob)', async () => {
  const e = web.v4.decode_edge_cases;
  assert.equal(e.length, 12);
  const byDesc = Object.fromEntries(e.map((x) => [x.description, x]));
  for (const x of e) assert.equal(isAES(x.input), x.is_aes, x.description);
  // Whitespace anywhere is ignored (the original failed for 4 of these 6).
  for (const [len, desc] of [[1, 'trailing "\\n", plaintext utf8 len 1 (blob len 45)'], [1, 'leading space, plaintext utf8 len 1'],
    [2, 'trailing "\\n", plaintext utf8 len 2 (blob len 46)'], [2, 'leading space, plaintext utf8 len 2'],
    [3, 'trailing "\\n", plaintext utf8 len 3 (blob len 47)'], [3, 'leading space, plaintext utf8 len 3']]) {
    const x = byDesc[desc];
    assert.ok(x, desc);
    const plain = await decryptV4Bytes(x.input, x.pin);
    assert.equal(plain.length, len, desc);
    assert.equal(await decryptV4Text(x.input.trim(), x.pin), legacyUtf8(plain));
    if (x.original_result.ok) assert.equal(legacyUtf8(plain), x.original_result.plaintext);
  }
  const mid = byDesc['space inserted in the middle'];
  const wrong = byDesc['wrong pin'];
  assert.equal(mid.input.replace(' ', ''), wrong.input);
  const midPlain = await decryptV4Text(mid.input, mid.pin);
  assert.equal(midPlain, await decryptV4Text(wrong.input, mid.pin));
  await assert.rejects(decryptV4Text(wrong.input, wrong.pin), code('legacy-wrong-pin'));
  const tampered = byDesc['one character changed (tag check)'];
  await assert.rejects(decryptV4Text(tampered.input, tampered.pin), code('legacy-wrong-pin'));
  const short = byDesc['truncated to 12 chars (blob < 45 bytes)'];
  await assert.rejects(decryptV4Text(short.input, short.pin), code('legacy-not-ciphertext'));
  const raw = byDesc['raw base64 (no script substitution) is also accepted'];
  assert.equal(await decryptV4Text(raw.input, raw.pin), raw.original_result.plaintext);
  assert.equal(looksLikeV4(raw.input), false);
  // The 44-byte blob of an empty plaintext is accepted (the original's 45-byte guard rejected it).
  const empty = byDesc['ciphertext of EMPTY plaintext (UI never produces it)'];
  assert.equal(v4Blob(empty.input).length, MIN_BLOB);
  assert.equal(await decryptV4Text(empty.input, empty.pin), '');
});

test('desktop v4 text vectors: blob layout, decrypt, cross-edition', async () => {
  assert.equal(desk.v4_text.length, 7);
  for (const v of desk.v4_text) {
    const blob = v4Blob(v.ciphertext);
    assert.deepEqual(blob, fromB64(v.blob_b64), v.id);
    assert.deepEqual(blob.subarray(0, 16), fromHex(v.salt_hex));
    assert.deepEqual(blob.subarray(16, 28), fromHex(v.iv_hex));
    assert.deepEqual(blob.subarray(blob.length - 16), fromHex(v.tag_hex));
    assert.equal(blob.length - MIN_BLOB, v.plaintext_utf8_len);
    assert.equal(await decryptV4Text(v.ciphertext, v.pin), v.plaintext, v.id);
    assert.equal(looksLikeV4(v.ciphertext), true, v.id);
    // Line-wrapped paste (e.g. from an email) still works.
    const wrapped = v.ciphertext.replace(/(.{20})/gu, '$1\r\n');
    assert.equal(await decryptV4Text(wrapped, v.pin), v.plaintext);
  }
});

test('desktop v4 text edge vectors', async () => {
  assert.equal(desk.v4_text_edge.length, 12);
  const base = Object.fromEntries(desk.v4_text.map((v) => [v.id, v]));
  for (const x of desk.v4_text_edge) {
    if (x.id === 'edge-truncated') {
      await assert.rejects(decryptV4Text(x.ciphertext, x.pin), code('legacy-not-ciphertext'), x.id);
    } else if (x.id === 'edge-wrong-pin') {
      await assert.rejects(decryptV4Text(x.ciphertext, x.pin), code('legacy-wrong-pin'), x.id);
    } else if (x.id === 'edge-empty-plaintext-undecryptable') {
      assert.equal(await decryptV4Text(x.ciphertext, x.pin), '', x.id);
    } else {
      // Every whitespace variant decodes (the original depended on L mod 4), raw base64 too.
      const want = x.plaintext ?? (x.original_aesDecrypt.ok ? x.original_aesDecrypt.result : base[x.base].plaintext);
      assert.equal(await decryptV4Text(x.ciphertext, x.pin), want, x.id);
    }
  }
});

test('PIN retries: exact, trimmed, NFC, NFD (distinct values only)', async () => {
  assert.deepEqual(pinVariants('1234'), ['1234']);
  assert.deepEqual(pinVariants(' 1234 '), [' 1234 ', '1234']);
  assert.deepEqual(pinVariants('é'), ['é', 'e\u0301']);
  assert.deepEqual(pinVariants('e\u0301'), ['e\u0301', 'é']);
  assert.deepEqual(pinVariants(' e\u0301'), [' e\u0301', 'e\u0301', ' é', 'é']);
  assert.deepEqual(pinVariants(''), []);
  assert.deepEqual(pinVariants('   '), ['   ']);
  assert.deepEqual(pinVariants(undefined), []);

  const hello = desk.v4_text[0]; // pin '1234'
  assert.equal(await decryptV4Text(hello.ciphertext, ' 1234\n'), hello.plaintext);
  await assert.rejects(decryptV4Text(hello.ciphertext, '1234 5'), code('legacy-wrong-pin'));
  const long = desk.v4_text.find((v) => v.id === 'v4-4-long'); // pin 'P@ssw0rd!é' (NFC)
  assert.equal(await decryptV4Text(long.ciphertext, long.pin.normalize('NFD')), long.plaintext);
  await assert.rejects(decryptV4Text(long.ciphertext, long.pin.toUpperCase()), code('legacy-wrong-pin'));
  // A PIN that really had spaces only works typed exactly (never "re-added").
  const spaced = web.v4.vectors.find((v) => v.pin === ' spaced pin ');
  assert.equal(await decryptV4Text(spaced.ciphertext, ' spaced pin '), spaced.plaintext);
  await assert.rejects(decryptV4Text(spaced.ciphertext, 'spaced pin'), code('legacy-wrong-pin'));
  // A PIN set in NFD form opens when typed in NFC.
  const nfd = await sealV4('nfd pin', 'cafe\u0301');
  assert.equal(await decryptV4Text(nfd, 'café'), 'nfd pin');
  await assert.rejects(decryptV4Text(nfd, ''), code('legacy-wrong-pin'));
  await assert.rejects(decryptV4Text(nfd, null), code('legacy-wrong-pin'));
});

test('pbkdf2Legacy = PBKDF2-HMAC-SHA256(UTF-8 pin, salt, 100000, 32)', async () => {
  const salt = fromHex(desk.v4_text[0].salt_hex);
  for (const pin of ['1234', 'pässwörd🔑', ' x ', '\ud800']) {
    assert.deepEqual(Buffer.from(await pbkdf2Legacy(pin, salt)), pbkdf2Sync(Buffer.from(utf8(pin)), salt, 100000, 32, 'sha256'), pin);
  }
  await assert.rejects(pbkdf2Legacy('1234', new Uint8Array(15)), TypeError);
  await assert.rejects(pbkdf2Legacy(1234, salt), TypeError);
});

test('1-block precheck on file payloads (web records, desktop .czd)', async () => {
  for (const v of web.files.single_real_constants) {
    assert.equal(await pinMatchesV4(v.record.cipher, v.pin), true, v.label);
    assert.equal(await pinMatchesV4(v.record.cipher, `${v.pin}x`), false, v.label);
  }
  for (const v of web.files.batched_reduced_constants.vectors) {
    const first = v.record.isChunked ? v.record.chunks[0] : v.record.cipher;
    assert.equal(await pinMatchesV4(first, v.pin), true, v.label);
    assert.equal(await pinMatchesV4(` ${first}\n`, ` ${v.pin} `), true, v.label);
  }
  for (const v of desk.czd_files) {
    const cipher = JSON.parse(v.expected.file_text).cipher;
    assert.equal(await pinMatchesV4(cipher, v.pin), v.id !== 'czd-7-crafted-nonimage', v.id);
    assert.equal(await pinMatchesV4(cipher, 'nope'), false, v.id);
  }
  await assert.rejects(pinMatchesV4('hello world', '1234'), code('legacy-not-ciphertext'));
  // The head of a long ciphertext is enough and equals the start of the full blob.
  const big = web.files.single_real_constants[2].record.cipher;
  assert.ok(big.length > 256);
  const head = v4Head(big);
  assert.equal(head.length, 60);
  assert.deepEqual(head, v4Blob(big).subarray(0, 60));
  const keys = await v4Keys(web.files.single_real_constants[2].pin, head);
  assert.equal(await precheckV4(head, keys), true);
  // Payloads shorter than the prefix can never match.
  const tiny = v4Blob(await sealV4('{"v":1,"typ', 'p'));
  assert.equal(await precheckV4(tiny, await v4Keys('p', tiny)), false);
  const exact = v4Blob(await sealV4('{"v":1,"type":"', 'p'));
  assert.equal(await precheckV4(exact, await v4Keys('p', exact)), true);
});

test('plaintext decoding like the original TextDecoder: one BOM stripped, bad UTF-8 → U+FFFD', async () => {
  const one = await sealV4('\ufeffhello', 'b');
  assert.equal(await decryptV4Text(one, 'b'), 'hello');
  assert.deepEqual(await decryptV4Bytes(one, 'b'), utf8('\ufeffhello'));
  assert.equal(await decryptV4Text(await sealV4('\ufeff\ufeffx', 'b'), 'b'), '\ufeffx');
  assert.equal(await decryptV4Text(await sealV4(new Uint8Array([0x61, 0xff, 0x62]), 'b'), 'b'), 'a\ufffdb');
});

test('base64-stage failures are legacy-not-ciphertext', async () => {
  for (const bad of ['', 'hello world', 'ა', `${'ა'.repeat(57)}`, 42, null, `${SA.slice(0, 60).join('')}!`]) {
    await assert.rejects(decryptV4Text(bad, '1234'), code('legacy-not-ciphertext'), String(bad).slice(0, 10));
  }
  // 43 bytes: one short of the minimum.
  await assert.rejects(decryptV4Text(bytesToScript(new Uint8Array(43)), '1234'), code('legacy-not-ciphertext'));
  assert.throws(() => v4Blob(toB64(new Uint8Array(60)), { allowRawBase64: false }), code('legacy-not-ciphertext'));
  // 44 zero bytes parse but cannot authenticate.
  await assert.rejects(decryptV4Text(bytesToScript(new Uint8Array(44)), '1234'), code('legacy-wrong-pin'));
});

test('isAES and looksLikeV4 on the detection vectors', () => {
  assert.equal(web.detection.length, 11);
  for (const d of web.detection) {
    assert.equal(isAES(d.input), d.isAES, d.input);
    // Georgian prose has no v4-only letter: never taken for ciphertext.
    assert.equal(looksLikeV4(d.input), d.isAES && d.input !== 'გამარჯობა მეგობარო', d.input);
  }
  assert.equal(isAES(42), false);
  assert.equal(looksLikeV4(null), false);
});
