#!/usr/bin/env node
// Golden vector for the .czb v1 backup format (DESIGN §3.7, §8). Dev/CI tool; never staged into dist.
//
//   node scripts/gen-backup-vector.mjs              (re)writes tests/vectors/backup-v1.czb + backup-v1.json
//   node scripts/gen-backup-vector.mjs --out <dir>  writes them into <dir> instead (the tests regenerate and compare)
//
// Fully deterministic: crypto.getRandomValues is replaced by a SHA-256 counter DRBG (fixed seed) BEFORE any app module
// loads, the clock is fixed, the thumbnailer is a stub, and the vault is built through the real Vault API (real POLICY
// Argon2id, fake-indexeddb, MemoryStore). Plaintext comes from mulberry32 (same as scripts/gen-vectors.mjs).
// Regenerating the committed vector requires a note in docs/FORMAT.md. The tests only DECRYPT the committed file
// (and check that this script still reproduces it byte for byte).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = 'cZEROde backup-v1 golden vector';

/** The test passphrase (non-ASCII on purpose). */
export const PASSPHRASE = 'cZEROde backup vector ✓ 2.0';
const T0 = 1767225600000; // 2026-01-01T00:00:00Z

const sha256 = (u8) => createHash('sha256').update(u8).digest('hex');

/** mulberry32(seed), each step a u32 written little-endian (scripts/gen-vectors.mjs prngBytes). */
function prngBytes(seed, n) {
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

/** Deterministic getRandomValues: SHA-256(SEED ‖ counter) blocks. */
function installDrbg() {
  let counter = 0;
  let pool = new Uint8Array(0);
  globalThis.crypto.getRandomValues = (arr) => {
    const out = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    let o = 0;
    while (o < out.length) {
      if (!pool.length) pool = new Uint8Array(createHash('sha256').update(SEED).update(String(counter++)).digest());
      const n = Math.min(pool.length, out.length - o);
      out.set(pool.subarray(0, n), o);
      pool = pool.subarray(n);
      o += n;
    }
    return arr;
  };
}

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const dir = outIdx > 0 ? path.resolve(process.argv[outIdx + 1]) : path.join(ROOT, 'tests/vectors');
  installDrbg();
  const { IDBFactory, IDBKeyRange } = await import('fake-indexeddb');
  const { openVaultDb } = await import('../app/vault/db.js');
  const { MemoryStore } = await import('../app/vault/store.js');
  const { Vault } = await import('../app/vault/vault.js');
  const { POLICY } = await import('../app/crypto/kdf.js');
  const { toHex } = await import('../app/util/bytes.js');
  const { bytesSource } = await import('../app/util/stream.js');
  const { readBackupHeader } = await import('../app/vault/backup.js');

  let clock = T0;
  const now = () => (clock += 1000);
  const db = await openVaultDb({ idb: new IDBFactory(), IDBKeyRange });
  const store = new MemoryStore({ now: () => T0 });
  // Stub thumbnailer: a small fixed "JPEG" for images, a duration for audio.
  const thumbnailer = async (file, type) => {
    if (type.startsWith('image/')) return { jpeg: prngBytes(77, 1500), w: 640, h: 480 };
    if (type.startsWith('audio/')) return { jpeg: null, w: 0, h: 0, duration: 12.5 };
    return null;
  };
  const vault = new Vault({ db, openStore: async () => store, thumbnailer, now });
  await vault.init();
  const { recoveryCode } = await vault.create(PASSPHRASE);

  const photoBytes = prngBytes(1001, 50_000);
  const songBytes = prngBytes(1002, 300_001);
  const photo = await vault.addFile(new File([photoBytes], 'photo.jpg', { type: 'image/jpeg', lastModified: T0 - 86_400_000 }));
  const song = await vault.addFile(new File([songBytes], 'song.mp3', { type: 'audio/mpeg', lastModified: T0 - 3_600_000 }));
  const empty = await vault.addFile(new File([], 'empty.txt', { type: 'text/plain', lastModified: T0 }));
  const note = await vault.addNote({ title: 'Shopping', body: 'milk, eggs, 🍞' });
  await vault.rename(song.id, 'Song (renamed).mp3');
  await vault.setFavorite(photo.id, true);
  const album = await vault.createList({ name: 'Favourites', itemIds: [photo.id, note.id] });
  await vault.updateList(album.id, { cover: photo.id });

  const backup = await vault.exportBackup();
  const parts = [];
  for await (const p of backup.stream) parts.push(p);
  const bytes = Buffer.concat(parts);
  if (bytes.length !== backup.size) throw new Error(`size ${bytes.length} ≠ planned ${backup.size}`);

  const hdr = await readBackupHeader(bytesSource(new Uint8Array(bytes)));
  const plain = new Map([[photo.id, photoBytes], [song.id, songBytes], [empty.id, new Uint8Array(0)]]);
  const json = {
    format: 'czb-v1',
    generator: 'scripts/gen-backup-vector.mjs',
    note: 'Decrypt-only golden vector: restore with the passphrase (or the recovery code) and compare each item. Regenerating it requires a docs/FORMAT.md note.',
    passphrase: PASSPHRASE,
    recoveryCode,
    kdf: { ...POLICY },
    vaultIdHex: toHex(hdr.vaultId),
    createdAt: vault.lastBackupAt,
    size: bytes.length,
    sha256: sha256(bytes),
    items: vault.items().map((i) => ({
      id: i.id,
      name: i.name,
      type: i.type,
      kind: i.kind,
      size: i.size,
      fav: i.fav,
      hasThumb: i.hasThumb,
      ...(i.mtime !== undefined ? { mtime: i.mtime } : {}),
      ...(i.duration !== undefined ? { duration: i.duration } : {}),
      ...(plain.has(i.id) ? { sha256: sha256(plain.get(i.id)) } : {}),
    })),
    notes: [{ id: note.id, title: 'Shopping', body: 'milk, eggs, 🍞' }],
    lists: vault.lists(),
    thumbSha256: { [photo.id]: sha256(prngBytes(77, 1500)) },
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'backup-v1.czb'), bytes);
  writeFileSync(path.join(dir, 'backup-v1.json'), `${JSON.stringify(json, null, 2)}\n`);
  console.log(`backup-v1.czb: ${bytes.length} bytes, sha256 ${json.sha256} → ${dir}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
