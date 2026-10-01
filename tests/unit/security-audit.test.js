// Regressions from the final security audit: blank padding / invisible fillers in untrusted names (extension
// spoofing in ellipsized displays), the desktop capability keeping the old cZEROde 1 folder read only, and GitHub
// Actions hygiene (pinned actions, no persisted checkout credentials, no write token outside tag builds).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extOf, kindOf, safeFilename } from '../../app/util/format.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// ───────── names

test('safeFilename: blank padding cannot hide the real extension (NBSP, Unicode spaces, braille blank, fillers)', () => {
  const pads = [' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', '　', ' ', '⠀', 'ㅤ', 'ﾠ', 'ᅟ', 'ᅠ'];
  for (const p of pads) {
    const out = safeFilename(`invoice.pdf${p.repeat(80)}.exe`);
    const hex = p.charCodeAt(0).toString(16);
    // At most one plain space is left between the decoy and the real extension: it stays visible.
    assert.ok(out === 'invoice.pdf .exe' || out === 'invoice.pdf.exe', `U+${hex}: ${JSON.stringify(out)}`);
    assert.equal(extOf(out), 'exe', `U+${hex}`);
    assert.equal(kindOf('', out), 'other', `U+${hex}`);
  }
});

test('safeFilename: invisible fillers are removed (soft hyphen, CGJ, Khmer, Mongolian selectors)', () => {
  assert.equal(safeFilename('re­port͏.pdf'), 'report.pdf');
  assert.equal(safeFilename('a឴b឵c᠋d᠎e᠏f.txt'), 'abcdef.txt');
  assert.equal(safeFilename('ㅤㅤ'), 'file');
});

test('safeFilename: ordinary names keep single spaces and stay idempotent', () => {
  assert.equal(safeFilename('My Holiday Photo.jpg'), 'My Holiday Photo.jpg');
  assert.equal(safeFilename('two  spaces and nbsp.txt'), 'two spaces and nbsp.txt');
  const samples = ['a  b.txt', `x${'⠀'.repeat(300)}.png`, ' 　lead.md', 'tail  ', `con${' '.repeat(5)}.txt`,
    `${'q'.repeat(195)}   .jpeg`, '­­', 'ok (2).pdf'];
  for (const s of samples) {
    const once = safeFilename(s);
    assert.equal(safeFilename(once), once, JSON.stringify(s));
    assert.ok(once.length <= 200);
    assert.doesNotMatch(once, /\s{2,}/u, JSON.stringify(once));
  }
  assert.equal(safeFilename(`con${' '.repeat(5)}.txt`), '_con .txt', 'device names are still prefixed');
});

// ───────── desktop capability

test('capabilities: the old <AppData>/vault folder is read only (only exists/stat/read-dir/read-file reach it)', () => {
  const caps = JSON.parse(read('src-tauri/capabilities/default.json'));
  const OLD = ['$APPDATA/vault', '$APPDATA/vault/**'];
  const scoped = new Map();
  for (const p of caps.permissions) {
    if (typeof p !== 'object') continue;
    for (const a of p.allow ?? []) if (a.path) scoped.set(a.path, [...(scoped.get(a.path) ?? []), p.identifier]);
  }
  for (const o of OLD) {
    assert.deepEqual((scoped.get(o) ?? []).sort(), ['fs:allow-exists', 'fs:allow-read-dir', 'fs:allow-read-file', 'fs:allow-stat'], o);
  }
  const global = caps.permissions.find((p) => p.identifier === 'fs:scope');
  assert.ok(global.allow.every((a) => /^\$APPDATA\/vault2(\/\*\*)?$/.test(a.path)), 'the global fs scope is vault2 only');
  // No write-capable command may carry a scope of its own (it would widen the global vault2 scope).
  for (const p of caps.permissions) {
    if (typeof p === 'object' && /^fs:allow-(write|remove|rename|truncate|mkdir|open|copy|create)/.test(p.identifier)) {
      assert.equal(p.allow, undefined, `${p.identifier} must not have its own scope`);
    }
  }
  // The legacy desktop reader only needs those four commands.
  const platform = read('app/platform.js');
  const legacy = platform.slice(platform.indexOf('export async function listLegacyDesktopCzd'), platform.indexOf('// ───────── files opened with the app'));
  assert.match(legacy, /readFile\(/);
  assert.doesNotMatch(legacy, /writeFile|remove\(|rename\(|truncate\(|mkdir\(|\.open\(/);
});

// ───────── GitHub Actions

const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/desktop.yml'];

test('workflows: every action is pinned to a full commit SHA (with the tag in a comment)', () => {
  for (const wf of WORKFLOWS) {
    const uses = [...read(wf).matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/gm)];
    assert.ok(uses.length > 0, wf);
    for (const [, ref, rest] of uses) {
      assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${wf}: ${ref} is not pinned to a commit`);
      assert.match(rest, /#\s*\S+/, `${wf}: ${ref} needs a "# <tag>" comment`);
    }
  }
});

test('workflows: checkouts keep no credentials; least-privilege tokens; no untrusted input in run lines', () => {
  for (const wf of WORKFLOWS) {
    const text = read(wf);
    const lines = text.split('\n');
    lines.forEach((l, i) => {
      if (!/uses:\s*actions\/checkout@/.test(l)) return;
      const block = lines.slice(i + 1, i + 4).join('\n');
      assert.match(block, /with:\s*\n\s*persist-credentials:\s*false/, `${wf}:${i + 1} checkout must set persist-credentials: false`);
    });
    assert.match(text, /^permissions:\s*\n\s+contents:\s*read\s*$/m, `${wf}: workflow-level permissions are read-only`);
    assert.doesNotMatch(text, /pull_request_target/, `${wf}: no pull_request_target`);
    // Attacker-controllable event fields must never be expanded into a shell script.
    assert.doesNotMatch(text, /\$\{\{\s*github\.(event\.|head_ref)/, `${wf}: no event fields in expressions`);
  }
  const desk = read('.github/workflows/desktop.yml');
  const tokens = [...desk.matchAll(/GH_TOKEN:\s*(.+)$/gm)].map((m) => m[1].trim());
  const build = desk.slice(desk.indexOf('\n  build:'), desk.indexOf('\n  publish-release:'));
  const buildTokens = [...build.matchAll(/GITHUB_TOKEN:\s*(.+)$/gm)].map((m) => m[1].trim());
  assert.deepEqual(buildTokens, ["${{ startsWith(github.ref, 'refs/tags/v') && secrets.GITHUB_TOKEN || '' }}"],
    'the build step (which runs every dependency build script) gets the write token only on v* tags');
  assert.equal(tokens.length, 2, 'create-release and publish-release (tag-only jobs) still get their token');
  for (const job of ['create-release', 'publish-release']) {
    const body = desk.slice(desk.indexOf(`\n  ${job}:`));
    assert.match(body.slice(0, 200), /if: startsWith\(github\.ref, 'refs\/tags\/v'\)/, `${job} runs on v* tags only`);
  }
  assert.doesNotMatch(read('.github/workflows/ci.yml'), /secrets\./, 'ci.yml uses no secrets');
});
