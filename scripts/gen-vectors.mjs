#!/usr/bin/env node
// Golden vectors for czd2 (FORMAT v2) and text v2 (DESIGN §8). Dev/CI tool; never staged into dist.
//
//   node scripts/gen-vectors.mjs              (re)writes tests/vectors/czd2/*.czd + czd2.json and tests/vectors/text-v2.json
//   node scripts/gen-vectors.mjs --big <dir>  writes the 17,039,359-byte vector (NOT committed) + its json into <dir>
//
// Plaintext comes from a seeded PRNG (mulberry32, 4 bytes little-endian per step) so any implementation can
// rebuild it. Keys, salts and nonces are random, so a regeneration changes every committed file: regenerating
// committed vectors requires a note in docs/FORMAT.md. The tests only DECRYPT the committed vectors.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as C from '../app/crypto/container.js';
import { POLICY, FLOOR } from '../app/crypto/kdf.js';
import { encryptText } from '../app/crypto/textfmt.js';
import { ascii, toHex } from '../app/util/bytes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CZD2_DIR = path.join(ROOT, 'tests/vectors/czd2');
export const TEXT_JSON = path.join(ROOT, 'tests/vectors/text-v2.json');

/** The test passphrase (non-ASCII on purpose: exercises UTF-8 + NFC canonicalization). */
export const PASSPHRASE = 'cZEROde golden vectors 2.0 ✓';
export const CHUNK_EXP = 18;
export const MTIME = 1767225600000; // 2026-01-01T00:00:00Z
const CS = 2 ** CHUNK_EXP;

/** The large padmé case: 65·CS − 1 bytes → padded to 66·CS (the last chunk is padding only). */
export const BIG = Object.freeze({ id: 'size-17039359', size: 17039359, seed: 17039359, chunkExp: CHUNK_EXP,
  meta: { name: 'vector-17039359.bin', type: 'application/octet-stream', mtime: MTIME } });

/**
 * Deterministic bytes: mulberry32(seed), each step yields a u32 written little-endian.
 * @param {number} seed u32
 * @param {number} n
 * @returns {Uint8Array}
 */
export function prngBytes(seed, n) {
  const out = new Uint8Array(Math.ceil(n / 4) * 4);
  const dv = new DataView(out.buffer);
  let a = seed >>> 0;
  for (let o = 0; o < out.length; o += 4) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    dv.setUint32(o, (t ^ (t >>> 14)) >>> 0, true);
  }
  return out.length === n ? out : out.subarray(0, n);
}

export const sha256 = (u8) => createHash('sha256').update(u8).digest('hex');

async function* pieces(u8, size = 1 << 20) {
  for (let o = 0; o < u8.length; o += size) yield u8.subarray(o, o + size);
}

