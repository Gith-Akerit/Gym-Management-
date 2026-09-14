import { test, expect } from '@playwright/test';

// Runs last against the ordinary gym on 4310. It creates accounts and moves
// roles around, so it uses addresses no earlier spec touches.

async function login(page, email) {
  await page.goto('/');
  await page.getByLabel('อีเมล', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'รับรหัสทางอีเมล' }).click();
  await expect(page.getByLabel('รหัสยืนยัน 6 หลัก')).toBeVisible();
  const { code } = await (await page.request.get(`/__test/code?email=${email}`)).json();
  await page.getByLabel('รหัสยืนยัน 6 หลัก').fill(code);
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click();
}

test('the admin can work the counter without a separate staff login', async ({ page }) => {
  await login(page, 'admin9@example.test');
  // The owner of a small gym is often the one at the desk.
  await page.getByRole('button', { name: 'สแกนเช็คอิน' }).click();
  await expect(page.getByRole('heading', { name: 'สแกนเช็คอิน' })).toBeVisible();
  await page.getByLabel('ชื่อจุดสแกน', { exact: false }).fill('เคาน์เตอร์แอดมิน');
  await page.getByLabel('รหัสจาก QR ของสมาชิก').fill('GYMCHK1.not-a-real-token.00');
  await page.getByRole('button', { name: 'ตรวจสอบ' }).click();
  await expect(page.locator('.scan-result').getByRole('heading', { name: 'เข้าใช้บริการไม่ได้' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/admin-scan-tab.png', fullPage: true });
});

test('an admin creates a staff account, changes a role, and suspends it', async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  await login(admin, 'admin10@example.test');
  await admin.getByRole('button', { name: 'ผู้ใช้และสิทธิ์' }).click();
  await expect(admin.getByRole('heading', { name: 'บัญชีผู้ใช้' })).toBeVisible();

  await admin.getByLabel('อีเมล', { exact: true }).fill('newcounter@example.test');
  await admin.getByLabel('สิทธิ์ของบัญชีใหม่').selectOption('staff');
  await admin.getByRole('button', { name: 'สร้างบัญชี' }).click();
  await expect(admin.getByRole('status').filter({ hasText: 'สร้างบัญชีแล้ว' })).toBeVisible();
  await admin.getByLabel('ค้นหาบัญชี').fill('newcounter@example.test');
  const row = admin.locator('.member-row').filter({ hasText: 'newcounter@example.test' });
  await expect(row).toContainText('พนักงาน');
  await admin.screenshot({ path: 'artifacts/admin-users.png', fullPage: true });

  // The new account works, and lands on the counter screen rather than the
  // admin console.
  const staff = await (await browser.newContext()).newPage();
  await login(staff, 'newcounter@example.test');
  await expect(staff.getByRole('heading', { name: 'สแกนเช็คอิน' })).toBeVisible();
  await expect(staff.getByRole('button', { name: 'ผู้ใช้และสิทธิ์' })).toHaveCount(0);

  // Promoting them ends the session they are holding, so the screen they see
  // always matches what they may do.
  await row.getByLabel('สิทธิ์ของ newcounter@example.test').selectOption('admin');
  await expect(admin.getByRole('status').filter({ hasText: 'เปลี่ยนสิทธิ์' })).toBeVisible();
  await staff.reload();
  await expect(staff.getByRole('button', { name: 'รับรหัสทางอีเมล' })).toBeVisible();

  // Suspending shuts the door; the row says so and offers the way back.
  await admin.getByLabel('ค้นหาบัญชี').fill('newcounter@example.test');
  await row.getByRole('button', { name: /ระงับบัญชี newcounter@example.test/ }).click();
  await expect(admin.getByRole('status').filter({ hasText: 'ระงับบัญชี' })).toBeVisible();
  await expect(row).toContainText('ถูกระงับ');
  await expect(row.getByRole('button', { name: /คืนสิทธิ์/ })).toBeVisible();
});

test('the gym cannot be left without an administrator', async ({ page }) => {
  await login(page, 'admin11@example.test');
  await page.getByRole('button', { name: 'ผู้ใช้และสิทธิ์' }).click();
  await page.getByLabel('ค้นหาบัญชี').fill('admin11@example.test');
  const self = page.locator('.member-row').filter({ hasText: 'admin11@example.test' });

  // There are other admins seeded here, so this one is allowed to step down --
  // and doing so signs them straight out, which is the point.
  const others = await page.getByText(/ผู้ดูแลระบบที่ใช้งานได้ \d+ คน/).innerText();
  expect(Number(others.match(/(\d+) คน/)[1])).toBeGreaterThan(1);
  await self.getByLabel('สิทธิ์ของ admin11@example.test').selectOption('staff');
  // Signed out on the spot: the screen they were on is no longer one they may
  // see, so they get the login page rather than a console full of dead buttons.
  await expect(page.getByRole('button', { name: 'รับรหัสทางอีเมล' })).toBeVisible();
});

test('an admin who suspends their own account is told why the screen vanished', async ({ browser }) => {
  // Allowed as long as somebody else can still administer the gym. Without a
  // word on the way out the console simply disappears mid-click and the login
  // page offers no explanation (QA PM-17).
  const admin = await (await browser.newContext()).newPage();
  await login(admin, 'admin12@example.test');
  await admin.getByRole('button', { name: 'ผู้ใช้และสิทธิ์' }).click();
  await admin.getByLabel('ค้นหาบัญชี').fill('admin12@example.test');
  const self = admin.locator('.member-row').filter({ hasText: 'admin12@example.test' });
  await self.getByRole('button', { name: /ระงับบัญชี admin12@example.test/ }).click();

  await expect(admin.getByRole('status').filter({ hasText: 'ระงับบัญชีของคุณแล้ว ออกจากระบบ' })).toBeVisible();
  await expect(admin.getByRole('button', { name: 'รับรหัสทางอีเมล' })).toBeVisible();
  await admin.screenshot({ path: 'artifacts/admin-self-suspend.png', fullPage: true });

  // That the door is really shut is checked where it can be: the sixty second
  // cooldown makes signing straight back in a different test, and
  // tests/users.test.js covers the refusal against the real code.
});
