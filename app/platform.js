// Platform bridge (DESIGN §1.7, §2.5, §4.3, §10): web vs Tauri, file pickers, save targets, sharing,
// storage APIs, files opened with the app, and thin Tauri fs wrappers. Owner: C2; G adds the Tauri stream helpers.
// Desktop APIs come from window.__TAURI__ (app.withGlobalTauri); no npm packages.
// Node-importable: browser globals are only touched inside functions.

import { CzdError, toCzdError } from './errors.js';
import { CAPS, RELEASES_URL, TIMES } from './config.js';
import * as state from './state.js';
import { dedupeName, safeFilename, safeMediaType } from './util/format.js';
import { rechunk } from './util/stream.js';
import { randomBytes, toBase32 } from './util/bytes.js';

/** True inside the Tauri desktop app (Tauri defines window.isTauri before any page script runs). */
export const isTauri = globalThis.isTauri === true || (typeof globalThis.__TAURI_INTERNALS__ === 'object' && globalThis.__TAURI_INTERNALS__ !== null);

/** Bytes per Tauri IPC write: raw octet-stream bodies appended with write_all on the Rust side. */
const TAURI_BATCH = 8 * 2 ** 20;
/** Read size for files opened with the app. */
const TAURI_READ = 8 * 2 ** 20;
/** How long after the window regains focus a file picker without change/cancel stops suspending the hidden lock. */
const PICKER_FOCUS_GRACE_MS = 2000;

/** window.__TAURI__ (only under Tauri). */
function T() {
  const t = globalThis.__TAURI__;
  if (!t || !t.core) throw new CzdError('internal', { detail: 'Tauri globals missing' });
  return t;
}

/** "Disk full" as Tauri/Rust reports it (invoke() rejects with the error text): ENOSPC 28, Windows 112/39, EDQUOT. */
const DISK_FULL = /\(os error (28|112|39)\)|no space left on device|not enough space on the disk|disk is full|disk quota exceeded/i;

/**
 * Any error → CzdError: disk-full texts become 'quota-exceeded', the rest go through toCzdError (cause kept;
 * Tauri's plain-string errors end up as 'internal' with the text as cause and detail).
 */
function mapError(e) {
  if (e instanceof CzdError) return e;
  const text = typeof e === 'string' ? e : typeof e?.message === 'string' ? e.message : '';
  if (text && DISK_FULL.test(text)) return new CzdError('quota-exceeded', { cause: e, detail: text });
  const out = toCzdError(e);
  if (typeof e === 'string' && out.detail === undefined) out.detail = e;
  return out;
}

/** Runs a Tauri call; rejections become CzdError (mapError). */
async function tauri(fn) {
  try {
    return await fn(T());
  } catch (e) {
    throw mapError(e);
  }
}

