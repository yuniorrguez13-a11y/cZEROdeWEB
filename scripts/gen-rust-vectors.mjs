#!/usr/bin/env node
// Extra czd2 vectors for the desktop stream reader (src-tauri/src/stream.rs tests, DESIGN §5.3). Dev/CI tool;
// never staged into dist. The golden vectors of scripts/gen-vectors.mjs stay untouched.
//
//   node scripts/gen-rust-vectors.mjs    (re)writes tests/vectors/czd2/rust-*.czd + rust-vectors.json
//
// Shapes the golden set lacks: chunkExp 12 with a padding-only extra chunk (266,240 B → 66 chunks, the last
// one all zeros), a short chunkExp 12 file over two chunks, chunkExp 24 (one 16 MiB chunk size) and a
// 3 MiB file at the default chunk size with a short final chunk. Each one is a VAULT item (vault stanza,
// like the containers czstream reads from $APPDATA/vault2/items): no Argon2, and the JSON carries the VMK,
// vaultId and itemId so JS can open it too, plus fileKeyHex/streamSaltHex for Rust. Plaintext comes from
// the golden-vector PRNG (mulberry32). Nonces are random: a regeneration changes every file.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as C from '../app/crypto/container.js';
import { ascii, toHex } from '../app/util/bytes.js';
import { prngBytes, sha256, MTIME } from './gen-vectors.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RUST_DIR = path.join(ROOT, 'tests/vectors/czd2');
export const RUST_JSON = path.join(RUST_DIR, 'rust-vectors.json');

/** [id, size, chunkExp, type] */
export const CASES = Object.freeze([
  ['rust-pad-extra', 266240, 12, 'video/webm'],
  ['rust-exp12-4097', 4097, 12, 'audio/ogg'],
  ['rust-exp24', 70001, 24, 'video/mp4'],
  ['rust-3mib', 3 * 2 ** 20 + 777, 18, 'video/webm'],
]);

/** itemWrapKey = HKDF-SHA256(VMK, salt = vaultId, "cZEROde czd2 vault item-wrap") (DESIGN §3.5). */
export async function itemWrapKey(vmk, vaultId) {
  const hk = await crypto.subtle.importKey('raw', vmk, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: vaultId, info: ascii('cZEROde czd2 vault item-wrap') }, hk,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
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

async function* pieces(u8, size = 1 << 20) {
  for (let o = 0; o < u8.length; o += size) yield u8.subarray(o, o + size);
}

async function main() {
  mkdirSync(RUST_DIR, { recursive: true });
  const vmk = prngBytes(6000, 32).slice();
  const vaultId = prngBytes(6001, 16).slice();
  const wrapKey = await itemWrapKey(vmk, vaultId);
  const vectors = [];
  for (const [i, [id, size, chunkExp, type]] of CASES.entries()) {
    const seed = 6100 + i;
    const plain = prngBytes(seed, size);
    const itemId = prngBytes(seed ^ 0x1d, 16).slice();
    const fileKey = prngBytes(seed ^ 0x5eed, 32).slice();
    const streamSalt = crypto.getRandomValues(new Uint8Array(16));
    const meta = { name: `${id}.bin`, type, mtime: MTIME };
    const container = await collect(C._encryptStreamWith(pieces(plain), {
      size, meta, chunkExp, fileKey, streamSalt,
      stanzasFor: async (fk) => [await C.vaultStanza(fk, wrapKey, vaultId, itemId)],
    }));
    const file = `${id}.czd`;
    writeFileSync(path.join(RUST_DIR, file), container);
    const paddedSize = C.padme(size);
    vectors.push({
      id,
      file,
      size,
      paddedSize,
      n: Math.max(1, Math.ceil(paddedSize / 2 ** chunkExp)),
      chunkExp,
      headerLen: C.parseHeader(container).headerLen,
      containerSize: container.length,
      containerSha256: sha256(container),
      plaintextSha256: sha256(plain),
      fileKeyHex: toHex(fileKey),
      streamSaltHex: toHex(streamSalt),
      kind: 'vault',
      seed,
      itemIdHex: toHex(itemId),
      meta: { v: 1, ...meta, size },
    });
    console.log(`${file}: ${container.length} bytes, n = ${vectors.at(-1).n}`);
  }
  const json = {
    format: 'czd2 FORMAT v2 (DESIGN §3.3)',
    generator: 'scripts/gen-rust-vectors.mjs',
    note: 'Decrypt-only vectors for src-tauri/src/stream.rs (czstream). Vault items: itemWrapKey = HKDF-SHA256(vmk, salt = vaultId, "cZEROde czd2 vault item-wrap"). plaintext = prng(seed, size) as in czd2.json.',
    prng: 'mulberry32 (see czd2.json)',
    vmkHex: toHex(vmk),
    vaultIdHex: toHex(vaultId),
    vectors,
  };
  writeFileSync(RUST_JSON, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`wrote ${vectors.length} vectors to ${path.relative(ROOT, RUST_JSON)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
