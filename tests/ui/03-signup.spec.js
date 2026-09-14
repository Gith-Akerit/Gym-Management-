import { test, expect } from '@playwright/test';
import { jpegBuffer, PNG_PIXEL, signIn, signUpMember } from './counter.js';

// Signing somebody up at the counter, from an empty form to a card the gym can
// send them. Runs after 02-settings, which is what put a package on sale.

test('a walk-in is signed up, photographed, sold a package and handed a card', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await signIn(page, 'admin3@example.test');

  await signUpMember(page, { name: 'ประกายแก้ว เจริญรุ่ง', phone: '0897778811' });
  // No email was asked for and none was given: a walk-in has nothing to sign
  // in to, so inventing an address for them would be inventing data.
  await expect(page.getByLabel('อีเมล (ไม่บังคับ)')).toHaveValue('');

  // --- the photograph --------------------------------------------------------
  await expect(page.getByRole('heading', { name: 'รูปถ่ายสมาชิก' })).toBeVisible();
  await expect(page.getByRole('img', { name: /รูปถ่ายของ/ })).toHaveCount(0);
  await page.getByLabel('หรือเลือกรูปจากเครื่อง')
    .setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: PNG_PIXEL });
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกรูปถ่ายแล้ว' })).toBeVisible();
  await page.getByLabel('ค้นหาสมาชิก').fill('ประกายแก้ว');
  await page.getByRole('button', { name: 'แก้ไข ประกายแก้ว เจริญรุ่ง' }).click();
  await expect(page.getByRole('img', { name: /รูปถ่ายของ ประกายแก้ว/ })).toBeVisible();
  // The camera is offered beside it; a counter computer without one still works.
  await expect(page.getByRole('button', { name: 'เปิดกล้องถ่ายรูป' })).toBeVisible();

  // --- the card --------------------------------------------------------------
  const card = page.getByRole('img', { name: /บัตรสมาชิกของ ประกายแก้ว/ });
  await expect(card).toBeVisible();
  await expect.poll(() => card.evaluate(img => img.naturalWidth)).toBe(1080);
  await expect.poll(() => card.evaluate(img => img.naturalHeight)).toBe(1350);
  await expect(page.getByText('บัตรใบที่ 1')).toBeVisible();
  await expect(page.getByRole('link', { name: 'ดาวน์โหลดบัตร' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/counter-member-card.png', fullPage: true });

  // --- the money -------------------------------------------------------------
  await page.getByLabel('แพ็กเกจที่จะมอบ').selectOption({ index: 1 });
  await expect(page.getByLabel('วิธีชำระเงิน')).toHaveValue('cash');
  await page.getByRole('button', { name: 'บันทึกการชำระเงินและมอบแพ็กเกจ' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกการชำระเงินและมอบแพ็กเกจแล้ว' })).toBeVisible();

  expect(errors).toEqual([]);
});

test('a transfer can carry the slip photo, and a free grant needs a reason', async ({ page }) => {
  await signIn(page, 'admin4@example.test');
  await signUpMember(page, { name: 'อารี โอนเงิน', phone: '0896665511' });

  await page.getByLabel('แพ็กเกจที่จะมอบ').selectOption({ index: 1 });
  await page.getByLabel('วิธีชำระเงิน').selectOption('transfer');
  await page.getByLabel('เลขอ้างอิงในสลิป (ถ้ามี)').fill('REF-COUNTER-01');
  await page.getByLabel('รูปสลิป', { exact: false })
    .setInputFiles({ name: 'slip.jpg', mimeType: 'image/jpeg', buffer: jpegBuffer() });
  await page.getByRole('button', { name: 'บันทึกการชำระเงินและมอบแพ็กเกจ' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกการชำระเงินและมอบแพ็กเกจแล้ว' })).toBeVisible();

  // Giving one away is a different thing and has to be written down.
  await page.getByLabel('ค้นหาสมาชิก').fill('อารี โอนเงิน');
  await page.getByRole('button', { name: 'แก้ไข อารี โอนเงิน' }).click();
  await page.getByLabel('แพ็กเกจที่จะมอบ').selectOption({ index: 1 });
  await page.getByLabel('วิธีชำระเงิน').selectOption('none');
  const give = page.getByRole('button', { name: 'มอบแพ็กเกจให้สมาชิกรายนี้' });
  await expect(give).toBeDisabled();
  await page.getByLabel('เหตุผล (บันทึกไว้ในประวัติ)').fill('ทดลองใช้ 1 เดือน');
  await expect(give).toBeEnabled();
  await give.click();
  await expect(page.getByRole('status').filter({ hasText: 'มอบแพ็กเกจแล้ว' })).toBeVisible();
});

test('staff sign members up too, but only the owner can cancel a card', async ({ page }) => {
  await signIn(page, 'staff2-ui@example.test');
  await expect(page.getByRole('heading', { name: 'สแกนเช็คอิน' })).toBeVisible();
  await signUpMember(page, { name: 'พนักงาน สมัครให้', phone: '0892224466' });
  await expect(page.getByRole('img', { name: /บัตรสมาชิกของ/ })).toBeVisible();
  // Reissuing throws away a card somebody is already carrying, so it is not a
  // button on a busy counter's screen.
  await expect(page.getByRole('button', { name: 'ออกบัตรใหม่' })).toHaveCount(0);
});
