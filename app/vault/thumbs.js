// Thumbnails, video posters and media durations for vault items (DESIGN §1.5, §4.1 'thumbs', §10).
// Images: createImageBitmap (resize options where supported), else <img> + canvas. Video: a hidden muted playsinline
// <video> on an object URL of the source File, seeked to min(1 s, duration/2), 3 s budget. Audio: <audio> metadata.
// Only bytes that look like a known image/media format are ever handed to an element (see imageFormat/knownContainer).
// The JPEG is q 0.7, long edge ≤ 320 px and ≤ 32 KiB (lower quality, then smaller, until it fits).
// makeThumb never throws (null on any failure) and releases every object URL, bitmap and media element it made.
// SVG is classified 'doc' by kindOf and is never rendered. Node-importable: DOM APIs are only touched inside functions.

import { CAPS } from '../config.js';
import { kindOf } from '../util/format.js';

const QUALITIES = [0.7, 0.6, 0.5, 0.4, 0.3];
const SHRINK = 0.75;
const MIN_EDGE = 48;
const MEDIA_BUDGET_MS = 3000;
const IMAGE_DECODE_MS = 15000;
const BACKGROUND = '#ffffff';

/**
 * -> {jpeg: Uint8Array|null, w, h, duration?} | null; never throws. `jpeg` is null for audio (duration only) and for
 * a video whose poster could not be drawn but whose metadata loaded. w/h are the source's pixel dimensions (0 for audio).
 * @param {Blob} file
 * @param {string} type MIME type (classification goes through kindOf with the file's name)
 * @returns {Promise<{jpeg: Uint8Array|null, w: number, h: number, duration?: number}|null>}
 */
export async function makeThumb(file, type) {
  try {
    if (typeof Blob === 'undefined' || !(file instanceof Blob) || file.size === 0) return null;
    const kind = kindOf(typeof type === 'string' && type ? type : file.type, typeof file.name === 'string' ? file.name : '');
    if (kind === 'image') return await imageThumb(file);
    if (kind === 'video') return await videoThumb(file);
    if (kind === 'audio') return await audioInfo(file);
    return null;
  } catch {
    return null;
  }
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), Math.max(0, ms));
    }),
  ]).finally(() => clearTimeout(timer));
}

function closeBitmap(b) {
  try {
    b?.close?.();
  } catch {
    // already closed
  }
}

async function imageThumb(file) {
  if (file.size > CAPS.image) return null;
  const img = await decodeImage(file);
  if (!img) return null;
  try {
    const r = await encodeFitting(img.source, img.w, img.h);
    return r ? { jpeg: r, w: img.w, h: img.h } : null;
  } finally {
    img.close();
  }
}

/**
 * Image format from the first bytes (null = not an image this module knows). Only known formats ever reach an <img>:
 * Chromium answers a failed <img> decode of a blob: URL with a fetch that the app's CSP (connect-src) refuses.
 */
async function imageFormat(file) {
  const b = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (b.length < 12) return null;
  const at = (o, s) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && at(1, 'PNG')) return 'png';
  if (at(0, 'GIF8')) return 'gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'webp';
  if (at(0, 'BM')) return 'bmp';
  if (at(0, 'II*\0') || at(0, 'MM\0*')) return 'tiff';
  if (at(4, 'ftyp')) {
    const brand = String.fromCharCode(...b.subarray(8, 12));
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  return null;
}

/**
 * Full-size decode: createImageBitmap(file) (EXIF orientation applied); an <img> on an object URL only where
 * createImageBitmap is missing, or for HEIC/TIFF, which some engines (Safari) decode only there.
 */
async function decodeImage(file) {
  const format = await imageFormat(file);
  if (!format) return null;
  const hasBitmap = typeof globalThis.createImageBitmap === 'function';
  if (hasBitmap) {
    try {
      const bmp = await withTimeout(globalThis.createImageBitmap(file), IMAGE_DECODE_MS);
      if (bmp.width > 0 && bmp.height > 0) return { source: bmp, w: bmp.width, h: bmp.height, close: () => closeBitmap(bmp) };
      closeBitmap(bmp);
    } catch {
      // HEIC/TIFF may still decode in an <img> below
    }
    if (format !== 'heic' && format !== 'tiff') return null;
  }
  const doc = globalThis.document;
  if (!doc || typeof URL?.createObjectURL !== 'function') return null;
  const url = URL.createObjectURL(file);
  const el = doc.createElement('img');
  const close = () => {
    el.removeAttribute('src');
    URL.revokeObjectURL(url);
  };
  try {
    el.decoding = 'async';
    el.src = url;
    await withTimeout(el.decode(), IMAGE_DECODE_MS);
    if (!el.naturalWidth || !el.naturalHeight) throw new Error('no size');
    return { source: el, w: el.naturalWidth, h: el.naturalHeight, close };
  } catch {
    close();
    return null;
  }
}

function makeCanvas(w, h) {
  if (typeof globalThis.OffscreenCanvas === 'function') return new globalThis.OffscreenCanvas(w, h);
  const c = globalThis.document?.createElement('canvas');
  if (!c) return null;
  c.width = w;
  c.height = h;
  return c;
}

/** source scaled to tw×th on a canvas (createImageBitmap's resize when available: better downscaling). */
async function scaled(source, w, h, tw, th) {
  const canvas = makeCanvas(tw, th);
  const g = canvas?.getContext('2d');
  if (!g) return null;
  let draw = source;
  let tmp = null;
  if (typeof globalThis.createImageBitmap === 'function' && (tw < w || th < h)) {
    try {
      tmp = await globalThis.createImageBitmap(source, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' });
      if (tmp.width === tw && tmp.height === th) draw = tmp;
    } catch {
      tmp = null;
    }
  }
  g.fillStyle = BACKGROUND; // JPEG has no alpha: transparent pixels become white, not black
  g.fillRect(0, 0, tw, th);
  g.drawImage(draw, 0, 0, tw, th);
  closeBitmap(tmp);
  return canvas;
}

async function toJpeg(canvas, quality) {
  let blob;
  if (typeof canvas.convertToBlob === 'function') blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  else blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob || blob.type !== 'image/jpeg') return null;
  return new Uint8Array(await blob.arrayBuffer());
}

