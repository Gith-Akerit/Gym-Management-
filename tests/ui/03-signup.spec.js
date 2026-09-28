import { test, expect } from '@playwright/test';
import { cardToken, go, jpegBuffer, openMember, PHOTO_JPEG, PNG_PIXEL, signIn, signUpMember } from './counter.js';

// Signing somebody up at the counter, in three steps, and handing them a card.
// Runs after 02-settings, which is what put a package on sale.

const MONTHLY = /รายเดือน Unlimited/;

test('the three steps go in order and the photograph comes first', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await signIn(page, 'admin3@example.test');
  await go(page, 'สมัครสมาชิก');

  // One subject per step, because the person at the desk is often new and has
  // a customer in front of them.
  await expect(page.getByRole('heading', { name: 'ถ่ายรูปลูกค้า' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'เปิดกล้องถ่ายรูป' })).toBeVisible();
  await expect(page.getByLabel('ชื่อ–นามสกุล')).toHaveCount(0);
  await page.getByLabel('เลือกรูปจากเครื่องแทน')
    .setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: PNG_PIXEL });
  await page.getByRole('button', { name: 'ถัดไป · ชื่อและเบอร์' }).click();

  await expect(page.getByText('รูปถ่ายเรียบร้อย')).toBeVisible();
  // Nothing can be skipped forward: a name and a phone are what the card and
  // the phone call at renewal time both need.
  const next = page.getByRole('button', { name: 'ถัดไป · แพ็กเกจและเงิน' });
  await expect(next).toBeDisabled();
  await page.getByLabel('ชื่อ–นามสกุล').fill('ประกายแก้ว เจริญรุ่ง');
  await page.getByLabel('เบอร์มือถือ').fill('0897778811');
  // No email is asked for and none is given: a walk-in has nothing to sign in
  // to, so inventing an address to get past a required field is inventing data.
  await expect(page.getByLabel('อีเมล (ไม่บังคับ)')).toHaveValue('');
  await expect(next).toBeEnabled();
  await next.click();

  // สิ่งที่ลูกค้าถามก่อนจ่ายเงินอยู่ตรงหน้าคนขาย ไม่ใช่แค่ชื่อกับราคา
  // (ผลทดสอบของผู้ใช้ ข้อ 4 · เจ้าของยิมกรอกไว้ใน 02-settings)
  await expect(page.getByText('เพื่อนมาด้วยได้เดือนละ 1 ครั้ง')).toBeVisible();
  await page.getByRole('radio', { name: MONTHLY }).check();
  await expect(page.getByText('รวมที่ต้องเก็บ')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'เงินสด' })).toBeChecked();
  await page.getByRole('button', { name: 'บันทึกและออกบัตร' }).click();

  // And the card is on the screen of whoever is going to send it.
  await expect(page.getByRole('heading', { name: 'บัตรสมาชิก' })).toBeVisible();
  const card = page.getByRole('img', { name: 'บัตรสมาชิกของ ประกายแก้ว เจริญรุ่ง' });
  await expect.poll(() => card.evaluate(img => img.naturalWidth)).toBe(1080);
  await expect.poll(() => card.evaluate(img => img.naturalHeight)).toBe(1350);
  await expect(page.getByRole('link', { name: 'บันทึกรูปบัตร' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/counter-member-card.png', fullPage: true });

  expect(errors).toEqual([]);
});

test('"ส่งบัตรซ้ำ" hands over a seven-day link to the same card', async ({ page }) => {
  await signIn(page, 'admin3@example.test');
  await openMember(page, 'ประกายแก้ว เจริญรุ่ง');

  await page.getByRole('button', { name: 'ส่งบัตรซ้ำ (ลิงก์ 7 วัน)' }).click();
  const box = page.getByLabel('ลิงก์บัตร');
  await expect(box).toBeVisible();
  await expect(page.getByText('เป็นบัตรใบเดิม ไม่ใช่ใบใหม่', { exact: false })).toBeVisible();

  // It really downloads a card, to a browser that has never signed in.
  const url = await box.inputValue();
  const opened = await page.request.get(url, { headers: {} });
  expect(opened.status()).toBe(200);
  expect(opened.headers()['content-type']).toBe('image/png');
});

test('"ออกบัตรใหม่" is behind a menu and a page that spells out the cost', async ({ page }) => {
  await signIn(page, 'admin6@example.test');
  await signUpMember(page, { name: 'บัตรหาย ต้องออกใหม่', phone: '0891119911', pkg: MONTHLY });
  const before = await cardToken(page, 'บัตรหาย ต้องออกใหม่');

  // Not a button on a busy counter's screen: it throws away a card somebody is
  // already carrying.
  await expect(page.getByRole('button', { name: 'ออกบัตรใหม่', exact: true })).toBeHidden();
  await page.getByText('เมนูเพิ่มเติม').click();
  await page.getByRole('button', { name: 'ออกบัตรใหม่', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'ออกบัตรใหม่ให้ บัตรหาย ต้องออกใหม่' })).toBeVisible();
  await expect(page.getByText('บัตรใบเดิมจะสแกนไม่ผ่านอีกเลย')).toBeVisible();
  // Both halves are listed, because the owner is throwing away both: staff can
  // type the code on a card, so a reissue that kept it would not be a reissue.
  await expect(page.getByText('รหัสสมาชิกจะเปลี่ยนเป็นรหัสใหม่ด้วย')).toBeVisible();
  await expect(page.getByText('คุณต้องส่งรูปใบใหม่ให้ลูกค้า')).toBeVisible();
  await page.screenshot({ path: 'artifacts/counter-reissue-confirm.png', fullPage: true });

  await page.getByLabel('เหตุผล (บันทึกไว้ในประวัติ)').selectOption('ลูกค้าทำรูปหาย ขอใหม่');
  await page.getByRole('button', { name: 'ยืนยัน ออกบัตรใหม่' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บัตรใบเดิมใช้ไม่ได้ทันที' })).toBeVisible();

  const after = await cardToken(page, 'บัตรหาย ต้องออกใหม่');
  expect(after.qr).not.toBe(before.qr);
  expect(after.code).not.toBe(before.code);
  // And the screen is showing the new code, not the one on the card it just
  // cancelled -- it is what staff read out to a customer standing there.
  await expect(page.getByText(after.code)).toBeVisible();
});

test('a transfer carries the slip, and a free grant needs a reason', async ({ page }) => {
  await signIn(page, 'admin4@example.test');
  await signUpMember(page, { name: 'อารี โอนเงิน', phone: '0896665511' });

  await go(page, 'รับเงินและมอบแพ็กเกจ');
  await page.getByLabel('ค้นหาสมาชิก').fill('อารี โอนเงิน');
  await page.getByRole('button', { name: 'เปิดสมาชิก อารี โอนเงิน' }).click();

  await page.getByRole('radio', { name: MONTHLY }).check();
  await page.getByRole('radio', { name: 'โอนเข้าบัญชี' }).check();
  await page.getByLabel('แนบรูปสลิป (ไม่บังคับ)')
    .setInputFiles({ name: 'slip.jpg', mimeType: 'image/jpeg', buffer: PHOTO_JPEG });
  // The panel the Designer asked for: what the member has now, and what they
  // will have after the button is pressed.
  await expect(page.getByText('หมดอายุเดิม')).toBeVisible();
  await expect(page.getByText('หมดอายุใหม่')).toBeVisible();
  await page.screenshot({ path: 'artifacts/counter-payment.png', fullPage: true });
  await page.getByRole('button', { name: 'บันทึกและมอบแพ็กเกจ' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกการชำระเงินและมอบแพ็กเกจแล้ว' })).toBeVisible();

  // Giving one away is a different thing, and has to be written down.
  await page.getByLabel('ค้นหาสมาชิก').fill('อารี โอนเงิน');
  await page.getByRole('button', { name: 'เปิดสมาชิก อารี โอนเงิน' }).click();
  await page.getByRole('radio', { name: MONTHLY }).check();
  await page.getByRole('radio', { name: 'ไม่ได้รับเงิน (แถมให้)' }).check();
  const save = page.getByRole('button', { name: 'บันทึกและมอบแพ็กเกจ' });
  await expect(save).toBeDisabled();
  await page.getByLabel('เหตุผล (บันทึกไว้ในประวัติ)').fill('ทดลองใช้ 1 เดือน');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole('status').filter({ hasText: 'มอบแพ็กเกจแล้ว' })).toBeVisible();
});

test('staff sign members up too, but only the owner can cancel a card', async ({ page }) => {
  await signIn(page, 'staff2-ui@example.test');
  await expect(page.locator('.scanstage')).toBeVisible();
  await signUpMember(page, { name: 'พนักงาน สมัครให้', phone: '0892224466' });
  await expect(page.getByRole('button', { name: 'ส่งบัตรซ้ำ (ลิงก์ 7 วัน)' })).toBeVisible();
  await expect(page.getByText('เมนูเพิ่มเติม')).toHaveCount(0);
});

test('a photograph that will not open is refused while the member is still there', async ({ page }) => {
  await signIn(page, 'admin8@example.test');
  await go(page, 'สมัครสมาชิก');
  // Perfect JPEG header, nothing behind it: an upload cut off halfway, which
  // used to be accepted and then made the card unobtainable for ever.
  await page.getByLabel('เลือกรูปจากเครื่องแทน')
    .setInputFiles({ name: 'half-sent.jpg', mimeType: 'image/jpeg', buffer: jpegBuffer() });
  await page.getByRole('button', { name: 'ถัดไป · ชื่อและเบอร์' }).click();
  await page.getByLabel('ชื่อ–นามสกุล').fill('เน็ตหลุด กลางคัน');
  await page.getByLabel('เบอร์มือถือ').fill('0894447722');
  await page.getByRole('button', { name: 'ถัดไป · แพ็กเกจและเงิน' }).click();
  await page.getByRole('button', { name: 'บันทึกและออกบัตร' }).click();

  // Told here, at the desk, where taking another picture is one tap away.
  await expect(page.getByRole('alert').first()).toContainText('ถ่ายใหม่');
  await page.getByRole('button', { name: 'ถ่ายรูปใหม่' }).click();
  await page.getByLabel('เลือกรูปจากเครื่องแทน')
    .setInputFiles({ name: 'face.jpg', mimeType: 'image/jpeg', buffer: PHOTO_JPEG });
  await page.getByRole('button', { name: 'ถัดไป · ชื่อและเบอร์' }).click();
  await page.getByRole('button', { name: 'ถัดไป · แพ็กเกจและเงิน' }).click();
  await page.getByRole('button', { name: 'บันทึกและออกบัตร' }).click();
  await expect(page.getByRole('heading', { name: 'บัตรสมาชิก' })).toBeVisible();
});

test('a photograph that goes bad later says so on the card screen, and can be replaced', async ({ page }) => {
  await signIn(page, 'admin9@example.test');
  await signUpMember(page, { name: 'รูปเสียทีหลัง', phone: '0894448833' });
  const { id } = await cardToken(page, 'รูปเสียทีหลัง');

  // The bytes go bad on the disk after the fact -- a half-written file, a
  // restore taken mid-write. Nothing in the app can do this any more.
  await page.request.post('/__test/break-photo', { data: { member_id: id } });
  await go(page, 'สมาชิก');
  await page.getByRole('button', { name: 'เปิดสมาชิก รูปเสียทีหลัง' }).click();

  // The card still comes out -- with the silhouette -- and the screen in front
  // of the person who can fix it is the one that says why.
  await expect(page.getByRole('alert')).toContainText('รูปถ่ายของสมาชิกรายนี้ใช้ไม่ได้ กรุณาถ่ายใหม่');
  const card = page.getByRole('img', { name: 'บัตรสมาชิกของ รูปเสียทีหลัง' });
  await expect.poll(() => card.evaluate(img => img.naturalWidth)).toBe(1080);
  await page.screenshot({ path: 'artifacts/counter-photo-broken.png', fullPage: true });

  // And the way to fix it is on the same screen, already open.
  await page.getByLabel('เลือกรูปจากเครื่องแทน').last()
    .setInputFiles({ name: 'again.jpg', mimeType: 'image/jpeg', buffer: PHOTO_JPEG });
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกรูปถ่ายใหม่แล้ว' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  // No new card: the QR is over the member, not over the picture.
  await expect(page.getByText('ครั้งที่')).toBeVisible();
  await expect(page.locator('.soft .row', { hasText: 'ครั้งที่' })).toContainText('1');
});

test('the slip a member of staff attached is on that member own screen', async ({ page }) => {
  // The queue screen that used to hold these is gone: it was a list of slips
  // members uploaded themselves, and there is no member app left to upload one.
  await signIn(page, 'admin4@example.test');
  await expect(page.getByRole('link', { name: 'ตรวจสลิป' })).toHaveCount(0);

  await openMember(page, 'อารี โอนเงิน');
  await expect(page.getByRole('heading', { name: 'ประวัติการรับเงิน' })).toBeVisible();
  // Two payments from the earlier test: the transfer with a slip, and the one
  // given away. Both say who recorded them.
  await expect(page.getByText('admin4@example.test').first()).toBeVisible();
  await expect(page.getByText('โอนเข้าบัญชี')).toBeVisible();
  await expect(page.getByText('ไม่ได้รับเงิน (แถมให้)')).toBeVisible();

  await page.getByRole('button', { name: /^ดูสลิปของ/ }).click();
  const slip = page.getByRole('img', { name: /^สลิปของ/ });
  await expect(slip).toBeVisible();
  await expect(slip).toHaveAttribute('src', /\/api\/slips\/[0-9a-f-]{36}\/image/);
  await expect(page.getByText('กดที่รูปเพื่อเปิดขนาดเต็ม')).toBeVisible();
  await page.screenshot({ path: 'artifacts/counter-payment-history.png', fullPage: true });
});
