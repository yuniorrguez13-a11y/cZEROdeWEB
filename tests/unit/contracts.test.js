// Module contracts (DESIGN §10): every documented export exists with the right type and arity.
// Expected names live in contracts.json; this test also checks that contracts.json covers every
// importable module under app/ (all but main.js, theme-boot.js, the workers and vendored files).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, listFiles } from './helpers-phase0.js';

const spec = JSON.parse(readFileSync(path.join(ROOT, 'tests/unit/contracts.json'), 'utf8')).modules;
// Browser-only scripts (no Node import): entry point, classic theme script, workers, vendored UMD.
const NOT_IMPORTABLE = new Set(['app/main.js', 'app/theme-boot.js', 'app/crypto/kdf-worker.js', 'app/vault/opfs-worker.js', 'app/crypto/argon2.umd.min.js']);
const expand = (dir, names, ext = '.js') => names.map((n) => `${dir}/${n}${ext}`);
// DESIGN §2.1: every app/ file of the layout.
const LAYOUT_APP = [
  ...expand('app', ['main', 'theme-boot', 'config', 'errors', 'types', 'platform', 'pwa', 'router', 'state', 'settings']),
  ...expand('app/util', ['bytes', 'format', 'dom', 'stream']),
  'app/crypto/argon2.umd.min.js', 'app/crypto/LICENSE-hash-wasm.txt',
  ...expand('app/crypto', ['kdf', 'kdf-worker', 'stealth', 'container', 'textfmt', 'passphrase', 'wordlist']),
  ...expand('app/legacy', ['v4', 'mixed', 'oldvault', 'oldczd']),
  ...expand('app/vault', ['db', 'store', 'opfs-worker', 'vault', 'backup', 'thumbs', 'autolock', 'boot']),
  'app/media/media.js',
  ...expand('app/ui', ['shell', 'components', 'easter', 'codzilla', 'tutorial', 'vault-view', 'vault-grid', 'upload', 'albums', 'viewer', 'player',
    'send-view', 'text-view', 'legacy-view', 'more-view', 'settings-view']),
];

const isClass = (v) => typeof v === 'function' && /^class\b/.test(Function.prototype.toString.call(v));
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

function checkArity(where, fn, arity) {
  if (!arity) return;
  const [min, max] = arity;
  assert.ok(fn.length >= min && fn.length <= max, `${where}: Function.length ${fn.length} not in [${min}, ${max}]`);
}

// How §10 declares the function: `function`, `async function` or `async function*`.
const KINDS = {
  sync: ['Function'],
  async: ['AsyncFunction'],
  asyncgen: ['AsyncGeneratorFunction'],
  promise: ['Function', 'AsyncFunction'],
};
function checkKind(where, fn, kind) {
  if (!kind) return;
  assert.ok(kind in KINDS, `${where}: unknown contract kind ${kind}`);
  const actual = Object.getPrototypeOf(fn).constructor.name;
  assert.ok(KINDS[kind].includes(actual), `${where}: DESIGN §10 declares it as ${kind === 'sync' ? 'a plain (non-async, non-generator)' : kind} function, got ${actual}`);
}

function checkExport(where, v, c) {
  switch (c.type) {
    case 'function':
      assert.equal(typeof v, 'function', `${where}: expected a function`);
      assert.ok(!isClass(v), `${where}: expected a function, got a class`);
      checkArity(where, v, c.arity);
      checkKind(where, v, c.kind);
      break;
    case 'class':
      assert.ok(isClass(v), `${where}: expected a class`);
      break;
    case 'array':
      assert.ok(Array.isArray(v), `${where}: expected an array`);
      break;
    case 'set':
      assert.ok(v instanceof Set, `${where}: expected a Set`);
      break;
    case 'uint8array':
      assert.ok(v instanceof Uint8Array, `${where}: expected a Uint8Array`);
      break;
    case 'object':
      assert.ok(v !== null && typeof v === 'object' && !Array.isArray(v), `${where}: expected a plain object`);
      break;
    case 'string':
    case 'number':
    case 'boolean':
      assert.equal(typeof v, c.type, `${where}: expected a ${c.type}`);
      break;
    case 'any':
      break;
    default:
      assert.fail(`${where}: unknown contract type ${c.type}`);
  }
  if ('value' in c) {
    const actual = v instanceof Uint8Array ? Array.from(v) : v;
    assert.deepEqual(actual, c.value, `${where}: value differs from DESIGN §10`);
  }
  for (const [m, mc] of Object.entries(c.members ?? {})) {
    assert.ok(m in v, `${where}.${m}: missing`);
    checkExport(`${where}.${m}`, v[m], mc);
  }
}

