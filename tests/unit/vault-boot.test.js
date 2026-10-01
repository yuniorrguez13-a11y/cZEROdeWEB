// app/vault/boot.js (DESIGN §2.5, §4.5, §10): boot on fake-indexeddb (status mirroring, singleton, probes, remote
// locks that ignore other tabs' idle/hidden locks), the single-vault-tab lock with a fake LockManager (yield handoff,
// steal when the holder does not answer), and the desktop index.json mirror with a fake Tauri fs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { boot, createMirror, createTabLock, rebuildFromMirror } from '../../app/vault/boot.js';
import * as vaultModule from '../../app/vault/vault.js';
import * as state from '../../app/state.js';
import * as settings from '../../app/settings.js';
import { openVaultDb } from '../../app/vault/db.js';
import { fromUtf8 } from '../../app/util/bytes.js';
import { PASS, file } from './vault-helpers.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function until(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await tick(5);
  }
}

/** A LockManager stand-in: exclusive locks with ifAvailable, signal (queued) and steal. */
function fakeLocks() {
  let holder = null;
  const queue = [];
  const release = (entry) => {
    if (holder !== entry) return;
    holder = null;
    const next = queue.shift();
    if (next) grant(next);
  };
  const grant = (req) => {
    const entry = { req, stolen: false };
    holder = entry;
    let p;
    try {
      p = Promise.resolve(req.cb({ name: req.name, mode: 'exclusive' }));
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then((v) => {
      if (entry.stolen) return;
      release(entry);
      req.resolve(v);
    }, (e) => {
      if (entry.stolen) return;
      release(entry);
      req.reject(e);
    });
  };
  return {
    request(name, opts, cb) {
      return new Promise((resolve, reject) => {
        const req = { name, cb, resolve, reject };
        if (opts.steal) {
          if (holder) {
            holder.stolen = true;
            holder.req.reject(new DOMException('lock stolen', 'AbortError'));
            holder = null;
          }
          grant(req);
          return;
        }
        if (!holder) {
          grant(req);
          return;
        }
        if (opts.ifAvailable) {
          Promise.resolve(cb(null)).then(resolve, reject);
          return;
        }
        queue.push(req);
        opts.signal?.addEventListener('abort', () => {
          const i = queue.indexOf(req);
          if (i >= 0) {
            queue.splice(i, 1);
            reject(new DOMException('aborted', 'AbortError'));
          }
        });
      });
    },
    get held() {
      return holder !== null;
    },
  };
}

test('boot: vault singleton, status mirrored to state, browser probe, legacy probe; works end to end on the idb store', async () => {
  const idb = new IDBFactory();
  const { vault, stop } = await boot({ state, settings, idb, IDBKeyRange, locks: null, BroadcastChannel: null });
  try {
    assert.equal(vaultModule.vault, vault);
    assert.equal(vault.status, 'none');
    assert.equal(state.get('vault.status'), 'none');
    await vault.create(PASS);
    assert.equal(state.get('vault.status'), 'unlocked');
    assert.equal(vault.storeKind, 'idb', 'Node has no OPFS: the IndexedDB segment store');
    const info = await vault.addFile(file(new Uint8Array(1000).fill(3), 'a.bin'));
    vault.lock('user');
    assert.equal(state.get('vault.status'), 'locked');
    await vault.unlock(PASS);
    assert.equal(vault.item(info.id).size, 1000);
    await until(() => state.get('browser.ok') !== undefined);
    assert.equal(state.get('browser.ok'), true);
    await until(() => state.get('legacy.importDone') !== undefined);
    assert.equal(state.get('legacy.found'), null);
    assert.equal(state.get('legacy.importDone'), false);
  } finally {
    stop();
    vaultModule.setVault(null);
  }
  // A second boot on the same database finds the vault locked.
  const again = await boot({ state, settings, idb, IDBKeyRange, locks: null, BroadcastChannel: null });
  try {
    assert.equal(again.vault.status, 'locked');
    await again.vault.unlock(PASS);
    assert.equal(again.vault.items().length, 1);
  } finally {
    again.stop();
    vaultModule.setVault(null);
  }
});

test('boot: any state.purge also locks the unlocked vault (once)', async () => {
  const { vault, stop } = await boot({ state, settings, idb: new IDBFactory(), IDBKeyRange, locks: null, BroadcastChannel: null });
  try {
    await vault.create(PASS);
    const seen = [];
    vault.addEventListener('locking', (e) => seen.push(e.detail.reason));
    state.purge('panic');
    assert.equal(vault.status, 'locked');
    assert.deepEqual(seen, ['panic']);
  } finally {
    stop();
    vaultModule.setVault(null);
  }
});

test('boot: an unavailable database → status unavailable (no throw)', async () => {
  const broken = { open() { throw new DOMException('denied', 'SecurityError'); } };
  const { vault, stop } = await boot({ state, settings, idb: broken, locks: null, BroadcastChannel: null });
  try {
    assert.equal(vault.status, 'unavailable');
    assert.equal(state.get('vault.status'), 'unavailable');
  } finally {
    stop();
    vaultModule.setVault(null);
  }
});

test('boot: remote locks from other tabs lock this vault, except other tabs\' own idle/hidden/pagehide/freeze', async () => {
  const { vault, stop } = await boot({ state, settings, idb: new IDBFactory(), IDBKeyRange, locks: null, BroadcastChannel: null });
  const other = new BroadcastChannel('czd-lock');
  try {
    await vault.create(PASS);
    for (const reason of ['idle', 'hidden', 'pagehide', 'freeze']) other.postMessage({ cmd: 'lock', reason, from: 'another-tab' });
    await tick(50);
    assert.equal(vault.status, 'unlocked');
    other.postMessage({ cmd: 'lock', reason: 'panic', from: 'another-tab' });
    await until(() => vault.status === 'locked');
  } finally {
    other.close();
    stop();
    vaultModule.setVault(null);
  }
});

test('tab lock: first tab holds; "Use it here" makes the holder yield (it locks) and the requester takes over', async () => {
  const locks = fakeLocks();
  const a = createTabLock({ locks, BC: BroadcastChannel, state: { TAB_ID: 'tab-a' } });
  const b = createTabLock({ locks, BC: BroadcastChannel, state: { TAB_ID: 'tab-b' } });
  const lost = [];
  a.onLost = () => lost.push('a');
  b.onLost = () => lost.push('b');
  try {
    assert.equal(await a.acquire(), true);
    assert.equal(await b.acquire(), false);
    assert.equal(a.isHolder(), true);
    assert.equal(b.isHolder(), false);
    assert.equal(await b.takeOver(), true);
    assert.equal(b.isHolder(), true);
    assert.equal(a.isHolder(), false);
    assert.deepEqual(lost, ['a']);
    assert.equal(await b.takeOver(), true, 'already the holder');
  } finally {
    a.close();
    b.close();
  }
});

test('tab lock: a holder that never answers is stolen from (and told it lost the lock)', async () => {
  const locks = fakeLocks();
  const a = createTabLock({ locks, BC: null, state: { TAB_ID: 'tab-a' } });
  const b = createTabLock({ locks, BC: null, state: { TAB_ID: 'tab-b' }, yieldWaitMs: 30 });
  let aLost = 0;
  a.onLost = () => aLost++;
  try {
    assert.equal(await a.acquire(), true);
    assert.equal(await b.takeOver(), true);
    assert.equal(b.isHolder(), true);
    await tick(0);
    assert.equal(a.isHolder(), false);
    assert.equal(aLost, 1);
  } finally {
    a.close();
    b.close();
  }
});

test('tab lock: without navigator.locks every tab is the holder', async () => {
  const t = createTabLock({ locks: null, BC: null, state: {} });
  assert.equal(await t.acquire(), true);
  assert.equal(t.isHolder(), true);
  assert.equal(await t.takeOver(), true);
});

function fakeFs() {
  const files = new Map();
  const ops = [];
  return {
    files,
    ops,
    appDataDir: async () => '/data/com.czeroode.app',
    join: async (...p) => p.join('/'),
    exists: async (p) => files.has(p),
    mkdir: async () => {},
    list: async (dir) => [...files].filter(([p]) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
      .map(([p, b]) => ({ name: p.slice(dir.length + 1), path: p, isFile: true, isDirectory: false, size: b.length, mtime: 0 })),
    readAt: async (p, off, len) => files.get(p).slice(off, off + len),
    async writeStream(p, source) {
      const parts = [];
      for await (const c of source) parts.push(c);
      files.set(p, Buffer.concat(parts));
      ops.push(['write', p]);
      return files.get(p).length;
    },
    async rename(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
      ops.push(['rename', from, to]);
    },
    async remove(p) {
      files.delete(p);
      ops.push(['remove', p]);
    },
  };
}

test('desktop mirror: atomic index.json writes (.part then rename), removal without a vault, rebuild when IndexedDB lost it', async () => {
  const fs = fakeFs();
  const FILE = '/data/com.czeroode.app/vault2/index.json';
  const idb = new IDBFactory();
  const db = await openVaultDb({ idb, IDBKeyRange });
  const { Vault } = vaultModule;
  const { MemoryStore } = await import('../../app/vault/store.js');
  const store = new MemoryStore();
  const v = new Vault({ db, openStore: async () => store, policy: { m: 64, t: 1, p: 1 } });
  await v.init();
  await v.create(PASS);
  await v.addNote({ title: 'kept', body: 'in the mirror' });
  const mirror = createMirror(db, fs);
  mirror.schedule();
  await mirror.flush();
  assert.deepEqual(fs.ops, [['write', `${FILE}.part`], ['rename', `${FILE}.part`, FILE]]);
  const snap = JSON.parse(fromUtf8(fs.files.get(FILE)));
  assert.equal(snap.items.length, 1);
  assert.ok(snap.meta);

  // IndexedDB loses the vault (cleared by the webview) → rebuilt from index.json; the note opens again.
  const fresh = await openVaultDb({ idb: new IDBFactory(), IDBKeyRange });
  assert.equal(await rebuildFromMirror(fresh, fs), true);
  assert.equal(await rebuildFromMirror(fresh, fs), false, 'only when IndexedDB has no vault');
  const v2 = new Vault({ db: fresh, openStore: async () => store, policy: { m: 64, t: 1, p: 1 } });
  await v2.init();
  await v2.unlock(PASS);
  assert.deepEqual(await v2.readNote(v2.items()[0].id), { title: 'kept', body: 'in the mirror' });

  // Destroyed vault → index.json removed (not resurrected at the next start).
  await v.destroy();
  mirror.schedule(true);
  await mirror.flush();
  assert.equal(fs.files.has(FILE), false);
  assert.equal(await rebuildFromMirror(await openVaultDb({ idb: new IDBFactory(), IDBKeyRange }), fs), false);
});

test('boot: the delayed store sweep runs only while this tab still holds the vault tab lock (§4.2)', async () => {
  const { openStore } = await import('../../app/vault/store.js');
  const idb = new IDBFactory();
  const first = await boot({ state, settings, idb, IDBKeyRange, locks: null, BroadcastChannel: null });
  await first.vault.create(PASS);
  first.vault.lock('user');
  first.stop();
  vaultModule.setVault(null);
  // An item file without an index record, written two hours ago (an interrupted import).
  const db = await openVaultDb({ idb, IDBKeyRange });
  const old = await openStore('idb', { db, now: () => Date.now() - 2 * 3600 * 1000 });
  const orphan = 'ab'.repeat(16);
  await old.write(orphan, new Uint8Array(100));
  const hasOrphan = async () => (await old.list()).some((e) => e.id === orphan);

  // Holder at boot, but another tab takes the vault over before the sweep is due: no sweep.
  const locks = fakeLocks();
  const second = await boot({ state, settings, idb, IDBKeyRange, locks, BroadcastChannel: null, sweepDelayMs: 40 });
  const other = createTabLock({ locks, BC: null, state: { TAB_ID: 'other-tab' }, yieldWaitMs: 10 });
  try {
    assert.equal(second.vault.status, 'locked');
    assert.equal(await other.takeOver(), true);
    await tick(0);
    assert.equal(second.vault.status, 'other-tab');
    await tick(120);
    assert.equal(await hasOrphan(), true, 'a tab that lost the vault tab lock does not sweep');
  } finally {
    other.close();
    second.stop();
    vaultModule.setVault(null);
  }

  // The holder sweeps it.
  const third = await boot({ state, settings, idb, IDBKeyRange, locks: fakeLocks(), BroadcastChannel: null, sweepDelayMs: 10 });
  try {
    const end = Date.now() + 3000;
    while (await hasOrphan()) {
      if (Date.now() > end) throw new Error('the holder did not sweep');
      await tick(10);
    }
  } finally {
    third.stop();
    vaultModule.setVault(null);
  }
});

test('tab lock: a double "Use it here" (two overlapping takeOver calls) ends with this tab holding, never "lost"', async () => {
  const locks = fakeLocks();
  const a = createTabLock({ locks, BC: BroadcastChannel, state: { TAB_ID: 'tab-a2' } });
  const b = createTabLock({ locks, BC: BroadcastChannel, state: { TAB_ID: 'tab-b2' }, yieldWaitMs: 50 });
  const lost = [];
  a.onLost = () => lost.push('a');
  b.onLost = () => lost.push('b');
  try {
    assert.equal(await a.acquire(), true);
    const [r1, r2] = await Promise.all([b.takeOver(), b.takeOver()]);
    assert.deepEqual([r1, r2], [true, true]);
    await tick(120); // past the yield wait of either call
    assert.equal(b.isHolder(), true);
    assert.equal(a.isHolder(), false);
    assert.deepEqual(lost, ['a']);
    assert.equal(locks.held, true);
  } finally {
    a.close();
    b.close();
  }
});

test('boot: a panic purge while an unlock or a restore is still running cancels it (the vault never opens afterwards)', async () => {
  const { vault, stop } = await boot({ state, settings, idb: new IDBFactory(), IDBKeyRange, locks: null, BroadcastChannel: null });
  try {
    await vault.create(PASS, { params: { m: 64, t: 1, p: 1 } });
    vault.lock('user');
    const p = vault.unlock(PASS);
    state.purge('panic'); // autolock's Esc×3 with no unlocked vault: state.purge only
    await assert.rejects(p, (e) => e.code === 'aborted');
    assert.equal(vault.status, 'locked');
    // Another tab's or this tab's own passive purge (hidden/idle) does not cancel an unlock in progress.
    const q = vault.unlock(PASS);
    state.purge('hidden');
    await q;
    assert.equal(vault.status, 'unlocked');
  } finally {
    stop();
    vaultModule.setVault(null);
  }
});
