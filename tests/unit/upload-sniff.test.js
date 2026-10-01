// ui/upload.js sniffFile (DESIGN §1.5): special files are recognised by their first bytes, never by name alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-phase0.js';
import { sniffFile } from '../../app/ui/upload.js';
import { encryptStream, makePassKek, passStanza } from '../../app/crypto/container.js';
import { CZB_MAGIC } from '../../app/vault/backup.js';

async function czd2Bytes() {
  const pk = await makePassKek('pw', { m: 64, t: 1, p: 1 });
  const data = new TextEncoder().encode('hello');
  const parts = [];
  for await (const p of encryptStream(data, { size: data.length, meta: { name: 'a.txt', type: 'text/plain' }, stanzasFor: async (fk) => [await passStanza(fk, pk)] })) parts.push(p);
  return parts;
}

test('czd2 containers are "czd2" whatever their name', async () => {
  const parts = await czd2Bytes();
  assert.equal(await sniffFile(new File(parts, 'x.czd')), 'czd2');
  assert.equal(await sniffFile(new File(parts, 'holiday.jpg', { type: 'image/jpeg' })), 'czd2');
});

test('backups are "czb" by their magic', async () => {
  assert.equal(await sniffFile(new File([CZB_MAGIC, new Uint8Array(100)], 'b.czb')), 'czb');
  assert.equal(await sniffFile(new File([CZB_MAGIC, new Uint8Array(100)], 'renamed.bin')), 'czb');
});

test('old desktop .czd files are "oldczd"; other JSON is an ordinary file', async () => {
  const old = readFileSync(path.join(ROOT, 'tests/fixtures/legacy/red-dot.czd'));
  assert.equal(await sniffFile(new File([old], 'red-dot.czd')), 'oldczd');
  assert.equal(await sniffFile(new File([old], 'red-dot.json')), 'oldczd'); // "type":"image" in the first bytes
  assert.equal(await sniffFile(new File(['﻿ {"v": 1, "cipher": "x"}'], 'any.dat')), 'oldczd');
  assert.equal(await sniffFile(new File(['{"v":1,"name":"settings","items":[1,2,3]}'], 'config.json')), null);
  assert.equal(await sniffFile(new File(['{"v":2,"type":"image"}'], 'x.czd')), null);
});

test('ordinary and tiny files are null', async () => {
  const png = readFileSync(path.join(ROOT, 'tests/fixtures/image.png'));
  assert.equal(await sniffFile(new File([png], 'image.png')), null);
  assert.equal(await sniffFile(new File(['hello world, plain text'], 'a.txt')), null);
  assert.equal(await sniffFile(new File([CZB_MAGIC.slice(0, 7)], 'short.czb')), null);
  assert.equal(await sniffFile(new File([], 'empty')), null);
  assert.equal(await sniffFile(null), null);
  assert.equal(await sniffFile('not a file'), null);
});
