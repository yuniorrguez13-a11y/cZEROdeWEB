// Argon2id KDF: the ONLY place KDF constants live (DESIGN §3.2).
// Browser: one module worker per derivation (kdf-worker.js), terminated after the run.
// Node (no Worker): the vendored hash-wasm UMD runs in-thread.
// A small derived-key cache skips Argon2 for repeated opens; it never stores passphrases or raw bits.

import { CzdError, toCzdError } from '../errors.js';
import { TIMES } from '../config.js';
import { randomBytes, toHex, utf8, zeroize } from '../util/bytes.js';
import { onPurge } from '../state.js';

/** KDF id for Argon2id v1.3. */
export const KDF_ARGON2ID = 1;

/** Default parameters (KiB, passes, lanes). */
export const POLICY = Object.freeze({ m: 65536, t: 3, p: 1 });

/** Low-memory parameters (only after a real out-of-memory error). */
export const FLOOR = Object.freeze({ m: 19456, t: 2, p: 1 });

const COST_OK = 2 * POLICY.m * POLICY.t; // 393216
const COST_CONFIRM = 16 * POLICY.m * POLICY.t; // 3145728
const M_OK = 131072;
const M_MAX = 1048576;
const CACHE_MAX = 8;
const PROBE = Object.freeze({ m: 8, t: 1, p: 1 });
const PROBE_LIMIT_MS = 5000;

/**
 * Canonical passphrase bytes for the Argon2 formats (vault, czd2 pass stanzas, text v2):
 * UTF-8(NFC, trimmed, inner whitespace runs collapsed to one space).
 * @param {string} s
 * @returns {Uint8Array}
 */
export function passphraseBytes(s) {
  if (typeof s !== 'string') throw new TypeError('passphraseBytes(): expected a string');
  return utf8(s.normalize('NFC').trim().replace(/\s+/gu, ' '));
}

/**
 * Validates Argon2id parameters and gates their cost (m = KiB, cost = m·t).
 * @param {{m:number, t:number, p:number}} params
 * @returns {'ok'|'confirm'} 'confirm' = ask the user first (confirmKdf)
 * @throws {CzdError} 'kdf-params-out-of-range'
 */
export function checkParams(params) {
  const { m, t, p } = params ?? {};
  const valid = Number.isInteger(m) && Number.isInteger(t) && Number.isInteger(p)
    && p >= 1 && p <= 8 && m >= 8 * p && m <= M_MAX && t >= 1 && t <= 16;
  if (!valid) throw new CzdError('kdf-params-out-of-range', { detail: { m, t, p } });
  const cost = m * t;
  if (m <= M_OK && cost <= COST_OK) return 'ok';
  if (cost <= COST_CONFIRM) return 'confirm';
  throw new CzdError('kdf-params-out-of-range', { detail: { m, t, p } });
}

/** Duration of the last Argon2 run in ms (cache hits do not update it). */
export let lastMs = 0;

let testImpl = null;
// Measured speed (ms per KiB-pass) for the confirmKdf estimate; tiny runs (boot probe) are dominated by
// worker start-up, so only runs of at least FLOOR's cost update it. Default ≈ 300 ms for POLICY.
let msPerCost = 300 / (POLICY.m * POLICY.t);

/**
 * Test hook: replaces the Argon2 implementation with fn(pwBytes, salt, {m,t,p}) -> Uint8Array(32)
 * (sync or async); null restores the real one.
 * @param {((pw:Uint8Array, salt:Uint8Array, params:{m:number,t:number,p:number}) => Uint8Array|Promise<Uint8Array>)|null} fn
 */
export function __setArgon2ForTests(fn) {
  if (fn !== null && typeof fn !== 'function') throw new TypeError('__setArgon2ForTests(): expected a function or null');
  testImpl = fn;
}

function checkSalt(salt) {
  if (!(salt instanceof Uint8Array) || salt.length < 8) throw new TypeError('argon2id(): salt must be ≥ 8 bytes');
}

function aborted(signal) {
  return new CzdError('aborted', { cause: signal?.reason });
}

/** Lazily loads the vendored hash-wasm UMD (it assigns globalThis.hashwasm). */
let hashwasmReady = null;
function loadHashWasm() {
  hashwasmReady ??= import('./argon2.umd.min.js').then(() => {
    // The UMD prefers CommonJS globals when they exist (e.g. `node -e`), else it sets globalThis.hashwasm.
    const cjs = globalThis.exports;
    const hw = globalThis.hashwasm ?? (cjs && typeof cjs.argon2id === 'function' ? cjs : null);
    if (!hw || typeof hw.argon2id !== 'function') throw new Error('hash-wasm did not load');
    return hw;
  });
  return hashwasmReady;
}

