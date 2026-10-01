// DESIGN §2.2: no HTML-string sinks, inline handler/style attributes or dynamic code anywhere in the
// shipped JavaScript, and localStorage only through settings.js. Comments count too: name the rule, not the sink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, frontendJs } from './helpers-phase0.js';

const SINKS = [
  ['innerHTML', /\binnerHTML\b/],
  ['outerHTML', /\bouterHTML\b/],
  ['insertAdjacentHTML', /\binsertAdjacentHTML\b/],
  ['document.write', /\bdocument\s*\.\s*write(?:ln)?\b/],
  ['createContextualFragment', /\bcreateContextualFragment\b/],
  ['srcdoc', /\bsrcdoc\b/],
  ['new Function', /\bnew\s+Function\b/],
  ['eval(', /\beval\s*\(/],
  ['string setTimeout/setInterval', /\bset(?:Timeout|Interval)\s*\(\s*['"`]/],
  ['on*/style attribute', /\bsetAttribute(?:NS)?\s*\(\s*(?:[^,()]+,\s*)??['"`](?:style|on[a-z]+)['"`]/i],
];

function scan(re, allow = new Set()) {
  const hits = [];
  for (const rel of frontendJs()) {
    if (allow.has(rel)) continue;
    const lines = readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (re.test(line)) hits.push(`${rel}:${i + 1}`);
    });
  }
  return hits;
}

test('no HTML-string sinks, inline handler/style attributes or dynamic code in app code', () => {
  const hits = [];
  for (const [name, re] of SINKS) for (const h of scan(re)) hits.push(`${h}: ${name}`);
  assert.deepEqual(hits, []);
});

test('the sink patterns match what they are meant to catch', () => {
  const bad = ['el.innerHTML = s', 'x.outerHTML', "el.insertAdjacentHTML('beforeend', s)", 'document.write(s)', 'document . writeln(s)',
    'r.createContextualFragment(s)', 'f.srcdoc = s', 'new Function("x")', 'eval(s)', "setTimeout('go()', 1)", 'setInterval(`x`)',
    "el.setAttribute('style', s)", 'el.setAttribute("onclick", s)', "el.setAttributeNS(null, 'style', s)", "el.setAttribute('ONLOAD', s)"];
  for (const line of bad) assert.ok(SINKS.some(([, re]) => re.test(line)), line);
  const fine = ["el.setAttribute('aria-label', s)", "el.setAttribute('data-on', s)", 'setTimeout(fn, 1)', 'el.style.width = w',
    "el.setAttribute('title', s)", 'evaluate(x)', 'el.textContent = s'];
  for (const line of fine) assert.ok(!SINKS.some(([, re]) => re.test(line)), line);
});

test('localStorage/sessionStorage only in settings.js (and the classic theme-boot script)', () => {
  const allow = new Set(['app/settings.js', 'app/theme-boot.js']);
  assert.deepEqual(scan(/\b(?:localStorage|sessionStorage)\b/, allow), []);
});
