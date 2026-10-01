// Playwright: e2e specs and the browser-unit runner (DESIGN §8). The repo is served as-is by
// scripts/serve.mjs on a fixed port; every test gets a fresh browser context (fresh storage, no service worker).
// Browsers come from PLAYWRIGHT_BROWSERS_PATH (CI: `npx playwright install --with-deps chromium`).
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.CZD_TEST_PORT || 4173);
const BASE = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90 * 1000,
  expect: { timeout: 15 * 1000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'allow',
    acceptDownloads: true,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `node scripts/serve.mjs --port ${PORT}`,
    url: `${BASE}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 30 * 1000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
