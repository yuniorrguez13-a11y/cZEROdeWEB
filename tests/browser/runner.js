// Browser unit runner (tests/browser/index.html?suite=<area>). Loads ./<area>.test.js, whose default export is
// `async function (t)` with t = {test(name, fn), assert(cond, msg), equal(a, b, msg), deepEqual(a, b, msg), log(...)}.
// Tests run one at a time in call order (t.test returns a promise; awaiting it is optional). A failed assertion
// marks the running test failed without stopping it; a thrown error ends it. Assertions outside a test count
// against a pseudo-test "(suite)". A t.test called inside a running test runs immediately as a sub-test. A CSP
// violation fails the running test (or "(suite)"). When done: window.__results = {passed, failed, failures:[{name, message}], logs}.

const results = { passed: 0, failed: 0, failures: [], logs: [] };
let current = null;
let chain = Promise.resolve();

function show(text) {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

function row(name, ok, message) {
  const list = document.getElementById('results');
  if (!list) return;
  const li = document.createElement('li');
  li.className = ok ? 'pass' : 'fail';
  li.textContent = ok ? `ok — ${name}` : `FAIL — ${name}: ${message}`;
  list.append(li);
}

function fmt(v) {
  if (typeof v === 'string') return JSON.stringify(v.length > 200 ? `${v.slice(0, 200)}…` : v);
  if (v instanceof Uint8Array) return `Uint8Array(${v.length})`;
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 300 ? `${s.slice(0, 300)}…` : s;
  } catch {
    return String(v);
  }
}

function deepEq(a, b, seen = new Map()) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (seen.get(a) === b) return true;
  seen.set(a, b);
  if (ArrayBuffer.isView(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  if (a instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Map || a instanceof Set) {
    if (a.size !== b.size) return false;
    if (a instanceof Set) return [...a].every((x) => b.has(x));
    for (const [k, v] of a) if (!b.has(k) || !deepEq(v, b.get(k), seen)) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEq(a[k], b[k], seen));
}

const suiteLevel = { name: '(suite)', messages: [] };

function fail(message) {
  (current ?? suiteLevel).messages.push(String(message));
}

function errText(e) {
  if (e && typeof e === 'object') {
    const code = e.code ? ` [${e.code}]` : '';
    return `${e.name ?? 'Error'}${code}: ${e.message ?? ''}${e.stack ? `\n${e.stack}` : ''}`;
  }
  return String(e);
}

async function runOne(name, fn) {
  const rec = { name: String(name), messages: [] };
  const outer = current;
  current = rec;
  window.__current = rec.name;
  try {
    await fn(t);
  } catch (e) {
    rec.messages.push(`threw ${errText(e)}`);
  } finally {
    current = outer;
    window.__current = outer ? outer.name : null;
  }
  if (rec.messages.length) {
    results.failed++;
    results.failures.push({ name: rec.name, message: rec.messages.join('\n') });
    row(rec.name, false, rec.messages.join('; '));
  } else {
    results.passed++;
    row(rec.name, true);
  }
}

const t = {
  test(name, fn) {
    // Nested t.test inside a running test runs right away (queuing it would deadlock an awaiting parent).
    if (current) return runOne(`${current.name} › ${name}`, fn);
    const run = chain.then(() => runOne(name, fn));
    chain = run.catch(() => {});
    return run;
  },
  assert(cond, msg) {
    if (!cond) fail(msg || 'assertion failed');
  },
  equal(a, b, msg) {
    if (!Object.is(a, b)) fail(`${msg || 'equal'}: expected ${fmt(b)}, got ${fmt(a)}`);
  },
  deepEqual(a, b, msg) {
    if (!deepEq(a, b)) fail(`${msg || 'deepEqual'}: expected ${fmt(b)}, got ${fmt(a)}`);
  },
  log(...args) {
    const line = args.map((a) => (typeof a === 'string' ? a : fmt(a))).join(' ');
    results.logs.push(line);
    console.log(line);
  },
};

function finish() {
  if (suiteLevel.messages.length) {
    results.failed++;
    results.failures.push({ name: suiteLevel.name, message: suiteLevel.messages.join('\n') });
    row(suiteLevel.name, false, suiteLevel.messages.join('; '));
  }
  show(`${results.failed ? 'FAIL' : 'PASS'}: ${results.passed} passed, ${results.failed} failed`);
  document.title = `${results.failed ? 'FAIL' : 'PASS'} — browser units`;
  window.__results = results;
}

async function main() {
  const suite = new URLSearchParams(location.search).get('suite') ?? '';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(suite)) {
    fail(`bad or missing ?suite= (got ${fmt(suite)})`);
    return finish();
  }
  show(`running ${suite}…`);
  try {
    const mod = await import(`./${suite}.test.js`);
    if (typeof mod.default !== 'function') throw new TypeError(`${suite}.test.js has no default export function`);
    await mod.default(t);
  } catch (e) {
    fail(`suite ${suite} threw ${errText(e)}`);
  }
  await chain;
  // securitypolicyviolation events are queued tasks: let late ones arrive before reporting.
  await new Promise((r) => setTimeout(r, 50));
  finish();
}

// The suites run under the app's CSP to catch code the app's CSP would break: a violation fails the test that
// is running when it is reported (or the suite, when none is).
window.addEventListener('securitypolicyviolation', (e) => {
  const line = `CSP violation: ${e.violatedDirective} ${e.blockedURI || '(inline)'}${e.sourceFile ? ` at ${e.sourceFile}:${e.lineNumber}` : ''}`;
  t.log(line);
  fail(line);
});
main();
