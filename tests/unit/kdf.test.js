// app/crypto/kdf.js: bounds, canonicalization, Argon2id KAT (Node in-thread path), cache, confirm flow,
// worker protocol (fake Worker) and kdf-worker.js itself (fake `self`).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-phase0.js';
import * as K from '../../app/crypto/kdf.js';
import { CzdError } from '../../app/errors.js';
import { toHex, utf8 } from '../../app/util/bytes.js';

const code = (c) => (e) => e instanceof CzdError && e.code === c;
const salt16 = (b = 7) => new Uint8Array(16).fill(b);

afterEach(() => {
  K.__setArgon2ForTests(null);
  K.clearKdfCache();
});

/** Counting fake Argon2: output = SHA-256(pw ‖ salt ‖ m,t,p) so different inputs give different keys. */
function fakeArgon() {
  const calls = [];
  const fn = (pw, salt, prm) => {
    calls.push({ pw: pw.slice(), salt: salt.slice(), prm });
    return new Uint8Array(createHash('sha256').update(pw).update(salt).update(`${prm.m},${prm.t},${prm.p}`).digest());
  };
  return { fn, calls };
}

test('constants match DESIGN §3.2', () => {
  assert.equal(K.KDF_ARGON2ID, 1);
  assert.deepEqual(K.POLICY, { m: 65536, t: 3, p: 1 });
  assert.deepEqual(K.FLOOR, { m: 19456, t: 2, p: 1 });
  assert.ok(Object.isFrozen(K.POLICY) && Object.isFrozen(K.FLOOR));
});

test('vendored hash-wasm argon2 UMD is the pinned build', () => {
  const js = readFileSync(path.join(ROOT, 'app/crypto/argon2.umd.min.js'));
  assert.equal(createHash('sha256').update(js).digest('hex'), 'dcec617a2e1b700fa132d1583a186cb70611113395e869f2dd6cc82b415d3094');
});

test('passphraseBytes: NFC, trim, whitespace runs collapsed to one space', () => {
  assert.deepEqual(K.passphraseBytes('abc'), utf8('abc'));
  assert.deepEqual(K.passphraseBytes('  a \t\n b\u00a0\u3000c  '), utf8('a b c'));
  assert.deepEqual(K.passphraseBytes('e\u0301té'), utf8('été'));
  assert.deepEqual(K.passphraseBytes('\ufeffpw\u2028'), utf8('pw'));
  assert.deepEqual(K.passphraseBytes('   '), new Uint8Array(0));
  assert.deepEqual(K.passphraseBytes('Case Matters'), utf8('Case Matters'));
  assert.throws(() => K.passphraseBytes(42), TypeError);
});

test('checkParams: ok / confirm / out of range', () => {
  const ok = [K.POLICY, K.FLOOR, { m: 8, t: 1, p: 1 }, { m: 64, t: 1, p: 1 }, { m: 131072, t: 3, p: 1 }, { m: 65536, t: 6, p: 8 }, { m: 24576, t: 16, p: 1 }];
  for (const p of ok) assert.equal(K.checkParams(p), 'ok', JSON.stringify(p));
  const confirm = [{ m: 131072, t: 4, p: 1 }, { m: 131073, t: 1, p: 1 }, { m: 1048576, t: 3, p: 1 }, { m: 196608, t: 16, p: 4 }, { m: 65536, t: 7, p: 1 }];
  for (const p of confirm) assert.equal(K.checkParams(p), 'confirm', JSON.stringify(p));
  const bad = [{ m: 1048576, t: 4, p: 1 }, { m: 1048577, t: 1, p: 1 }, { m: 2 ** 32 - 1, t: 1, p: 1 }, { m: 64, t: 0, p: 1 }, { m: 64, t: 17, p: 1 },
    { m: 64, t: 1, p: 0 }, { m: 128, t: 1, p: 9 }, { m: 15, t: 1, p: 2 }, { m: 7, t: 1, p: 1 }, { m: 64.5, t: 1, p: 1 }, { m: '64', t: 1, p: 1 },
    { m: 64, t: 1 }, {}, null, undefined, { m: NaN, t: 1, p: 1 }, { m: 393216, t: 9, p: 1 }];
  for (const p of bad) assert.throws(() => K.checkParams(p), code('kdf-params-out-of-range'), JSON.stringify(p));
});

