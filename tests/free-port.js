// Playwright refuses to start when port 4310 is still held by a test server it
// failed to reap on a previous run. Clear it before handing over.
import { execFileSync } from 'node:child_process';
const PORTS = [4310, 4311];
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
