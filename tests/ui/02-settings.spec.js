import { test, expect } from '@playwright/test';

// Spec files share one test server and run in filename order, hence the number
// prefixes. Runs after 01-member.spec, so these journeys never
// assume an empty member list. Declaration order matters: the empty-catalogue
// check has to happen before the admin publishes a package.

async function login(page, email) {
  await page.goto('/');
  await page.getByLabel('อีเมล', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'รับรหัสทางอีเมล' }).click();
  await expect(page.getByLabel('รหัสยืนยัน 6 หลัก')).toBeVisible();
  const { code } = await (await page.request.get(`/__test/code?email=${email}`)).json();
  await page.getByLabel('รหัสยืนยัน 6 หลัก').fill(code);
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click();
}

async function registerMember(page, { email, name, phone }) {
  await login(page, email);
  await page.getByLabel('ชื่อ–นามสกุล').fill(name);
  await page.getByLabel('เบอร์มือถือ').fill(phone);
  await page.getByRole('button', { name: 'เริ่มใช้งาน' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

test('with every package still a draft the member sees an honest empty catalogue', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await registerMember(page, { email: 'empty@example.test', name: 'สมชาย ทดสอบ', phone: '0894445566' });
  await page.getByRole('button', { name: 'แพ็กเกจ' }).click();
  await expect(page.getByRole('heading', { name: 'ยังไม่เปิดขายแพ็กเกจ' })).toBeVisible();
  // Unconfirmed opening hours must warn the member rather than read as fact.
  await page.getByRole('button', { name: 'บัญชี' }).click();
  await expect(page.getByText('เวลาเปิดทำการยังรอการยืนยัน', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test('admin edits gym facts and publishes a package, member then sees both', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await login(page, 'admin2@example.test');
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
  // Publishing without a price has to fail: members must never see a ฿0 package.
  await page.getByLabel('สถานะแพ็กเกจ').selectOption('active');
  await page.getByRole('button', { name: 'บันทึกแพ็กเกจ' }).click();
  await expect(page.getByRole('alert')).toContainText('ตรวจสอบข้อมูล');
  await expect(page.getByText('ต้องกรอกราคาก่อนจึงจะเปิดขายแพ็กเกจได้')).toBeVisible();

  await page.getByLabel('ราคา (บาท)', { exact: false }).fill('1200');
  await page.getByRole('button', { name: 'บันทึกแพ็กเกจ' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกแพ็กเกจแล้ว' })).toBeVisible();
  await expect(page.getByText('฿1,200.00').first()).toBeVisible();

  await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
  await expect(page.getByRole('button', { name: 'รับรหัสทางอีเมล' })).toBeVisible();

  // --- member side -----------------------------------------------------------
  await page.setViewportSize({ width: 390, height: 844 });
  await registerMember(page, { email: 'catalogue@example.test', name: 'มานี รักดี', phone: '0891112233' });
  await expect(page.getByRole('heading', { name: 'QR สำหรับเช็คอิน' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/member-home.png', fullPage: true });

  await page.getByRole('button', { name: 'แพ็กเกจ' }).click();
  await expect(page.getByRole('heading', { name: 'รายเดือน Unlimited' })).toBeVisible();
  await expect(page.getByText('฿1,200.00')).toBeVisible();
  // Drafts stay internal.
  await expect(page.getByText('10 ครั้ง ใช้ได้ 90 วัน')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/member-packages.png', fullPage: true });

  await page.getByRole('button', { name: 'บัญชี' }).click();
  await expect(page.getByRole('heading', { name: 'ข้อมูลยิม' })).toBeVisible();
  // The admin switched the displayed number to the mobile one and confirmed hours.
  await expect(page.getByText('086-330-7368')).toBeVisible();
  await expect(page.getByText('17:00 – 22:00 น.').first()).toBeVisible();
  await expect(page.getByText('เวลาเปิดทำการยังรอการยืนยัน', { exact: false })).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/member-account.png', fullPage: true });

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  expect(errors).toEqual([]);
});