// Expected values computed with three independent implementations that agree: @noble/hashes 2.4.0 argon2id
// (itself checked against the RFC 9106 §5.3 vector), the `argon2id` 1.0.1 wasm package and hash-wasm 4.12.0.
const KAT = [
  { pw: 'password', salt: 'somesalt', m: 64, t: 1, p: 1, out: '729c7a54441bc13559bdca71348c4e554599e719c08a952601ed5c83618c1bbd' },
  { pw: 'password', salt: 'somesalt', m: 256, t: 2, p: 2, out: '6d093c501fd5999645e0ea3bf620d7b8be7fd2db59c20d9fff9539da2bf57037' },
  { pw: 'ძალიან საიდუმლო', salt: 'cZEROde-kat-salt', m: 8, t: 1, p: 1, out: '119cefb7c407e79df0d71dd2bb63a4549c7e8e33d742357c974e587696f56fb8' },
  { pw: 'correct-horse-battery-staple', salt: '0123456789abcdef', m: 19456, t: 2, p: 1, out: 'f6147e83436e8adda84e88f4e42a5fd078108d3c9d6c60adefe48ffd268f5301' },
  { pw: 'correct-horse-battery-staple', salt: '0123456789abcdef', m: 65536, t: 3, p: 1, out: '7d2c03d61a78ee9f87679af4741a8cfbd320efba76349847ac234d208ce13880' },
];

test('argon2id known-answer vectors (Node in-thread path, vendored hash-wasm)', async () => {
  assert.equal(typeof globalThis.Worker, 'undefined', 'Node has no Worker: the in-thread path runs');
  for (const v of KAT) {
    const out = await K.argon2id(utf8(v.pw), utf8(v.salt), { m: v.m, t: v.t, p: v.p });
    assert.equal(toHex(out), v.out, JSON.stringify(v));
  }
  assert.ok(K.lastMs > 0, 'lastMs is a live binding updated by the POLICY run');
});

test('argon2id input validation (before any run)', async () => {
  const { fn, calls } = fakeArgon();
  K.__setArgon2ForTests(fn);
  await assert.rejects(K.argon2id(new Uint8Array(0), salt16(), K.POLICY), TypeError);
  await assert.rejects(K.argon2id(utf8('x'), new Uint8Array(4), K.POLICY), TypeError);
  await assert.rejects(K.argon2id(utf8('x'), salt16(), { m: 4 * 2 ** 20, t: 3, p: 1 }), code('kdf-params-out-of-range'));
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(K.argon2id(utf8('x'), salt16(), K.POLICY, { signal: ac.signal }), code('aborted'));
  assert.equal(calls.length, 0);
});

test('argon2id error mapping: RangeError → kdf-out-of-memory, others → internal, bad output → internal', async () => {
  K.__setArgon2ForTests(() => { throw new RangeError('WebAssembly.Memory.grow(): Maximum memory size exceeded'); });
  await assert.rejects(K.argon2id(utf8('x'), salt16(), K.POLICY), code('kdf-out-of-memory'));
  K.__setArgon2ForTests(() => { throw new Error('Out of memory: Cannot allocate Wasm memory for new instance'); });
  await assert.rejects(K.argon2id(utf8('x'), salt16(), K.POLICY), code('kdf-out-of-memory'));
  K.__setArgon2ForTests(() => { throw new Error('something else'); });
  await assert.rejects(K.argon2id(utf8('x'), salt16(), K.POLICY), code('internal'));
  K.__setArgon2ForTests(() => new Uint8Array(31));
  await assert.rejects(K.argon2id(utf8('x'), salt16(), K.POLICY), code('internal'));
  assert.throws(() => K.__setArgon2ForTests('nope'), TypeError);
});

test('derive caches the built value: canonical passphrase + salt + params + purpose', async () => {
  const { fn, calls } = fakeArgon();
  K.__setArgon2ForTests(fn);
  const build = async (bits) => ({ bits: bits.slice() });
  const a = await K.derive('pass word', salt16(), K.POLICY, { purpose: 'p1', build });
  const b = await K.derive('  pass \u00a0 word  ', salt16(), K.POLICY, { purpose: 'p1', build });
  assert.equal(a, b, 'same object from the cache');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].pw, utf8('pass word'), 'Argon2 sees the canonical bytes');
  await K.derive('pass word', salt16(), K.POLICY, { purpose: 'p2', build });
  await K.derive('pass word', salt16(8), K.POLICY, { purpose: 'p1', build });
  await K.derive('pass word', salt16(), K.FLOOR, { purpose: 'p1', build });
  await K.derive('Pass word', salt16(), K.POLICY, { purpose: 'p1', build });
  assert.equal(calls.length, 5);
  // NFD and NFC spell the same passphrase.
  await K.derive('café', salt16(), K.POLICY, { purpose: 'p1', build });
  await K.derive('cafe\u0301', salt16(), K.POLICY, { purpose: 'p1', build });
  assert.equal(calls.length, 6);
  K.clearKdfCache();
  await K.derive('pass word', salt16(), K.POLICY, { purpose: 'p1', build });
  assert.equal(calls.length, 7, 'clearKdfCache drops everything');
});

