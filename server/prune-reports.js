// Deletes problem reports past the retention window, and their screenshots.
//
// The screenshot is a picture of whatever was on the screen when somebody
// pressed the button, which at a counter is nearly always a member: a name, a
// face, a telephone number. Keeping those for as long as the disk holds out is
// a choice nobody made on purpose. Half a year is long enough to notice a
// pattern of reports and short enough that a gym is not quietly running a
// photo archive of its customers.
//
//   REPORT_RETENTION_DAYS=180 npm run reports:prune            # delete
//   REPORT_RETENTION_DAYS=180 npm run reports:prune -- --dry-run
import './load-env.js';
import { openDatabase, migrate } from './db.js';
import { SlipStore } from './slips.js';
import { MAX_REPORT_BYTES, REPORT_RETENTION_DAYS } from './reports.js';

const days = Number(process.env.REPORT_RETENTION_DAYS ?? REPORT_RETENTION_DAYS);
if (!Number.isFinite(days) || days < 1) throw new Error('REPORT_RETENTION_DAYS must be a positive number of days');
const dryRun = process.argv.includes('--dry-run');

const db = openDatabase(process.env.DATABASE_PATH || './data/gym.sqlite');
migrate(db);
const store = new SlipStore(process.env.REPORT_STORAGE_PATH || './data/reports', { maxBytes: MAX_REPORT_BYTES });

try {
  const cutoff = Date.now() - days * 86400000;
  const stale = db.prepare(
    'SELECT id, image_stored_name FROM problem_reports WHERE created_at < ?').all(cutoff);
  let images = 0;
  for (const report of stale) {
    if (dryRun) { if (report.image_stored_name) images += 1; continue; }
    // The file goes first, for the same reason as a slip: a row without its
    // image is recoverable confusion, an image without its row is personal
    // data nobody can find again to delete.
    if (report.image_stored_name) { store.remove(report.image_stored_name); images += 1; }
    db.prepare('DELETE FROM problem_reports WHERE id=?').run(report.id);
  }
  console.log(JSON.stringify({
    event: dryRun ? 'reports_prune_preview' : 'reports_prune',
    retention_days: days,
    cutoff: new Date(cutoff).toISOString(),
    reports: stale.length,
    images,
  }));
} finally { db.close(); }
