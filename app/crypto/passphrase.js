// Passphrase generation and strength estimate (DESIGN §3.9).
// Generated phrases: BIP39 English words (11 bits each), lowercase, joined by "-".
// Typed passphrases: a deliberately simple, conservative estimate (charset × effective length, capped
// at 10 bits for very common passwords). It feeds the meter and the vault minimum, nothing else.

import { WORDS } from './wordlist.js';

/** The old app's weak-PIN set (kept verbatim; drives the inline warning and the easter egg). */
export const WEAK = new Set(['123', '1234', '12345', 'password', 'qwerty', 'abc', '0000', '1111', 'pass', 'admin']);

/**
 * ~200 most common passwords: the first entries of the "passwords" frequency list in zxcvbn 4.4.2
 * (npm zxcvbn, lib/frequency_lists.js; derived from Mark Burnett's / Xato's leaked-password corpus),
 * in rank order with vulgar entries left out. zxcvbn is MIT licensed, Copyright (c) 2012-2016 Dan Wheeler
 * and Dropbox, Inc.
 */
export const COMMON = new Set([
  '123456', 'password', '12345678', 'qwerty', '123456789', '12345', '1234', '111111', '1234567', 'dragon', '123123',
  'baseball', 'abc123', 'football', 'monkey', 'letmein', 'shadow', 'master', '696969', 'mustang', '666666',
  'qwertyuiop', '123321', '1234567890', 'superman', '654321', '1qaz2wsx', '7777777', 'qazwsx', 'jordan', '123qwe',
  '000000', 'killer', 'trustno1', 'hunter', 'harley', 'zxcvbnm', 'asdfgh', 'buster', 'batman', 'soccer', 'tigger',
  'charlie', 'sunshine', 'iloveyou', 'ranger', 'hockey', 'computer', 'starwars', 'pepper', 'klaster', '112233',
  'zxcvbn', 'freedom', 'princess', 'maggie', 'pass', 'ginger', '11111111', '131313', 'love', 'cheese', '159753',
  'summer', 'chelsea', 'dallas', 'matrix', 'yankees', '6969', 'corvette', 'austin', 'access', 'thunder', 'merlin',
  'secret', 'diamond', 'hello', 'hammer', '1234qwer', 'silver', 'gfhjkm', 'internet', 'samantha', 'golfer', 'scooter',
  'test', 'orange', 'cookie', 'q1w2e3r4t5', 'maverick', 'sparky', 'phoenix', 'mickey', 'bigdog', 'snoopy', 'guitar',
  'whatever', 'chicken', 'camaro', 'mercedes', 'peanut', 'ferrari', 'falcon', 'cowboy', 'welcome', 'samsung',
  'steelers', 'smokey', 'dakota', 'arsenal', 'boomer', 'eagles', 'tigers', 'marina', 'nascar', 'gateway', 'yellow',
  'porsche', 'monster', 'spider', 'diablo', 'hannah', 'bulldog', 'junior', 'london', 'purple', 'compaq', 'lakers',
  'iceman', 'qwer1234', 'hardcore', 'cowboys', 'money', 'banana', 'ncc1701', 'boston', 'tennis', 'q1w2e3r4', 'coffee',
  'scooby', '123654', 'nikita', 'yamaha', 'mother', 'barney', 'brandy', 'chester', 'oliver', 'player', 'forever',
  'rangers', 'midnight', 'chicago', 'bigdaddy', 'redsox', 'angel', 'badboy', 'fender', 'jasper', 'slayer', 'rabbit',
  'natasha', 'marine', 'wizard', 'marlboro', 'raiders', 'prince', 'casper', 'fishing', 'flower', 'jasmine', 'adidas',
  'winter', 'winner', 'gandalf', 'password1', 'enter', 'ghbdtn', '1q2w3e4r', 'golden', 'cocacola', 'jordan23',
  'winston', 'madison', 'angels', 'panther', 'spanky', 'sophie', 'asdfasdf', 'thx1138', 'toyota', 'tiger', 'canada',
  '12344321', '8675309', 'muffin', 'liverpoo', 'apples', 'qwerty123', 'passw0rd',
]);

const EASTER = new Set(['123', '1234', '12345']);
const WEAK_OR_COMMON = [...new Set([...WEAK, ...COMMON])];
const GUESSES_PER_SECOND = 1e6; // ≈ 600 GPUs against Argon2id 64 MiB / t = 3
const YEAR = 365 * 86400;

function canonical(s) {
  return String(s).normalize('NFC').trim().replace(/\s+/gu, ' ');
}

/**
 * A random passphrase of `words` BIP39 words joined by "-" (11 bits per word).
 * @param {number} words 1..64
 * @returns {string}
 */
export function generatePassphrase(words) {
  if (!Number.isInteger(words) || words < 1 || words > 64) throw new TypeError('generatePassphrase(): words must be 1..64');
  const r = globalThis.crypto.getRandomValues(new Uint16Array(words));
  return Array.from(r, (v) => WORDS[v & 2047]).join('-'); // 2048 = 2^11: masking is unbiased
}

