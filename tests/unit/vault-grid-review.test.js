// vault-grid display names (review pass): file names through safeFilename, note titles and album names as labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayName, labelText } from '../../app/ui/vault-grid.js';

test('a note title keeps its punctuation; a file name is made safe', () => {
  assert.equal(displayName({ name: 'To do: Monday?', kind: 'note' }), 'To do: Monday?');
  assert.equal(displayName({ name: 'a/b: c?.txt', kind: 'doc' }), 'a_b_ c_.txt');
  assert.equal(displayName({ name: 'CON.txt', kind: 'doc' }), '_CON.txt');
});

test('labels lose control and direction characters and are capped', () => {
  assert.equal(labelText('evil‮gpj.exe\u0007 '), 'evilgpj.exe');
  assert.equal(labelText('zero​width﻿'), 'zerowidth');
  assert.equal(labelText('x'.repeat(500)).length, 200);
  assert.equal(labelText(null), '');
  // An empty or all-invisible note title falls back to the safe file name ('file').
  assert.equal(displayName({ name: '​', kind: 'note' }), 'file');
});
