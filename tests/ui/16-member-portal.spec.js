import { test, expect } from '@playwright/test';
import { go, PNG_PIXEL, signIn } from './counter.js';

// The member's own app, walked the way a member walks it: a card arrives by
// email, the link in it sets a password, and from then on the phone is the
// way in.
//
// Two things are being proved beyond "the screens render". The machine page
// behind the QR sticker must work for somebody who has never signed in and
// never will -- that is the whole reason it is server-rendered. And the
// programme behind the membership must stop the moment the membership does,
// without the session changing at all.

const OWNER = 'portal-admin@example.test';
const MEMBER = { name: 'พรทิพย์ ใจสู้', phone: '0893331177', email: 'porn@example.test' };
const MEMBER_PASSWORD = 'a-password-of-my-own';

/** Signs somebody up at the counter WITH an address, the way a member joins. */
async function joinAndSetPassword(page) {
  await signIn(page, OWNER);
  await go(page, 'สมัครสมาชิก');
  await page.getByLabel('เลือกรูปจากเครื่องแทน')
    .setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: PNG_PIXEL });
  await page.getByRole('button', { name: 'ถัดไป · ชื่อและเบอร์' }).click();
  await page.getByLabel('ชื่อ–นามสกุล').fill(MEMBER.name);
  await page.getByLabel('เบอร์มือถือ').fill(MEMBER.phone);
  await page.getByLabel('อีเมล (ไม่บังคับ)').fill(MEMBER.email);
  await page.getByRole('button', { name: 'ถัดไป · แพ็กเกจและเงิน' }).click();
  await page.getByRole('radio', { name: /รายเดือน Unlimited/ }).check();
  await page.getByRole('button', { name: 'บันทึกและออกบัตร' }).click();
  await expect(page.getByRole('heading', { name: 'บัตรสมาชิก' })).toBeVisible();

  // The wizard posts the card letter itself, without waiting for it.
  await expect.poll(async () => {
    const box = await (await page.request.get(`/__test/outbox?to=${MEMBER.email}`)).json();
    return box.items.length;
  }, { message: 'สมาชิกที่กรอกอีเมลต้องได้รับบัตรทางอีเมล' }).toBeGreaterThan(0);

  const letters = await (await page.request.get(`/__test/outbox?to=${MEMBER.email}`)).json();
  const link = letters.items.map(letter => /\/\?setpw=[A-Za-z0-9_-]{43}/.exec(letter.text ?? '')).find(Boolean);
  expect(link, 'จดหมายบัตรสมาชิกต้องมีลิงก์ตั้งรหัสผ่าน').toBeTruthy();

  await page.context().clearCookies();
  await page.goto(link[0]);
  await page.getByLabel('รหัสผ่านใหม่').fill(MEMBER_PASSWORD);
  await page.getByLabel('พิมพ์รหัสผ่านอีกครั้ง').fill(MEMBER_PASSWORD);
  await page.getByRole('button', { name: 'บันทึกรหัสผ่าน' }).click();
  await expect(page.getByRole('heading', { name: 'ตั้งรหัสผ่านใหม่แล้ว' })).toBeVisible();
}

async function signInAsMember(page) {
  await page.goto('/m/login');
  await page.getByLabel('อีเมล', { exact: true }).fill(MEMBER.email);
  await page.getByLabel('รหัสผ่าน', { exact: true }).fill(MEMBER_PASSWORD);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
}

