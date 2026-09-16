// QA Release Tester — PR #4 (release/pilot). Covers the app code this branch
// changed that no earlier round tested: the free-package grant path, the
// env:set script the gym owner will run in a browser terminal, and the
// container entrypoint that runs on every boot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import request from 'supertest';
import { openDatabase, migrate } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seedConfiguration } from '../server/seed.js';
import { SlipStore } from '../server/slips.js';

const DAY = 86400000;
const THAI = /[฀-๿]/;

function lengthOf(p) { const h = Buffer.alloc(2); h.writeUInt16BE(p.length + 2); return h; }
function jpeg(tag = 'x') {
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from(`GPS ${tag}`, 'latin1')]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), lengthOf(exif), exif]);
  const jfif = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, app1,
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.from([...Buffer.from(String(tag).padEnd(8, '.'), 'latin1'), 0xff, 0xd9])]);
}

function fixture(t) {
  const db = openDatabase(); migrate(db); seedConfiguration(db, Date.now());
  const root = mkdtempSync(join(tmpdir(), 'qa-pilot-'));
  let time = Date.parse('2026-09-14T09:00:00+07:00');
  const app = createApp({ db, secret: randomBytes(32).toString('hex'), now: () => time,
    sendOtp: async () => {}, slipStore: new SlipStore(root), promptPayId: '0812345678' });
  t.after(() => { app.locals.stopSweeper?.(); db.close(); rmSync(root, { recursive: true, force: true }); });

  const call = (method, path, token, body) => {
    const req = request(app)[method](`/api${path}`).set('X-Gym-Client', 'mobile');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  function session(userId) {
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions VALUES(?,?,?)')
      .run(createHash('sha256').update(token).digest('hex'), userId, time + 365 * DAY);
    return token;
  }
  let seq = 1000000;
  function makeUser(email, role = 'member') {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,email,role,email_verified_at,created_at) VALUES(?,?,?,?,?)')
      .run(id, email, role, time, time);
    return id;
  }
  function makeMember(email, name = 'สุดา ใจดี') {
    const userId = makeUser(email);
    const id = randomUUID();
    db.prepare(`INSERT INTO members(id,user_id,member_code,name,phone,status,joined_at,updated_at)
      VALUES(?,?,?,?,?,'active',?,?)`).run(id, userId, `GYM-${String(seq).padStart(12, '0')}`,
      name, `089${seq++}`, time, time);
    return { id, token: session(userId) };
  }
  const makeAdmin = email => session(makeUser(email, 'admin'));
  function makePackage({ baht, name = 'รายเดือน', sessions = null } = {}) {
    const id = randomUUID();
    db.prepare(`INSERT INTO packages(id,code,name_th,type,duration_days,session_limit,price_satang,
      description,status,sort_order,created_at,updated_at) VALUES(?,?,?,?,30,?,?,'','active',0,?,?)`)
      .run(id, `P${seq++}`, name, sessions === null ? 'unlimited' : 'limited_sessions',
        sessions, Math.round(baht * 100), time, time);
    return id;
  }
  const upload = (token, orderId, tag) => request(app).post(`/api/orders/${orderId}/slip`)
    .set('X-Gym-Client', 'mobile').set('Authorization', `Bearer ${token}`)
    .field('reference_no', `REF${String(seq++)}`).field('transferred_at', '2026-09-14T08:45')
    .attach('slip', jpeg(tag), { filename: 'slip.jpg', contentType: 'image/jpeg' });

  return { db, call, makeMember, makeAdmin, makePackage, upload, at: () => time };
}

// ===================================================== free package: granting
// PILOT-01..03 tested the member-side purchase and the bank tick on a slip.
// The member app was removed at cf6fa58 and the money moved to the counter,
// so what they were guarding now lives in the counter-sale cases of the new
// matrix. The deployment cases below are untouched by the change of subject.
test('PILOT-04 a free package reaches the member catalogue as free, not as zero baht', async t => {
  const { call, makeMember, makeAdmin, makePackage } = fixture(t);
  const admin = makeAdmin('admin@example.test');
  makePackage({ baht: 0, name: 'ทดลองเล่นฟรี', sessions: 1 });
  makePackage({ baht: 1200, name: 'รายเดือน' });
  const member = makeMember('cat@example.test');
  const items = (await call('get', '/packages', member.token).expect(200)).body.items;
  console.log('PILOT-04 member catalogue:', JSON.stringify(items.map(p =>
    ({ name: p.name_th, satang: p.price_satang, thb: p.price_thb }))));
  const freeItem = items.find(p => p.name_th === 'ทดลองเล่นฟรี');
  assert.equal(freeItem.price_thb, 0);
  assert.notEqual(freeItem.price_thb, null, 'a free package must not read as "price not set yet"');
  const queue = (await call('get', '/admin/orders?status=all', admin).expect(200)).body;
  console.log('PILOT-04 admin queue shape ok:', Array.isArray(queue.items));
});

