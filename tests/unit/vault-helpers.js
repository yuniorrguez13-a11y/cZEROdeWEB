// Shared helpers for the vault/backup unit tests: a Vault on a fresh fake-indexeddb factory + MemoryStore with fast
// KDF parameters ({m:64, t:1, p:1}), byte helpers and error matchers.
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { openVaultDb } from '../../app/vault/db.js';
import { MemoryStore } from '../../app/vault/store.js';
import { Vault } from '../../app/vault/vault.js';
import { CzdError } from '../../app/errors.js';
import { bytesSource } from '../../app/util/stream.js';

export const FAST = Object.freeze({ m: 64, t: 1, p: 1 });
export const PASS = 'correct horse battery staple';
export const T0 = 1_767_225_600_000;

export const isCzd = (code) => (e) => e instanceof CzdError && e.code === code;

/** A deterministic-ish clock: T0 + 1 s per call. */
export function stepClock(start = T0) {
  let t = start;
  return () => (t += 1000);
}

/**
 * A Vault on its own fake IndexedDB + MemoryStore.
 * @param {object} [opts] idb, store, thumbnailer (default: none), now, isHolder, policy, useHere, init (default true)
 */
export async function makeVault({ idb = new IDBFactory(), store = new MemoryStore(), thumbnailer = async () => null, now = stepClock(), isHolder,
  policy = FAST, useHere, init = true, wrapDb } = {}) {
  let db = await openVaultDb({ idb, IDBKeyRange });
  if (wrapDb) db = wrapDb(db);
  const v = new Vault({ db, openStore: async () => store, policy, thumbnailer, now, isHolder, useHere });
  if (init) await v.init();
  return { v, db, idb, store };
}

/** makeVault + create(PASS). */
export async function unlockedVault(opts = {}) {
  const r = await makeVault(opts);
  const created = await r.v.create(opts.pass ?? PASS, { recovery: opts.recovery ?? true });
  return { ...r, code: created.recoveryCode };
}

/** Deterministic bytes. */
export function bytes(n, seed = 1) {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

export async function collectBytes(it) {
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

export function same(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const file = (data, name, type = '', lastModified = T0 - 1000) => new File([data], name, { type, lastModified });

/** Exports a backup of `v` and returns its bytes and a ByteSource over them. */
export async function backupBytes(v) {
  const b = await v.exportBackup({});
  const out = await collectBytes(b.stream);
  return { out, src: bytesSource(out), size: b.size, name: b.name, skipped: b.skipped };
}

/** Records every event of the given types on `target`. */
export function recordEvents(target, types) {
  const log = [];
  for (const t of types) target.addEventListener(t, (e) => log.push({ type: t, detail: e.detail }));
  return log;
}

/** A controllable async source: yields `first`, then waits for release(), then yields `rest`. */
export function gatedSource(first, rest) {
  let release;
  const gate = new Promise((r) => (release = r));
  let started;
  const startedP = new Promise((r) => (started = r));
  return {
    release,
    started: startedP,
    async *[Symbol.asyncIterator]() {
      yield first;
      started();
      await gate;
      yield rest;
    },
  };
}
