import { test, expect } from '@playwright/test';
import { PASSWORD, signIn } from './counter.js';

// Spec files share one test server and run in filename order, hence the number
// prefixes. This one goes first because everything after it signs in.

test('the login screen is for staff, and says so', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeVisible();
  await expect(page.getByText('สมาชิกไม่ต้องเข้าสู่ระบบ')).toBeVisible();
  // Nothing about codes, mailboxes or signing up: there is no member app left
  // for any of it to belong to.
  await expect(page.getByRole('button', { name: 'รับรหัสทางอีเมล' })).toHaveCount(0);
  await expect(page.getByLabel('รหัสผ่าน')).toHaveAttribute('type', 'password');
  await page.screenshot({ path: 'artifacts/ui-login.png', fullPage: true });
});

test('a wrong password is refused without saying which half was wrong', async ({ page }) => {
  await signIn(page, 'admin2@example.test', 'not-the-password');
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  // The typed password stays put: somebody who mistyped one character should
  // fix that character rather than type twelve again.
  await expect(page.getByLabel('รหัสผ่าน')).toHaveValue('not-the-password');

  // An address with no account at all answers exactly the same.
  await signIn(page, 'nobody-at-all@example.test', 'not-the-password');
  await expect(page.getByRole('alert')).toContainText('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
});

test('an account the owner has not given a password to cannot get in', async ({ page }) => {
  await signIn(page, 'nopassword-ui@example.test', PASSWORD);
  await expect(page.getByRole('alert')).toContainText('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  await expect(page.getByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeVisible();
});

test('the owner signs in and lands on the counter', async ({ page }) => {
  await signIn(page, 'admin2@example.test');
  // Scanning is the first screen: it is the one opened every time the door
  // opens, which on a small gym is the owner's job as much as anybody's.
  await expect(page.getByRole('heading', { name: 'สแกนเช็คอิน' })).toBeVisible();
  await expect(page.getByText('ผู้ดูแลระบบ').first()).toBeVisible();
  await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
  await expect(page.getByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeVisible();
});