function matches(query) {
  try {
    return typeof globalThis.matchMedia === 'function' && globalThis.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** Desktop Chromium FS Access pickers are used only with a fine pointer (DESIGN §1.7). */
function fsAccess(name) {
  return !isTauri && typeof globalThis[name] === 'function' && matches('(pointer: fine)');
}

/** Capability checks, evaluated at call time. */
export const caps = {
  /** chooseSaveTarget asks where to save ONE output (Tauri dialog or FS Access save picker). */
  savePicker() {
    return isTauri || fsAccess('showSaveFilePicker');
  },
  /** chooseSaveTarget asks for a folder for SEVERAL outputs. */
  dirPicker() {
    return isTauri || fsAccess('showDirectoryPicker');
  },
  /** A service worker controls this page (SW media streaming / downloads possible). */
  sw() {
    return !isTauri && Boolean(globalThis.navigator?.serviceWorker?.controller);
  },
  /** Touch-first device (pointer: coarse): smaller Blob caps, share instead of save. */
  mobile() {
    return matches('(pointer: coarse)');
  },
  /** navigator.share can take these files. */
  share(files) {
    const nav = globalThis.navigator;
    if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false;
    try {
      return nav.canShare({ files: [...files] });
    } catch {
      return false;
    }
  },
};

async function storageCall(name, ...args) {
  try {
    const s = globalThis.navigator?.storage;
    if (!s || typeof s[name] !== 'function') return null;
    const v = await s[name](...args);
    return v ?? null;
  } catch {
    return null;
  }
}

/** navigator.storage wrappers: each resolves null when unavailable (e.g. WebKitGTK) and never throws. */
export const storage = {
  /** -> {usage, quota, …} | null */
  async estimate() {
    return storageCall('estimate');
  },
  /** -> boolean | null */
  async persisted() {
    return storageCall('persisted');
  },
  /** Only from a user click. -> boolean | null */
  async persist() {
    return storageCall('persist');
  },
};

// ───────── hidden-lock suspension (DESIGN §1.6)

let suspended = 0;

/** True while a picker, dialog or share sheet is open (autolock does not count hidden time then). */
export function isPickerPending() {
  return suspended > 0;
}

/**
 * Wraps a picker/dialog/share promise for autolock: state 'picker.pending' is true until it settles
 * (or after TIMES.pickerSuspendMs at the latest). Returns the same promise.
 * @template T
 * @param {Promise<T>} promise
 * @returns {Promise<T>}
 */
export function suspendHiddenLock(promise) {
  suspended++;
  state.set('picker.pending', true);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    suspended = Math.max(0, suspended - 1);
    state.set('picker.pending', suspended > 0);
  };
  const timer = setTimeout(release, TIMES.pickerSuspendMs);
  timer?.unref?.();
  Promise.resolve(promise).then(release, release);
  return promise;
}

// ───────── pickers

/** finish() of a pick whose dialog closed without 'change' or 'cancel' yet (see pickFiles). */
let stalePick = null;

/**
 * Opens the system file picker (hidden <input type=file>, no accept filter). Resolves the chosen files on
 * 'change' and [] on 'cancel'. Call it from a click handler before any await.
 * When the window regains focus and neither event follows within a grace period, the hidden-lock suspension
 * ends (the page is in front again) but the pick stays open: a slow 'change' (a cloud photo being downloaded,
 * iOS transcoding a video) still delivers. Such a pick resolves [] when the next pickFiles() starts, which
 * also covers browsers without the 'cancel' event.
 * @param {{multiple?: boolean, folder?: boolean}} [opts]
 * @returns {Promise<File[]>} with folder: each File has webkitRelativePath
 */
export async function pickFiles({ multiple = true, folder = false } = {}) {
  const doc = globalThis.document;
  if (!doc) return [];
  stalePick?.([]);
  const input = doc.createElement('input');
  input.type = 'file';
  input.multiple = Boolean(multiple || folder);
  if (folder) input.webkitdirectory = true;
  input.hidden = true;
  input.tabIndex = -1;
  const win = globalThis.window;
  let onFocus = null;
  let graceTimer = null;
  let endSuspension;
  const suspension = new Promise((r) => (endSuspension = r));
  const picked = new Promise((resolve) => {
    let done = false;
    const finish = (files) => {
      if (done) return;
      done = true;
      if (stalePick === finish) stalePick = null;
      clearTimeout(graceTimer);
      if (onFocus) win?.removeEventListener('focus', onFocus);
      input.remove();
      endSuspension();
      resolve(files);
    };
    input.addEventListener('change', () => finish([...(input.files ?? [])]));
    input.addEventListener('cancel', () => finish([]));
    if (win && typeof win.addEventListener === 'function') {
      onFocus = () => {
        clearTimeout(graceTimer);
        graceTimer = setTimeout(() => {
          endSuspension();
          stalePick = finish;
        }, PICKER_FOCUS_GRACE_MS);
      };
      win.addEventListener('focus', onFocus);
    }
  });
  (doc.body ?? doc.documentElement).append(input);
  suspendHiddenLock(suspension);
  input.click();
  return picked;
}

// ───────── save targets

let stager = null;

/**
 * fn: (name, source, {signal}) => Promise<File> (the store's staging area); wired by boot.
 * @param {((name: string, source: AsyncIterable<Uint8Array>|Blob, opts: {signal?: AbortSignal}) => Promise<File>)|null} fn
 */
export function setStager(fn) {
  stager = typeof fn === 'function' ? fn : null;
}

const isBlob = (x) => typeof Blob === 'function' && x instanceof Blob;

/** Async iteration over a Blob or an (async) iterable of byte chunks. */
async function* chunksOf(source) {
  if (isBlob(source)) {
    const reader = source.stream().getReader();
    let finished = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          return;
        }
        yield value;
      }
    } finally {
      if (!finished) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } else {
    yield* source;
  }
}

