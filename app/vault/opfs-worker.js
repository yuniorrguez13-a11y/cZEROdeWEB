// OPFS sync-access-handle writer (module worker; DESIGN §4.2).
// Protocol: {rid, cmd, ...} → {rid, ok:true, result} | {rid, ok:false, error:{name, message}};
// cmds probe, write-begin, write-chunk, write-commit, write-abort, delete, list.
// Owner: D (phase 2). Phase-0 placeholder: answers every request with an error.
self.addEventListener('message', (event) => {
  const rid = event.data && event.data.rid;
  self.postMessage({ rid, ok: false, error: { name: 'CzdError', message: 'not-implemented' } });
});
