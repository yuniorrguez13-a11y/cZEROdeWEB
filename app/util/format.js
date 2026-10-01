// Formatting, classification and sanitizing of untrusted names/types (DESIGN §2.2).
// kindOf() is the only file classifier; safeFilename()/safeMediaType() gate every untrusted
// name and MIME type before it is shown, used as a file name or given to a Blob.

import { randomBytes, toBase32 } from './bytes.js';
import { CAPS } from '../config.js';

/** MIME type of vault notes (created by vault.addNote; classified as kind 'note'). */
export const NOTE_TYPE = 'application/x-czd-note';

const MAX_NAME = 200;
const UNITS = ['KB', 'MB', 'GB', 'TB', 'PB'];

/**
 * Human-readable byte size ("0 B", "999 B", "1.5 KB", "12 MB", "1.2 GB"); 1 KB = 1024 B.
 * Invalid input → "—".
 * @param {number} n
 * @returns {string}
 */
export function fmtSize(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—';
  if (Math.round(n) < 1024) return `${Math.round(n)} B`; // fractional counts (speeds): 1023.6 → "1 KB", not "1024 B"
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < UNITS.length - 1);
  // 1 decimal below 10 ("1.5 MB"), whole numbers above ("12 MB", "512 KB").
  let s = v < 10 ? v.toFixed(1) : String(Math.round(v));
  if (s === '1024' && u < UNITS.length - 1) {
    s = '1.0';
    u++;
  }
  return `${s.replace(/\.0$/, '')} ${UNITS[u]}`;
}

/**
 * Short local date ("Oct 1, 2026" in en-US). Invalid input → "".
 * @param {number} ms epoch milliseconds
 * @returns {string}
 */