/** One AbortSignal that fires when any of the given ones does. */
function anySignal(signals) {
  const list = signals.filter(Boolean);
  if (list.length <= 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const ctl = new AbortController();
  for (const s of list) {
    if (s.aborted) {
      ctl.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => ctl.abort(s.reason), { once: true });
  }
  return ctl.signal;
}

function checkAborted(signal) {
  if (signal?.aborted) throw new CzdError('aborted', { cause: signal.reason });
}

const basename = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() ?? '';

/**
 * Common SaveTarget plumbing: abort() aborts the write in flight and removes every output this target
 * wrote (outputs are provisional until the caller is done), and later writes reject with 'aborted'.
 */
function makeTarget(kind, count, { writeOne, discard }) {
  const ctl = new AbortController();
  const outputs = [];
  let writes = 0;
  let inflight = null;
  return {
    kind,
    count,
    /**
     * @param {string} name
     * @param {AsyncIterable<Uint8Array>|Blob} source
     * @param {{size?: number, mime?: string, signal?: AbortSignal}} [opts]
     */
    async write(name, source, { size, mime, signal } = {}) {
      checkAborted(ctl.signal);
      if (count <= 1 && writes > 0 && kind !== 'stage') throw new CzdError('internal', { detail: 'single-output target written twice' });
      writes++;
      const sig = anySignal([ctl.signal, signal]);
      const job = writeOne(safeFilename(name), source, { size, mime, signal: sig });
      inflight = job;
      try {
        const res = await job;
        if (ctl.signal.aborted) {
          // abort() raced with the last chunk: this output is discarded here (never listed twice).
          await discard(res.ref).catch(() => {});
          throw new CzdError('aborted');
        }
        outputs.push(res.ref);
        return res.result;
      } catch (e) {
        throw mapError(e);
      } finally {
        if (inflight === job) inflight = null;
      }
    },
    async abort() {
      if (!ctl.signal.aborted) ctl.abort(new CzdError('aborted'));
      if (inflight) await inflight.catch(() => {});
      for (const ref of outputs.splice(0)) await discard(ref).catch(() => {});
    },
  };
}

// FS Access (desktop Chromium)

async function writeToHandle(handle, source, signal) {
  const writable = await handle.createWritable();
  try {
    if (isBlob(source)) {
      checkAborted(signal);
      await writable.write(source);
    } else {
      for await (const chunk of source) {
        checkAborted(signal);
        await writable.write(chunk);
      }
    }
    checkAborted(signal);
    await writable.close();
  } catch (e) {
    await writable.abort().catch(() => {});
    throw e;
  }
}

function fsHandleTarget(handle) {
  return makeTarget('fs-handle', 1, {
    async writeOne(name, source, { signal }) {
      await writeToHandle(handle, source, signal);
      return { ref: handle, result: { name: safeFilename(handle.name), where: handle.name } };
    },
    // The user picked this file: remove it where the browser allows, else truncate it to 0 bytes.
    async discard(h) {
      if (typeof h.remove === 'function') {
        try {
          await h.remove();
          return;
        } catch {
          // fall through
        }
      }
      const w = await h.createWritable();
      await w.close();
    },
  });
}

async function fsEntryExists(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (e) {
    if (e && e.name === 'NotFoundError') return false;
    return true; // a folder of that name, or not readable: don't use the name
  }
}

function fsDirTarget(dir, count) {
  const taken = new Set();
  return makeTarget('fs-dir', count, {
    async writeOne(name, source, { signal }) {
      let candidate = dedupeName(name, taken);
      for (let i = 0; await fsEntryExists(dir, candidate); i++) {
        if (i > 999) throw new CzdError('internal', { detail: 'no free file name' });
        candidate = dedupeName(name, taken);
      }
      const handle = await dir.getFileHandle(candidate, { create: true });
      try {
        await writeToHandle(handle, source, signal);
      } catch (e) {
        await dir.removeEntry(candidate).catch(() => {});
        throw e;
      }
      return { ref: candidate, result: { name: candidate, where: dir.name } };
    },
    discard: (entryName) => dir.removeEntry(entryName),
  });
}

// Tauri (dialog-picked file or folder; the dialog plugin adds exactly that file / the folder's direct
// children to the fs scope, so no `.part` siblings here)

/**
 * Streams `source` into `path`: the first 8 MiB batch creates/truncates the file (or, with createNew, fails
 * if it exists), later batches are appended. `st.created` turns true once the file is ours.
 */
async function tauriWriteAll(path, source, signal, { createNew = false, st = {} } = {}) {
  const fs = T().fs;
  const firstOpts = createNew ? { createNew: true } : undefined;
  let total = 0;
  for await (const piece of rechunk(chunksOf(source), TAURI_BATCH)) {
    checkAborted(signal);
    if (st.created) await fs.writeFile(path, piece, { append: true });
    else {
      await fs.writeFile(path, piece, firstOpts);
      st.created = true;
    }
    total += piece.length;
  }
  checkAborted(signal);
  if (!st.created) {
    await fs.writeFile(path, new Uint8Array(0), firstOpts);
    st.created = true;
  }
  return total;
}

/** Best-effort removal of a provisional output: truncate first so no plaintext survives a failed remove. */
async function tauriDiscard(path) {
  const fs = T().fs;
  await fs.truncate(path, 0).catch(() => {});
  await fs.remove(path).catch(() => {});
}

function tauriFileTarget(path) {
  return makeTarget('tauri-file', 1, {
    async writeOne(name, source, { signal }) {
      // Until the first batch is written the picked file (possibly an existing one the user chose to
      // replace) is untouched: a failure before that must not delete it.
      const st = { created: false };
      try {
        await tauriWriteAll(path, source, signal, { st });
      } catch (e) {
        if (st.created) await tauriDiscard(path);
        throw e;
      }
      return { ref: path, result: { name: safeFilename(basename(path)) || name, where: path } };
    },
    discard: tauriDiscard,
  });
}

function tauriDirTarget(dir, count) {
  const taken = new Set();
  return makeTarget('tauri-dir', count, {
    async writeOne(name, source, { signal }) {
      const fs = T().fs;
      let candidate = dedupeName(name, taken);
      let path = await T().path.join(dir, candidate);
      for (let i = 0; await fs.exists(path); i++) {
        if (i > 999) throw new CzdError('internal', { detail: 'no free file name' });
        candidate = dedupeName(name, taken);
        path = await T().path.join(dir, candidate);
      }
      // createNew: a file that appeared after the exists() check is never overwritten (the write fails).
      const st = { created: false };
      try {
        await tauriWriteAll(path, source, signal, { createNew: true, st });
      } catch (e) {
        if (st.created) await tauriDiscard(path);
        throw e;
      }
      return { ref: path, result: { name: candidate, where: dir } };
    },
    discard: tauriDiscard,
  });
}

// Staging (mobile, Firefox, Safari, or when the picker is not allowed): the caller offers Save/Share per output.

/** First 8 bytes of a czd2 container (§3.3) and of a .czb backup (§3.7): 89 'C' 'Z' 'D'|'B' 0D 0A 1A 0A. */
const CONTAINER_MAGICS = [
  [0x89, 0x43, 0x5a, 0x44, 0x0d, 0x0a, 0x1a, 0x0a],
  [0x89, 0x43, 0x5a, 0x42, 0x0d, 0x0a, 0x1a, 0x0a],
];

const asBytes = (c) => (c instanceof Uint8Array ? c : ArrayBuffer.isView(c) ? new Uint8Array(c.buffer, c.byteOffset, c.byteLength) : new Uint8Array(c));

/**
 * Reads chunks of `source` until at least `n` bytes (or the end) are buffered.
 * @returns {Promise<{head: Uint8Array, rest: AsyncIterable<Uint8Array>}>} rest yields EVERY chunk, peeked ones included
 */
async function peekBytes(source, n) {
  const it = source[Symbol.asyncIterator] ? source[Symbol.asyncIterator]() : source[Symbol.iterator]();
  const buffered = [];
  let have = 0;
  let ended = false;
  while (have < n) {
    const r = await it.next();
    if (r.done) {
      ended = true;
      break;
    }
    const c = asBytes(r.value);
    buffered.push(c);
    have += c.length;
  }
  const head = new Uint8Array(Math.min(n, have));
  let o = 0;
  for (const c of buffered) {
    if (o >= head.length) break;
    const take = c.subarray(0, head.length - o);
    head.set(take, o);
    o += take.length;
  }
  async function* rest() {
    let finished = ended;
    try {
      yield* buffered;
      while (!finished) {
        const r = await it.next();
        if (r.done) finished = true;
        else yield r.value;
      }
    } finally {
      if (!finished) await it.return?.();
    }
  }
  return { head, rest: rest() };
}

const isContainerHead = (head) => head.length === 8 && CONTAINER_MAGICS.some((m) => m.every((b, i) => head[i] === b));

function stageTarget(count) {
  const cap = () => (caps.mobile() ? CAPS.blobMobile : CAPS.blobDesktop);
  return makeTarget('stage', count, {
    async writeOne(name, source, { mime, signal }) {
      const type = mime ? safeMediaType(mime) : '';
      let file;
      if (isBlob(source)) {
        file = new File([source], name, { type });
      } else {
        // The store's staging area (OPFS tmp) is on disk: only cZEROde containers (Send outputs, backups) may
        // go there. Anything else (decrypted saves) is plaintext and stays an in-memory Blob up to the cap
        // (DESIGN §4.2 "never store plaintext", §5.1).
        const { head, rest } = await peekBytes(source, 8);
        if (stager && isContainerHead(head)) {
          file = await stager(name, rest, { signal });
          if (!(file instanceof Blob)) throw new CzdError('internal', { detail: 'stager returned no File' });
          if (!(file instanceof File) || file.name !== name || (type && file.type !== type)) file = new File([file], name, { type });
        } else {
          const parts = [];
          let total = 0;
          const max = cap();
          for await (const chunk of rest) {
            checkAborted(signal);
            total += chunk.byteLength;
            if (total > max) throw new CzdError('quota-exceeded', { detail: 'staging limit' });
            parts.push(chunk);
          }
          file = new File(parts, name, { type });
        }
      }
      checkAborted(signal);
      return { ref: file, result: { name, staged: file } };
    },
    async discard() {
      // Staged Files are dropped with their references; store staging is swept after 24 h.
    },
  });
}

/**
 * Where to save `count` outputs (DESIGN §1.7). Must be the FIRST await of a click handler: the picker opens
 * synchronously. Tauri: dialog.save (1 output) / folder dialog (several). Desktop Chromium with a fine
 * pointer: showSaveFilePicker / showDirectoryPicker. Otherwise (or when the picker is refused with
 * SecurityError/NotAllowedError) a 'stage' target. Cancel → null.
 * @param {{name: string, mime?: string, count?: number}} opts (mime is not needed to pick a target)
 * @returns {Promise<import('./types.js').SaveTarget|null>}
 */
export async function chooseSaveTarget({ name, count = 1 } = {}) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const suggested = safeFilename(name);
  if (isTauri) {
    const dialog = T().dialog;
    try {
      if (n === 1) {
        const path = await suspendHiddenLock(dialog.save({ defaultPath: suggested }));
        return path ? tauriFileTarget(String(path)) : null;
      }
      const dir = await suspendHiddenLock(dialog.open({ directory: true, multiple: false, recursive: false }));
      return dir ? tauriDirTarget(String(Array.isArray(dir) ? dir[0] : dir), n) : null;
    } catch (e) {
      throw mapError(e);
    }
  }
  const single = n === 1;
  if (single ? fsAccess('showSaveFilePicker') : fsAccess('showDirectoryPicker')) {
    try {
      if (single) {
        const handle = await suspendHiddenLock(globalThis.showSaveFilePicker({ suggestedName: suggested, id: 'czeroode-save' }));
        return fsHandleTarget(handle);
      }
      const dir = await suspendHiddenLock(globalThis.showDirectoryPicker({ mode: 'readwrite', id: 'czeroode-folder' }));
      return fsDirTarget(dir, n);
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      if (!(e && (e.name === 'SecurityError' || e.name === 'NotAllowedError'))) throw mapError(e);
      // No user activation left (or pickers blocked): stage instead.
    }
  }
  return stageTarget(n);
}