async function collect(it) {
  const parts = [];
  let len = 0;
  for await (const p of it) {
    parts.push(p);
    len += p.length;
  }
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Encrypts with a recorded fileKey (scripts may use the test-only entry point; app code never does). */
async function seal(plain, { meta, stanzasFor, fileKey }) {
  const streamSalt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const container = await collect(C._encryptStreamWith(pieces(plain), { size: plain.length, meta, chunkExp: CHUNK_EXP, stanzasFor, fileKey, streamSalt }));
  return { container, fileKey, streamSalt };
}

function describe(id, file, plain, { container, fileKey, streamSalt }, extra) {
  const h = C.parseHeader(container);
  const paddedSize = C.padme(plain.length);
  return {
    id,
    file,
    size: plain.length,
    paddedSize,
    n: Math.max(1, Math.ceil(paddedSize / CS)),
    chunkExp: CHUNK_EXP,
    headerLen: h.headerLen,
    containerSize: container.length,
    containerSha256: sha256(container),
    plaintextSha256: sha256(plain),
    fileKeyHex: toHex(fileKey),
    streamSaltHex: toHex(streamSalt),
    ...extra,
  };
}

/**
 * Builds the large vector in memory (also used by tests/unit/golden.test.js).
 * @returns {Promise<{plain:Uint8Array, container:Uint8Array, fileKey:Uint8Array, streamSalt:Uint8Array, json:object}>}
 */
export async function buildBig() {
  const plain = prngBytes(BIG.seed, BIG.size);
  const pk = await C.makePassKek(PASSPHRASE, POLICY);
  const fileKey = prngBytes(BIG.seed ^ 0x5eed, 32).slice();
  const r = await seal(plain, { meta: BIG.meta, fileKey, stanzasFor: async (fk) => [await C.passStanza(fk, pk)] });
  return { plain, ...r, json: describe(BIG.id, `${BIG.id}.czd`, plain, r, { kind: 'single', seed: BIG.seed, passphrase: PASSPHRASE, kdf: { ...POLICY }, meta: { v: 1, ...BIG.meta, size: BIG.size } }) };
}

async function genCzd2() {
  mkdirSync(CZD2_DIR, { recursive: true });
  const vectors = [];
  const write = (file, bytes) => writeFileSync(path.join(CZD2_DIR, file), bytes);
  const keyFor = (seed) => prngBytes(seed ^ 0x5eed, 32).slice();

  // Single files, one Argon2 salt each: 0, 1, CS−1, CS, CS+1, 3·CS+7.
  for (const size of [0, 1, CS - 1, CS, CS + 1, 3 * CS + 7]) {
    const seed = 1000 + size;
    const plain = prngBytes(seed, size);
    const meta = { name: `vector-${size}.bin`, type: 'application/octet-stream', mtime: MTIME };
    const pk = await C.makePassKek(PASSPHRASE, POLICY);
    const r = await seal(plain, { meta, fileKey: keyFor(seed), stanzasFor: async (fk) => [await C.passStanza(fk, pk)] });
    const file = `size-${size}.czd`;
    write(file, r.container);
    vectors.push(describe(`size-${size}`, file, plain, r, { kind: 'single', seed, passphrase: PASSPHRASE, kdf: { ...POLICY }, passSaltHex: toHex(pk.salt), meta: { v: 1, ...meta, size } }));
  }

  // A Send batch: two containers sharing one PassKek (one Argon2 salt), each with its own fileKey.
  const batchKek = await C.makePassKek(PASSPHRASE, POLICY);
  for (const [i, size, name, type] of [[0, 1000, 'résumé ✓.txt', 'text/plain'], [1, 300000, 'photo.jpg', 'image/jpeg']]) {
    const seed = 2000 + i;
    const plain = prngBytes(seed, size);
    const meta = { name, type };
    const r = await seal(plain, { meta, fileKey: keyFor(seed), stanzasFor: async (fk) => [await C.passStanza(fk, batchKek)] });
    const file = `batch-${i}.czd`;
    write(file, r.container);
    vectors.push(describe(`batch-${i}`, file, plain, r, { kind: 'batch', batch: 'batch', seed, passphrase: PASSPHRASE, kdf: { ...POLICY }, passSaltHex: toHex(batchKek.salt), meta: { v: 1, ...meta, size } }));
  }

  // A 3-entry bundle (payload = entries concatenated; one entry empty, one crossing a chunk boundary).
  {
    const specs = [[3000, 5000, 'notes.txt', 'text/plain', MTIME], [3001, 0, 'empty.bin', 'application/octet-stream', undefined], [3002, 270000, 'clip.webm', 'video/webm', MTIME - 86400000]];
    const parts = specs.map(([seed, size]) => prngBytes(seed, size));
    const meta = C.bundleMeta(specs.map(([, size, name, type, mtime]) => (mtime === undefined ? { name, type, size } : { name, type, size, mtime })));
    const plain = new Uint8Array(meta.size);
    parts.forEach((p, i) => plain.set(p, meta.entries[i].off));
    const pk = await C.makePassKek(PASSPHRASE, POLICY);
    const r = await seal(plain, { meta, fileKey: keyFor(3999), stanzasFor: async (fk) => [await C.passStanza(fk, pk)] });
    write('bundle-3.czd', r.container);
    vectors.push(describe('bundle-3', 'bundle-3.czd', plain, r, {
      kind: 'bundle', passphrase: PASSPHRASE, kdf: { ...POLICY }, passSaltHex: toHex(pk.salt), meta,
      entrySeeds: specs.map(([seed]) => seed), entrySha256: parts.map(sha256),
    }));
  }

  // A vault item: itemWrapKey = HKDF-SHA256(VMK, salt = vaultId, "cZEROde czd2 vault item-wrap") (DESIGN §3.5).
  {
    const vmk = prngBytes(4000, 32).slice();
    const vaultId = prngBytes(4001, 16).slice();
    const itemId = prngBytes(4002, 16).slice();
    const hk = await crypto.subtle.importKey('raw', vmk, 'HKDF', false, ['deriveKey']);
    const wrapKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: vaultId, info: ascii('cZEROde czd2 vault item-wrap') }, hk,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const plain = prngBytes(4003, 1000);
    const meta = { name: 'vault-item.bin', type: 'application/octet-stream', mtime: MTIME };
    const r = await seal(plain, { meta, fileKey: keyFor(4003), stanzasFor: async (fk) => [await C.vaultStanza(fk, wrapKey, vaultId, itemId)] });
    write('vault-1.czd', r.container);
    vectors.push(describe('vault-1', 'vault-1.czd', plain, r, {
      kind: 'vault', seed: 4003, vmkHex: toHex(vmk), vaultIdHex: toHex(vaultId), itemIdHex: toHex(itemId), meta: { v: 1, ...meta, size: 1000 },
    }));
  }

  const json = {
    format: 'czd2 FORMAT v2 (DESIGN §3.3)',
    generator: 'scripts/gen-vectors.mjs',
    note: 'Decrypt-only golden vectors. plaintext = prng(seed, size); bundle plaintext = entries concatenated (entrySeeds). fileKeyHex/streamSaltHex let readers without Argon2 (src-tauri stream.rs) derive the payload key.',
    prng: 'mulberry32: a = seed; per step a = (a + 0x6D2B79F5) >>> 0; t = imul(a ^ a >>> 15, a | 1); t ^= t + imul(t ^ t >>> 7, t | 61); u32 = (t ^ t >>> 14) >>> 0, written little-endian; truncated to size',
    passphrase: PASSPHRASE,
    kdf: { ...POLICY },
    chunkExp: CHUNK_EXP,
    vectors,
    generated: [{ id: BIG.id, kind: 'single', size: BIG.size, seed: BIG.seed, paddedSize: C.padme(BIG.size), n: Math.ceil(C.padme(BIG.size) / CS),
      plaintextSha256: sha256(prngBytes(BIG.seed, BIG.size)), passphrase: PASSPHRASE, meta: { v: 1, ...BIG.meta, size: BIG.size },
      howto: 'not committed: rebuild the plaintext from the seed, encrypt, decrypt (node scripts/gen-vectors.mjs --big <dir> writes a container)' }],
  };
  writeFileSync(path.join(CZD2_DIR, 'czd2.json'), `${JSON.stringify(json, null, 2)}\n`);
  return vectors.length;
}

