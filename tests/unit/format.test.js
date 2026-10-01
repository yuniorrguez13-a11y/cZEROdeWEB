// util/format.js: sizes/dates/durations, the kindOf/viewerMode classifiers, safeMediaType and the
// hostile-name rules of safeFilename (DESIGN §2.2, §10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtSize, fmtDate, fmtDuration, kindOf, viewerMode, safeMediaType, safeFilename, extOf, mimeFromExt,
  randomExportName, contentDisposition, dedupeName, NOTE_TYPE,
} from '../../app/util/format.js';

test('fmtSize', () => {
  assert.equal(fmtSize(0), '0 B');
  assert.equal(fmtSize(1), '1 B');
  assert.equal(fmtSize(1023), '1023 B');
  assert.equal(fmtSize(1024), '1 KB');
  assert.equal(fmtSize(1536), '1.5 KB');
  assert.equal(fmtSize(10 * 1024), '10 KB');
  assert.equal(fmtSize(512 * 1024), '512 KB');
  assert.equal(fmtSize(1024 * 1024 - 1), '1 MB', 'rounding up to the next unit');
  assert.equal(fmtSize(5.25 * 2 ** 20), '5.3 MB');
  assert.equal(fmtSize(1.25 * 2 ** 30), '1.3 GB');
  assert.equal(fmtSize(3 * 2 ** 40), '3 TB');
  for (const bad of [-1, NaN, Infinity, '12', null, undefined]) assert.equal(fmtSize(bad), '—');
});

test('fmtDate', () => {
  const s = fmtDate(Date.UTC(2026, 9, 1, 12));
  assert.ok(s.includes('2026'), s);
  assert.equal(fmtDate(NaN), '');
  assert.equal(fmtDate('x'), '');
  assert.equal(fmtDate(8.64e15 + 1), '', 'out of Date range');
});

test('fmtDuration', () => {
  assert.equal(fmtDuration(0), '0:00');
  assert.equal(fmtDuration(5.9), '0:05');
  assert.equal(fmtDuration(65), '1:05');
  assert.equal(fmtDuration(3599), '59:59');
  assert.equal(fmtDuration(3600), '1:00:00');
  assert.equal(fmtDuration(36000 + 61), '10:01:01');
  for (const bad of [-1, NaN, Infinity, '3']) assert.equal(fmtDuration(bad), '');
});

test('extOf and mimeFromExt', () => {
  assert.equal(extOf('photo.JPG'), 'jpg');
  assert.equal(extOf('archive.tar.gz'), 'gz');
  assert.equal(extOf('README'), '');
  assert.equal(extOf('.bashrc'), '', 'dotfiles have no extension');
  assert.equal(extOf('name.'), '');
  assert.equal(extOf('my file.with spaces'), '', 'implausible extension');
  assert.equal(extOf('x.' + 'a'.repeat(40)), '');
  assert.equal(extOf(42), '');
  assert.equal(mimeFromExt('jpg'), 'image/jpeg');
  assert.equal(mimeFromExt('.PNG'), 'image/png');
  assert.equal(mimeFromExt('mp3'), 'audio/mpeg');
  assert.equal(mimeFromExt('webm'), 'video/webm');
  assert.equal(mimeFromExt('czd'), 'application/x-czeroode');
  assert.equal(mimeFromExt('czb'), 'application/x-czeroode-backup');
  assert.equal(mimeFromExt('nope'), 'application/octet-stream');
  assert.equal(mimeFromExt('__proto__'), 'application/octet-stream');
  assert.equal(mimeFromExt(null), 'application/octet-stream');
});