// ───────── sharing

/**
 * navigator.share({files}); only call from the Share button's own click.
 * @param {File[]} files
 * @returns {Promise<boolean>} false when unavailable or cancelled
 */
export async function shareFiles(files) {
  const list = [...(files ?? [])];
  if (!list.length || !caps.share(list)) return false;
  try {
    await suspendHiddenLock(globalThis.navigator.share({ files: list }));
    return true;
  } catch (e) {
    if (e && e.name === 'AbortError') return false;
    if (e && e.name === 'NotAllowedError') throw new CzdError('picker-needs-gesture', { cause: e });
    throw new CzdError('share-unavailable', { cause: e });
  }
}

/**
 * navigator.share({text}).
 * @param {string} text
 * @returns {Promise<boolean>} false when unavailable or cancelled
 */
export async function shareText(text) {
  const nav = globalThis.navigator;
  if (!nav || typeof nav.share !== 'function') return false;
  const data = { text: String(text) };
  try {
    if (typeof nav.canShare === 'function' && !nav.canShare(data)) return false;
    await suspendHiddenLock(nav.share(data));
    return true;
  } catch (e) {
    if (e && e.name === 'AbortError') return false;
    if (e && e.name === 'NotAllowedError') throw new CzdError('picker-needs-gesture', { cause: e });
    throw new CzdError('share-unavailable', { cause: e });
  }
}

