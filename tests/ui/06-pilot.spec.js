import { test, expect } from '@playwright/test';

// Runs against the second server (port 4311), which is the same build with
// PILOT_MODE=1: no mail provider, no PromptPay account. Nothing here touches
// the gym on 4310, so this file is independent of the four before it.
const PILOT = 'http://127.0.0.1:4311';

async function signIn(page, email, readCode) {
  await page.goto(`${PILOT}/`);
  await page.getByLabel('อีเมล', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'ขอรหัสเข้าใช้งาน' }).click();
  await expect(page.getByLabel('รหัสยืนยัน 6 หลัก')).toBeVisible();
  await page.getByLabel('รหัสยืนยัน 6 หลัก').fill(await readCode(page));
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click();
}

/** The back door the other specs use; here it stands in for the admin reading
 *  the code off their own screen, for the sign-in steps that are not the point
 *  of the test. */
const fromTestInbox = email => async page =>
  (await (await page.request.get(`${PILOT}/__test/code?email=${email}`)).json()).code;

test('the member is told to ask staff for the code, and is never shown it', async ({ page }) => {
  await page.goto(`${PILOT}/`);
  await page.getByLabel('อีเมล', { exact: true }).fill('pilot-member@example.test');
  // The button does not promise an email that is never sent.
  await page.getByRole('button', { name: 'ขอรหัสเข้าใช้งาน' }).click();
  await expect(page.getByText('ขอรหัส 6 หลักของ pilot-member@example.test จากเจ้าหน้าที่', { exact: false })).toBeVisible();
  await expect(page.getByText('ยังไม่ส่งอีเมล เจ้าหน้าที่จะเป็นผู้แจ้งรหัสให้คุณ', { exact: false })).toBeVisible();

  // No six digit number anywhere on the member's screen.
  expect(await page.locator('body').innerText()).not.toMatch(/\b\d{6}\b/);
});

test('the admin reads out the code, grants a package, and never sees a slip queue', async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, 'admin@example.test', fromTestInbox('admin@example.test'));

  // The banner is the first thing on the page and stays there.
  await expect(admin.getByText('โหมดทดลอง').first()).toBeVisible();
  await expect(admin.getByRole('button', { name: 'ตรวจสลิป' })).toHaveCount(0);
  await expect(admin.getByRole('button', { name: 'รหัส OTP' })).toBeVisible();

  // A member asks for a code from their phone.
  const member = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await member.goto(`${PILOT}/`);
  await member.getByLabel('อีเมล', { exact: true }).fill('pilot-walkin@example.test');
  await member.getByRole('button', { name: 'ขอรหัสเข้าใช้งาน' }).click();
  await expect(member.getByLabel('รหัสยืนยัน 6 หลัก')).toBeVisible();

  // The admin finds it on the codes screen and reads it out.
  await admin.getByRole('button', { name: 'รหัส OTP' }).click();
  await expect(admin.getByRole('heading', { name: 'รหัสเข้าใช้งานล่าสุด' })).toBeVisible();
  const row = admin.locator('.member-row').filter({ hasText: 'pilot-walkin@example.test' });
  await expect(row).toBeVisible();
  const code = (await row.locator('.otp-code').innerText()).trim();
  expect(code).toMatch(/^\d{6}$/);
  await admin.screenshot({ path: 'artifacts/pilot-otp-board.png', fullPage: true });

  await member.getByLabel('รหัสยืนยัน 6 หลัก').fill(code);
  await member.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click();
  await member.getByLabel('ชื่อ–นามสกุล').fill('ทดลอง ใช้งาน');
  await member.getByLabel('เบอร์มือถือ').fill('0897778899');
  await member.getByRole('button', { name: 'เริ่มใช้งาน' }).click();
  await expect(member.getByRole('heading', { name: 'ทดลอง ใช้งาน' })).toBeVisible();

  // There is nothing to buy, so the tab is not there to disappoint anyone.
  await expect(member.getByRole('button', { name: 'แพ็กเกจ', exact: true })).toHaveCount(0);
  await member.screenshot({ path: 'artifacts/pilot-member-home.png', fullPage: true });

  // The admin prices a package and hands it over directly.
  await admin.getByRole('button', { name: 'แพ็กเกจ', exact: true }).click();
  await admin.getByRole('button', { name: 'แก้ไข รายเดือน Unlimited' }).click();
  await admin.getByLabel('ราคา (บาท)', { exact: false }).fill('1200');
  await admin.getByLabel('สถานะแพ็กเกจ').selectOption('active');
  await admin.getByRole('button', { name: 'บันทึกแพ็กเกจ' }).click();
  await expect(admin.getByRole('status').filter({ hasText: 'บันทึกแพ็กเกจแล้ว' })).toBeVisible();

  await admin.getByRole('button', { name: 'สมาชิก', exact: true }).click();
  await admin.getByRole('button', { name: 'แก้ไข ทดลอง ใช้งาน' }).click();
  await expect(admin.getByRole('heading', { name: 'มอบแพ็กเกจ' })).toBeVisible();
  // Only packages with a price appear: the ten-visit one is still unpriced and
  // is not offered, because there would be no number to record.
  const choices = admin.getByLabel('แพ็กเกจที่จะมอบ');
  await expect(choices.locator('option')).toContainText(['เลือกแพ็กเกจ', 'รายเดือน Unlimited', 'ทดลองเล่นฟรี']);
  await choices.selectOption({ index: 1 });
  await admin.getByLabel('เหตุผล (บันทึกไว้ในประวัติ)').fill('ผู้ทดลองใช้รอบ pilot');
  await admin.screenshot({ path: 'artifacts/pilot-grant-package.png', fullPage: true });
  await admin.getByRole('button', { name: 'มอบแพ็กเกจให้สมาชิกรายนี้' }).click();
  await expect(admin.getByText('มอบแพ็กเกจแล้ว')).toBeVisible();

  // The member has it, and can show the QR that gets them through the door.
  await member.getByRole('button', { name: 'บัญชี' }).click();
  await expect(member.getByText('รายเดือน Unlimited').first()).toBeVisible();
  await member.getByRole('button', { name: 'หน้าแรก' }).click();
  await expect(member.getByRole('img', { name: /QR สำหรับเช็คอิน/ })).toBeVisible();
});
