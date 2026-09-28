import { test, expect } from '@playwright/test';
import { go, signIn } from './counter.js';

// Runs after the login spec and before everything that sells anything: this is
// the spec that puts a package on sale. Declaration order matters inside the
// file too — the unpriced check has to happen before the owner fixes it.

test('the owner edits the facts that end up on the card', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await signIn(page, 'admin2@example.test');
  await go(page, 'ข้อมูลยิม');
  await expect(page.getByRole('heading', { name: 'ข้อมูลยิม' })).toBeVisible();
  // Seeded facts are editable, never hardcoded.
  await expect(page.getByLabel('ชื่อยิม (ภาษาไทย)')).toHaveValue('สุขฤทัย ฟิตเนส');

  await page.getByLabel('อำเภอ จังหวัด (ขึ้นบนบัตร)').fill('เมือง ขอนแก่น');
  await page.getByLabel('เบอร์ที่แสดงบนบัตรและหน้าสาธารณะ').selectOption('secondary');
  await page.getByLabel('ยืนยันเวลาเปิดทำการแล้ว', { exact: false }).check();
  await page.getByRole('button', { name: 'บันทึกข้อมูลยิม' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกข้อมูลยิมแล้ว' })).toBeVisible();

  await page.getByLabel('เวลาเปิดวันจันทร์').fill('17:00');
  await page.getByLabel('เวลาปิดวันจันทร์').fill('22:00');
  await page.getByRole('button', { name: 'บันทึกเวลาเปิดทำการ' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกเวลาเปิดทำการแล้ว' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/admin-gym-settings.png', fullPage: true });

  expect(errors).toEqual([]);
});

test('a package cannot go on sale without a price', async ({ page }) => {
  await signIn(page, 'admin2@example.test');
  await go(page, 'แพ็กเกจ');
  await expect(page.getByRole('heading', { name: 'แพ็กเกจ', exact: true })).toBeVisible();
  // The seeded drafts arrive with no price, and the list says what that costs
  // the counter rather than showing them as free.
  await expect(page.getByText('ยังไม่ตั้งราคา').first()).toBeVisible();
  await expect(page.getByText('◷ มอบไม่ได้').first()).toBeVisible();
  await page.screenshot({ path: 'artifacts/admin-packages.png', fullPage: true });

  await page.getByRole('button', { name: 'แก้ไข รายเดือน Unlimited' }).click();
  // Publishing without a price has to fail: nobody must ever be sold a ฿0
  // package by accident.
  await page.getByLabel('สถานะแพ็กเกจ').selectOption('active');
  await page.getByRole('button', { name: 'บันทึกแพ็กเกจ' }).click();
  await expect(page.getByText('ต้องกรอกราคาก่อนจึงจะเปิดขายแพ็กเกจได้')).toBeVisible();

  await page.getByLabel('ราคา (บาท)', { exact: false }).fill('1200');
  // ผลทดสอบของผู้ใช้ ข้อ 4: มีแต่ชื่อกับราคา ไม่มีที่ให้เจ้าของยิมเขียนเงื่อนไข
  // หรือโปรโมชัน ทั้งที่ตารางเก็บช่องนี้ไว้ตั้งแต่ต้น
  await page.getByLabel('รายละเอียดและเงื่อนไข', { exact: false })
    .fill('รวมคลาสกลุ่มทุกคลาส · เพื่อนมาด้วยได้เดือนละ 1 ครั้ง');
  await page.getByRole('button', { name: 'บันทึกแพ็กเกจ' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกแพ็กเกจแล้ว' })).toBeVisible();
  await expect(page.getByText('1,200 ฿').first()).toBeVisible();
  await expect(page.getByText('✓ เปิดขาย').first()).toBeVisible();
  await expect(page.getByText('เพื่อนมาด้วยได้เดือนละ 1 ครั้ง').first()).toBeVisible();

  // และกลับมาแก้ได้จริง ไม่ใช่เขียนแล้วหายไปจากฟอร์ม
  await page.getByRole('button', { name: 'แก้ไข รายเดือน Unlimited' }).click();
  await expect(page.getByLabel('รายละเอียดและเงื่อนไข', { exact: false }))
    .toHaveValue('รวมคลาสกลุ่มทุกคลาส · เพื่อนมาด้วยได้เดือนละ 1 ครั้ง');
  await page.getByRole('button', { name: 'ยกเลิก' }).click();
});

test('a year-long package that admits one visit is questioned before it is saved', async ({ page }) => {
  // ผลทดสอบของผู้ใช้ รอบที่ 2: ยิมตั้งแพ็กเกจเองครบทั้งห้าตัว และใส่ "1 ครั้ง"
  // เหมือนกันหมด รวมทั้งรายปี 10,000 บาท — สมาชิกจึงเข้าได้ครั้งเดียวทั้งปี
  // หน้าจอเดิมบันทึกให้เงียบ ๆ ไม่ถามอะไรสักคำ
  await signIn(page, 'admin10@example.test');
  await go(page, 'แพ็กเกจ');
  await page.getByRole('button', { name: '＋ เพิ่มแพ็กเกจ' }).click();

  await page.getByLabel('รหัสแพ็กเกจ').fill('YEAR_TRAP');
  await page.getByLabel('ชื่อแพ็กเกจ').fill('รายปี (1 ปี)');
  await page.getByLabel('ประเภท').selectOption('limited_sessions');
  await page.getByLabel('อายุแพ็กเกจ (วัน)').fill('365');
  await page.getByLabel('จำนวนครั้ง').fill('1');

  const warning = page.getByRole('status').filter({ hasText: 'เข้ายิมได้ 1 ครั้ง ตลอด 365 วัน' });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('ไม่จำกัดครั้ง');
  await page.screenshot({ path: 'artifacts/admin-package-session-warning.png', fullPage: true });

  // ทักอย่างเดียว ไม่ขวาง — ขายครั้งเดียวจบก็เป็นแพ็กเกจที่มีจริง
  await expect(page.getByRole('button', { name: 'บันทึกแพ็กเกจ' })).toBeEnabled();

  // แพ็กเกจปกติต้องไม่โดนทัก ไม่งั้นคำเตือนจะกลายเป็นเสียงรบกวนที่ทุกคนมองข้าม
  await page.getByLabel('จำนวนครั้ง').fill('30');
  await expect(warning).toHaveCount(0);

  // และแบบไม่จำกัดครั้งก็ไม่มีช่อง "จำนวนครั้ง" ให้ตั้งผิดตั้งแต่แรก
  await page.getByLabel('ประเภท').selectOption('unlimited');
  await expect(page.getByLabel('จำนวนครั้ง')).toHaveCount(0);
  await page.getByRole('button', { name: 'ยกเลิก' }).click();
});
