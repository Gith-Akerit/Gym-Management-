import { test, expect } from '@playwright/test';
import { go, openUserMenu, PASSWORD, signIn } from './counter.js';

// Turning email on, and the two things that stand in for it until somebody
// does.
//
// The gym's mailbox password is typed in here by the owner and never leaves
// again -- so the proof that it works cannot be a green tick on a form, it has
// to be a letter that actually arrives. And while the mailbox is empty, the
// counter still has to be able to hand a new member of staff a way in.

const OWNER = 'mail-admin@example.test';

test('the owner fills in the gym mailbox and proves it works by sending a letter', async ({ page }) => {
  await signIn(page, OWNER);
  await go(page, 'ตั้งค่ายิม');
  // A tab on the settings page, not an eighth entry in the menu -- and the dot
  // on it says there is something unfinished behind it before it is opened.
  await expect(page.locator('.settabs .dotwarn')).toBeVisible();
  await page.getByRole('link', { name: /อีเมลของระบบ/ }).click();

  // Said plainly before anything is typed: nothing is broken, letters just do
  // not go out, and here is what to do in the meantime -- as consequences,
  // because "not configured yet" does not tell anybody their customers are
  // not getting their cards.
  await expect(page.getByText('ระบบยังส่งอีเมลไม่ได้')).toBeVisible();
  await expect(page.getByText(/ไม่ได้รับ/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'ส่งเมลทดสอบ' })).toBeDisabled();
  await page.screenshot({ path: 'artifacts/mail-settings-empty-1280.png', fullPage: true });

  // Office 365 out of the box, because that is what this gym has.
  await expect(page.getByLabel('เซิร์ฟเวอร์อีเมล (SMTP)')).toHaveValue('smtp.office365.com');
  await expect(page.getByLabel('พอร์ต')).toHaveValue('587');

  await page.getByLabel('ชื่อผู้ใช้ (อีเมลที่ใช้ล็อกอินกล่องนี้)').fill('info@suklutai.co.th');
  await page.getByLabel('อีเมลผู้ส่ง').fill('info@suklutai.co.th');
  await page.getByRole('button', { name: 'กรอกรหัสผ่าน' }).click();
  await page.getByLabel('รหัสผ่านของกล่องจดหมาย').fill('app-password-from-the-owner');
  // "ดูรหัส" exists only while it is being typed. After it is saved there is
  // no way to read it back, here or anywhere else.
  await expect(page.getByRole('button', { name: 'ดูรหัส' })).toBeVisible();
  await page.getByRole('button', { name: 'บันทึกการตั้งค่าอีเมล' }).click();

  await expect(page.getByText('ระบบส่งอีเมลได้', { exact: false }).first()).toBeVisible();
  // A label and a button, never an input holding fake dots -- an input with a
  // value in it invites a save-over by accident.
  await expect(page.getByText('✓ ตั้งค่าไว้แล้ว')).toBeVisible();
  await expect(page.getByLabel('รหัสผ่านของกล่องจดหมาย')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ดูรหัส' })).toHaveCount(0);
  await expect(page.locator('.settabs .dotwarn')).toHaveCount(0);

  await page.getByRole('button', { name: 'ส่งเมลทดสอบ' }).click();
  await expect(page.getByText('ส่งเมลทดสอบแล้ว')).toBeVisible();
  // To whoever pressed it, never to an address typed into a box.
  const letters = await (await page.request.get(`/__test/outbox?to=${OWNER}`)).json();
  expect(letters.items.length).toBeGreaterThan(0);
  expect(letters.items[0].subject).toMatch(/ทดสอบการส่งอีเมล/);
  await page.screenshot({ path: 'artifacts/mail-settings-ready-1280.png', fullPage: true });

  // The one thing that costs a day if nobody says it.
  await expect(page.getByText(/Authenticated SMTP/).first()).toBeVisible();
});

