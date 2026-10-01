// czd2 container format v2 (DESIGN §3.3).
// Owner: A (phase 1). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from '../errors.js';
import { CHUNK_EXP } from '../config.js';
import { POLICY } from './kdf.js';

/** File magic. */
export const MAGIC = new Uint8Array([0x89, 0x43, 0x5a, 0x44, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Format version byte. */
export const VERSION = 2;

/** Passphrase stanza type. */
export const ST_PASS = 1;

/** Vault stanza type. */
export const ST_VAULT = 2;

/** Reader bounds (placeholder values from §3.3; A finalizes). */
export const LIMITS = Object.freeze({
  chunkExpMin: 12,
  chunkExpMax: 24,
  maxStanzas: 4,
  maxPassStanzas: 2,
  maxVaultStanzas: 1,
  metaLenMin: 272,
  metaLenMax: 2 ** 20 + 16,
  metaJsonSingle: 64 * 1024,
  metaJsonBundle: 2 ** 20,
  bundleEntries: 2000,
});

/** meta.type of a bundle. */
export const BUNDLE_TYPE = 'application/x-czd-bundle';

/** Magic check. */
export function isCzd2(first8) {
  throw new CzdError('not-implemented');
}

/** Padmé padded length. */
export function padme(n) {
  throw new CzdError('not-implemented');
}

/** Total container length. */
export function containerSize(size, chunkExp, headerLen) {
  throw new CzdError('not-implemented');
}

/** Parses (copies) the header; no keys. */
export function parseHeader(buf) {
  throw new CzdError('not-implemented');
}

/** Reads the header bytes from a ByteSource. */
export async function readHeaderBytes(src) {
  throw new CzdError('not-implemented');
}

/** -> PassKek (one Argon2 run). */
export async function makePassKek(pass, params = POLICY, { signal } = {}) {
  throw new CzdError('not-implemented');
}

/** -> Stanza. */
export async function passStanza(fileKey, passKek) {
  throw new CzdError('not-implemented');
}

/** -> Stanza. */
export async function vaultStanza(fileKey, itemWrapKey, vaultId, itemId) {
  throw new CzdError('not-implemented');
}

/** vault: {wrapKey, vaultId, itemId}; -> Opened. */
export async function openHeader(buf, { passphrase, vault, confirmKdf, signal }) {
  throw new CzdError('not-implemented');
}

/** readHeaderBytes + openHeader + size check. */
export async function openSource(src, opts) {
  throw new CzdError('not-implemented');
}

/** Yields the container bytes; stanzasFor: async fileKey => Stanza[]. */
export async function* encryptStream(source, { size, meta, stanzasFor, chunkExp = CHUNK_EXP, signal }) {
  throw new CzdError('not-implemented');
}

/** ctSource = bytes after the header. */
export async function* decryptStream(ctSource, opened, { signal }) {
  throw new CzdError('not-implemented');
}

/** entry: {off, size} for bundle entries. */
export async function* decryptSource(src, opened, { signal, entry }) {
  throw new CzdError('not-implemented');
}

/** -> Uint8Array. */
export async function decryptRange(src, opened, start, endInclusive) {
  throw new CzdError('not-implemented');
}

/** Authenticates every chunk. */
export async function verifySource(src, opened, { signal, onProgress }) {
  throw new CzdError('not-implemented');
}

/** entries: [{name, type, size, mtime?}] -> meta with offsets. */
export function bundleMeta(entries) {
  throw new CzdError('not-implemented');
}

/** Drops keys held by an Opened. */
export function release(opened) {
  throw new CzdError('not-implemented');
}
