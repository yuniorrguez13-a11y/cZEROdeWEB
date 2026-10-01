// app/vault/vault.js lifecycle (DESIGN §1.4, §3.5, §4.5): init/status, create (+recovery code, floor), unlock (wrong
// passphrase, canonicalization), lock (sync, purge, 'locking'), recovery-code unlock, change passphrase, set/remove
// recovery, compare-and-swap between two instances, destroy, storage, other-tab/unavailable, useHere, and a
// cross-check of the §3.5 key derivations against the vault-1 golden vector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolveObjectURL } from 'node:buffer';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { Vault } from '../../app/vault/vault.js';
import { openVaultDb } from '../../app/vault/db.js';
import { MemoryStore } from '../../app/vault/store.js';
import * as state from '../../app/state.js';
import { FLOOR, __setArgon2ForTests, deriveKek } from '../../app/crypto/kdf.js';
import { decryptSource } from '../../app/crypto/container.js';
import { ascii, concat, fromHex, randomBytes, toB64, utf8 } from '../../app/util/bytes.js';
import { FAST, PASS, collectBytes, file, isCzd, makeVault, recordEvents, unlockedVault } from './vault-helpers.js';

const CODE_RE = /^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/;

test('init: no vault → none; a db that fails → unavailable; no db → unavailable', async () => {
  const { v } = await makeVault();
  assert.equal(v.status, 'none');
  const broken = new Vault({ db: { getMeta: async () => { throw new Error('boom'); } }, openStore: async () => null });
  await broken.init();
  assert.equal(broken.status, 'unavailable');
  const none = new Vault({ db: null, openStore: async () => null });
  await none.init();
  assert.equal(none.status, 'unavailable');
  await assert.rejects(none.create(PASS), isCzd('store-unavailable'));
});

test('create: unlocked, recovery code 8×4 base32, meta written, events; second create → vault-exists', async () => {
  const { v, db } = await makeVault();
  const log = recordEvents(v, ['status', 'meta']);
  const r = await v.create(PASS);
  assert.match(r.recoveryCode, CODE_RE);
  assert.ok(Number.isFinite(r.ms));
  assert.equal(v.status, 'unlocked');
  assert.deepEqual(v.kdfParams, FAST);
  assert.equal(v.floor, false);
  assert.equal(v.hasRecovery, true);
  assert.equal(v.storeKind, 'memory');
  assert.equal(v.lastBackupAt, null);
  assert.deepEqual(v.items(), []);
  assert.deepEqual(v.lists(), []);
  const meta = await db.getMeta();
  assert.equal(meta.v, 1);
  assert.equal(meta.vaultId.length, 16);
  assert.deepEqual({ id: meta.kdf.id, m: meta.kdf.m, t: meta.kdf.t, p: meta.kdf.p }, { id: 1, ...FAST });
  assert.equal(meta.wrap.iv.length, 12);
  assert.equal(meta.wrap.ct.length, 48);
  assert.equal(meta.rwrap.ct.length, 48);
  assert.ok(log.some((e) => e.type === 'status' && e.detail.status === 'unlocked'));
  assert.ok(log.some((e) => e.type === 'meta'));
  await assert.rejects(v.create(PASS), isCzd('vault-exists'));
  await assert.rejects(v.create(''), TypeError);
});

test('create: recovery:false → no code; another tab created first → vault-exists and status locked', async () => {
  const idb = new IDBFactory();
  const { v } = await makeVault({ idb });
  const r = await v.create(PASS, { recovery: false });
  assert.equal(r.recoveryCode, null);
  assert.equal(v.hasRecovery, false);
  // A second instance that read "no vault" before the first one committed.
  const { v: late } = await makeVault({ idb, init: false });
  late.status = 'none';
  await assert.rejects(late.create('another passphrase'), isCzd('vault-exists'));
  assert.equal(late.status, 'locked');
});