// ───────── Tauri fs wrappers (paths are absolute; the fs scope decides what is reachable)

async function readExactly(fh, off, len) {
  const out = new Uint8Array(len);
  if (len === 0) return out;
  if (off > 0) await fh.seek(off, 0 /* SeekMode.Start */);
  let got = 0;
  while (got < len) {
    const n = await fh.read(out.subarray(got));
    if (n === null || n === 0) break;
    got += n;
  }
  if (got !== len) throw new CzdError('truncated');
  return out;
}

/** Largest single readAt (a stored chunk is ≤ 16 MiB + 16; this only guards against absurd lengths). */
const READ_AT_MAX = 2 ** 30;

/** Thin Tauri fs wrappers used by TauriFsStore (and the legacy/opened-file readers). They reject with CzdError
 * only ('quota-exceeded' for a full disk, else 'internal' with the Tauri error text as cause/detail). */
export const tauriFs = {
  /** Exactly `len` bytes at `off` (open + seek + read); CzdError('truncated') past EOF. */
  async readAt(path, off, len) {
    if (!Number.isSafeInteger(off) || !Number.isSafeInteger(len) || off < 0 || len < 0 || len > READ_AT_MAX) {
      throw new CzdError('internal', { detail: `readAt(): bad range ${off}+${len}` });
    }
    return tauri(async (t) => {
      const fh = await t.fs.open(path, { read: true });
      try {
        return await readExactly(fh, off, len);
      } finally {
        await fh.close().catch(() => {});
      }
    });
  },
  /**
   * Creates/truncates `path` and streams `source` into it in 8 MiB appends; on any error the file is removed.
   * @returns {Promise<number>} bytes written
   */
  async writeStream(path, source, { signal } = {}) {
    try {
      return await tauriWriteAll(path, source, signal);
    } catch (e) {
      await Promise.resolve()
        .then(() => T().fs.remove(path))
        .catch(() => {});
      throw mapError(e);
    }
  },
  async remove(path) {
    await tauri((t) => t.fs.remove(path));
  },
  /**
   * Size and modification time of one file (plugin-fs stat; capability fs:allow-stat). TauriFsStore uses it to
   * size an item without listing the whole folder. Rejects CzdError ('internal') when the file is missing.
   * @param {string} path
   * @returns {Promise<{size: number, mtime: number|null}>}
   */
  async stat(path) {
    return tauri(async (t) => {
      const st = await t.fs.stat(path);
      const size = Number(st?.size);
      if (!Number.isSafeInteger(size) || size < 0) throw new CzdError('internal', { detail: `stat(): bad size for ${basename(path)}` });
      const ms = st?.mtime ? new Date(st.mtime).getTime() : NaN;
      return { size, mtime: Number.isFinite(ms) ? ms : null };
    });
  },
  /**
   * Directory entries: [{name, path, isFile, isDirectory, size, mtime}] (size/mtime via stat for files
   * unless {stat:false}).
   */
  async list(dir, { stat = true } = {}) {
    return tauri(async (t) => {
      const out = [];
      for (const ent of await t.fs.readDir(dir)) {
        const path = await t.path.join(dir, ent.name);
        const item = { name: ent.name, path, isFile: Boolean(ent.isFile), isDirectory: Boolean(ent.isDirectory), size: null, mtime: null };
        if (stat && item.isFile) {
          try {
            const st = await t.fs.stat(path);
            item.size = st.size;
            item.mtime = st.mtime ? new Date(st.mtime).getTime() : null;
          } catch {
            // vanished or unreadable: keep the entry without size
          }
        }
        out.push(item);
      }
      return out;
    });
  },
  async mkdir(path) {
    await tauri((t) => t.fs.mkdir(path, { recursive: true }));
  },
  async exists(path) {
    return tauri((t) => t.fs.exists(path));
  },
  async rename(from, to) {
    await tauri((t) => t.fs.rename(from, to));
  },
  /** Absolute <AppData> ({data_dir}/com.czeroode.app). */
  async appDataDir() {
    return tauri((t) => t.path.appDataDir());
  },
  /** Joins path segments with the platform separator. */
  async join(...parts) {
    return tauri((t) => t.path.join(...parts));
  },
};

