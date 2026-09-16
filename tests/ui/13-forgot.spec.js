import { test, expect } from '@playwright/test';
import { go, PASSWORD, signIn } from './counter.js';

// Forgetting a password, and the gym's invite code.
//
// Until now the way back in was to telephone the owner and be read a password
// out loud, which is how a password ends up in a group chat. This is the
// replacement, and the two things it must not do are: tell somebody whether an
// address has an account here, and leave the old sessions open after the
// password that protected them has been replaced.

const OWNER = 'forgot-admin@example.test';
const RESET = /\/\?setpw=[A-Za-z0-9_-]{43}/;

/** Reads the letter that just arrived and presses the link in it. */
async function pressResetLink(page, email) {
  const letters = await (await page.request.get(`/__test/outbox?to=${encodeURIComponent(email)}`)).json();
  const found = letters.items.map(letter => RESET.exec(letter.text ?? '')).find(Boolean);
  expect(found, `ไม่พบลิงก์ตั้งรหัสผ่านใหม่ในจดหมายถึง ${email}`).toBeTruthy();
  await page.goto(found[0]);
}

async function askForALink(page, email) {
  await page.goto('/');
  await page.getByRole('button', { name: 'ลืมรหัสผ่าน' }).click();
  await page.getByLabel('อีเมล', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'ส่งลิงก์ตั้งรหัสผ่านใหม่' }).click();
}

test('the screen answers a stranger and an account holder with one sentence', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await askForALink(page, 'nobody-here-at-all@example.test');
  await expect(page.getByRole('heading', { name: 'ถ้ามีบัญชีนี้อยู่ เราส่งอีเมลไปแล้ว' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/forgot-sent-390.png', fullPage: true });
  const strangerSaw = await page.locator('.authcard').innerText();

  await askForALink(page, OWNER);
  await expect(page.getByRole('heading', { name: 'ถ้ามีบัญชีนี้อยู่ เราส่งอีเมลไปแล้ว' })).toBeVisible();
  // Word for word, apart from the address the person typed themselves.
  expect((await page.locator('.authcard').innerText()).replace(OWNER, 'x'))
    .toBe(strangerSaw.replace('nobody-here-at-all@example.test', 'x'));

  // And the half that is easy to forget: no letter left the building for the
  // address that has no account. A reply saying "there is no account here"
  // would undo the whole thing from the other side.
  const toStranger = await (await page.request.get('/__test/outbox?to=nobody-here-at-all@example.test')).json();
  expect(toStranger.items, 'อีเมลที่ไม่มีบัญชีต้องไม่มีเมลออกไปเลยสักฉบับ').toHaveLength(0);
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('the link sets a new password and closes every session that was open', async ({ page }) => {
  // A tablet left signed in at the counter, the way one is between shifts.
  await signIn(page, OWNER);
  await expect(page.getByRole('button', { name: 'เมนู', exact: true })).toBeVisible();
  const tablet = await page.context().storageState();

  // The person is at home on their own phone, signed in nowhere.
  await page.context().clearCookies();
  await askForALink(page, OWNER);
  await pressResetLink(page, OWNER);
  await expect(page.getByRole('heading', { name: 'ตั้งรหัสผ่านใหม่' })).toBeVisible();
  await expect(page.getByText(OWNER, { exact: false })).toBeVisible();
  await page.screenshot({ path: 'artifacts/reset-form-1280.png', fullPage: true });

  const fresh = 'a-brand-new-counter-password';
  await page.getByLabel('รหัสผ่านใหม่').fill(fresh);
  await page.getByLabel('พิมพ์รหัสผ่านอีกครั้ง').fill(fresh);
  await page.getByRole('button', { name: 'บันทึกรหัสผ่าน' }).click();
  await expect(page.getByRole('heading', { name: 'ตั้งรหัสผ่านใหม่แล้ว' })).toBeVisible();
  await expect(page.getByText(/ถูกออกจากระบบทั้งหมดแล้ว/)).toBeVisible();
  await page.screenshot({ path: 'artifacts/reset-done-1280.png', fullPage: true });

  // The tablet that was left signed in is not signed in any more.
  await page.context().addCookies(tablet.cookies);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'เข้าสู่ระบบ' })).toBeVisible();

  // The new password works, the old one does not.
  await signIn(page, OWNER, PASSWORD);
  await expect(page.getByRole('alert')).toContainText('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  await signIn(page, OWNER, fresh);
  await expect(page.getByRole('button', { name: 'เมนู', exact: true })).toBeVisible();
});

test('a link that has been used already says so without blaming anybody', async ({ page }) => {
  await askForALink(page, 'forgot-twice@example.test');
  const letters = await (await page.request.get('/__test/outbox?to=forgot-twice@example.test')).json();
  const link = letters.items.map(letter => RESET.exec(letter.text ?? '')).find(Boolean)[0];

  await page.goto(link);
  const fresh = 'another-counter-password-x';
  await page.getByLabel('รหัสผ่านใหม่').fill(fresh);
  await page.getByLabel('พิมพ์รหัสผ่านอีกครั้ง').fill(fresh);
  await page.getByRole('button', { name: 'บันทึกรหัสผ่าน' }).click();
  await expect(page.getByRole('heading', { name: 'ตั้งรหัสผ่านใหม่แล้ว' })).toBeVisible();

  // The same link, opened a second time from an old message.
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'ลิงก์นี้ใช้ไม่ได้แล้ว' })).toBeVisible();
  await expect(page.getByText(/30 นาที/)).toBeVisible();
  await page.screenshot({ path: 'artifacts/reset-expired-1280.png', fullPage: true });
  await page.getByRole('button', { name: 'ขอลิงก์ใหม่' }).click();
  await expect(page.getByRole('button', { name: 'เข้าสู่ระบบ' })).toBeVisible();
});

