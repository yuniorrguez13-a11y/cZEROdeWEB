// Argon2id worker (module worker, one derivation per worker; DESIGN §3.2).
// Protocol: receives {pw: Uint8Array, salt, m, t, p}; replies {ok:true, bytes} or {ok:false, error:'memory'|'other', message}.
// 'memory' only for a RangeError or a WebAssembly memory growth/allocation failure.
import './argon2.umd.min.js'; // UMD: assigns globalThis.hashwasm

/** @param {unknown} e */
function isMemoryError(e) {
  if (e instanceof RangeError) return true;
  const msg = String(e && e.message ? e.message : '');
  return /Memory\.grow|grow\(\)|out of memory|Cannot allocate Wasm memory/i.test(msg);
}

self.addEventListener('message', async (ev) => {
  const { pw, salt, m, t, p } = ev.data || {};
  try {
    const out = await globalThis.hashwasm.argon2id({ password: pw, salt, parallelism: p, iterations: t, memorySize: m, hashLength: 32, outputType: 'binary' });
    if (pw instanceof Uint8Array) pw.fill(0);
    const bytes = out.slice(); // a standalone 32-byte buffer, safe to transfer
    out.fill(0);
    self.postMessage({ ok: true, bytes }, [bytes.buffer]);
  } catch (e) {
    if (pw instanceof Uint8Array) pw.fill(0);
    self.postMessage({ ok: false, error: isMemoryError(e) ? 'memory' : 'other', message: String(e && e.message ? e.message : e) });
  }
});
