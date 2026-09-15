// QA Release Tester — the second live pass at 170ee35: the matrix rows the
// first pass left unmeasured that can still be measured from here.
//
//   node qa/live-round2.mjs
//
// Everything it creates is named so the gym can tell at a glance it is QA's,
// and it deletes what it can when it is done. It never touches the reporter's
// account, and the IP rate-limit probe runs last because it costs this machine
// fifteen minutes of sign-ins.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const SITE = 'https://srv1979069.hstgr.cloud';
const PW = JSON.parse(readFileSync('../qa-live-password.json', 'utf8'));
const say = (...a) => console.log(...a);
const step = name => say(`\n--- ${name}`);
const THAI = /[฀-๿]/;
const english = [];
const check = (where, message) => {
  if (message && !THAI.test(String(message))) english.push([where, message]);
  return message;
};

const tokens = {};
async function api(method, path, { as = 'admin', body, raw, headers = {} } = {}) {
  const res = await fetch(`${SITE}${/^\/(api|card)/.test(path) ? path : `/api${path}`}`, {
    method,
    headers: {
      'X-Gym-Client': 'mobile',
      ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...(as && tokens[as] ? { Authorization: `Bearer ${tokens[as]}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  if (raw) return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let body2; try { body2 = JSON.parse(text); } catch { body2 = text; }
  return { status: res.status, headers: res.headers, body: body2 };
}
const signIn = async (who, email, password) => {
  const res = await fetch(`${SITE}/api/auth/login`, { method: 'POST',
    headers: { 'X-Gym-Client': 'mobile', 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }) });
  const body = await res.json();
  tokens[who] = body.token;
  return res.status;
};
async function photograph(tint = '#c8a27a') {
  const { createCanvas } = await import('@napi-rs/canvas');
  const c = createCanvas(600, 600); const g = c.getContext('2d');
  g.fillStyle = tint; g.fillRect(0, 0, 600, 600);
  g.fillStyle = '#33261c';
  g.beginPath(); g.arc(300, 250, 120, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(300, 560, 190, 170, 0, 0, Math.PI * 2); g.fill();
  return c.toBuffer('image/png');
}
const upload = async (id, bytes, name, type, as = 'staff') => {
  const form = new FormData();
  form.append('photo', new Blob([bytes], { type }), name);
  return api('PUT', `/members/${id}/photo`, { as, body: form });
};
async function readCard(id, as = 'staff') {
  const png = await api('GET', `/members/${id}/card.png`, { as, raw: true });
  if (png.status !== 200) return { status: png.status };
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const img = await loadImage(png.buffer);
  const c = createCanvas(img.width, img.height);
  c.getContext('2d').drawImage(img, 0, 0);
  const { default: jsQR } = await import('jsqr');
  const px = c.getContext('2d').getImageData(0, 0, img.width, img.height);
  const read = jsQR(new Uint8ClampedArray(px.data), img.width, img.height);
  return { status: 200, size: [img.width, img.height], bytes: png.buffer.length, qr: read?.data ?? null, buffer: png.buffer };
}

say(await signIn('admin', 'qa-admin@example.test', PW.admin) === 200 ? 'signed in as the QA owner'
  : 'the QA owner could not sign in — stopping');
await signIn('staff', 'qa-staff@example.test', PW.staff);
const rubbish = [];   // things to delete at the end

// ------------------------------------------------------------------ B · names
step('SIGNUP-03 · what the name field accepts');
const names = {
  'empty': '',
  'spaces only': '   ',
  '120 characters': 'ก'.repeat(120),
  '121 characters': 'ก'.repeat(121),
  'tone marks stacked': 'QA น้ำใสสุ่มเลี้ยงผึ้ง ก๊วนอุ๋งอิ๋ง',
  'an emoji in the name': 'QA ทดสอบ 💪🏋️ อิโมจิ',
  'angle brackets': 'QA <script>alert(1)</script> ทดสอบ',
};
const created = {};
let n = 200;
for (const [label, name] of Object.entries(names)) {
  const res = await api('POST', '/members', { as: 'staff',
    body: { name, phone: `08800002${String(n++).slice(-2)}`, date_of_birth: null, emergency_contact: '' } });
  created[label] = res.body?.id;
  if (res.body?.id) rubbish.push(['member', res.body.id]);
  say(`   ${label.padEnd(20)} -> ${res.status} ${JSON.stringify(res.status === 201
    ? { name: res.body.name } : check(`SIGNUP-03 ${label}`, res.body.error ?? res.body.fields))}`);
}

step('SIGNUP-04 · the same telephone typed four different ways');
const phones = ['0880000311', '088-000-0311', '+66880000311', ' 088 000 0311 '];
const first = await api('POST', '/members', { as: 'staff',
  body: { name: 'QA ทดสอบเบอร์โทร', phone: phones[0], date_of_birth: null, emergency_contact: '' } });
if (first.body?.id) rubbish.push(['member', first.body.id]);
say(`   ${JSON.stringify(phones[0])} -> ${first.status} stored as ${JSON.stringify(first.body.phone)}`);
for (const phone of phones.slice(1)) {
  const res = await api('POST', '/members', { as: 'staff',
    body: { name: 'QA เบอร์เดิมคนละรูปแบบ', phone, date_of_birth: null, emergency_contact: '' } });
  if (res.body?.id) rubbish.push(['member', res.body.id]);
  say(`   ${JSON.stringify(phone).padEnd(18)} -> ${res.status} ${JSON.stringify(res.status === 409
    ? check('SIGNUP-04', res.body.error) : { stored: res.body.phone })}`);
}

// --------------------------------------------------------- C · what is drawn
step('CARD-07/08 · a card for a stacked Thai name, a very long one, and no photograph');
for (const [label, key] of [['tone marks', 'tone marks stacked'], ['120 characters', '120 characters'],
  ['an emoji', 'an emoji in the name']]) {
  const id = created[key];
  if (!id) { say(`   ${label}: no member to draw`); continue; }
  const card = await readCard(id);
  say(`   ${label.padEnd(15)} no photograph -> ${card.status} ${JSON.stringify(card.size)} `
    + `${card.bytes} bytes · QR readable: ${!!card.qr}`);
  if (card.buffer) {
    mkdirSync('artifacts/live', { recursive: true });
    writeFileSync(`artifacts/live/card-${label.replace(/\s+/g, '-')}.png`, card.buffer);
  }
}

step('SIGNUP-11 · changing the photograph of somebody who already has one');
const faceId = created['tone marks stacked'];
const before = await readCard(faceId);
await upload(faceId, await photograph('#c8a27a'), 'first.png', 'image/png');
const one = await readCard(faceId);
await upload(faceId, await photograph('#7aa8c8'), 'second.png', 'image/png');
const two = await readCard(faceId);
const after = await api('GET', `/members/${faceId}`, { as: 'staff' });
say(`   no photo ${before.bytes} bytes -> first ${one.bytes} -> second ${two.bytes} bytes`);
say(`   the card is redrawn each time: ${one.bytes !== two.bytes} · has_photo now: ${after.body.has_photo}`
  + ` · the QR never moved: ${before.qr === two.qr}`);

// ----------------------------------------------------------- D · reissue again
step('REISSUE-05/06 · a reissue with no reason, then several in a row');
const noReason = await api('POST', `/members/${faceId}/card/reissue`, { body: { reason: '   ' } });
say('   a reason of nothing but spaces ->', noReason.status, JSON.stringify(check('REISSUE-05', noReason.body.error ?? noReason.body.fields)));
const versions = [];
for (let i = 1; i <= 3; i++) {
  const res = await api('POST', `/members/${faceId}/card/reissue`, { body: { reason: `QA ทดสอบออกบัตรใหม่ครั้งที่ ${i}` } });
  versions.push(res.body.card_version ?? res.status);
}
say('   three reissues in a row ->', JSON.stringify(versions));
const nowCard = await readCard(faceId);
const old = await api('POST', '/check-ins/verify', { as: 'staff', body: { qr: before.qr, device_label: 'QA รอบสอง' } });
say('   the very first card after three reissues ->', old.status, JSON.stringify(check('REISSUE-06', old.body.failure_reason)));
say('   the newest card still reads:', !!nowCard.qr);

// --------------------------------------------------------------- F · the money
step('SALE-09 · a package with no price, and one that is closed');
const unpriced = await api('POST', '/packages', { body: { code: 'QA_NOPRICE', name_th: 'QA ยังไม่กำหนดราคา (ห้ามขาย)',
  type: 'limited_sessions', duration_days: 7, session_limit: 1, price_thb: null, status: 'active',
  description: 'สร้างโดย QA เพื่อทดสอบ' } });
const closed = await api('POST', '/packages', { body: { code: 'QA_CLOSED', name_th: 'QA ปิดการขาย (ห้ามขาย)',
  type: 'limited_sessions', duration_days: 7, session_limit: 1, price_thb: 1, status: 'inactive',
  description: 'สร้างโดย QA เพื่อทดสอบ' } });
for (const [label, res] of [['no price', unpriced], ['closed', closed]]) {
  say(`   creating the ${label} package -> ${res.status}`);
  if (res.body?.id) rubbish.push(['package', res.body.id]);
}
for (const [label, res] of [['no price', unpriced], ['closed', closed]]) {
  if (!res.body?.id) continue;
  const sell = await api('POST', `/members/${faceId}/grant`, { as: 'staff',
    body: { package_id: res.body.id, payment_method: 'cash', note: 'QA ทดสอบว่าขายไม่ได้' } });
  say(`   selling the ${label} package -> ${sell.status} ${JSON.stringify(check(`SALE-09 ${label}`, sell.body.error))}`);
}

step('SALE-07 · renewing somebody who still has time left');
const list = await api('GET', '/packages');
const sellable = (list.body.items ?? []).find(p => p.code === 'QA_ROUND2');
const grantOnce = async note => api('POST', `/members/${faceId}/grant`, { as: 'staff',
  body: { package_id: sellable.id, payment_method: 'cash', note } });
const buy1 = await grantOnce('QA ต่ออายุครั้งที่ 1');
const ent1 = await api('GET', `/members/${faceId}/entitlements`, { as: 'staff' });
const buy2 = await grantOnce('QA ต่ออายุครั้งที่ 2 ขณะยังมีสิทธิ์เหลือ');
const ent2 = await api('GET', `/members/${faceId}/entitlements`, { as: 'staff' });
const pick = r => (r.body.items ?? []).map(e => ({ ends: e.ends_at ?? e.expires_at, left: e.sessions_remaining }));
say('   first purchase ->', buy1.status, JSON.stringify(pick(ent1)));
say('   second while still valid ->', buy2.status, JSON.stringify(pick(ent2)));

step('CARD-09 · the band along the bottom of the card against the entitlement');
const withBand = await api('GET', `/members/${faceId}/card`, { as: 'staff' });
say('   the card says:', JSON.stringify({ subtitle: withBand.body.subtitle, footer: withBand.body.footer,
  package: withBand.body.package_name, expires: withBand.body.expires_at ?? withBand.body.valid_until }));
say('   the entitlement says:', JSON.stringify(pick(ent2)));

step('SALE-08 · what a member of staff may and may not do');
const staffTries = {
  'take money': ['POST', `/members/${faceId}/grant`, { package_id: sellable.id, payment_method: 'cash', note: 'QA สิทธิ์พนักงาน' }],
  'edit a member': ['PUT', `/members/${faceId}`, { name: 'QA พนักงานแก้ชื่อ', phone: '0880000311' }],
  'edit a package': ['PUT', `/packages/${sellable.id}`, { ...sellable, price_thb: 2 }],
  'delete a member': ['DELETE', `/members/${created['an emoji in the name']}`, undefined],
  'reissue a card': ['POST', `/members/${faceId}/card/reissue`, { reason: 'QA พนักงานออกบัตรใหม่' }],
  'read the till': ['GET', '/admin/sales', undefined],
  'read the audit of a member': ['GET', `/members/${faceId}/audit`, undefined],
};
for (const [label, [method, path, body]] of Object.entries(staffTries)) {
  const res = await api(method, path, { as: 'staff', body });
  say(`   ${label.padEnd(26)} -> ${res.status}${res.status >= 400 ? ' ' + JSON.stringify(check(`SALE-08 ${label}`, res.body.error)) : ''}`);
}

// ------------------------------------------------------------- G · the accounts
step('USER-04 · changing a role cuts the sessions that role was using');
const users = await api('GET', '/users');
const staffRow = (users.body.items ?? []).find(u => u.email === 'qa-staff@example.test');
const aliveBefore = await api('GET', '/me', { as: 'staff' });
const promote = await api('PUT', `/users/${staffRow.id}/role`, { body: { role: 'admin' } });
const afterPromote = await api('GET', '/me', { as: 'staff' });
say('   staff session before ->', aliveBefore.status, '| promoted ->', promote.status,
  '| the same session after ->', afterPromote.status);
const demote = await api('PUT', `/users/${staffRow.id}/role`, { body: { role: 'staff' } });
say('   put back to staff ->', demote.status);
say('   signing in again ->', await signIn('staff', 'qa-staff@example.test', PW.staff));

step('USER-06 · suspending an account is not the same as suspending a membership');
const suspend = await api('POST', `/users/${staffRow.id}/suspend`, { body: { reason: 'QA ทดสอบระงับบัญชี' } });
const blocked = await api('GET', '/me', { as: 'staff' });
const memberStill = await api('GET', `/members/${faceId}`);
say('   suspended ->', suspend.status, '| that session ->', blocked.status,
  '| the QA member is still', JSON.stringify(memberStill.body.status));
const loginWhileSuspended = await fetch(`${SITE}/api/auth/login`, { method: 'POST',
  headers: { 'X-Gym-Client': 'mobile', 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'qa-staff@example.test', password: PW.staff }) });
const suspendedBody = await loginWhileSuspended.json();
say('   signing in while suspended ->', loginWhileSuspended.status, JSON.stringify(check('USER-06', suspendedBody.error)));
const restore = await api('POST', `/users/${staffRow.id}/restore`, { body: {} });
say('   restored ->', restore.status, '| signing in again ->', await signIn('staff', 'qa-staff@example.test', PW.staff));

step('USER-05 · what the audit kept of all that');
const audit = await api('GET', `/users/${staffRow.id}/audit`);
const rows = (audit.body.items ?? []).map(r => ({ action: r.action, by: r.actor_email ?? r.actor_id?.slice(0, 8) }));
say('   ->', audit.status, JSON.stringify(rows));
say('   actions present:', JSON.stringify([...new Set(rows.map(r => r.action))]));

step('USER-03 · the guard on the last owner (tried against a QA account only)');
const self = await api('GET', '/me');
const demoteSelf = await api('PUT', `/users/${self.body.id}/role`, { body: { role: 'staff' } });
say('   the QA owner demoting themselves ->', demoteSelf.status, JSON.stringify(check('USER-03', demoteSelf.body.error)));
if (demoteSelf.status === 200) {
  say('   NOTE: it went through — putting the role back');
  await signIn('admin', 'qa-admin@example.test', PW.admin);
  const back = await api('PUT', `/users/${self.body.id}/role`, { body: { role: 'admin' } });
  say('   put back ->', back.status);
  if (back.status !== 200) say('   !!! could not restore the QA owner role — tell Infrastructure');
}

// ------------------------------------------------------------------ the tidy-up
step('clearing what QA made');
for (const [kind, id] of rubbish.reverse()) {
  const res = await api('DELETE', `/${kind === 'member' ? 'members' : 'packages'}/${id}`);
  say(`   ${kind} ${id.slice(0, 8)} -> ${res.status}${res.status >= 400 ? ' ' + JSON.stringify(res.body.error) : ''}`);
}

step('XCUT-08 · anything that answered in English');
say(english.length ? JSON.stringify(english, null, 1) : '   nothing — every refusal above was in Thai');

// ------------------------------------------------- A · the quota, saved for last
step('AUTH-09 · the per-IP quota on the sign-in form (this locks this machine out for 15 minutes)');
const statuses = [];
for (let i = 0; i < 70; i++) {
  const res = await fetch(`${SITE}/api/auth/login`, { method: 'POST',
    headers: { 'X-Gym-Client': 'mobile', 'content-type': 'application/json',
      'X-Forwarded-For': `203.0.113.${i % 250}` },   // a spoofed hop must not buy more tries
    body: JSON.stringify({ email: `qa-nobody-${i}@example.test`, password: 'not-the-password' }) });
  statuses.push(res.status);
  if (res.status === 429) { say(`   refused at attempt ${i + 1} with 429`); break; }
}
const counted = statuses.reduce((a, s) => ({ ...a, [s]: (a[s] ?? 0) + 1 }), {});
say('   attempts by status:', JSON.stringify(counted));
say('   a forged X-Forwarded-For did not buy more tries:', statuses.includes(429));
