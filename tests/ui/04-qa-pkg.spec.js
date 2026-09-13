// QA Release Tester — Phase 2 UX cases in a real browser.
// PKG-033/045/053/080/081/082/083 plus evidence capture for the reported defects.
//
// Structured as two journeys rather than seven small tests on purpose: the 60
// second OTP cooldown is a real rule, so signing one admin address in seven
// times would be testing something no human does. Runs after 02-settings, which
// has already put the 1,200 baht monthly package on sale.
import { test, expect } from '@playwright/test';

function jpegBuffer(tag = 'a') {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.from([...Buffer.from(String(tag).padEnd(8, '.'), 'latin1'), 0xff, 0xd9]),
  ]);
}
async function login(page, email) {
  await page.goto('/');
  await page.getByLabel('อีเมล', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'รับรหัสทางอีเมล' }).click();
  await expect(page.getByLabel('รหัสยืนยัน 6 หลัก')).toBeVisible();
  const { code } = await (await page.request.get(`/__test/code?email=${email}`)).json();
  await page.getByLabel('รหัสยืนยัน 6 หลัก').fill(code);
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click();
}
async function registerMember(page, { email, name, phone }) {
  await login(page, email);
  await page.getByLabel('ชื่อ–นามสกุล').fill(name);
  await page.getByLabel('เบอร์มือถือ').fill(phone);
  await page.getByRole('button', { name: 'เริ่มใช้งาน' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}
async function newMember(browser, who) {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await registerMember(page, who);
  return page;
}
async function publish(page, { code, name, baht }) {
  await page.getByRole('button', { name: 'แพ็กเกจ', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'แพ็กเกจทั้งหมด' })).toBeVisible();
  await page.getByRole('button', { name: '＋ เพิ่มแพ็กเกจ' }).click();
  await page.getByLabel('รหัสแพ็กเกจ', { exact: false }).fill(code);
  await page.getByLabel('ชื่อแพ็กเกจ', { exact: false }).fill(name);
  await page.getByLabel('ราคา (บาท)', { exact: false }).fill(String(baht));
  await page.getByLabel('สถานะแพ็กเกจ').selectOption('active');
  await page.getByRole('button', { name: 'บันทึกแพ็กเกจ' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'เพิ่มแพ็กเกจแล้ว' })).toBeVisible();
}
async function buy(page, packageName) {
  await page.getByRole('button', { name: 'แพ็กเกจ' }).click();
  await page.getByRole('button', { name: `ซื้อแพ็กเกจนี้` }).nth(packageName.index ?? 0).click();
  await expect(page.getByRole('heading', { name: 'PromptPay' })).toBeVisible();
}
async function sendSlip(page, reference, { amount, tag = 's' } = {}) {
  await page.getByLabel('รูปสลิป', { exact: false })
    .setInputFiles({ name: 'slip.jpg', mimeType: 'image/jpeg', buffer: jpegBuffer(tag) });
  await page.getByLabel('เลขอ้างอิงในสลิป').fill(reference);
  const amountField = page.getByLabel('ยอดที่โอน', { exact: false });
  if (amount !== undefined && await amountField.count()) await amountField.fill(String(amount));
  await page.getByRole('button', { name: 'ส่งสลิป', exact: true }).click();
}

