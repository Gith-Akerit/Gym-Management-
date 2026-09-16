import { test, expect } from '@playwright/test';
import { go, PASSWORD, signIn } from './counter.js';

// Asking for an account from the login screen, and being let in.
//
// The whole journey in one spec, because it is the only way to see the thing
// that matters: the person fills in a form, proves the address is theirs, is
// told they are waiting, tries to sign in and cannot, the owner presses one
// button, and the same password now works. Any one of those steps checked on
// its own would pass while the chain was broken.

const OWNER = 'signup-admin@example.test';
const applicant = suffix => ({
  name: `นิด ขยัน${suffix}`,
  email: `ask-${suffix}@example.test`,
  phone: `08911100${suffix}`,
  password: PASSWORD,
});

/** Fills in the request form on the login screen and sends it. */
async function ask(page, person, code) {
  await page.goto('/');
  await page.getByRole('button', { name: 'ขอบัญชีพนักงาน' }).click();
  await page.getByLabel('ชื่อ–นามสกุล').fill(person.name);
  await page.getByLabel('อีเมล', { exact: true }).fill(person.email);
  await page.getByLabel('เบอร์มือถือ').fill(person.phone);
  await page.getByLabel('ตั้งรหัสผ่าน').fill(person.password);
  if (code !== undefined) await page.getByLabel('รหัสเชิญของยิม').fill(code);
  await page.getByRole('button', { name: 'ส่งคำขอ' }).click();
}

/**
 * Does what the person holding the letter does: opens it and presses the link.
 *
 * The token is pulled out of the letter the server actually produced rather
 * than minted beside it, so a template that stopped carrying the link would
 * fail here instead of passing quietly.
 */
async function pressLinkIn(page, email, pattern) {
  const letters = await (await page.request.get(`/__test/outbox?to=${encodeURIComponent(email)}`)).json();
  const found = letters.items.map(letter => pattern.exec(letter.text ?? '')).find(Boolean);
  expect(found, `ไม่พบลิงก์ในจดหมายที่ส่งถึง ${email}`).toBeTruthy();
  await page.goto(found[0]);
  return found[1];
}

const pressVerifyLink = (page, email) => pressLinkIn(page, email, /\/\?verify=[A-Za-z0-9_-]{43}/);