/** JPEG of the source with long edge ≤ CAPS.thumbEdge and ≤ CAPS.thumbBytes: quality first, then size. */
async function encodeFitting(source, w, h) {
  let edge = CAPS.thumbEdge;
  for (;;) {
    const s = Math.min(1, edge / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * s));
    const th = Math.max(1, Math.round(h * s));
    const canvas = await scaled(source, w, h, tw, th);
    if (!canvas) return null;
    for (const q of QUALITIES) {
      const jpeg = await toJpeg(canvas, q);
      if (!jpeg) return null;
      if (jpeg.length <= CAPS.thumbBytes) return jpeg;
    }
    const next = Math.floor(Math.min(edge, Math.max(tw, th)) * SHRINK);
    if (next < MIN_EDGE) return null;
    edge = next;
  }
}

/** Resolves on `type`, rejects on 'error' or after `ms`. */
function once(el, type, ms) {
  return new Promise((resolve, reject) => {
    const done = (fn, v) => {
      clearTimeout(timer);
      el.removeEventListener(type, ok);
      el.removeEventListener('error', bad);
      fn(v);
    };
    const ok = () => done(resolve);
    const bad = () => done(reject, new Error('media error'));
    const timer = setTimeout(() => done(reject, new Error('timeout')), Math.max(0, ms));
    el.addEventListener(type, ok);
    el.addEventListener('error', bad);
  });
}

/** A detached-from-layout media element on an object URL of `file`; cleanup() releases the decoder and the URL. */
function mediaElement(tag, file) {
  const doc = globalThis.document;
  if (!doc || typeof URL?.createObjectURL !== 'function') return null;
  const url = URL.createObjectURL(file);
  const el = doc.createElement(tag);
  el.muted = true;
  el.defaultMuted = true;
  el.preload = 'metadata';
  if (tag === 'video') {
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.setAttribute('aria-hidden', 'true');
    // Off-screen but in the document: some engines (iOS) only decode frames of attached videos.
    Object.assign(el.style, { position: 'fixed', left: '-10000px', top: '0', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
    (doc.body ?? doc.documentElement)?.append(el);
  }
  el.src = url;
  const cleanup = () => {
    try {
      el.pause?.();
      el.removeAttribute('src');
      el.load?.();
    } catch {
      // best effort
    }
    el.remove?.();
    URL.revokeObjectURL(url);
  };
  return { el, cleanup };
}

const ascii4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/**
 * True when the first bytes are a container browsers can demux (EBML/WebM/Matroska, ISO BMFF, Ogg, RIFF WAVE/AVI,
 * FLAC, AIFF, CAF, AMR, MP3/ADTS). Unknown bytes are never handed to a media element: Chromium then probes the URL
 * as an HLS stream with a fetch, which the app's CSP (connect-src) refuses.
 */
async function knownContainer(file) {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (b.length < 12) return false;
  const a0 = ascii4(b, 0);
  const a4 = ascii4(b, 4);
  const a8 = ascii4(b, 8);
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true;
  if (['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(a4)) return true;
  if (a0 === 'OggS' || a0 === 'fLaC' || a0 === 'caff' || a0.startsWith('ID3') || a0 === '#!AM') return true;
  if (a0 === 'RIFF' && (a8 === 'WAVE' || a8 === 'AVI ')) return true;
  if (a0 === 'FORM' && (a8 === 'AIFF' || a8 === 'AIFC')) return true;
  return b[0] === 0xff && (b[1] & 0xe0) === 0xe0; // MPEG audio frame / ADTS
}

async function videoThumb(file) {
  if (!(await knownContainer(file))) return null;
  const m = mediaElement('video', file);
  if (!m) return null;
  const { el } = m;
  const deadline = Date.now() + MEDIA_BUDGET_MS;
  const left = () => deadline - Date.now();
  try {
    await once(el, 'loadedmetadata', left());
    const duration = Number.isFinite(el.duration) && el.duration >= 0 ? el.duration : undefined;
    const w = el.videoWidth;
    const h = el.videoHeight;
    let jpeg = null;
    if (w > 0 && h > 0) {
      try {
        const at = Math.min(1, (duration ?? 0) / 2);
        if (at > 0) {
          const seeked = once(el, 'seeked', left());
          el.currentTime = at;
          await seeked;
        } else if (el.readyState < 2) {
          await once(el, 'loadeddata', left());
        }
        jpeg = await withTimeout(encodeFitting(el, w, h), Math.max(1, left()));
      } catch {
        jpeg = null;
      }
    }
    if (!jpeg && duration === undefined) return null;
    const out = { jpeg, w: w > 0 ? w : 0, h: h > 0 ? h : 0 };
    if (duration !== undefined) out.duration = duration;
    return out;
  } catch {
    return null;
  } finally {
    m.cleanup();
  }
}

async function audioInfo(file) {
  if (!(await knownContainer(file))) return null;
  const m = mediaElement('audio', file);
  if (!m) return null;
  try {
    await once(m.el, 'loadedmetadata', MEDIA_BUDGET_MS);
    const d = m.el.duration;
    return Number.isFinite(d) && d >= 0 ? { jpeg: null, w: 0, h: 0, duration: d } : null;
  } catch {
    return null;
  } finally {
    m.cleanup();
  }
}
