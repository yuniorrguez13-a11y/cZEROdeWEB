// Platform bridge: web vs Tauri, pickers, save targets, sharing, storage APIs.
// Owner: C2 (phase 1); G adds the Tauri stream helpers. Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from './errors.js';

/** True inside the Tauri desktop app. */
export const isTauri = globalThis.isTauri === true;

/** Capability checks, evaluated at call time. */
export const caps = {
  savePicker() {
    throw new CzdError('not-implemented');
  },
  dirPicker() {
    throw new CzdError('not-implemented');
  },
  sw() {
    throw new CzdError('not-implemented');
  },
  mobile() {
    throw new CzdError('not-implemented');
  },
  share(files) {
    throw new CzdError('not-implemented');
  },
};

/** navigator.storage wrappers: each resolves null when unavailable and never throws. */
export const storage = {
  async estimate() {
    return null;
  },
  async persisted() {
    return null;
  },
  async persist() {
    return null;
  },
};

/** -> File[] (folder: each File has webkitRelativePath). */
export async function pickFiles({ multiple = true, folder = false } = {}) {
  throw new CzdError('not-implemented');
}

/** FIRST await in the click handler; -> SaveTarget | null (cancel). */
export async function chooseSaveTarget({ name, mime, count = 1 }) {
  throw new CzdError('not-implemented');
}

/** fn: (name, source, {signal}) => Promise<File>; wired by boot to the store. */
export function setStager(fn) {
  throw new CzdError('not-implemented');
}

/** -> boolean; only from its own click. */
export async function shareFiles(files) {
  throw new CzdError('not-implemented');
}

/** -> boolean. */
export async function shareText(text) {
  throw new CzdError('not-implemented');
}

/** Wraps a picker/dialog/share promise for autolock. */
export function suspendHiddenLock(promise) {
  throw new CzdError('not-implemented');
}

/** -> [{name, path, size}]; [] on web. */
export async function listLegacyDesktopCzd() {
  throw new CzdError('not-implemented');
}

/** -> string. */
export async function readLegacyDesktopCzd(path) {
  throw new CzdError('not-implemented');
}

/** Tauri argv/associations + PWA launchQueue; returns off(). */
export function onOpenFiles(cb) {
  throw new CzdError('not-implemented');
}

/** Tauri opener (releases URL only) / web window.open. */
export async function openExternal(url) {
  throw new CzdError('not-implemented');
}

/** Thin Tauri fs wrappers used by TauriFsStore. */
export const tauriFs = {
  async readAt(path, off, len) {
    throw new CzdError('not-implemented');
  },
  async writeStream(path, source, { signal }) {
    throw new CzdError('not-implemented');
  },
  async remove(path) {
    throw new CzdError('not-implemented');
  },
  async list(dir) {
    throw new CzdError('not-implemented');
  },
  async mkdir(path) {
    throw new CzdError('not-implemented');
  },
  async exists(path) {
    throw new CzdError('not-implemented');
  },
  async rename(from, to) {
    throw new CzdError('not-implemented');
  },
  async appDataDir() {
    throw new CzdError('not-implemented');
  },
};

/** invoke stream_register; -> url. */
export async function tauriStreamRegister(opts) {
  throw new CzdError('not-implemented');
}

/** invoke stream_unregister. */
export async function tauriStreamUnregister(token) {
  throw new CzdError('not-implemented');
}

/** invoke stream_clear (lock). */
export async function tauriStreamClear() {
  throw new CzdError('not-implemented');
}