/** RangeError or a WebAssembly memory growth/allocation failure. */
function isMemoryError(e) {
  if (e instanceof RangeError) return true;
  const msg = String(e?.message ?? '');
  return /Memory\.grow|grow\(\)|out of memory|Cannot allocate Wasm memory/i.test(msg);
}

async function runInThread(pw, salt, { m, t, p }) {
  const hw = await loadHashWasm();
  try {
    return await hw.argon2id({ password: pw, salt, parallelism: p, iterations: t, memorySize: m, hashLength: 32, outputType: 'binary' });
  } catch (e) {
    throw new CzdError(isMemoryError(e) ? 'kdf-out-of-memory' : 'internal', { cause: e });
  }
}

function runInWorker(pw, salt, { m, t, p }, signal) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./kdf-worker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      reject(new CzdError('internal', { cause: e }));
      return;
    }
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
      fn(v);
    };
    const onAbort = () => finish(reject, aborted(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (ev) => {
      const d = ev.data;
      if (d && d.ok === true && d.bytes instanceof Uint8Array && d.bytes.length === 32) finish(resolve, d.bytes);
      else if (d && d.error === 'memory') finish(reject, new CzdError('kdf-out-of-memory', { detail: d.message }));
      else finish(reject, new CzdError('internal', { detail: d?.message ?? 'bad worker reply' }));
    };
    worker.onerror = (ev) => {
      ev.preventDefault?.();
      finish(reject, new CzdError('internal', { detail: ev.message || 'kdf worker failed to load' }));
    };
    worker.onmessageerror = () => finish(reject, new CzdError('internal', { detail: 'kdf worker message error' }));
    // A private copy is transferred, so the caller's bytes stay usable.
    const copy = pw.slice();
    worker.postMessage({ pw: copy, salt: salt.slice(), m, t, p }, [copy.buffer]);
  });
}

/**
 * One raw Argon2id v1.3 run (32-byte output). Validates the parameters (throws for out-of-range,
 * never asks; derive() does the cost gating). Aborting terminates the worker.
 * @param {Uint8Array} pwBytes canonical passphrase bytes (non-empty)
 * @param {Uint8Array} salt
 * @param {{m:number, t:number, p:number}} params
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function argon2id(pwBytes, salt, params, { signal } = {}) {
  if (!(pwBytes instanceof Uint8Array) || pwBytes.length === 0) throw new TypeError('argon2id(): empty passphrase');
  checkSalt(salt);
  checkParams(params);
  const prm = { m: params.m, t: params.t, p: params.p };
  if (signal?.aborted) throw aborted(signal);
  const t0 = Date.now();
  let out;
  try {
    if (testImpl) out = await testImpl(pwBytes, salt, prm);
    else if (typeof Worker === 'function') out = await runInWorker(pwBytes, salt, prm, signal);
    else out = await runInThread(pwBytes, salt, prm);
  } catch (e) {
    if (!(e instanceof CzdError) && isMemoryError(e)) throw new CzdError('kdf-out-of-memory', { cause: e });
    throw toCzdError(e);
  }
  lastMs = Date.now() - t0;
  if (prm.m * prm.t >= FLOOR.m * FLOOR.t && lastMs > 0) msPerCost = lastMs / (prm.m * prm.t);
  if (signal?.aborted) {
    zeroize(out);
    throw aborted(signal);
  }
  if (!(out instanceof Uint8Array) || out.length !== 32) throw new CzdError('internal', { detail: 'argon2 output' });
  return out;
}

// ---- derived-key cache ---------------------------------------------------------------------------

const cache = new Map(); // key -> {value, expires}
let epoch = 0; // bumped by clearKdfCache: a derivation that straddles a purge is not cached
let sessionKeyP = null;
let sweepTimer = null;

function sessionKey() {
  sessionKeyP ??= globalThis.crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return sessionKeyP;
}

async function cacheKey(pw, salt, params, purpose) {
  const tag = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', await sessionKey(), pw));
  return [toHex(tag), toHex(salt), KDF_ARGON2ID, params.m, params.t, params.p, purpose].join('|');
}

function now() {
  return Date.now();
}

function sweep() {
  const t = now();
  for (const [k, e] of cache) if (e.expires <= t) cache.delete(k);
  scheduleSweep();
}

function scheduleSweep() {
  if (sweepTimer !== null) {
    clearTimeout(sweepTimer);
    sweepTimer = null;
  }
  if (cache.size === 0) return;
  let next = Infinity;
  for (const e of cache.values()) next = Math.min(next, e.expires);
  sweepTimer = setTimeout(sweep, Math.max(0, next - now()) + 5);
  sweepTimer?.unref?.(); // never keeps Node alive
}

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return undefined;
  if (e.expires <= now()) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key); // move to the most-recently-used end
  e.expires = now() + TIMES.kdfCacheMs;
  cache.set(key, e);
  scheduleSweep();
  return e;
}

function cachePut(key, value) {
  cache.delete(key);
  while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires: now() + TIMES.kdfCacheMs });
  scheduleSweep();
}

/** Drops every cached derived key (registered with state.onPurge below, so every lock clears it). */
export function clearKdfCache() {
  epoch++;
  cache.clear();
  scheduleSweep();
}

