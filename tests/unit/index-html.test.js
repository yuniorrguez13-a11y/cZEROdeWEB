// index.html shell: canonical CSP first in <head>, theme-boot before CSS, every view stylesheet,
// module entry point, and no inline script/style/handlers (DESIGN §2.2, §2.3, §2.6, §7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-phase0.js';

const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; "
  + "media-src 'self' blob: czstream: http://czstream.localhost https://czstream.localhost; font-src 'self'; "
  + "connect-src 'self' ipc: http://ipc.localhost; worker-src 'self'; manifest-src 'self'; object-src 'none'; "
  + "base-uri 'none'; form-action 'none'; frame-src 'none'";
const CSS = ['app', 'vault', 'viewer', 'player', 'upload', 'albums', 'send', 'text', 'legacy', 'settings', 'extras'].map((n) => `./css/${n}.css`);

const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const head = /<head>([\s\S]*)<\/head>/.exec(html)[1];
const body = /<body>([\s\S]*)<\/body>/.exec(html)[1];
const tags = [...head.matchAll(/<(meta|title|link|script)\b[^>]*>/g)].map((m) => ({ name: m[1], text: m[0], index: m.index }));
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
};

test('charset, viewport, then the canonical CSP meta', () => {
  assert.match(html, /^<!doctype html>\n<html lang="en">/);
  assert.equal(attr(tags[0].text, 'charset'), 'utf-8');
  assert.equal(attr(tags[1].text, 'name'), 'viewport');
  assert.doesNotMatch(attr(tags[1].text, 'content'), /user-scalable|maximum-scale/, 'no zoom lock');
  assert.equal(attr(tags[2].text, 'http-equiv'), 'Content-Security-Policy');
  assert.equal(attr(tags[2].text, 'content'), CSP);
  assert.equal(tags.filter((t) => /Content-Security-Policy/i.test(t.text)).length, 1);
});

// §2.3: tauri.conf.json carries the same policy, directive by directive, plus frame-ancestors 'none'.
// The file is created by C2 (phase 1); until then there is nothing to compare.
const TAURI_CONF = path.join(ROOT, 'src-tauri/tauri.conf.json');
const parseCsp = (csp) => {
  const entries = typeof csp === 'string'
    ? csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v]; })
    : Object.entries(csp).map(([k, v]) => [k, Array.isArray(v) ? v : String(v).split(/\s+/).filter(Boolean)]);
  const map = new Map();
  for (const [k, v] of entries) {
    assert.ok(!map.has(k.toLowerCase()), `duplicate CSP directive ${k}`);
    map.set(k.toLowerCase(), [...v].sort());
  }
  return map;
};
test('tauri.conf.json CSP equals the canonical policy plus frame-ancestors', { skip: !existsSync(TAURI_CONF) && 'src-tauri/tauri.conf.json does not exist yet' }, () => {
  const conf = JSON.parse(readFileSync(TAURI_CONF, 'utf8'));
  const tauri = parseCsp(conf.app?.security?.csp ?? '');
  assert.deepEqual(tauri.get('frame-ancestors'), ["'none'"]);
  tauri.delete('frame-ancestors');
  assert.deepEqual(Object.fromEntries(tauri), Object.fromEntries(parseCsp(CSP)));
});

test('title, manifest, icons, theme-color', () => {
  assert.match(head, /<title>cZEROde<\/title>/);
  assert.ok(tags.some((t) => attr(t.text, 'rel') === 'manifest' && attr(t.text, 'href') === './manifest.webmanifest'));
  assert.ok(tags.some((t) => attr(t.text, 'name') === 'theme-color' && attr(t.text, 'content') === '#0d0d0d'));
  assert.ok(tags.some((t) => attr(t.text, 'rel') === 'icon'));
  assert.ok(tags.some((t) => attr(t.text, 'rel') === 'apple-touch-icon'));
});

test('theme-boot (classic, sync) before the stylesheets; every view stylesheet; module entry last', () => {
  const scripts = tags.filter((t) => t.name === 'script');
  assert.deepEqual(scripts.map((t) => t.text), ['<script src="./app/theme-boot.js">', '<script type="module" src="./app/main.js">']);
  const sheets = tags.filter((t) => t.name === 'link' && attr(t.text, 'rel') === 'stylesheet');
  assert.deepEqual(sheets.map((t) => attr(t.text, 'href')), CSS);
  assert.ok(scripts[0].index < sheets[0].index, 'theme-boot runs before the first stylesheet');
  assert.ok(scripts[1].index > sheets.at(-1).index);
  const onDisk = readdirSync(path.join(ROOT, 'css')).filter((f) => f.endsWith('.css')).map((f) => `./css/${f}`).sort();
  assert.deepEqual(onDisk, [...CSS].sort(), 'every css/*.css file is linked');
});

test('body is the app root plus noscript', () => {
  assert.match(body, /^\s*<div id="app"><\/div>\s*<noscript>[^<]+<\/noscript>\s*$/);
});

test('no inline script, style, handlers or style attributes', () => {
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    assert.ok(/\ssrc="/.test(m[0]), 'every script has src');
    assert.equal(m[1], '', 'script elements are empty');
  }
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /javascript:/i);
});

test('every local file referenced by index.html exists', () => {
  const refs = [...html.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 15);
  for (const ref of refs) {
    assert.match(ref, /^\.\//, `relative reference: ${ref}`);
    assert.ok(existsSync(path.join(ROOT, ref)), `missing ${ref}`);
  }
});

test('view stylesheets declare their owner and prefix', () => {
  const prefixes = { vault: '.vv-', viewer: '.vw-', player: '.pl-', upload: '.up-', albums: '.al-', send: '.sd-', text: '.tx-', legacy: '.lg-', settings: '.st-' };
  for (const [file, prefix] of Object.entries(prefixes)) {
    const css = readFileSync(path.join(ROOT, `css/${file}.css`), 'utf8');
    assert.match(css, /Owner: /);
    assert.ok(css.includes(prefix), `${file}.css names ${prefix}`);
  }
  const extras = readFileSync(path.join(ROOT, 'css/extras.css'), 'utf8');
  for (const p of ['.cz-', '.tu-', '.eg-', '.sh-']) assert.ok(extras.includes(p));
});
