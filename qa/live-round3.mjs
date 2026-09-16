// QA Release Tester — the third live pass at 170ee35: the rows the second pass
// asked the wrong question of, plus the tidy-up the second pass could not do.
//
//   node qa/live-round3.mjs
//
// It starts by waiting out the per-IP sign-in quota the AUTH-09 probe spent.
import { readFileSync } from 'node:fs';

const SITE = 'https://srv1979069.hstgr.cloud';
const PW = JSON.parse(readFileSync('../qa-live-password.json', 'utf8'));
const say = (...a) => console.log(...a);
const step = name => say(`\n--- ${name}`);
const wait = ms => new Promise(r => setTimeout(r, ms));

const tokens = {};
async function api(method, path, { as = 'admin', body, raw, headers = {} } = {}) {
  const res = await fetch(`${SITE}${/^\/(api|card)/.test(path) ? path : `/api${path}`}`, {
    method,
    headers: {
      'X-Gym-Client': 'mobile',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(as && tokens[as] ? { Authorization: `Bearer ${tokens[as]}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (raw) return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, headers: res.headers, body: parsed };
}
const attempt = async (email, password) => {
  const res = await fetch(`${SITE}/api/auth/login`, { method: 'POST',
    headers: { 'X-Gym-Client': 'mobile', 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }) });
  return { status: res.status, body: await res.json() };
};

step('waiting for the per-IP sign-in quota AUTH-09 spent');
for (let minute = 0; minute <= 17; minute++) {
  const res = await attempt('qa-admin@example.test', PW.admin);
  if (res.status === 200) { tokens.admin = res.body.token; say(`   in after ${minute} minutes`); break; }
  say(`   ${minute} min: ${res.status} ${JSON.stringify(res.body.error)}`);
  await wait(60000);
}
if (!tokens.admin) { say('the quota never let go — stopping'); process.exit(1); }
const staffIn = await attempt('qa-staff@example.test', PW.staff);
tokens.staff = staffIn.body.token;
say('   AUTH-09 the quota releases on its own, no intervention needed');

const member = '(filled in below)';
const members = await api('GET', '/members?query=QA');
const qa = (members.body.items ?? []).filter(m => /^QA |^คิวเอ/.test(m.name));
say(`   QA members on the box: ${qa.length}`);
const target = qa.find(m => m.name.includes('น้ำใสสุ่ม')) ?? qa[0];
say(`   working on: ${JSON.stringify({ name: target?.name, code: target?.member_code })}`);

// ---------------------------------------------------- F · packages that are not for sale
step('SALE-09 · a package with no price yet, and one taken off sale');
const rubbish = [];
const draft = await api('POST', '/packages', { body: { code: 'QA_DRAFT', name_th: 'QA ยังไม่กำหนดราคา (ห้ามขาย)',
  type: 'limited_sessions', duration_days: 7, session_limit: 1, status: 'draft',
  description: 'สร้างโดย QA เพื่อทดสอบ' } });
const archived = await api('POST', '/packages', { body: { code: 'QA_ARCHIVED', name_th: 'QA ปิดการขายแล้ว (ห้ามขาย)',
  type: 'limited_sessions', duration_days: 7, session_limit: 1, price_thb: 1, status: 'archived',
  description: 'สร้างโดย QA เพื่อทดสอบ' } });
for (const [label, res] of [['no price, draft', draft], ['priced, archived', archived]]) {
  say(`   ${label.padEnd(18)} -> ${res.status} ${JSON.stringify(res.body.error ?? res.body.code)}`);
  if (res.body?.id) rubbish.push(res.body.id);
}
const active = await api('POST', '/packages', { body: { code: 'QA_NOPRICE_LIVE', name_th: 'QA เปิดขายโดยไม่มีราคา',
  type: 'limited_sessions', duration_days: 7, session_limit: 1, status: 'active',
  description: 'สร้างโดย QA เพื่อทดสอบ' } });
say('   opening one for sale with no price at all ->', active.status,
  JSON.stringify(active.body.error ?? active.body.fields ?? active.body.code));
if (active.body?.id) rubbish.push(active.body.id);

for (const [label, res] of [['no price, draft', draft], ['priced, archived', archived]]) {
  if (!res.body?.id || !target) continue;
  const sell = await api('POST', `/members/${target.id}/grant`, { as: 'staff',
    body: { package_id: res.body.id, payment_method: 'cash', note: 'QA ทดสอบว่าขายไม่ได้' } });
  say(`   selling the ${label} package -> ${sell.status} ${JSON.stringify(sell.body.error)}`);
}
const shown = await api('GET', '/packages');
const sellableCodes = (shown.body.items ?? [])
  .filter(p => p.price_thb !== null && p.status === 'active').map(p => p.code);
say('   what the sell screen would offer:', JSON.stringify(sellableCodes));
say('   the draft and the archived package are absent:',
  !sellableCodes.includes('QA_DRAFT') && !sellableCodes.includes('QA_ARCHIVED'));

// ------------------------------------------- F · renewing while time is left
step('SALE-07 · a long package, then a short one bought before it runs out');
const long = await api('POST', '/packages', { body: { code: 'QA_LONG60', name_th: 'QA ทดสอบ 60 วัน (ห้ามขาย)',
  type: 'unlimited', duration_days: 60, price_thb: 1, status: 'active', description: 'สร้างโดย QA เพื่อทดสอบ' } });
const short = await api('POST', '/packages', { body: { code: 'QA_SHORT7', name_th: 'QA ทดสอบ 7 วัน (ห้ามขาย)',
  type: 'limited_sessions', duration_days: 7, session_limit: 2, price_thb: 1, status: 'active',
  description: 'สร้างโดย QA เพื่อทดสอบ' } });
for (const r of [long, short]) if (r.body?.id) rubbish.push(r.body.id);
const day = 86400000;
const when = t => (t ? new Date(t).toISOString().slice(0, 10) : null);
const fresh = await api('POST', '/members', { as: 'staff',
  body: { name: 'QA ทดสอบต่ออายุ', phone: '0880000407', date_of_birth: null, emergency_contact: '' } });
const who = fresh.body.id;
say('   a fresh QA member ->', fresh.status, JSON.stringify(fresh.body.member_code));
const buyLong = await api('POST', `/members/${who}/grant`, { as: 'staff',
  body: { package_id: long.body.id, payment_method: 'cash', note: 'QA ซื้อ 60 วัน' } });
const afterLong = await api('GET', `/members/${who}`, { as: 'staff' });
say('   after the 60-day package ->', buyLong.status,
  JSON.stringify({ package: afterLong.body.membership.package, expires: when(afterLong.body.membership.expires_at),
    days: Math.round((afterLong.body.membership.expires_at - Date.now()) / day) }));
const buyShort = await api('POST', `/members/${who}/grant`, { as: 'staff',
  body: { package_id: short.body.id, payment_method: 'cash', note: 'QA ต่ออายุ 7 วันทั้งที่ยังเหลือ 60 วัน' } });
const afterShort = await api('GET', `/members/${who}`, { as: 'staff' });
say('   then the 7-day one on top ->', buyShort.status,
  JSON.stringify({ package: afterShort.body.membership.package, expires: when(afterShort.body.membership.expires_at),
    days: Math.round((afterShort.body.membership.expires_at - Date.now()) / day) }));
say('   the membership date did not go backwards:',
  afterShort.body.membership.expires_at >= afterLong.body.membership.expires_at);
const ents = await api('GET', `/members/${who}/entitlements`, { as: 'staff' });
say('   what the member is holding:', JSON.stringify((ents.body.items ?? []).map(e =>
  ({ ends: when(e.expires_at), left: e.sessions_remaining }))));

step('SCAN · which of the two a check-in spends');
const card = await api('GET', `/members/${who}/card`, { as: 'staff' });
const scan = await api('POST', '/check-ins/verify', { as: 'staff',
  body: { qr: card.body.qr, device_label: 'QA รอบสาม' } });
const spent = await api('GET', `/members/${who}/entitlements`, { as: 'staff' });
say('   ->', scan.status, JSON.stringify({ result: scan.body.result, left: scan.body.remaining }));
say('   afterwards:', JSON.stringify((spent.body.items ?? []).map(e =>
  ({ ends: when(e.expires_at), left: e.sessions_remaining }))));
say('   it spent the one that runs out first, not the long one:',
  (spent.body.items ?? []).some(e => e.sessions_remaining === 1));

// --------------------------------------------------- C · the band on the card
step('CARD-09 · what the card says about the package');
say('   /card membership ->', JSON.stringify(card.body.membership));
say('   card_version', card.body.card_version, '· photo_readable', card.body.photo_readable);
const cardAfter = await api('GET', `/members/${who}/card`, { as: 'staff' });
say('   after the check-in, the card says ->', JSON.stringify(cardAfter.body.membership));

step('CARD-10 · the gym telephone on the card');
const gym = await api('GET', '/gym');
say('   the gym profile says:', JSON.stringify({ phone: gym.body.phone,
  show: gym.body.show_phone_on_card ?? gym.body.card_show_phone ?? '(no such setting)' }));

// -------------------------------------------------------------- the tidy-up
step('clearing what QA made (a delete here suspends the row, it does not remove it)');
const suspend = async id => {
  const row = await api('GET', `/members/${id}`);
  if (row.status !== 200) return row.status;
  const res = await api('DELETE', `/members/${id}`, { body: { version: row.body.version } });
  return `${res.status} ${JSON.stringify(res.body.status ?? res.body.error)}`;
};
for (const m of [...qa.map(x => x.id), who]) say(`   member ${m.slice(0, 8)} -> ${await suspend(m)}`);
for (const id of rubbish) {
  const row = await api('GET', `/packages/${id}`);
  const res = await api('DELETE', `/packages/${id}`, { body: { version: row.body?.version } });
  say(`   package ${id.slice(0, 8)} -> ${res.status} ${JSON.stringify(res.body.status ?? res.body.error)}`);
}
say(`\n(member placeholder ${member})`);
