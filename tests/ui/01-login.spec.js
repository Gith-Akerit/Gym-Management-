import { test, expect } from '@playwright/test';
import { logOut, PASSWORD, signIn } from './counter.js';

// Spec files share one test server and run in filename order, hence the number
// prefixes. This one goes first because everything after it signs in.

test('the login screen is for staff, and says so', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('สำหรับพนักงานและเจ้าของยิมเท่านั้น')).toBeVisible();
  // Nothing about codes, mailboxes or signing up: there is no member app left
  // for any of it to belong to, and no public page in front of this one.
  await expect(page.getByRole('button', { name: 'รับรหัสทางอีเมล' })).toHaveCount(0);
  await expect(page.getByText('ยังไม่เปิดขายแพ็กเกจ')).toHaveCount(0);
  await expect(page.getByLabel('รหัสผ่าน', { exact: true })).toHaveAttribute('type', 'password');
  await expect(page.getByText('ให้เจ้าของยิมตั้งรหัสใหม่ให้', { exact: false })).toBeVisible();
});

test('a wrong password is refused, and says how many tries are left', async ({ page }) => {
  await signIn(page, 'admin2@example.test', 'not-the-password');
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  // Counting down out loud: somebody mistyping their own password should find
  // out they are near the lockout before they hit it, not after.
  await expect(alert).toContainText('เหลืออีก');
  // The typed password stays put: somebody who mistyped one character should
  // fix that character rather than type twelve again.
  await expect(page.getByLabel('รหัสผ่าน', { exact: true })).toHaveValue('not-the-password');

  // An address with no account at all answers exactly the same.
  await signIn(page, 'nobody-at-all@example.test', 'not-the-password');
  await expect(page.getByRole('alert')).toContainText('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
});

test('an account the owner has not given a password to cannot get in', async ({ page }) => {
  await signIn(page, 'nopassword-ui@example.test', PASSWORD);
  await expect(page.getByRole('alert')).toContainText('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  await expect(page.getByRole('button', { name: 'เข้าสู่ระบบ' })).toBeVisible();
});

test('a set-password link opens a form with no session, and works once', async ({ page, request }) => {
  // The state the installed gym is in: an administrator account with no
  // password, and no second admin to fix it from inside the app.
  const issued = await request.post('/__test/setup-link', {
    data: { email: 'relink-ui@example.test' }, headers: { 'X-Gym-Client': 'web' },
  });
  const { token } = await issued.json();

  await page.goto(`/?setpw=${token}`);
  await expect(page.getByText('relink-ui@example.test')).toBeVisible();
  // The token leaves the address bar immediately: a screenshot of this screen,
  // or a back button, must not carry a working way in around with it.
  expect(new URL(page.url()).search).toBe('');

  await page.getByLabel('รหัสผ่านใหม่', { exact: true }).fill('a-password-the-owner-picked');
  await page.getByLabel('พิมพ์รหัสผ่านอีกครั้ง').fill('a-password-the-owner-picked');
  await page.getByRole('button', { name: 'บันทึกรหัสผ่าน' }).click();
  await expect(page.getByText('ตั้งรหัสผ่านเรียบร้อย', { exact: false })).toBeVisible();

  await signIn(page, 'relink-ui@example.test', 'a-password-the-owner-picked');
  await expect(page.getByRole('button', { name: 'ไปหน้าจัดการ' })).toBeVisible();

  // The link is spent. Opening it again says so instead of offering the form.
  await page.goto(`/?setpw=${token}`);
  await expect(page.getByText('ลิงก์นี้ใช้ไม่ได้แล้ว')).toBeVisible();
  await expect(page.getByText('หมดอายุหรือถูกใช้ไปแล้ว', { exact: false })).toBeVisible();
});

test('the owner signs in and lands on the scan screen', async ({ page }) => {
  await signIn(page, 'admin2@example.test');
  // Scanning is the first screen: it is the one opened every time the door
  // opens, which on a small gym is the owner's job as much as anybody's.
  await expect(page.locator('.scanstage')).toBeVisible();
  await expect(page.getByText('พร้อมสแกน')).toBeVisible();
  await expect(page.getByText('เจ้าของยิม').first()).toBeVisible();
  // Signing out now lives in the corner menu, on this screen as on every other.
  await logOut(page);
});
