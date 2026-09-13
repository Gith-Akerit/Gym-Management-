// Deletes slip images past the retention window, and the rows that point at
// them. A slip carries the payer's name, part of an account number, an amount
// and a time: keeping it forever is a choice nobody made on purpose.
//
//   SLIP_RETENTION_DAYS=365 npm run slips:prune         # delete
//   SLIP_RETENTION_DAYS=365 npm run slips:prune -- --dry-run
import { openDatabase, migrate } from './db.js';
import { SlipStore } from './slips.js';

const days = Number(process.env.SLIP_RETENTION_DAYS ?? 365);
if (!Number.isFinite(days) || days < 1) throw new Error('SLIP_RETENTION_DAYS must be a positive number of days');
const dryRun = process.argv.includes('--dry-run');

const db = openDatabase(process.env.DATABASE_PATH || './data/gym.sqlite');
migrate(db);
const store = new SlipStore(process.env.SLIP_STORAGE_PATH || './data/slips');

try {
  const cutoff = Date.now() - days * 86400000;
  const stale = db.prepare('SELECT id, stored_name, uploaded_at FROM payment_slips WHERE uploaded_at < ?').all(cutoff);
  for (const slip of stale) {
    if (dryRun) continue;
    // The file goes first: a row without its image is recoverable confusion,
    // an image without its row is personal data nobody can find again.
    store.remove(slip.stored_name);
    db.prepare('DELETE FROM payment_slips WHERE id=?').run(slip.id);
  }
  console.log(JSON.stringify({
    event: dryRun ? 'slips_prune_preview' : 'slips_prune',
    retention_days: days,
    cutoff: new Date(cutoff).toISOString(),
    slips: stale.length,
  }));
} finally { db.close(); }
