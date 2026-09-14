import { test, expect } from '@playwright/test';

// Runs last, and brings its own member accounts. Earlier specs already signed
// theirs in, and the 60 second cooldown between OTP requests is a real rule
// rather than something a test should be built to dodge.

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

/** Buys the package that 02-settings put on sale and sends a slip for it. */
async function buyAndSendSlip(page, reference) {
  await page.getByRole('button', { name: 'แพ็กเกจ' }).click();
  await page.getByRole('button', { name: 'ซื้อแพ็กเกจนี้' }).click();
  await expect(page.getByRole('heading', { name: 'PromptPay' })).toBeVisible();
  await page.getByLabel('รูปสลิป', { exact: false })
    .setInputFiles({ name: 'slip.jpg', mimeType: 'image/jpeg', buffer: jpegBuffer() });
  await page.getByLabel('เลขอ้างอิงในสลิป').fill(reference);
  await page.getByRole('button', { name: 'ส่งสลิป', exact: true }).click();
  await expect(page.getByText('รอตรวจสอบการชำระเงิน')).toBeVisible();
}

async function approveFor(browser, adminEmail, memberName) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, adminEmail);
  await page.getByRole('button', { name: 'ตรวจสลิป' }).click();
  await page.getByRole('button', { name: `ตรวจสลิปของ ${memberName}` }).click();
  await page.getByLabel('ตรวจกับแอปธนาคารแล้ว', { exact: false }).check();
  await page.getByRole('button', { name: 'อนุมัติและให้สิทธิ์' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'อนุมัติแล้ว' })).toBeVisible();
  return page;
}

/** The big pass/fail panel, as distinct from the log of earlier scans below it. */
const scanResult = page => page.locator('.scan-result');

/** The exact string inside the member's QR, read through the same API the page uses. */
async function qrValue(page) {
  const response = await page.request.post('/api/me/check-in-token', {
    headers: { 'X-Gym-Client': 'web', 'Content-Type': 'application/json' },
    data: {},
  });
  return (await response.json()).qr;
}

