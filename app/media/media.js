// Decrypted media for the viewer and the player (DESIGN §5): playable URLs (Blob, service-worker stream or Tauri
// czstream), text/note previews, decrypted Blobs/Files, provisional saves into a SaveTarget, single-use SW
// downloads, and the lock-time cleanup. Owner: F.
// Ownership: a DecryptSource obtained from ViewerItem.getSource() belongs to whoever called getSource (viewer,
// player); they hand it back with disposeSource(). Handles returned here are released with handle.release() or,
// all at once, by releaseAll() (registered with state.onPurge).
// Node-importable: browser globals are only touched inside functions.

import { CzdError, isCancel, toCzdError } from '../errors.js';
import { CAPS, TIMES } from '../config.js';
import * as state from '../state.js';
import * as platform from '../platform.js';
import { isIOS } from '../pwa.js';
import { decryptSource, release as releaseOpened } from '../crypto/container.js';
import { randomBytes, toBase32, utf8 } from '../util/bytes.js';
import { extOf, kindOf, mimeFromExt, safeFilename, safeMediaType } from '../util/format.js';
import { abortable, collect, fileChunks, withProgress } from '../util/stream.js';
import { h } from '../util/dom.js';

const MODES = new Set(['image', 'audio', 'video']);
/** Notes are exported as their body only (DESIGN §11). */
const NOTE_FILE_TYPE = 'text/plain;charset=utf-8';
/** Largest note decrypted for the editor or an export. */
const NOTE_MAX = 16 * 2 ** 20;
/** Decrypted pieces are gathered into Blobs of about this size (the browser may page them out of the JS heap). */
const BLOB_GROUP = 16 * 2 ** 20;
const SW_REPLY_MS = 5000;
const SW_READY_MS = 2000;
const DOWNLOAD_START_MS = 15000;
/** A streamed URL with no Blob fallback (above the cap) gets this many times TIMES.mediaFallbackMs. */
const STREAM_PATIENCE = 6;
const ITEM_ID = /^[0-9a-f]{32}$/;

/** Every URL handed out and not yet released. */
const handles = new Set();
/** Live SW media tokens → their register payload (re-sent when the worker asks 'need'). */
const live = new Map();
/** Pending SW downloads: token → watcher. */
const downloads = new Map();
/** One background decrypt for the next item (player): {src, ctl, promise}. */
let prefetched = null;
let swHooked = false;

// ───────── sources

/**
 * Name/type/size of a DecryptSource (names sanitized). Throws TypeError for anything else.
 * @param {import('../types.js').DecryptSource} src
 * @returns {{name: string, type: string, size: number}}
 */
export function sourceInfo(src) {
  if (src && src.kind === 'plain') {
    if (typeof Blob === 'undefined' || !(src.blob instanceof Blob)) throw new TypeError('DecryptSource: plain needs a Blob');
    return { name: safeFilename(src.name ?? src.blob.name ?? ''), type: String(src.type ?? src.blob.type ?? ''), size: src.blob.size };
  }
  if (src && src.kind === 'container') {
    if (!src.src || typeof src.src.readAt !== 'function' || !src.opened || typeof src.opened !== 'object') throw new TypeError('DecryptSource: container needs src and opened');
    const e = src.entry;
    if (e) {
      if (!Number.isSafeInteger(e.off) || !Number.isSafeInteger(e.size) || e.off < 0 || e.size < 0 || e.off + e.size > src.opened.size) {
        throw new TypeError('DecryptSource: entry outside the container');
      }
      return { name: safeFilename(e.name), type: String(e.type ?? ''), size: e.size };
    }
    const meta = src.opened.meta ?? {};
    return { name: safeFilename(meta.name), type: String(meta.type ?? ''), size: src.opened.size };
  }
  throw new TypeError('expected a DecryptSource');
}