test('derive: bits are zero-filled after build; no build → raw bits, never cached', async () => {
  const { fn, calls } = fakeArgon();
  K.__setArgon2ForTests(fn);
  let seen;
  await K.derive('pw', salt16(), K.POLICY, { purpose: 'z', build: async (bits) => { seen = bits; return 1; } });
  assert.equal(seen.length, 32);
  assert.ok(seen.every((x) => x === 0), 'bits wiped');
  const raw1 = await K.derive('pw', salt16(), K.POLICY);
  const raw2 = await K.derive('pw', salt16(), K.POLICY);
  assert.equal(raw1.length, 32);
  assert.deepEqual(raw1, raw2);
  assert.notEqual(raw1, raw2);
  assert.equal(calls.length, 3);
  await assert.rejects(K.derive('pw', salt16(), K.POLICY, { build: async () => 1 }), TypeError, 'purpose required with build');
  await assert.rejects(K.derive('   ', salt16(), K.POLICY, { purpose: 'z', build: async () => 1 }), TypeError, 'empty passphrase');
});

test('derive cache: at most 8 entries, least recently used evicted', async () => {
  const { fn, calls } = fakeArgon();
  K.__setArgon2ForTests(fn);
  const build = async () => ({});
  for (let i = 0; i < 8; i++) await K.derive(`pw${i}`, salt16(), K.POLICY, { purpose: 'lru', build });
  await K.derive('pw0', salt16(), K.POLICY, { purpose: 'lru', build }); // touch pw0
  assert.equal(calls.length, 8);
  await K.derive('pw8', salt16(), K.POLICY, { purpose: 'lru', build }); // evicts pw1
  assert.equal(calls.length, 9);
  await K.derive('pw0', salt16(), K.POLICY, { purpose: 'lru', build });
  assert.equal(calls.length, 9, 'pw0 survived');
  await K.derive('pw1', salt16(), K.POLICY, { purpose: 'lru', build });
  assert.equal(calls.length, 10, 'pw1 was evicted');
});

test('derive cache: entries expire 5 minutes after last use', async () => {
  const { fn, calls } = fakeArgon();
  K.__setArgon2ForTests(fn);
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    const build = async () => ({});
    await K.derive('pw', salt16(), K.POLICY, { purpose: 'exp', build });
    t += 4 * 60000;
    await K.derive('pw', salt16(), K.POLICY, { purpose: 'exp', build });
    assert.equal(calls.length, 1, 'hit within 5 min');
    t += 4 * 60000;
    await K.derive('pw', salt16(), K.POLICY, { purpose: 'exp', build });
    assert.equal(calls.length, 1, 'the previous hit renewed the entry');
    t += 5 * 60000 + 1;
    await K.derive('pw', salt16(), K.POLICY, { purpose: 'exp', build });
    assert.equal(calls.length, 2, 'expired after 5 min unused');
  } finally {
    Date.now = realNow;
  }
});

test('derive: confirm-level params need confirmKdf; decline → kdf-declined; out-of-range never runs', async () => {
  const { fn, calls } = fakeArgon();
  K.__setArgon2ForTests(fn);
  const big = { m: 262144, t: 3, p: 1 };
  const build = async () => ({});
  await assert.rejects(K.derive('pw', salt16(), big, { purpose: 'c', build }), code('kdf-params-out-of-range'));
  const asked = [];
  await assert.rejects(K.derive('pw', salt16(), big, { purpose: 'c', build, confirmKdf: (p) => { asked.push(p); return false; } }), code('kdf-declined'));
  assert.equal(calls.length, 0);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].m, 262144);
  assert.equal(asked[0].mib, 256);
  assert.ok(Number.isInteger(asked[0].seconds) && asked[0].seconds >= 1);
  const v = await K.derive('pw', salt16(), big, { purpose: 'c', build, confirmKdf: async () => true });
  assert.equal(calls.length, 1);
  const again = await K.derive('pw', salt16(), big, { purpose: 'c', build, confirmKdf: () => assert.fail('cache hit must not ask') });
  assert.equal(again, v);
  await assert.rejects(K.derive('pw', salt16(), { m: 1048576, t: 16, p: 1 }, { purpose: 'c', build, confirmKdf: () => true }), code('kdf-params-out-of-range'));
  assert.equal(calls.length, 1);
});

