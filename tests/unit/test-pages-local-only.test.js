// GitHub Pages publishes tests/ too, and the test pages wipe vault databases on their origin. Every test page's
// entry script must import tests/local-only.js first so it refuses to run on the real site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function htmlPages(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await htmlPages(p));
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

test('every test page imports local-only.js before anything else', async () => {
  const pages = await htmlPages(path.join(root, 'tests'));
  assert.ok(pages.length >= 2);
  for (const page of pages) {
    const html = await readFile(page, 'utf8');
    const srcs = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(srcs.length, `${page} has an entry script`);
    for (const src of srcs) {
      const js = await readFile(path.resolve(path.dirname(page), src), 'utf8');
      const firstImport = js.match(/^import\s+[^\n]*$/m)?.[0] ?? '';
      assert.match(firstImport, /local-only\.js/, `${src} must import local-only.js first`);
    }
  }
});

test('local-only.js throws on a public host and passes on localhost', async () => {
  const code = await readFile(path.join(root, 'tests/local-only.js'), 'utf8');
  const ctx = (hostname) => {
    const sandbox = { location: { hostname } };
    sandbox.globalThis = sandbox;
    return () => vm.runInNewContext(code, sandbox);
  };
  assert.throws(ctx('yuniorrguez13-a11y.github.io'), /localhost/);
  assert.doesNotThrow(ctx('127.0.0.1'));
  assert.doesNotThrow(ctx('localhost'));
  assert.doesNotThrow(ctx('tauri.localhost'));
  assert.throws(ctx('localhost.example.com'), /localhost/);
});
