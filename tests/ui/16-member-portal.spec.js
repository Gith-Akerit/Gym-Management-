import { test, expect } from '@playwright/test';
import { contrastIn, go, PNG_PIXEL, signIn, tooFaint } from './counter.js';

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

test('the portal wears the gym own colour without anything disappearing into it', async ({ page }) => {
  await signInAsMember(page);
  await expect(page.getByRole('heading', { name: `สวัสดี ${MEMBER.name}` })).toBeVisible();

  // The badge in the top bar is the gym's initials in a white box -- unless
  // the gym has uploaded a logo, in which case it is the logo. Both states
  // happen in this suite depending on what ran before, so the rule is measured
  // rather than the instance: put a span where the initials go and ask what
  // colour the cascade gives it. It gave white, inside a white box, on the
  // first screen a member ever sees (BUG-10).
  const badge = page.locator('.mtop .mk');
  await expect(badge).toBeVisible();
  const ratio = await page.evaluate(() => {
    const box = document.querySelector('.mtop .mk');
    const probe = document.createElement('span');
    probe.textContent = 'สฟ';
    box.append(probe);
    const parse = value => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = ([r, g, b]) => {
      const channel = v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const ink = luminance(parse(getComputedStyle(probe).color));
    const behind = luminance(parse(getComputedStyle(box).backgroundColor));
    probe.remove();
    return Math.round(((Math.max(ink, behind) + 0.05) / (Math.min(ink, behind) + 0.05)) * 100) / 100;
  });
  expect(ratio, 'ตราย่อชื่อยิมบนแถบพอร์ทัล').toBeGreaterThanOrEqual(4.5);

  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(tooFaint(await contrastIn(page)), `พอร์ทัลหน้าแรก ที่ ${width}px`).toEqual([]);
  }

  // And the same sweep on the two screens behind it, because the bar is on
  // every one of them.
  await page.getByRole('link', { name: 'วิธีใช้เครื่อง', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'วิธีใช้เครื่อง', level: 1 })).toBeVisible();
  expect(tooFaint(await contrastIn(page)), 'พอร์ทัลหน้าเครื่อง').toEqual([]);
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

test('the member tab says what the member opened, and the number is dialable', async ({ page }) => {
  // The spec before this one signs in at the counter; both front doors here
  // are the signed-out ones.
  await page.context().clearCookies();
  await page.goto('/m/login');
  await expect(page.getByRole('button', { name: 'เข้าสู่ระบบ' })).toBeVisible();
  // It said "· จัดการยิม" -- the staff app's name -- on a screen only members
  // reach, because both apps ship in one bundle and the title was written once
  // for the counter (BUG-13).
  await expect.poll(() => page.title()).toMatch(/ช่วยเล่น$/);
  expect(await page.title()).not.toMatch(/จัดการยิม/);

  // And the counter's own front door keeps its own name.
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'เข้าสู่ระบบ' })).toBeVisible();
  await expect.poll(() => page.title()).toMatch(/จัดการยิม$/);
});

test('a sticker for a machine that is gone speaks Thai', async ({ page }) => {
  await page.context().clearCookies();
  const answer = await page.request.get('/m/M-99');
  expect(answer.status()).toBe(404);

  // Somebody standing at the machine with a phone got Express's own page:
  // English, headed "Error", `Cannot GET /m/M-99` (BUG-11).
  await page.goto('/m/M-99');
  await expect(page.getByRole('heading', { name: 'ไม่พบเครื่องนี้' })).toBeVisible();
  await expect(page.getByText(/ถามพนักงานที่เคาน์เตอร์/)).toBeVisible();
  expect(await page.title()).toMatch(/ไม่พบเครื่องนี้/);
  expect(await page.content()).not.toContain('Cannot GET');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/machine-missing-390.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('a membership taken back says so, rather than showing a date next month', async ({ page }) => {
  // The spec above ended this membership by its own date, so this one starts
  // on the expiry screen -- which is exactly the comparison worth making: one
  // member, one session, the two endings back to back.
  await signInAsMember(page);
  await expect(page.getByRole('heading', { name: 'สมาชิกหมดอายุแล้ว' })).toBeVisible();
  await expect(page.locator('.wall .when')).toHaveCount(1, { timeout: 5000 });

  // Now the owner reverses the approval -- a refund, or an approval made by
  // mistake. A different fact about the same membership.
  await page.request.post('/__test/revoke-membership', {
    headers: { 'X-Gym-Client': 'web' }, data: { phone: MEMBER.phone },
  });

  await page.reload();
  await expect(page.getByRole('heading', { name: 'สิทธิ์ถูกยกเลิก' })).toBeVisible();
  await expect(page.getByText(/ติดต่อเคาน์เตอร์/)).toBeVisible();
  // The date it WOULD have run to is not a fact about today, and printing it
  // sent members to the counter with the screen held up as proof (BUG-12).
  await expect(page.locator('.wall .when')).toHaveCount(0);
  await expect(page.getByText(/หมดอายุ/)).toHaveCount(0);

  // The gym's number is written the way every staff screen writes it.
  const call = page.getByRole('link', { name: /โทรหายิม/ });
  await expect(call).toBeVisible();
  await expect(call).toHaveText(/\d{3}-\d{3}-\d{3,4}/);
});