test('the page behind the sticker works for somebody who has never signed in', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/m/M-01');

  await expect(page.getByRole('heading', { name: 'ลู่วิ่งไฟฟ้า' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'วิธีใช้' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ข้อควรระวัง' })).toBeVisible();
  await expect(page.getByText(/คลิปฉุกเฉิน/)).toBeVisible();

  // The clip is a still and a button. Five embedded players on gym wifi is
  // five megabytes for something most people never press.
  await expect(page.locator('iframe')).toHaveCount(0);
  const play = page.getByRole('button', { name: /^เล่นคลิป/ });
  await expect(play).toBeVisible();
  await play.click();
  await expect(page.locator('iframe')).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/machine-page-390.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('a member signs in on their phone and follows a programme', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await joinAndSetPassword(page);
  await signInAsMember(page);

  await expect(page.getByRole('heading', { name: `สวัสดี ${MEMBER.name}` })).toBeVisible();
  // Nothing about roles or permissions: a member has none to be told about.
  await expect(page.getByText('พนักงาน', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/อายุต่ำกว่า 18 ปี/)).toBeVisible();
  await page.screenshot({ path: 'artifacts/portal-home-390.png', fullPage: true });

  await page.getByRole('link', { name: /เริ่มต้น 4 สัปดาห์/ }).click();
  await expect(page.getByRole('heading', { name: 'เริ่มต้น 4 สัปดาห์' })).toBeVisible();
  // Numbers nobody at the gym has checked say so, on the screen, where
  // somebody about to lift reads them.
  await expect(page.getByText('ตัวเลขเป็นค่าตัวอย่างเริ่มต้น')).toBeVisible();
  await expect(page.getByText('ก่อนเริ่มทุกครั้ง')).toBeVisible();
  const stations = page.locator('.steps-x li');
  await expect(stations.first()).toBeVisible();
  expect(await stations.count()).toBeGreaterThan(3);
  await page.screenshot({ path: 'artifacts/portal-program-390.png', fullPage: true });

  // Each station links to the same public page the sticker opens: written
  // once, read from both places.
  await stations.nth(1).getByRole('link', { name: /ดูวิธีใช้/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(new URL(page.url()).pathname).toMatch(/^\/m\/M-\d\d$/);

  await page.setViewportSize({ width: 1280, height: 900 });
});

test('a member cannot reach the counter, and the counter cannot reach the portal', async ({ page }) => {
  await signInAsMember(page);
  await expect(page.getByRole('heading', { name: `สวัสดี ${MEMBER.name}` })).toBeVisible();

  // The member's own session, pointed at the counter's screens.
  for (const path of ['/api/members', '/api/users', '/api/packages', '/api/gym/settings']) {
    const answer = await page.request.get(path);
    expect([401, 403], `${path} ตอบ ${answer.status()}`).toContain(answer.status());
  }
  // And the counter app itself hands them the staff login, not the console.
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'เข้าสู่ระบบ' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'เมนู', exact: true })).toHaveCount(0);
});

test('the programme stops when the membership does, without the session changing', async ({ page }) => {
  await signInAsMember(page);
  await expect(page.getByRole('heading', { name: `สวัสดี ${MEMBER.name}` })).toBeVisible();

  // The owner cancels the membership from the counter, on another machine.
  const owner = await page.context().browser().newContext();
  const deskPage = await owner.newPage();
  await signIn(deskPage, OWNER);
  await go(deskPage, 'สมาชิก');
  await deskPage.getByLabel('ค้นหาสมาชิก').fill(MEMBER.name);
  await deskPage.getByRole('button', { name: `เปิดสมาชิก ${MEMBER.name}` }).click();
  await deskPage.request.post('/__test/expire-membership', {
    headers: { 'X-Gym-Client': 'web' }, data: { phone: MEMBER.phone },
  });
  await owner.close();

  // The member's phone has not been touched. The next thing it asks for is
  // refused, and it lands on the screen that says what to do about it.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'สมาชิกหมดอายุแล้ว' })).toBeVisible();
  await expect(page.getByText(/ด้วยรหัสผ่านเดิม ไม่ต้องตั้งใหม่/)).toBeVisible();
  await expect(page.getByText(/บัญชีของคุณไม่ได้ถูกลบ/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/portal-expired-390.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // The machine pages still work, because they were never the paid part.
  await page.goto('/m/M-03');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('the owner prints one QR sheet for the whole gym', async ({ page }) => {
  await signIn(page, OWNER);
  // Wait for the session to exist before asking for anything with it.
  await expect(page.getByRole('button', { name: 'เมนู', exact: true })).toBeVisible();
  const sheet = await page.request.get('/api/machines/qr-sheet');
  expect(sheet.status()).toBe(200);
  const html = await sheet.text();
  expect((html.match(/class="qr"/g) ?? []).length).toBe(6);
  expect(html).toContain('ลู่วิ่งไฟฟ้า');
  expect(html).toMatch(/ไม่ต้องเข้าสู่ระบบ/);

  // Staff do not get it: a sheet of QR codes is a thing the owner prints once.
  await page.context().clearCookies();
  await signIn(page, 'portal-staff@example.test');
  await expect(page.getByRole('button', { name: 'เมนู', exact: true })).toBeVisible();
  expect((await page.request.get('/api/machines/qr-sheet')).status()).toBe(403);
});
