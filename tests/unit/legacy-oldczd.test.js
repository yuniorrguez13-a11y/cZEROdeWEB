// app/legacy/oldczd.js against every desktop .czd vector, plus sniffing and malformed files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ROOT } from './helpers-phase0.js';
import { cleanMime, isOldCzd, openOldCzd } from '../../app/legacy/oldczd.js';
import { bytesToScript } from '../../app/crypto/stealth.js';
import { CzdError } from '../../app/errors.js';
import { fromB64, utf8 } from '../../app/util/bytes.js';
import { safeFilename, safeMediaType } from '../../app/util/format.js';

const desk = JSON.parse(readFileSync(path.join(ROOT, 'tests/vectors/legacy-desktop-vectors.json'), 'utf8'));
const web = JSON.parse(readFileSync(path.join(ROOT, 'tests/vectors/legacy-web-vectors.json'), 'utf8'));
const code = (c) => (e) => e instanceof CzdError && e.code === c;
const sha256 = (u8) => createHash('sha256').update(u8).digest('hex');
const blobBytes = async (b) => new Uint8Array(await b.arrayBuffer());
const IMAGES = desk.czd_files.filter((v) => !v.crafted);

async function sealV4(plain, pin) {
  const subtle = globalThis.crypto.subtle;
  const salt = new Uint8Array(16).fill(3);
  const iv = new Uint8Array(12).fill(5);
  const base = await subtle.importKey('raw', utf8(pin), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8(plain)));
  const blob = new Uint8Array(28 + ct.length);
  blob.set(salt, 0);
  blob.set(iv, 16);
  blob.set(ct, 28);
  return bytesToScript(blob);
}
const czd = (cipher) => JSON.stringify({ v: 1, type: 'image', cipher });

test('every desktop .czd vector opens; names get an extension from the mime', async () => {
  assert.equal(desk.czd_files.length, 7);
  for (const v of IMAGES) {
    const e = v.expected;
    assert.equal(sha256(utf8(e.file_text)), e.file_sha256, v.id);
    const r = await openOldCzd(e.file_text, v.pin);
    const bytes = await blobBytes(r.blob);
    assert.deepEqual(bytes, fromB64(v.input.file_bytes_b64), v.id);
    assert.equal(bytes.length, v.input.file_size);
    assert.equal(r.type, e.mime);
    assert.equal(r.blob.type, safeMediaType(e.mime));
    const ext = { 'image/png': 'png', 'image/gif': 'gif' }[e.mime];
    assert.equal(r.name, safeFilename(`${e.name}.${ext}`), v.id);
    // The same file read as bytes (Uint8Array) works too.
    assert.equal((await openOldCzd(utf8(e.file_text), v.pin)).name, r.name);
  }
  const grad = IMAGES.find((v) => v.id === 'czd-3-gradient-renamed');
  assert.equal(grad.expected.name, 'grad.8x8'); // the picked file's base name, not the renamed .czd
  assert.equal((await openOldCzd(grad.expected.file_text, grad.pin)).name, safeFilename('grad.8x8.png'));
});

test('crafted non-image .czd comes back as text', async () => {
  const v = desk.czd_files.find((x) => x.id === 'czd-7-crafted-nonimage');
  const r = await openOldCzd(v.expected.file_text, v.pin);
  assert.equal(r.type, 'text/plain');
  assert.equal(r.name, 'decrypted.txt');
  assert.equal(await r.blob.text(), v.expected.viewer_text_out);
  assert.equal(v.expected.inner_plaintext, v.expected.viewer_text_out);
});

test('wrong PIN, PIN spellings, BOM', async () => {
  const red = IMAGES.find((v) => v.id === 'czd-1-red-dot'); // pin '1234'
  await assert.rejects(openOldCzd(red.expected.file_text, '4321'), code('legacy-wrong-pin'));
  assert.equal((await openOldCzd(red.expected.file_text, ' 1234\t')).type, 'image/png');
  assert.equal((await openOldCzd(`\ufeff${red.expected.file_text}`, '1234')).type, 'image/png');
  assert.equal((await openOldCzd(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(red.expected.file_text)]), '1234')).type, 'image/png');
  // A PIN that really ends in a space must be typed with it.
  const fallback = IMAGES.find((v) => v.id === 'czd-5-browser-fallback');
  assert.equal(fallback.pin, 'pin with trailing space ');
  assert.equal((await openOldCzd(fallback.expected.file_text, fallback.pin)).name, safeFilename('browser pixel.png'));
  await assert.rejects(openOldCzd(fallback.expected.file_text, fallback.pin.trim()), code('legacy-wrong-pin'));
  const unicode = IMAGES.find((v) => v.id === 'czd-3-gradient-renamed');
  assert.equal((await openOldCzd(unicode.expected.file_text, unicode.pin.normalize('NFD'))).type, 'image/png');
});

