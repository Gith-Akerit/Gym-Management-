import { test, expect } from '@playwright/test';

// The complaint that started the redesign was "the screen is very strange on a
// computer": a phone layout stretched across 1280px. These check the two widths
// the gym actually uses -- a desktop at the counter and a phone in a hand --
// and fail with the name of whatever is sticking out rather than a bare false.

const SIZES = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];

/** Every element whose box reaches past the right edge of the viewport. */
async function overflowing(page) {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (box.right <= limit + 0.5 && box.left >= -0.5) continue;
      const style = getComputedStyle(el);
      if (style.position === 'fixed' || style.visibility === 'hidden') continue;
      // Deliberately parked off-screen for screen readers only.
      if (box.right < 0) continue;
      out.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ').filter(Boolean).join('.')}`
        + ` [${Math.round(box.left)}…${Math.round(box.right)}] of ${limit}`);
      if (out.length >= 6) break;
    }
    return out;
  });
}

async function fits(page, label) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  const offenders = await overflowing(page);
  expect(wide === false && offenders.length === 0,
    `${label} overflows sideways:\n  ${offenders.join('\n  ')}`).toBeTruthy();
}

async function login(page, email) {
  await page.goto('/');
  await page.getByLabel('อีเมล', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'รับรหัสทางอีเมล' }).click();
  await expect(page.getByLabel('รหัสยืนยัน 6 หลัก')).toBeVisible();
  const { code } = await (await page.request.get(`/__test/code?email=${email}`)).json();
  await page.getByLabel('รหัสยืนยัน 6 หลัก').fill(code);
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click();
}

for (const size of SIZES) {
  test(`the public page fits a ${size.name}`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'รับรหัสทางอีเมล' })).toBeVisible();
    await fits(page, `หน้าแรก at ${size.width}px`);
    await page.screenshot({ path: `artifacts/ui-1-public-${size.name}.png`, fullPage: true });
  });
}

test('the member screens fit both sizes', async ({ browser }) => {
  const context = await browser.newContext({ viewport: SIZES[0] });
  const page = await context.newPage();
  await login(page, 'layout-member@example.test');
  await page.getByLabel('ชื่อ–นามสกุล').fill('เลย์ เอาต์');
  await page.getByLabel('เบอร์มือถือ').fill('0893331100');
  await page.getByRole('button', { name: 'เริ่มใช้งาน' }).click();
  await expect(page.getByRole('heading', { name: 'เลย์ เอาต์' })).toBeVisible();

  for (const size of SIZES) {
    await page.setViewportSize(size);
    // The QR is the widest thing on this screen and the one most likely to push.
    await expect(page.getByRole('img', { name: /QR สำหรับเช็คอิน/ })).toBeVisible();
    await fits(page, `หน้าสมาชิก at ${size.width}px`);
    await page.screenshot({ path: `artifacts/ui-2-member-${size.name}.png`, fullPage: true });

    await page.getByRole('button', { name: 'บัญชี' }).click();
    await expect(page.getByRole('heading', { name: 'ประวัติการเข้าใช้บริการ' })).toBeVisible();
    await fits(page, `บัญชีสมาชิก at ${size.width}px`);
    await page.getByRole('button', { name: 'หน้าแรก' }).click();
  }
});

test('the admin console fits both sizes', async ({ browser }) => {
  const context = await browser.newContext({ viewport: SIZES[0] });
  const page = await context.newPage();
  await login(page, 'layout-admin@example.test');
  await expect(page.getByRole('heading', { name: 'สมาชิกทั้งหมด' })).toBeVisible();

  for (const size of SIZES) {
    await page.setViewportSize(size);
    for (const [tab, heading] of [
      ['สมาชิก', 'สมาชิกทั้งหมด'],
      ['ผู้ใช้และสิทธิ์', 'บัญชีผู้ใช้'],
      ['สแกนเช็คอิน', 'สแกนเช็คอิน'],
      ['แพ็กเกจ', 'แพ็กเกจทั้งหมด'],
      ['ข้อมูลยิม', 'ข้อมูลยิม'],
    ]) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
      await fits(page, `${tab} at ${size.width}px`);
    }
    await page.getByRole('button', { name: 'สมาชิก', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'สมาชิกทั้งหมด' })).toBeVisible();
    // Wait for rows: a screenshot of the loading line proves nothing about the
    // table this whole change is about.
    await expect(page.locator('.table-members tbody tr').first()).toBeVisible();
    await page.screenshot({ path: `artifacts/ui-3-admin-${size.name}.png`, fullPage: true });
  }
});
