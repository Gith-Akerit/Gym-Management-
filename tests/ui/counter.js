import { expect } from '@playwright/test';

/** The password every seeded account in the test server has. */
export const PASSWORD = 'counter-test-password';

// The same files the API suite sends, so a browser journey and an API test
// disagreeing means the app changed, not the fixture.
import { jpegBuffer, PHOTO_JPEG, PNG_PIXEL } from '../fixtures.js';
export { jpegBuffer, PHOTO_JPEG, PNG_PIXEL };

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
 * Three ways in, and only one of them is on the screen at a time, so a spec
 * that names a destination should not also have to know which: the rail on a
 * desktop, the bar at the bottom of a phone -- both carrying the four everyday
 * screens -- and the menu in the top right corner, which carries the rest and
 * is on every screen including the scan stage.
 */
export async function go(page, label) {
  const onStage = await page.locator('.scanstage').isVisible().catch(() => false);
  if (onStage && label === 'สแกนเช็คอิน') return undefined;

  // The scan stage has no rail and no bar. The menu is on it, so anything the
  // menu carries is one tap away; the four everyday screens are not in the
  // menu, so those are reached by stepping off the stage first.
  if (onStage) {
    const item = await menuItem(page, label);
    if (item) return item.click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'ไปหน้าจัดการ' }).click();
  }

  const rail = page.locator('.railnav').getByRole('link', { name: label, exact: true });
  if (await rail.isVisible()) return rail.click();
  const bottom = page.locator('.bottomnav').getByRole('link', { name: label, exact: true });
  if (await bottom.isVisible()) return bottom.click();

  const item = await menuItem(page, label);
  if (!item) throw new Error(`ไม่มีทางไปหน้า "${label}" ทั้งบนแถบและในเมนู`);
  return item.click();
}

/** The row with this label in the corner menu, or null when it carries none. */
async function menuItem(page, label) {
  await openUserMenu(page);
  const item = page.getByRole('menuitem', { name: label, exact: true });
  return await item.count() ? item : null;
}

/** Opens the menu in the top right corner and waits for it to be there. */
export async function openUserMenu(page) {
  // Wait for the header first: hunting for a control inside a header that is
  // not drawn yet is what turned into a thirty-second timeout under load.
  await page.locator('.scanbar, .appbar').first().waitFor();
  const button = page.getByRole('button', { name: 'เมนู', exact: true });
  await button.waitFor();
  if (await button.getAttribute('aria-expanded') === 'false') await button.click();
  await expect(page.locator('#usermenu-panel')).toBeVisible();
  return button;
}

/**
 * The scan stage, once it is really up.
 *
 * "พร้อมสแกน" appears when the camera has settled, which under the load of a
 * full suite run arrives a beat after the stage itself. Waiting for the text
 * alone is what turned into a timeout about once in three full runs (QA).
 */
export async function scanReady(page) {
  await page.locator('.scanstage').waitFor();
  await expect(page.getByText('พร้อมสแกน')).toBeVisible();
}

/** Signing out, which lives in that menu now and nowhere else. */
export async function logOut(page) {
  await openUserMenu(page);
  await page.getByRole('menuitem', { name: 'ออกจากระบบ', exact: true }).click();
  await expect(page.getByRole('button', { name: 'เข้าสู่ระบบ' })).toBeVisible();
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
