import { test, expect } from '@playwright/test';
async function login(page, email) {
  await page.goto('/');
  await page.getByLabel('อีเมล', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'รับรหัสทางอีเมล' }).click();
  await expect(page.getByLabel('รหัสยืนยัน 6 หลัก')).toBeVisible();
  const { code } = await (await page.request.get(`/__test/code?email=${email}`)).json();
  await page.getByLabel('รหัสยืนยัน 6 หลัก').fill(code);
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click();
}
test('admin creates, searches, updates and deactivates without executing stored markup', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await login(page, 'admin@example.test');
  await expect(page.getByRole('heading', { name: 'สมาชิกทั้งหมด' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ยังไม่มีสมาชิก' })).toBeVisible();
  await page.getByRole('button', { name: '＋ เพิ่มสมาชิก' }).click();
  await page.getByLabel('ชื่อ–นามสกุล').fill('<img src=x onerror=alert(1)>');
  await page.getByLabel('อีเมล', { exact: true }).fill('created@example.test');
  await page.getByLabel('เบอร์มือถือ').fill('0812345678');
  await page.getByRole('button', { name: 'บันทึกสมาชิก' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'เพิ่มสมาชิกแล้ว' })).toBeVisible();
  await page.getByLabel('ค้นหาสมาชิก').fill('081-234-5678');
  await page.getByRole('button', { name: 'แก้ไข <img src=x onerror=alert(1)>' }).click();
  await page.getByLabel('ชื่อ–นามสกุล').fill('สุดา ใจดี');
  await page.getByRole('button', { name: 'บันทึกสมาชิก' }).click();
  await page.getByRole('button', { name: 'แก้ไข สุดา ใจดี' }).click();
  await page.getByRole('button', { name: 'ดูประวัติการแก้ไข' }).click();
  await expect(page.getByText('สร้างสมาชิก', { exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'ระงับสมาชิก', exact: true }).click();
  await expect(page.getByText('ถูกระงับ', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/admin-members.png', fullPage: true });
  await page.getByLabel('ค้นหาสมาชิก').fill('ไม่มีชื่อนี้');
  await expect(page.getByRole('heading', { name: 'ไม่พบสมาชิกที่ค้นหา' })).toBeVisible();
  expect(errors).toEqual([]);
});
test('member self-registers on small phone, refreshes and logs out', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await login(page, 'phone@example.test');
  await expect(page.getByRole('heading', { name: 'ทำความรู้จักกัน' })).toBeVisible();
  await page.getByLabel('ชื่อ–นามสกุล').fill('สมาชิก มือถือ');
  await page.getByLabel('เบอร์มือถือ').fill('0898765432');
  await page.getByRole('button', { name: 'เริ่มใช้งาน' }).click();
  await expect(page.getByRole('heading', { name: 'สมาชิก มือถือ' })).toBeVisible();
  await page.reload();
  await expect(page.getByText('ใช้งานอยู่', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'artifacts/member-phone.png', fullPage: true });
  await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
  await expect(page.getByRole('button', { name: 'รับรหัสทางอีเมล' })).toBeVisible();
  expect((await page.request.get('/api/me')).status()).toBe(401);
});
test('existing suspended member sees status and clear guidance', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await login(page, 'created@example.test');
  await expect(page.getByText('ถูกระงับ', { exact: true })).toBeVisible();
  await expect(page.getByText('บัญชีสมาชิกถูกระงับ กรุณาติดต่อพนักงานที่ยิม')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});
test('email delivery failure renders a recoverable Thai error', async ({ page }) => {
  await page.goto('/');
  await page.route('**/api/auth/request-otp', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'ส่งอีเมลไม่สำเร็จ กรุณาลองอีกครั้งใน 60 วินาที' }) }));
  await page.getByLabel('อีเมล', { exact: true }).fill('error@example.test');
  await page.getByRole('button', { name: 'รับรหัสทางอีเมล' }).click();
  await expect(page.getByRole('alert')).toContainText('ส่งอีเมลไม่สำเร็จ');
  await expect(page.getByRole('button', { name: 'รับรหัสทางอีเมล' })).toBeEnabled();
});