test('kindOf: the only classifier (type first, extension when the type is missing/generic)', () => {
  assert.equal(kindOf('image/png', 'x'), 'image');
  assert.equal(kindOf('image/heic', 'IMG_1.HEIC'), 'image');
  assert.equal(kindOf('video/mp4', 'a'), 'video');
  assert.equal(kindOf('audio/ogg; codecs=opus', 'a'), 'audio');
  assert.equal(kindOf('application/pdf', 'a'), 'doc');
  assert.equal(kindOf('text/plain', 'a'), 'doc');
  assert.equal(kindOf('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a'), 'doc');
  assert.equal(kindOf('image/svg+xml', 'a.svg'), 'doc', 'SVG is never treated as an image');
  assert.equal(kindOf(NOTE_TYPE, 'note'), 'note');
  assert.equal(kindOf('', 'clip.MOV'), 'video');
  assert.equal(kindOf('application/octet-stream', 'song.flac'), 'audio');
  assert.equal(kindOf(undefined, 'scan.pdf'), 'doc');
  assert.equal(kindOf('', 'README'), 'other');
  assert.equal(kindOf('application/zip', 'a.zip'), 'other');
  assert.equal(kindOf('garbage', 'a.jpg'), 'image', 'invalid type falls back to the extension');
  assert.equal(kindOf('IMAGE/PNG', 'a'), 'image');
  assert.equal(kindOf('application/x-czd-note', 'a.jpg'), 'note');
});

test('viewerMode', () => {
  assert.equal(viewerMode('image/jpeg', 'a.jpg', 1000), 'image');
  assert.equal(viewerMode('image/jpg', 'a.jpg', 1000), 'image');
  assert.equal(viewerMode('image/png', 'a.png', 65 * 2 ** 20), 'none', 'above CAPS.image');
  assert.equal(viewerMode('image/heic', 'a.heic', 10), 'none', 'not a safe image type');
  assert.equal(viewerMode('image/svg+xml', 'a.svg', 10), 'text', 'SVG shown as text');
  assert.equal(viewerMode('audio/mpeg', 'a.mp3', 10), 'audio');
  assert.equal(viewerMode('video/webm', 'a.webm', 10), 'video');
  assert.equal(viewerMode('text/html', 'a.html', 10), 'text');
  assert.equal(viewerMode('application/json', 'a', 10), 'text');
  assert.equal(viewerMode('', 'notes.md', 10), 'text');
  assert.equal(viewerMode('', 'big.txt', 50 * 2 ** 20), 'text', 'text is previewed truncated, never refused');
  assert.equal(viewerMode('application/pdf', 'a.pdf', 10), 'none');
  assert.equal(viewerMode(NOTE_TYPE, 'n', 10), 'note');
  assert.equal(viewerMode('application/octet-stream', 'blob', 10), 'none');
});

test('safeMediaType', () => {
  assert.equal(safeMediaType('image/png'), 'image/png');
  assert.equal(safeMediaType('IMAGE/JPEG'), 'image/jpeg');
  assert.equal(safeMediaType('image/jpg'), 'image/jpeg');
  assert.equal(safeMediaType('image/avif'), 'image/avif');
  assert.equal(safeMediaType('image/bmp'), 'image/bmp');
  assert.equal(safeMediaType('image/svg+xml'), 'application/octet-stream');
  assert.equal(safeMediaType('image/heic'), 'application/octet-stream');
  assert.equal(safeMediaType('audio/ogg; codecs=opus'), 'audio/ogg');
  assert.equal(safeMediaType('video/x-matroska'), 'video/x-matroska');
  assert.equal(safeMediaType('text/html'), 'application/octet-stream');
  assert.equal(safeMediaType('application/javascript'), 'application/octet-stream');
  assert.equal(safeMediaType('video/mp4\r\nX-Evil: 1'), 'application/octet-stream');
  assert.equal(safeMediaType('audio/' + 'a'.repeat(61)), 'application/octet-stream');
  assert.equal(safeMediaType('video/../../x'), 'application/octet-stream');
  assert.equal(safeMediaType(''), 'application/octet-stream');
  assert.equal(safeMediaType(null), 'application/octet-stream');
  assert.equal(safeMediaType({ toString: () => 'image/png' }), 'application/octet-stream');
});

test('safeFilename: control, zero-width and bidi characters are stripped (RLO spoofing)', () => {
  assert.equal(safeFilename('photo\u202egpj.exe'), 'photogpj.exe');
  assert.equal(safeFilename('a\u200bb\u200fc\u2066d\u2069e\ufefff\u061cg'), 'abcdefg');
  assert.equal(safeFilename('line\nbreak\ttab\u0000nul\u007fdel\u0085nel'), 'linebreaktabnuldelnel');
  assert.equal(safeFilename('para\u2028sep\u2029x'), 'parasepx');
  assert.equal(safeFilename('\u202a\u202b\u202c\u202d\u202e'), 'file');
});