test('create with FLOOR parameters flags the vault floor:true', async () => {
  __setArgon2ForTests(async (pw, salt) => new Uint8Array(createHash('sha256').update(pw).update(salt).digest()));
  try {
    const { v, db } = await makeVault();
    await v.create(PASS, { params: FLOOR });
    assert.equal(v.floor, true);
    assert.deepEqual(v.kdfParams, { m: FLOOR.m, t: FLOOR.t, p: FLOOR.p });
    assert.equal((await db.getMeta()).floor, true);
    v.lock('test');
    await v.unlock(PASS);
    assert.equal(v.status, 'unlocked');
  } finally {
    __setArgon2ForTests(null);
  }
});

test('create/unlock in a tab that is not the holder → other-tab', async () => {
  let holder = false;
  const { v } = await makeVault({ isHolder: () => holder });
  assert.equal(v.status, 'other-tab');
  await assert.rejects(v.create(PASS), isCzd('other-tab'));
  holder = true;
  await v.init();
  assert.equal(v.status, 'none');
  await v.create(PASS);
  holder = false;
  v.lock('remote');
  assert.equal(v.status, 'other-tab');
  await assert.rejects(v.unlock(PASS), isCzd('other-tab'));
});

test('unlock: wrong / empty passphrase → wrong-passphrase; canonical whitespace and NFC accepted; index restored', async () => {
  const { v } = await unlockedVault({ pass: 'Crème brûlée  is   tasty' });
  const a = await v.addFile(file(new Uint8Array([1, 2, 3]), 'a.txt'));
  const l = await v.createList({ name: 'L', itemIds: [a.id] });
  v.lock('user');
  assert.equal(v.status, 'locked');
  await assert.rejects(v.unlock('Creme brulee is tasty'), isCzd('wrong-passphrase'));
  await assert.rejects(v.unlock('crème brûlée is tasty'), isCzd('wrong-passphrase'));
  await assert.rejects(v.unlock(''), isCzd('wrong-passphrase'));
  await assert.rejects(v.unlock('   '), isCzd('wrong-passphrase'));
  assert.equal(v.status, 'locked');
  // NFD + extra/leading whitespace canonicalize to the same bytes.
  const r = await v.unlock('  Crème brûlée is\ttasty \n'.normalize('NFD'));
  assert.ok(Number.isFinite(r.ms));
  assert.equal(v.lastUnlockMs, r.ms);
  assert.equal(v.status, 'unlocked');
  assert.deepEqual(v.items().map((i) => i.id), [a.id]);
  assert.deepEqual(v.list(l.id).itemIds, [a.id]);
  assert.deepEqual(await v.unlock('anything'), { ms: 0 }, 'already unlocked');
});

test('unlock without a vault → no-vault; unlock with an unavailable store → store-unavailable', async () => {
  const { v } = await makeVault();
  await assert.rejects(v.unlock(PASS), isCzd('no-vault'));
  const idb = new IDBFactory();
  const { v: a } = await unlockedVault({ idb });
  a.lock('x');
  const db = await openVaultDb({ idb, IDBKeyRange });
  const b = new Vault({ db, openStore: async () => { throw new Error('no OPFS'); }, policy: FAST });
  await b.init();
  assert.equal(b.status, 'unavailable');
  await assert.rejects(b.unlock(PASS), isCzd('store-unavailable'));
});

