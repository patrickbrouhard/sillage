import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://127.0.0.1:18381',
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'on',
  },
  webServer: {
    command: 'python3 ../tests/web/serve.py',
    url: 'http://127.0.0.1:18381',
    reuseExistingServer: false,
    timeout: 30_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
  },
})