async function genText() {
  const cases = [
    { id: 'policy-ascii', params: POLICY, message: 'hello world', passphrase: PASSPHRASE },
    { id: 'policy-empty', params: POLICY, message: '', passphrase: PASSPHRASE },
    { id: 'policy-unicode', params: POLICY, message: 'ძალიან საიდუმლო 🔐\nСекрет — line 2\t(tab)  ', passphrase: PASSPHRASE },
    { id: 'floor-16', params: FLOOR, message: 'exactly 16 bytes', passphrase: PASSPHRASE },
    // Typed with NFD + doubled inner spaces; decrypts with the canonical spelling.
    { id: 'floor-canonical', params: FLOOR, message: 'canonical passphrase', passphrase: 'Tést  phrase', decryptWith: '  Tést phrase ' },
  ];
  const vectors = [];
  for (const c of cases) {
    const text = await encryptText(c.message, c.passphrase, { params: c.params });
    vectors.push({ id: c.id, preset: c.params === POLICY ? 1 : 2, params: { ...c.params }, passphrase: c.passphrase, decryptWith: c.decryptWith ?? c.passphrase, message: c.message, text });
  }
  const json = { format: 'cZEROde text v2 (DESIGN §3.4)', generator: 'scripts/gen-vectors.mjs', note: 'Decrypt-only golden vectors.', vectors };
  writeFileSync(TEXT_JSON, `${JSON.stringify(json, null, 2)}\n`);
  return vectors.length;
}

async function main(argv) {
  const big = argv.indexOf('--big');
  if (big >= 0) {
    const dir = argv[big + 1];
    if (!dir) throw new Error('usage: gen-vectors.mjs --big <dir>');
    mkdirSync(dir, { recursive: true });
    const r = await buildBig();
    writeFileSync(path.join(dir, `${BIG.id}.czd`), r.container);
    writeFileSync(path.join(dir, `${BIG.id}.json`), `${JSON.stringify(r.json, null, 2)}\n`);
    console.log(`wrote ${BIG.id}.czd (${r.container.length} bytes) to ${dir}`);
    return;
  }
  const n = await genCzd2();
  const t = await genText();
  console.log(`wrote ${n} czd2 vectors to ${path.relative(ROOT, CZD2_DIR)} and ${t} text vectors to ${path.relative(ROOT, TEXT_JSON)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