/**
 * Hands a DecryptSource back once the viewer/player is done with it: its own release() when it has one (shared
 * Opened objects, e.g. a bundle kept open by the Send view, provide a no-op), else container.release(opened).
 * @param {import('../types.js').DecryptSource|null|undefined} src
 */
export function disposeSource(src) {
  if (!src || typeof src !== 'object') return;
  // A prefetched plaintext of this source must not outlive it (nor be handed out after the keys are gone).
  if (prefetched && prefetched.src === src) cancelPrefetch();
  try {
    if (typeof src.release === 'function') src.release();
    else if (src.kind === 'container') releaseOpened(src.opened);
  } catch (e) {
    globalThis.console?.warn?.('[media] releasing a source failed', e);
  }
}

/** The declared type, or the one implied by the extension when the declared one isn't a media type. */
function mediaType(type, name) {
  const t = safeMediaType(type);
  return t !== 'application/octet-stream' ? t : safeMediaType(mimeFromExt(extOf(name)));
}

const isNote = (info) => kindOf(info.type, info.name) === 'note';

function blobCap() {
  return platform.caps.mobile() ? CAPS.blobMobile : CAPS.blobDesktop;
}

async function* blobChunks(blob, signal) {
  const ab = abortable(signal);
  for await (const piece of fileChunks(blob)) {
    ab.checkpoint();
    yield piece;
  }
}

/** The whole plaintext (containers: strictly authenticated, entries: by random access). */
function plaintext(src, signal) {
  if (src.kind === 'plain') return blobChunks(src.blob, signal);
  if (src.entry) return decryptSource(src.src, src.opened, { signal, entry: { off: src.entry.off, size: src.entry.size } });
  return decryptSource(src.src, src.opened, { signal });
}

/** The first n plaintext bytes (n ≤ size). */
function prefix(src, n, signal) {
  if (src.kind === 'plain') return blobChunks(src.blob.slice(0, n), signal);
  return decryptSource(src.src, src.opened, { signal, entry: { off: src.entry ? src.entry.off : 0, size: n } });
}

// ───────── text, notes, Blobs, Files

/**
 * Text preview: at most maxBytes, decoded as UTF-8 (invalid bytes → U+FFFD; a character cut at the limit is dropped).
 * @param {import('../types.js').DecryptSource} src
 * @param {{maxBytes?: number}} [opts]
 * @returns {Promise<{text: string, truncated: boolean}>}
 */
export async function readText(src, { maxBytes = CAPS.text } = {}) {
  const info = sourceInfo(src);
  const max = Math.max(0, Math.floor(Number(maxBytes) || 0));
  const truncated = info.size > max;
  const bytes = await collect(truncated ? prefix(src, max) : plaintext(src));
  return { text: new TextDecoder('utf-8').decode(bytes, { stream: truncated }), truncated };
}

/**
 * A note's {title, body} (payload {"v":1,"title","body"}, DESIGN §11). Text that isn't such JSON becomes the body.
 * Extra over §10 (viewer note mode).
 * @param {import('../types.js').DecryptSource} src
 * @returns {Promise<{title: string, body: string}>}
 */
export async function readNote(src) {
  const info = sourceInfo(src);
  if (info.size > NOTE_MAX) throw new CzdError('too-big-to-preview');
  const { text } = await readText(src, { maxBytes: NOTE_MAX });
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && (typeof obj.body === 'string' || typeof obj.title === 'string')) {
      return { title: typeof obj.title === 'string' ? obj.title : info.name, body: typeof obj.body === 'string' ? obj.body : '' };
    }
  } catch {
    // not JSON: show it as it is
  }
  return { title: info.name, body: text };
}

/** "<safe title>.txt" (DESIGN §11). */
function noteFileName(title) {
  const base = String(title ?? '').trim() || 'note';
  return safeFilename(/\.txt$/i.test(base) ? base : `${base}.txt`);
}