test('missing / non-string mime, odd names, web file payloads', async () => {
  const data = IMAGES[0].input.file_bytes_b64;
  const cases = [
    [{ v: 1, type: 'image', name: 'nomime', data }, 'image/png', 'nomime.png'],
    [{ v: 1, type: 'image', mime: '', name: 'empty mime', data }, 'image/png', 'empty mime.png'],
    [{ v: 1, type: 'image', mime: 42, name: 'num', data }, 'image/png', 'num.png'],
    [{ v: 1, type: 'image', mime: 'IMAGE/JPEG', name: 'up', data }, 'image/jpeg', 'up.jpg'],
    [{ v: 1, type: 'image', mime: 'image/webp', data }, 'image/webp', 'decrypted_image.webp'],
    [{ v: 1, type: 'image', mime: 'image/svg+xml', name: 'vec', data }, 'image/svg+xml', 'vec.svg'],
    [{ v: 1, type: 'image', mime: 'image/heic', name: 'phone', data }, 'image/heic', 'phone.heic'],
    [{ v: 1, type: 'image', mime: 'text/html; x', name: '../../evil', data }, 'image/png', '../../evil.png'],
    [{ v: 1, type: 'file', mime: 'application/pdf', name: 'doc', ext: 'pdf', data }, 'application/pdf', 'doc.pdf'],
  ];
  for (const [payload, type, name] of cases) {
    const r = await openOldCzd(czd(await sealV4(JSON.stringify(payload), 'p')), 'p');
    assert.equal(r.type, type, JSON.stringify(payload).slice(0, 60));
    assert.equal(r.name, safeFilename(name));
    assert.equal(r.blob.type, safeMediaType(type));
    assert.deepEqual(await blobBytes(r.blob), fromB64(data));
  }
  // A web single-file payload taken from the web vectors.
  const tiny = web.files.single_real_constants[0];
  const r = await openOldCzd(czd(tiny.record.cipher), tiny.pin);
  assert.equal(sha256(await blobBytes(r.blob)), tiny.expected_plaintext_sha256);
  assert.equal(r.name, safeFilename(tiny.original_decrypt.download_name));
});

test('malformed files', async () => {
  const good = await sealV4('{"v":1,"type":"image","mime":"image/png","data":"!!"}', 'p');
  await assert.rejects(openOldCzd(czd(good), 'p'), code('legacy-bad-record')); // bad base64 inside
  for (const bad of ['', 'not json', '{"v":1,"type":"image"}', '{"v":1,"type":"image","cipher":""}', '{"v":1,"type":"image","cipher":7}', 'null', '[1]', 7, null]) {
    await assert.rejects(openOldCzd(bad, 'p'), code('legacy-bad-record'), String(bad));
  }
  await assert.rejects(openOldCzd(new Uint8Array([0x7b, 0xff, 0x7d]), 'p'), code('legacy-bad-record'));
  await assert.rejects(openOldCzd('{"v":1,"type":"image","cipher":"hello world"}', 'p'), code('legacy-not-ciphertext'));
});

test('isOldCzd sniffs {"v":1, from the first 8 bytes', () => {
  for (const v of desk.czd_files) {
    const bytes = utf8(v.expected.file_text);
    assert.equal(isOldCzd(bytes.subarray(0, 8)), true, v.id);
    assert.equal(isOldCzd(bytes), true, v.id);
    assert.equal(isOldCzd(bytes.buffer.slice(0, 8)), true, v.id);
  }
  const yes = ['{"v":1,"type":"image"', '{"v":1,', '{ "v" : 1 ,', '\ufeff{"v":1,"t', '\n{\n  "v": 1,\n', '{"v":', '{ "v"', '{"v": 1'];
  const no = ['{"v":2,"type"', '{"v":12,', '{"a":1}', '{"cipher":"x"}', 'czd2xxxx', '', '{', '{   ', '{"', '[{"v":1,', '{"v":1}', 'v":1,'];
  for (const s of yes) assert.equal(isOldCzd(utf8(s).subarray(0, 8)), true, JSON.stringify(s));
  for (const s of no) assert.equal(isOldCzd(utf8(s).subarray(0, 8)), false, JSON.stringify(s));
  assert.equal(isOldCzd('{"v":1,"type":"image"'), true);
  assert.equal(isOldCzd(null), false);
  assert.equal(isOldCzd(new Uint8Array(64)), false);
});

test('cleanMime', () => {
  assert.equal(cleanMime(' Image/PNG\n'), 'image/png');
  assert.equal(cleanMime('audio/x-m4a'), 'audio/x-m4a');
  for (const bad of ['', 'png', 'image/', '/png', 'text/html; charset=utf-8', 'a/b/c', 'image/p ng', 42, null, `image/${'a'.repeat(130)}`]) {
    assert.equal(cleanMime(bad), '', String(bad));
  }
  // The app's own pseudo-types never come from old data (an old record must not pose as a note or bundle).
  for (const own of ['application/x-czd-note', 'Application/X-CZD-Bundle', 'application/x-czd-anything']) assert.equal(cleanMime(own), '', own);
  assert.equal(cleanMime('application/x-czeroode'), 'application/x-czeroode');
});

test('a payload claiming an app pseudo-type comes back as a plain file', async () => {
  const data = IMAGES[0].input.file_bytes_b64;
  for (const mime of ['application/x-czd-note', 'application/x-czd-bundle']) {
    const r = await openOldCzd(czd(await sealV4(JSON.stringify({ v: 1, type: 'file', mime, name: 'n', ext: 'bin', data }), 'p')), 'p');
    assert.equal(r.type, 'application/octet-stream', mime);
    const img = await openOldCzd(czd(await sealV4(JSON.stringify({ v: 1, type: 'image', mime, name: 'n', data }), 'p')), 'p');
    assert.equal(img.type, 'image/png', mime);
  }
});
