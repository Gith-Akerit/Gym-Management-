import { test, expect } from '@playwright/test';

// Runs last on purpose: it puts a second package on sale, and the earlier specs
// click "ซื้อแพ็กเกจนี้" expecting to find exactly one.

async function login(page, email) {
  await page.goto('/');
  await page.getByLabel('อีเมล', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'รับรหัสทางอีเมล' }).click();
  await expect(page.getByLabel('รหัสยืนยัน 6 หลัก')).toBeVisible();
  const { code } = await (await page.request.get(`/__test/code?email=${email}`)).json();
  await page.getByLabel('รหัสยืนยัน 6 หลัก').fill(code);
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click();
}

test('a package that costs nothing is granted, not confirmed against a bank', async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  await login(admin, 'admin8@example.test');

  // Put the trial on sale at zero.
  await admin.getByRole('button', { name: 'แพ็กเกจ', exact: true }).click();
  await admin.getByRole('button', { name: 'แก้ไข ทดลองเล่นฟรี 1 ครั้ง' }).click();
  await admin.getByLabel('ราคา (บาท)', { exact: false }).fill('0');
  await admin.getByLabel('สถานะแพ็กเกจ').selectOption('active');
  await admin.getByRole('button', { name: 'บันทึกแพ็กเกจ' }).click();
  await expect(admin.getByRole('status').filter({ hasText: 'บันทึกแพ็กเกจแล้ว' })).toBeVisible();

  const memberContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const member = await memberContext.newPage();
  await login(member, 'freeui@example.test');
  await member.getByLabel('ชื่อ–นามสกุล').fill('ฟรี ทดลองใช้');
  await member.getByLabel('เบอร์มือถือ').fill('0895556677');
  await member.getByRole('button', { name: 'เริ่มใช้งาน' }).click();

  await member.getByRole('button', { name: 'แพ็กเกจ', exact: true }).click();
  // The monthly package is on sale too by now, so pick the free one by name
  // rather than by position.
  const freeCard = member.locator('.pkg-card').filter({ hasText: 'ทดลองเล่นฟรี 1 ครั้ง' });
  await expect(freeCard.getByText('ไม่มีค่าใช้จ่าย')).toBeVisible();
  await freeCard.getByRole('button', { name: 'ซื้อแพ็กเกจนี้' }).click();

  // No QR and no slip form: there is nothing to pay.
  await expect(member.getByRole('heading', { name: 'PromptPay' })).toHaveCount(0);
  await expect(member.getByLabel('รูปสลิป', { exact: false })).toHaveCount(0);
  await member.screenshot({ path: 'artifacts/member-free-package.png', fullPage: true });

  // The admin side is a grant, not a slip check. Ticking "I checked the bank
  // app" would be swearing to a transfer that never happened.
  await admin.getByRole('button', { name: 'ตรวจสลิป' }).click();
  await admin.getByRole('button', { name: 'มอบสิทธิ์ให้ ฟรี ทดลองใช้' }).click();
  await expect(admin.getByRole('heading', { name: 'มอบสิทธิ์แพ็กเกจฟรี' })).toBeVisible();
  await expect(admin.getByText('ตรวจกับแอปธนาคารแล้ว', { exact: false })).toHaveCount(0);
  await expect(admin.getByText('แพ็กเกจนี้ไม่มีค่าใช้จ่าย จึงไม่มีสลิป')).toBeVisible();

  const grant = admin.getByRole('button', { name: 'มอบสิทธิ์ (ไม่มีค่าใช้จ่าย)' });
  await expect(grant).toBeEnabled();
  await admin.screenshot({ path: 'artifacts/admin-free-grant.png', fullPage: true });
  await grant.click();
  await expect(admin.getByRole('status').filter({ hasText: 'มอบสิทธิ์แล้ว' })).toBeVisible();

  // And the member has the package.
  await member.reload();
  await member.getByRole('button', { name: 'บัญชี' }).click();
  await expect(member.getByText('ทดลอง', { exact: false }).first()).toBeVisible();
});