/**
 * Decrypts into a Blob of type safeMediaType(type ?? the source's type). maxBytes defaults to this device's
 * Blob cap (CAPS.blobDesktop / blobMobile); larger → CzdError('too-big-to-preview').
 * @param {import('../types.js').DecryptSource} src
 * @param {{maxBytes?: number, type?: string, signal?: AbortSignal}} [opts]
 * @returns {Promise<Blob>}
 */
export async function decryptToBlob(src, { maxBytes, type, signal } = {}) {
  const info = sourceInfo(src);
  if (info.size > (maxBytes ?? blobCap())) throw new CzdError('too-big-to-preview');
  const t = type === undefined || type === null ? mediaType(info.type, info.name) : safeMediaType(type);
  if (src.kind === 'plain') return src.blob.type === t ? src.blob : src.blob.slice(0, src.blob.size, t);
  const groups = [];
  let group = [];
  let filled = 0;
  for await (const piece of plaintext(src, signal)) {
    group.push(piece);
    filled += piece.length;
    if (filled >= BLOB_GROUP) {
      groups.push(new Blob(group));
      group = [];
      filled = 0;
    }
  }
  if (group.length) groups.push(new Blob(group));
  return new Blob(groups, { type: t });
}

/**
 * Decrypts into a File for navigator.share (≤ this device's Blob cap). The caller shows a "Share" button whose
 * own click calls platform.shareFiles([file]). Notes become "<title>.txt" holding the body.
 * @param {import('../types.js').DecryptSource} src
 * @param {{name?: string, type?: string}} [opts]
 * @returns {Promise<File>}
 */
export async function prepareShare(src, { name, type } = {}) {
  const info = sourceInfo(src);
  if (isNote(info)) {
    const note = await readNote(src);
    return new File([utf8(note.body)], noteFileName(name ?? note.title), { type: NOTE_FILE_TYPE });
  }
  const blob = await decryptToBlob(src, { type });
  return new File([blob], safeFilename(name ?? info.name), { type: blob.type });
}

/**
 * Streams the plaintext into a SaveTarget (DESIGN §5.1). Output is provisional: on any error target.abort() removes
 * what was written (FS Access writable.abort, Tauri truncate+remove, staged Blob dropped) and the error is rethrown.
 * 'stage' targets keep the output in memory, so sizes above this device's Blob cap use a single-use service-worker
 * download instead where possible (resolves {name, where:'downloads', done}), else CzdError('too-big-to-preview',
 * {detail:'too-big-to-save'}) — the UI says "Too big to save in this browser — use the desktop app or Chrome".
 * Notes are saved as "<title>.txt" holding the body.
 * @param {import('../types.js').SaveTarget} target
 * @param {import('../types.js').DecryptSource} src
 * @param {{name?: string, type?: string, signal?: AbortSignal, onProgress?: (done: number, total: number) => void}} [opts]
 * @returns {Promise<{name: string, where?: string, staged?: File, done?: Promise<void>}>}
 */
export async function saveDecrypted(target, src, { name, type, signal, onProgress } = {}) {
  if (!target || typeof target.write !== 'function' || typeof target.abort !== 'function') throw new TypeError('saveDecrypted(): expected a SaveTarget');
  const info = sourceInfo(src);
  try {
    let outName;
    let mime;
    let size;
    let source;
    if (isNote(info)) {
      const note = await readNote(src);
      const bytes = utf8(note.body);
      outName = noteFileName(name ?? note.title);
      mime = NOTE_FILE_TYPE;
      size = bytes.length;
      source = (async function* one() {
        yield bytes;
      })();
    } else {
      outName = safeFilename(name ?? info.name);
      mime = type ?? info.type;
      size = info.size;
      if (target.kind === 'stage' && size > blobCap()) {
        if (canSwDownload(src)) return await downloadViaSw(src, { name: outName });
        throw new CzdError('too-big-to-preview', { detail: 'too-big-to-save' });
      }
      source = src.kind === 'plain' && !onProgress ? src.blob : plaintext(src, signal);
    }
    const piped = onProgress && typeof source[Symbol.asyncIterator] === 'function' ? withProgress(source, onProgress, size) : source;
    return await target.write(outName, piped, { size, mime, signal });
  } catch (e) {
    try {
      await target.abort();
    } catch {
      // already reported by the write
    }
    throw toCzdError(e);
  }
}