test('staff are told whether it works and are shown nothing else', async ({ page }) => {
  await signIn(page, 'mail-staff@example.test');
  await openUserMenu(page);
  // Not an entry in the menu for anybody any more.
  await expect(page.getByRole('menuitem', { name: 'ตั้งค่าอีเมล' })).toHaveCount(0);
  // But they do get the one row everybody gets.
  await expect(page.getByRole('menuitem', { name: 'เปลี่ยนรหัสผ่าน' })).toBeVisible();
  await page.keyboard.press('Escape');

  await go(page, 'ตั้งค่ายิม');
  await page.getByRole('link', { name: /อีเมลของระบบ/ }).click();
  // One sentence, because "do customers get their card by email?" is a
  // question staff get asked at the counter. No host, no username, and no
  // hint about the mailbox the gym signs in with (Designer, screen 8).
  await expect(page.getByText(/ระบบส่งอีเมลได้ตามปกติ|ระบบยังส่งอีเมลไม่ได้/)).toBeVisible();
  await expect(page.getByLabel('ชื่อผู้ใช้ (อีเมลที่ใช้ล็อกอินกล่องนี้)')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ส่งเมลทดสอบ' })).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/mail-settings-staff-1280.png', fullPage: true });
});

test('the owner hands a new member of staff a link instead of a password', async ({ page }) => {
  await signIn(page, OWNER);
  await go(page, 'ผู้ใช้และสิทธิ์');
  await page.getByLabel('อีเมล', { exact: true }).fill('linkstaff@example.test');
  await page.getByRole('button', { name: 'สร้างบัญชี' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'สร้างบัญชีแล้ว' })).toBeVisible();

  await page.getByLabel('ค้นหาบัญชี').fill('linkstaff@example.test');
  const row = page.locator('.utable tbody tr').filter({ hasText: 'linkstaff@example.test' });
  await row.getByRole('button', { name: /^สร้างลิงก์ตั้งรหัสผ่านของ/ }).click();

  await expect(page.getByRole('heading', { name: /^ลิงก์ตั้งรหัสผ่านของ/ })).toBeVisible();
  const link = await page.getByLabel('ลิงก์', { exact: true }).inputValue();
  expect(link).toMatch(/\?setpw=[A-Za-z0-9_-]{43}$/);
  await expect(page.getByText(/อย่าโพสต์ลงกลุ่ม/)).toBeVisible();
  await page.screenshot({ path: 'artifacts/password-link-1280.png', fullPage: true });

  // Handed over and used, by the person it belongs to, on their own machine.
  await page.context().clearCookies();
  await page.goto(new URL(link).pathname + new URL(link).search);
  await page.getByLabel('รหัสผ่านใหม่').fill(PASSWORD);
  await page.getByLabel('พิมพ์รหัสผ่านอีกครั้ง').fill(PASSWORD);
  await page.getByRole('button', { name: 'บันทึกรหัสผ่าน' }).click();
  await expect(page.getByRole('heading', { name: 'ตั้งรหัสผ่านใหม่แล้ว' })).toBeVisible();

  await signIn(page, 'linkstaff@example.test');
  await expect(page.getByRole('button', { name: 'เมนู', exact: true })).toBeVisible();
});

