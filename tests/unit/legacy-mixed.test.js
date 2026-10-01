// app/legacy/mixed.js against every v1/v2/v3/detection vector (web + desktop) and the recorded tables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-phase0.js';
import { LEGEND, decodeV1, decodeV2, decodeV3, detectLegacyText, isGeo, isV2C, shufA, srng, vigKey } from '../../app/legacy/mixed.js';
import { looksLikeV4 } from '../../app/legacy/v4.js';
import { SA } from '../../app/crypto/stealth.js';
import { CzdError } from '../../app/errors.js';

const web = JSON.parse(readFileSync(path.join(ROOT, 'tests/vectors/legacy-web-vectors.json'), 'utf8'));
const desk = JSON.parse(readFileSync(path.join(ROOT, 'tests/vectors/legacy-desktop-vectors.json'), 'utf8'));
const C = web.constants;
const code = (c) => (e) => e instanceof CzdError && e.code === c;
const NOISE = new Set(C.NC.map((n) => n.char));
const hasNoise = (s) => [...s].some((c) => NOISE.has(c));

// Independent v2 encoder pieces (legacy-web.md §4.3) for round trips.
const sm3 = (s) => {
  const c = [...s];
  const ch = [];
  for (let i = 0; i < c.length; i += 3) ch.push(c.slice(i, i + 3));
  return ch.reverse().map((x) => x.join('')).join('');
};
const encCyr = (s) => s.split('').map((c) => (c >= 'A' && c <= 'Z' ? C.CYR[c] : (C.GEO[c.toLowerCase()] ?? c))).join('');
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 2 ** 32;
  };
}

test('v1 vectors: encode/decode and decode-only', () => {
  assert.equal(web.v1.encode_decode.length, 20);
  for (const v of web.v1.encode_decode) {
    const r = decodeV1(v.encoded);
    assert.equal(r.text, v.decoded_by_original, v.input);
    assert.equal(r.ambiguousQY, v.encoded.includes('ყ'));
    assert.equal(r.text === v.input, v.roundtrip_exact);
  }
  assert.equal(web.v1.decode_only.length, 8);
  for (const v of web.v1.decode_only) assert.equal(decodeV1(v.input).text, v.decoded_by_original, v.input);
  for (const v of desk.legacy_text.v1) {
    assert.equal(decodeV1(v.encoded).text, v.original_decT, v.plaintext);
    assert.equal(decodeV1(v.encoded).ambiguousQY, v.plaintext.toLowerCase().includes('q') || v.plaintext.toLowerCase().includes('y'));
  }
  assert.throws(() => decodeV1(null), code('legacy-not-ciphertext'));
});

test('recorded tables: GR/CR reverse maps (last writer wins), GSET, LEGEND', () => {
  for (const [g, latin] of Object.entries(C.GR)) assert.equal(decodeV1(g).text, latin, g);
  for (const [c, latin] of Object.entries(C.CR)) assert.equal(decodeV1(c).text, latin, c);
  assert.equal(Object.keys(C.GR).length, C.GSET_size);
  assert.equal(LEGEND.length, 26);
  assert.ok(Object.isFrozen(LEGEND) && Object.isFrozen(LEGEND[0]));
  for (const row of LEGEND) {
    assert.equal(row.geo, C.GEO[row.latin]);
    assert.equal(row.cyr, C.CYR[row.latin.toUpperCase()]);
    assert.equal(row.geoReadsAs, C.GR[row.geo]);
    assert.equal(row.cyrReadsAs, C.CR[row.cyr]);
  }
  const shared = (k) => LEGEND.filter((r) => r[k]).map((r) => r.latin).join('');
  assert.equal(shared('geoShared'), 'qy');
  assert.equal(shared('cyrShared'), 'bcfhnpqrsv');
  assert.equal(LEGEND.find((r) => r.latin === 'q').geoReadsAs, 'y');
});