test('deriveKek: non-extractable AES-GCM key with encrypt/decrypt/wrapKey/unwrapKey, cached', async () => {
  const { fn, calls } = fakeArgon();
  K.__setArgon2ForTests(fn);
  const kek = await K.deriveKek('pw', salt16(), K.POLICY);
  assert.equal(kek.algorithm.name, 'AES-GCM');
  assert.equal(kek.algorithm.length, 256);
  assert.equal(kek.extractable, false);
  assert.deepEqual([...kek.usages].sort(), ['decrypt', 'encrypt', 'unwrapKey', 'wrapKey']);
  assert.equal(await K.deriveKek(' pw ', salt16(), K.POLICY), kek);
  assert.equal(calls.length, 1);
  const iv = new Uint8Array(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, utf8('hi'));
  const raw = new Uint8Array(createHash('sha256').update(utf8('pw')).update(salt16()).update('65536,3,1').digest());
  const same = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  assert.deepEqual(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, same, ct)), utf8('hi'), 'KEK = raw Argon2 output');
});

test('bootProbe runs the real Argon2 (m = 8 KiB, t = 1)', async () => {
  const r = await K.bootProbe();
  assert.equal(r.ok, true);
  assert.ok(Number.isFinite(r.ms) && r.ms >= 0 && r.ms < 5000);
  K.__setArgon2ForTests(() => { throw new Error('boom'); });
  assert.equal((await K.bootProbe()).ok, false);
});

// ---- browser worker path, exercised in Node with a fake Worker -----------------------------------

class FakeWorker {
  static instances = [];
  static reply = null; // (data) => reply object | 'error' | 'hang'
  constructor(url, opts) {
    this.url = String(url);
    this.opts = opts;
    this.terminated = false;
    FakeWorker.instances.push(this);
  }
  postMessage(data, transfer) {
    this.data = data;
    this.transfer = transfer;
    const r = FakeWorker.reply(data);
    if (r === 'hang') return;
    setTimeout(() => {
      if (this.terminated) return;
      if (r === 'error') this.onerror({ message: 'load failed', preventDefault() {} });
      else this.onmessage({ data: r });
    }, 1);
  }
  terminate() {
    this.terminated = true;
  }
}

async function withFakeWorker(reply, fn) {
  FakeWorker.instances = [];
  FakeWorker.reply = reply;
  globalThis.Worker = FakeWorker;
  try {
    await fn();
  } finally {
    delete globalThis.Worker;
  }
}

test('worker path: module worker per run, transferred copy of pw, terminated after each run', async () => {
  await withFakeWorker((d) => ({ ok: true, bytes: new Uint8Array(32).fill(d.m & 0xff) }), async () => {
    const pw = utf8('secret');
    const out = await K.argon2id(pw, salt16(), { m: 64, t: 1, p: 1 });
    assert.deepEqual(out, new Uint8Array(32).fill(64));
    const w = FakeWorker.instances[0];
    assert.ok(w.url.endsWith('/app/crypto/kdf-worker.js'), w.url);
    assert.deepEqual(w.opts, { type: 'module' });
    assert.deepEqual({ m: w.data.m, t: w.data.t, p: w.data.p }, { m: 64, t: 1, p: 1 });
    assert.deepEqual(w.data.pw, utf8('secret'));
    assert.notEqual(w.data.pw, pw);
    assert.deepEqual(w.transfer, [w.data.pw.buffer]);
    assert.deepEqual(pw, utf8('secret'), 'caller bytes intact');
    assert.equal(w.terminated, true);
    await K.argon2id(pw, salt16(), { m: 64, t: 1, p: 1 });
    assert.equal(FakeWorker.instances.length, 2, 'a new worker per derivation');
  });
});

