import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/ui', fullyParallel: false, workers: 1, timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:4310', browserName: 'chromium',
    ...(process.env.PLAYWRIGHT_CHANNEL && { channel: process.env.PLAYWRIGHT_CHANNEL }),
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
    permissions: ['camera'],
    // A synthetic camera, so the counter's scan screen can be exercised without
    // hardware. It produces a test pattern, not a QR, so it proves the wiring
    // and the permission flow rather than the decoding.
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } },
  webServer: { command: 'node tests/ui-server.js', url: 'http://127.0.0.1:4310/api/health', reuseExistingServer: false },
});