test('the owner can close the sign-up form with a code, and the form never says so', async ({ page }) => {
  await signIn(page, 'invite-admin@example.test');
  await go(page, 'ตั้งค่ายิม');
  await page.getByLabel('รหัสเชิญ').fill('SUKLUTAI-2026');
  await page.getByRole('button', { name: 'บันทึกการตั้งค่า' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกการตั้งค่ายิมแล้ว' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/invite-code-1280.png', fullPage: true });

  // The form now asks for it -- and asks nothing else about it.
  await page.context().clearCookies();
  await page.goto('/');
  await page.getByRole('button', { name: 'ขอบัญชีพนักงาน' }).click();
  await expect(page.getByLabel('รหัสเชิญของยิม')).toBeVisible();
  await page.getByLabel('ชื่อ–นามสกุล').fill('คนนอก ไม่รู้รหัส');
  await page.getByLabel('อีเมล', { exact: true }).fill('outsider@example.test');
  await page.getByLabel('เบอร์มือถือ').fill('0899000111');
  await page.getByLabel('ตั้งรหัสผ่าน').fill(PASSWORD);
  await page.getByLabel('รหัสเชิญของยิม').fill('GUESS');
  await page.getByRole('button', { name: 'ส่งคำขอ' }).click();

  // A wrong code is answered exactly like a duplicate address. Saying "wrong
  // code" would turn this form into a way to find out whether a gym uses one.
  await expect(page.getByRole('heading', { name: 'ส่งอีเมลยืนยันแล้ว' })).toBeVisible();
  const sent = await (await page.request.get('/__test/outbox?to=outsider@example.test')).json();
  expect(sent.items, 'รหัสเชิญผิดต้องไม่สร้างบัญชีและไม่ส่งเมล').toHaveLength(0);

  // Put it back, so the specs after this one meet the form every gym starts with.
  await signIn(page, 'invite-admin@example.test');
  await go(page, 'ตั้งค่ายิม');
  await page.getByLabel('รหัสเชิญ').fill('');
  await page.getByRole('button', { name: 'บันทึกการตั้งค่า' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกการตั้งค่ายิมแล้ว' })).toBeVisible();
});
