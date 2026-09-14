import './load-env.js';
import { randomUUID } from 'node:crypto';
import { openDatabase, migrate, rollback, transaction, createMember, audit } from './db.js';
import { email, parse, password } from './validation.js';
import { hashPassword } from './passwords.js';
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
    // The password is how the owner gets in on day one. It is optional here so
    // an existing install can be re-pointed at a new address without changing
    // anybody's password, but a fresh gym with no password set can sign in
    // nowhere -- so say so rather than reporting success.
    const secret = process.env.ADMIN_PASSWORD ? parse(password, process.env.ADMIN_PASSWORD) : null;
    transaction(db, () => {
      db.prepare(`INSERT INTO users(id,email,role,created_at) VALUES(?,?,'admin',?) ON CONFLICT(email) DO UPDATE SET role='admin'`)
        .run(randomUUID(), address, Date.now());
      const user = db.prepare('SELECT id,password_hash FROM users WHERE email=?').get(address);
      if (secret) {
        db.prepare('UPDATE users SET password_hash=?,password_set_at=? WHERE id=?')
          .run(hashPassword(secret), Date.now(), user.id);
      }
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      audit(db, user.id, 'user.bootstrap_admin', user.id, null,
        { role: 'admin', password_set: !!secret }, Date.now());
      if (!secret && !user.password_hash) {
        console.warn('Warning: no ADMIN_PASSWORD given and this account has none, so nobody can sign in yet. '
          + 'Re-run with ADMIN_PASSWORD set.');
      }
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
      const demoPassword = hashPassword('demo-counter-2026');
      let actor = null;
      for (const role of ['admin', 'staff']) {
        const address = `${role}@example.test`;
        if (db.prepare('SELECT 1 FROM users WHERE email=?').get(address)) continue;
        const id = randomUUID();
        db.prepare('INSERT INTO users(id,email,role,password_hash,password_set_at,created_at) VALUES(?,?,?,?,?,?)')
          .run(id, address, role, demoPassword, Date.now(), Date.now());
        actor ??= id;
      }
      actor ??= db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get()?.id;
      // A demo member with no account at all, which is what every member is now.
      if (actor && !db.prepare('SELECT 1 FROM members WHERE phone=?').get('0890000001')) {
        createMember(db, null, { name: 'สมาชิก ทดสอบ', phone: '0890000001', date_of_birth: null, emergency_contact: '' }, actor, Date.now());
      }
    });
    console.log('Demo sign-in: admin@example.test / staff@example.test, password demo-counter-2026');
  } else throw new Error('Use migrate, rollback, admin, seed, or seed:demo');
  console.log(`Database command completed: ${command}`);
} finally { db.close(); }
