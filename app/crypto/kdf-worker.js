// Argon2id worker (module worker, one derivation per worker; DESIGN §3.2).
// Protocol: receives {pw: Uint8Array, salt, m, t, p}; replies {ok:true, bytes} or {ok:false, error:'memory'|'other', message}.
// Owner: A (phase 1). Phase-0 placeholder: answers every request with an error.
self.addEventListener('message', () => {
  self.postMessage({ ok: false, error: 'other', message: 'not-implemented' });
});
