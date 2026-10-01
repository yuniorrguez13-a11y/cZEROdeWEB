// Test-suite stability settings: what playwright.config.js does on CI (and locally), and the CI steps that make a
// failed browser run debuggable. A retry may tell a flake from a real failure, but it must never turn one green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG = pathToFileURL(path.join(ROOT, 'playwright.config.js')).href;
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

/** playwright.config.js evaluated with CI set or unset (a fresh module instance each time). */
async function configWith(ci) {
  const saved = process.env.CI;
  if (ci) process.env.CI = 'true';
  else delete process.env.CI;
  try {
    return (await import(`${CONFIG}?ci=${ci}`)).default;
  } finally {
    if (saved === undefined) delete process.env.CI;
    else process.env.CI = saved;
  }
}

test('playwright on CI: a flaky test fails the run; 2 workers, own server, traces and the HTML report kept', async () => {
  const c = await configWith(true);
  assert.equal(c.failOnFlakyTests, true, 'a test that only passes on retry fails CI');
  assert.equal(c.retries, 1);
  assert.equal(c.workers, 2);
  assert.equal(c.forbidOnly, true);
  assert.equal(c.webServer.reuseExistingServer, false, 'CI never talks to a server it did not start');
  assert.equal(c.use.trace, 'retain-on-failure');
  assert.ok(c.reporter.some((r) => r[0] === 'html'), 'HTML report for the artifact');
});

test('playwright locally: no retries, so a flake shows up as a failure', async () => {
  const c = await configWith(false);
  assert.equal(c.retries, 0);
  assert.equal(c.failOnFlakyTests, false);
});

test('ci.yml: Chromium is installed before the browser tests; a failure uploads the report and the traces', () => {
  const ci = read('.github/workflows/ci.yml');
  const install = ci.indexOf('npx playwright install --with-deps chromium');
  const run = ci.indexOf('run: npx playwright test');
  assert.ok(install > 0 && run > install, 'install step, then the test step');
  const upload = ci.slice(run);
  assert.match(upload, /if: failure\(\)\s+uses: actions\/upload-artifact@/);
  for (const dir of ['playwright-report/', 'test-results/']) assert.ok(upload.includes(dir), `uploads ${dir}`);
  const minutes = [...ci.matchAll(/timeout-minutes: (\d+)/g)].map((m) => Number(m[1]));
  assert.ok(minutes.length >= 2 && minutes.every((m) => m >= 20), `job timeouts: ${minutes}`);
});
