import { test, expect } from '@playwright/test';
import { go, PASSWORD, signIn } from './counter.js';

// Asking for an account from the login screen, and being let in.
//
// The whole journey in one spec, because it is the only way to see the thing
// that matters: the person fills in a form, is told they are waiting, tries to
// sign in and cannot, the owner presses one button, and the same password now
// works. Any one of those steps checked on its own would pass while the chain
// was broken.

const OWNER = 'signup-admin@example.test';
const applicant = suffix => ({
  name: `นิด ขยัน${suffix}`,
  email: `ask-${suffix}@example.test`,
  phone: `08911100${suffix}`,
  password: PASSWORD,
});

/** Fills in the request form on the login screen and sends it. */
async function ask(page, person) {
  await page.goto('/');
  await page.getByRole('button', { name: 'ยังไม่มีบัญชี · ขอเข้าใช้งาน' }).click();
  await page.getByLabel('ชื่อ–นามสกุล').fill(person.name);
  await page.getByLabel('อีเมล', { exact: true }).fill(person.email);
  await page.getByLabel('เบอร์มือถือ').fill(person.phone);
  await page.getByLabel('ตั้งรหัสผ่าน').fill(person.password);
  await page.getByRole('button', { name: 'ส่งคำขอเข้าใช้งาน' }).click();
}

test('somebody asks, waits, is approved, and walks in with the same password', async ({ page }) => {
  const person = applicant('11');
  await ask(page, person);

  await expect(page.getByRole('status').filter({ hasText: 'ส่งคำขอแล้ว' })).toBeVisible();
  // Told now, not after they try and fail: they are about to try.
  await expect(page.getByText('ระหว่างนี้ยังเข้าใช้งานไม่ได้')).toBeVisible();
  await page.screenshot({ path: 'artifacts/signup-sent-1280.png', fullPage: true });
  await page.getByRole('button', { name: 'กลับไปหน้าเข้าสู่ระบบ' }).click();

  // The right password, and still no way in.
  await signIn(page, person.email, person.password);
  await expect(page.getByText(/รอเจ้าของยิมอนุมัติ/)).toBeVisible();
  await expect(page.locator('.scanstage:not(.loginstage)')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/signup-pending-login-1280.png', fullPage: true });

  // The owner sees who is asking, with enough to recognise them by.
  await page.context().clearCookies();
  await signIn(page, OWNER);
  await go(page, 'ผู้ใช้และสิทธิ์');
  const waiting = page.locator('.rep').filter({ hasText: person.email });
  await expect(waiting).toBeVisible();
  await expect(waiting).toContainText(person.name);
  await expect(page.getByRole('heading', { name: /^รออนุมัติ/ })).toBeVisible();
  await page.screenshot({ path: 'artifacts/signup-requests-1280.png', fullPage: true });

  // Approving is where the role is chosen, in the same press.
  await waiting.getByLabel(`สิทธิ์ที่จะให้ ${person.name}`).selectOption('staff');
  await waiting.getByRole('button', { name: 'อนุมัติ', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'อนุมัติ' })).toBeVisible();
  await expect(page.locator('.rep').filter({ hasText: person.email })).toHaveCount(0);

  // And now the password they chose for themselves works.
  await page.context().clearCookies();
  await signIn(page, person.email, person.password);
  await expect(page.getByRole('button', { name: 'เมนู', exact: true })).toBeVisible();
  await expect(page.getByText(/รอเจ้าของยิมอนุมัติ/)).toHaveCount(0);
});

test('a refusal says why, and the person is told the same thing at the door', async ({ page }) => {
  const person = applicant('22');
  await ask(page, person);
  await expect(page.getByRole('status').filter({ hasText: 'ส่งคำขอแล้ว' })).toBeVisible();

  await signIn(page, OWNER);
  await go(page, 'ผู้ใช้และสิทธิ์');
  const waiting = page.locator('.rep').filter({ hasText: person.email });
  await waiting.getByRole('button', { name: 'ปฏิเสธ' }).click();

  // The reason is required, because it is what the person receives.
  const confirm = waiting.getByRole('button', { name: 'ยืนยันการปฏิเสธ' });
  await expect(confirm).toBeDisabled();
  await waiting.getByLabel(`เหตุผลที่ปฏิเสธ ${person.name}`).fill('ไม่ใช่พนักงานของยิมนี้');
  await expect(page.getByText('ข้อความนี้ถูกส่งไปที่อีเมลของผู้สมัคร')).toBeVisible();
  await page.screenshot({ path: 'artifacts/signup-reject-1280.png', fullPage: true });
  await confirm.click();
  await expect(page.getByRole('status').filter({ hasText: 'ปฏิเสธคำขอแล้ว' })).toBeVisible();

  await page.context().clearCookies();
  await signIn(page, person.email, person.password);
  // The same sentence the owner typed, so nobody has to ask what happened.
  await expect(page.getByText(/ไม่ได้รับอนุมัติ/)).toBeVisible();
  await expect(page.getByText(/ไม่ใช่พนักงานของยิมนี้/)).toBeVisible();
});

test('the form says the same thing about an address that already has an account', async ({ page }) => {
  // Otherwise this form is the tool that tells somebody which addresses belong
  // to the gym -- exactly what the login screen refuses to say.
  await ask(page, { ...applicant('33'), email: OWNER });
  await expect(page.getByRole('status').filter({ hasText: 'ส่งคำขอแล้ว' })).toBeVisible();
  await page.getByRole('button', { name: 'กลับไปหน้าเข้าสู่ระบบ' }).click();

  // And the owner's own account is untouched by it.
  await signIn(page, OWNER);
  await expect(page.getByRole('button', { name: 'เมนู', exact: true })).toBeVisible();
});

test('the form fits a phone, and says who it is for', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'ยังไม่มีบัญชี · ขอเข้าใช้งาน' }).click();
  // Members do not have accounts and must not be sent down this path looking
  // for one: the screen says so where somebody filling it in would see it.
  await expect(page.getByText(/ไม่ใช่สำหรับสมาชิกที่มาออกกำลังกาย/)).toBeVisible();

  const overflowing = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    return [...document.querySelectorAll('body *')]
      .filter(el => { const box = el.getBoundingClientRect(); return box.width && box.right > limit + 0.5; })
      .slice(0, 4).map(el => `${el.tagName.toLowerCase()}.${el.className}`);
  });
  expect(overflowing, 'หน้าขอเข้าใช้งานที่ 390px ล้นขอบ').toEqual([]);
  await page.screenshot({ path: 'artifacts/signup-form-390.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
});
