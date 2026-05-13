import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // In sandboxed CI environments, Playwright's per-version
        // browser download is unavailable. Fall through to a system-
        // installed Chromium via PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        // when set. Local runs (where `npx playwright install` works)
        // ignore this and use the bundled binary.
        // Accept the legacy `PLAYWRIGHT_LOCAL_CHROME` name as a
        // fallback — earlier audit branches use it.
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.PLAYWRIGHT_LOCAL_CHROME
          ? { launchOptions: { executablePath: (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.PLAYWRIGHT_LOCAL_CHROME) as string } }
          : {}),
      },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
  },
});