// ───────── playable URLs

/** Remembers a handle until it is released (idempotent). */
function track(url, via, onRelease) {
  let released = false;
  const handle = {
    url,
    via,
    release() {
      if (released) return;
      released = true;
      handles.delete(handle);
      try {
        onRelease();
      } catch (e) {
        globalThis.console?.warn?.('[media] release failed', e);
      }
    },
  };
  handles.add(handle);
  return handle;
}

/**
 * A URL the viewer/player can put in <img>/<audio>/<video> (DESIGN §5.1): images always as a Blob (≤ CAPS.image);
 * audio and video through the Tauri czstream protocol (vault items on desktop) or the service worker (web with a
 * controller; not on iOS) and else as a Blob within this device's cap. force:'blob' (extra over §10) skips the
 * streamed paths (the fallback after a streamed URL failed); signal (extra) stops the Blob decrypt.
 * Throws CzdError('too-big-to-preview').
 * @param {import('../types.js').DecryptSource} src
 * @param {{mode: 'image'|'audio'|'video', force?: 'blob', signal?: AbortSignal}} opts
 * @returns {Promise<{url: string, via: 'blob'|'sw'|'tauri', release(): void}>}
 */
export async function playableUrl(src, { mode, force, signal } = {}) {
  if (!MODES.has(mode)) throw new TypeError(`playableUrl(): bad mode ${mode}`);
  const info = sourceInfo(src);
  const type = mediaType(info.type, info.name);
  if (signal?.aborted) throw new CzdError('aborted');
  if (mode !== 'image' && force !== 'blob' && src.kind === 'container') {
    if (!src.opened.keys) throw new CzdError('aborted', { detail: 'released' });
    let streamed = null;
    if (platform.isTauri) streamed = await tauriPlayable(src, info, type);
    else if (canSwMedia()) streamed = await swPlayable(src, info, type);
    if (streamed) return streamed;
  }
  return blobPlayable(src, info, mode, type, signal);
}

/** Largest Blob the viewer/player decrypts for this mode. */
function blobLimit(mode) {
  return mode === 'image' ? CAPS.image : blobCap();
}

async function blobPlayable(src, info, mode, type, signal) {
  let blob = null;
  if (prefetched && prefetched.src === src) {
    const p = prefetched;
    prefetched = null;
    blob = await p.promise.catch(() => null);
  }
  if (!blob) {
    if (src.kind === 'plain') blob = src.blob.type === type ? src.blob : src.blob.slice(0, src.blob.size, type);
    else blob = await decryptToBlob(src, { maxBytes: blobLimit(mode), type, signal });
  }
  if (signal?.aborted) throw new CzdError('aborted');
  const url = URL.createObjectURL(blob);
  return track(url, 'blob', () => URL.revokeObjectURL(url));
}

function itemIdOf(src) {
  const id = src.itemId ?? src.src?.id;
  return typeof id === 'string' && ITEM_ID.test(id) ? id : null;
}