test('PKG-080/081/082/045/083/053 the whole buy-and-review journey on a phone', async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  await login(admin, 'admin4@example.test');
  await expect(admin.getByRole('button', { name: 'ออกจากระบบ' })).toBeVisible();
  await publish(admin, { code: 'QA_UX_30D', name: 'QA รายเดือน', baht: 1500 });

  // --- PKG-080/081 · reaching the QR ----------------------------------------
  const buyer = await newMember(browser, { email: 'ux-buy@example.test', name: 'ยูเอ็กซ์ ทดสอบ', phone: '0895550001' });
  const errors = []; buyer.on('pageerror', e => errors.push(e.message));
  let screens = 1;
  await buyer.getByRole('button', { name: 'แพ็กเกจ' }).click(); screens++;
  await expect(buyer.getByText('฿1,500.00').first()).toBeVisible();
  await buyer.getByRole('button', { name: 'ซื้อแพ็กเกจนี้' }).last().click(); screens++;
  await expect(buyer.getByRole('heading', { name: 'PromptPay' })).toBeVisible();
  console.log('PKG-080 screens from home to the QR:', screens);
  expect(screens).toBeLessThanOrEqual(3);

  const qrText = await buyer.evaluate(() => document.body.innerText);
  const has = {
    amount: /฿1,500\.00/.test(qrText),
    countdown: /หมดอายุใน \d+:\d\d/.test(qrText),
    saveButton: await buyer.getByRole('link', { name: 'บันทึกรูป QR' }).isVisible(),
    uploadControl: await buyer.getByLabel('รูปสลิป', { exact: false }).count() > 0,
    instructions: /สแกน|แอปธนาคาร|โอน/.test(qrText),
  };
  const px = await buyer.getByRole('img', { name: /QR พร้อมเพย์/ }).evaluate(i => ({ w: i.naturalWidth, h: i.naturalHeight }));
  console.log('PKG-081 QR screen text:\n' + qrText);
  console.log('PKG-081 contains:', JSON.stringify(has), '| QR decoded to', JSON.stringify(px));
  expect(px.w).toBeGreaterThan(50);
  for (const [k, v] of Object.entries(has)) expect(v, `QR screen missing: ${k}`).toBeTruthy();
  expect(await buyer.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await buyer.screenshot({ path: 'qa/evidence-qr-screen.png', fullPage: true });

  // --- PKG-082 · what the member is told while waiting ----------------------
  await sendSlip(buyer, 'REF-UX-WAIT', { tag: 'w' });
  await expect(buyer.getByText('รอตรวจสอบการชำระเงิน')).toBeVisible();
  const waitText = await buyer.evaluate(() => document.body.innerText);
  const honest = {
    saysWaiting: /รอตรวจสอบ/.test(waitText),
    saysNotUsableYet: /ยังใช้เข้ายิมไม่ได้|ยังไม่สามารถ|จนกว่าจะอนุมัติ/.test(waitText),
    givesTimeframe: /ภายใน .*(นาที|ชั่วโมง)/.test(waitText),
    noFalseSuccess: !/ชำระเงินสำเร็จ|ชำระเงินเรียบร้อย|ใช้ได้แล้ว/.test(waitText),
    qrGone: !/PromptPay/.test(waitText),
  };
  console.log('PKG-082 waiting screen:\n' + waitText);
  console.log('PKG-082 honesty checks:', JSON.stringify(honest));
  await buyer.screenshot({ path: 'qa/evidence-awaiting-review.png', fullPage: true });
  for (const [k, v] of Object.entries(honest)) expect(v, `PKG-082 failed: ${k}`).toBeTruthy();

  // --- PKG-045/083 · the admin clears it ------------------------------------
  await admin.getByRole('button', { name: 'ตรวจสลิป' }).click();
  await expect(admin.getByText(/รอตรวจสอบ \d+ รายการ/)).toBeVisible();
  let clicks = 0;
  await admin.getByRole('button', { name: 'ตรวจสลิปของ ยูเอ็กซ์ ทดสอบ' }).click(); clicks++;
  await expect(admin.getByRole('heading', { name: 'ตรวจสลิป' })).toBeVisible();
  const review = await admin.evaluate(() => document.body.innerText);
  const oneScreen = {
    slipImage: await admin.getByRole('img', { name: 'สลิปการโอนเงิน' }).isVisible(),
    amountDue: /฿1,500\.00/.test(review),
    memberName: /ยูเอ็กซ์ ทดสอบ/.test(review),
    packageName: /QA รายเดือน/.test(review),
    uploadedAt: /ส่งสลิปเมื่อ/.test(review),
    reference: /REF-UX-WAIT/.test(review),
  };
  console.log('PKG-045 review screen:\n' + review.slice(0, 800));
  console.log('PKG-045 everything on one screen:', JSON.stringify(oneScreen));
  await admin.screenshot({ path: 'qa/evidence-slip-review.png', fullPage: true });
  for (const [k, v] of Object.entries(oneScreen)) expect(v, `PKG-045 missing: ${k}`).toBeTruthy();
  await admin.getByLabel('ตรวจกับแอปธนาคารแล้ว', { exact: false }).check(); clicks++;
  await admin.getByRole('button', { name: 'อนุมัติและให้สิทธิ์' }).click(); clicks++;
  await expect(admin.getByRole('status').filter({ hasText: 'อนุมัติแล้ว' })).toBeVisible();
  console.log('PKG-083 clicks to clear one slip once it is open:', clicks);
  expect(clicks).toBeLessThanOrEqual(3);

  expect(errors, 'JS errors on the member app').toEqual([]);
});

