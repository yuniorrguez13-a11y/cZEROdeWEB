// Legacy Mixed Script v1–v3 decoders (decode only). None of these were encryption: v1 is a letter map,
// v2 a keyless scramble with noise, v3 a PIN-seeded alphabet shuffle plus Vigenère. All three are lossy
// (q and y share ყ; five Cyrillic capitals are shared; case is lost). Ported from the original code as
// specified in legacy-web.md §4 (identical in the desktop edition); the only deliberate change is the
// corrected inverse of v2 method III.

import { CzdError } from '../errors.js';
import { looksLikeV4 } from './v4.js';

const SRC = 'abcdefghijklmnopqrstuvwxyz';
const GEO = { a: 'ა', b: 'ბ', c: 'ც', d: 'დ', e: 'ე', f: 'ფ', g: 'გ', h: 'ჰ', i: 'ი', j: 'ჯ', k: 'კ', l: 'ლ', m: 'მ', n: 'ნ', o: 'ო', p: 'პ', q: 'ყ', r: 'რ', s: 'ს', t: 'ტ', u: 'უ', v: 'ვ', w: 'წ', x: 'ხ', y: 'ყ', z: 'ზ' };
const CYR = { A: 'А', B: 'В', C: 'С', D: 'Д', E: 'Е', F: 'Ф', G: 'Г', H: 'Н', I: 'И', J: 'Ж', K: 'К', L: 'Л', M: 'М', N: 'Н', O: 'О', P: 'Р', Q: 'Ф', R: 'Р', S: 'С', T: 'Т', U: 'У', V: 'В', W: 'Ш', X: 'Х', Y: 'Ч', Z: 'З' };
// Reverse maps built in a…z / A…Z order, so the last writer wins (ყ → y, В → v, С → s, Ф → q, Н → n, Р → r).
const GR = new Map(Object.entries(GEO).map(([k, v]) => [v, k]));
const CR = new Map(Object.entries(CYR).map(([k, v]) => [v, k.toLowerCase()]));
const GSET = new Set(Object.values(GEO));
const CYRSET = new Set(Object.values(CYR));
const QY = 'ყ';

const NSET = new Set('†‡§¶※◊●○◦•⁕⁂✦✧✩✪⌘⌬⍟⏣⌖⎌⌀');
const M2M = new Map([['╾', 1], ['╿', 2], ['╼', 3], ['╽', 4], ['╻', 5]]);
const MN = { 1: 'I·Reverse', 2: 'II·Word Mirror', 3: 'III·Chunk Shift', 4: 'IV·Pair Flip', 5: 'V·Mirror Fold' };

const LETTER = /\p{L}/u;

/** Per UTF-16 unit: GR, then CR, else unchanged (the original decT). */
function decT(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    out += GR.get(c) ?? CR.get(c) ?? c;
  }
  return out;
}

// v2 unscramblers, on code points; sm2 splits on U+0020 only.
const rev = (s) => [...s].reverse().join('');
const sm2 = (s) => s.split(' ').map(rev).join(' ');
function sm4(s) {
  const c = [...s];
  const o = [];
  for (let i = 0; i < c.length; i += 2) {
    if (i + 1 < c.length) o.push(c[i + 1], c[i]);
    else o.push(c[i]);
  }
  return o.join('');
}
// Correct inverse of the 3-code-point chunk reversal: the first chunk is len % 3 || 3 long.
function un3(s) {
  const c = [...s];
  if (!c.length) return '';
  const first = c.length % 3 || 3;
  const ch = [c.slice(0, first)];
  for (let i = first; i < c.length; i += 3) ch.push(c.slice(i, i + 3));
  return ch.reverse().map((x) => x.join('')).join('');
}
const UNSCRAMBLE = { 1: rev, 2: sm2, 3: un3, 4: sm4, 5: (s) => rev(sm4(s)) };

/**
 * v3 PRNG exactly as the original: FNV-1a-like seed over UTF-16 units with a float64 multiply, then
 * xorshift32 with the signed >> 17, returning h / 0xFFFFFFFF in [0, 1]. Exported for tests.
 * @param {string} pin
 * @returns {() => number}
 */
export function srng(pin) {
  let h = 2166136261;
  for (let i = 0; i < pin.length; i++) {
    h ^= pin.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return () => {
    h ^= h << 13;
    h ^= h >> 17;
    h ^= h << 5;
    h >>>= 0;
    return h / 0xffffffff;
  };
}

/** v3 shuffled alphabet (Fisher–Yates driven by srng). Exported for tests. @param {string} pin @returns {string[]} */
export function shufA(pin) {
  const a = SRC.split('');
  const rng = srng(pin);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** v3 Vigenère key: the PIN lower-cased, a–z only, else 'x'. Exported for tests. @param {string} pin */
export function vigKey(pin) {
  return pin.toLowerCase().replace(/[^a-z]/g, '') || 'x';
}

// Vigenère decrypt; the key index is the UTF-16 index in the whole text (every unit advances it).
function unvig(text, pin) {
  const key = vigKey(pin);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 97 && code <= 122) {
      const sh = key.charCodeAt(i % key.length) - 97;
      out += String.fromCharCode(((code - 97 - sh + 26) % 26) + 97);
    } else {
      out += text[i];
    }
  }
  return out;
}