/** Reads an absolute path into a File (8 MiB reads collected into Blob parts). */
async function tauriFileFromPath(path) {
  const t = T();
  const fh = await t.fs.open(path, { read: true });
  const parts = [];
  let mtime = Date.now();
  try {
    try {
      const st = await fh.stat();
      if (st.mtime) mtime = new Date(st.mtime).getTime();
    } catch {
      // keep now
    }
    for (;;) {
      const buf = new Uint8Array(TAURI_READ);
      const n = await fh.read(buf);
      if (n === null || n === 0) break;
      parts.push(n === buf.length ? buf : buf.slice(0, n));
    }
  } finally {
    await fh.close().catch(() => {});
  }
  return new File(parts, safeFilename(basename(path)), { lastModified: mtime });
}

// ───────── legacy desktop .czd ($APPDATA/vault/*.czd, Tauri only)

/** -> [{name, path, size}] of the Tauri 1 app's .czd files; [] on web or when the folder doesn't exist. */
export async function listLegacyDesktopCzd() {
  if (!isTauri) return [];
  const dir = await tauriFs.join(await tauriFs.appDataDir(), 'vault');
  if (!(await tauriFs.exists(dir))) return [];
  const entries = await tauriFs.list(dir);
  return entries
    .filter((e) => e.isFile && /\.czd$/i.test(e.name))
    .map((e) => ({ name: safeFilename(e.name), path: e.path, size: e.size ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Old desktop .czd files are UTF-8 text (JSON). */
export async function readLegacyDesktopCzd(path) {
  if (!isTauri) throw new CzdError('internal', { detail: 'desktop only' });
  const bytes = await tauri((t) => t.fs.readFile(path));
  return new TextDecoder('utf-8').decode(bytes);
}

// ───────── files opened with the app
// One source per page, fanned out to every subscriber: the Rust queue (take_open_files) and launchQueue can
// each be consumed only once, so separate onOpenFiles() calls must not compete for them.

const openSubs = new Set();
/** Tauri: the 'open-files' unlisten function (or a pending listen), while anyone subscribes. */
let openListen = null;
let openChain = Promise.resolve();
let launchConsumerSet = false;

function deliverOpened(files) {
  if (!files.length) return;
  for (const sub of [...openSubs]) {
    try {
      sub.cb([...files]);
    } catch (e) {
      globalThis.console?.warn?.('[platform] open-files subscriber failed', e);
    }
  }
}

/** Drains the Rust queue; serialized so a burst of events can't deliver files out of order. */
function drainOpenFiles() {
  openChain = openChain
    .then(async () => {
      if (!openSubs.size) return; // leave the paths queued in Rust for the next subscriber
      const paths = await T().core.invoke('take_open_files');
      const files = [];
      for (const p of Array.isArray(paths) ? paths : []) {
        try {
          files.push(await tauriFileFromPath(String(p)));
        } catch (e) {
          globalThis.console?.warn?.('[platform] could not read an opened file', e);
        }
      }
      deliverOpened(files);
    })
    .catch((e) => globalThis.console?.warn?.('[platform] take_open_files failed', e));
  return openChain;
}

function startTauriOpenFiles() {
  if (openListen) return;
  const pending = Promise.resolve()
    .then(() => T().event.listen('open-files', () => drainOpenFiles()))
    .then((un) => {
      if (openListen !== pending) {
        un(); // everyone unsubscribed (or a newer listener exists) before listen() resolved
        return;
      }
      openListen = un;
      drainOpenFiles(); // paths queued before the listener existed (initial argv, macOS launch)
    })
    .catch((e) => {
      if (openListen === pending) openListen = null;
      globalThis.console?.warn?.('[platform] open-files listener failed', e);
    });
  openListen = pending;
}

function stopTauriOpenFiles() {
  const l = openListen;
  openListen = null;
  if (typeof l === 'function') l();
}

function startLaunchQueue() {
  const lq = globalThis.launchQueue;
  if (launchConsumerSet || !lq || typeof lq.setConsumer !== 'function') return;
  launchConsumerSet = true;
  lq.setConsumer(async (params) => {
    const files = [];
    for (const handle of params?.files ?? []) {
      try {
        if (handle.kind === 'file') files.push(await handle.getFile());
      } catch (e) {
        globalThis.console?.warn?.('[platform] launch file unreadable', e);
      }
    }
    deliverOpened(files);
  });
}

/**
 * Files the app is asked to open: Tauri file associations/argv/second instance ('open-files' event +
 * take_open_files, each path read into a File) or the PWA launchQueue. Every subscriber gets each batch
 * (File[], never empty). Under Tauri, paths that arrive while nobody subscribes stay queued in Rust.
 * @param {(files: File[]) => void} cb
 * @returns {() => void} off
 */
export function onOpenFiles(cb) {
  if (typeof cb !== 'function') throw new CzdError('internal', { detail: 'onOpenFiles(): cb must be a function' });
  const sub = { cb };
  openSubs.add(sub);
  if (isTauri) startTauriOpenFiles();
  else startLaunchQueue();
  return () => {
    if (!openSubs.delete(sub)) return;
    if (isTauri && !openSubs.size) stopTauriOpenFiles();
  };
}

/**
 * Opens a web page outside the app. Tauri: only config.RELEASES_URL (opener scope); web: http(s) URLs in a
 * new tab without opener/referrer.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function openExternal(url) {
  const href = String(url);
  if (isTauri) {
    if (href !== RELEASES_URL) throw new CzdError('internal', { detail: 'URL not allowed' });
    await tauri((t) => t.opener.openUrl(href));
    return true;
  }
  let parsed;
  try {
    parsed = new URL(href);
  } catch {
    throw new CzdError('internal', { detail: 'bad URL' });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new CzdError('internal', { detail: 'URL not allowed' });
  // With noopener, window.open returns null even when the tab opened.
  globalThis.window?.open?.(parsed.href, '_blank', 'noopener,noreferrer');
  return true;
}

// ───────── Tauri czstream helpers (DESIGN §5.3; src-tauri/src/stream.rs)
// The page registers an opened vault item; Rust derives the payload key from the raw fileKey, reads
// $APPDATA/vault2/items/<id>.czd and answers Range requests on czstream://localhost/<token> (Windows:
// http(s)://czstream.localhost/<token>). Rust re-validates every value and checks the item file's length and
// header before accepting; on lock (state.purge) and on page reload every registration is dropped.
// Linux (WebKitGTK) cannot play media from a custom scheme: Rust refuses there, and after the first refusal
// tauriStreamRegister rejects 'unsupported-media' without asking again.

/** 16 random bytes, RFC 4648 base32 without padding (sw-stream.js uses the same shape). */
const STREAM_TOKEN = /^[A-Z2-7]{26}$/;
const STREAM_ITEM_ID = /^[0-9a-f]{32}$/;
/** Start of Rust's refusal where the webview can't play custom-scheme media (stream.rs UNSUPPORTED). */
const STREAM_UNSUPPORTED = 'czstream: unsupported:';
let streamUnsupported = false;
/**
 * Bumped by tauriStreamClear. Rust reads its own clear epoch inside the async stream_register, on a runtime
 * thread, so a stream_clear sent after the register can still run before it and the registration would then
 * outlive the lock: a register that saw a clear (or an unregister of its token) while in flight undoes itself.
 */
let streamClears = 0;
/** token → {cancelled} for registrations in flight. */
const streamPending = new Map();

function streamArgError(what) {
  return new CzdError('internal', { detail: `tauriStreamRegister(): bad ${what}` });
}

const isCount = (n) => Number.isSafeInteger(n) && n >= 0;

/** The stream_register arguments (camelCase, as Tauri maps them to the Rust parameters); throws CzdError. */
function streamRegisterArgs(opts) {
  if (!opts || typeof opts !== 'object') throw streamArgError('options');
  const { id, fileKey, streamSalt, headerLen, chunkExp, size, paddedSize, mime } = opts;
  const token = opts.token === undefined ? toBase32(randomBytes(16)) : opts.token;
  if (typeof token !== 'string' || !STREAM_TOKEN.test(token)) throw streamArgError('token');
  if (typeof id !== 'string' || !STREAM_ITEM_ID.test(id)) throw streamArgError('id');
  if (!(fileKey instanceof Uint8Array) || fileKey.length !== 32) throw streamArgError('fileKey');
  if (!(streamSalt instanceof Uint8Array) || streamSalt.length !== 16) throw streamArgError('streamSalt');
  if (!isCount(headerLen)) throw streamArgError('headerLen');
  if (!Number.isInteger(chunkExp) || chunkExp < 12 || chunkExp > 24) throw streamArgError('chunkExp');
  if (!isCount(size) || !isCount(paddedSize) || size > paddedSize) throw streamArgError('size');
  return {
    token,
    id,
    // Tauri IPC is JSON: plain number arrays (wiped after the call; Rust keeps only the derived payload key).
    fileKey: Array.from(fileKey),
    streamSalt: Array.from(streamSalt),
    headerLen,
    chunkExp,
    size,
    paddedSize,
    mime: safeMediaType(typeof mime === 'string' ? mime : ''),
  };
}

/** A token, or the czstream URL tauriStreamRegister returned (its last path segment). */
function streamToken(tokenOrUrl) {
  const s = typeof tokenOrUrl === 'string' ? tokenOrUrl : '';
  if (STREAM_TOKEN.test(s)) return s;
  const last = s.split(/[?#]/, 1)[0].split('/').pop();
  if (s.includes('czstream') && STREAM_TOKEN.test(last)) return last;
  throw new CzdError('internal', { detail: 'tauriStreamUnregister(): bad token' });
}

/**
 * Registers an opened vault item (no bundle entries) for desktop streaming and returns its URL for
 * <video>/<audio>. opts: {token?, id, fileKey, streamSalt, headerLen, chunkExp, size, paddedSize, mime} where
 * id is the item id (32 hex), fileKey/streamSalt/headerLen/chunkExp/size/paddedSize come from the Opened, and
 * mime is passed through safeMediaType. Without `token` a fresh one is drawn (unregister with the URL then).
 * Rejects CzdError 'unsupported-media' where the webview can't stream (Linux), else 'internal' (Rust's reason in
 * detail) for invalid values, a missing or different item file, or outside Tauri; callers fall back to a Blob.
 * Rejects 'aborted' (silent, isCancel) when tauriStreamClear or an unregister of this token ran meanwhile.
 * @param {{token?: string, id: string, fileKey: Uint8Array, streamSalt: Uint8Array, headerLen: number, chunkExp: number, size: number, paddedSize: number, mime: string}} opts
 * @returns {Promise<string>} czstream URL (convertFileSrc(token, 'czstream'))
 */
export async function tauriStreamRegister(opts) {
  if (!isTauri) throw new CzdError('internal', { detail: 'desktop only' });
  if (streamUnsupported) throw new CzdError('unsupported-media', { detail: 'czstream' });
  const args = streamRegisterArgs(opts);
  const { token } = args;
  if (streamPending.has(token)) {
    args.fileKey.fill(0);
    throw new CzdError('internal', { detail: 'tauriStreamRegister(): token already being registered' });
  }
  const pending = { cancelled: false };
  const clears = streamClears;
  streamPending.set(token, pending);
  try {
    // The URL first (synchronously, so the IPC still leaves in call order): nothing can fail between a
    // successful register and the caller holding its URL.
    let url;
    try {
      url = String(T().core.convertFileSrc(token, 'czstream'));
    } catch (e) {
      throw mapError(e);
    }
    await tauri((t) => t.core.invoke('stream_register', args));
    if (pending.cancelled || clears !== streamClears) {
      await tauri((t) => t.core.invoke('stream_unregister', { token })).catch(() => {});
      throw new CzdError('aborted', { detail: 'czstream: cleared or unregistered while registering' });
    }
    return url;
  } catch (e) {
    if (typeof e.detail === 'string' && e.detail.startsWith(STREAM_UNSUPPORTED)) {
      streamUnsupported = true;
      throw new CzdError('unsupported-media', { cause: e, detail: e.detail });
    }
    throw e;
  } finally {
    args.fileKey.fill(0);
    streamPending.delete(token);
  }
}

/**
 * Drops one registration (a token or the URL from tauriStreamRegister). Unknown tokens are fine; no-op on web.
 * A registration of that token still in flight is dropped as soon as it lands (tauriStreamRegister rejects 'aborted').
 * @param {string} token
 */
export async function tauriStreamUnregister(token) {
  if (!isTauri) return;
  const tok = streamToken(token);
  const pending = streamPending.get(tok);
  if (pending) pending.cancelled = true;
  await tauri((t) => t.core.invoke('stream_unregister', { token: tok }));
}

/** Linux desktop: WebKitGTK can't play media from a custom URI scheme (stream.rs refuses there; DESIGN §12). */
function linuxWebview() {
  const nav = globalThis.navigator;
  const s = `${nav?.userAgentData?.platform ?? ''} ${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`;
  return /linux/i.test(s) && !/android/i.test(s);
}

/**
 * Whether desktop czstream playback is available: under Tauri, not on Linux, and Rust hasn't refused a
 * registration yet. media.playLimit uses it for the import-time "too big to play on this device" warning.
 * Extra over §10.
 * @returns {boolean}
 */
export function tauriStreamAvailable() {
  return isTauri && !streamUnsupported && !linuxWebview();
}

/** Drops every registration (lock; state.purge calls it), also those still in flight. No-op on web. */
export async function tauriStreamClear() {
  if (!isTauri) return;
  streamClears += 1;
  await tauri((t) => t.core.invoke('stream_clear'));
}
