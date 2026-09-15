import { test, expect } from '@playwright/test';
import { cardToken, go, scan, signIn, signUpMember } from './counter.js';

// The counter screen: a card is scanned, a face comes up, and a person decides.
// Four states, one stage, nothing else on it (Designer, แบบ 2).

const MONTHLY = /รายเดือน Unlimited/;

test('a card scans, the face comes up big, and the visit is counted', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await signIn(page, 'admin5@example.test');
  await signUpMember(page, { name: 'ชัยชนะ มาออกกำลัง', phone: '0893334455', pkg: MONTHLY });
  const member = await cardToken(page, 'ชัยชนะ มาออกกำลัง');

  await scan(page, member.qr, { device: 'เคาน์เตอร์ 1' });
  const result = page.locator('.result');
  await expect(result).toContainText('เข้าใช้บริการได้');
  await expect(result).toContainText('ชัยชนะ มาออกกำลัง');

  // The photograph is the check a person makes, so it is on the screen and it
  // is bigger than the words beside it.
  const photo = result.getByRole('img', { name: 'รูปถ่ายของ ชัยชนะ มาออกกำลัง' });
  await expect(photo).toBeVisible();
  const [face, verdict] = await Promise.all([photo.boundingBox(), result.locator('.rv').boundingBox()]);
  expect(face.height).toBeGreaterThan(verdict.height);
  await expect(page.getByText('ดูรูปเทียบกับคนตรงหน้าก่อนให้เข้า')).toBeVisible();
  await expect(page.getByRole('button', { name: 'ไม่ใช่คนนี้' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/counter-scan-allowed.png', fullPage: true });

  // The same card a moment later is the same visit, not a second one.
  await page.getByRole('button', { name: 'ยืนยันให้เข้า · สแกนคนถัดไป' }).click();
  await scan(page, member.qr);
  await expect(result).toContainText('เช็คอินไปแล้ว');
  await expect(result).toContainText('ไม่ได้หักสิทธิ์ซ้ำ');
  expect(errors).toEqual([]);
});

test('a cancelled card is refused, told apart, and the new one works', async ({ page }) => {
  await signIn(page, 'admin7@example.test');
  await signUpMember(page, { name: 'ยกเลิก แล้วออกใหม่', phone: '0891113311', pkg: MONTHLY });
  const old = await cardToken(page, 'ยกเลิก แล้วออกใหม่');

  await page.getByText('เมนูเพิ่มเติม').click();
  await page.getByRole('button', { name: 'ออกบัตรใหม่', exact: true }).click();
  await page.getByRole('button', { name: 'ยืนยัน ออกบัตรใหม่' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บัตรใบเดิมใช้ไม่ได้ทันที' })).toBeVisible();
  const fresh = await cardToken(page, 'ยกเลิก แล้วออกใหม่');

  await scan(page, old.qr);
  const result = page.locator('.result');
  await expect(result).toContainText('เข้าใช้บริการไม่ได้');
  await expect(result).toContainText('บัตรใบนี้ถูกยกเลิกแล้ว');
  // A cancelled card is not a forged one, and the counter is told what to do
  // about it rather than only that it failed.
  await expect(page.getByText('ให้ลูกค้าใช้บัตรใบล่าสุดที่ยิมส่งให้')).toBeVisible();
  await page.screenshot({ path: 'artifacts/counter-scan-cancelled.png', fullPage: true });

  await page.getByRole('button', { name: 'สแกนคนถัดไป' }).click();
  await scan(page, fresh.qr);
  await expect(result).toContainText('เข้าใช้บริการได้');
});

test('a forged code is refused and kept out of the member history', async ({ page }) => {
  await signIn(page, 'staff3-ui@example.test');
  await scan(page, 'GYMCARD1.deadbeefdeadbeefdeadbeefdeadbeef.1.' + 'f'.repeat(32));
  const result = page.locator('.result');
  await expect(result).toContainText('เข้าใช้บริการไม่ได้');
  await expect(result).toContainText('QR ไม่ถูกต้อง');
  await expect(page.getByText('ไม่ทราบสมาชิก').first()).toBeVisible();
});

test('the counter tablet scans with its own camera', async ({ page }) => {
  // Chromium supplies a synthetic camera here (see playwright.config.js), so
  // this proves the permission flow and that frames really are arriving. It
  // cannot prove a QR decodes: the fake device shows a test pattern.
  await signIn(page, 'staff4-ui@example.test');
  await expect(page.getByText('พร้อมสแกน')).toBeVisible();
  const video = page.getByLabel('ภาพจากกล้องสำหรับสแกน QR');
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate(el => el.videoWidth), { timeout: 15000 }).toBeGreaterThan(0);
  await page.screenshot({ path: 'artifacts/counter-camera.png', fullPage: true });

  // Turning it off is allowed and remembered: a counter with a USB reader
  // plugged in has no use for the lens.
  await page.getByRole('button', { name: 'ปิดกล้อง' }).click();
  await expect(page.getByText('กล้องปิดอยู่')).toBeVisible();
  await page.reload();
  await expect(page.getByText('กล้องปิดอยู่')).toBeVisible();
});

test('a browser that refuses the camera leaves the counter still working', async ({ browser }) => {
  // The fourth state, and the one that decides whether the queue at the door
  // moves: somebody with a customer in front of them needs a way to carry on
  // before they need a way to fix it (Designer).
  const context = await browser.newContext();
  await context.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => {
      const error = new Error('denied by the test');
      error.name = 'NotAllowedError';
      return Promise.reject(error);
    };
  });
  const page = await context.newPage();
  await signIn(page, 'staff5-ui@example.test');

  await expect(page.getByText('เบราว์เซอร์ไม่ให้ใช้กล้อง')).toBeVisible();
  await expect(page.getByText('ยังเช็คอินให้ลูกค้าได้ตามปกติ', { exact: false })).toBeVisible();
  await expect(page.getByText('วิธีเปิดกล้องคืน')).toBeVisible();
  await page.screenshot({ path: 'artifacts/counter-camera-denied.png', fullPage: true });

  // And the way to carry on is one button, not a paragraph to read first.
  await page.getByRole('button', { name: 'พิมพ์รหัสจากบัตรแทน' }).click();
  await expect(page.getByLabel('รหัสจาก QR ของสมาชิก')).toBeVisible();
  await page.getByLabel('รหัสจาก QR ของสมาชิก').fill('GYMCARD1.' + 'a'.repeat(32) + '.1.' + 'f'.repeat(32));
  await page.getByRole('button', { name: 'ตรวจสอบ' }).click();
  await expect(page.locator('.result')).toContainText('เข้าใช้บริการไม่ได้');
  await context.close();
});

test('the history screen separates real visits from unreadable codes', async ({ page }) => {
  await signIn(page, 'admin5@example.test');
  await go(page, 'ประวัติเช็คอิน');
  await expect(page.getByRole('heading', { name: 'ประวัติการเช็คอิน' })).toBeVisible();
  await expect(page.getByText('ชัยชนะ มาออกกำลัง').first()).toBeVisible();
  await page.getByRole('button', { name: /QR ไม่ถูกต้อง/ }).click();
  await expect(page.getByText('ไม่ให้กลบประวัติการเข้าใช้บริการจริง', { exact: false })).toBeVisible();
});
