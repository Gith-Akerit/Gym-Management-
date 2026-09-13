import { randomUUID } from 'node:crypto';
import { openDatabase, migrate, rollback, transaction, createMember, audit } from './db.js';
import { email, parse } from './validation.js';
import { seedConfiguration } from './seed.js';
const db = openDatabase(process.env.DATABASE_PATH || './data/gym.sqlite');
const command = process.argv[2];
try {
  if (command === 'migrate') migrate(db);
  else if (command === 'rollback') {
    if (process.env.ALLOW_DESTRUCTIVE_ROLLBACK !== 'yes') throw new Error('Rollback removes Phase 1 data. Back up first; set ALLOW_DESTRUCTIVE_ROLLBACK=yes explicitly.');
    rollback(db);
  } else if (command === 'admin') {
    migrate(db);
    const address = parse(email, process.env.ADMIN_EMAIL);
    transaction(db, () => {
      db.prepare(`INSERT INTO users(id,email,role,created_at) VALUES(?,?,'admin',?) ON CONFLICT(email) DO UPDATE SET role='admin'`)
        .run(randomUUID(), address, Date.now());
      const user = db.prepare('SELECT id FROM users WHERE email=?').get(address);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      audit(db, user.id, 'user.bootstrap_admin', user.id, null, { role: 'admin' }, Date.now());
    });
  } else if (command === 'seed') {
    // Gym profile, opening hours and package drafts are real configuration,
    // so this is safe to re-run in production; it never overwrites edits.
    migrate(db);
    const created = seedConfiguration(db);
    console.log(JSON.stringify({ event: 'seed_configuration', ...created }));
  } else if (command === 'seed:demo') {
    if (process.env.NODE_ENV === 'production') throw new Error('Demo seed is disabled in production');
    migrate(db);
    seedConfiguration(db);
    transaction(db, () => {
      for (const [index, role] of ['admin', 'staff', 'member'].entries()) {
        const address = `${role}@example.test`;
        if (db.prepare('SELECT 1 FROM users WHERE email=?').get(address)) continue;
        const id = randomUUID();
        db.prepare('INSERT INTO users(id,email,role,created_at) VALUES(?,?,?,?)').run(id, address, role, Date.now());
        if (role === 'member') createMember(db, id, { name: 'สมาชิก ทดสอบ', phone: '0890000001', date_of_birth: null, emergency_contact: '' }, id, Date.now());
      }
    });
  } else throw new Error('Use migrate, rollback, admin, seed, or seed:demo');
  console.log(`Database command completed: ${command}`);
} finally { db.close(); }