test('lock is synchronous: locking event first (keys still usable), then keys/index dropped, status, purge(reason)', async () => {
  const { v } = await unlockedVault({ thumbnailer: async () => ({ jpeg: new Uint8Array([0xff, 0xd8, 1, 2]), w: 4, h: 3 }) });
  const a = await v.addFile(file(new Uint8Array(10), 'p.png', 'image/png'));
  const url = await v.thumbUrl(a.id);
  assert.ok(resolveObjectURL(url));
  const seen = [];
  v.addEventListener('locking', (e) => seen.push(['locking', e.detail.reason, v.items().length]));
  v.addEventListener('status', (e) => seen.push(['status', e.detail.status]));
  const off = state.onPurge((reason) => seen.push(['purge', reason]));
  try {
    const ret = v.lock('panic');
    assert.equal(ret, undefined);
    assert.equal(v.status, 'locked');
    assert.deepEqual(seen, [['locking', 'panic', 1], ['status', 'locked'], ['purge', 'panic']]);
  } finally {
    off();
  }
  assert.throws(() => v.items(), isCzd('vault-locked'));
  assert.throws(() => v.item(a.id), isCzd('vault-locked'));
  assert.throws(() => v.lists(), isCzd('vault-locked'));
  assert.equal(resolveObjectURL(url), undefined, 'thumbnail URL revoked');
  await assert.rejects(v.thumbUrl(a.id), isCzd('vault-locked'));
  await assert.rejects(v.open(a.id), isCzd('vault-locked'));
  // Locking again (and locking with no vault) still purges.
  const reasons = [];
  const off2 = state.onPurge((r) => reasons.push(r));
  v.lock('idle');
  off2();
  assert.deepEqual(reasons, ['idle']);
});

test('a lock during unlock wins: the unlock rejects (aborted) and the vault stays locked', async () => {
  const { v } = await unlockedVault();
  v.lock('x');
  const p = v.unlock(PASS);
  v.lock('again');
  await assert.rejects(p, isCzd('aborted'));
  assert.equal(v.status, 'locked');
});

test('unlockWithRecovery: tolerant code, sets the new passphrase, the code keeps working; wrong codes → recovery-wrong', async () => {
  const { v, code } = await unlockedVault();
  await v.addNote({ title: 'n', body: 'b' });
  v.lock('user');
  await assert.rejects(v.unlockWithRecovery('AAAA-BBBB', 'new pass phrase'), isCzd('recovery-wrong'));
  await assert.rejects(v.unlockWithRecovery('!!!!-!!!!-!!!!-!!!!-!!!!-!!!!-!!!!-!!!!', 'new pass phrase'), isCzd('recovery-wrong'));
  await assert.rejects(v.unlockWithRecovery(`${code}AAAA`, 'new pass phrase'), isCzd('recovery-wrong'));
  const wrong = code.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
  await assert.rejects(v.unlockWithRecovery(wrong, 'new pass phrase'), isCzd('recovery-wrong'));
  await assert.rejects(v.unlockWithRecovery(code, ''), TypeError);
  assert.equal(v.status, 'locked');
  const typed = ` ${code.toLowerCase().replaceAll('-', ' ')} `;
  await v.unlockWithRecovery(typed, 'new pass phrase');
  assert.equal(v.status, 'unlocked');
  assert.equal(v.items().length, 1);
  v.lock('user');
  await assert.rejects(v.unlock(PASS), isCzd('wrong-passphrase'));
  await v.unlock('new pass phrase');
  v.lock('user');
  await v.unlockWithRecovery(code, 'third pass phrase');
  v.lock('user');
  await v.unlock('third pass phrase');
});

test('recovery code look-alikes 0/1/8 are read as O/I/B', async () => {
  for (let i = 0; i < 20; i++) {
    const { v, code } = await unlockedVault();
    if (!/[OIB]/.test(code)) continue;
    v.lock('user');
    await v.unlockWithRecovery(code.replaceAll('O', '0').replaceAll('I', '1').replaceAll('B', '8'), 'new pass phrase');
    assert.equal(v.status, 'unlocked');
    return;
  }
  assert.fail('no code with O/I/B in 20 tries');
});

test('changePassphrase: needs unlocked + old passphrase; old stops working; meta event', async () => {
  const { v } = await unlockedVault();
  const log = recordEvents(v, ['meta']);
  await assert.rejects(v.changePassphrase('nope nope nope', 'next passphrase'), isCzd('wrong-passphrase'));
  await assert.rejects(v.changePassphrase(PASS, ''), TypeError);
  await v.changePassphrase(PASS, 'next passphrase');
  assert.equal(log.length, 1);
  v.lock('user');
  await assert.rejects(v.changePassphrase(PASS, 'x y z w'), isCzd('vault-locked'));
  await assert.rejects(v.unlock(PASS), isCzd('wrong-passphrase'));
  await v.unlock('next passphrase');
});