function checkMethods(where, proto, methods) {
  for (const [m, { arity, kind }] of Object.entries(methods)) {
    assert.equal(typeof proto[m], 'function', `${where}.${m}: missing method`);
    checkArity(`${where}.${m}`, proto[m], arity);
    checkKind(`${where}.${m}`, proto[m], kind);
  }
}

test('every §2.1 app file exists', () => {
  for (const f of LAYOUT_APP) assert.ok(existsSync(path.join(ROOT, f)), `missing ${f}`);
});

test('contracts.json covers exactly the importable §2.1 modules', () => {
  const importable = LAYOUT_APP.filter((f) => f.endsWith('.js') && !NOT_IMPORTABLE.has(f)).sort();
  assert.deepEqual(Object.keys(spec).sort(), importable);
});

test('contracts.json gives every exported function and class method a kind', () => {
  const missing = [];
  for (const [rel, exportsSpec] of Object.entries(spec)) {
    for (const [name, c] of Object.entries(exportsSpec)) {
      if (c.type === 'function' && !c.kind) missing.push(`${rel}#${name}`);
      for (const [m, mc] of Object.entries(c.methods ?? {})) if (!mc.kind) missing.push(`${rel}#${name}.${m}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every app module (including helpers added later) imports in Node without a DOM', async () => {
  for (const f of listFiles('app').filter((x) => !NOT_IMPORTABLE.has(x))) {
    await assert.doesNotReject(load(f), f);
  }
});

for (const [rel, exportsSpec] of Object.entries(spec)) {
  test(`${rel} exports match DESIGN §10`, async () => {
    const ns = await load(rel);
    for (const [name, c] of Object.entries(exportsSpec)) {
      assert.ok(name in ns, `${rel}: missing export ${name}`);
      checkExport(`${rel}#${name}`, ns[name], c);
    }
    if (rel === 'app/types.js') assert.deepEqual(Object.keys(ns), [], 'types.js holds typedefs only');
  });
}

test('Vault class: EventTarget, methods, instance fields', async () => {
  const { Vault } = await load('app/vault/vault.js');
  const c = spec['app/vault/vault.js'].Vault;
  assert.ok(Vault.prototype instanceof EventTarget);
  checkMethods('Vault', Vault.prototype, c.methods);
  const v = new Vault({ db: {}, openStore: async () => null });
  for (const p of c.instanceProps) assert.ok(p in v, `Vault#${p}: missing`);
});

test('vault singleton is a live binding set by setVault', async () => {
  const mod = await load('app/vault/vault.js');
  assert.equal(mod.vault, null);
  const marker = { marker: true };
  mod.setVault(marker);
  assert.equal(mod.vault, marker);
  mod.setVault(null);
  assert.equal(mod.vault, null);
});

test('MemoryStore implements the ContainerStore methods', async () => {
  const { MemoryStore } = await load('app/vault/store.js');
  const c = spec['app/vault/store.js'].MemoryStore;
  checkMethods('MemoryStore', MemoryStore.prototype, c.methods);
  const s = new MemoryStore();
  for (const p of c.instanceProps) assert.ok(p in s, `MemoryStore#${p}: missing`);
  assert.equal(typeof s.kind, 'string');
});
