import { defineConfig } from '@playwright/test';
import { UI_PILOT_PORT, UI_PORT } from './tests/ports.js';
export default defineConfig({
  testDir: './tests/ui', fullyParallel: false, workers: 1, timeout: 30000,
  use: { baseURL: `http://127.0.0.1:${UI_PORT}`, browserName: 'chromium',
    ...(process.env.PLAYWRIGHT_CHANNEL && { channel: process.env.PLAYWRIGHT_CHANNEL }),
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
    permissions: ['camera'],
    // A synthetic camera, so the counter's scan screen can be exercised without
    // hardware. It produces a test pattern, not a QR, so it proves the wiring
    // and the permission flow rather than the decoding.
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } },
  webServer: [
    { command: 'node tests/ui-server.js', url: `http://127.0.0.1:${UI_PORT}/api/health`, reuseExistingServer: false,
      env: { UI_PORT: String(UI_PORT) } },
    // The same build served with PILOT_MODE=1, because pilot mode changes what
    // the counter is offered and that cannot be reached by flipping something
    // inside the first server.
    { command: 'node tests/ui-server.js', url: `http://127.0.0.1:${UI_PILOT_PORT}/api/health`, reuseExistingServer: false,
      env: { UI_PORT: String(UI_PILOT_PORT), PILOT_MODE: '1' } },
  ],
});