test('v2 vectors: corrected method III, original output elsewhere', () => {
  assert.equal(web.v2.vectors.length, 35);
  for (const v of web.v2.vectors) {
    const r = decodeV2(v.ciphertext);
    const n = `m${v.method} ${v.plaintext}`;
    assert.equal(r.method, v.method, n);
    assert.equal(r.methodName, v.method_name, n);
    assert.equal(isV2C(v.ciphertext), v.ui_detects_as_ciphertext, n);
    if (v.method !== 3) assert.equal(r.text, v.original_decoder_output, n);
    if (!hasNoise(v.plaintext)) assert.equal(r.text, v.intended_output, n);
    else assert.notEqual(r.text, v.intended_output, n); // noise characters in the plaintext are lost
  }
  // Method III vectors the original got wrong are now right.
  const fixed = web.v2.vectors.filter((v) => v.method === 3 && !v.original_decoder_correct && !hasNoise(v.plaintext));
  assert.ok(fixed.length >= 3);
  for (const v of desk.legacy_text.v2) {
    const r = decodeV2(v.ciphertext);
    assert.equal(r.text, v.corrected_decode, v.plaintext);
    assert.equal(r.method, v.method);
  }
});

test('v2 edge cases: leading/trailing whitespace, markers, noise set, bad input', () => {
  for (const e of web.v2.edge_cases) {
    assert.equal(isV2C(e.input), e.isV2C);
    assert.equal(e.v2sdec, null); // the original failed here
    assert.deepEqual(decodeV2(e.input), decodeV2(e.input.trim()));
    assert.equal(decodeV2(e.input).text, 'nello world');
  }
  assert.deepEqual(decodeV2(`\n${desk.legacy_text.v2[0].ciphertext}\r\n`).text, desk.legacy_text.v2[0].corrected_decode);
  for (const [m, marker] of Object.entries(C.MM)) {
    assert.equal(decodeV2(`${marker}ა`).method, Number(m));
    assert.equal(decodeV2(`${marker}ა`).methodName, C.MN[m]);
  }
  for (const { char } of C.NC) assert.equal(decodeV2(`╾${char}ბ${char}ა${char}`).text, 'ab', char);
  assert.equal(decodeV2('╾').text, '');
  for (const bad of ['', '   ', 'hello', 'ა╾', 7]) assert.throws(() => decodeV2(bad), code('legacy-not-ciphertext'), String(bad));
});

test('v2 round trips with an independent encoder (every method, every length mod 3)', () => {
  const r = rng(0xc0ffee);
  const scr = { 1: (s) => [...s].reverse().join(''), 2: (s) => s.split(' ').map((w) => [...w].reverse().join('')).join(' '), 3: sm3,
    4: (s) => { const c = [...s]; const o = []; for (let i = 0; i < c.length; i += 2) { if (i + 1 < c.length) o.push(c[i + 1], c[i]); else o.push(c[i]); } return o.join(''); } };
  scr[5] = (s) => scr[4]([...s].reverse().join(''));
  const noise = [...NOISE];
  const plains = ['', 'a', 'ab', 'abc', 'abcd', 'abcde', 'x y  z', 'Zebra QUIZ', '😀😀😀😀', 'hi 😀 there', 'Meet me at 9!'];
  for (const p of plains) {
    for (let m = 1; m <= 5; m++) {
      let ct = Object.entries(C.MM).find(([k]) => Number(k) === m)[1];
      ct += noise[Math.floor(r() * noise.length)] + noise[Math.floor(r() * noise.length)];
      for (const ch of scr[m](encCyr(p))) ct += ch + (r() < 0.3 ? noise[Math.floor(r() * noise.length)] : '');
      ct += noise[Math.floor(r() * noise.length)] + noise[Math.floor(r() * noise.length)];
      assert.equal(decodeV2(ct).text, decodeV1(encCyr(p)).text, `m${m} ${p}`);
    }
  }
});

