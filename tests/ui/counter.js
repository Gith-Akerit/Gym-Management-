import { expect } from '@playwright/test';

/** The password every seeded account in the test server has. */
export const PASSWORD = 'counter-test-password';

/** A one-pixel PNG a real image decoder will open, for member photographs. */
export const PNG_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

/** The smallest thing a browser will hand over that is genuinely a JPEG. */
export function jpegBuffer() {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9]),
  ]);
}

/** Signs in the way somebody arriving for a shift does. */
export async function signIn(page, email, password = PASSWORD) {
  await page.goto('/');
  await page.getByLabel('อีเมล', { exact: true }).fill(email);
  await page.getByLabel('รหัสผ่าน', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
}

/**
 * Moves to a screen the way whoever is holding the machine would.
 *
 * The rail on a desktop and the bar at the bottom of a phone are the same menu
 * drawn twice, and only one of them is on the screen at a time, so a spec that
 * names a destination should not also have to know which. The scan screen is a
 * stage of its own with no menu at all: leaving it is its own button.
 */
export async function go(page, label) {
  const onStage = await page.locator('.scanstage').isVisible().catch(() => false);
  if (onStage && label === 'สแกนเช็คอิน') return undefined;
  if (onStage) await page.getByRole('button', { name: 'ไปหน้าจัดการ' }).click();
  const rail = page.locator('.railnav').getByRole('link', { name: label, exact: true });
  if (await rail.isVisible()) return rail.click();

  const bottom = page.locator('.bottomnav');
  let item = bottom.getByRole('link', { name: label, exact: true });
  // Four everyday screens are on the bar; everything else is two taps away.
  if (!await item.isVisible()) {
    await bottom.getByRole('link', { name: 'เพิ่มเติม' }).click();
    item = bottom.getByRole('link', { name: label, exact: true });
  }
  return item.click();
}

/**
 * Signs somebody up at the counter, three steps, and leaves their card open.
 *
 * `pkg` is the label of a package on sale; leaving it out signs the member up
 * without selling them anything, which a walk-in who is only asking prices is.
 */
export async function signUpMember(page, { name, phone, photo = true, pkg = null }) {
  await go(page, 'สมัครสมาชิก');
  await expect(page.getByRole('heading', { name: 'สมัครสมาชิกใหม่' })).toBeVisible();

  if (photo) {
    await page.getByLabel('เลือกรูปจากเครื่องแทน')
      .setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: PNG_PIXEL });
  }
  await page.getByRole('button', { name: 'ถัดไป · ชื่อและเบอร์' }).click();

  await page.getByLabel('ชื่อ–นามสกุล').fill(name);
  await page.getByLabel('เบอร์มือถือ').fill(phone);
  await page.getByRole('button', { name: 'ถัดไป · แพ็กเกจและเงิน' }).click();

  if (pkg) await page.getByRole('radio', { name: pkg }).check();
  await page.getByRole('button', { name: 'บันทึกและออกบัตร' }).click();
  await expect(page.getByRole('heading', { name: 'บัตรสมาชิก' })).toBeVisible();
  await expect(page.getByRole('img', { name: `บัตรสมาชิกของ ${name}` })).toBeVisible();
}

/** Opens a member's card from the list, by name. */
export async function openMember(page, name) {
  await go(page, 'สมาชิก');
  await page.getByLabel('ค้นหาสมาชิก').fill(name);
  await page.getByRole('button', { name: `เปิดสมาชิก ${name}` }).click();
  await expect(page.getByRole('heading', { name: 'บัตรสมาชิก' })).toBeVisible();
}

/** The token printed on the card that is currently on the screen. */
export async function cardToken(page, name) {
  const id = await page.getByRole('img', { name: `บัตรสมาชิกของ ${name}` })
    .evaluate(img => new URL(img.src).pathname.split('/')[3]);
  const card = await (await page.request.get(`/api/members/${id}/card`)).json();
  return { id, qr: card.qr };
}

/** Types a code into the scan screen the way a USB reader or a thumb would. */
export async function scan(page, qr, { device = null } = {}) {
  await go(page, 'สแกนเช็คอิน');
  if (!await page.getByLabel('รหัสจาก QR ของสมาชิก').isVisible()) {
    await page.getByRole('button', { name: 'พิมพ์รหัสเอง' }).click();
  }
  if (device) await page.getByLabel('ชื่อจุดสแกน', { exact: false }).fill(device);
  await page.getByLabel('รหัสจาก QR ของสมาชิก').fill(qr);
  await page.getByRole('button', { name: 'ตรวจสอบ' }).click();
}
