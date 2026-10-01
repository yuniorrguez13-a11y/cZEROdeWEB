// app/errors.js: the code catalogue, CzdError, userMessage (§7.1), isCancel, toCzdError,
// and every CzdError('literal') in the shipped code uses a catalogued code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, frontendJs } from './helpers-phase0.js';
import { CODES, CzdError, isCancel, toCzdError, userMessage } from '../../app/errors.js';

const DESIGN_CODES = [
  'not-czd2', 'short-header', 'unsupported-version', 'unknown-flags', 'bad-chunk-size', 'bad-stanza-count', 'too-many-stanzas', 'bad-stanza', 'bad-meta',
  'unsupported-kdf', 'kdf-params-out-of-range', 'kdf-declined', 'kdf-out-of-memory', 'wrong-passphrase', 'no-usable-stanza', 'other-vault', 'item-mismatch',
  'vault-unwrap-failed', 'header-mac', 'meta-auth', 'size-mismatch', 'truncated', 'truncated-or-corrupt', 'chunk-auth', 'bad-padding', 'trailing-data',
  'source-size-mismatch', 'source-larger-than-size', 'aborted',
  'text-preset-unknown', 'not-cz-text',
  'no-vault', 'vault-exists', 'vault-locked', 'vault-changed', 'framed', 'other-tab', 'item-not-found', 'item-file-missing', 'item-tampered', 'quota-exceeded', 'store-unavailable', 'recovery-wrong',
  'not-czb', 'czb-version', 'czb-mac', 'czb-truncated',
  'legacy-not-ciphertext', 'legacy-wrong-pin', 'legacy-missing-chunks', 'legacy-bad-record', 'legacy-no-db',
  'too-big-to-preview', 'unsupported-media', 'picker-needs-gesture', 'share-unavailable', 'interrupted', 'browser-too-old',
  'not-implemented', 'internal'];

test('CODES is exactly the §10 list, frozen and unique', () => {
  assert.deepEqual([...CODES], DESIGN_CODES);
  assert.ok(Object.isFrozen(CODES));
  assert.equal(new Set(CODES).size, CODES.length);
});

test('CzdError carries code, detail and cause', () => {
  const cause = new Error('inner');
  const e = new CzdError('truncated', { cause, detail: { at: 7 } });
  assert.ok(e instanceof Error);
  assert.ok(e instanceof CzdError);
  assert.equal(e.name, 'CzdError');
  assert.equal(e.code, 'truncated');
  assert.equal(e.message, 'truncated');
  assert.deepEqual(e.detail, { at: 7 });
  assert.equal(e.cause, cause);
  const plain = new CzdError('internal');
  assert.equal(plain.detail, undefined);
  assert.ok(!('cause' in plain));
  assert.match(String(plain.stack), /CzdError/);
});

test('userMessage follows §7.1', () => {
  const damaged = 'This file is damaged or incomplete — ask for it again.';
  const notCzd = "That's not a cZEROde file (or it's damaged).";
  const badBackup = 'That backup file is damaged or not a cZEROde backup.';
  const table = {
    'wrong-passphrase': 'Wrong passphrase. Capital letters matter; spaces at the ends are ignored.',
    'not-czd2': notCzd, 'short-header': notCzd,
    'truncated': damaged, 'truncated-or-corrupt': damaged, 'chunk-auth': damaged, 'bad-padding': damaged,
    'trailing-data': damaged, 'header-mac': damaged, 'meta-auth': damaged, 'size-mismatch': damaged,
    'item-tampered': "This vault item was changed outside cZEROde and can't be trusted.",
    'quota-exceeded': 'Not enough storage space.',
    'too-big-to-preview': 'Too big to preview on this device — save it instead.',
    'unsupported-media': "This device can't show/play this file type.",
    'kdf-params-out-of-range': 'This file asks for more memory than is safe to use.',
    'kdf-declined': 'Cancelled.',
    'kdf-out-of-memory': 'Not enough memory on this device.',
    'vault-locked': 'Unlock your vault first.',
    'other-tab': 'cZEROde is open in another tab.',
    'store-unavailable': "This browser can't reach your vault storage (private window?).",
    'legacy-wrong-pin': 'Wrong PIN.',
    'legacy-missing-chunks': 'Parts of this old file are missing.',
    'not-czb': badBackup, 'czb-version': badBackup, 'czb-mac': badBackup, 'czb-truncated': badBackup,
    'interrupted': 'Interrupted — retry after unlock.',
  };
  for (const [code, msg] of Object.entries(table)) {
    assert.equal(userMessage(code), msg, code);
    assert.equal(userMessage(new CzdError(code)), msg, code);
  }
  assert.equal(userMessage('no-such-code'), 'Something went wrong.');
  assert.equal(userMessage('internal'), 'Something went wrong.');
  assert.equal(userMessage('not-implemented'), 'Something went wrong.');
  assert.equal(userMessage(new TypeError('x')), 'Something went wrong.');
  assert.equal(userMessage(undefined), 'Something went wrong.');
  assert.equal(userMessage(new DOMException('full', 'QuotaExceededError')), 'Not enough storage space.');
  assert.equal(userMessage('constructor'), 'Something went wrong.');
  for (const code of CODES) assert.equal(typeof userMessage(code), 'string');
});

test('isCancel: AbortError, aborted, kdf-declined', () => {
  assert.equal(isCancel(new DOMException('x', 'AbortError')), true);
  assert.equal(isCancel(new CzdError('aborted')), true);
  assert.equal(isCancel(new CzdError('kdf-declined')), true);
  assert.equal(isCancel('aborted'), true);
  assert.equal(isCancel(new CzdError('wrong-passphrase')), false);
  assert.equal(isCancel(new Error('aborted')), false);
  assert.equal(isCancel(null), false);
  assert.equal(isCancel(undefined), false);
  const ac = new AbortController();
  ac.abort();
  assert.equal(isCancel(ac.signal.reason), true);
});

test('toCzdError maps and wraps', () => {
  const c = new CzdError('truncated');
  assert.equal(toCzdError(c), c);
  const q = new DOMException('full', 'QuotaExceededError');
  const eq = toCzdError(q);
  assert.equal(eq.code, 'quota-exceeded');
  assert.equal(eq.cause, q);
  assert.equal(toCzdError(new DOMException('x', 'AbortError')).code, 'aborted');
  assert.equal(toCzdError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' }).code, 'quota-exceeded');
  const t = new TypeError('boom');
  const et = toCzdError(t);
  assert.equal(et.code, 'internal');
  assert.equal(et.cause, t);
  assert.equal(toCzdError('boom').code, 'internal');
  assert.equal(toCzdError('truncated').code, 'truncated');
  assert.equal(toCzdError(null).code, 'internal');
  assert.equal(toCzdError({ name: 'CzdError', code: 'header-mac', message: 'header-mac' }).code, 'header-mac');
  assert.equal(toCzdError({ name: 'CzdError', code: 'made-up' }).code, 'internal');
  assert.ok(toCzdError(t) instanceof CzdError);
});

test("every CzdError('literal') in the shipped code is a catalogued code", () => {
  const known = new Set(CODES);
  const re = /CzdError\(\s*(['"`])((?:(?!\1)[^\\])*)\1/g;
  const bad = [];
  let count = 0;
  for (const rel of frontendJs()) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(re)) {
      count++;
      if (m[1] === '`' && m[2].includes('${')) continue;
      if (!known.has(m[2])) bad.push(`${rel}: '${m[2]}'`);
    }
  }
  assert.ok(count > 0, 'the scan found no CzdError literals at all');
  assert.deepEqual(bad, []);
});