/** Desktop: stream_register for a vault item stored on disk (no bundle entries). null → use a Blob. */
async function tauriPlayable(src, info, type) {
  const id = itemIdOf(src);
  const { opened } = src;
  if (!id || src.entry || !(opened.fileKey instanceof Uint8Array) || opened.fileKey.length !== 32) return null;
  if (!tauriStreams()) return null; // Linux, or Rust refused before: no key leaves for a stream that can't play
  const token = newToken();
  try {
    const r = await platform.tauriStreamRegister({
      token,
      id,
      fileKey: opened.fileKey,
      streamSalt: opened.streamSalt,
      headerLen: opened.headerLen,
      chunkExp: opened.chunkExp,
      size: opened.size,
      paddedSize: opened.paddedSize,
      mime: type,
    });
    const url = typeof r === 'string' ? r : r && typeof r.url === 'string' ? r.url : null;
    if (!url) return null;
    const used = r && typeof r.token === 'string' ? r.token : token;
    return track(url, 'tauri', () => {
      Promise.resolve().then(() => platform.tauriStreamUnregister(used)).catch(() => {});
    });
  } catch (e) {
    // A lock or unregister while registering: stop, never fall back to decrypting into memory.
    if (e?.code === 'aborted') throw e;
    // Linux (WebKitGTK) refuses by design; that and the stub are expected, so stay quiet.
    if (e?.code !== 'not-implemented' && e?.code !== 'unsupported-media') {
      globalThis.console?.warn?.('[media] czstream unavailable, using a Blob', e);
    }
    return null;
  }
}

// ───────── service worker streaming (page side of DESIGN §5.2)

function swContainer() {
  return globalThis.navigator?.serviceWorker ?? null;
}

/** SW media streaming: a controller exists, not Tauri, not iOS (unverified there, DESIGN §1.5). */
function canSwMedia() {
  return platform.caps.sw() && !isIOS();
}

/** iOS and macOS Safari (and every other WebKit browser) get no SW downloads (DESIGN §5.2). */
function isWebKit() {
  if (isIOS()) return true;
  const ua = String(globalThis.navigator?.userAgent ?? '');
  return /AppleWebKit/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS|SamsungBrowser/.test(ua);
}

function canSwDownload(src) {
  return src.kind === 'container' && typeof Blob !== 'undefined' && src.src.blob instanceof Blob && platform.caps.sw() && !isWebKit();
}

const newToken = () => toBase32(randomBytes(16));

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function swScope() {
  const sw = swContainer();
  if (!sw || !sw.controller) throw new CzdError('internal', { detail: 'no service worker' });
  const reg = await Promise.race([sw.ready, delay(SW_READY_MS).then(() => null)]);
  if (!reg || typeof reg.scope !== 'string') throw new CzdError('internal', { detail: 'service worker not ready' });
  return reg.scope;
}

/** Posts to the controlling worker and waits for {ok:true} on a MessageChannel. */
function postToSw(msg) {
  const ctl = swContainer()?.controller;
  if (!ctl) return Promise.reject(new CzdError('internal', { detail: 'no service worker' }));
  return new Promise((resolve, reject) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => {
      ch.port1.close();
      reject(new CzdError('internal', { detail: 'service worker did not answer' }));
    }, SW_REPLY_MS);
    ch.port1.onmessage = (e) => {
      clearTimeout(timer);
      ch.port1.close();
      if (e.data && e.data.ok === true) resolve();
      else reject(new CzdError('internal', { detail: `service worker refused: ${e.data?.error ?? 'unknown'}` }));
    };
    ctl.postMessage(msg, [ch.port2]);
  });
}

/** The register message of §5.2 (the payKey CryptoKey and the container Blob are structured-cloned). */
function registerPayload(src, token, { download, filename, mime }) {
  const { opened } = src;
  const payKey = opened.keys?.pay;
  if (!payKey) throw new CzdError('aborted', { detail: 'released' });
  const msg = {
    cmd: 'register',
    token,
    blob: src.src.blob,
    payKey,
    headerLen: opened.headerLen,
    chunkExp: opened.chunkExp,
    size: opened.size,
    paddedSize: opened.paddedSize,
    mime,
    filename: safeFilename(filename),
    download,
  };
  if (src.entry) msg.entry = { off: src.entry.off, size: src.entry.size };
  return msg;
}

function hookSw() {
  if (swHooked) return;
  const sw = swContainer();
  if (!sw) return;
  swHooked = true;
  sw.addEventListener('message', onSwMessage);
  sw.startMessages?.();
}

