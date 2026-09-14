import { test, expect } from '@playwright/test';
import { PNG_PIXEL, signIn, signUpMember } from './counter.js';

// The counter screen: a card is scanned, a face comes up, and a person decides.

/** Signs somebody up, photographs them, sells them a package, keeps their card. */
async function memberWithCard(page, { name, phone }) {
  await signUpMember(page, { name, phone });
  await page.getByLabel('หรือเลือกรูปจากเครื่อง')
    .setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: PNG_PIXEL });
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกรูปถ่ายแล้ว' })).toBeVisible();
  await page.getByLabel('ค้นหาสมาชิก').fill(name);
  await page.getByRole('button', { name: `แก้ไข ${name}` }).click();
  await page.getByLabel('แพ็กเกจที่จะมอบ').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'บันทึกการชำระเงินและมอบแพ็กเกจ' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกการชำระเงินและมอบแพ็กเกจแล้ว' })).toBeVisible();

  // The token the card carries, read the way the screen reads it.
  await page.getByLabel('ค้นหาสมาชิก').fill(name);
  await page.getByRole('button', { name: `แก้ไข ${name}` }).click();
  const id = await page.getByRole('img', { name: new RegExp(`บัตรสมาชิกของ ${name}`) })
    .evaluate(img => new URL(img.src).pathname.split('/')[3]);
  const card = await (await page.request.get(`/api/members/${id}/card`)).json();
  return { id, qr: card.qr };
}

test('a card scans, the face comes up big, and the visit is counted', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await signIn(page, 'admin5@example.test');
  const member = await memberWithCard(page, { name: 'ชัยชนะ มาออกกำลัง', phone: '0893334455' });

  await page.getByRole('button', { name: 'สแกนเช็คอิน' }).click();
  await page.getByLabel('ชื่อจุดสแกน', { exact: false }).fill('เคาน์เตอร์ 1');
  await page.getByLabel('รหัสจาก QR ของสมาชิก').fill(member.qr);
  await page.getByRole('button', { name: 'ตรวจสอบ' }).click();

  const result = page.locator('.scan-result');
  await expect(result.getByRole('heading', { name: 'เข้าใช้บริการได้' })).toBeVisible();
  await expect(result.getByText('ชัยชนะ มาออกกำลัง')).toBeVisible();
  // The photograph is the check a person makes, so it is on the screen and it
  // is bigger than the verdict beside it.
  const photo = result.getByRole('img', { name: /รูปถ่ายของ ชัยชนะ/ });
  await expect(photo).toBeVisible();
  const [photoBox, headingBox] = await Promise.all([
    photo.boundingBox(),
    result.getByRole('heading', { name: 'เข้าใช้บริการได้' }).boundingBox(),
  ]);
  expect(photoBox.height).toBeGreaterThan(headingBox.height);
  await expect(result.getByText('ดูรูปเทียบกับคนตรงหน้าก่อนให้เข้า')).toBeVisible();
  await expect(result.getByRole('button', { name: 'ไม่ใช่คนนี้' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/counter-scan-allowed.png', fullPage: true });

  // The same card a moment later is the same visit, not a second one.
  await page.getByLabel('รหัสจาก QR ของสมาชิก').fill(member.qr);
  await page.getByRole('button', { name: 'ตรวจสอบ' }).click();
  await expect(result.getByRole('heading', { name: 'เช็คอินไปแล้ว' })).toBeVisible();
  await expect(result.getByText(/ไม่ได้หักสิทธิ์ซ้ำ/)).toBeVisible();

  await expect(page.getByRole('heading', { name: 'เช็คอินล่าสุด' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a cancelled card is refused, and the new one works', async ({ page }) => {
  await signIn(page, 'admin6@example.test');
  const member = await memberWithCard(page, { name: 'บัตรหาย ต้องออกใหม่', phone: '0891119911' });

  page.on('dialog', dialog => dialog.accept('บัตรหาย'));
  await page.getByRole('button', { name: 'ออกบัตรใหม่' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'ออกบัตรใหม่แล้ว' })).toBeVisible();

  await page.getByRole('button', { name: 'สแกนเช็คอิน' }).click();
  await page.getByLabel('รหัสจาก QR ของสมาชิก').fill(member.qr);
  await page.getByRole('button', { name: 'ตรวจสอบ' }).click();
  const result = page.locator('.scan-result');
  await expect(result.getByRole('heading', { name: 'เข้าใช้บริการไม่ได้' })).toBeVisible();
  await expect(result.getByText('บัตรใบนี้ถูกยกเลิกแล้ว', { exact: false })).toBeVisible();
  await page.screenshot({ path: 'artifacts/counter-scan-cancelled.png', fullPage: true });

  // The replacement opens the door.
  const fresh = await (await page.request.get(`/api/members/${member.id}/card`)).json();
  await page.getByLabel('รหัสจาก QR ของสมาชิก').fill(fresh.qr);
  await page.getByRole('button', { name: 'ตรวจสอบ' }).click();
  await expect(result.getByRole('heading', { name: 'เข้าใช้บริการได้' })).toBeVisible();
});

test('a forged code is refused and kept out of the member history', async ({ page }) => {
  await signIn(page, 'staff3-ui@example.test');
  await page.getByLabel('รหัสจาก QR ของสมาชิก').fill('GYMCARD1.deadbeefdeadbeefdeadbeefdeadbeef.1.' + 'f'.repeat(32));
  await page.getByRole('button', { name: 'ตรวจสอบ' }).click();
  const result = page.locator('.scan-result');
  await expect(result.getByRole('heading', { name: 'เข้าใช้บริการไม่ได้' })).toBeVisible();
  await expect(result.getByText('QR ไม่ถูกต้อง', { exact: false })).toBeVisible();
  await expect(page.getByText('ไม่ทราบสมาชิก').first()).toBeVisible();
});

test('the counter tablet can scan with its own camera', async ({ page }) => {
  // Chromium supplies a synthetic camera here (see playwright.config.js), so
  // this proves the permission flow and that frames really are arriving. It
  // cannot prove a QR decodes: the fake device shows a test pattern.
  await signIn(page, 'staff4-ui@example.test');
  await expect(page.getByRole('heading', { name: 'สแกนเช็คอิน' })).toBeVisible();
  const toggle = page.getByLabel('ใช้กล้องของเครื่องนี้สแกน', { exact: false });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  const video = page.getByLabel('ภาพจากกล้องสำหรับสแกน QR');
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate(el => el.videoWidth), { timeout: 15000 }).toBeGreaterThan(0);
  await page.screenshot({ path: 'artifacts/counter-camera.png', fullPage: true });
});
