// Review regressions for app/vault/backup.js + Vault backup methods (DESIGN §3.7): an export must never produce a
// .czb that the reader then refuses as a whole because ONE vault container is damaged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PASS, backupBytes, bytes, file, makeVault, unlockedVault } from './vault-helpers.js';

/** Replaces a MemoryStore container with a modified copy. */
async function damage(store, id, fn) {
  const e = store.items.get(id);
  const buf = new Uint8Array(await e.blob.arrayBuffer());
  store.items.set(id, { ...e, blob: new Blob([fn(buf)]) });
}

test('export skips a container whose header fails its MAC; the rest of the backup restores', async () => {
  const s = await unlockedVault();
  const good = await s.v.addFile(file(bytes(5000, 3), 'good.bin'));
  const bad = await s.v.addFile(file(bytes(5000, 4), 'bad.bin'));
  // Flip a byte inside the encrypted metadata: the header still parses, but its MAC no longer verifies.
  await damage(s.store, bad.id, (b) => {
    b[200] ^= 1;
    return b;
  });
  const b = await backupBytes(s.v);
  assert.equal(b.skipped, 1);
  const t = await makeVault();
  assert.deepEqual(await t.v.restoreBackup(b.src, { pass: PASS }, { mode: 'replace' }), { added: 1, skipped: 0 });
  assert.deepEqual(t.v.items().map((i) => i.id), [good.id]);
});

test('export skips a truncated container (size no longer matches its header); the rest restores', async () => {
  const s = await unlockedVault();
  const good = await s.v.addFile(file(bytes(5000, 5), 'good.bin'));
  const bad = await s.v.addFile(file(bytes(300_000, 6), 'bad.bin'));
  await damage(s.store, bad.id, (b) => b.slice(0, b.length - 100));
  const b = await backupBytes(s.v);
  assert.equal(b.skipped, 1);
  const t = await makeVault();
  assert.deepEqual(await t.v.restoreBackup(b.src, { pass: PASS }, { mode: 'replace' }), { added: 1, skipped: 0 });
  assert.deepEqual(t.v.items().map((i) => i.id), [good.id]);
});

test('replace restore commits the vault record under navigator.locks "czd-vault-record" (§3.5)', async () => {
  const s = await unlockedVault();
  await s.v.addFile(file(bytes(100, 7), 'a.bin'));
  const b = await backupBytes(s.v);
  const t = await makeVault();
  const names = [];
  let inside = 0;
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: {
      async request(name, opts, fn) {
        names.push([name, opts.mode]);
        inside++;
        try {
          return await fn({ name });
        } finally {
          inside--;
        }
      },
    },
  });
  const commit = t.db.commit.bind(t.db);
  let committedInside = false;
  t.db.commit = async (ops, opts) => {
    if (ops.some((o) => o.store === 'meta')) committedInside = inside > 0;
    return commit(ops, opts);
  };
  try {
    await t.v.restoreBackup(b.src, { pass: PASS }, { mode: 'replace' });
  } finally {
    delete globalThis.navigator.locks;
  }
  assert.ok(names.some(([n, m]) => n === 'czd-vault-record' && m === 'exclusive'));
  assert.equal(committedInside, true);
  assert.equal(t.v.items().length, 1);
});

test('a lock while the export is still planning interrupts it (job: busy, then interrupted, busy back to 0)', async () => {
  const { MemoryStore } = await import('../../app/vault/store.js');
  const state = await import('../../app/state.js');
  const inner = new MemoryStore();
  let gate = null;
  const store = Object.assign(Object.create(inner), {
    async source(id) {
      if (gate) await gate.promise;
      return inner.source(id);
    },
  });
  const s = await unlockedVault({ store });
  await s.v.addFile(file(bytes(100, 8), 'a.bin'));
  let open;
  gate = { promise: new Promise((r) => (open = r)) };
  const busyBefore = state.get('busy');
  const p = s.v.exportBackup();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(state.get('busy'), busyBefore + 1, 'planning counts as a running job');
  s.v.lock('user');
  open();
  await assert.rejects(p, (e) => e.code === 'interrupted');
  assert.equal(state.get('busy'), busyBefore);
});