test('compare-and-swap: two instances on one database — the second writer gets vault-changed', async () => {
  const idb = new IDBFactory();
  const { v: a } = await unlockedVault({ idb });
  let onRead = () => {};
  let gate = Promise.resolve();
  const { v: b } = await makeVault({
    idb,
    wrapDb: (db) => Object.assign(Object.create(db), {
      async getMeta() {
        const m = await db.getMeta();
        onRead();
        return m;
      },
      async putMeta(rec, opts) {
        await gate;
        return db.putMeta(rec, opts);
      },
    }),
  });
  await b.unlock(PASS);
  let openGate;
  gate = new Promise((r) => (openGate = r));
  const read = new Promise((r) => (onRead = r));
  const pb = b.changePassphrase(PASS, 'from tab b passphrase');
  await read; // b has read the vault record…
  await a.changePassphrase(PASS, 'from tab a passphrase'); // …a changes it…
  openGate(); // …then b tries to write
  await assert.rejects(pb, isCzd('vault-changed'));
  a.lock('x');
  await a.unlock('from tab a passphrase');
  await assert.rejects(b.setRecovery('from tab b passphrase'), isCzd('wrong-passphrase'));
});

test('setRecovery replaces the code (old one stops working); removeRecovery; wrong passphrase rejected', async () => {
  const { v, code: first } = await unlockedVault();
  await assert.rejects(v.setRecovery('bad pass words'), isCzd('wrong-passphrase'));
  const second = await v.setRecovery(PASS);
  assert.match(second, CODE_RE);
  assert.notEqual(second, first);
  assert.equal(v.hasRecovery, true);
  v.lock('x');
  await assert.rejects(v.unlockWithRecovery(first, 'p q r s t'), isCzd('recovery-wrong'));
  await v.unlockWithRecovery(second, 'p q r s t');
  await assert.rejects(v.removeRecovery(PASS), isCzd('wrong-passphrase'));
  await v.removeRecovery('p q r s t');
  assert.equal(v.hasRecovery, false);
  v.lock('x');
  await assert.rejects(v.unlockWithRecovery(second, 'u v w x y'), isCzd('recovery-wrong'));
  await v.unlock('p q r s t');
});

test('destroy: deletes every container (also orphans) and the database; a new vault can be created', async () => {
  const { v, store, db } = await unlockedVault();
  const a = await v.addFile(file(new Uint8Array(100), 'a.bin'));
  await store.write('ab'.repeat(16), new Uint8Array(5)); // an orphan
  await v.addNote({ title: 't', body: 'b' });
  await db.kvSet('dismissed:x', true);
  v.lock('user');
  await v.destroy();
  assert.equal(v.status, 'none');
  assert.equal(v.hasRecovery, false);
  assert.equal(v.kdfParams, null);
  assert.deepEqual(await store.list(), []);
  assert.equal(await db.getMeta(), undefined);
  assert.deepEqual(await db.getAll('items'), []);
  assert.equal(await db.kvGet('dismissed:x'), undefined);
  await v.create('a brand new vault');
  assert.equal(v.status, 'unlocked');
  assert.throws(() => v.item(a.id), isCzd('item-not-found'));
});

test('storage(): counts and bytes while unlocked and locked; estimate from the store', async () => {
  const { v, store } = await unlockedVault();
  const a = await v.addFile(file(new Uint8Array(1000), 'a.bin'));
  const b = await v.addFile(file(new Uint8Array(2000), 'b.bin'));
  const s1 = await v.storage();
  assert.equal(s1.count, 2);
  assert.equal(s1.itemBytes, a.storedBytes + b.storedBytes);
  assert.equal(s1.usage, store.usage());
  assert.equal(s1.quota, null);
  assert.equal(s1.persisted, false);
  v.lock('x');
  const s2 = await v.storage();
  assert.equal(s2.count, 2);
  assert.equal(s2.itemBytes, s1.itemBytes);
  const { v: empty } = await makeVault();
  const s3 = await empty.storage();
  assert.equal(s3.count, null);
  assert.equal(s3.itemBytes, null);
});