/** 'need': answer with the register payload only while the token is live (not released, not purged). */
function onSwMessage(e) {
  const d = e.data;
  if (!d || typeof d !== 'object') return;
  if (d.cmd === 'need') {
    const port = e.ports && e.ports[0];
    if (!port) return;
    const payload = typeof d.token === 'string' ? live.get(d.token) : undefined;
    try {
      port.postMessage(payload && payload.payKey ? payload : { deny: true });
    } catch {
      port.postMessage({ deny: true });
    }
    return;
  }
  if (typeof d.type === 'string' && d.type.startsWith('download-') && typeof d.token === 'string') downloads.get(d.token)?.on(d.type);
}

async function swPlayable(src, info, type) {
  if (typeof Blob === 'undefined' || !(src.src.blob instanceof Blob)) return null;
  let token = null;
  try {
    const scope = await swScope();
    hookSw();
    token = newToken();
    const payload = registerPayload(src, token, { download: false, filename: info.name, mime: type });
    live.set(token, payload); // before posting: a racing 'need' can already be answered
    await postToSw(payload);
    const t = token;
    return track(new URL(`czstream/${t}`, scope).href, 'sw', () => {
      if (!live.delete(t)) return;
      try {
        swContainer()?.controller?.postMessage({ cmd: 'unregister', token: t });
      } catch {
        // the worker forgets it on lock or when it stops
      }
    });
  } catch (e) {
    if (token) live.delete(token);
    if (isCancel(e)) throw e;
    globalThis.console?.warn?.('[media] service worker streaming unavailable, using a Blob', e);
    return null;
  }
}

/** Watches the worker's download-started / -done / -failed notices for one token. */
function watchDownload(token) {
  let settleStart;
  let settleDone;
  const started = new Promise((resolve, reject) => (settleStart = { resolve, reject }));
  const done = new Promise((resolve, reject) => (settleDone = { resolve, reject }));
  started.catch(() => {});
  done.catch(() => {});
  const finish = () => {
    clearTimeout(timer);
    downloads.delete(token);
  };
  const w = {
    started,
    done,
    on(type) {
      if (type === 'download-started') {
        clearTimeout(timer);
        settleStart.resolve();
      } else if (type === 'download-done') {
        finish();
        settleStart.resolve();
        settleDone.resolve();
      } else if (type === 'download-failed') {
        w.fail(new CzdError('interrupted', { detail: 'download failed' }));
      }
    },
    fail(err) {
      finish();
      settleStart.reject(err);
      settleDone.reject(err);
    },
  };
  const timer = setTimeout(() => w.fail(new CzdError('internal', { detail: 'download did not start' })), DOWNLOAD_START_MS);
  downloads.set(token, w);
  return w;
}

/**
 * Saves the plaintext through a single-use service-worker download (DESIGN §5.2): registers a download token and
 * clicks a plain <a href> (no download attribute) so the browser streams it to its downloads. Not on WebKit.
 * Resolves once the worker started serving it: {name, where: 'downloads', done: Promise} (done settles at the end).
 * Extra over §10 (used by saveDecrypted for large outputs on 'stage' targets; views may call it directly).
 * @param {import('../types.js').DecryptSource} src
 * @param {{name?: string}} [opts]
 * @returns {Promise<{name: string, where: string, done: Promise<void>}>}
 */
export async function downloadViaSw(src, { name } = {}) {
  const info = sourceInfo(src);
  // The worker streams the raw payload: a note's would be its JSON, not the "<title>.txt" body (DESIGN §11).
  if (isNote(info)) throw new CzdError('internal', { detail: 'notes are saved with saveDecrypted()' });
  if (!canSwDownload(src)) throw new CzdError('too-big-to-preview', { detail: 'too-big-to-save' });
  const outName = safeFilename(name ?? info.name);
  const scope = await swScope();
  hookSw();
  const token = newToken();
  const watcher = watchDownload(token);
  try {
    await postToSw(registerPayload(src, token, { download: true, filename: outName, mime: 'application/octet-stream' }));
  } catch (e) {
    watcher.fail(e);
    throw toCzdError(e);
  }
  const url = new URL(`czstream/${token}`, scope);
  url.searchParams.set('download', '1');
  const a = h('a', { hidden: true, rel: 'noopener' });
  a.href = url.href; // absolute same-origin worker URL (h() only takes relative/blob: URLs)
  globalThis.document.body.append(a);
  a.click();
  a.remove();
  await watcher.started;
  return { name: outName, where: 'downloads', done: watcher.done };
}

