// .czb v1 golden vector (tests/vectors/backup-v1.czb + backup-v1.json, DESIGN §3.7, §8): decrypt-only checks at the
// real POLICY parameters (passphrase and recovery code), and scripts/gen-backup-vector.mjs reproduces it byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveObjectURL } from 'node:buffer';
import { readBackupHeader } from '../../app/vault/backup.js';
import { POLICY } from '../../app/crypto/kdf.js';
import { decryptSource } from '../../app/crypto/container.js';
import { toHex } from '../../app/util/bytes.js';
import { bytesSource } from '../../app/util/stream.js';
import { collectBytes, makeVault } from './vault-helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CZB = new Uint8Array(readFileSync(path.join(ROOT, 'tests/vectors/backup-v1.czb')));
const JSON_TEXT = readFileSync(path.join(ROOT, 'tests/vectors/backup-v1.json'), 'utf8');
const VEC = JSON.parse(JSON_TEXT);
const sha256 = (u8) => createHash('sha256').update(u8).digest('hex');

test('backup-v1.czb: size and sha256 as recorded; header fields', async () => {
  assert.equal(CZB.length, VEC.size);
  assert.equal(sha256(CZB), VEC.sha256);
  const hdr = await readBackupHeader(bytesSource(CZB));
  assert.equal(toHex(hdr.vaultId), VEC.vaultIdHex);
  assert.equal(hdr.createdAt, VEC.createdAt);
  assert.deepEqual({ m: hdr.kdf.m, t: hdr.kdf.t, p: hdr.kdf.p }, { ...POLICY });
  assert.deepEqual(VEC.kdf, { ...POLICY });
  assert.ok(hdr.rwrap);
  assert.deepEqual(hdr.counts, { items: VEC.items.length, lists: VEC.lists.length, thumbs: Object.keys(VEC.thumbSha256).length });
});

async function checkRestored(v) {
  const items = v.items();
  assert.equal(items.length, VEC.items.length);
  for (const want of VEC.items) {
    const got = v.item(want.id);
    for (const k of ['name', 'type', 'kind', 'size', 'fav', 'hasThumb', 'mtime', 'duration']) assert.deepEqual(got[k], want[k], `${want.name}.${k}`);
    if (want.sha256) {
      const { src, opened } = await v.open(want.id);
      assert.equal(sha256(await collectBytes(decryptSource(src, opened))), want.sha256, want.name);
    }
  }
  for (const n of VEC.notes) assert.deepEqual(await v.readNote(n.id), { title: n.title, body: n.body });
  assert.deepEqual(v.lists(), VEC.lists);
  for (const [id, digest] of Object.entries(VEC.thumbSha256)) {
    const url = await v.thumbUrl(id);
    assert.equal(sha256(new Uint8Array(await resolveObjectURL(url).arrayBuffer())), digest);
  }
}

test('backup-v1.czb restores with its passphrase (real POLICY Argon2id) and every item matches', async () => {
  const { v } = await makeVault();
  assert.deepEqual(await v.restoreBackup(bytesSource(CZB), { pass: VEC.passphrase }, { mode: 'replace' }), { added: VEC.items.length, skipped: 0 });
  await checkRestored(v);
});

test('backup-v1.czb restores with its recovery code', async () => {
  const { v } = await makeVault();
  await v.restoreBackup(bytesSource(CZB), { code: VEC.recoveryCode }, { mode: 'replace' });
  await checkRestored(v);
});

test('scripts/gen-backup-vector.mjs reproduces the committed vector byte for byte', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'czb-vector-'));
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/gen-backup-vector.mjs'), '--out', dir], { cwd: ROOT, stdio: 'pipe' });
    assert.equal(sha256(readFileSync(path.join(dir, 'backup-v1.czb'))), VEC.sha256);
    assert.equal(readFileSync(path.join(dir, 'backup-v1.json'), 'utf8'), JSON_TEXT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
