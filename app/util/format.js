// Formatting, classification and sanitizing of untrusted names/types (DESIGN §2.2).
// Owner: C1 (phase 1). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from '../errors.js';

/** Human-readable byte size. */
export function fmtSize(n) {
  throw new CzdError('not-implemented');
}

/** Short local date. */
export function fmtDate(ms) {
  throw new CzdError('not-implemented');
}

/** m:ss / h:mm:ss. */
export function fmtDuration(sec) {
  throw new CzdError('not-implemented');
}

/** The only classifier: Kind for a MIME type + file name. */
export function kindOf(type, name) {
  throw new CzdError('not-implemented');
}

/** -> 'image'|'audio'|'video'|'text'|'note'|'none'. */
export function viewerMode(type, name, size) {
  throw new CzdError('not-implemented');
}

/** image/(png|jpeg|gif|webp|avif|bmp) | audio/x | video/x else application/octet-stream. */
export function safeMediaType(t) {
  throw new CzdError('not-implemented');
}

/** NFC; strips control/bidi/zero-width chars; replaces reserved chars; Windows device names; ≤ 200 UTF-16 units keeping the extension; empty → "file". */
export function safeFilename(s) {
  throw new CzdError('not-implemented');
}

/** Lowercase extension without the dot. */
export function extOf(name) {
  throw new CzdError('not-implemented');
}

/** MIME type for an extension. */
export function mimeFromExt(ext) {
  throw new CzdError('not-implemented');
}

/** 'cz-' + 8 lowercase base32 chars + '.czd'. */
export function randomExportName() {
  throw new CzdError('not-implemented');
}

/** attachment; filename*=UTF-8''… */
export function contentDisposition(name) {
  throw new CzdError('not-implemented');
}

/** 'name (2).ext' style de-duplication against a Set. */
export function dedupeName(name, taken) {
  throw new CzdError('not-implemented');
}