// ───────── media elements

/** Stops an element's loading/playback and drops its source. */
export function detachMedia(el) {
  if (!el) return;
  try {
    if (typeof el.pause === 'function') el.pause();
    el.removeAttribute('src');
    if (typeof el.load === 'function') el.load();
  } catch {
    // ignore
  }
}

/** Thrown by loadInto when a streamed URL showed nothing within TIMES.mediaFallbackMs. */
class SlowStream extends Error {}

/**
 * Sets el.src and waits for load/loadedmetadata. A streamed URL gets TIMES.mediaFallbackMs (then SlowStream);
 * patient: no Blob to fall back to, so it gets STREAM_PATIENCE times as long before giving up. A Blob URL in an
 * <audio>/<video> that neither loads nor fails within TIMES.mediaFallbackMs is handed over as it is: engines that
 * don't preload without a gesture (iOS) load it when the user presses play.
 */
function loadInto(el, handle, mode, signal, { patient = false } = {}) {
  return new Promise((resolve, reject) => {
    const okEvent = mode === 'image' ? 'load' : 'loadedmetadata';
    let timer = null;
    const done = (fn, v) => {
      clearTimeout(timer);
      el.removeEventListener(okEvent, onOk);
      el.removeEventListener('error', onErr);
      signal?.removeEventListener('abort', onAbort);
      fn(v);
    };
    const onOk = () => done(resolve);
    const onErr = () => done(reject, el.error ?? new Error('media error'));
    const onAbort = () => done(reject, new CzdError('aborted'));
    if (signal?.aborted) {
      reject(new CzdError('aborted'));
      return;
    }
    el.addEventListener(okEvent, onOk);
    el.addEventListener('error', onErr);
    signal?.addEventListener('abort', onAbort);
    // A streamed URL that shows nothing within 5 s is retried as a Blob (DESIGN §5.1).
    if (handle.via !== 'blob') {
      const ms = TIMES.mediaFallbackMs * (patient ? STREAM_PATIENCE : 1);
      timer = setTimeout(() => done(reject, new SlowStream('no loadedmetadata in time')), ms);
    } else if (mode !== 'image') {
      timer = setTimeout(() => done(resolve), TIMES.mediaFallbackMs);
    }
    el.src = handle.url;
  });
}

/**
 * Loads src into an <img>, <audio> or <video> with the DESIGN §5.1 fallback: a streamed URL (sw/tauri) that errors
 * or shows no loadedmetadata within TIMES.mediaFallbackMs is replaced once by a Blob URL (within caps; above them
 * an error is 'unsupported-media' and a slow stream gets longer before 'too-big-to-preview'). A Blob that the
 * element can't decode → CzdError('unsupported-media'). The signal also stops the Blob decrypt. Resolves the live
 * handle (release it when done). Extra over §10 (shared by the viewer and the player).
 * @param {HTMLImageElement|HTMLMediaElement} el
 * @param {import('../types.js').DecryptSource} src
 * @param {{mode: 'image'|'audio'|'video', signal?: AbortSignal}} opts
 * @returns {Promise<{url: string, via: 'blob'|'sw'|'tauri', release(): void}>}
 */
