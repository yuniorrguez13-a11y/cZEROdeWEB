// app/config.js values (DESIGN §10) and the vendored Argon2 build (DESIGN §3.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-phase0.js';
import { APP_URL, CAPS, CHUNK_EXP, RELEASES_URL, TIMES, VERSION } from '../../app/config.js';

test('config constants', () => {
  assert.equal(VERSION, '2.0.0');
  assert.equal(VERSION, JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version, 'package.json version matches');
  assert.equal(APP_URL, 'https://yuniorrguez13-a11y.github.io/cZEROdeWEB/');
  assert.equal(RELEASES_URL, 'https://github.com/yuniorrguez13-a11y/cZEROdeWEB/releases');
  assert.equal(CHUNK_EXP, 18);
  assert.deepEqual(CAPS, { image: 67108864, text: 2097152, blobDesktop: 536870912, blobMobile: 209715200, thumbEdge: 320, thumbBytes: 32768, bundleEntries: 2000, folderFiles: 10000, folderDepth: 8 });
  assert.deepEqual(TIMES, { undoMs: 8000, kdfCacheMs: 300000, swNeedMs: 2000, mediaFallbackMs: 5000, pickerSuspendMs: 600000, easterDebounceMs: 400 });
  assert.ok(Object.isFrozen(CAPS));
  assert.ok(Object.isFrozen(TIMES));
});

test('vendored hash-wasm argon2.umd.min.js is the pinned 4.12.0 build, with its license', () => {
  const js = readFileSync(path.join(ROOT, 'app/crypto/argon2.umd.min.js'));
  assert.equal(createHash('sha256').update(js).digest('hex'), 'dcec617a2e1b700fa132d1583a186cb70611113395e869f2dd6cc82b415d3094');
  const license = readFileSync(path.join(ROOT, 'app/crypto/LICENSE-hash-wasm.txt'), 'utf8');
  assert.match(license, /^MIT License/);
  assert.match(license, /Dani Bir/);
});