export function fmtDate(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/**
 * Media duration: "m:ss" below an hour, "h:mm:ss" above. Invalid/negative/infinite → "".
 * @param {number} sec
 * @returns {string}
 */
export function fmtDuration(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '';
  const t = Math.floor(sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// ───────── MIME types and extensions

const EXT_MIME = Object.freeze({
  // images
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', apng: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', heic: 'image/heic', heif: 'image/heif',
  tif: 'image/tiff', tiff: 'image/tiff', ico: 'image/x-icon',
  // audio
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', weba: 'audio/webm', mid: 'audio/midi', midi: 'audio/midi', aif: 'audio/aiff', aiff: 'audio/aiff', amr: 'audio/amr',
  // video
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  ogv: 'video/ogg', '3gp': 'video/3gpp', '3g2': 'video/3gpp2', mpg: 'video/mpeg', mpeg: 'video/mpeg', wmv: 'video/x-ms-wmv',
  // documents
  pdf: 'application/pdf', txt: 'text/plain', text: 'text/plain', log: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
  csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html',
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain', py: 'text/x-python', sh: 'text/x-shellscript',
  c: 'text/plain', h: 'text/plain', cpp: 'text/plain', rs: 'text/plain', java: 'text/plain', go: 'text/plain', ini: 'text/plain',
  cfg: 'text/plain', conf: 'text/plain', yaml: 'application/yaml', yml: 'application/yaml', toml: 'application/toml',
  srt: 'text/plain', vtt: 'text/vtt', ics: 'text/calendar', vcf: 'text/vcard', rtf: 'application/rtf',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation', epub: 'application/epub+zip', pages: 'application/vnd.apple.pages',
  key: 'application/vnd.apple.keynote', numbers: 'application/vnd.apple.numbers',
  // archives and others
  zip: 'application/zip', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', gz: 'application/gzip',
  tar: 'application/x-tar', apk: 'application/vnd.android.package-archive', exe: 'application/octet-stream',
  czd: 'application/x-czeroode', czb: 'application/x-czeroode-backup',
});

// Shown in the text viewer (as plain text, never rendered).
const TEXT_TYPES = new Set(['application/json', 'application/xml', 'application/javascript', 'application/x-javascript', 'application/yaml',
  'application/x-yaml', 'application/toml', 'application/x-sh', 'application/x-shellscript', 'image/svg+xml', 'application/xhtml+xml',
  'application/ld+json', 'application/sql', 'application/x-subrip']);
const DOC_TYPES = new Set(['application/pdf', 'application/rtf', 'application/epub+zip', 'application/msword', 'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint', 'application/vnd.apple.pages', 'application/vnd.apple.keynote', 'application/vnd.apple.numbers']);
const SAFE_IMAGE = new Set(['png', 'jpeg', 'gif', 'webp', 'avif', 'bmp']);
const IMAGE_ALIAS = Object.freeze({ jpg: 'jpeg', pjpeg: 'jpeg', 'x-png': 'png', 'x-ms-bmp': 'bmp', 'x-bmp': 'bmp' });
const TOKEN = /^[a-z0-9.+-]{1,60}$/;

/** "type/subtype" lowercased without parameters, or '' when it isn't one. */
function normType(t) {
  if (typeof t !== 'string') return '';
  const base = t.split(';', 1)[0].trim().toLowerCase();
  const m = /^([a-z0-9.+-]{1,60})\/([a-z0-9.+-]{1,60})$/.exec(base);
  return m ? base : '';
}

/** The declared type, or the type implied by the extension when the declared one is missing/generic. */
function effectiveType(type, name) {
  const t = normType(type);
  if (t && t !== 'application/octet-stream' && t !== 'binary/octet-stream') return t;
  const fromExt = mimeFromExt(extOf(name));
  return fromExt !== 'application/octet-stream' ? fromExt : t;
}

function isTextType(t) {
  return t.startsWith('text/') || TEXT_TYPES.has(t) || t.endsWith('+json') || t.endsWith('+xml');
}

/**
 * The only classifier (DESIGN §2.2): Kind from the MIME type, falling back to the file
 * extension when the type is missing or generic. Container `meta.kind` is never trusted.
 * SVG counts as a document (it is shown as text, never rendered).
 * @param {string} type
 * @param {string} name
 * @returns {'image'|'video'|'audio'|'doc'|'note'|'other'}
 */
export function kindOf(type, name) {
  if (normType(type) === NOTE_TYPE) return 'note';
  const t = effectiveType(type, name);
  if (!t) return 'other';
  if (t === 'image/svg+xml') return 'doc';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (isTextType(t) || DOC_TYPES.has(t) || t.startsWith('application/vnd.openxmlformats-officedocument.')
    || t.startsWith('application/vnd.oasis.opendocument.')) return 'doc';
  return 'other';
}

/**
 * How the viewer shows an item. Images only for the raster types safeMediaType() keeps
 * (≤ CAPS.image = 64 MiB, else 'none'); text-like types (incl. SVG) as text; PDF and
 * everything else 'none' (file info + Save/Share/Send).
 * @param {string} type
 * @param {string} name
 * @param {number} size bytes
 * @returns {'image'|'audio'|'video'|'text'|'note'|'none'}
 */
export function viewerMode(type, name, size) {
  if (normType(type) === NOTE_TYPE) return 'note';
  const t = effectiveType(type, name);
  if (!t) return 'none';
  if (t.startsWith('image/')) {
    if (t === 'image/svg+xml') return 'text';
    const tooBig = typeof size === 'number' && size > CAPS.image;
    return safeMediaType(t).startsWith('image/') && !tooBig ? 'image' : 'none';
  }
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('video/')) return 'video';
  if (isTextType(t)) return 'text';
  return 'none';
}

/**
 * MIME type safe to give to a Blob / media element / SW response: image/(png|jpeg|gif|webp|avif|bmp),
 * audio/<token>, video/<token>; anything else → application/octet-stream. Parameters are dropped.
 * @param {string} t
 * @returns {string}
 */
export function safeMediaType(t) {
  const n = normType(t);
  if (!n) return 'application/octet-stream';
  const [major, minor] = n.split('/');
  if (!TOKEN.test(minor)) return 'application/octet-stream';
  if (major === 'image') {
    const sub = IMAGE_ALIAS[minor] ?? minor;
    return SAFE_IMAGE.has(sub) ? `image/${sub}` : 'application/octet-stream';
  }
  if (major === 'audio' || major === 'video') return n;
  return 'application/octet-stream';
}

// C0 + DEL + C1 controls, zero-width/bidi marks and embeddings, isolates, ALM, line/paragraph separators, BOM,
// and the other invisible format characters (word joiner/invisible operators, deprecated format controls,
// interlinear annotation marks) that can hide part of a name.
const STRIP = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const RESERVED_CHARS = /[/\\:*?"<>|]/g;
const EDGE = /^[\s.]+|[\s.]+$/gu;
const WIN_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** Splits "stem.ext" (ext ≤ 16 safe chars, the name must have a non-empty stem). */
function splitExt(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return [name, ''];
  const ext = name.slice(i);
  return /^\.[\p{L}\p{N}_+-]{1,16}$/u.test(ext) ? [name.slice(0, i), ext] : [name, ''];
}

/** Cuts to at most `max` UTF-16 units without splitting a surrogate pair. */
function cut(s, max) {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end);
}

/**
 * Sanitizes an untrusted name (DESIGN §2.2, §10): NFC; strips C0/C1 controls, zero-width and bidi
 * controls (U+200B–U+200F, U+202A–U+202E, U+2066–U+2069, U+061C), other invisible format characters
 * (U+2060–U+2064, U+206A–U+206F, U+FFF9–U+FFFB), line separators and U+FEFF;
 * lone surrogates → U+FFFD; / \ : * ? " < > | → '_'; trims dots and whitespace at both ends;
 * '_' prefix for Windows device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9, also with an extension);
 * at most 200 UTF-16 units keeping the extension; empty → "file". Idempotent.
 * @param {unknown} s
 * @returns {string}
 */
export function safeFilename(s) {
  let n = typeof s === 'string' ? s : s == null ? '' : String(s);
  // Strip before NFC: removing a zero-width char can make a sequence composable (idempotence).
  n = fit(n.replace(LONE_SURROGATE, '\ufffd').replace(STRIP, '').normalize('NFC').replace(RESERVED_CHARS, '_').replace(EDGE, ''));
  // After the cap (cutting a stem can expose "con"); the prefixed name is capped again, keeping the extension.
  if (WIN_DEVICE.test(n.split('.', 1)[0].trimEnd())) n = fit(`_${n}`);
  return n || 'file';
}

/** Caps a trimmed name at MAX_NAME units, shortening the stem so a plausible extension survives. */
function fit(n) {
  if (n.length <= MAX_NAME) return n;
  const [stem, ext] = splitExt(n);
  const out = ext && ext.length < MAX_NAME / 2 ? cut(stem, MAX_NAME - ext.length).replace(EDGE, '') + ext : cut(n, MAX_NAME);
  return out.replace(EDGE, '');
}

/**
 * Lowercase extension without the dot ('' when none, for dotfiles and for implausible "extensions").
 * @param {string} name
 * @returns {string}
 */
export function extOf(name) {
  if (typeof name !== 'string') return '';
  const [, ext] = splitExt(name.trim());
  return ext ? ext.slice(1).toLowerCase() : '';
}

/**
 * MIME type for an extension (with or without the dot, any case); unknown → application/octet-stream.
 * @param {string} ext
 * @returns {string}
 */
export function mimeFromExt(ext) {
  if (typeof ext !== 'string') return 'application/octet-stream';
  const e = ext.replace(/^\./, '').toLowerCase();
  return Object.hasOwn(EXT_MIME, e) ? EXT_MIME[e] : 'application/octet-stream';
}

/**
 * Random export file name that hides the real one: 'cz-' + 8 lowercase base32 chars (40 bits) + '.czd'.
 * @returns {string}
 */
export function randomExportName() {
  return `cz-${toBase32(randomBytes(5)).toLowerCase()}.czd`;
}

/**
 * Content-Disposition header value with an RFC 5987/8187 encoded UTF-8 file name
 * (the name is passed through safeFilename first).
 * @param {string} name
 * @returns {string}
 */
export function contentDisposition(name) {
  const enc = encodeURIComponent(safeFilename(name)).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename*=UTF-8''${enc}`;
}

/**
 * Returns `name`, or "stem (2).ext", "stem (3).ext", … — the first one not in `taken`
 * (exact match), and adds the result to `taken`. Long names are shortened to stay ≤ 200 units.
 * @param {string} name
 * @param {Set<string>} taken
 * @returns {string}
 */
export function dedupeName(name, taken) {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const [stem, ext] = splitExt(name);
  for (let i = 2; ; i++) {
    const suffix = ` (${i})${ext}`;
    const candidate = cut(stem, MAX_NAME - suffix.length) + suffix;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}
