import { test, expect } from '@playwright/test';
import { go, jpegBuffer, signIn } from './counter.js';

// "ตั้งค่ายิม" — the screen where the gym stops looking like the software.
//
// Five states, and the reason the preview exists at all: the owner cannot
// picture what a colour will do to a membership card, so the card is on the
// screen while they choose. These check what a person would see, including the
// numbers in the contrast table, because that table is the promise the screen
// makes about what the server did.
//
// This spec runs last and repaints the app, so it puts the colour back.

/** A logo drawn in the browser: flat colour with a transparent background. */
async function logoFile(page, colour = '#C2185B') {
  return page.evaluate(async hex => {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 512;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = hex;
    ctx.beginPath(); ctx.arc(256, 256, 200, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 190px sans-serif'; ctx.fillText('S', 195, 320);
    const blob = await new Promise(done => canvas.toBlob(done, 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return Array.from(bytes);
  }, colour);
}

const asFile = (name, bytes) => ({ name, mimeType: 'image/png', buffer: Buffer.from(bytes) });

test('the owner sees the form beside a live preview, and nothing saves by itself', async ({ page }) => {
  await signIn(page, 'brand-admin@example.test');
  await go(page, 'ตั้งค่ายิม');
  await expect(page.getByRole('heading', { name: 'ตั้งค่ายิม' })).toBeVisible();

  // Empty state: no logo yet, and the screen says that is fine.
  await expect(page.getByText('ยังไม่มีโลโก้ก็เริ่มใช้ได้')).toBeVisible();
  await expect(page.getByRole('button', { name: /^ใช้สี #05603A$/ })).toBeVisible();
  await page.screenshot({ path: 'artifacts/branding-2-nologo-1280.png', fullPage: true });

  // The preview follows the colour before anything is saved.
  const cardTop = page.locator('.pvcard .mcard .top');
  await expect(cardTop).toHaveCSS('background-color', 'rgb(5, 96, 58)');
  await page.getByLabel('สีหลัก', { exact: true }).fill('#C2185B');
  await page.getByLabel('สีหลัก', { exact: true }).blur();
  await expect(cardTop).toHaveCSS('background-color', 'rgb(194, 24, 91)');
  // And the app around it has NOT changed: nothing is saved until it is saved.
  expect(await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--brand-surface').trim().toUpperCase()))
    .toBe('#05603A');

  // The five numbers, live, as numbers rather than a pass mark.
  const ratios = page.locator('.ratio');
  await expect(ratios).toHaveCount(5);
  await expect(ratios.first()).toContainText(':1');
  await expect(page.locator('.savebar')).toContainText('แก้ไขแล้ว 1 อย่าง');

  await page.getByRole('button', { name: 'บันทึกการตั้งค่า' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกการตั้งค่ายิมแล้ว' })).toBeVisible();
  // Now the whole app wears it.
  await expect.poll(() => page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--brand-surface').trim().toUpperCase()))
    .toBe('#C2185B');
  await page.screenshot({ path: 'artifacts/branding-1-settings-1280.png', fullPage: true });
});

test('a colour that cannot carry text is used anyway, and the screen says what it did', async ({ page }) => {
  await signIn(page, 'brand-admin@example.test');
  await go(page, 'ตั้งค่ายิม');
  // The narrow band of grey where neither white nor black passes on it.
  await page.getByLabel('สีหลัก', { exact: true }).fill('#7A7A7A');
  await page.getByLabel('สีหลัก', { exact: true }).blur();

  await expect(page.getByText('ปรับสีพื้นให้เข้มขึ้นเล็กน้อยแล้ว')).toBeVisible();
  // It says which colour it used instead, and keeps the one that was chosen.
  await expect(page.locator('.alert.warn')).toContainText('#7A7A7A');
  await expect(page.getByLabel('สีหลัก', { exact: true })).toHaveValue('#7A7A7A');
  // Every row of the table still clears its own bar after the adjustment.
  const numbers = await page.locator('.ratio b').allInnerTexts();
  expect(numbers).toHaveLength(5);
  for (const [at, text] of numbers.entries()) {
    const value = Number(text.replace(':1', ''));
    expect(value, `row ${at} is ${text}`).toBeGreaterThanOrEqual(at === 3 ? 3 : 4.5);
  }
});

test('the logo goes up, its colours come back, and the card takes it', async ({ page }) => {
  await signIn(page, 'brand-admin@example.test');
  await go(page, 'ตั้งค่ายิม');
  await page.getByLabel('เลือกไฟล์โลโก้').setInputFiles(asFile('logo.png', await logoFile(page)));

  await expect(page.getByText('โลโก้ปัจจุบัน')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'อัปโหลดโลโก้แล้ว' })).toBeVisible();
  // The colours off the file are offered, with the system green last as the
  // way back (Designer, ข้อ 7).
  const swatches = page.locator('.sw');
  await expect(swatches.first()).toBeVisible();
  const offered = await swatches.evaluateAll(list => list.map(el => el.textContent.trim()));
  expect(offered.length).toBeGreaterThanOrEqual(2);
  expect(offered.at(-1)).toBe('#05603A');
  // The pink of the logo is in there somewhere.
  expect(offered.some(hex => /^#C[0-9A-F]/.test(hex)), `offered ${offered.join(' ')}`).toBeTruthy();

  // The card preview now carries the logo instead of the initials.
  await expect(page.locator('.pvcard .mcard .gm.logo img')).toBeVisible();
  // And so does the app bar, as a horizontal mark rather than a squeezed square.
  await expect(page.getByRole('img', { name: /^โลโก้ของ/ })).toBeVisible();
  await page.screenshot({ path: 'artifacts/branding-3-logo-1280.png', fullPage: true });

  // Choosing a colour is one press. The last one is the system green, which
  // is the way back when the colours off the logo turn out not to be it.
  await swatches.last().click();
  await expect(page.getByLabel('สีหลัก', { exact: true })).toHaveValue('#05603A');
  await expect(page.locator('.savebar')).toContainText('แก้ไขแล้ว');
});

test('a file that is not a logo is refused, and nothing already saved is lost', async ({ page }) => {
  await signIn(page, 'brand-admin@example.test');
  await go(page, 'ตั้งค่ายิม');
  const before = await page.locator('.pvcard .mcard .top').evaluate(el => getComputedStyle(el).backgroundColor);

  await page.getByLabel('เปลี่ยนโลโก้').setInputFiles({
    name: 'half-sent.jpg', mimeType: 'image/jpeg', buffer: jpegBuffer(),
  });
  await expect(page.locator('.alert.err')).toContainText('อัปโหลดโลโก้ไม่สำเร็จ');
  await expect(page.locator('.alert.err')).toContainText('เปิดไม่ได้');
  // The settings that were there a moment ago are still there: a bad file is
  // not a reason to lose a colour somebody chose last week.
  await expect(page.locator('.pvcard .mcard .top')).toHaveCSS('background-color', before);
  await expect(page.locator('.pvcard .mcard .gm.logo img')).toBeVisible();
  await page.screenshot({ path: 'artifacts/branding-4-error-1280.png', fullPage: true });
});

test('staff can read the settings but not touch them', async ({ page }) => {
  await signIn(page, 'brand-staff@example.test');
  await go(page, 'ตั้งค่ายิม');
  await expect(page.getByText('คุณเข้าใช้งานในฐานะพนักงาน')).toBeVisible();
  // The reason the page is open to them at all: the customer on the phone is
  // asking for the gym's LINE.
  await expect(page.getByText('LINE ID')).toBeVisible();
  await expect(page.getByRole('button', { name: 'บันทึกการตั้งค่า' })).toHaveCount(0);
  await expect(page.getByLabel('สีหลัก', { exact: true })).toHaveCount(0);
  // They still see the card the gym is sending out.
  await expect(page.locator('.pvcard .mcard')).toBeVisible();
  await page.screenshot({ path: 'artifacts/branding-5-staff-1280.png', fullPage: true });
});

test('the settings page fits a phone, preview first', async ({ page }) => {
  await signIn(page, 'brand-admin@example.test');
  await page.setViewportSize({ width: 390, height: 844 });
  await go(page, 'ตั้งค่ายิม');
  await expect(page.getByRole('heading', { name: 'ตั้งค่ายิม' })).toBeVisible();

  // At 390 the preview comes before the form: see the result, then scroll down
  // to change it (Designer, ข้อ 6).
  const [previewTop, formTop] = await Promise.all([
    page.locator('.previewcol').evaluate(el => el.getBoundingClientRect().top + window.scrollY),
    page.locator('.sect').first().evaluate(el => el.getBoundingClientRect().top + window.scrollY),
  ]);
  expect(previewTop).toBeLessThan(formTop);
  const overflowing = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    return [...document.querySelectorAll('body *')]
      .filter(el => { const box = el.getBoundingClientRect(); return box.width && box.right > limit + 0.5; })
      .filter(el => getComputedStyle(el).position !== 'fixed')
      // The card is 1080 px of real card, scaled down inside a box that clips
      // it on purpose. What must not scroll sideways is the page.
      .filter(el => !el.closest('.pvcard'))
      .slice(0, 4).map(el => `${el.tagName.toLowerCase()}.${el.className}`);
  });
  expect(overflowing, 'หน้าตั้งค่ายิมที่ 390px ล้นขอบ').toEqual([]);
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  'ทั้งหน้าเลื่อนข้างได้ที่ 390px').toBeTruthy();
  await page.screenshot({ path: 'artifacts/branding-1-settings-390.png', fullPage: true });

  // Put the gym back the way the rest of the suite expects to find it.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByLabel('สีหลัก', { exact: true }).fill('#05603A');
  await page.getByLabel('สีหลัก', { exact: true }).blur();
  await page.getByRole('button', { name: 'บันทึกการตั้งค่า' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกการตั้งค่ายิมแล้ว' })).toBeVisible();
});
