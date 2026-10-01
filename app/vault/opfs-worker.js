// OPFS writer (module worker; DESIGN §4.2). The only place a FileSystemSyncAccessHandle is opened: writes go
// to the FINAL path, every handle method is awaited (Safari 16.4 returns promises) and write() must report the
// full length. Reads never come here (the page uses getFile().slice()).
// Protocol: {rid, cmd, ...} → {rid, ok:true, result} | {rid, ok:false, error:{name, message}}.
//   probe()                    write + flush + read back a scratch file through a sync access handle → true
//   write-begin(path)          create/truncate path and open its handle → true
//   write-chunk(path, buf)     append buf (transferred ArrayBuffer) → bytes written so far
//   write-commit(path)         flush, close → final size
//   write-abort(path)          close (if open) and remove the file → true
//   delete(path)               remove → existed (boolean)
//   list(dir)                  files of dir → [{name, size, mtime}] ([] when the dir doesn't exist)
// Commands on the same path run one after another, in arrival order; different paths run concurrently.
// Only cZEROde's own paths are accepted (czd/v1/items/<32 hex>.czd, czd/v1/tmp/<32 hex>.tmp).

const FILE_RE = /^czd\/v1\/(?:items\/[0-9a-f]{32}\.czd|tmp\/[0-9a-f]{32}\.tmp)$/;
const DIRS = new Set(['czd/v1/items', 'czd/v1/tmp']);

/** path → {sah, at} for writes in progress. */
const open = new Map();
/** path → tail of that path's command chain. */
const chains = new Map();

function fail(name, message) {
  return new DOMException(message, name);
}

function checkFile(path) {
  if (typeof path !== 'string' || !FILE_RE.test(path)) throw new TypeError('opfs-worker: path not allowed');
}

function split(path) {
  const i = path.lastIndexOf('/');
  return [path.slice(0, i), path.slice(i + 1)];
}

async function dirHandle(dir, create) {
  let h = await navigator.storage.getDirectory();
  for (const part of dir.split('/')) h = await h.getDirectoryHandle(part, { create });
  return h;
}

async function remove(path) {
  const [dir, name] = split(path);
  try {
    await (await dirHandle(dir, false)).removeEntry(name);
    return true;
  } catch (e) {
    if (e && e.name === 'NotFoundError') return false;
    throw e;
  }
}

function hex(n) {
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
}

const commands = {
  async probe() {
    const dir = await dirHandle('czd/v1/tmp', true);
    const name = `${hex(16)}.tmp`;
    const fh = await dir.getFileHandle(name, { create: true });
    let sah = null;
    try {
      sah = await fh.createSyncAccessHandle();
      const data = crypto.getRandomValues(new Uint8Array(64));
      // A short count is how Chromium reports a full origin (see write-chunk).
      if ((await sah.write(data, { at: 0 })) !== data.length) throw fail('QuotaExceededError', 'probe: short write');
      await sah.flush();
      if ((await sah.getSize()) !== data.length) throw fail('UnknownError', 'probe: wrong size');
      const back = new Uint8Array(data.length);
      if ((await sah.read(back, { at: 0 })) !== data.length || !back.every((b, i) => b === data[i])) throw fail('UnknownError', 'probe: read back differs');
      return true;
    } finally {
      if (sah) await Promise.resolve().then(() => sah.close()).catch(() => {});
      await dir.removeEntry(name).catch(() => {});
    }
  },

  async 'write-begin'({ path }) {
    checkFile(path);
    if (open.has(path)) throw fail('InvalidStateError', 'write already in progress');
    const [dirPath, name] = split(path);
    const dir = await dirHandle(dirPath, true);
    let created = false;
    let fh;
    try {
      fh = await dir.getFileHandle(name);
    } catch (e) {
      if (!e || e.name !== 'NotFoundError') throw e;
      fh = await dir.getFileHandle(name, { create: true });
      created = true;
    }
    let sah = null;
    try {
      sah = await fh.createSyncAccessHandle();
      await sah.truncate(0);
    } catch (e) {
      if (sah) await Promise.resolve().then(() => sah.close()).catch(() => {});
      // Remove only a file this call created: an existing one may be another context's write in progress.
      if (created) await dir.removeEntry(name).catch(() => {});
      throw e;
    }
    open.set(path, { sah, at: 0 });
    return true;
  },

  async 'write-chunk'({ path, buf }) {
    const w = open.get(path);
    if (!w) throw fail('InvalidStateError', 'no write in progress');
    if (!(buf instanceof ArrayBuffer)) throw new TypeError('opfs-worker: write-chunk needs an ArrayBuffer');
    const u8 = new Uint8Array(buf);
    const n = await w.sah.write(u8, { at: w.at });
    // Out of quota, Chromium returns a short (or a nonsense, e.g. 2^32 - 8) count instead of throwing.
    if (n !== u8.byteLength) throw fail('QuotaExceededError', `short write: ${n} of ${u8.byteLength} bytes`);
    w.at += n;
    return w.at;
  },

  async 'write-commit'({ path }) {
    const w = open.get(path);
    if (!w) throw fail('InvalidStateError', 'no write in progress');
    await w.sah.flush();
    const size = await w.sah.getSize();
    await w.sah.close();
    open.delete(path);
    return size;
  },

  async 'write-abort'({ path }) {
    checkFile(path);
    const w = open.get(path);
    open.delete(path);
    if (w) await Promise.resolve().then(() => w.sah.close()).catch(() => {});
    await remove(path);
    return true;
  },

  async delete({ path }) {
    checkFile(path);
    if (open.has(path)) throw fail('NoModificationAllowedError', 'write in progress');
    return remove(path);
  },

  async list({ dir }) {
    if (!DIRS.has(dir)) throw new TypeError('opfs-worker: dir not allowed');
    let h;
    try {
      h = await dirHandle(dir, false);
    } catch (e) {
      if (e && e.name === 'NotFoundError') return [];
      throw e;
    }
    const out = [];
    for await (const [name, entry] of h.entries()) {
      if (entry.kind !== 'file') continue;
      try {
        const f = await entry.getFile();
        out.push({ name, size: f.size, mtime: f.lastModified });
      } catch {
        // vanished, or locked by a writer in another context: not ours to judge now
      }
    }
    return out;
  },
};

function reply(rid, promise) {
  promise.then(
    (result) => self.postMessage({ rid, ok: true, result }),
    (e) => self.postMessage({ rid, ok: false, error: { name: (e && e.name) || 'Error', message: String((e && e.message) || e) } }),
  );
}

self.addEventListener('message', (event) => {
  const msg = event.data && typeof event.data === 'object' ? event.data : {};
  const { rid, cmd } = msg;
  const fn = typeof cmd === 'string' && Object.hasOwn(commands, cmd) ? commands[cmd] : null;
  const run = () => (fn ? fn(msg) : Promise.reject(new TypeError(`opfs-worker: unknown command ${String(cmd)}`)));
  if (typeof msg.path !== 'string') {
    reply(rid, Promise.resolve().then(run));
    return;
  }
  const key = msg.path;
  const result = (chains.get(key) ?? Promise.resolve()).then(run);
  const tail = result.then(() => {}, () => {});
  chains.set(key, tail);
  tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  reply(rid, result);
});