test('useHere: runs the tab takeover, then re-reads the vault (other-tab → locked); a refused takeover → other-tab', async () => {
  let holder = true;
  const idb = new IDBFactory();
  await unlockedVault({ idb });
  holder = false;
  let calls = 0;
  let allow = false;
  const { v } = await makeVault({ idb, isHolder: () => holder, useHere: async () => { calls++; holder = allow; return allow; } });
  assert.equal(v.status, 'other-tab');
  await assert.rejects(v.useHere(), isCzd('other-tab'));
  assert.equal(v.status, 'other-tab');
  allow = true;
  await v.useHere();
  assert.equal(calls, 2);
  assert.equal(v.status, 'locked');
  await v.unlock(PASS);
});

test('§3.5 derivations match the vault-1 golden vector (item-wrap key, index record AAD, VMK wrap AAD)', async () => {
  const dir = new URL('../vectors/czd2/', import.meta.url);
  const vec = JSON.parse(readFileSync(new URL('czd2.json', dir), 'utf8')).vectors.find((x) => x.id === 'vault-1');
  const container = new Uint8Array(readFileSync(new URL(vec.file, dir)));
  const vmkRaw = fromHex(vec.vmkHex);
  const vaultId = fromHex(vec.vaultIdHex);
  const itemId = vec.itemIdHex;
  const subtle = globalThis.crypto.subtle;
  // Built independently from the spec text: KEK wraps the VMK; indexKey = HKDF(VMK, vaultId, "cZEROde vault index").
  const salt = randomBytes(16);
  const kek = await deriveKek(PASS, salt, FAST, { purpose: 'test-vector' });
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: concat(ascii('cZEROde vault v1'), vaultId) }, kek, vmkRaw));
  const hk = await subtle.importKey('raw', vmkRaw, 'HKDF', false, ['deriveKey']);
  const indexKey = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: vaultId, info: ascii('cZEROde vault index') }, hk,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const mac = container.slice(vec.headerLen - 32, vec.headerLen);
  const ix = { name: 'vault-item.bin', type: 'application/octet-stream', size: vec.size, addedAt: 1, origName: 'vault-item.bin', hmac: toB64(mac) };
  const riv = randomBytes(12);
  const enc = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: riv, additionalData: concat(ascii('item:'), fromHex(itemId)) }, indexKey, utf8(JSON.stringify(ix))));
  const idb = new IDBFactory();
  const db = await openVaultDb({ idb, IDBKeyRange });
  await db.putMeta({ v: 1, vaultId, kdf: { id: 1, ...FAST, salt }, floor: false, wrap: { iv, ct }, rwrap: null, storeKind: 'memory', createdAt: 1, lastBackupAt: null });
  await db.put('items', { id: itemId, iv: riv, enc, storedBytes: container.length });
  const store = new MemoryStore();
  await store.write(itemId, container);
  const v = new Vault({ db, openStore: async () => store, policy: FAST });
  await v.init();
  await v.unlock(PASS);
  assert.deepEqual(v.items().map((i) => [i.id, i.name, i.size]), [[itemId, 'vault-item.bin', vec.size]]);
  const { src, opened } = await v.open(itemId);
  const pt = await collectBytes(decryptSource(src, opened));
  assert.equal(createHash('sha256').update(pt).digest('hex'), vec.plaintextSha256);
});

test('kvGet/kvSet: device-local values; merged:* keys are reserved for backup merges', async () => {
  const { v } = await makeVault();
  assert.equal(await v.kvGet('legacy-import-done'), undefined);
  await v.kvSet('legacy-import-done', true);
  assert.equal(await v.kvGet('legacy-import-done'), true);
  await v.kvSet('legacy-import-done', undefined);
  assert.equal(await v.kvGet('legacy-import-done'), undefined);
  await assert.rejects(v.kvSet('merged:abc:def', 'x'), TypeError);
  await assert.rejects(v.kvSet(5, 'x'), TypeError);
});
