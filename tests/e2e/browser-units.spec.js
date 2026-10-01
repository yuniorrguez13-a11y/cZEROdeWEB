// Runs every tests/browser/<suite>.test.js in the browser runner (tests/browser/index.html?suite=<suite>, app
// CSP), one fresh browser context per suite, and fails with the runner's failure list (a CSP violation counts
// as a failure). *-selftest suites are runner self-checks with a fixed expected outcome.
import { test, expect } from '@playwright/test';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../browser');
// *-selftest suites check the runner itself and fail on purpose; they get their own test below.
const SUITES = readdirSync(DIR)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => f.slice(0, -'.test.js'.length))
  .filter((s) => !s.endsWith('-selftest'))
  .sort();

async function runSuite(page, suite) {
  await page.goto(`/tests/browser/index.html?suite=${encodeURIComponent(suite)}`);
  const handle = await page.waitForFunction(() => window.__results, null, { timeout: 9 * 60 * 1000, polling: 250 });
  return handle.jsonValue();
}

test.describe('browser units', () => {
  test.describe.configure({ timeout: 10 * 60 * 1000 });

  test('runner self-test: passes counted; assertion, CSP violation and throw fail their test', async ({ page }) => {
    const results = await runSuite(page, 'platform-selftest');
    expect(results.passed).toBe(1);
    expect(results.failures.map((f) => f.name)).toEqual(['fails on purpose: assertion', 'fails on purpose: CSP violation', 'fails on purpose: throws']);
    expect(results.failures[0].message).toContain('one is not two: expected 2, got 1');
    expect(results.failures[1].message).toContain('CSP violation: style-src');
    expect(results.failures[2].message).toContain('thrown on purpose');
    expect(results.failed).toBe(3);
  });

  for (const suite of SUITES) {
    test(suite, async ({ page }, info) => {
      const lines = [];
      page.on('console', (m) => lines.push(`[${m.type()}] ${m.text()}`));
      page.on('pageerror', (e) => lines.push(`[pageerror] ${e.message}`));
      const results = await runSuite(page, suite);
      if (results.logs?.length) await info.attach('logs', { body: results.logs.join('\n'), contentType: 'text/plain' });
      if (lines.length) await info.attach('console', { body: lines.join('\n'), contentType: 'text/plain' });
      const report = results.failures.map((f) => `✗ ${f.name}\n  ${f.message.replace(/\n/g, '\n  ')}`).join('\n');
      expect(results.failed, `${suite}: ${results.failed} failed, ${results.passed} passed\n${report}`).toBe(0);
      expect(results.passed, `${suite}: no test ran`).toBeGreaterThan(0);
    });
  }
});
