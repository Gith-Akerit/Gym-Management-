// Playwright refuses to start when a port is still held by a test server it
// failed to reap on a previous run. Clear ONLY the ports this run will use --
// never a fixed pair, or two runs on one machine take turns killing each
// other's servers.
import { execFileSync } from 'node:child_process';
import { UI_OPEN_PORT, UI_PILOT_PORT, UI_PORT } from './ports.js';

const PORTS = [UI_PORT, UI_PILOT_PORT, UI_OPEN_PORT];
try {
  const netstat = execFileSync('netstat', ['-ano']).toString().split('\n');
  for (const port of PORTS) {
    const lines = netstat.filter(line => line.includes(`127.0.0.1:${port} `) && line.includes('LISTENING'));
    for (const line of lines) {
      const pid = line.trim().split(/\s+/).pop();
      if (pid && pid !== '0') {
        execFileSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' });
        console.log(`Freed port ${port} (pid ${pid})`);
      }
    }
  }
} catch {
  // No leftover, or not Windows: nothing to clean up.
}