test('safeFilename: separators and reserved characters', () => {
  assert.equal(safeFilename('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(safeFilename('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(safeFilename('..\\..\\windows\\system32'), '_.._windows_system32');
  assert.equal(safeFilename('/'), '_');
});

test('safeFilename: dots and spaces trimmed at both ends', () => {
  assert.equal(safeFilename('  report.pdf  '), 'report.pdf');
  assert.equal(safeFilename('...hidden...'), 'hidden');
  assert.equal(safeFilename('.bashrc'), 'bashrc');
  assert.equal(safeFilename('name. . .'), 'name');
  assert.equal(safeFilename('\u3000wide\u00a0'), 'wide');
  assert.equal(safeFilename('.'), 'file');
  assert.equal(safeFilename('..'), 'file');
});

test('safeFilename: Windows device names get a "_" prefix', () => {
  for (const n of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'com9', 'LPT1', 'LPT9', 'COM¹']) assert.equal(safeFilename(n), `_${n}`, n);
  assert.equal(safeFilename('con.txt'), '_con.txt');
  assert.equal(safeFilename('NUL.tar.gz'), '_NUL.tar.gz');
  assert.equal(safeFilename('LPT1 .txt'), '_LPT1 .txt');
  for (const n of ['CONSOLE.txt', 'COM10', 'prn2', 'icon.png', 'aux_file']) assert.equal(safeFilename(n), n, n);
});

test('safeFilename: ≤ 200 UTF-16 units, keeping the extension and surrogate pairs', () => {
  const long = 'x'.repeat(300) + '.jpeg';
  const out = safeFilename(long);
  assert.equal(out.length, 200);
  assert.ok(out.endsWith('.jpeg'));
  const emoji = '😀'.repeat(150) + '.png'; // 300 units + ext
  const e = safeFilename(emoji);
  assert.ok(e.length <= 200);
  assert.ok(e.endsWith('.png'));
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(e), 'no lone high surrogate');
  const noExt = 'y'.repeat(250);
  assert.equal(safeFilename(noExt).length, 200);
  const hugeExt = 'z.' + 'q'.repeat(250);
  assert.equal(safeFilename(hugeExt).length, 200);
  const dotsAtCut = 'a'.repeat(190) + '.'.repeat(20) + 'b'.repeat(20) + '.txt';
  const d = safeFilename(dotsAtCut);
  assert.ok(d.length <= 200 && d.endsWith('.txt'));
});

test('safeFilename: empty, non-strings, lone surrogates, NFC', () => {
  assert.equal(safeFilename(''), 'file');
  assert.equal(safeFilename('   '), 'file');
  assert.equal(safeFilename(null), 'file');
  assert.equal(safeFilename(undefined), 'file');
  assert.equal(safeFilename(123), '123');
  assert.equal(safeFilename('a\ud800b'), 'a\ufffdb');
  assert.equal(safeFilename('\udc00'), '\ufffd');
  assert.equal(safeFilename('e\u0301.txt'), 'é.txt');
  assert.equal(safeFilename('e\u200b\u0301'), 'é', 'stripping before NFC composes');
  assert.equal(safeFilename('<img src=x onerror=alert(1)>.mp3'), '_img src=x onerror=alert(1)_.mp3', 'rendered as text anyway');
});

test('safeFilename is idempotent', () => {
  const samples = ['photo\u202egpj.exe', 'CON', '  ..x.. ', 'a'.repeat(300) + '.jpeg', '😀'.repeat(150) + '.png', 'e\u200b\u0301',
    'NUL.tar.gz', '..\\..\\x', 'z.' + 'q'.repeat(250), '', 'normal name (2).txt', 'x'.repeat(199) + '.', '_'.repeat(5)];
  for (const s of samples) {
    const once = safeFilename(s);
    assert.equal(safeFilename(once), once, JSON.stringify(s));
    assert.ok(once.length >= 1 && once.length <= 200);
  }
});

