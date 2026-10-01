// Test doubles for app/platform.js: an in-memory window.__TAURI__ (fs/path/dialog/core/event/opener with the
// call shapes of Tauri 2 + plugin-fs 2.6) and small helpers. Paths are POSIX-style.

/** Async iterable over byte chunks (optionally failing after `failAfter` chunks). */
export async function* chunks(list, { failAfter = Infinity } = {}) {
  let i = 0;
  for (const c of list) {
    if (i++ >= failAfter) throw new Error('source failed');
    yield c;
  }
}

/** n bytes with a recognizable pattern. */
export function pattern(n, seed = 1) {
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i++) u[i] = (i * 31 + seed) & 0xff;
  return u;
}

export function concatBytes(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * In-memory Tauri. `fake.files` (path → Uint8Array), `fake.dirs`, `fake.calls` (recorded fs calls),
 * `fake.saveAnswer` / `fake.openAnswer` (dialog results), `fake.pending` (take_open_files queue),
 * `fake.emit(event)`, `fake.failWrite(path, info) → boolean|string` (inject write errors; a string is thrown
 * as-is, like invoke() rejections), `fake.opened` (URLs).
 */
export function fakeTauri({ appData = '/data/com.czeroode.app' } = {}) {
  const files = new Map();
  const dirs = new Set(['/', '/data', appData]);
  const calls = [];
  const listeners = new Map();
  const parent = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
  const fake = {
    files,
    dirs,
    calls,
    appData,
    saveAnswer: null,
    openAnswer: null,
    pending: [],
    opened: [],
    dialogCalls: [],
    failWrite: () => false,
    emit(name, payload) {
      for (const fn of listeners.get(name) ?? []) fn({ event: name, payload });
    },
    listenerCount: (name) => (listeners.get(name) ?? new Set()).size,
  };

  class FileHandle {
    constructor(path) {
      this.path = path;
      this.pos = 0;
    }
    async read(buf) {
      const data = files.get(this.path);
      if (buf.byteLength === 0) return 0;
      if (this.pos >= data.length) return null;
      const n = Math.min(buf.length, data.length - this.pos, 5 * 2 ** 20); // short reads happen
      buf.set(data.subarray(this.pos, this.pos + n));
      this.pos += n;
      return n;
    }
    async seek(off, whence) {
      if (whence !== 0) throw new Error('only SeekMode.Start in tests');
      this.pos = off;
      return off;
    }
    async stat() {
      return { size: files.get(this.path).length, mtime: new Date(1700000000000), isFile: true };
    }
    async close() {
      calls.push(['close', this.path]);
    }
  }

  const fs = {
    async writeFile(path, data, opts) {
      calls.push(['writeFile', path, data.length, opts ?? null]);
      if (!dirs.has(parent(path))) throw new Error(`No such directory: ${parent(path)}`);
      const fail = fake.failWrite(path, { opts, length: data.length });
      // Tauri's invoke() rejects with the Rust error as a plain string: a string answer is thrown as-is.
      if (typeof fail === 'string') throw fail;
      if (fail) throw new Error(`injected write failure: ${path}`);
      if (opts?.createNew && files.has(path)) throw new Error(`File exists (os error 17): ${path}`);
      if (opts?.append) {
        if (!files.has(path)) throw new Error(`No such file: ${path}`);
        files.set(path, concatBytes([files.get(path), data]));
      } else {
        files.set(path, data.slice());
      }
    },
    async open(path, opts) {
      calls.push(['open', path, opts]);
      if (!files.has(path)) throw new Error(`No such file: ${path}`);
      return new FileHandle(path);
    },
    async exists(path) {
      return files.has(path) || dirs.has(path);
    },
    async remove(path) {
      calls.push(['remove', path]);
      if (!files.delete(path)) throw new Error(`No such file: ${path}`);
    },
    async truncate(path, len) {
      calls.push(['truncate', path, len]);
      if (!files.has(path)) throw new Error(`No such file: ${path}`);
      files.set(path, files.get(path).slice(0, len));
    },
    async readDir(dir) {
      if (!dirs.has(dir)) throw new Error(`No such directory: ${dir}`);
      const out = [];
      for (const p of files.keys()) if (parent(p) === dir) out.push({ name: p.slice(dir.length + 1), isFile: true, isDirectory: false, isSymlink: false });
      for (const d of dirs) if (d !== dir && parent(d) === dir) out.push({ name: d.slice(dir.length + 1), isFile: false, isDirectory: true, isSymlink: false });
      return out;
    },
    async stat(path) {
      if (!files.has(path)) throw new Error(`No such file: ${path}`);
      return { size: files.get(path).length, mtime: new Date(1700000000000), isFile: true };
    },
    async mkdir(path, opts) {
      calls.push(['mkdir', path, opts]);
      dirs.add(path);
    },
    async rename(from, to) {
      calls.push(['rename', from, to]);
      files.set(to, files.get(from));
      files.delete(from);
    },
    async readFile(path) {
      if (!files.has(path)) throw new Error(`No such file: ${path}`);
      return files.get(path).slice();
    },
  };

  globalThis.__TAURI__ = {
    fs,
    path: {
      async join(...parts) {
        return parts.join('/').replace(/\/+/g, '/');
      },
      async appDataDir() {
        return appData;
      },
    },
    dialog: {
      async save(opts) {
        fake.dialogCalls.push(['save', opts]);
        return fake.saveAnswer;
      },
      async open(opts) {
        fake.dialogCalls.push(['open', opts]);
        return fake.openAnswer;
      },
    },
    core: {
      async invoke(cmd) {
        if (cmd === 'take_open_files') return fake.pending.splice(0);
        throw new Error(`unknown command ${cmd}`);
      },
    },
    event: {
      async listen(name, fn) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(fn);
        return () => listeners.get(name).delete(fn);
      },
    },
    opener: {
      async openUrl(url) {
        fake.opened.push(url);
      },
    },
  };
  globalThis.isTauri = true;
  return fake;
}
