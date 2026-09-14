import { test, expect } from '@playwright/test';
import { cardToken, go, PNG_PIXEL, scan, signIn } from './counter.js';

// The complaint that started the redesign was "the screen is very strange on a
// computer": a phone layout stretched across 1280px. These check the two widths
// the gym actually uses -- a desktop at the counter and a phone in a hand --
// and fail with the name of whatever is sticking out rather than a bare false.
//
// They are also where the pictures come from. Every screenshot below is taken
// from a viewport that really is that wide, not a desktop window scaled down.

const SIZES = [
  { name: '1280', width: 1280, height: 900 },
  { name: '390', width: 390, height: 844 },
];
const MONTHLY = /รายเดือน Unlimited/;

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
      // A wide table is meant to scroll sideways inside its own box. What must
      // never scroll sideways is the page (Designer).
      if (el.closest('.table-wrap, .queue-list')) continue;
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

/** Resize, check, photograph — in that order, at a width that is really that. */
async function shot(page, size, name, label) {
  await page.setViewportSize(size);
  expect(await page.evaluate(() => window.innerWidth), `${label} was not photographed at ${size.width}px`)
    .toBe(size.width);
  await fits(page, `${label} at ${size.width}px`);
  await page.screenshot({ path: `artifacts/ui-${name}-${size.name}.png`, fullPage: true });
}

test('the login screen fits both sizes', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'เข้าสู่ระบบ' })).toBeVisible();
  for (const size of SIZES) await shot(page, size, 'login', 'หน้าเข้าสู่ระบบ');
});

test('signing somebody up fits both sizes, step by step', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: SIZES[0] })).newPage();
  await signIn(page, 'layout-admin@example.test');
  await go(page, 'สมัครสมาชิก');
  await expect(page.getByRole('heading', { name: 'ถ่ายรูปลูกค้า' })).toBeVisible();
  for (const size of SIZES) await shot(page, size, 'signup', 'หน้าสมัครสมาชิก');

  // And the steps after it, which is where a long Thai name pushes hardest.
  await page.setViewportSize(SIZES[0]);
  await page.getByLabel('เลือกรูปจากเครื่องแทน')
    .setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: PNG_PIXEL });
  await page.getByRole('button', { name: 'ถัดไป · ชื่อและเบอร์' }).click();
  await page.getByLabel('ชื่อ–นามสกุล').fill('ประกายแก้วมณี ศรีสุวรรณวัฒนกุลชัย');
  await page.getByLabel('เบอร์มือถือ').fill('0893331100');
  await page.getByRole('button', { name: 'ถัดไป · แพ็กเกจและเงิน' }).click();
  await page.getByRole('radio', { name: MONTHLY }).check();
  for (const size of SIZES) await fits(page, `ขั้นที่ 3 ของการสมัคร at ${size.width}px`);
  await page.setViewportSize(SIZES[0]);
  await page.getByRole('button', { name: 'บันทึกและออกบัตร' }).click();

  // The card is the widest thing in the app and the one most likely to push.
  const card = page.getByRole('img', { name: /บัตรสมาชิกของ/ });
  await expect(card).toBeVisible();
  await expect.poll(() => card.evaluate(img => img.naturalWidth)).toBe(1080);
  for (const size of SIZES) await shot(page, size, 'card', 'หน้าบัตรสมาชิก');

  // A name too long for one line is shown on two, not cut off mid-word.
  await go(page, 'สมาชิก');
  await page.getByLabel('ค้นหาสมาชิก').fill('ประกายแก้วมณี');
  const name = page.locator('.item .who b').first();
  await expect(name).toBeVisible();
  const lines = await name.evaluate(el =>
    Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
  expect(lines, 'a long name is wrapped to two lines, not one and not five').toBe(2);
  for (const size of SIZES) await shot(page, size, 'members', 'หน้ารายชื่อสมาชิก');
});

test('the scan screen fits both sizes with the photograph on it', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: SIZES[0] })).newPage();
  await signIn(page, 'layout-admin@example.test');
  await go(page, 'สมาชิก');
  await page.getByLabel('ค้นหาสมาชิก').fill('ประกายแก้วมณี');
  await page.getByRole('button', { name: /^เปิดสมาชิก/ }).first().click();
  const member = await cardToken(page, 'ประกายแก้วมณี ศรีสุวรรณวัฒนกุลชัย');

  await scan(page, member.qr);
  await expect(page.locator('.result')).toContainText('เข้าใช้บริการได้');
  await expect(page.getByRole('img', { name: /รูปถ่ายของ/ })).toBeVisible();
  for (const size of SIZES) await shot(page, size, 'scan', 'หน้าสแกนเช็คอิน');
});

test('the money screen fits both sizes with the summary panel', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: SIZES[0] })).newPage();
  await signIn(page, 'layout-admin@example.test');
  await go(page, 'รับเงินและมอบแพ็กเกจ');
  await page.getByLabel('ค้นหาสมาชิก').fill('ประกายแก้วมณี');
  await page.getByRole('button', { name: /^เปิดสมาชิก/ }).first().click();
  await page.getByRole('radio', { name: MONTHLY }).check();
  // The three steps and the summary are one screen on a desktop and one column
  // on a phone, and the old expiry and the new one are on both.
  await expect(page.getByText('หมดอายุเดิม')).toBeVisible();
  await expect(page.getByText('หมดอายุใหม่')).toBeVisible();
  for (const size of SIZES) await shot(page, size, 'payment', 'หน้ารับเงินและมอบแพ็กเกจ');
});

test('every screen in the console fits both sizes', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: SIZES[0] })).newPage();
  await signIn(page, 'layout-admin@example.test');
  await expect(page.locator('.scanstage')).toBeVisible();

  for (const size of SIZES) {
    await page.setViewportSize(size);
    for (const [tab, heading] of [
      ['สมาชิก', 'สมาชิก'],
      ['ผู้ใช้และสิทธิ์', 'ผู้ใช้และสิทธิ์'],
      ['ตรวจสลิป', 'คำสั่งซื้อ'],
      ['ประวัติเช็คอิน', 'ประวัติเช็คอิน'],
      ['แพ็กเกจ', 'แพ็กเกจ'],
      ['ข้อมูลยิม', 'ข้อมูลยิม'],
    ]) {
      // On a phone the four everyday screens are on the bar and the rest sit
      // behind "เพิ่มเติม", so reaching one of those is two taps.
      await go(page, tab);
      await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
      await fits(page, `${tab} at ${size.width}px`);
    }
    await go(page, 'สแกนเช็คอิน');
    await expect(page.getByText('พร้อมสแกน')).toBeVisible();
    await fits(page, `สแกนเช็คอิน at ${size.width}px`);
  }
});
