// QA Release Tester — closing the last three live rows, and the tidy-up.
import { readFileSync } from 'node:fs';
const SITE = 'https://srv1979069.hstgr.cloud';
const PW = JSON.parse(readFileSync('../qa-live-password.json', 'utf8'));
const say = (...a) => console.log(...a);
const step = n => say(`\n--- ${n}`);
const tokens = {};
async function api(method, path, { as = 'admin', body } = {}) {
  const res = await fetch(`${SITE}/api${path}`, { method,
    headers: { 'X-Gym-Client': 'mobile', ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(tokens[as] ? { Authorization: `Bearer ${tokens[as]}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const login = async (who, email, password) => {
  const r = await api('POST', '/auth/login', { as: null, body: { email, password } });
  tokens[who] = r.body.token; return r.status;
};
say('admin', await login('admin', 'qa-admin@example.test', PW.admin),
  '· staff', await login('staff', 'qa-staff@example.test', PW.staff));

step('SALE-09 · the server, not just the screen, refuses a package that is not for sale');
const all = await api('GET', '/packages');
const draft = (all.body.items ?? []).find(p => p.code === 'QA_DRAFT');
const archived = (all.body.items ?? []).find(p => p.code === 'QA_ARCHIVED');
const one = await api('POST', '/members', { as: 'staff',
  body: { name: 'QA ทดสอบขายแพ็กเกจปิด', phone: '0880000501', date_of_birth: null, emergency_contact: '' } });
say('   a QA member to try it on ->', one.status, JSON.stringify(one.body.member_code));
for (const [label, p] of [['a draft with no price', draft], ['one taken off sale', archived]]) {
  if (!p) { say(`   ${label}: not on the box`); continue; }
  const sell = await api('POST', `/members/${one.body.id}/grant`, { as: 'staff',
    body: { package_id: p.id, payment_method: 'cash', note: 'QA ทดสอบว่าขายไม่ได้' } });
  say(`   selling ${label.padEnd(22)} -> ${sell.status} ${JSON.stringify(sell.body.error)}`);
}

step('CARD-10 · the gym telephone, and the setting that hides it');
const gym = await api('GET', '/gym');
const profile = gym.body.profile ?? gym.body;
say('   the gym profile:', JSON.stringify({ name: profile.name, phone_primary: profile.phone_primary,
  phone_secondary: profile.phone_secondary, phone_display: profile.phone_display }));
say('   NOTE: not flipping this setting — it belongs to the gym, not to QA.');

step('clearing every QA row this round made');
const seen = new Map();
for (const q of ['QA', 'คิวเอ']) {
  const res = await api('GET', `/members?q=${encodeURIComponent(q)}&limit=100`);
  for (const m of res.body.items ?? []) seen.set(m.id, m);
}
say(`   ${seen.size} QA member rows found`);
for (const [id, m] of seen) {
  if (m.status === 'suspended') { say(`   ${m.member_code} ${m.name.slice(0, 26)} already suspended`); continue; }
  const row = await api('GET', `/members/${id}`);
  const res = await api('DELETE', `/members/${id}`, { body: { version: row.body.version } });
  say(`   ${m.member_code} ${m.name.slice(0, 26).padEnd(28)} -> ${res.status} ${JSON.stringify(res.body.status ?? res.body.error)}`);
}
const packs = await api('GET', '/packages');
for (const p of (packs.body.items ?? []).filter(p => p.code.startsWith('QA_'))) {
  if (p.status === 'archived') { say(`   ${p.code} already archived`); continue; }
  const res = await api('DELETE', `/packages/${p.id}`, { body: { version: p.version } });
  say(`   ${p.code.padEnd(18)} -> ${res.status} ${JSON.stringify(res.body.status ?? res.body.error)}`);
}
const left = await api('GET', '/packages');
say('   packages still on sale:', JSON.stringify((left.body.items ?? [])
  .filter(p => p.status === 'active').map(p => p.code)));
