// Browser units for the crypto core (runner: tests/browser/index.html?suite=crypto, app CSP).
// Argon2id runs through the real module worker (kdf-worker.js); container and text formats round trip
// with WebCrypto in the page, and committed golden vectors decrypt in the browser too.
import * as K from '../../app/crypto/kdf.js';
import * as C from '../../app/crypto/container.js';
import { encryptText, decryptText } from '../../app/crypto/textfmt.js';
import { blobSource, bytesSource } from '../../app/util/stream.js';
import { toHex, utf8 } from '../../app/util/bytes.js';
import * as state from '../../app/state.js';

const FAST = { m: 64, t: 1, p: 1 };

async function collect(it) {
  const parts = [];
  let n = 0;
  for await (const p of it) {
    parts.push(p);
    n += p.length;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function randomBytes(n) {
  const u = new Uint8Array(n);
  for (let o = 0; o < n; o += 65536) crypto.getRandomValues(u.subarray(o, Math.min(n, o + 65536)));
  return u;
}

function same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function rejectsWith(t, promise, code, msg) {
  try {
    await promise;
    t.assert(false, `${msg}: expected ${code}, resolved`);
  } catch (e) {
    t.equal(e && e.code, code, msg);
  }
}

/** @param {{test(name:string, fn:Function):any, assert(c:any, m?:string):void, equal(a:any, b:any, m?:string):void, deepEqual(a:any, b:any, m?:string):void, log(...a:any[]):void}} t */
export default async function (t) {
  await t.test('kdf runs in a module worker (browser path)', async () => {
    t.equal(typeof Worker, 'function', 'Worker exists');
    const out = await K.argon2id(utf8('password'), utf8('somesalt'), { m: 64, t: 1, p: 1 });
    t.equal(toHex(out), '729c7a54441bc13559bdca71348c4e554599e719c08a952601ed5c83618c1bbd', 'Argon2id KAT m=64 t=1');
    const out2 = await K.argon2id(utf8('password'), utf8('somesalt'), { m: 256, t: 2, p: 2 });
    t.equal(toHex(out2), '6d093c501fd5999645e0ea3bf620d7b8be7fd2db59c20d9fff9539da2bf57037', 'Argon2id KAT m=256 t=2 p=2');
  });

  await t.test('kdf POLICY known answer through the worker', async () => {
    const t0 = performance.now();
    const out = await K.argon2id(utf8('correct-horse-battery-staple'), utf8('0123456789abcdef'), K.POLICY);
    t.equal(toHex(out), '7d2c03d61a78ee9f87679af4741a8cfbd320efba76349847ac234d208ce13880', 'Argon2id KAT POLICY');
    t.log(`POLICY Argon2id in worker: ${(performance.now() - t0).toFixed(0)} ms (lastMs ${K.lastMs})`);
    t.assert(K.lastMs > 0, 'lastMs updated');
  });

  await t.test('bootProbe succeeds under the app CSP', async () => {
    const r = await K.bootProbe();
    t.equal(r.ok, true, 'probe ok');
    t.assert(r.ms < 5000, `probe ${r.ms} ms`);
  });

  await t.test('aborting a derivation terminates the worker run', async () => {
    const ac = new AbortController();
    const p = K.argon2id(utf8('x'), randomBytes(16), K.POLICY, { signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    await rejectsWith(t, p, 'aborted', 'aborted');
  });

  await t.test('derived-key cache: the second derivation skips Argon2', async () => {
    K.clearKdfCache();
    const salt = randomBytes(16);
    const t0 = performance.now();
    const a = await K.deriveKek('cache me', salt, K.POLICY);
    const first = performance.now() - t0;
    const t1 = performance.now();
    const b = await K.deriveKek(' cache  me ', salt, K.POLICY);
    const second = performance.now() - t1;
    t.assert(a === b, 'same CryptoKey');
    t.assert(second < first, `cached ${second.toFixed(1)} ms < ${first.toFixed(1)} ms`);
    K.clearKdfCache();
  });

  await t.test('state.purge() (lock) drops the derived-key cache', async () => {
    const salt = randomBytes(16);
    const a = await K.deriveKek('purge me', salt, FAST);
    t.assert(a === (await K.deriveKek('purge me', salt, FAST)), 'cached before the lock');
    state.purge('manual');
    t.assert(a !== (await K.deriveKek('purge me', salt, FAST)), 'derived again after the lock');
    K.clearKdfCache();
  });

  await t.test('a lock racing a decrypt is a cancellation, not a damaged file', async () => {
    const data = randomBytes(3 * 4096 + 5);
    const pk = await C.makePassKek('race', FAST);
    const ct = await collect(C.encryptStream(data, { size: data.length, chunkExp: 12, meta: { name: 'r.bin', type: 'application/octet-stream' }, stanzasFor: async (fk) => [await C.passStanza(fk, pk)] }));
    const src = blobSource(new Blob([ct]));
    const o = await C.openSource(src, { passphrase: 'race' });
    let code = null;
    try {
      for await (const p of C.decryptSource(src, o)) { if (p.length) C.release(o); }
    } catch (e) {
      code = e && e.code;
    }
    t.equal(code, 'aborted', 'aborted');
  });

  await t.test('czd2 round trip from a Blob (2 MiB, default 256 KiB chunks)', async () => {
    const data = randomBytes(2 * 2 ** 20 + 12345);
    const pk = await C.makePassKek('browser pass', FAST);
    const parts = [];
    for await (const p of C.encryptStream(new Blob([data]), { size: data.length, meta: { name: 'b.bin', type: 'application/octet-stream' }, stanzasFor: async (fk) => [await C.passStanza(fk, pk)] })) parts.push(p);
    const blob = new Blob(parts);
    const src = blobSource(blob);
    const o = await C.openSource(src, { passphrase: 'browser pass' });
    t.equal(o.size, data.length, 'size');
    t.equal(o.meta.name, 'b.bin', 'name');
    t.assert(same(await collect(C.decryptSource(src, o)), data), 'decryptSource matches');
    for (const [a, b] of [[0, 0], [262143, 262144], [data.length - 10, data.length - 1], [1000, 700000]]) {
      t.assert(same(await C.decryptRange(src, o, a, b), data.subarray(a, b + 1)), `range ${a}..${b}`);
    }
    t.equal(await C.verifySource(src, o), true, 'verifySource');
    await rejectsWith(t, C.openSource(src, { passphrase: 'wrong' }), 'wrong-passphrase', 'wrong passphrase');
    C.release(o);
  });

  await t.test('czd2 bundle entry streams in the browser', async () => {
    const parts = [randomBytes(1000), randomBytes(300000), randomBytes(5)];
    const meta = C.bundleMeta(parts.map((p, i) => ({ name: `e${i}`, type: 'application/octet-stream', size: p.length })));
    const all = new Uint8Array(meta.size);
    parts.forEach((p, i) => all.set(p, meta.entries[i].off));
    const pk = await C.makePassKek('bundle', FAST);
    const ct = await collect(C.encryptStream([all], { size: all.length, meta, stanzasFor: async (fk) => [await C.passStanza(fk, pk)] }));
    const src = bytesSource(ct);
    const o = await C.openSource(src, { passphrase: 'bundle' });
    t.equal(o.isBundle, true, 'bundle');
    for (const [i, e] of o.meta.entries.entries()) t.assert(same(await collect(C.decryptSource(src, o, { entry: e })), parts[i]), `entry ${i}`);
  });

  await t.test('text v2 round trip (FLOOR) and wrong passphrase', async () => {
    const msg = 'ძალიან საიდუმლო 🔐 browser';
    const text = await encryptText(msg, 'text pass', { params: K.FLOOR });
    t.equal(await decryptText(text, 'text pass'), msg, 'round trip');
    await rejectsWith(t, decryptText(text, 'nope'), 'wrong-passphrase', 'wrong passphrase');
  });

  await t.test('committed golden vectors decrypt in the browser', async () => {
    const spec = await (await fetch('../vectors/czd2/czd2.json')).json();
    for (const id of ['size-262145', 'bundle-3']) {
      const v = spec.vectors.find((x) => x.id === id);
      const blob = await (await fetch(`../vectors/czd2/${v.file}`)).blob();
      const src = blobSource(blob);
      const o = await C.openSource(src, { passphrase: v.passphrase });
      const pt = await collect(C.decryptSource(src, o));
      const hex = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', pt)));
      t.equal(hex, v.plaintextSha256, `${id} plaintext sha256`);
      C.release(o);
    }
    const text = await (await fetch('../vectors/text-v2.json')).json();
    const tv = text.vectors.find((x) => x.id === 'floor-canonical');
    t.equal(await decryptText(tv.text, tv.decryptWith), tv.message, 'text vector');
  });
}
