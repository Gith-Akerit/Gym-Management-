import { test, expect } from '@playwright/test';
import { signIn } from './counter.js';

// Runs after the login spec. Declaration order matters inside this file: the
// unpriced-package check has to happen before the owner publishes one.

test('the public page warns about unconfirmed hours and sells nothing yet', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/');
  // What somebody deciding whether to join sees before anybody signs in.
  await expect(page.getByText('ยังไม่เปิดขายแพ็กเกจ')).toBeVisible();
  await expect(page.getByText('เวลาเปิดทำการยังรอการยืนยัน', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test('the owner edits gym facts and puts a package on sale', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await signIn(page, 'admin2@example.test');
  await page.getByRole('button', { name: 'ข้อมูลยิม' }).click();
  await expect(page.getByRole('heading', { name: 'ข้อมูลยิม' })).toBeVisible();
  // Seeded facts are editable, never hardcoded.
  await expect(page.getByLabel('ชื่อยิม (ภาษาไทย)')).toHaveValue('สุขฤทัย ฟิตเนส');
  await expect(page.getByText('เวลาเปิดทำการยังไม่ได้ยืนยัน', { exact: false })).toBeVisible();

  await page.getByLabel('เบอร์ที่แสดงในแอปสมาชิก').selectOption('secondary');
  await page.getByLabel('ยืนยันเวลาเปิดทำการแล้ว', { exact: false }).check();
  await page.getByRole('button', { name: 'บันทึกข้อมูลยิม' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกข้อมูลยิมแล้ว' })).toBeVisible();

  await page.getByLabel('เวลาเปิดวันจันทร์').fill('17:00');
  await page.getByLabel('เวลาปิดวันจันทร์').fill('22:00');
  await page.getByRole('button', { name: 'บันทึกเวลาเปิดทำการ' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกเวลาเปิดทำการแล้ว' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/admin-gym-settings.png', fullPage: true });

  await page.getByRole('button', { name: 'แพ็กเกจ', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'แพ็กเกจทั้งหมด' })).toBeVisible();
  await expect(page.getByText('รอกำหนดราคา').first()).toBeVisible();
  await page.screenshot({ path: 'artifacts/admin-packages.png', fullPage: true });

  await page.getByRole('button', { name: 'แก้ไข รายเดือน Unlimited' }).click();
  // Publishing without a price has to fail: nobody must ever be sold a ฿0 package.
  await page.getByLabel('สถานะแพ็กเกจ').selectOption('active');
  await page.getByRole('button', { name: 'บันทึกแพ็กเกจ' }).click();
  await expect(page.getByRole('alert')).toContainText('ตรวจสอบข้อมูล');
  await expect(page.getByText('ต้องกรอกราคาก่อนจึงจะเปิดขายแพ็กเกจได้')).toBeVisible();

  await page.getByLabel('ราคา (บาท)', { exact: false }).fill('1200');
  await page.getByRole('button', { name: 'บันทึกแพ็กเกจ' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกแพ็กเกจแล้ว' })).toBeVisible();
  await expect(page.getByText('฿1,200.00').first()).toBeVisible();

  await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
  await expect(page.getByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeVisible();

  // --- what the public page says now -----------------------------------------
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByText('รายเดือน Unlimited')).toBeVisible();
  await expect(page.getByText('฿1,200.00')).toBeVisible();
  // Drafts stay internal.
  await expect(page.getByText('10 ครั้ง ใช้ได้ 90 วัน')).toHaveCount(0);
  // The owner switched the displayed number to the mobile one and confirmed hours.
  await expect(page.getByText('086-330-7368')).toBeVisible();
  await expect(page.getByText('17:00 – 22:00 น.').first()).toBeVisible();
  await expect(page.getByText('เวลาเปิดทำการยังรอการยืนยัน', { exact: false })).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/public-gym.png', fullPage: true });

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  expect(errors).toEqual([]);
});