onPurge(() => clearKdfCache());

function estimate(params) {
  const seconds = Math.max(1, Math.round((msPerCost * params.m * params.t) / 1000));
  return { m: params.m, t: params.t, p: params.p, mib: Math.ceil(params.m / 1024), seconds };
}

/**
 * Cached Argon2id derivation. On a cache miss: checkParams → (confirmKdf when 'confirm') → Argon2 →
 * value = await build(bits) → bits zero-filled → value cached (key = HMAC(sessionKey, passphraseBytes)
 * | salt | kdfId | m | t | p | purpose; max 8 entries, 5 min after last use).
 * Without `build` nothing is cached and a fresh copy of the 32 raw bytes is returned. A derivation
 * that is still running when clearKdfCache() (a lock) happens is returned but not cached.
 * Without `confirmKdf`, parameters that need confirmation are rejected (kdf-params-out-of-range).
 * @param {string} pass the passphrase as typed (canonicalized here)
 * @param {Uint8Array} salt
 * @param {{m:number, t:number, p:number}} params
 * @param {{purpose?: string, signal?: AbortSignal, confirmKdf?: (p:{m:number,t:number,p:number,mib:number,seconds:number}) => boolean|Promise<boolean>, build?: (bits:Uint8Array) => Promise<any>}} [opts]
 * @returns {Promise<any>}
 */
export async function derive(pass, salt, params, { purpose, signal, confirmKdf, build } = {}) {
  const verdict = checkParams(params);
  checkSalt(salt);
  const prm = { m: params.m, t: params.t, p: params.p };
  const pw = passphraseBytes(pass);
  if (pw.length === 0) throw new TypeError('derive(): empty passphrase');
  if (build !== undefined && typeof build !== 'function') throw new TypeError('derive(): build must be a function');
  if (build && (typeof purpose !== 'string' || purpose === '')) throw new TypeError('derive(): purpose is required with build');
  const ep = epoch;
  try {
    if (signal?.aborted) throw aborted(signal); // also before a cache hit
    const key = build ? await cacheKey(pw, salt, prm, purpose) : null;
    if (key) {
      const hit = cacheGet(key);
      if (hit) return hit.value;
    }
    if (verdict === 'confirm') {
      if (typeof confirmKdf !== 'function') throw new CzdError('kdf-params-out-of-range', { detail: 'needs confirmation' });
      if (!(await confirmKdf(estimate(prm)))) throw new CzdError('kdf-declined');
    }
    if (signal?.aborted) throw aborted(signal);
    const bits = await argon2id(pw, salt, prm, { signal });
    if (!build) return bits;
    let value;
    try {
      value = await build(bits);
    } finally {
      zeroize(bits);
    }
    if (ep === epoch) cachePut(key, value);
    return value;
  } finally {
    zeroize(pw);
  }
}

/**
 * Cached AES-256-GCM KEK (non-extractable; encrypt, decrypt, wrapKey, unwrapKey).
 * @param {string} pass
 * @param {Uint8Array} salt
 * @param {{m:number, t:number, p:number}} params
 * @param {{purpose?: string, signal?: AbortSignal, confirmKdf?: Function}} [opts] purpose defaults to 'kek'
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKek(pass, salt, params, opts = {}) {
  return derive(pass, salt, params, {
    ...opts,
    purpose: opts.purpose ?? 'kek',
    build: (bits) => globalThis.crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']),
  });
}

/**
 * Boot probe (§2.4): a tiny Argon2 run (m = 8 KiB, t = 1) through the real path (worker in browsers).
 * ok = false on any failure or when it takes longer than 5 s.
 * @returns {Promise<{ok:boolean, ms:number}>}
 */
export async function bootProbe() {
  const t0 = Date.now();
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      ac?.abort();
      resolve(false);
    }, PROBE_LIMIT_MS);
    timer?.unref?.();
  });
  try {
    const run = argon2id(randomBytes(16), randomBytes(16), PROBE, { signal: ac?.signal }).then((b) => b.length === 32, () => false);
    const ok = await Promise.race([run, timeout]);
    const ms = Date.now() - t0;
    return { ok: ok === true && ms <= PROBE_LIMIT_MS, ms };
  } catch {
    return { ok: false, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}