test('worker path: memory → kdf-out-of-memory; other/bad reply/load error → internal; abort terminates', async () => {
  await withFakeWorker(() => ({ ok: false, error: 'memory', message: 'RangeError' }), async () => {
    await assert.rejects(K.argon2id(utf8('x'), salt16(), K.POLICY), code('kdf-out-of-memory'));
  });
  await withFakeWorker(() => ({ ok: false, error: 'other', message: 'x' }), async () => {
    await assert.rejects(K.argon2id(utf8('x'), salt16(), K.POLICY), code('internal'));
  });
  await withFakeWorker(() => ({ ok: true, bytes: new Uint8Array(5) }), async () => {
    await assert.rejects(K.argon2id(utf8('x'), salt16(), K.POLICY), code('internal'));
  });
  await withFakeWorker(() => 'error', async () => {
    await assert.rejects(K.argon2id(utf8('x'), salt16(), K.POLICY), code('internal'));
    assert.equal(FakeWorker.instances[0].terminated, true);
  });
  await withFakeWorker(() => 'hang', async () => {
    const ac = new AbortController();
    const p = K.argon2id(utf8('x'), salt16(), K.POLICY, { signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    await assert.rejects(p, code('aborted'));
    assert.equal(FakeWorker.instances[0].terminated, true);
  });
});

// ---- kdf-worker.js in Node with a fake `self` --------------------------------------------------

test('kdf-worker.js: replies {ok, bytes} / memory / other', async () => {
  const listeners = [];
  const posted = [];
  const prevSelf = globalThis.self;
  globalThis.self = {
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    postMessage: (msg, transfer) => posted.push({ msg, transfer }),
  };
  try {
    await import('../../app/crypto/kdf-worker.js');
    assert.equal(listeners.length, 1);
    const send = async (data) => {
      posted.length = 0;
      await listeners[0]({ data });
      return posted[0];
    };
    const v = KAT[0];
    const pw = utf8(v.pw);
    const ok = await send({ pw, salt: utf8(v.salt), m: v.m, t: v.t, p: v.p });
    assert.equal(ok.msg.ok, true);
    assert.equal(toHex(ok.msg.bytes), v.out);
    assert.deepEqual(ok.transfer, [ok.msg.bytes.buffer]);
    assert.ok(pw.every((x) => x === 0), 'worker wipes its copy of the passphrase');
    const other = await send({ pw: utf8('x'), salt: salt16(), m: 4, t: 1, p: 1 });
    assert.deepEqual({ ok: other.msg.ok, error: other.msg.error }, { ok: false, error: 'other' });
    const mem = await send({ pw: utf8('x'), salt: salt16(), m: 8 * 1024 * 1024, t: 1, p: 1 });
    assert.deepEqual({ ok: mem.msg.ok, error: mem.msg.error }, { ok: false, error: 'memory' });
  } finally {
    if (prevSelf === undefined) delete globalThis.self;
    else globalThis.self = prevSelf;
  }
});

// ---- review regressions: the cache is part of the lock (DESIGN §1.6, §3.2) ---------------------

test('state.purge() clears the derived-key cache (kdf.js registers itself; no wiring needed)', async () => {
  const state = await import('../../app/state.js');
  const { fn, calls } = fakeArgon();
  K.__setArgon2ForTests(fn);
  const build = async () => ({});
  await K.derive('pw', salt16(), K.POLICY, { purpose: 'purge', build });
  await K.derive('pw', salt16(), K.POLICY, { purpose: 'purge', build });
  assert.equal(calls.length, 1, 'cached');
  state.purge('idle');
  await K.derive('pw', salt16(), K.POLICY, { purpose: 'purge', build });
  assert.equal(calls.length, 2, 'purge dropped the cached key');
});

test('a derivation still running when the cache is cleared (lock) is returned but not cached', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let runs = 0;
  K.__setArgon2ForTests(async (pw, salt, prm) => {
    runs++;
    await gate;
    return new Uint8Array(createHash('sha256').update(pw).update(salt).update(`${prm.m}`).digest());
  });
  const build = async (bits) => ({ first: bits[0] });
  const pending = K.derive('pw', salt16(), K.POLICY, { purpose: 'race', build });
  await new Promise((r) => setTimeout(r, 5));
  K.clearKdfCache(); // the lock happens while Argon2 runs
  release();
  const v = await pending;
  assert.equal(typeof v.first, 'number', 'the caller still gets its value');
  await K.derive('pw', salt16(), K.POLICY, { purpose: 'race', build });
  assert.equal(runs, 2, 'nothing derived before the lock was cached after it');
});

test('derive: an aborted signal wins over a cache hit', async () => {
  const { fn, calls } = fakeArgon();
  K.__setArgon2ForTests(fn);
  const build = async () => ({});
  await K.derive('pw', salt16(), K.POLICY, { purpose: 'ab', build });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(K.derive('pw', salt16(), K.POLICY, { purpose: 'ab', build, signal: ac.signal }), code('aborted'));
  assert.equal(calls.length, 1);
});