test('a member with a package checks in, and the counter sees who walked in', async ({ browser }) => {
  const errors = [];
  const memberContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const member = await memberContext.newPage();
  member.on('pageerror', error => errors.push(error.message));

  await registerMember(member, { email: 'checkin-ui@example.test', name: 'ชัยชนะ มาออกกำลัง', phone: '0893334455' });
  await buyAndSendSlip(member, 'REF-CHK-0001');
  await approveFor(browser, 'admin6@example.test', 'ชัยชนะ มาออกกำลัง');

  // Back on the home screen the QR is simply there — no tapping to find it.
  await member.getByRole('button', { name: 'หน้าแรก' }).click();
  const qr = member.getByRole('img', { name: /QR สำหรับเช็คอิน/ });
  await expect(qr).toBeVisible();
  await expect.poll(() => qr.evaluate(img => img.naturalWidth)).toBeGreaterThan(50);
  await expect(member.getByText(/รหัสใหม่ใน \d+ วินาที/)).toBeVisible();
  await expect(member.getByText(/ส่งภาพหน้าจอให้คนอื่นจึงใช้เข้ายิมไม่ได้/)).toBeVisible();
  await member.screenshot({ path: 'artifacts/member-checkin-qr.png', fullPage: true });

  const staffContext = await browser.newContext();
  const staff = await staffContext.newPage();
  await login(staff, 'staff-ui@example.test');
  await expect(staff.getByRole('heading', { name: 'สแกนเช็คอิน' })).toBeVisible();
  await staff.getByLabel('ชื่อจุดสแกน', { exact: false }).fill('เคาน์เตอร์ 1');

  const code = await qrValue(member);
  await staff.getByLabel('รหัสจาก QR ของสมาชิก').fill(code);
  await staff.getByRole('button', { name: 'ตรวจสอบ' }).click();

  await expect(scanResult(staff).getByRole('heading', { name: 'เข้าใช้บริการได้' })).toBeVisible();
  await expect(scanResult(staff).getByText('ชัยชนะ มาออกกำลัง', { exact: false })).toBeVisible();
  await expect(scanResult(staff).getByText(/ใช้ได้ไม่จำกัดครั้ง/)).toBeVisible();
  await staff.screenshot({ path: 'artifacts/staff-checkin-allowed.png', fullPage: true });

  // The same code a second time is refused, in plain Thai.
  await staff.getByLabel('รหัสจาก QR ของสมาชิก').fill(code);
  await staff.getByRole('button', { name: 'ตรวจสอบ' }).click();
  await expect(scanResult(staff).getByRole('heading', { name: 'เข้าใช้บริการไม่ได้' })).toBeVisible();
  await expect(scanResult(staff).getByText(/ถูกใช้ไปแล้ว/)).toBeVisible();
  await staff.screenshot({ path: 'artifacts/staff-checkin-denied.png', fullPage: true });
  await expect(staff.getByRole('heading', { name: 'เช็คอินล่าสุด' })).toBeVisible();

  // The member can see their own visit without asking anyone.
  await member.getByRole('button', { name: 'บัญชี' }).click();
  await expect(member.getByRole('heading', { name: 'ประวัติการเข้าใช้บริการ' })).toBeVisible();
  await expect(member.getByText('เข้าใช้บริการได้').first()).toBeVisible();

  expect(await member.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  expect(errors).toEqual([]);

  // With no way to reach the server there is no code, and the screen says so
  // rather than leaving the last one on display. A member who walks to the
  // counter holding an expired QR is turned away by a scanner that cannot
  // explain itself (กติกาข้อบังคับ: ออฟไลน์ห้ามแสดง QR เดิมว่าพร้อมใช้).
  await member.route('**/api/me/check-in-token', route => route.abort());
  await member.getByRole('button', { name: 'หน้าแรก' }).click();
  await member.reload();
  await expect(member.getByText('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้')).toBeVisible();
  await expect(member.getByRole('img', { name: /QR สำหรับเช็คอิน/ })).toHaveCount(0);
  await expect(member.getByText(/รหัสใหม่ใน \d+ วินาที/)).toHaveCount(0);
  await member.screenshot({ path: 'artifacts/member-checkin-offline.png', fullPage: true });
  await member.unroute('**/api/me/check-in-token');
});

test('a member with no package is turned away with a reason they can act on', async ({ browser }) => {
  const memberContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const member = await memberContext.newPage();
  await registerMember(member, { email: 'walkin-ui@example.test', name: 'วาสนา ยังไม่ซื้อ', phone: '0892223311' });
  await expect(member.getByRole('img', { name: /QR สำหรับเช็คอิน/ })).toBeVisible();
  const code = await qrValue(member);

  const staffContext = await browser.newContext();
  const staff = await staffContext.newPage();
  await login(staff, 'staff2-ui@example.test');
  await staff.getByLabel('รหัสจาก QR ของสมาชิก').fill(code);
  await staff.getByRole('button', { name: 'ตรวจสอบ' }).click();

  await expect(scanResult(staff).getByRole('heading', { name: 'เข้าใช้บริการไม่ได้' })).toBeVisible();
  await expect(scanResult(staff).getByText(/ยังไม่มีแพ็กเกจ/)).toBeVisible();
  await expect(scanResult(staff).getByText(/ซื้อแพ็กเกจ/)).toBeVisible();
});

test('staff may read the slip queue but are told they cannot decide it', async ({ page }) => {
  await login(page, 'staff3-ui@example.test');
  await page.getByRole('button', { name: 'คิวสลิป' }).click();
  await expect(page.getByRole('heading', { name: 'คำสั่งซื้อ' })).toBeVisible();
  await page.getByRole('button', { name: 'ทั้งหมด' }).click();
  await page.getByRole('button', { name: /ตรวจสลิปของ/ }).first().click();
  await expect(page.getByText('พนักงานดูได้อย่างเดียว', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'อนุมัติและให้สิทธิ์' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ปฏิเสธสลิป' })).toHaveCount(0);
});

test('the admin can see who came in and who was turned away', async ({ page }) => {
  await login(page, 'admin5@example.test');
  await page.getByRole('button', { name: 'เช็คอิน', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'การเข้าใช้บริการ' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ประวัติการเช็คอิน' })).toBeVisible();
  await expect(page.getByText('เข้าใช้บริการได้').first()).toBeVisible();
  await expect(page.getByText('เข้าใช้บริการไม่ได้').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'สรุปรายวัน' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/admin-checkin-log.png', fullPage: true });

  // A forged QR belongs to nobody, so it sits in its own tab rather than
  // burying the day's real visits.
  await page.getByRole('button', { name: /QR ไม่ถูกต้อง/ }).click();
  await expect(page.getByText('ระบุตัวสมาชิกไม่ได้', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ค้นหาสมาชิก' })).toHaveCount(0);
  await page.getByRole('button', { name: 'รายชื่อสมาชิก' }).click();
  await expect(page.getByText('ไม่ทราบสมาชิก')).toHaveCount(0);
});

test('a scan that matches no member is kept out of the member history', async ({ browser }) => {
  const staffContext = await browser.newContext();
  const staff = await staffContext.newPage();
  await login(staff, 'staff5-ui@example.test');
  await staff.getByLabel('รหัสจาก QR ของสมาชิก').fill('GYMCHK1.forged-code.0000');
  await staff.getByRole('button', { name: 'ตรวจสอบ' }).click();
  await expect(scanResult(staff).getByText('QR ไม่ถูกต้อง', { exact: false })).toBeVisible();
  // The scanner's own list is unfiltered: a junk scan that just happened is
  // exactly what the person at the counter wants to see.
  await expect(staff.getByRole('heading', { name: 'เช็คอินล่าสุด' })).toBeVisible();
  await expect(staff.getByText('ไม่ทราบสมาชิก').first()).toBeVisible();

  const admin = await (await browser.newContext()).newPage();
  await login(admin, 'admin7@example.test');
  await admin.getByRole('button', { name: 'เช็คอิน', exact: true }).click();
  const tab = admin.getByRole('button', { name: /QR ไม่ถูกต้อง/ });
  await expect(tab).toContainText(/\(\d+\)/);
  await tab.click();
  await expect(admin.getByText('ไม่ทราบสมาชิก').first()).toBeVisible();
  await admin.screenshot({ path: 'artifacts/admin-checkin-unknown.png', fullPage: true });
});

test('the counter tablet can scan with its own camera', async ({ page }) => {
  // Chromium supplies a synthetic camera here (see playwright.config.js), so
  // this proves the permission flow and that frames really are arriving. It
  // cannot prove a QR decodes: the fake device shows a test pattern.
  await login(page, 'staff4-ui@example.test');
  await expect(page.getByRole('heading', { name: 'สแกนเช็คอิน' })).toBeVisible();

  const toggle = page.getByLabel('ใช้กล้องของเครื่องนี้สแกน', { exact: false });
  await expect(toggle).not.toBeChecked();
  await toggle.check();

  const view = page.getByLabel('ภาพจากกล้องสำหรับสแกน QR');
  await expect(view).toBeVisible();
  await expect.poll(() => view.evaluate(node => node.videoWidth), { timeout: 15000 }).toBeGreaterThan(0);
  await expect.poll(() => view.evaluate(node => node.readyState)).toBeGreaterThanOrEqual(2);
  await expect(page.getByText('หันกล้องไปที่จอของสมาชิก', { exact: false })).toBeVisible();
  await page.screenshot({ path: 'artifacts/staff-camera-scan.png', fullPage: true });

  // Typing a code still works while the camera is on: most counters have both.
  await expect(page.getByLabel('รหัสจาก QR ของสมาชิก')).toBeVisible();

  // Turning it off releases the camera rather than leaving the light on.
  await toggle.uncheck();
  await expect(view).toHaveCount(0);
});
