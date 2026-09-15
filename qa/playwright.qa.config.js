// QA Release Tester — the base browser config, pointed at the probes in `qa/`.
//
//   UI_PORT=4393 UI_PILOT_PORT=4394 PLAYWRIGHT_CHANNEL=msedge \
//     npx playwright test --config qa/playwright.qa.config.js
//
// Same servers, same browser and the same ports contract as the team's own
// suite; only the directory of specs differs, so a QA probe and a team spec
// never disagree about the environment they ran in. `cwd` is pinned to the
// repository root because the servers are started by a path relative to it.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import base from '../playwright.config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default {
  ...base,
  testDir: '.',
  // Only the browser probes: `qa/*.test.js` are node:test files and would
  // otherwise be collected here and run twice, in the wrong runner.
  testMatch: '*.spec.js',
  webServer: base.webServer.map(server => ({ ...server, cwd: root })),
};