/**
 * The original v2 detector: the first code point after trimStart() is a method marker.
 * @param {string} s
 * @returns {boolean}
 */
export function isV2C(s) {
  if (typeof s !== 'string') return false;
  const f = [...s.trimStart()][0];
  return f !== undefined && M2M.has(f);
}

/**
 * The original v3 detector: at least 5 code points after trim(), more than 60 % of them GEO letters.
 * @param {string} s
 * @returns {boolean}
 */
export function isGeo(s) {
  if (typeof s !== 'string') return false;
  const c = [...s.trim()];
  if (c.length < 5) return false;
  let hits = 0;
  for (const x of c) if (GSET.has(x)) hits++;
  return hits / c.length > 0.6;
}

/**
 * Guesses which legacy text format `s` is, in the order of legacy-web.md §4.5:
 * v2 (marker first) → v4 (looksLikeV4) → v3 (isGeo, no Cyrillic capitals: v3 output is all lower case)
 * → v1 (some GEO letter and more than 60 % of the letters are GEO/CYR letters). v1 and v3 look alike;
 * the UI lets the user switch.
 * @param {string} s
 * @returns {'v4'|'v3'|'v2'|'v1'|null}
 */
export function detectLegacyText(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t) return null;
  if (isV2C(t)) return 'v2';
  if (looksLikeV4(t)) return 'v4';
  let geo = 0;
  let cyr = 0;
  let letters = 0;
  for (const ch of t) {
    if (GSET.has(ch)) geo++;
    else if (CYRSET.has(ch)) cyr++;
    if (LETTER.test(ch)) letters++;
  }
  if (!geo) return null;
  if (!cyr && isGeo(t)) return 'v3';
  return (geo + cyr) / letters > 0.6 ? 'v1' : null;
}

/**
 * v1 decode (the original decT): GEO letters → a–z, CYR capitals → a–z, everything else unchanged.
 * @param {string} s
 * @returns {{text: string, ambiguousQY: boolean}}
 */
export function decodeV1(s) {
  if (typeof s !== 'string') throw new CzdError('legacy-not-ciphertext');
  return { text: decT(s), ambiguousQY: s.includes(QY) };
}

/**
 * v2 decode with the corrected method-III inverse. Surrounding whitespace is ignored (the original trimmed only
 * for detection; a real ciphertext always starts with a marker and ends with noise). Every noise code point is
 * removed, so plaintext that contained noise characters cannot be recovered exactly.
 * Throws CzdError('legacy-not-ciphertext') when the first code point is not a method marker.
 * @param {string} s
 * @returns {{text: string, method: number, methodName: string}}
 */
export function decodeV2(s) {
  if (typeof s !== 'string') throw new CzdError('legacy-not-ciphertext');
  const c = [...s.trim()];
  const method = c.length ? M2M.get(c[0]) : undefined;
  if (!method) throw new CzdError('legacy-not-ciphertext');
  const body = c.slice(1).filter((x) => !NSET.has(x)).join('');
  return { text: decT(UNSCRAMBLE[method](body)), method, methodName: MN[method] };
}

/**
 * v3 decode exactly as the original v3sd, on the text as given (leading whitespace shifts the Vigenère key,
 * as it did in the original). Unverifiable: any PIN produces some output.
 * Throws CzdError('legacy-wrong-pin') for a missing or empty PIN (the original never accepted one).
 * @param {string} s
 * @param {string} pin
 * @returns {{text: string, ambiguousQY: boolean}}
 */
export function decodeV3(s, pin) {
  if (typeof s !== 'string') throw new CzdError('legacy-not-ciphertext');
  if (typeof pin !== 'string' || !pin) throw new CzdError('legacy-wrong-pin');
  const sh = shufA(pin);
  const rv = new Map(sh.map((c, i) => [c, SRC[i]]));
  const s2 = unvig(decT3(s), pin);
  let text = '';
  for (let i = 0; i < s2.length; i++) {
    const c = s2[i];
    text += rv.get(c.toLowerCase()) || c;
  }
  return { text, ambiguousQY: s.includes(QY) };
}

// v3 step 1: GEO letters → a–z only (Latin letters and Cyrillic are kept).
function decT3(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) out += GR.get(text[i]) ?? text[i];
  return out;
}

/**
 * Rows for the Legend chart: each Latin letter, the Georgian letter used for it (lower case) and the Cyrillic
 * capital used for it (v1 caps), what each one decodes back to, and whether the mapping is shared.
 * @type {ReadonlyArray<Readonly<{latin: string, geo: string, cyr: string, geoReadsAs: string, cyrReadsAs: string, geoShared: boolean, cyrShared: boolean}>>}
 */
export const LEGEND = Object.freeze(SRC.split('').map((latin) => {
  const geo = GEO[latin];
  const cyr = CYR[latin.toUpperCase()];
  return Object.freeze({
    latin,
    geo,
    cyr,
    geoReadsAs: GR.get(geo),
    cyrReadsAs: CR.get(cyr),
    geoShared: Object.values(GEO).filter((g) => g === geo).length > 1,
    cyrShared: Object.values(CYR).filter((g) => g === cyr).length > 1,
  });
}));
