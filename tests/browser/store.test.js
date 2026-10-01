// Browser units for the container stores (runner: tests/browser/index.html?suite=store, app CSP): the shared
// ContainerStore conformance suite against OpfsStore (real OPFS + vault/opfs-worker.js) and IdbBlobStore (real
// IndexedDB), plus OPFS specifics: probe, the worker protocol, ≤ 4 chunks in flight, abort cleanup, reads after
// delete, sweeps under navigator.locks, and passphrase-container round trips through both stores.
import { IdbBlobStore, OpfsStore, openStore, probeBestKind } from '../../app/vault/store.js';
import { openVaultDb } from '../../app/vault/db.js';
import * as C from '../../app/crypto/container.js';
import { CzdError } from '../../app/errors.js';
import { randomBytes, toHex } from '../../app/util/bytes.js';
import { collectBytes, makeAssert, newId, pieces, same, storeCases } from '../unit/store-conformance.js';

const MiB = 2 ** 20;
const T0 = 1_700_000_000_000;
const FAST = { m: 64, t: 1, p: 1 };

/**
 * Empties OPFS before a test. A worker that the previous test terminated while it held a write handle lets go of it
 * asynchronously (terminate() doesn't wait), so the files can stay locked for a moment: retry for up to 5 s, as
 * OpfsStore._removeHere does, instead of failing whichever test comes next.
 */
async function resetOpfs() {
  const root = await navigator.storage.getDirectory();
  for (let i = 0; ; i++) {
    try {
      await root.removeEntry('czd', { recursive: true });
      return;
    } catch (e) {
      if (e.name === 'NotFoundError') return;
      if (e.name !== 'NoModificationAllowedError' || i >= 100) throw e;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

function resetIdb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase('czd-vault');
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('czd-vault delete blocked'));
  });
}

async function itemsDir() {
  const root = await navigator.storage.getDirectory();
  return (await (await root.getDirectoryHandle('czd')).getDirectoryHandle('v1')).getDirectoryHandle('items');
}

async function onDisk(id) {
  try {
    await (await itemsDir()).getFileHandle(`${id}.czd`);
    return true;
  } catch (e) {
    if (e.name === 'NotFoundError') return false;
    throw e;
  }
}

/** Talks to a fresh opfs-worker directly (protocol tests). */
function rawWorker() {
  const w = new Worker(new URL('../../app/vault/opfs-worker.js', import.meta.url), { type: 'module' });
  let rid = 0;
  const pending = new Map();
  w.onmessage = (ev) => {
    const p = pending.get(ev.data.rid);
    pending.delete(ev.data.rid);
    p?.(ev.data);
  };
  return {
    send(msg, transfer = []) {
      const id = ++rid;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        w.postMessage({ ...msg, rid: id }, transfer);
      });
    },
    close: () => w.terminate(),
  };
}

