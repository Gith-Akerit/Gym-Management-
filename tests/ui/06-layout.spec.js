import { test, expect } from '@playwright/test';
import { PNG_PIXEL, signIn, signUpMember } from './counter.js';

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

for (const size of SIZES) {
  test(`the public page fits a ${size.name}`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeVisible();
    await fits(page, `หน้าแรก at ${size.width}px`);
    await page.screenshot({ path: `artifacts/ui-1-public-${size.name}.png`, fullPage: true });
  });
}

test('signing somebody up and handing them a card fits both sizes', async ({ browser }) => {
  const context = await browser.newContext({ viewport: SIZES[0] });
  const page = await context.newPage();
  await signIn(page, 'layout-admin@example.test');
  await signUpMember(page, { name: 'เลย์ เอาต์', phone: '0893331100' });
  await page.getByLabel('หรือเลือกรูปจากเครื่อง')
    .setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: PNG_PIXEL });
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกรูปถ่ายแล้ว' })).toBeVisible();
  await page.getByLabel('ค้นหาสมาชิก').fill('เลย์ เอาต์');
  await page.getByRole('button', { name: 'แก้ไข เลย์ เอาต์' }).click();

  // The card is the widest thing on this screen and the one most likely to push.
  const card = page.getByRole('img', { name: /บัตรสมาชิกของ/ });
  await expect(card).toBeVisible();
  await expect.poll(() => card.evaluate(img => img.naturalWidth)).toBe(1080);
  for (const size of SIZES) await shot(page, size, 'ui-2-signup', 'หน้าสมาชิกรายคน');
});

test('the scan result fits both sizes with the photograph on it', async ({ browser }) => {
  const context = await browser.newContext({ viewport: SIZES[0] });
  const page = await context.newPage();
  await signIn(page, 'layout-admin@example.test');
  await page.getByRole('button', { name: 'สมาชิก', exact: true }).click();
  await page.getByLabel('ค้นหาสมาชิก').fill('เลย์ เอาต์');
  await page.getByRole('button', { name: 'แก้ไข เลย์ เอาต์' }).click();
  const id = await page.getByRole('img', { name: /บัตรสมาชิกของ/ })
    .evaluate(img => new URL(img.src).pathname.split('/')[3]);
  const card = await (await page.request.get(`/api/members/${id}/card`)).json();

  await page.getByRole('button', { name: 'สแกนเช็คอิน' }).click();
  await page.getByLabel('รหัสจาก QR ของสมาชิก').fill(card.qr);
  await page.getByRole('button', { name: 'ตรวจสอบ' }).click();
  await expect(page.locator('.scan-result')).toBeVisible();
  await expect(page.getByRole('img', { name: /รูปถ่ายของ/ })).toBeVisible();
  for (const size of SIZES) await shot(page, size, 'ui-4-scan', 'หน้าสแกนเช็คอิน');
});

test('the admin console fits both sizes', async ({ browser }) => {
  const context = await browser.newContext({ viewport: SIZES[0] });
  const page = await context.newPage();
  await signIn(page, 'layout-admin@example.test');
  await expect(page.getByRole('heading', { name: 'สแกนเช็คอิน' })).toBeVisible();

  for (const size of SIZES) {
    await page.setViewportSize(size);
    for (const [tab, heading, picture] of [
      ['สแกนเช็คอิน', 'สแกนเช็คอิน'],
      ['สมาชิก', 'สมาชิกทั้งหมด', 'ui-3-members'],
      ['ผู้ใช้และสิทธิ์', 'บัญชีผู้ใช้', 'ui-6-users'],
      ['ตรวจสลิป', 'คำสั่งซื้อ'],
      ['เช็คอิน', 'การเข้าใช้บริการ'],
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
      if (picture) await shot(page, size, picture, tab);
    }
  }
});