test('randomExportName', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const n = randomExportName();
    assert.match(n, /^cz-[a-z2-7]{8}\.czd$/);
    seen.add(n);
  }
  assert.ok(seen.size > 45, 'random');
});

test('contentDisposition: RFC 5987 encoding of the sanitized name', () => {
  assert.equal(contentDisposition('report.pdf'), "attachment; filename*=UTF-8''report.pdf");
  assert.equal(contentDisposition('naïve café.txt'), "attachment; filename*=UTF-8''na%C3%AFve%20caf%C3%A9.txt");
  assert.equal(contentDisposition("it's (1).txt"), "attachment; filename*=UTF-8''it%27s%20%281%29.txt");
  assert.equal(contentDisposition('a"b\r\nSet-Cookie: x.txt'), "attachment; filename*=UTF-8''a_bSet-Cookie_%20x.txt");
  assert.equal(contentDisposition(''), "attachment; filename*=UTF-8''file");
  assert.equal(contentDisposition('😀.png'), "attachment; filename*=UTF-8''%F0%9F%98%80.png");
  const v = contentDisposition('x\ud800y');
  assert.match(v, /^attachment; filename\*=UTF-8''[A-Za-z0-9%._~!-]+$/);
  // Only RFC 5987 attr-chars or percent escapes after the prefix.
  for (const name of ['a*b', "q'uote", 'pa(ren)', 'sp ace', 'semi;colon', 'comma,x', 'eq=x']) {
    assert.match(contentDisposition(name), /^attachment; filename\*=UTF-8''(?:[A-Za-z0-9!#$&+.^_`|~-]|%[0-9A-F]{2})+$/, name);
  }
});

test('dedupeName', () => {
  const taken = new Set(['a.txt', 'a (2).txt', 'README']);
  assert.equal(dedupeName('b.txt', taken), 'b.txt');
  assert.ok(taken.has('b.txt'), 'adds the result');
  assert.equal(dedupeName('a.txt', taken), 'a (3).txt');
  assert.equal(dedupeName('a.txt', taken), 'a (4).txt');
  assert.equal(dedupeName('README', taken), 'README (2)');
  assert.equal(dedupeName('archive.tar.gz', new Set(['archive.tar.gz'])), 'archive.tar (2).gz');
  const long = 'x'.repeat(196) + '.jpg';
  const out = dedupeName(long, new Set([long]));
  assert.ok(out.length <= 200 && out.endsWith(' (2).jpg'), out);
});

// ───────── review regressions (C1 adversarial review)

test('safeFilename: a device name that also hits the 200-unit cap keeps its extension', () => {
  for (const n of [196, 197, 200, 260]) {
    const name = `con.${'a'.repeat(n)}.txt`;
    const out = safeFilename(name);
    assert.ok(out.length <= 200, `${n}: ${out.length}`);
    assert.ok(out.startsWith('_con.'), `${n}: prefixed`);
    assert.ok(out.endsWith('.txt'), `${n}: kept the extension, got …${out.slice(-6)}`);
    assert.equal(safeFilename(out), out, 'idempotent');
  }
  // Cutting the stem can expose a device name ("con……….txt" → "con.txt"): still prefixed.
  const dotted = `con${'.'.repeat(300)}.txt`;
  assert.equal(safeFilename(dotted), '_con.txt');
  // Blank runs collapse to one space before the cap (security audit): the device name is still prefixed.
  const spaced = `con${' '.repeat(300)}.txt`;
  assert.equal(safeFilename(spaced), '_con .txt');
});

test('safeFilename: invisible format characters are stripped too', () => {
  assert.equal(safeFilename('a⁠b⁡c⁢d⁣e⁤f.txt'), 'abcdef.txt');
  assert.equal(safeFilename('x⁪y⁯z￹w￻.png'), 'xyzw.png');
});

test('fmtSize: fractional byte counts (speeds) never show "1024 B"', () => {
  assert.equal(fmtSize(1023.6), '1 KB');
  assert.equal(fmtSize(1023.4), '1023 B');
  assert.equal(fmtSize(0.4), '0 B');
});
