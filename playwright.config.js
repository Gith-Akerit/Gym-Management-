import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/ui', fullyParallel: false, workers: 1, timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:4310', browserName: 'chromium',
    ...(process.env.PLAYWRIGHT_CHANNEL && { channel: process.env.PLAYWRIGHT_CHANNEL }),
    screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'node tests/ui-server.js', url: 'http://127.0.0.1:4310/api/health', reuseExistingServer: false },
});