/** Length where runs of one repeated character or of ±1 sequences longer than 3 count as 1. */
function effectiveLength(codes) {
  let n = 0;
  let i = 0;
  while (i < codes.length) {
    if (i + 1 < codes.length) {
      const d = codes[i + 1] - codes[i];
      if (d === 0 || d === 1 || d === -1) {
        let j = i + 1;
        while (j + 1 < codes.length && codes[j + 1] - codes[j] === d) j++;
        if (j - i + 1 > 3) {
          n += 1;
          i = j + 1;
          continue;
        }
      }
    }
    n += 1;
    i += 1;
  }
  return n;
}

function isCommon(lower) {
  if (COMMON.has(lower) || WEAK.has(lower)) return true;
  const len = [...lower].length;
  return WEAK_OR_COMMON.some((w) => lower.startsWith(w) && len - w.length <= 3);
}

/**
 * Entropy estimate (bits) for a typed passphrase: effective length × log2(charset), where the charset
 * is the union of the classes present (lower 26, upper 26, digits 10, ASCII symbols/space 33, other 100);
 * at most 10 bits for a common password (or one plus ≤ 3 extra characters).
 * @param {string} s
 * @returns {number}
 */
export function estimateBits(s) {
  if (typeof s !== 'string') return 0;
  const canon = canonical(s);
  const codes = Array.from(canon, (ch) => ch.codePointAt(0));
  if (codes.length === 0) return 0;
  let lower = 0;
  let upper = 0;
  let digit = 0;
  let sym = 0;
  let other = 0;
  for (const c of codes) {
    if (c >= 97 && c <= 122) lower = 26;
    else if (c >= 65 && c <= 90) upper = 26;
    else if (c >= 48 && c <= 57) digit = 10;
    else if (c >= 32 && c <= 126) sym = 33;
    else other = 100;
  }
  let bits = effectiveLength(codes) * Math.log2(lower + upper + digit + sym + other);
  if (isCommon(canon.toLowerCase())) bits = Math.min(bits, 10);
  return bits;
}

/**
 * Time to try half the space at 1e6 guesses/s.
 * @param {number} bits
 * @returns {'instantly'|'minutes'|'hours'|'days'|'years'|'centuries'}
 */
export function crackTime(bits) {
  const b = Number.isFinite(bits) ? Math.max(0, bits) : 0;
  const seconds = 2 ** (b - 1) / GUESSES_PER_SECOND;
  if (seconds < 1) return 'instantly';
  if (seconds < 3600) return 'minutes';
  if (seconds < 86400) return 'hours';
  if (seconds < YEAR) return 'days';
  if (seconds < 100 * YEAR) return 'years';
  return 'centuries';
}

/**
 * Meter data. Generated phrases count 11 bits per word (`words`, or the number of "-" separated words).
 * Labels: < 40 bits weak, < 60 ok, ≥ 60 strong.
 * @param {string} s
 * @param {{generated?: boolean, words?: number}} [opts]
 * @returns {{bits:number, label:'weak'|'ok'|'strong', crack:string}}
 */
export function strength(s, { generated = false, words = 0 } = {}) {
  let bits;
  if (generated) {
    const w = words > 0 ? words : String(s ?? '').split('-').filter(Boolean).length;
    bits = w * 11;
  } else {
    bits = Math.floor(estimateBits(s));
  }
  const label = bits < 40 ? 'weak' : bits < 60 ? 'ok' : 'strong';
  return { bits, label, crack: crackTime(bits) };
}

/**
 * Vault passphrase rule: generated, or (≥ 10 characters AND ≥ 45 estimated bits).
 * @param {string} s
 * @param {{generated?: boolean}} [opts]
 * @returns {{ok:boolean, reason:null|'too-short'|'too-weak'}}
 */
export function meetsVaultMinimum(s, { generated = false } = {}) {
  if (generated) return { ok: true, reason: null };
  if (typeof s !== 'string' || [...canonical(s)].length < 10) return { ok: false, reason: 'too-short' };
  if (estimateBits(s) < 45) return { ok: false, reason: 'too-weak' };
  return { ok: true, reason: null };
}

/**
 * In the old weak-PIN set (case-insensitive, ends trimmed: unlike the old app, ' 1234' warns too, because
 * passphraseBytes() trims and it IS the passphrase '1234').
 * @param {string} s
 * @returns {boolean}
 */
export function isWeak(s) {
  return typeof s === 'string' && WEAK.has(s.trim().toLowerCase());
}

/**
 * The PINs that trigger the easter egg: exactly '123', '1234' or '12345' (DESIGN §1.11; as in the old app,
 * ' 1234' does not count).
 * @param {string} s
 * @returns {boolean}
 */
export function isEasterEggPin(s) {
  return typeof s === 'string' && EASTER.has(s);
}
