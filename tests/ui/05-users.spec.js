import { test, expect } from '@playwright/test';
import { go, PASSWORD, signIn } from './counter.js';

// Who may sign in, and what they may do. It creates accounts and moves roles
// around, so it uses addresses no earlier spec touches.

test('the owner creates a staff account, hands over a password, and it works', async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, 'admin10@example.test');
  await go(admin, 'ผู้ใช้และสิทธิ์');
  await expect(admin.getByRole('heading', { name: 'ผู้ใช้และสิทธิ์' })).toBeVisible();

  // Added before their first shift, with no password yet: the table has to say
  // so, or they will stand at the login wondering what they typed wrong.
  await admin.getByLabel('อีเมล', { exact: true }).fill('newcounter@example.test');
  await admin.getByLabel('สิทธิ์ของบัญชีใหม่').selectOption('staff');
  await admin.getByRole('button', { name: 'สร้างบัญชี' }).click();
  await expect(admin.getByRole('status').filter({ hasText: 'สร้างบัญชีแล้ว' })).toBeVisible();
  await admin.getByLabel('ค้นหาบัญชี').fill('newcounter@example.test');
  const row = admin.locator('.utable tbody tr').filter({ hasText: 'newcounter@example.test' });
  await expect(row).toContainText('ยังไม่ได้ตั้ง');
  await admin.screenshot({ path: 'artifacts/admin-users.png', fullPage: true });

  const staff = await (await browser.newContext()).newPage();
  await signIn(staff, 'newcounter@example.test', 'whatever-they-guess');
  await expect(staff.getByRole('alert')).toContainText('อีเมลหรือรหัสผ่านไม่ถูกต้อง');

  // The owner no longer types one in front of them: a password somebody else
  // chose has to be said out loud to be handed over, and out loud is how it
  // reaches a group chat. The screen has no button for it any more.
  await expect(admin.getByRole('button', { name: /^ตั้งรหัสผ่านของ/ })).toHaveCount(0);

  // The new account sets its own, from the link the "ลืมรหัสผ่าน" letter carries.
  await staff.getByRole('button', { name: 'ลืมรหัสผ่าน' }).click();
  await staff.getByLabel('อีเมล', { exact: true }).fill('newcounter@example.test');
  await staff.getByRole('button', { name: 'ส่งลิงก์ตั้งรหัสผ่านใหม่' }).click();
  await expect(staff.getByRole('heading', { name: 'ถ้ามีบัญชีนี้อยู่ เราส่งอีเมลไปแล้ว' })).toBeVisible();
  const letters = await (await staff.request.get('/__test/outbox?to=newcounter@example.test')).json();
  const link = letters.items.map(letter => /\/\?setpw=[A-Za-z0-9_-]{43}/.exec(letter.text ?? '')).find(Boolean)[0];
  await staff.goto(link);
  await staff.getByLabel('รหัสผ่านใหม่').fill(PASSWORD);
  await staff.getByLabel('พิมพ์รหัสผ่านอีกครั้ง').fill(PASSWORD);
  await staff.getByRole('button', { name: 'บันทึกรหัสผ่าน' }).click();
  await expect(staff.getByRole('heading', { name: 'ตั้งรหัสผ่านใหม่แล้ว' })).toBeVisible();

  // Cleared and typed again: the list only goes back for more when the search
  // changes, and the password was set on the other person's machine.
  await admin.getByLabel('ค้นหาบัญชี').fill('');
  await admin.getByLabel('ค้นหาบัญชี').fill('newcounter@example.test');
  await expect(row).toContainText('ตั้งแล้ว');

  await signIn(staff, 'newcounter@example.test');
  await expect(staff.locator('.scanstage')).toBeVisible();
  // Staff run the counter; they do not hand out roles.
  await staff.getByRole('button', { name: 'ไปหน้าจัดการ' }).click();
  await expect(staff.getByRole('link', { name: 'ผู้ใช้และสิทธิ์' })).toHaveCount(0);

  // Promoting them ends the session they are holding, so the screen they see
  // always matches what they may do.
  await row.getByLabel('สิทธิ์ของ newcounter@example.test').selectOption('admin');
  await expect(admin.getByRole('status').filter({ hasText: 'เปลี่ยนสิทธิ์' })).toBeVisible();
  await staff.reload();
  await expect(staff.getByRole('button', { name: 'เข้าสู่ระบบ' })).toBeVisible();

  // Suspending shuts the door; the row says so and offers the way back.
  await admin.getByLabel('ค้นหาบัญชี').fill('newcounter@example.test');
  await row.getByRole('button', { name: 'ระงับบัญชี newcounter@example.test' }).click();
  await expect(admin.getByRole('status').filter({ hasText: 'ระงับบัญชี' })).toBeVisible();
  await expect(row).toContainText('ถูกระงับ');
  await expect(row.getByRole('button', { name: /คืนสิทธิ์/ })).toBeVisible();
});

test('the gym cannot be left without an administrator', async ({ page }) => {
  await signIn(page, 'admin11@example.test');
  await go(page, 'ผู้ใช้และสิทธิ์');
  await page.getByLabel('ค้นหาบัญชี').fill('admin11@example.test');
  const self = page.locator('.utable tbody tr').filter({ hasText: 'admin11@example.test' });

  // There are other admins seeded here, so this one is allowed to step down --
  // and doing so signs them straight out, which is the point.
  const others = await page.getByText(/ผู้ดูแลระบบที่ใช้งานได้ \d+ คน/).innerText();
  expect(Number(others.match(/(\d+) คน/)[1])).toBeGreaterThan(1);
  await self.getByLabel('สิทธิ์ของ admin11@example.test').selectOption('staff');
  await expect(page.getByRole('button', { name: 'เข้าสู่ระบบ' })).toBeVisible();
});

test('an admin who suspends their own account is told why the screen vanished', async ({ browser }) => {
  // Allowed as long as somebody else can still administer the gym. Without a
  // word on the way out the console simply disappears mid-click and the login
  // page offers no explanation (QA PM-17).
  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, 'admin12@example.test');
  await go(admin, 'ผู้ใช้และสิทธิ์');
  await admin.getByLabel('ค้นหาบัญชี').fill('admin12@example.test');
  const self = admin.locator('.utable tbody tr').filter({ hasText: 'admin12@example.test' });
  await self.getByRole('button', { name: 'ระงับบัญชี admin12@example.test' }).click();

  await expect(admin.getByRole('status').filter({ hasText: 'ระงับบัญชีของคุณแล้ว ออกจากระบบ' })).toBeVisible();
  await expect(admin.getByRole('button', { name: 'เข้าสู่ระบบ' })).toBeVisible();
  await admin.screenshot({ path: 'artifacts/admin-self-suspend.png', fullPage: true });
});