/** @param {{test(name:string, fn:Function):any, assert(c:any, m?:string):void, equal(a:any, b:any, m?:string):void, deepEqual(a:any, b:any, m?:string):void, log(...a:any[]):void}} t */
export default async function (t) {
  const a = makeAssert({ ok: (c, m) => t.assert(c, m), equal: (x, y, m) => t.equal(x, y, m) });
  await resetOpfs();
  await resetIdb();

  const backends = [
    {
      name: 'OpfsStore',
      caps: { blob: true, stage: true, big: true },
      async make() {
        await resetOpfs();
        let offset = 0;
        const store = new OpfsStore({ now: () => Date.now() + offset });
        await store.init();
        return { store, advance: (ms) => { offset += ms; }, cleanup: () => store.close() };
      },
    },
    {
      name: 'IdbBlobStore',
      caps: { blob: true, stage: true, big: true },
      async make() {
        await resetIdb();
        let offset = 0;
        const db = await openVaultDb();
        const store = new IdbBlobStore(db, { now: () => T0 + offset });
        await store.init();
        return { store, advance: (ms) => { offset += ms; }, cleanup: () => db.close() };
      },
    },
  ];

  for (const b of backends) {
    for (const c of storeCases(b.caps)) {
      await t.test(`${b.name}: ${c.name}`, async () => {
        const env = await b.make();
        try {
          await c.fn(a, env);
        } finally {
          await env.cleanup?.();
        }
      });
    }
  }

  await t.test('probeBestKind → opfs in Chromium; openStore(opfs) probes and opens', async () => {
    await resetOpfs();
    t.equal(await probeBestKind(), 'opfs', 'probe');
    const s = await openStore('opfs');
    t.equal(s.kind, 'opfs', 'kind');
    const root = await navigator.storage.getDirectory();
    const v1 = await (await root.getDirectoryHandle('czd')).getDirectoryHandle('v1');
    await v1.getDirectoryHandle('items');
    const tmp = await v1.getDirectoryHandle('tmp');
    const left = [];
    for await (const name of tmp.keys()) left.push(name);
    t.deepEqual(left, [], 'the probe file is removed');
    s.close();
  });

  await t.test('OpfsStore: 20 MiB through the worker with ≤ 4 chunks in flight; File source; final path', async () => {
    await resetOpfs();
    const s = new OpfsStore();
    await s.init();
    const id = newId();
    const data = randomBytes(20 * MiB + 777);
    const t0 = performance.now();
    t.equal(await s.write(id, pieces(data, [999999, 4097, 3 * MiB + 5])), data.length, 'bytes');
    t.log(`OPFS write 20 MiB: ${(performance.now() - t0).toFixed(0)} ms, max in flight ${s.maxInflight}`);
    t.assert(s.maxInflight <= 4 && s.maxInflight >= 2, `in flight ${s.maxInflight}`);
    t.assert(await onDisk(id), 'written at items/<id>.czd');
    const src = await s.source(id);
    t.assert(src.blob instanceof File, 'source.blob is the OPFS File');
    t.equal(src.blob.size, data.length, 'size');
    a.same(await src.readAt(13 * MiB + 1, 5 * MiB), data.subarray(13 * MiB + 1, 18 * MiB + 1), 'readAt');
    a.same(await collectBytes(src.stream(MiB - 1)), data.subarray(MiB - 1), 'stream tail');
    a.same(new Uint8Array(await src.blob.slice(5, 70005).arrayBuffer()), data.subarray(5, 70005), 'blob slice');
    // Reads never hold a sync access handle: the file can be deleted while a File snapshot exists ...
    await s.delete(id);
    t.equal(await onDisk(id), false, 'deleted');
    // ... and reading the stale snapshot is a CzdError, not a DOMException.
    await a.rejects(src.readAt(0, 16), 'item-file-missing', 'read after delete');
    s.close();
  });

  await t.test('OpfsStore: abort mid-write and source failures remove the partial file; nothing is listed', async () => {
    await resetOpfs();
    const s = new OpfsStore();
    await s.init();
    const id = newId();
    const ac = new AbortController();
    let sent = 0;
    async function* gen() {
      for (let i = 0; i < 40; i++) {
        if (i === 9) ac.abort();
        sent++;
        yield randomBytes(MiB);
      }
    }
    await a.rejects(s.write(id, gen(), { signal: ac.signal }), 'aborted', 'aborted');
    t.assert(sent < 40, `source stopped early (${sent})`);
    t.equal(await onDisk(id), false, 'no partial file');
    t.deepEqual(await s.list(), [], 'list empty');
    // the same id can be written afterwards (no stale handle in the worker)
    await s.write(id, randomBytes(10));
    t.equal((await s.source(id)).size, 10, 'rewrite after abort');
    s.close();
  });

  await t.test('OpfsStore: three concurrent writes plus a stage, each with its own handle', async () => {
    await resetOpfs();
    const s = new OpfsStore();
    await s.init();
    const items = [3 * MiB + 1, 5 * MiB + 2, 2 * MiB + 3].map((n) => ({ id: newId(), data: randomBytes(n) }));
    const staged = randomBytes(MiB + 9);
    const [, , , file] = await Promise.all([
      ...items.map((it) => s.write(it.id, pieces(it.data, [123457]))),
      s.stage('three.czd', pieces(staged, [65536])),
    ]);
    for (const it of items) a.same(new Uint8Array(await (await s.source(it.id)).blob.arrayBuffer()), it.data, `item ${it.id}`);
    a.same(new Uint8Array(await file.arrayBuffer()), staged, 'staged');
    t.equal(file.name, 'three.czd', 'staged name');
    s.close();
  });

  await t.test('OpfsStore: sweep is skipped while another context holds czd-store', async () => {
    await resetOpfs();
    let offset = 0;
    const s = new OpfsStore({ now: () => Date.now() + offset });
    await s.init();
    const id = newId();
    await s.write(id, randomBytes(10));
    offset = 2 * 3600 * 1000;
    let release;
    const held = new Promise((r) => {
      release = r;
    });
    let granted;
    const gotIt = new Promise((r) => {
      granted = r;
    });
    const holder = navigator.locks.request('czd-store', { mode: 'exclusive' }, () => {
      granted();
      return held;
    });
    await gotIt;
    const r = await s.sweep({ knownIds: [] });
    t.deepEqual(r, { tmp: 0, orphans: 0, skipped: true }, 'skipped');
    t.assert(await onDisk(id), 'kept');
    release();
    await holder;
    t.deepEqual(await s.sweep({ knownIds: [] }), { tmp: 0, orphans: 1 }, 'swept once free');
    s.close();
  });

  await t.test('opfs-worker protocol: allowed paths only, ordered per path, errors as {name, message}', async () => {
    await resetOpfs();
    const w = rawWorker();
    try {
      for (const path of ['../evil', 'czd/v1/items/x.czd', `czd/v1/items/${newId()}.czd/..`, `czd/v1/items/${newId().toUpperCase()}.czd`, 'czd/v1/probe/a.bin', `czd/v1/tmp/${newId()}.czd`]) {
        const r = await w.send({ cmd: 'write-begin', path });
        t.equal(r.ok, false, `write-begin ${path}`);
        t.equal(r.error?.name, 'TypeError', `${path} → TypeError`);
      }
      const r1 = await w.send({ cmd: 'list', dir: 'czd' });
      t.equal(r1.error?.name, 'TypeError', 'list outside the store dirs');
      const r2 = await w.send({ cmd: 'nope' });
      t.equal(r2.ok, false, 'unknown command');
      const path = `czd/v1/items/${newId()}.czd`;
      const r3 = await w.send({ cmd: 'write-chunk', path, buf: new ArrayBuffer(4) });
      t.equal(r3.error?.name, 'InvalidStateError', 'chunk without begin');
      t.equal((await w.send({ cmd: 'write-begin', path })).ok, true, 'begin');
      t.equal((await w.send({ cmd: 'write-begin', path })).error?.name, 'InvalidStateError', 'second begin on an open path');
      t.equal((await w.send({ cmd: 'delete', path })).error?.name, 'NoModificationAllowedError', 'delete while writing');
      // fire 6 chunks without waiting: the worker applies them in order
      const bufs = [1, 2, 3, 4, 5, 6].map((n) => new Uint8Array(1000 + n).fill(n));
      const acks = await Promise.all(bufs.map((u) => {
        const copy = u.slice();
        return w.send({ cmd: 'write-chunk', path, buf: copy.buffer }, [copy.buffer]);
      }));
      t.deepEqual(acks.map((x) => x.result), [1001, 2003, 3006, 4010, 5015, 6021], 'running totals in order');
      t.equal((await w.send({ cmd: 'write-commit', path })).result, 6021, 'commit size');
      const file = await (await (await itemsDir()).getFileHandle(path.split('/').pop())).getFile();
      const back = new Uint8Array(await file.arrayBuffer());
      let o = 0;
      let ok = true;
      for (const u of bufs) {
        ok = ok && same(back.subarray(o, o + u.length), u);
        o += u.length;
      }
      t.assert(ok, 'bytes in order');
      const listed = await w.send({ cmd: 'list', dir: 'czd/v1/items' });
      t.deepEqual(listed.result.map((e) => [e.name, e.size]), [[path.split('/').pop(), 6021]], 'list');
      t.equal((await w.send({ cmd: 'delete', path })).result, true, 'delete → existed');
      t.equal((await w.send({ cmd: 'delete', path })).result, false, 'delete again → false');
      t.equal((await w.send({ cmd: 'write-abort', path })).ok, true, 'abort of nothing is fine');
      t.equal((await w.send({ cmd: 'probe' })).result, true, 'probe');
    } finally {
      w.close();
    }
  });

  await t.test('OpfsStore: a write-begin on a file another context is writing fails without deleting it', async () => {
    await resetOpfs();
    const s = new OpfsStore();
    await s.init();
    const w = rawWorker();
    const id = newId();
    const path = `czd/v1/items/${id}.czd`;
    try {
      t.equal((await w.send({ cmd: 'write-begin', path })).ok, true, 'other context holds the handle');
      await a.rejects(s.write(id, randomBytes(10)), (e) => e instanceof CzdError && e.cause?.name === 'NoModificationAllowedError', 'second writer refused');
      t.assert(await onDisk(id), 'the other writer\'s file is still there');
      t.deepEqual(await s.sweep({ knownIds: [] }), { tmp: 0, orphans: 0 }, 'young file not swept');
    } finally {
      w.close();
      s.close();
    }
  });

  await t.test('test setup: resetOpfs works right after terminating a worker that holds a write handle', async () => {
    // worker.terminate() returns before the worker lets go of its handles (the test above ends that way).
    for (let i = 0; i < 5; i++) {
      const w = rawWorker();
      t.equal((await w.send({ cmd: 'write-begin', path: `czd/v1/items/${newId()}.czd` })).ok, true, 'the worker holds a handle');
      w.close();
      await resetOpfs();
      let left = true;
      try {
        await (await navigator.storage.getDirectory()).getDirectoryHandle('czd');
      } catch (e) {
        left = e.name !== 'NotFoundError';
      }
      t.equal(left, false, 'czd removed');
    }
  });

  await t.test('passphrase container round trip through OPFS and IndexedDB stores', async () => {
    await resetOpfs();
    await resetIdb();
    const db = await openVaultDb();
    const stores = [new OpfsStore(), new IdbBlobStore(db)];
    const pk = await C.makePassKek('correct horse', FAST);
    try {
      for (const s of stores) {
        await s.init();
        const data = randomBytes(3 * 262144 + 7);
        const id = toHex(randomBytes(16));
        await s.write(id, C.encryptStream(pieces(data, [100000]), {
          size: data.length,
          meta: { v: 1, name: 'clip.webm', type: 'video/webm', size: data.length },
          stanzasFor: async (fk) => [await C.passStanza(fk, pk)],
        }));
        const src = await s.source(id);
        const opened = await C.openSource(src, { passphrase: 'correct horse' });
        try {
          t.equal(opened.meta.name, 'clip.webm', `${s.kind}: name`);
          a.same(await collectBytes(C.decryptSource(src, opened)), data, `${s.kind}: plaintext`);
          // the SW streams from source.blob: chunk 1 straight from the Blob
          const cs = opened.chunkSize;
          const ct = new Uint8Array(await src.blob.slice(opened.headerLen + cs + 16, opened.headerLen + 2 * (cs + 16)).arrayBuffer());
          a.same(ct, await src.readAt(opened.headerLen + cs + 16, cs + 16), `${s.kind}: blob slice = readAt`);
        } finally {
          C.release(opened);
        }
        await a.rejects(C.openSource(src, { passphrase: 'wrong horse' }), 'wrong-passphrase', `${s.kind}: wrong passphrase`);
      }
    } finally {
      stores[0].close();
      db.close();
    }
  });

  await t.test('OpfsStore: close() during a write rejects it as aborted, starts no new worker and leaves no file', async () => {
    await resetOpfs();
    const s = new OpfsStore();
    await s.init();
    const id = newId();
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    async function* paused() {
      yield randomBytes(2 * MiB);
      await gate;
      yield randomBytes(10);
    }
    const writing = s.write(id, paused());
    for (let i = 0; i < 100 && !(await onDisk(id)); i++) await new Promise((r) => setTimeout(r, 10));
    t.assert(await onDisk(id), 'write started');
    s.close();
    release();
    await a.rejects(writing, 'aborted', 'the interrupted write');
    t.equal(s._client.worker, null, 'no worker was started after close()');
    let gone = false;
    for (let i = 0; i < 50 && !gone; i++) {
      gone = !(await onDisk(id));
      if (!gone) await new Promise((r) => setTimeout(r, 20));
    }
    t.assert(gone, 'partial file removed');
    // the store still works afterwards (a later call starts a new worker)
    await s.write(id, randomBytes(10));
    t.equal((await s.source(id)).size, 10, 'usable after close()');
    s.close();
  });

  await t.test('OpfsStore: a worker lost while write-begin is pending leaves no file behind', async () => {
    await resetOpfs();
    const s = new OpfsStore();
    await s.init();
    const id = newId();
    const realCall = s._client.call.bind(s._client);
    // The worker creates the file and opens its handle, then dies before its answer arrives.
    s._client.call = async (cmd, args, transfer, gen) => {
      if (cmd !== 'write-begin') return realCall(cmd, args, transfer, gen);
      await realCall(cmd, args, transfer, gen);
      s._client.terminate();
      throw s._client.lastError;
    };
    await a.rejects(s.write(id, randomBytes(100)), 'aborted', 'write');
    s._client.call = realCall;
    t.equal(await onDisk(id), false, 'no empty file left at the final path');
    s.close();
  });

  await t.test('IdbBlobStore through openStore(idb) with the real IndexedDB', async () => {
    await resetIdb();
    const db = await openVaultDb();
    const s = await openStore('idb', { db });
    t.equal(s.kind, 'idb', 'kind');
    const id = newId();
    const data = randomBytes(17 * MiB + 1);
    await s.write(id, new Blob([data]));
    const src = await s.source(id);
    t.assert(src.blob instanceof Blob, 'composite Blob');
    a.same(await src.readAt(16 * MiB - 3, 6), data.subarray(16 * MiB - 3, 16 * MiB + 3), 'across segments');
    const e = await s.estimate();
    t.assert(e && typeof e.usage === 'number' && typeof e.quota === 'number', `estimate ${JSON.stringify(e)}`);
    db.close();
  });

  await resetOpfs();
  await resetIdb();
}