// ======================================================== env:set on the box
function envRun(dir, args, { input } = {}) {
  const script = resolve('server/env-set.js');
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: dir, encoding: 'utf8', input: input ?? '',
      env: { ...process.env, ENV_FILE: join(dir, '.env') },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('PILOT-05 env:set never prints the value it was given', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-env-'));
  try {
    // Shaped like a Brevo key so the awkward characters are exercised, but
    // spelled out as a placeholder so the secrets sweep does not flag it.
    const secret = 'xkeysib-EXAMPLE-not-a-real-key-Aa1#$%+/:,.@-_';
    writeFileSync(join(dir, '.env'), 'PORT=3000\n# a comment\nOTP_SECRET=keepme\n');
    const set = envRun(dir, [`SMTP_PASSWORD=${secret}`, 'SMTP_USER=gym@example.test']);
    const printed = set.stdout + set.stderr;
    console.log('PILOT-05 exit', set.code, '| output:\n' + printed.trim());
    assert.equal(set.code, 0, printed);
    assert.ok(!printed.includes(secret), 'env:set echoed the secret back onto the screen');
    assert.ok(printed.includes('SMTP_PASSWORD'), 'the owner is not told which key was written');

    const list = envRun(dir, ['--list']);
    console.log('PILOT-05 --list output:\n' + list.stdout.trim());
    assert.ok(!list.stdout.includes(secret), '--list printed the value');
    assert.ok(/SMTP_PASSWORD/.test(list.stdout));

    const onDisk = readFileSync(join(dir, '.env'), 'utf8');
    console.log('PILOT-05 file after writing:\n' + onDisk.split('\n').map(l =>
      l.startsWith('SMTP_PASSWORD=') ? 'SMTP_PASSWORD=<hidden by QA>' : l).join('\n'));
    assert.ok(onDisk.includes('PORT=3000'), 'an unrelated line was lost');
    assert.ok(onDisk.includes('# a comment'), 'comments were stripped');
    assert.ok(onDisk.includes('OTP_SECRET=keepme'), 'an existing secret was destroyed');

    // The app has to read back exactly what the owner typed.
    const { parseEnv } = await import('node:util');
    const parsed = parseEnv(onDisk);
    console.log('PILOT-05 value round-trips through the parser Node uses:', parsed.SMTP_PASSWORD === secret);
    assert.equal(parsed.SMTP_PASSWORD, secret);
    assert.equal(parsed.SMTP_USER, 'gym@example.test');

    if (process.platform !== 'win32') {
      const mode = statSync(join(dir, '.env')).mode & 0o777;
      console.log('PILOT-05 file mode:', mode.toString(8));
      assert.equal(mode, 0o600, '.env is readable by other users on the box');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PILOT-06 env:set leaves the file untouched when it cannot store a value faithfully', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-env2-'));
  try {
    const before = 'PORT=3000\nOTP_SECRET=originalsecret\nSMTP_PASSWORD=oldpassword\n';
    writeFileSync(join(dir, '.env'), before);
    const attempts = {
      'contains all three quote characters': `a"b'c\`d`,
      'contains a newline': 'line-one\nline-two',
      'contains a carriage return': 'value\rmore',
    };
    for (const [name, value] of Object.entries(attempts)) {
      writeFileSync(join(dir, '.env'), before);      // same starting point every time
      const run = envRun(dir, [`SMTP_PASSWORD=${value}`]);
      const after = readFileSync(join(dir, '.env'), 'utf8');
      const { parseEnv } = await import('node:util');
      const readsBack = parseEnv(after).SMTP_PASSWORD;
      console.log(`PILOT-06 ${name}: exit ${run.code} | file unchanged: ${after === before}`
        + ` | reads back as expected: ${readsBack === value}`);
      console.log('   message:', (run.stderr || run.stdout).trim().split('\n')[0]);
      assert.ok(!(run.stdout + run.stderr).includes(value.split('\n')[1] ?? ' '),
        'the rejected value was printed back');
      if (run.code === 0) {
        // Accepting is fine only if the app really does read back the same value.
        assert.equal(readsBack, value, `${name} was stored but the app reads it back differently`);
      } else {
        assert.equal(after, before, `${name} was refused but the file was left changed`);
        assert.ok(parseEnv(after).OTP_SECRET === 'originalsecret', 'an unrelated secret was lost');
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PILOT-07 env:set refuses nonsense arguments instead of writing something wrong', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-env3-'));
  try {
    writeFileSync(join(dir, '.env'), 'PORT=3000\n');
    const cases = {
      'lowercase key': ['smtp_password=x'],
      'key with a dash': ['SMTP-PASSWORD=x'],
      'no equals sign': ['SMTP_PASSWORD'],
      'empty key': ['=value'],
      '--stdin without a key': ['--stdin'],
      '--stdin with a bad key': ['--stdin', 'bad key'],
      'no arguments at all': [],
    };
    const out = {};
    for (const [name, args] of Object.entries(cases)) {
      const run = envRun(dir, args);
      out[name] = run.code;
      assert.notEqual(readFileSync(join(dir, '.env'), 'utf8'), '', `${name} emptied the file`);
    }
    console.log('PILOT-07 exit codes:', JSON.stringify(out, null, 1));
    for (const [name, code] of Object.entries(out)) assert.notEqual(code, 0, `${name} was accepted`);
    assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'PORT=3000\n', 'the file changed despite every call failing');

    // --stdin is the documented way to avoid a value landing in shell history.
    const viaStdin = envRun(dir, ['--stdin', 'PROMPTPAY_ID'], { input: '0812345678\n' });
    const { parseEnv } = await import('node:util');
    console.log('PILOT-07 --stdin exit', viaStdin.code, '| stored correctly:',
      parseEnv(readFileSync(join(dir, '.env'), 'utf8')).PROMPTPAY_ID === '0812345678');
    assert.equal(viaStdin.code, 0, viaStdin.stderr);
    assert.equal(parseEnv(readFileSync(join(dir, '.env'), 'utf8')).PROMPTPAY_ID, '0812345678');
    assert.ok(!(viaStdin.stdout + viaStdin.stderr).includes('0812345678'), '--stdin echoed the value');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PILOT-08 running env:set twice is safe and rewrites in place', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-env4-'));
  try {
    writeFileSync(join(dir, '.env'), 'PORT=3000\nPROMPTPAY_ID=\n');
    const first = envRun(dir, ['PROMPTPAY_ID=0812345678']);
    const afterFirst = readFileSync(join(dir, '.env'), 'utf8');
    const second = envRun(dir, ['PROMPTPAY_ID=0898887777']);
    const afterSecond = readFileSync(join(dir, '.env'), 'utf8');
    const third = envRun(dir, ['PROMPTPAY_ID=0898887777']);
    console.log('PILOT-08 actions:', JSON.stringify([first.stdout.trim().split('\n')[0],
      second.stdout.trim().split('\n')[0], third.stdout.trim().split('\n')[0]]));
    console.log('PILOT-08 line count stays flat:', afterFirst.split('\n').length, '->', afterSecond.split('\n').length);
    const { parseEnv } = await import('node:util');
    assert.equal(parseEnv(afterSecond).PROMPTPAY_ID, '0898887777');
    assert.equal(afterFirst.split('\n').length, afterSecond.split('\n').length, 'the key was appended instead of replaced');
    assert.equal((afterSecond.match(/^PROMPTPAY_ID=/gm) || []).length, 1, 'the key now appears twice');
    assert.match(third.stdout, /unchanged/, 'writing the same value again is not reported as unchanged');
    const leftovers = (await import('node:fs')).readdirSync(dir).filter(f => f !== '.env');
    console.log('PILOT-08 temporary files left behind:', JSON.stringify(leftovers));
    assert.deepEqual(leftovers, [], 'a temporary .env file was left on the box');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========================================================== container boot
test('PILOT-09 booting twice does not overwrite what the gym edited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-boot-'));
  const dbPath = join(dir, 'data', 'gym.sqlite');
  const run = () => {
    const shell = process.platform === 'win32' ? 'sh' : '/bin/sh';
    return execFileSync(shell, [resolve('deploy/entrypoint.sh'), 'true'], {
      cwd: resolve('.'), encoding: 'utf8',
      env: { ...process.env, DATABASE_PATH: dbPath, SLIP_STORAGE_PATH: join(dir, 'slips'), ADMIN_EMAIL: '' },
    });
  };
  try {
    const first = run();
    console.log('PILOT-09 first boot:\n' + first.trim());
    let db = openDatabase(dbPath);
    const seeded = db.prepare('SELECT count(*) n FROM packages').get().n;
    const profile = db.prepare('SELECT name, hours_confirmed FROM gym_profile WHERE id=1').get();
    // The owner does what an owner does: fills in a price and confirms the hours.
    db.prepare("UPDATE packages SET price_satang=150000, status='active' WHERE code='UNLIMITED_30D'").run();
    db.prepare("UPDATE gym_profile SET name='สุขฤทัย ฟิตเนส (แก้แล้ว)', hours_confirmed=1 WHERE id=1").run();
    db.prepare("UPDATE gym_hours SET open_time='06:00', close_time='22:00' WHERE weekday=1").run();
    db.close();

    const second = run();
    console.log('PILOT-09 second boot:\n' + second.trim());
    db = openDatabase(dbPath);
    const after = {
      packages: db.prepare('SELECT count(*) n FROM packages').get().n,
      price: db.prepare("SELECT price_satang p FROM packages WHERE code='UNLIMITED_30D'").get().p,
      name: db.prepare('SELECT name FROM gym_profile WHERE id=1').get().name,
      hoursConfirmed: db.prepare('SELECT hours_confirmed h FROM gym_profile WHERE id=1').get().h,
      mondayOpen: db.prepare('SELECT open_time o FROM gym_hours WHERE weekday=1').get().o,
      migrations: db.prepare('SELECT count(*) n FROM schema_migrations').get().n,
    };
    db.close();
    console.log('PILOT-09 after the second boot:', JSON.stringify(after));
    assert.equal(after.price, 150000, 'the second boot reset the price the owner typed in');
    assert.equal(after.name, 'สุขฤทัย ฟิตเนส (แก้แล้ว)', 'the second boot overwrote the gym name');
    assert.equal(after.hoursConfirmed, 1, 'the second boot un-confirmed the opening hours');
    assert.equal(after.mondayOpen, '06:00', 'the second boot reset the opening time');
    assert.equal(after.packages, seeded, 'the second boot seeded a duplicate set of packages');
    assert.ok(profile);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PILOT-10 the entrypoint creates the directories the app needs and stops on failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-boot2-'));
  try {
    const dbPath = join(dir, 'nested', 'deep', 'gym.sqlite');
    const slips = join(dir, 'nested', 'slips');
    const shell = process.platform === 'win32' ? 'sh' : '/bin/sh';
    execFileSync(shell, [resolve('deploy/entrypoint.sh'), 'true'], {
      cwd: resolve('.'), encoding: 'utf8',
      env: { ...process.env, DATABASE_PATH: dbPath, SLIP_STORAGE_PATH: slips, ADMIN_EMAIL: '' },
    });
    console.log('PILOT-10 database created at a nested path:', existsSync(dbPath));
    console.log('PILOT-10 slip directory created:', existsSync(slips));
    assert.ok(existsSync(dbPath));
    assert.ok(existsSync(slips));

    // set -e means a failed migration must stop the boot, not serve a broken app.
    const script = readFileSync(resolve('deploy/entrypoint.sh'), 'utf8');
    console.log('PILOT-10 entrypoint aborts on error:', /^set -e/m.test(script));
    console.log('PILOT-10 runs admin bootstrap only when asked:', /if \[ -n "\$ADMIN_EMAIL" \]/.test(script));
    console.log('PILOT-10 hands over with exec:', /^exec "\$@"/m.test(script));
    assert.match(script, /^set -e/m, 'a failed migration would be ignored and the app served anyway');
    assert.match(script, /^exec "\$@"/m, 'the app would not receive stop signals as PID 1');
    assert.doesNotMatch(script, /seed:demo/, 'the container seeds demo accounts on a real deployment');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PILOT-11 the deployment files keep secrets out of the image and off the web', async () => {
  const lf = text => text.split('\r\n').join('\n');
  const compose = lf(readFileSync(resolve('docker-compose.yml'), 'utf8'));
  const dockerignore = lf(readFileSync(resolve('.dockerignore'), 'utf8'));
  const dockerfile = lf(readFileSync(resolve('Dockerfile'), 'utf8'));
  const checks = {
    'dockerignore excludes .env': /^\.env$/m.test(dockerignore),
    'dockerignore excludes the database and slips': /^data\/?$/m.test(dockerignore) && /^\*\.sqlite/m.test(dockerignore),
    'the image copies only what it serves': !/^COPY \.\s/m.test(dockerfile) && !/^COPY \. /m.test(dockerfile),
    'no secret literal in compose': !/(password|secret|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{16,}/i.test(compose),
    'compose reads env from a file or the host': /env_file|\$\{/.test(compose),
    'Dockerfile pins a Node major': /FROM\s+node:24/i.test(dockerfile),
    'container does not run as root': /USER\s+(?!root)/i.test(dockerfile),
  };
  console.log('PILOT-11 deployment hygiene:', JSON.stringify(checks, null, 1));
  const slipPath = (compose.match(/SLIP_STORAGE_PATH[^\n]*/) || [])[0];
  console.log('PILOT-11 slip storage in compose:', slipPath ?? '(inherited from .env)');
  console.log('PILOT-11 Dockerfile copies:', JSON.stringify(
    (dockerfile.match(/^COPY .*/gm) || []).map(line => line.replace(/\s+/g, ' '))));
  for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `deployment package: ${name}`);
  assert.ok(THAI);
});
