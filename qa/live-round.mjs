// QA Release Tester — the last round on the running gym (170ee35).
//
// Everything here runs against https://srv1979069.hstgr.cloud with the QA
// administrator Infrastructure created. It never touches the reporter's
// account or their link, and every row it creates says QA in its name.
//
//   node qa/live-round.mjs
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const SITE = 'https://srv1979069.hstgr.cloud';
// The set-password token is a one-shot credential: it is passed in, never
// written down here.  QA_SETPW_TOKEN=<token from the link Infrastructure posted>
const SETPW = process.env.QA_SETPW_TOKEN || '';
const VAULT = '../qa-live-password.json';
const say = (...a) => console.log(...a);
const step = name => say(`\n--- ${name}`);

/** The password lives outside the repository and is never printed. */
function password() {
  if (existsSync(VAULT)) return JSON.parse(readFileSync(VAULT, 'utf8'));
  const made = { admin: `Qa-${randomBytes(18).toString('base64url')}`, staff: `Qs-${randomBytes(18).toString('base64url')}` };
  writeFileSync(VAULT, JSON.stringify(made, null, 1));
  return made;
}
const PW = password();

const tokens = {};
async function api(method, path, { as, body, raw, headers = {} } = {}) {
  const res = await fetch(`${SITE}${path.startsWith('/api') || path.startsWith('/card') ? path : `/api${path}`}`, {
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
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, headers: res.headers, body: parsed };
}

/** A face the card can actually draw, and one it cannot. */
async function photograph(seed = 1) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const c = createCanvas(600, 600); const g = c.getContext('2d');
  g.fillStyle = seed === 1 ? '#c8a27a' : '#9fb7c8'; g.fillRect(0, 0, 600, 600);
  g.fillStyle = '#33261c';
  g.beginPath(); g.arc(300, 250, 120, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(300, 560, 190, 170, 0, 0, Math.PI * 2); g.fill();
  return c.toBuffer('image/png');
}
const truncatedJpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
  0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
const upload = async (memberId, bytes, name, type, as = 'admin') => {
  const form = new FormData();
  form.append('photo', new Blob([bytes], { type }), name);
  return api('PUT', `/members/${memberId}/photo`, { as, body: form });
};

// ------------------------------------------------------- A · the way in
step('AUTH-15 / UI-01 · the set-password link Infrastructure issued');
const peek = await api('GET', `/auth/set-password/${SETPW}`);
say('   opening the link ->', peek.status, JSON.stringify(peek.body));
if (peek.status !== 200) {
  say('   the link is spent or expired — ask Infrastructure for a new one and rerun');
  process.exit(1);
}
const set = await api('POST', '/auth/set-password', { body: { token: SETPW, password: PW.admin } });
say('   setting the password ->', set.status, JSON.stringify(set.body));
const reuse = await api('POST', '/auth/set-password', { body: { token: SETPW, password: 'another-one-entirely' } });
say('   using the same link again ->', reuse.status, JSON.stringify(reuse.body.error));

step('AUTH-01 · signing in as the QA administrator');
const signedIn = await api('POST', '/auth/login', { body: { email: 'qa-admin@example.test', password: PW.admin } });
tokens.admin = signedIn.body.token;
say('   ->', signedIn.status, JSON.stringify({ role: signedIn.body.role, email: signedIn.body.email }));
say('   a token came back:', !!tokens.admin);

step('AUTH-03 · what a wrong password says (never the reporter\'s address)');
const wrong = await api('POST', '/auth/login', { body: { email: 'qa-admin@example.test', password: 'not-the-password' } });
const unknown = await api('POST', '/auth/login', { body: { email: 'qa-nobody-0001@example.test', password: 'not-the-password' } });
say('   wrong password ->', wrong.status, JSON.stringify(wrong.body.error));
say('   unknown address ->', unknown.status, JSON.stringify(unknown.body.error));
say('   same sentence:', String(wrong.body.error).replace(/\d+/g, 'N') === String(unknown.body.error).replace(/\d+/g, 'N'));

// ------------------------------------------------- G · users and permissions
step('USER-02 · creating the staff account from "ผู้ใช้และสิทธิ์"');
const created = await api('POST', '/users', { as: 'admin', body: { email: 'qa-staff@example.test', role: 'staff' } });
say('   create ->', created.status, JSON.stringify({ role: created.body.role, status: created.body.status }));
const staffId = created.body.id ?? (await api('GET', '/users?q=qa-staff', { as: 'admin' })).body.items?.[0]?.id;
const noPassword = await api('POST', '/auth/login', { as: null, body: { email: 'qa-staff@example.test', password: PW.staff } });
say('   signing in before a password is set ->', noPassword.status, JSON.stringify(noPassword.body.error));
const gave = await api('PUT', `/users/${staffId}/password`, { as: 'admin', body: { password: PW.staff } });
say('   the owner sets their password ->', gave.status);
const staffIn = await api('POST', '/auth/login', { body: { email: 'qa-staff@example.test', password: PW.staff } });
tokens.staff = staffIn.body.token;
say('   the new staff member signs in ->', staffIn.status, JSON.stringify({ role: staffIn.body.role }));

step('USER-01 · what that staff account may not do');
const refused = {};
for (const [name, method, path, body] of [
  ['GET /users', 'GET', '/users'],
  ['POST /users', 'POST', '/users', { email: 'qa-sneak@example.test', role: 'admin' }],
  ['PUT /users/:id/role', 'PUT', `/users/${staffId}/role`, { role: 'admin' }],
  ['GET /admin/sales', 'GET', '/admin/sales'],
]) refused[name] = (await api(method, path, { as: 'staff', body })).status;
say('  ', JSON.stringify(refused));

// ------------------------------------------------------- packages and a member
step('SALE-09 · a package to sell');
const pkg = await api('POST', '/packages', { as: 'admin', body: {
  code: 'QA_ROUND2', name_th: 'QA ทดสอบระบบ รอบสุดท้าย (ห้ามขาย)', type: 'limited_sessions',
  duration_days: 7, session_limit: 3, price_thb: 1, status: 'active',
  description: 'สร้างโดย QA เพื่อทดสอบบนเครื่องจริง ปิดการขายหลังทดสอบ' } });
say('   ->', pkg.status, JSON.stringify({ name: pkg.body.name_th, price: pkg.body.price_thb }));

step('SIGNUP-01 · signing somebody up at the counter, no email anywhere');
const member = await api('POST', '/members', { as: 'staff', body: {
  name: 'คิวเอ ทดสอบรอบสุดท้าย', phone: '0880000199', date_of_birth: null, emergency_contact: '' } });
say('   ->', member.status, JSON.stringify({ code: member.body.member_code, has_photo: member.body.has_photo }));
const memberId = member.body.id;

step('SIGNUP-02 · the same phone number twice');
const duplicate = await api('POST', '/members', { as: 'staff', body: {
  name: 'คิวเอ ซ้ำเบอร์', phone: '0880000199', date_of_birth: null, emergency_contact: '' } });
say('   ->', duplicate.status, JSON.stringify(duplicate.body.error));

// ------------------------------------------------------------ B/C · the photo
step('PHOTO-03 layer 1 · a photograph the card could not draw is refused at the door');
const broken = await upload(memberId, truncatedJpeg(), 'half-sent.jpg', 'image/jpeg', 'staff');
say('   truncated JPEG ->', broken.status, JSON.stringify(broken.body.error ?? broken.body.has_photo));
const notAnImage = await upload(memberId, Buffer.from('%PDF-1.4 not a picture'), 'face.jpg', 'image/jpeg', 'staff');
say('   a PDF wearing a .jpg name ->', notAnImage.status, JSON.stringify(notAnImage.body.error));

step('SIGNUP-05/06 · a real photograph');
const photo = await upload(memberId, await photograph(), 'face.png', 'image/png', 'staff');
say('   ->', photo.status, JSON.stringify({ has_photo: photo.body.has_photo }));
const keptPhoto = await upload(memberId, truncatedJpeg(), 'half-sent-again.jpg', 'image/jpeg', 'staff');
const stillThere = await api('GET', `/members/${memberId}`, { as: 'staff' });
say('   a bad upload after a good one ->', keptPhoto.status,
  '| the good photograph survived:', stillThere.body.has_photo);

// ---------------------------------------------------------------- C · the card
step('CARD-06 · the card the gym will send, read back with a scanner');
const card = await api('GET', `/members/${memberId}/card`, { as: 'staff' });
say('   /card ->', card.status, JSON.stringify({ qr: card.body.qr, version: card.body.card_version,
  photo_readable: card.body.photo_readable, subtitle: card.body.subtitle }));
const png = await api('GET', `/members/${memberId}/card.png`, { as: 'staff', raw: true });
say('   /card.png ->', png.status, png.headers.get('content-type'), '|', png.buffer.length, 'bytes',
  '|', png.headers.get('content-disposition'));
mkdirSync('artifacts/live', { recursive: true });
writeFileSync('artifacts/live/card-from-the-box.png', png.buffer);

const { createCanvas, loadImage } = await import('@napi-rs/canvas');
const image = await loadImage(png.buffer);
const canvas = createCanvas(image.width, image.height);
canvas.getContext('2d').drawImage(image, 0, 0);
const { default: jsQR } = await import('jsqr');
const pixels = canvas.getContext('2d').getImageData(0, 0, image.width, image.height);
const read = jsQR(new Uint8ClampedArray(pixels.data), image.width, image.height);
say(`   the picture is ${image.width} x ${image.height}`);
say('   what a scanner reads off it:', JSON.stringify(read?.data));
say('   it matches the token the server says is on it:', read?.data === card.body.qr);
const half = createCanvas(540, 675);
half.getContext('2d').drawImage(image, 0, 0, 540, 675);
const shrunk = half.getContext('2d').getImageData(0, 0, 540, 675);
say('   still readable after a chat app halves it:',
  !!jsQR(new Uint8ClampedArray(shrunk.data), 540, 675));

// --------------------------------------------------------------- F · the money
step('SALE-01 · taking the money at the counter');
const sale = await api('POST', `/members/${memberId}/grant`, { as: 'staff', body: {
  package_id: pkg.body.id, payment_method: 'cash', note: 'QA ทดสอบรับเงินสด' } });
say('   ->', sale.status, JSON.stringify({ status: sale.body.order?.status ?? sale.body.status,
  method: sale.body.order?.payment_method ?? sale.body.payment_method }));
const sales = await api('GET', '/admin/sales', { as: 'admin' });
say('   daily sales ->', sales.status, JSON.stringify(sales.body.items?.[0]));

// ----------------------------------------------------------------- E · the scan
step('SCAN-01/04/05/06 · the four things the counter can see');
const scan = (qr, as = 'staff') => api('POST', '/check-ins/verify', { as, body: { qr, device_label: 'QA รอบสุดท้าย' } });
const allowed = await scan(card.body.qr);
say('   a card with a package ->', allowed.status, JSON.stringify({ result: allowed.body.result,
  who: allowed.body.member?.name, photo: !!allowed.body.member?.has_photo, left: allowed.body.remaining ?? allowed.body.entitlement }));
const again = await scan(card.body.qr);
say('   the same card again ->', again.status, JSON.stringify({ result: again.body.result, reason: again.body.failure_reason }));
const forged = await scan(card.body.qr.replace(/\.[0-9a-f]{32}$/, `.${'a'.repeat(32)}`));
say('   the same card with the signature rewritten ->', forged.status,
  JSON.stringify({ result: forged.body.result, reason: forged.body.failure_reason }));

// ------------------------------------------------------- D · links and reissue
step('REISSUE-01/02 · the link the gym sends, and what a reissue does to it');
const link = await api('POST', `/members/${memberId}/card/link`, { as: 'staff', body: {} });
say('   issued ->', link.status, JSON.stringify({ url: link.body.url,
  days: Math.round((link.body.expires_at - Date.now()) / 86400000), version: link.body.card_version }));
const opened = await api('GET', link.body.url, { raw: true });
say('   a customer with no session opens it ->', opened.status, opened.headers.get('content-type'),
  '|', opened.buffer.length, 'bytes | cache:', opened.headers.get('cache-control'));
const byStaff = await api('POST', `/members/${memberId}/card/reissue`, { as: 'staff', body: { reason: 'ทดสอบ' } });
say('   staff tries to reissue ->', byStaff.status, JSON.stringify(byStaff.body.error));
const reissued = await api('POST', `/members/${memberId}/card/reissue`, { as: 'admin', body: { reason: 'QA ทดสอบออกบัตรใหม่' } });
say('   the owner reissues ->', reissued.status, JSON.stringify({ version: reissued.body.member?.card_version }));
const deadLink = await api('GET', link.body.url, { raw: true });
const deadCard = await scan(card.body.qr);
say('   the link already sent to the customer ->', deadLink.status);
say('   the card already in their phone ->', deadCard.status, JSON.stringify({
  result: deadCard.body.result, reason: deadCard.body.failure_reason }));
const fresh = await api('GET', `/members/${memberId}/card`, { as: 'staff' });
const afterReissue = await scan(fresh.body.qr);
say('   the new card ->', afterReissue.status, JSON.stringify({ result: afterReissue.body.result }));

// ------------------------------------------------------------------- I · leftovers
step('XCUT · what is left of the old member application');
const gone = {};
for (const path of ['/orders', '/entitlements', '/me/check-in-token', '/auth/request-otp', '/there-is-no-such-route']) {
  gone[path] = (await api('GET', path, { as: 'staff' })).status;
}
say('  ', JSON.stringify(gone));
say('\nQA rows created on the box: member', memberId, '· package QA_ROUND2 · users qa-admin, qa-staff');
