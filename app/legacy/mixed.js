// Legacy Mixed Script v1–v3 decoders (decode only).
// Owner: B (phase 1). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from '../errors.js';

/** -> 'v4'|'v3'|'v2'|'v1'|null. */
export function detectLegacyText(s) {
  throw new CzdError('not-implemented');
}

/** -> {text, ambiguousQY}. */
export function decodeV1(s) {
  throw new CzdError('not-implemented');
}

/** -> {text, method}. */
export function decodeV2(s) {
  throw new CzdError('not-implemented');
}

/** -> {text, ambiguousQY}. */
export function decodeV3(s, pin) {
  throw new CzdError('not-implemented');
}

/** Rows for the legend chart. */
export const LEGEND = Object.freeze([]);
