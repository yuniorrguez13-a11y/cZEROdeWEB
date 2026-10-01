// ContainerStore conformance suite (DESIGN §4.2, types.js ContainerStore), shared by every backend: Node runs it
// against MemoryStore, IdbBlobStore (fake-indexeddb) and TauriFsStore (fake Tauri) in tests/unit/store.test.js;
// the browser runs it against OpfsStore and IdbBlobStore (real IndexedDB) in tests/browser/store.test.js.
// Runner-agnostic: no node: imports; every case gets an assert adapter `a` and an env {store, advance(ms)}.
import { CzdError } from '../../app/errors.js';
import { randomBytes, toHex } from '../../app/util/bytes.js';
import * as C from '../../app/crypto/container.js';

const MiB = 2 ** 20;
const H = 3600 * 1000;
export const newId = () => toHex(randomBytes(16));

export function same(x, y) {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
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

/** Async pieces of `u8`; `sizes` cycles through the given piece sizes (odd sizes exercise rechunking). */
export async function* pieces(u8, sizes = [65536]) {
  let i = 0;
  for (let o = 0; o < u8.length; ) {
    const n = sizes[i++ % sizes.length];
    yield u8.subarray(o, Math.min(u8.length, o + n));
    o += n;
  }
}

/**
 * Adapter-based asserts. `rejects(p, want)`: want is a CzdError code, an Error class, or a predicate.
 * @param {{ok(c:any, m?:string):void, equal(a:any, b:any, m?:string):void}} base
 */
export function makeAssert(base) {
  const a = {
    ok: (c, m) => base.ok(c, m),
    equal: (x, y, m) => base.equal(x, y, m),
    same: (x, y, m) => base.ok(x instanceof Uint8Array && same(x, y), `${m || 'bytes differ'} (got ${x?.length} bytes, want ${y?.length})`),
    async rejects(p, want, m) {
      try {
        await (typeof p === 'function' ? p() : p);
      } catch (e) {
        let ok;
        if (typeof want === 'string') ok = e instanceof CzdError && e.code === want;
        else if (typeof want === 'function' && want.prototype instanceof Error) ok = e instanceof want;
        else ok = want(e);
        base.ok(ok, `${m || 'rejects'}: unexpected ${e?.name}${e?.code ? ` [${e.code}]` : ''}: ${e?.message}`);
        return e;
      }
      base.ok(false, `${m || 'rejects'}: resolved`);
      return null;
    },
  };
  return a;
}

async function ids(store) {
  return (await store.list()).map((r) => r.id).sort();
}

/** Builds a vault-stanza container of `data` (no Argon2) and the opts that open it. */
async function vaultContainer(data, chunkExp) {
  const wrapKey = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const vaultId = randomBytes(16);
  const itemId = randomBytes(16);
  const stream = C.encryptStream(pieces(data, [70001]), {
    size: data.length,
    meta: { v: 1, name: 'round trip.bin', type: 'application/octet-stream', size: data.length },
    chunkExp,
    stanzasFor: async (fk) => [await C.vaultStanza(fk, wrapKey, vaultId, itemId)],
  });
  return { id: toHex(itemId), stream, open: { vault: { wrapKey, vaultId, itemId } } };
}

/**
 * The cases. caps: {blob: source has .blob, stage: stage() works, big: run the 20 MiB case}.
 * Each case: async (a, env) with env = {store, advance(ms)}: advance moves the store's clock forward.
 * @returns {Array<{name: string, fn: (a: ReturnType<typeof makeAssert>, env: {store: any, advance(ms: number): void}) => Promise<void>}>}
 */
export function storeCases(caps) {
  const cases = [];
  const add = (name, fn) => cases.push({ name, fn });

  add('write → source (readAt, stream, blob) → list → delete', async (a, { store }) => {
    const id = newId();
    const data = randomBytes(300001);
    a.equal(await store.write(id, pieces(data, [65536, 4099, 1])), data.length, 'write returns the byte count');
    const src = await store.source(id);
    a.equal(src.size, data.length, 'size');
    a.same(await src.readAt(1000, 50), data.subarray(1000, 1050), 'readAt');
    a.same(await src.readAt(0, data.length), data, 'readAt everything');
    a.equal((await src.readAt(data.length, 0)).length, 0, 'readAt(size, 0)');
    await a.rejects(src.readAt(data.length - 1, 2), 'truncated', 'readAt past the end');
    await a.rejects(src.readAt(-1, 1), TypeError, 'readAt negative offset');
    a.same(await collectBytes(src.stream()), data, 'stream()');
    a.same(await collectBytes(src.stream(5, 70000)), data.subarray(5, 70000), 'stream(5, 70000)');
    a.equal((await collectBytes(src.stream(data.length, data.length))).length, 0, 'empty stream range');
    await a.rejects(collectBytes(src.stream(0, data.length + 1)), 'truncated', 'stream past the end');
    if (caps.blob) {
      a.ok(src.blob instanceof Blob, 'source.blob is a Blob');
      a.same(new Uint8Array(await src.blob.arrayBuffer()), data, 'source.blob bytes');
    } else {
      a.equal(src.blob, undefined, 'no source.blob');
    }
    const row = (await store.list()).find((r) => r.id === id);
    a.ok(row && row.size === data.length && typeof row.mtime === 'number', `list row ${JSON.stringify(row)}`);
    await store.delete(id);
    await a.rejects(store.source(id), 'item-file-missing', 'source after delete');
    await store.delete(id);
    a.ok(!(await ids(store)).includes(id), 'gone from list');
  });

  add('write accepts Blob, Uint8Array, sync and async iterables; input is copied', async (a, { store }) => {
    const bytes = randomBytes(5000);
    const [b1, b2, b3, b4] = [newId(), newId(), newId(), newId()];
    await store.write(b1, new Blob([bytes]));
    await store.write(b2, bytes);
    await store.write(b3, [bytes.subarray(0, 10), bytes.subarray(10)]);
    await store.write(b4, pieces(bytes, [777]));
    const want = bytes.slice();
    bytes.fill(0);
    for (const id of [b1, b2, b3, b4]) {
      const src = await store.source(id);
      a.same(await src.readAt(0, src.size), want, `content of ${id}`);
    }
  });

  add('empty container', async (a, { store }) => {
    const id = newId();
    a.equal(await store.write(id, new Uint8Array(0)), 0, 'zero bytes');
    const src = await store.source(id);
    a.equal(src.size, 0, 'size 0');
    a.equal((await src.readAt(0, 0)).length, 0, 'readAt(0, 0)');
    a.equal((await collectBytes(src.stream())).length, 0, 'empty stream');
    a.ok((await ids(store)).includes(id), 'listed');
  });

  add('invalid ids and sources are rejected and leave nothing behind', async (a, { store }) => {
    for (const bad of ['../x', 'ABCDEF0123456789ABCDEF0123456789', 'abc', '', 42, `${newId()}/..`]) {
      await a.rejects(store.write(bad, new Uint8Array(1)), TypeError, `write(${String(bad)})`);
      await a.rejects(store.source(bad), (e) => e instanceof TypeError || e?.code === 'item-file-missing', `source(${String(bad)})`);
    }
    await a.rejects(store.write(newId(), 'not bytes'), TypeError, 'string source');
    await a.rejects(store.write(newId(), null), TypeError, 'null source');
    await a.rejects(store.write(newId(), [new Uint8Array(1), 'x']), TypeError, 'non-byte chunk');
    a.equal((await ids(store)).length, 0, 'nothing listed');
  });

  add('abort mid-write and a pre-aborted signal → aborted, nothing left', async (a, { store }) => {
    const id = newId();
    const ac = new AbortController();
    async function* slow() {
      yield randomBytes(3 * MiB);
      ac.abort();
      yield randomBytes(10);
    }
    await a.rejects(store.write(id, slow(), { signal: ac.signal }), 'aborted', 'mid-write abort');
    await a.rejects(store.source(id), 'item-file-missing', 'no source after abort');
    const pre = new AbortController();
    pre.abort();
    await a.rejects(store.write(newId(), new Uint8Array(1), { signal: pre.signal }), 'aborted', 'pre-aborted write');
    if (caps.stage) await a.rejects(store.stage('x.czd', new Uint8Array(1), { signal: pre.signal }), 'aborted', 'pre-aborted stage');
    a.equal((await ids(store)).length, 0, 'nothing listed');
  });

  add('a failing source propagates its own error and leaves nothing behind', async (a, { store }) => {
    const id = newId();
    const boom = new Error('disk on fire');
    async function* broken() {
      yield randomBytes(2 * MiB + 3);
      throw boom;
    }
    const e = await a.rejects(store.write(id, broken()), (x) => x === boom, 'same error object');
    a.ok(e === boom, 'identity');
    await a.rejects(store.source(id), 'item-file-missing', 'no source');
    a.equal((await ids(store)).length, 0, 'nothing listed');
  });

  add('unknown id → item-file-missing', async (a, { store }) => {
    await a.rejects(store.source(newId()), 'item-file-missing', 'fresh id');
    await store.delete(newId());
  });

  add('writing an existing id replaces it', async (a, { store }) => {
    const id = newId();
    await store.write(id, randomBytes(100000));
    const second = randomBytes(777);
    await store.write(id, second);
    const src = await store.source(id);
    a.equal(src.size, 777, 'new size');
    a.same(await src.readAt(0, 777), second, 'new bytes');
    a.equal((await ids(store)).filter((x) => x === id).length, 1, 'listed once');
  });

  add('concurrent writes of three ids', async (a, { store }) => {
    const items = [0, 1, 2].map((i) => ({ id: newId(), data: randomBytes(MiB * (i + 1) + 1234 * i + 1) }));
    const sizes = await Promise.all(items.map((it, i) => store.write(it.id, pieces(it.data, [65536 + i * 1001, 333]))));
    a.equal(sizes.join(), items.map((it) => it.data.length).join(), 'byte counts');
    for (const it of items) {
      const src = await store.source(it.id);
      a.same(await collectBytes(src.stream()), it.data, `content ${it.id}`);
    }
    a.equal((await ids(store)).join(), items.map((it) => it.id).sort().join(), 'all listed');
  });

  add('sweep: item files without a record after 1 h, staged files after 24 h', async (a, { store, advance }) => {
    const known = newId();
    const orphan = newId();
    await store.write(known, randomBytes(10));
    await store.write(orphan, randomBytes(10));
    let staged = null;
    if (caps.stage) staged = await store.stage('out.czd', randomBytes(20));
    await a.rejects(store.sweep({}), TypeError, 'knownIds is required');
    advance(30 * 60 * 1000);
    const r0 = await store.sweep({ knownIds: [known] });
    a.equal(r0.orphans, 0, 'young orphan kept');
    a.equal(r0.tmp, 0, 'young staged file kept');
    advance(2 * H);
    const r1 = await store.sweep({ knownIds: new Set([known]) });
    a.equal(r1.orphans, 1, 'old orphan swept');
    a.equal(r1.tmp, 0, 'staged file younger than 24 h kept');
    a.equal((await ids(store)).join(), known, 'only the known item is left');
    if (staged) a.equal(staged.size, 20, 'staged File still readable before 24 h');
    advance(25 * H);
    const r2 = await store.sweep({ knownIds: [known] });
    a.equal(r2.orphans, 0, 'known item kept');
    a.equal(r2.tmp, caps.stage ? 1 : 0, 'old staged file swept');
    const r3 = await store.sweep({ knownIds: [known] });
    a.equal(r3.tmp + r3.orphans, 0, 'second sweep finds nothing');
    a.ok((await store.source(known)).size === 10, 'known item readable');
  });

  if (caps.stage) {
    add('stage returns a File named as asked; staged files are not items', async (a, { store }) => {
      const data = randomBytes(5000);
      const f = await store.stage('cz-abcdefgh.czd', pieces(data, [999]));
      a.ok(f instanceof File, 'File');
      a.equal(f.name, 'cz-abcdefgh.czd', 'name');
      a.equal(f.size, 5000, 'size');
      a.same(new Uint8Array(await f.arrayBuffer()), data, 'bytes');
      const g = await store.stage('cz-abcdefgh.czd', new Blob([data.subarray(0, 10)]));
      a.equal(g.size, 10, 'same name again');
      a.same(new Uint8Array(await f.arrayBuffer()), data, 'first staged File unaffected by a same-named stage');
      a.equal((await ids(store)).length, 0, 'not listed as items');
    });
  } else {
    add('stage is not available', async (a, { store }) => {
      await a.rejects(store.stage('x.czd', new Uint8Array(1)), 'internal', 'stage');
    });
  }

  add('estimate', async (a, { store }) => {
    await store.write(newId(), randomBytes(1000));
    const e = await store.estimate();
    a.ok(e === null || (typeof e === 'object' && 'usage' in e && 'quota' in e && 'persisted' in e), `shape ${JSON.stringify(e)}`);
    if (e && e.usage !== null) a.ok(typeof e.usage === 'number' && e.usage >= 0, 'usage');
  });

  add('container round trip: encryptStream → write → openSource → decryptSource', async (a, { store }) => {
    const data = randomBytes(200003);
    const c = await vaultContainer(data, 14);
    await store.write(c.id, c.stream);
    const src = await store.source(c.id);
    const opened = await C.openSource(src, c.open);
    try {
      a.equal(opened.size, data.length, 'meta size');
      a.equal(opened.meta.name, 'round trip.bin', 'meta name');
      a.same(await collectBytes(C.decryptSource(src, opened)), data, 'plaintext');
      a.same(await C.decryptRange(src, opened, 100000, 140000), data.subarray(100000, 140001), 'decryptRange');
    } finally {
      C.release(opened);
    }
  });

  if (caps.big) {
    add('20 MiB in odd-sized chunks: readAt across segment/batch boundaries, stream, blob', async (a, { store }) => {
      const id = newId();
      const data = randomBytes(20 * MiB + 12345);
      a.equal(await store.write(id, pieces(data, [1000003, 65521, 3, 2 * MiB + 1])), data.length, 'bytes');
      const src = await store.source(id);
      a.equal(src.size, data.length, 'size');
      for (const at of [0, 8 * MiB - 3, 16 * MiB - 5, 20 * MiB]) {
        a.same(await src.readAt(at, 11), data.subarray(at, at + 11), `readAt ${at}`);
      }
      a.same(await src.readAt(MiB, 17 * MiB), data.subarray(MiB, 18 * MiB), 'readAt 17 MiB span');
      a.same(await collectBytes(src.stream()), data, 'stream');
      a.same(await collectBytes(src.stream(16 * MiB - 1, 16 * MiB + 1)), data.subarray(16 * MiB - 1, 16 * MiB + 1), 'stream across 16 MiB');
      if (caps.blob) a.same(new Uint8Array(await src.blob.arrayBuffer()), data, 'blob');
    });
  }
  return cases;
}