test('anybody can change their own password from the menu, including on the scan stage', async ({ page }) => {
  await signIn(page, 'changepw-staff@example.test');
  // The scan stage is where a shift is actually spent, so the menu is there
  // too -- and so is this.
  await expect(page.locator('.scanstage')).toBeVisible();
  await openUserMenu(page);
  await page.getByRole('menuitem', { name: 'เปลี่ยนรหัสผ่าน' }).click();

  const box = page.getByRole('dialog', { name: 'เปลี่ยนรหัสผ่าน' });
  await expect(box).toBeVisible();
  await expect(box.getByText(/เครื่องอื่นที่เข้าไว้จะถูกออกจากระบบ/)).toBeVisible();
  await page.screenshot({ path: 'artifacts/change-password-1280.png', fullPage: true });

  // The old one is required, and a wrong one is refused out loud: the session
  // is exactly what an unattended tablet hands to a stranger.
  await box.getByLabel('รหัสผ่านเดิม').fill('not-the-password');
  await box.getByLabel('รหัสผ่านใหม่', { exact: true }).fill('a-brand-new-password');
  await box.getByLabel('พิมพ์รหัสผ่านใหม่อีกครั้ง').fill('a-brand-new-password');
  await box.getByRole('button', { name: 'บันทึกรหัสผ่านใหม่' }).click();
  await expect(box.getByRole('alert')).toContainText('รหัสผ่านเดิมไม่ถูกต้อง');

  await box.getByLabel('รหัสผ่านเดิม').fill(PASSWORD);
  await box.getByRole('button', { name: 'บันทึกรหัสผ่านใหม่' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // And the tablet in the hand of the person who did the right thing is not
  // signed out for their trouble.
  await expect(page.getByRole('button', { name: 'เมนู', exact: true })).toBeVisible();
  await page.context().clearCookies();
  await signIn(page, 'changepw-staff@example.test', 'a-brand-new-password');
  await expect(page.getByRole('button', { name: 'เมนู', exact: true })).toBeVisible();
});

test('a member who gives an address gets their card, and the counter is told', async ({ page }) => {
  await signIn(page, OWNER);
  await go(page, 'ตั้งค่ายิม');           // any screen; the point is being signed in
  await go(page, 'สมัครสมาชิก');

  await page.getByLabel('เลือกรูปจากเครื่องแทน')
    .setInputFiles({ name: 'face.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
  await page.getByRole('button', { name: 'ถัดไป · ชื่อและเบอร์' }).click();
  await page.getByLabel('ชื่อ–นามสกุล').fill('QA-TEST มีอีเมล');
  await page.getByLabel('เบอร์มือถือ').fill('0899000456');
  // Says why anybody would fill it in, where somebody filling it in can read it.
  await expect(page.getByText(/ระบบส่งบัตรสมาชิกไปให้เขาทางอีเมลเลย/)).toBeVisible();
  await page.getByLabel('อีเมล (ไม่บังคับ)').fill('newmember@example.test');
  await page.getByRole('button', { name: 'ถัดไป · แพ็กเกจและเงิน' }).click();
  await page.getByRole('button', { name: 'บันทึกและออกบัตร' }).click();
  await expect(page.getByRole('heading', { name: 'บัตรสมาชิก' })).toBeVisible();

  // The card itself is attached, not an image in the body: a mail client that
  // blocks remote images must not turn a member's card into an empty box.
  await expect.poll(async () => {
    const letters = await (await page.request.get('/__test/outbox?to=newmember@example.test')).json();
    return letters.items.length;
  }, { message: 'สมาชิกที่กรอกอีเมลต้องได้รับบัตรทางอีเมล' }).toBeGreaterThan(0);
  const letters = await (await page.request.get('/__test/outbox?to=newmember@example.test')).json();
  expect(letters.items[0].subject).toMatch(/บัตรสมาชิก/);
  expect(letters.items[0].attachments[0].contentType).toBe('image/png');

  // And the card screen offers to send it again, because the address is on
  // the member. (Which of the two labels it carries depends on whether the
  // letter that went out at the end of the wizard has landed in the row yet;
  // what matters is that the button is there at all.)
  await expect(page.getByRole('button', { name: /ส่งบัตรทางอีเมล/ })).toBeVisible();
  await page.screenshot({ path: 'artifacts/member-card-email-1280.png', fullPage: true });
});

test('a mail server refusal is translated into steps the owner can follow', async ({ page }) => {
  await signIn(page, 'diag-admin@example.test');
  await go(page, 'ตั้งค่ายิม');
  await page.getByRole('link', { name: /อีเมลของระบบ/ }).click();
  await page.getByLabel('ชื่อผู้ใช้ (อีเมลที่ใช้ล็อกอินกล่องนี้)').fill('info@suklutai.co.th');
  await page.getByLabel('อีเมลผู้ส่ง').fill('info@suklutai.co.th');
  // The spec files share one server, so by now a mailbox may already be saved
  // and the button reads "แทนที่รหัส" rather than "กรอกรหัสผ่าน".
  await page.getByRole('button', { name: /กรอกรหัสผ่าน|แทนที่รหัส/ }).click();
  await page.getByLabel('รหัสผ่านของกล่องจดหมาย').fill('whatever-they-typed');
  await page.getByRole('button', { name: 'บันทึกการตั้งค่าอีเมล' }).click();
  await expect(page.getByText('ระบบส่งอีเมลได้', { exact: false }).first()).toBeVisible();

  // The one that costs an afternoon if it is read as a wrong password. The
  // first sentence has to say so out loud.
  await page.request.post('/__test/refuse-mail', {
    headers: { 'X-Gym-Client': 'web' },
    data: { reason: 'smtp_disabled', message: 'กล่องนี้ยังไม่ได้เปิดให้โปรแกรมส่งเมลแทน',
      raw: '535 5.7.139 SmtpClientAuthentication is disabled for the Mailbox' },
  });
  await page.getByRole('button', { name: 'ส่งเมลทดสอบ' }).click();
  await expect(page.getByText('กล่องนี้ยังไม่ได้เปิดให้โปรแกรมส่งเมลแทน').first()).toBeVisible();
  await expect(page.getByText('นี่ไม่ใช่รหัสผ่านผิด')).toBeVisible();
  // The step everybody skips, and the reason they conclude the system is broken.
  await expect(page.getByText(/รอ 10–15 นาที/)).toBeVisible();
  await expect(page.locator('.mpath span').filter({ hasText: 'Manage email apps' })).toBeVisible();
  // The raw text exists, and it is folded away rather than thrown at them.
  const raw = page.locator('details.raw');
  await expect(raw).toBeVisible();
  await expect(raw.locator('pre')).toBeHidden();
  await expect(page.locator('.settabs .dotbad')).toBeVisible();
  await page.screenshot({ path: 'artifacts/mail-diag-smtp-disabled-1280.png', fullPage: true });

  // A different refusal gives different instructions, not the same red box.
  await page.request.post('/__test/refuse-mail', {
    headers: { 'X-Gym-Client': 'web' },
    data: { reason: 'password', message: 'Microsoft ไม่รับรหัสผ่านนี้', raw: '535 5.7.3 Authentication unsuccessful' },
  });
  await page.getByRole('button', { name: 'ส่งเมลทดสอบ' }).click();
  await expect(page.getByText('Microsoft ไม่รับรหัสผ่านนี้').first()).toBeVisible();
  await expect(page.locator('.mpath span').filter({ hasText: 'myaccount.microsoft.com' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/mail-diag-password-1280.png', fullPage: true });

  // A server that will not encrypt. This one reached the server and not the
  // screen: the branch was added to explainFailure and the screen's table was
  // not touched, so a real answer fell through to "cause unknown" -- the exact
  // thing the branch existed to stop. Nothing on the API side could see it,
  // because the API side was right (QA).
  await page.request.post('/__test/refuse-mail', {
    headers: { 'X-Gym-Client': 'web' },
    data: { reason: 'no_tls', message: 'เซิร์ฟเวอร์นี้ไม่รองรับการเข้ารหัส',
      raw: '500 5.5.1 STARTTLS not supported' },
  });
  await page.getByRole('button', { name: 'ส่งเมลทดสอบ' }).click();
  await expect(page.getByText('เซิร์ฟเวอร์นี้ไม่รองรับการเข้ารหัส').first()).toBeVisible();
  // The two things the owner can actually check, and the reason the system
  // refused rather than sending -- which is the part that stops them from
  // "fixing" it by turning encryption off somewhere.
  await expect(page.locator('.mpath span').filter({ hasText: 'smtp.office365.com' })).toBeVisible();
  await expect(page.locator('.mpath span').filter({ hasText: 'พอร์ต 587' })).toBeVisible();
  await expect(page.getByText(/ไม่ส่งรหัสผ่านของกล่องจดหมายออกไปเลย/)).toBeVisible();
  await expect(page.getByText('ส่งไม่สำเร็จ และยังไม่ทราบสาเหตุ')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/mail-diag-no-tls-1280.png', fullPage: true });

  // And one nobody anticipated still lands on a screen that says what to do.
  await page.request.post('/__test/refuse-mail', {
    headers: { 'X-Gym-Client': 'web' },
    data: { reason: 'something-new', message: 'ส่งไม่สำเร็จ', raw: 'who knows' },
  });
  await page.getByRole('button', { name: 'ส่งเมลทดสอบ' }).click();
  await expect(page.getByText('ส่งไม่สำเร็จ และยังไม่ทราบสาเหตุ').first()).toBeVisible();
  await expect(page.getByText(/กดแจ้งปัญหา/).first()).toBeVisible();
});

test('the sender that Microsoft would refuse is caught before anything is sent', async ({ page }) => {
  await signIn(page, 'diag-admin@example.test');
  await go(page, 'ตั้งค่ายิม');
  await page.getByRole('link', { name: /อีเมลของระบบ/ }).click();
  await page.getByLabel('ชื่อผู้ใช้ (อีเมลที่ใช้ล็อกอินกล่องนี้)').fill('info@suklutai.co.th');
  await page.getByLabel('อีเมลผู้ส่ง').fill('someone-else@suklutai.co.th');

  // Microsoft answers this with a message that reads exactly like a wrong
  // password, so the screen says it plainly before a letter is ever sent.
  await expect(page.getByText('อีเมลผู้ส่งไม่ตรงกับชื่อผู้ใช้')).toBeVisible();
  await expect(page.getByRole('button', { name: 'บันทึกการตั้งค่าอีเมล' })).toBeDisabled();
});