export async function attachMedia(el, src, { mode, signal } = {}) {
  let handle = await playableUrl(src, { mode, signal });
  // Above this device's Blob cap there is nothing to fall back to: a streamed URL gets more time, and its
  // failure means the element can't play it (not "too big").
  const blobPossible = src.kind === 'plain' || sourceInfo(src).size <= blobLimit(mode);
  try {
    await loadInto(el, handle, mode, signal, { patient: !blobPossible });
    return handle;
  } catch (e) {
    handle.release();
    detachMedia(el);
    if (isCancel(e)) throw e;
    if (handle.via === 'blob') throw new CzdError('unsupported-media', { cause: e });
    if (!blobPossible) throw new CzdError(e instanceof SlowStream ? 'too-big-to-preview' : 'unsupported-media', { cause: e });
  }
  if (signal?.aborted) throw new CzdError('aborted');
  handle = await playableUrl(src, { mode, force: 'blob', signal });
  try {
    await loadInto(el, handle, mode, signal);
    return handle;
  } catch (e) {
    handle.release();
    detachMedia(el);
    throw isCancel(e) ? e : new CzdError('unsupported-media', { cause: e });
  }
}

/**
 * Largest item of this kind the viewer/player can show on this device: images CAPS.image; audio/video unlimited
 * when they can stream (desktop app with czstream, or a service worker outside iOS), else this device's Blob cap —
 * also on the desktop app where czstream is unavailable (Linux, or after Rust refused a registration; DESIGN §12).
 * For the import warning "Stored, but too big to play or save on this device" (DESIGN §1.5). Extra over §10.
 * @param {'image'|'audio'|'video'} kind
 * @returns {number} bytes (Infinity = no limit)
 */
export function playLimit(kind) {
  if (kind === 'image') return CAPS.image;
  const streams = platform.isTauri ? tauriStreams() : canSwMedia();
  return streams ? Infinity : blobCap();
}

/** Desktop: czstream can be used (not Linux, no refusal yet). */
function tauriStreams() {
  return typeof platform.tauriStreamAvailable === 'function' ? platform.tauriStreamAvailable() : true;
}

// ───────── prefetch and cleanup

function cancelPrefetch() {
  if (!prefetched) return;
  prefetched.ctl.abort();
  prefetched = null;
}

/**
 * Starts preparing an item that will be shown next (player's next track): when it would play from a Blob, the
 * decrypt starts now and playableUrl(src) picks it up (same DecryptSource object). One item at a time; streamed
 * items need nothing. Never throws.
 * @param {import('../types.js').DecryptSource} src
 */
export function prefetch(src) {
  try {
    if (prefetched && prefetched.src === src) return;
    cancelPrefetch();
    const info = sourceInfo(src);
    if (src.kind !== 'container' || !src.opened.keys) return;
    const kind = kindOf(info.type, info.name);
    if (kind !== 'audio' && kind !== 'video' && kind !== 'image') return;
    const streamed = kind !== 'image' && (platform.isTauri ? tauriStreams() && Boolean(itemIdOf(src)) && !src.entry : canSwMedia() && src.src.blob instanceof Blob);
    if (streamed) return;
    const maxBytes = kind === 'image' ? CAPS.image : blobCap();
    if (info.size > maxBytes) return;
    const ctl = new AbortController();
    const promise = decryptToBlob(src, { maxBytes, type: mediaType(info.type, info.name), signal: ctl.signal });
    promise.catch(() => {});
    prefetched = { src, ctl, promise };
  } catch {
    // a prefetch is only a hint
  }
}

/**
 * Lock-time cleanup (registered with state.onPurge): revokes every Blob URL, unregisters every SW/czstream token,
 * forgets the tokens the worker could ask for, fails pending downloads and drops the prefetched item.
 */
export function releaseAll() {
  cancelPrefetch();
  for (const handle of [...handles]) handle.release();
  handles.clear();
  live.clear();
  for (const w of [...downloads.values()]) w.fail(new CzdError('aborted'));
  downloads.clear();
  if (platform.isTauri) Promise.resolve().then(() => platform.tauriStreamClear()).catch(() => {});
}

state.onPurge(() => releaseAll());
