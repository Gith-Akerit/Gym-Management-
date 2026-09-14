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
      // A queue strip and a wide table are meant to scroll sideways inside
      // their own box. What must never scroll sideways is the page (Designer).
      if (el.closest('.queue-list, .table-wrap')) continue;
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
  // The measure that matters is whether the page itself can be scrolled
  // sideways. The element list exists only to name what is responsible.
  const pageScrolls = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth);
  const offenders = await overflowing(page);
  expect(pageScrolls === false, `${label} scrolls sideways:\n  `
    + (offenders.join('\n  ') || '(no single element; look for a wide grid or an unbroken word)')).toBeTruthy();
  expect(offenders, `${label}: an element reaches past the edge`).toEqual([]);
}

/**
 * Resize, check, photograph. The width assertion is the point: a picture of a
 * phone layout has to come out of a viewport that really is 390px wide, not a
 * desktop window scaled down afterwards (Designer).
 */
async function shot(page, size, name, label) {
  await page.setViewportSize(size);
  expect(await page.evaluate(() => window.innerWidth), `${label} was not photographed at ${size.width}px`)
    .toBe(size.width);
  await fits(page, `${label} at ${size.width}px`);
  await page.screenshot({ path: `artifacts/${name}-${size.name}.png`, fullPage: true });
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

  // The payment screen is the one with the most to fit: a QR that must stay
  // scannable, an amount that must stay legible, and a form beside both.
  await page.getByRole('button', { name: 'แพ็กเกจ' }).click();
  await page.getByRole('button', { name: 'ซื้อแพ็กเกจนี้' }).first().click();
  await expect(page.getByRole('heading', { name: 'PromptPay' })).toBeVisible();
  const qr = page.getByRole('img', { name: /QR พร้อมเพย์/ });
  await expect.poll(() => qr.evaluate(img => img.naturalWidth)).toBeGreaterThan(50);
  for (const size of SIZES) await shot(page, size, 'ui-4-payment', 'หน้าชำระเงิน');
});

test('the admin console fits both sizes', async ({ browser }) => {
  const context = await browser.newContext({ viewport: SIZES[0] });
  const page = await context.newPage();
  await login(page, 'layout-admin@example.test');
  await expect(page.getByRole('heading', { name: 'สมาชิกทั้งหมด' })).toBeVisible();

  for (const size of SIZES) {
    await page.setViewportSize(size);
    for (const [tab, heading, picture] of [
      ['สมาชิก', 'สมาชิกทั้งหมด'],
      ['ผู้ใช้และสิทธิ์', 'บัญชีผู้ใช้'],
      ['ตรวจสลิป', 'คำสั่งซื้อ'],
      ['สแกนเช็คอิน', 'สแกนเช็คอิน'],
      ['แพ็กเกจ', 'แพ็กเกจทั้งหมด'],
      ['ข้อมูลยิม', 'ข้อมูลยิม', 'ui-5-gym'],
    ]) {
      // On a phone the four everyday screens are on the bar and the rest sit
      // behind "เพิ่มเติม", so reaching one of those is two taps.
      const item = page.getByRole('button', { name: tab, exact: true });
      if (!await item.isVisible()) await page.getByRole('button', { name: 'เพิ่มเติม' }).click();
      await item.click();
      await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
      await fits(page, `${tab} at ${size.width}px`);

      if (tab === 'ตรวจสลิป') {
        // "ทั้งหมด" rather than the default queue: by the time this spec runs
        // the earlier ones have decided every slip, and a picture of an empty
        // queue says nothing about the screen the layout is for.
        await page.getByRole('button', { name: 'ทั้งหมด', exact: true }).click();
        const first = page.getByRole('button', { name: /ตรวจสลิปของ |มอบสิทธิ์ให้ / }).first();
        // Changing the filter refetches, and this machine is running two gyms
        // and a browser at once; the default five seconds has been short enough
        // to catch the skeleton rather than the queue.
        await expect(first).toBeVisible({ timeout: 15000 });
        await first.click();
        await expect(page.getByRole('heading', { name: 'ตรวจสลิป' })).toBeVisible();
        await shot(page, size, 'ui-6-review', 'หน้าตรวจสลิป');
      }
      if (picture) await shot(page, size, picture, tab);
    }
    await page.getByRole('button', { name: 'สมาชิก', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'สมาชิกทั้งหมด' })).toBeVisible();
    // Wait for rows: a screenshot of the loading line proves nothing about the
    // table this whole change is about.
    await expect(page.locator('.table-members tbody tr').first()).toBeVisible();
    await page.screenshot({ path: `artifacts/ui-3-admin-${size.name}.png`, fullPage: true });
  }
});
