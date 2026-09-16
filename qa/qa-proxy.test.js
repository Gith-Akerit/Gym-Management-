// QA Release Tester — does the per-IP OTP throttle survive a reverse proxy?
// Production requires HTTPS (server refuses a plain-http APP_ORIGIN), so the API
// will sit behind nginx / Caddy / Cloudflare. This checks what req.ip becomes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { openDatabase, migrate } from '../server/db.js';
import { createApp } from '../server/app.js';

function fixture(t) {
  const db = openDatabase(); migrate(db); const inbox = new Map();
  let time = Date.now();
  const app = createApp({ db, secret: randomBytes(32).toString('hex'), now: () => time,
    sendOtp: async ({ email, code }) => inbox.set(email, code) });
  t.after(() => db.close());
  return { db, app, tick: ms => { time += ms; } };
}

test('OTP per-IP budget is 20 per 15 min and every client behind a proxy shares it', async t => {
  const { app, tick } = fixture(t);
  console.log('trust proxy setting:', JSON.stringify(app.get('trust proxy')));
  const statuses = [];
  // 25 different members, each on a different real device, all arriving through
  // one reverse proxy — so each request carries a distinct X-Forwarded-For.
  for (let i = 0; i < 25; i++) {
    // no clock advance: each address is distinct, so the 60s per-address cooldown never applies
    const r = await request(app).post('/api/auth/request-otp')
      .set('X-Gym-Client', 'mobile')
      .set('X-Forwarded-For', `203.0.113.${i + 1}`)
      .send({ email: `device${i}@example.test` });
    statuses.push(r.status);
  }
  const accepted = statuses.filter(s => s === 202).length;
  const blocked = statuses.filter(s => s === 429).length;
  console.log('25 distinct members, 25 distinct X-Forwarded-For addresses, one TCP peer');
  console.log('statuses:', JSON.stringify(statuses));
  console.log(`accepted=${accepted} blocked=${blocked}`);
  console.log('=> if blocked > 0, the per-IP bucket is keyed on the proxy, not the member.');
  assert.equal(blocked, 0, `${blocked} of 25 legitimate members were refused an OTP because they shared a proxy`);
});

test('control: the same 25 requests without a proxy header behave identically', async t => {
  const { app, tick } = fixture(t);
  const statuses = [];
  for (let i = 0; i < 25; i++) {
    // (control) same, no clock advance
    const r = await request(app).post('/api/auth/request-otp').set('X-Gym-Client', 'mobile')
      .send({ email: `direct${i}@example.test` });
    statuses.push(r.status);
  }
  console.log('control statuses (no XFF):', JSON.stringify(statuses));
  console.log('control accepted:', statuses.filter(s => s === 202).length, 'blocked:', statuses.filter(s => s === 429).length);
});
