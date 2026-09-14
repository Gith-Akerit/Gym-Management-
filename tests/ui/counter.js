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
  await page.getByLabel('รหัสผ่าน').fill(password);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
}

/** Signs somebody up at the counter and opens their page. */
export async function signUpMember(page, { name, phone }) {
  await page.getByRole('button', { name: 'สมาชิก', exact: true }).click();
  await page.getByRole('button', { name: '＋ สมัครสมาชิกใหม่' }).click();
  await page.getByLabel('ชื่อ–นามสกุล').fill(name);
  await page.getByLabel('เบอร์มือถือ').fill(phone);
  await page.getByRole('button', { name: 'บันทึกสมาชิก' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'เพิ่มสมาชิกแล้ว' })).toBeVisible();
  await page.getByLabel('ค้นหาสมาชิก').fill(name);
  await page.getByRole('button', { name: `แก้ไข ${name}` }).click();
  await expect(page.getByRole('heading', { name: 'ข้อมูลสมาชิก' })).toBeVisible();
}
