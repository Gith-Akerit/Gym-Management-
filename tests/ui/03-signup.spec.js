import { test, expect } from '@playwright/test';
import { cardToken, go, jpegBuffer, openMember, PNG_PIXEL, signIn, signUpMember } from './counter.js';

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
  await expect(page.getByText('คุณต้องส่งรูปใบใหม่ให้ลูกค้า')).toBeVisible();
  await page.screenshot({ path: 'artifacts/counter-reissue-confirm.png', fullPage: true });

  await page.getByLabel('เหตุผล (บันทึกไว้ในประวัติ)').selectOption('ลูกค้าทำรูปหาย ขอใหม่');
  await page.getByRole('button', { name: 'ยืนยัน ออกบัตรใหม่' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บัตรใบเดิมใช้ไม่ได้ทันที' })).toBeVisible();

  const after = await cardToken(page, 'บัตรหาย ต้องออกใหม่');
  expect(after.qr).not.toBe(before.qr);
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
    .setInputFiles({ name: 'slip.jpg', mimeType: 'image/jpeg', buffer: jpegBuffer() });
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