test('v3 vectors, edge cases and desktop vectors (exact original output)', () => {
  assert.equal(web.v3.vectors.length, 17);
  for (const v of web.v3.vectors) {
    const r = decodeV3(v.ciphertext, v.pin);
    assert.equal(r.text, v.original_decoder_output, `${v.pin} ${v.plaintext}`);
    assert.equal(r.ambiguousQY, v.ciphertext.includes('ყ'));
    assert.equal(isGeo(v.ciphertext), v.ui_detects_as_ciphertext);
    if (v.ui_detects_as_ciphertext) assert.equal(r.text, v.ui_decode_output);
  }
  assert.equal(web.v3.edge_cases.length, 6);
  for (const e of web.v3.edge_cases) {
    assert.equal(decodeV3(e.input, e.pin).text, e.v3sd, `${e.description} ${e.pin}`);
    assert.equal(isGeo(e.input), e.isGeo);
  }
  for (const v of desk.legacy_text.v3) {
    const r = decodeV3(v.ciphertext, v.pin);
    assert.equal(r.text, v.original_v3sdec, v.plaintext);
    assert.equal(r.ambiguousQY, v.ambiguous_U10E7_count > 0);
  }
  assert.throws(() => decodeV3('ა', ''), code('legacy-wrong-pin'));
  assert.throws(() => decodeV3('ა', undefined), code('legacy-wrong-pin'));
  assert.throws(() => decodeV3(undefined, '1'), code('legacy-not-ciphertext'));
});

test('v3 internals: float-multiply seed, signed xorshift, shuffle, Vigenère key', () => {
  assert.equal(web.v3.internals.length, 8);
  for (const v of web.v3.internals) {
    assert.equal(v.pin.length, v.pin_utf16_units);
    const next = srng(v.pin);
    const values = Array.from({ length: 8 }, () => next());
    assert.deepEqual(values, v.first_8_rng_values, v.pin);
    assert.deepEqual(values.map((x) => Math.round(x * 0xffffffff)), v.first_8_rng_states_u32);
    assert.equal(shufA(v.pin).join(''), v.shuffled_alphabet, v.pin);
    assert.equal(vigKey(v.pin), v.vig_key, v.pin);
  }
});

test('detection vectors and detectLegacyText order', () => {
  const want = {
    'hello world': null,
    'გამარჯობა მეგობარო': 'v3',
    'ПРИВЕТ МИР КАК ДЕЛА': null,
    'привет мир как дела': null,
    'ჰელლო': 'v3',
    'ჰელ': 'v1',
    'კმუუჰ გჰდუტ': 'v3',
    '╾hello': 'v2',
  };
  for (const d of web.detection) {
    assert.equal(isGeo(d.input), d.isGeo, d.input);
    assert.equal(isV2C(d.input), d.isV2C, d.input);
    const expected = d.isV2C ? 'v2' : d.input in want ? want[d.input] : 'v4';
    assert.equal(detectLegacyText(d.input), expected, d.input);
  }
  for (const v of web.v4.vectors) assert.equal(detectLegacyText(v.ciphertext), 'v4');
  for (const v of desk.v4_text) assert.equal(detectLegacyText(`\n${v.ciphertext}\n`), 'v4');
  for (const v of web.v2.vectors) assert.equal(detectLegacyText(v.ciphertext), 'v2');
  // v3 output is lower case Georgian; v1 text with Cyrillic capitals is v1.
  for (const v of web.v3.vectors.filter((x) => x.ui_detects_as_ciphertext)) assert.equal(detectLegacyText(v.ciphertext), 'v3', v.ciphertext);
  for (const v of desk.legacy_text.v1) assert.equal(detectLegacyText(v.encoded), v.caps === 'cyrillic' && /[A-Z]/.test(v.plaintext) ? 'v1' : (isGeo(v.encoded) ? 'v3' : 'v1'), v.encoded);
  // A long v1 message without spaces is mostly stealth letters but has no v4-only letter.
  const longV1 = 'ჰელლოწორლდ'.repeat(8);
  assert.equal(looksLikeV4(longV1), false);
  assert.equal(detectLegacyText(longV1), 'v3');
  for (const s of ['', '   ', '123 !!!', 'plain English text', null, 5]) assert.equal(detectLegacyText(s), null, String(s));
});

test('looksLikeV4 uses exactly the stealth letters v1–v3 never emit', () => {
  const mixed = new Set([...Object.values(C.GEO), ...Object.values(C.CYR)]);
  const only = SA.filter((c) => !mixed.has(c));
  assert.equal(only.length, 18);
  for (const c of SA) assert.equal(looksLikeV4(`${'ა'.repeat(11)}${c}`), only.includes(c), c);
});