test('PKG-053 a short payment can be approved with no explanation at all', async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  await login(admin, 'admin3@example.test');
  await expect(admin.getByRole('button', { name: 'ออกจากระบบ' })).toBeVisible();
  const short = await newMember(browser, { email: 'ux-short@example.test', name: 'จ่าย ขาด', phone: '0895550004' });
  await short.getByRole('button', { name: 'แพ็กเกจ' }).click();
  await short.getByRole('button', { name: 'ซื้อแพ็กเกจนี้' }).last().click();
  await expect(short.getByRole('heading', { name: 'PromptPay' })).toBeVisible();
  await sendSlip(short, 'REF-UX-SHORT', { amount: 500, tag: 'x' });
  await expect(short.getByText('รอตรวจสอบการชำระเงิน')).toBeVisible();

  await admin.getByRole('button', { name: 'ตรวจสลิป' }).click();
  await admin.getByRole('button', { name: 'ตรวจสลิปของ จ่าย ขาด' }).click();
  await expect(admin.getByRole('heading', { name: 'ตรวจสลิป' })).toBeVisible();
  const warned = await admin.getByText('ยอดไม่ตรง').isVisible().catch(() => false);
  console.log('PKG-053 mismatch warning shown:', warned);
  await admin.screenshot({ path: 'qa/evidence-amount-mismatch.png', fullPage: true });
  expect(warned, 'a 500 baht slip against a 1,500 baht order was not flagged').toBeTruthy();
  await admin.getByLabel('ตรวจกับแอปธนาคารแล้ว', { exact: false }).check();
  const approve = admin.getByRole('button', { name: 'อนุมัติและให้สิทธิ์' });
  const note = await admin.getByLabel('หมายเหตุ', { exact: false }).inputValue();
  const enabled = await approve.isEnabled();
  console.log('PKG-053 note box:', JSON.stringify(note), '| approve enabled with an empty note:', enabled);
  expect(enabled && note === '',
    'the screen asks for a reason but nothing stops an approval without one').toBeFalsy();
  });

test('PKG-033 the payment screens degrade honestly when the network drops', async ({ browser }) => {
  const page = await newMember(browser, { email: 'ux-offline@example.test', name: 'เน็ต หลุด', phone: '0895550005' });
  await page.getByRole('button', { name: 'แพ็กเกจ' }).click();
  await page.getByRole('button', { name: 'ซื้อแพ็กเกจนี้' }).first().click();
  await expect(page.getByRole('heading', { name: 'PromptPay' })).toBeVisible();

  // (a) the upload itself fails
  await page.route('**/api/**', route => route.abort('failed'));
  await sendSlip(page, 'REF-UX-OFFLINE', { tag: 'o' });
  await page.waitForTimeout(1200);
  const uploadText = await page.evaluate(() => document.body.innerText);
  const uploadLeak = [...new Set(uploadText.match(/Failed to fetch|NetworkError|TypeError|\[object Object\]/g) || [])];
  console.log('PKG-033 (a) upload fails — message shown:',
    JSON.stringify((uploadText.match(/อัปโหลด[^\n]*/) || [])[0] ?? null), '| raw English:', JSON.stringify(uploadLeak));
  await page.unroute('**/api/**');

  // (b) the screen is opened while the API is unreachable
  await page.route('**/api/**', route => route.abort('failed'));
  await page.reload();
  await page.waitForTimeout(1500);
  const loadText = await page.evaluate(() => document.body.innerText);
  const loadLeak = [...new Set(loadText.match(/Failed to fetch|NetworkError|TypeError|\[object Object\]/g) || [])];
  console.log('PKG-033 (b) screen loaded offline:\n' + loadText.slice(0, 400));
  console.log('PKG-033 (b) raw English shown to the member:', JSON.stringify(loadLeak));
  await page.screenshot({ path: 'qa/evidence-payment-offline.png', fullPage: true });
  await page.unroute('**/api/**');

  expect(loadText.trim().length, 'blank screen').toBeGreaterThan(0);
  expect(uploadLeak, 'upload failure leaked browser English').toEqual([]);
  expect(loadLeak, 'loading the app offline leaked browser English').toEqual([]);
});
