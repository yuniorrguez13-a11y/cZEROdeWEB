// vault-grid pure helpers (DESIGN §1.5): filter chips, search, sort orders, album order, pending-delete hiding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILTERS, SORTS, matchesKind, metaLine, searchKey, visibleItems } from '../../app/ui/vault-grid.js';

const item = (id, name, kind, { size = 1, addedAt = 0, fav = false, mtime } = {}) => ({
  id: id.padStart(32, '0'), name, kind, type: 'x/y', size, addedAt, fav, mtime, storedBytes: 0, hasThumb: false,
});

const ITEMS = [
  item('1', 'Beach.jpg', 'image', { size: 300, addedAt: 10, fav: true }),
  item('2', 'song 10.mp3', 'audio', { size: 900, addedAt: 30 }),
  item('3', 'song 9.mp3', 'audio', { size: 100, addedAt: 20 }),
  item('4', 'notes', 'note', { size: 5, addedAt: 40 }),
  item('5', 'archive.zip', 'other', { size: 50, addedAt: 50 }),
  item('6', 'report.pdf', 'doc', { size: 70, addedAt: 60 }),
];

function fakeVault(items = ITEMS, lists = {}) {
  return {
    items: () => [...items].sort((a, b) => b.addedAt - a.addedAt),
    item: (id) => items.find((i) => i.id === id),
    list: (id) => {
      if (!lists[id]) throw new Error('item-not-found');
      return lists[id];
    },
  };
}

const names = (list) => list.map((i) => i.name);

test('chips cover every kind; ★ is favorites; Docs also lists files of no particular kind', () => {
  assert.deepEqual(FILTERS.map((f) => f.value), ['all', 'fav', 'image', 'video', 'audio', 'doc', 'note']);
  assert.deepEqual(SORTS.map((s) => s.value), ['new', 'old', 'name', 'size']);
  for (const i of ITEMS) assert.ok(FILTERS.some((f) => f.value !== 'all' && f.value !== 'fav' && matchesKind(i, f.value)), i.name);
  assert.equal(matchesKind(ITEMS[0], 'fav'), true);
  assert.equal(matchesKind(ITEMS[1], 'fav'), false);
  assert.equal(matchesKind(ITEMS[4], 'doc'), true);
  assert.equal(matchesKind(ITEMS[5], 'doc'), true);
  assert.equal(matchesKind(ITEMS[3], 'all'), true);
});

test('sort orders: newest, oldest, name (numeric-aware), size', () => {
  const v = fakeVault();
  assert.deepEqual(names(visibleItems(v, { sort: 'new' })), ['report.pdf', 'archive.zip', 'notes', 'song 10.mp3', 'song 9.mp3', 'Beach.jpg']);
  assert.deepEqual(names(visibleItems(v, { sort: 'old' })), ['Beach.jpg', 'song 9.mp3', 'song 10.mp3', 'notes', 'archive.zip', 'report.pdf']);
  assert.deepEqual(names(visibleItems(v, { sort: 'name' })), ['archive.zip', 'Beach.jpg', 'notes', 'report.pdf', 'song 9.mp3', 'song 10.mp3']);
  assert.deepEqual(names(visibleItems(v, { sort: 'size' })), ['song 10.mp3', 'Beach.jpg', 'song 9.mp3', 'report.pdf', 'archive.zip', 'notes']);
  assert.deepEqual(names(visibleItems(v, { sort: 'bogus' })), names(visibleItems(v, { sort: 'new' })));
});

test('kind filter, case-insensitive search and hidden (pending delete) items combine', () => {
  const v = fakeVault();
  assert.deepEqual(names(visibleItems(v, { kind: 'audio', sort: 'name' })), ['song 9.mp3', 'song 10.mp3']);
  assert.deepEqual(names(visibleItems(v, { query: '  SONG ', sort: 'name' })), ['song 9.mp3', 'song 10.mp3']);
  assert.deepEqual(names(visibleItems(v, { kind: 'audio', query: '10' })), ['song 10.mp3']);
  const hidden = new Set([ITEMS[1].id]);
  assert.deepEqual(names(visibleItems(v, { kind: 'audio' }, { isHidden: (id) => hidden.has(id) })), ['song 9.mp3']);
  assert.equal(searchKey('Ａ'.normalize('NFC')), 'ａ');
});

test('album mode keeps the album order, ignores the sort and skips missing items; a gone album shows nothing', () => {
  const lists = { a: { itemIds: [ITEMS[5].id, 'f'.repeat(32), ITEMS[0].id, ITEMS[2].id] } };
  const v = fakeVault(ITEMS, lists);
  assert.deepEqual(names(visibleItems(v, { albumId: 'a', sort: 'name' })), ['report.pdf', 'Beach.jpg', 'song 9.mp3']);
  assert.deepEqual(names(visibleItems(v, { albumId: 'a', kind: 'audio' })), ['song 9.mp3']);
  assert.deepEqual(visibleItems(v, { albumId: 'gone' }), []);
});

test('metaLine: size and the file date (else the date it was added); the year only when it is not this one', () => {
  const now = Date.UTC(2027, 5, 1, 12);
  const line = metaLine(item('9', 'x', 'doc', { size: 2048, addedAt: Date.UTC(2026, 9, 1, 12) }), now);
  assert.match(line, /^2 KB · .*2026/);
  assert.match(metaLine(item('9', 'x', 'doc', { size: 0, addedAt: 0, mtime: Date.UTC(2020, 0, 15, 12) }), now), /^0 B · .*2020/);
  const thisYear = metaLine(item('9', 'x', 'doc', { size: 2048, addedAt: Date.UTC(2027, 2, 3, 12) }), now);
  assert.match(thisYear, /^2 KB · \S/);
  assert.doesNotMatch(thisYear, /2027/);
});
