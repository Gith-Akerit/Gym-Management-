import { test, expect } from '@playwright/test';
import { PASSWORD, signIn } from './counter.js';

// Who may sign in, and what they may do. It creates accounts and moves roles
// around, so it uses addresses no earlier spec touches.

test('the owner creates a staff account, hands over a password, and it works', async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, 'admin10@example.test');
  await admin.getByRole('button', { name: 'ผู้ใช้และสิทธิ์' }).click();
  await expect(admin.getByRole('heading', { name: 'บัญชีผู้ใช้' })).toBeVisible();

  // Added before their first shift, with no password yet: the screen has to say
  // so, or they will stand at the login wondering what they typed wrong.
  await admin.getByLabel('อีเมล', { exact: true }).fill('newcounter@example.test');
  await admin.getByLabel('สิทธิ์ของบัญชีใหม่').selectOption('staff');
  await admin.getByRole('button', { name: 'สร้างบัญชี' }).click();
  await expect(admin.getByRole('status').filter({ hasText: 'สร้างบัญชีแล้ว' })).toBeVisible();
  await admin.getByLabel('ค้นหาบัญชี').fill('newcounter@example.test');
  const row = admin.locator('.table-users tbody tr').filter({ hasText: 'newcounter@example.test' });
  await expect(row).toContainText('พนักงาน');
  await expect(row).toContainText('ยังไม่ได้ตั้ง');
  await admin.screenshot({ path: 'artifacts/admin-users.png', fullPage: true });

  const staff = await (await browser.newContext()).newPage();
  await signIn(staff, 'newcounter@example.test', 'whatever-they-guess');
  await expect(staff.getByRole('alert')).toContainText('อีเมลหรือรหัสผ่านไม่ถูกต้อง');

  // The owner types one in front of them at the counter.
  admin.on('dialog', dialog => dialog.accept(PASSWORD));
  await row.getByRole('button', { name: /ตั้งรหัสผ่านของ newcounter@example.test/ }).click();
  await expect(admin.getByRole('status').filter({ hasText: 'ตั้งรหัสผ่านใหม่' })).toBeVisible();
  await admin.getByLabel('ค้นหาบัญชี').fill('newcounter@example.test');
  await expect(row).toContainText('ตั้งแล้ว');

  await signIn(staff, 'newcounter@example.test');
  await expect(staff.getByRole('heading', { name: 'สแกนเช็คอิน' })).toBeVisible();
  // Staff run the counter; they do not hand out roles.
  await expect(staff.getByRole('button', { name: 'ผู้ใช้และสิทธิ์' })).toHaveCount(0);

  // Promoting them ends the session they are holding, so the screen they see
  // always matches what they may do.
  await row.getByLabel('สิทธิ์ของ newcounter@example.test').selectOption('admin');
  await expect(admin.getByRole('status').filter({ hasText: 'เปลี่ยนสิทธิ์' })).toBeVisible();
  await staff.reload();
  await expect(staff.getByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeVisible();

  // Suspending shuts the door; the row says so and offers the way back.
  await admin.getByLabel('ค้นหาบัญชี').fill('newcounter@example.test');
  await row.getByRole('button', { name: /ระงับบัญชี newcounter@example.test/ }).click();
  await expect(admin.getByRole('status').filter({ hasText: 'ระงับบัญชี' })).toBeVisible();
  await expect(row).toContainText('ถูกระงับ');
  await expect(row.getByRole('button', { name: /คืนสิทธิ์/ })).toBeVisible();
});

test('the gym cannot be left without an administrator', async ({ page }) => {
  await signIn(page, 'admin11@example.test');
  await page.getByRole('button', { name: 'ผู้ใช้และสิทธิ์' }).click();
  await page.getByLabel('ค้นหาบัญชี').fill('admin11@example.test');
  const self = page.locator('.table-users tbody tr').filter({ hasText: 'admin11@example.test' });

  // There are other admins seeded here, so this one is allowed to step down --
  // and doing so signs them straight out, which is the point.
  const others = await page.getByText(/ผู้ดูแลระบบที่ใช้งานได้ \d+ คน/).innerText();
  expect(Number(others.match(/(\d+) คน/)[1])).toBeGreaterThan(1);
  await self.getByLabel('สิทธิ์ของ admin11@example.test').selectOption('staff');
  await expect(page.getByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeVisible();
});

test('an admin who suspends their own account is told why the screen vanished', async ({ browser }) => {
  // Allowed as long as somebody else can still administer the gym. Without a
  // word on the way out the console simply disappears mid-click and the login
  // page offers no explanation (QA PM-17).
  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, 'admin12@example.test');
  await admin.getByRole('button', { name: 'ผู้ใช้และสิทธิ์' }).click();
  await admin.getByLabel('ค้นหาบัญชี').fill('admin12@example.test');
  const self = admin.locator('.table-users tbody tr').filter({ hasText: 'admin12@example.test' });
  await self.getByRole('button', { name: /ระงับบัญชี admin12@example.test/ }).click();

  await expect(admin.getByRole('status').filter({ hasText: 'ระงับบัญชีของคุณแล้ว ออกจากระบบ' })).toBeVisible();
  await expect(admin.getByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeVisible();
  await admin.screenshot({ path: 'artifacts/admin-self-suspend.png', fullPage: true });
});
