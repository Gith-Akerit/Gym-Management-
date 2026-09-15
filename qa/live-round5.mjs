// QA Release Tester — pinning down SALE-09: the server sells what the screen hides.
import { readFileSync } from 'node:fs';
const SITE = 'https://srv1979069.hstgr.cloud';
const PW = JSON.parse(readFileSync('../qa-live-password.json', 'utf8'));
const say = (...a) => console.log(...a);
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
await login('admin', 'qa-admin@example.test', PW.admin);
await login('staff', 'qa-staff@example.test', PW.staff);

// A package the owner priced but has NOT opened for sale: the likeliest real
// version of this, because a price gets filled in while the package is drafted.
const priced = await api('POST', '/packages', { body: { code: 'QA_DRAFT_PRICED',
  name_th: 'QA ร่างที่ใส่ราคาไว้แล้ว แต่ยังไม่เปิดขาย (ห้ามขาย)', type: 'unlimited',
  duration_days: 30, price_thb: 1500, status: 'draft', description: 'สร้างโดย QA เพื่อทดสอบ' } });
say('a draft package that already has a price ->', priced.status,
  JSON.stringify({ code: priced.body.code, status: priced.body.status, price: priced.body.price_thb }));

const member = await api('POST', '/members', { as: 'staff',
  body: { name: 'QA ทดสอบขายของที่ยังไม่เปิดขาย', phone: '0880000601', date_of_birth: null, emergency_contact: '' } });
const sold = await api('POST', `/members/${member.body.id}/grant`, { as: 'staff',
  body: { package_id: priced.body.id, payment_method: 'cash', note: 'QA ทดสอบว่าขายได้ไหมทั้งที่ยังไม่เปิดขาย' } });
say('a member of staff selling it ->', sold.status,
  JSON.stringify({ order: sold.body.status, price: sold.body.price_satang_snapshot, error: sold.body.error }));

const listed = await api('GET', '/packages');
const offered = (listed.body.items ?? []).filter(p => p.price_thb !== null && p.status === 'active').map(p => p.code);
say('what the sell screen offers:', JSON.stringify(offered));
say('so the screen hides it, and the API sells it anyway:',
  sold.status === 201 && !offered.includes('QA_DRAFT_PRICED'));

const after = await api('GET', `/members/${member.body.id}`, { as: 'staff' });
say('the member now holds:', JSON.stringify(after.body.membership));
const till = await api('GET', '/admin/sales');
say('and the day\'s takings say:', JSON.stringify(till.body.items?.[0]));

say('\n--- clearing up');
for (const q of ['QA', 'คิวเอ', 'ก']) {
  const res = await api('GET', `/members?q=${encodeURIComponent(q)}&limit=100`);
  for (const m of res.body.items ?? []) {
    if (m.status === 'suspended') continue;
    const row = await api('GET', `/members/${m.id}`);
    const out = await api('DELETE', `/members/${m.id}`, { body: { version: row.body.version } });
    say(`   ${m.member_code} ${m.name.slice(0, 24).padEnd(26)} -> ${out.status} ${JSON.stringify(out.body.status ?? out.body.error)}`);
  }
}
const packs = await api('GET', '/packages');
for (const p of (packs.body.items ?? []).filter(p => p.code.startsWith('QA_') && p.status !== 'archived')) {
  const out = await api('DELETE', `/packages/${p.id}`, { body: { version: p.version } });
  say(`   ${p.code.padEnd(18)} -> ${out.status} ${JSON.stringify(out.body.status ?? out.body.error)}`);
}
const end = await api('GET', '/members?q=&limit=100');
say('   members left active on the box:', JSON.stringify((end.body.items ?? [])
  .filter(m => m.status === 'active').map(m => m.name)));
say('   packages left on sale:', JSON.stringify(((await api('GET', '/packages')).body.items ?? [])
  .filter(p => p.status === 'active').map(p => p.code)));