test('somebody asks, proves the address, waits, is approved, and walks in', async ({ page }) => {
  const person = applicant('11');
  await ask(page, person);

  await expect(page.getByRole('heading', { name: 'ส่งอีเมลยืนยันแล้ว' })).toBeVisible();
  await expect(page.getByText(person.email, { exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/signup-sent-1280.png', fullPage: true });

  // The link in the letter grants nothing, and says so.
  await pressVerifyLink(page, person.email);
  await expect(page.getByRole('heading', { name: 'ยืนยันอีเมลแล้ว' })).toBeVisible();
  await expect(page.getByText(/เจ้าของยิมกดอนุมัติ/)).toBeVisible();
  // And it is out of the address bar the moment it is used.
  expect(new URL(page.url()).search).toBe('');
  await page.getByRole('button', { name: 'ไปหน้าเข้าสู่ระบบ' }).click();

  // The right password, and still no way in -- on its own panel, not a red
  // line under the password box: nothing has gone wrong.
  await signIn(page, person.email, person.password);
  await expect(page.getByRole('heading', { name: 'รอเจ้าของยิมอนุมัติ' })).toBeVisible();
  await expect(page.getByText(/คำขอของคุณยังไม่ถูกปฏิเสธ/)).toBeVisible();
  await page.screenshot({ path: 'artifacts/signup-pending-login-1280.png', fullPage: true });

  // The owner sees who is asking, with enough to recognise them by, and is
  // told in the box itself what the risk of pressing the button is.
  await page.context().clearCookies();
  await signIn(page, OWNER);
  await go(page, 'ผู้ใช้และสิทธิ์');
  await expect(page.getByText('อนุมัติเฉพาะคนที่รู้จักตัวจริง')).toBeVisible();
  const waiting = page.locator('.qitem').filter({ hasText: person.email });
  await expect(waiting).toBeVisible();
  await expect(waiting).toContainText(person.name);
  await expect(page.getByRole('heading', { name: /^รออนุมัติ/ })).toBeVisible();
  await page.screenshot({ path: 'artifacts/signup-requests-1280.png', fullPage: true });

  // The role is said out loud on the button, so there is no default to leave
  // alone by accident.
  await waiting.getByRole('button', { name: 'อนุมัติเป็น พนักงาน' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'อนุมัติ' })).toBeVisible();
  await expect(page.locator('.qitem').filter({ hasText: person.email })).toHaveCount(0);

  // And now the password they chose for themselves works.
  await page.context().clearCookies();
  await signIn(page, person.email, person.password);
  await expect(page.getByRole('button', { name: 'เมนู', exact: true })).toBeVisible();
  await expect(page.getByText(/รอเจ้าของยิมอนุมัติ/)).toHaveCount(0);
});

test('nobody is approved before their address has answered', async ({ page }) => {
  const person = applicant('44');
  await ask(page, person);
  await expect(page.getByRole('heading', { name: 'ส่งอีเมลยืนยันแล้ว' })).toBeVisible();

  await signIn(page, OWNER);
  await go(page, 'ผู้ใช้และสิทธิ์');
  const waiting = page.locator('.qitem').filter({ hasText: person.email });
  // Both buttons dead, and the row says why rather than leaving the owner to
  // press a grey button and wonder.
  await expect(waiting.getByRole('button', { name: 'อนุมัติเป็น พนักงาน' })).toBeDisabled();
  await expect(waiting.getByRole('button', { name: 'อนุมัติเป็น ผู้ดูแลระบบ' })).toBeDisabled();
  await expect(waiting.getByText(/ยังยืนยันอีเมลไม่สำเร็จ/)).toBeVisible();
  await page.screenshot({ path: 'artifacts/signup-unverified-1280.png', fullPage: true });

  // The one thing that helps when somebody says they never got it.
  await waiting.getByRole('button', { name: 'ส่งอีเมลยืนยันอีกครั้ง' }).click();
  await expect(waiting.getByText('ส่งอีเมลยืนยันใหม่แล้ว')).toBeVisible();

  await pressVerifyLink(page, person.email);
  await expect(page.getByRole('heading', { name: 'ยืนยันอีเมลแล้ว' })).toBeVisible();
  await page.goto('/');
  await go(page, 'ผู้ใช้และสิทธิ์');
  await expect(page.locator('.qitem').filter({ hasText: person.email })
    .getByRole('button', { name: 'อนุมัติเป็น ผู้ดูแลระบบ' })).toBeEnabled();
});

test('a refusal says why, and the person is told the same thing at the door', async ({ page }) => {
  const person = applicant('22');
  await ask(page, person);
  await expect(page.getByRole('heading', { name: 'ส่งอีเมลยืนยันแล้ว' })).toBeVisible();
  await pressVerifyLink(page, person.email);

  await signIn(page, OWNER);
  await go(page, 'ผู้ใช้และสิทธิ์');
  const waiting = page.locator('.qitem').filter({ hasText: person.email });
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
  await expect(page.getByRole('heading', { name: 'คำขอไม่ได้รับอนุมัติ' })).toBeVisible();
  await expect(page.getByText(/ไม่ใช่พนักงานของยิมนี้/)).toBeVisible();
  await page.screenshot({ path: 'artifacts/signup-rejected-1280.png', fullPage: true });
});

test('the form says the same thing about an address that already has an account', async ({ page }) => {
  // Otherwise this form is the tool that tells somebody which addresses belong
  // to the gym -- exactly what the login screen refuses to say.
  await ask(page, { ...applicant('33'), email: OWNER });
  await expect(page.getByRole('heading', { name: 'ส่งอีเมลยืนยันแล้ว' })).toBeVisible();
  await page.getByRole('button', { name: 'กลับไปหน้าเข้าสู่ระบบ' }).click();

  // And the owner's own account is untouched by it.
  await signIn(page, OWNER);
  await expect(page.getByRole('button', { name: 'เมนู', exact: true })).toBeVisible();
});

test('the Google button holds its place without pretending to work yet', async ({ page }) => {
  await page.goto('/');
  const google = page.getByRole('button', { name: 'ดำเนินการต่อด้วย Google' });
  await expect(google).toBeVisible();
  await expect(google).toBeDisabled();
  await expect(page.getByText('กำลังพัฒนา จะเปิดใช้ในรอบถัดไป').first()).toBeVisible();
  // The mark is Google's own artwork, not a letter G drawn here: four paths in
  // their four colours. Redrawing it is against their brand terms.
  await expect(google.locator('svg path[fill="#4285F4"]')).toHaveCount(1);
  await expect(google.locator('svg path[fill="#EA4335"]')).toHaveCount(1);
  await expect(google.locator('svg path[fill="#FBBC05"]')).toHaveCount(1);
  await expect(google.locator('svg path[fill="#34A853"]')).toHaveCount(1);
});

test('the form fits a phone, and says who it is for', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'ขอบัญชีพนักงาน' }).click();
  // Members do not have accounts and must not be sent down this path looking
  // for one: the screen says so where somebody filling it in would see it.
  await expect(page.getByText(/สมาชิกที่มาออกกำลังกายใช้บัตรที่ได้รับตอนสมัคร/)).toBeVisible();

  const overflowing = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    return [...document.querySelectorAll('body *')]
      .filter(el => { const box = el.getBoundingClientRect(); return box.width && box.right > limit + 0.5; })
      .slice(0, 4).map(el => `${el.tagName.toLowerCase()}.${el.className}`);
  });
  expect(overflowing, 'หน้าขอบัญชีพนักงานที่ 390px ล้นขอบ').toEqual([]);
  await page.screenshot({ path: 'artifacts/signup-form-390.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
});

