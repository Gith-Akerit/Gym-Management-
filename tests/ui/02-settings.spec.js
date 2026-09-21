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
