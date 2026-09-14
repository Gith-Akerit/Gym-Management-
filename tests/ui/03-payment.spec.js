import { test, expect } from '@playwright/test';

// Runs last: 02-settings.spec puts the monthly package on sale at 1,200 baht,
// which is what a member can buy here.
//
// Each journey holds its member and admin sessions in separate browser contexts
// rather than signing the same address in twice. That is not a workaround — the
// 60 second cooldown between OTP requests is a real rule, and a test that had to
// defeat it would be testing something users never do.

/** The smallest thing a browser will hand over that is genuinely a JPEG. */
function jpegBuffer() {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9]),
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

async function sendSlip(page, reference) {
  await page.getByLabel('รูปสลิป', { exact: false })
    .setInputFiles({ name: 'slip.jpg', mimeType: 'image/jpeg', buffer: jpegBuffer() });
  await page.getByLabel('เลขอ้างอิงในสลิป').fill(reference);
  await page.getByRole('button', { name: 'ส่งสลิป', exact: true }).click();
}

/** A page signed in as the given admin, in its own context. */
async function adminPage(browser, email) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, email);
  return { page, context };
}

test('buy by QR, wait for review, get approved, see the membership', async ({ browser }) => {
  const errors = [];
  const memberContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const member = await memberContext.newPage();
  member.on('pageerror', error => errors.push(error.message));

  await registerMember(member, { email: 'shopper-ui@example.test', name: 'ปิติ ตั้งใจ', phone: '0897778899' });

  // Packages tab, then buy: two screens to reach the QR.
  await member.getByRole('button', { name: 'แพ็กเกจ' }).click();
  await expect(member.getByText('฿1,200.00').first()).toBeVisible();
  await member.getByRole('button', { name: 'ซื้อแพ็กเกจนี้' }).click();

  await expect(member.getByRole('heading', { name: 'PromptPay' })).toBeVisible();
  const qr = member.getByRole('img', { name: /QR พร้อมเพย์/ });
  await expect(qr).toBeVisible();
  // The QR must have decoded into pixels, not rendered as a broken image.
  await expect.poll(() => qr.evaluate(img => img.naturalWidth)).toBeGreaterThan(50);
  await expect(member.getByRole('link', { name: 'บันทึกรูป QR' })).toBeVisible();
  await expect(member.getByText(/หมดอายุใน \d+:\d\d นาที/)).toBeVisible();
  await member.screenshot({ path: 'artifacts/member-payment.png', fullPage: true });

  // กติกาข้อบังคับ: ส่งไม่สำเร็จ ห้ามล้างค่าที่กรอก. Somebody who has already
  // moved the money must never be sent back to the banking app to read the
  // reference number off the slip a second time.
  await member.getByLabel('เลขอ้างอิงในสลิป').fill('REF-UI-0001');
  await member.getByRole('button', { name: 'ส่งสลิป', exact: true }).click();
  await expect(member.getByText('กรุณาแนบรูปสลิปการโอนเงิน')).toBeVisible();
  await expect(member.getByLabel('เลขอ้างอิงในสลิป')).toHaveValue('REF-UI-0001');

  // And when the upload itself dies on the way out, the chosen photo survives
  // with it — reopening the picker is the part members get wrong.
  await member.route('**/api/orders/*/slip', route => route.abort());
  await member.getByLabel('รูปสลิป', { exact: false })
    .setInputFiles({ name: 'slip.jpg', mimeType: 'image/jpeg', buffer: jpegBuffer() });
  await member.getByRole('button', { name: 'ส่งสลิป', exact: true }).click();
  await expect(member.locator('.notice.error')).toBeVisible();
  await expect(member.getByLabel('เลขอ้างอิงในสลิป')).toHaveValue('REF-UI-0001');
  await expect(member.locator('.dropzone b')).toHaveText('slip.jpg');
  await member.unroute('**/api/orders/*/slip');

  await sendSlip(member, 'REF-UI-0001');

  await expect(member.getByText('รอตรวจสอบการชำระเงิน')).toBeVisible();
  await expect(member.getByText(/สิทธิ์ยังใช้เข้ายิมไม่ได้จนกว่าจะอนุมัติ/)).toBeVisible();
  await expect(member.getByText('ภายใน 30 นาทีในเวลาทำการ')).toBeVisible();
  // The QR disappears once the slip is in: there is nothing left to pay.
  await expect(member.getByRole('heading', { name: 'PromptPay' })).toHaveCount(0);
  await member.screenshot({ path: 'artifacts/member-awaiting-review.png', fullPage: true });

  // --- admin reviews ---------------------------------------------------------
  const { page: admin } = await adminPage(browser, 'admin3@example.test');
  await admin.getByRole('button', { name: 'ตรวจสลิป' }).click();
  await expect(admin.getByText('รอตรวจสอบ 1 รายการ')).toBeVisible();
  await admin.getByRole('button', { name: 'ตรวจสลิปของ ปิติ ตั้งใจ' }).click();
  await expect(admin.getByRole('heading', { name: 'ตรวจสลิป' })).toBeVisible();
  await expect(admin.getByText('REF-UI-0001')).toBeVisible();
  await expect(admin.getByRole('img', { name: 'สลิปการโอนเงิน' })).toBeVisible();
  await admin.screenshot({ path: 'artifacts/admin-slip-review.png', fullPage: true });

  const approve = admin.getByRole('button', { name: 'อนุมัติและให้สิทธิ์' });
  await expect(approve).toBeDisabled();
  await admin.getByLabel('ตรวจกับแอปธนาคารแล้ว', { exact: false }).check();
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(admin.getByRole('status').filter({ hasText: 'อนุมัติแล้ว' })).toBeVisible();

  // --- member sees the membership, without signing in again ------------------
  await member.reload();
  await expect(member.getByRole('heading', { name: 'แพ็กเกจปัจจุบัน' })).toBeVisible();
  await expect(member.getByText('ใช้ได้ถึง')).toBeVisible();
  await member.screenshot({ path: 'artifacts/member-entitlement.png', fullPage: true });

  await member.getByRole('button', { name: 'บัญชี' }).click();
  await expect(member.getByRole('heading', { name: 'ประวัติการสั่งซื้อ' })).toBeVisible();
  await expect(member.getByText('อนุมัติแล้ว')).toBeVisible();

  expect(await member.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  expect(errors).toEqual([]);
});

test('a rejected slip explains itself and can be replaced on the same order', async ({ browser }) => {
  const memberContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const member = await memberContext.newPage();
  await registerMember(member, { email: 'retry-ui@example.test', name: 'อารี พยายาม', phone: '0896665544' });
  await member.getByRole('button', { name: 'แพ็กเกจ' }).click();
  await member.getByRole('button', { name: 'ซื้อแพ็กเกจนี้' }).click();
  await expect(member.getByRole('heading', { name: 'PromptPay' })).toBeVisible();
  await sendSlip(member, 'REF-UI-0002');
  await expect(member.getByText('รอตรวจสอบการชำระเงิน')).toBeVisible();

  const { page: admin } = await adminPage(browser, 'admin4@example.test');
  await admin.getByRole('button', { name: 'ตรวจสลิป' }).click();
  await admin.getByRole('button', { name: 'ตรวจสลิปของ อารี พยายาม' }).click();
  await admin.getByLabel('เหตุผลที่ปฏิเสธ').fill('สลิปเบลอ อ่านยอดไม่ออก');
  await admin.getByRole('button', { name: 'ปฏิเสธสลิป' }).click();
  await expect(admin.getByRole('status').filter({ hasText: 'ปฏิเสธสลิปแล้ว' })).toBeVisible();

  // Reloading lands on the home tab, so walk back to the order the way a member would.
  await member.reload();
  await member.getByRole('button', { name: 'บัญชี' }).click();
  await member.getByRole('button', { name: /รายเดือน Unlimited/ }).click();
  await expect(member.getByText('สลิปไม่ผ่านการตรวจสอบ')).toBeVisible();
  await expect(member.getByText('สลิปเบลอ อ่านยอดไม่ออก')).toBeVisible();
  await expect(member.getByText('ส่งสลิปใหม่ได้จากด้านล่าง ไม่ต้องสั่งซื้อใหม่')).toBeVisible();

  await sendSlip(member, 'REF-UI-0003');
  await expect(member.getByText('รอตรวจสอบการชำระเงิน')).toBeVisible();
});
