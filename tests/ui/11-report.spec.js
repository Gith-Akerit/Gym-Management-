import { test, expect } from '@playwright/test';
import { go, openUserMenu, signIn } from './counter.js';

// Reporting what just went wrong, from the screen it went wrong on.
//
// The thing this spec exists to hold still is the ORDER: the picture is taken
// before the box opens. Get that backwards and every report in the system is a
// photograph of the report form, which looks fine in a demo and is worthless
// on the day somebody needs it.
//
// The second thing is that a report never depends on the picture. The capture
// fails on some browsers, some people switch it off because a member's face is
// on the screen, and the network is worst exactly when the problems happen --
// in all three cases the sentence somebody typed has to survive.

const ADMIN = 'report-admin@example.test';
const STAFF = 'report-staff@example.test';

/** Opens the corner menu and presses แจ้งปัญหา, then waits for the form. */
async function openReport(page) {
  await openUserMenu(page);
  await page.getByRole('menuitem', { name: /^แจ้งปัญหา/ }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'แจ้งปัญหา' })).toBeVisible();
}

test('the picture is of the screen, not of the box that asks about it', async ({ page }) => {
  await signIn(page, STAFF);
  await go(page, 'สมัครสมาชิก');
  await openReport(page);

  const shot = page.getByRole('img', { name: /ภาพหน้าจอที่ระบบจับไว้/ });
  await expect(shot).toBeVisible();
  // The capture is a data URL drawn from the DOM, so it can be looked at: the
  // form that is on top right now must not be in it.
  const drawn = await shot.evaluate(el => new Promise(done => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
      done({ width: canvas.width, height: canvas.height });
    };
    image.onerror = () => done(null);
    image.src = el.src;
  }));
  expect(drawn, 'ภาพที่จับได้เปิดไม่ได้').not.toBeNull();
  expect(drawn.width).toBeGreaterThan(200);

  // What the screen promises about the ordering, said where somebody can read it.
  await expect(page.getByText('ระบบจับภาพก่อนเปิดกล่องนี้เสมอ')).toBeVisible();
  // And the page it was taken on is filled in without anybody typing it.
  await expect(page.getByRole('dialog')).toContainText('สมัครสมาชิก');
  await page.screenshot({ path: 'artifacts/report-form-1280.png', fullPage: true });
});

test('one field is required, and it is the one a picture cannot answer', async ({ page }) => {
  await signIn(page, STAFF);
  await go(page, 'สมาชิก');
  await openReport(page);

  const send = page.getByRole('button', { name: 'ส่งเรื่อง' });
  await expect(send).toBeDisabled();
  await page.getByLabel(/ใช้ไม่ได้อย่างไร/).fill('กดปุ่มบันทึกแล้วหมุนค้าง ไม่ขึ้นอะไรเลย');
  await expect(send).toBeEnabled();

  // Everything that travels with it is shown before it is sent, not after.
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('แนบไปด้วยอัตโนมัติ');
  await expect(dialog).toContainText(STAFF);

  await send.click();
  await expect(dialog).toContainText('ส่งเรื่องแล้ว');
  await expect(dialog).toContainText(/เรื่อง #\d+/);
  // Said plainly: a member is still standing at the counter.
  await expect(dialog).toContainText('เรื่องนี้ยังไม่ได้แก้ให้คุณตอนนี้');
  await page.screenshot({ path: 'artifacts/report-sent-1280.png', fullPage: true });
  await page.getByRole('button', { name: 'กลับไปทำงานต่อ' }).click();
  await expect(dialog).toHaveCount(0);
});

test('the report goes without the picture when the person says so', async ({ page }) => {
  await signIn(page, STAFF);
  await go(page, 'สมาชิก');
  await openReport(page);

  // The tick is on by default and says who can see the picture, because the
  // screen behind it usually has a member's name and face on it.
  const tick = page.getByLabel(/ส่งภาพหน้าจอไปด้วย/);
  await expect(tick).toBeChecked();
  await expect(page.getByRole('dialog')).toContainText('เจ้าของยิมเท่านั้นที่เปิดดูได้');
  await tick.uncheck();

  await page.getByLabel(/ใช้ไม่ได้อย่างไร/).fill('ไม่อยากส่งภาพเพราะมีชื่อลูกค้าอยู่บนจอ');
  await page.getByRole('button', { name: 'ส่งเรื่อง' }).click();
  await expect(page.getByRole('dialog')).toContainText('ส่งเรื่องแล้ว');
  await page.getByRole('button', { name: 'กลับไปทำงานต่อ' }).click();
});

test('a report written during an outage is kept and sent when the line comes back', async ({ page, context }) => {
  await signIn(page, STAFF);
  await go(page, 'สมาชิก');
  await openReport(page);
  await page.getByLabel(/ใช้ไม่ได้อย่างไร/).fill('เน็ตหลุดตอนกำลังรับเงิน');

  // The problems worth reporting happen when the network is bad. Losing the
  // sentence at that moment is the worst outcome this screen can have.
  await context.setOffline(true);
  await page.getByRole('button', { name: 'ส่งเรื่อง' }).click();
  await expect(page.getByRole('dialog')).toContainText('เก็บเรื่องไว้ในเครื่องแล้ว');
  await page.screenshot({ path: 'artifacts/report-offline-1280.png', fullPage: true });
  await page.getByRole('button', { name: 'กลับไปทำงานต่อ' }).click();

  // The menu says so, so an outage does not look like nothing happening.
  await openUserMenu(page);
  await expect(page.getByRole('menuitem', { name: /แจ้งปัญหา \(รอส่ง 1\)/ })).toBeVisible();
  await page.keyboard.press('Escape');

  await context.setOffline(false);
  await page.reload();
  await expect.poll(async () => {
    await openUserMenu(page);
    const label = await page.getByRole('menuitem', { name: /^แจ้งปัญหา/ }).innerText();
    await page.keyboard.press('Escape');
    return label;
  }, { timeout: 15000 }).not.toContain('รอส่ง');
});

test('the owner reads them back, and staff cannot', async ({ page }) => {
  // Staff send them; the pictures have members on them, so the list is not
  // offered to staff at all rather than offered and refused.
  await signIn(page, STAFF);
  await go(page, 'สมาชิก');
  await openUserMenu(page);
  await expect(page.getByRole('menuitem', { name: 'เรื่องที่แจ้งไว้', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Two different people on the same tablet, which is the normal case here.
  await page.context().clearCookies();
  await signIn(page, ADMIN);
  await go(page, 'เรื่องที่แจ้งไว้');
  await expect(page.getByRole('heading', { name: 'เรื่องที่แจ้งไว้' })).toBeVisible();

  const first = page.locator('.rep').first();
  await expect(first).toBeVisible();
  // New reports are marked without having to read them, and the picture is in
  // the list so five reports do not become five round trips.
  await expect(first).toHaveClass(/unread/);
  await page.screenshot({ path: 'artifacts/report-list-1280.png', fullPage: true });

  // Open one that has a picture -- some reports deliberately have none, and
  // the picture is the half of this screen with the privacy rules on it.
  const withPicture = page.locator('.rep').filter({ has: page.locator('img') }).first();
  await expect(withPicture).toBeVisible();
  await withPicture.getByRole('button', { name: 'เปิดดู' }).click();
  await expect(page.getByRole('heading', { name: /^เรื่อง #\d+$/ })).toBeVisible();
  await expect(page.getByText('ระบบบันทึกทุกครั้งที่มีคนเปิดดูภาพนี้')).toBeVisible();

  await page.getByLabel('สถานะ').selectOption('reading');
  await page.getByLabel('บันทึกภายใน').fill('ถามคนติดตั้งแล้ว รอตอบ');
  await expect(page.getByText('ผู้แจ้งไม่เห็นข้อความนี้')).toBeVisible();
  await page.getByRole('button', { name: 'บันทึก', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกแล้ว' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/report-detail-1280.png', fullPage: true });
});

test('the menu opens the staff guide', async ({ page }) => {
  await signIn(page, ADMIN);
  await go(page, 'สมาชิก');
  await openUserMenu(page);
  const [manual] = await Promise.all([
    page.context().waitForEvent('page'),
    page.getByRole('menuitem', { name: /^คู่มือการใช้งาน/ }).click(),
  ]);
  // Served out of the repository, so the manual on the machine is the manual
  // for the version on the machine.
  expect(new URL(manual.url()).pathname).toBe('/manual.pdf');
  await manual.close();
});

test('it works on the scan stage too, where the shift is actually spent', async ({ page }) => {
  await signIn(page, STAFF);
  await expect(page.locator('.scanstage')).toBeVisible();
  await openReport(page);
  await expect(page.getByRole('dialog')).toContainText('สแกนเช็คอิน');
  await page.getByLabel(/ใช้ไม่ได้อย่างไร/).fill('สแกนบัตรแล้วไม่ขึ้นชื่อ');
  await page.getByRole('button', { name: 'ส่งเรื่อง' }).click();
  await expect(page.getByRole('dialog')).toContainText('ส่งเรื่องแล้ว');
  await page.screenshot({ path: 'artifacts/report-scan-1280.png', fullPage: true });
  await page.getByRole('button', { name: 'กลับไปทำงานต่อ' }).click();
});

test('the form fits a phone', async ({ page }) => {
  await signIn(page, STAFF);
  await page.setViewportSize({ width: 390, height: 844 });
  await go(page, 'สมาชิก');
  await openReport(page);
  await page.getByLabel(/ใช้ไม่ได้อย่างไร/).fill('ทดสอบบนมือถือ');

  const overflowing = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    return [...document.querySelectorAll('.sheet *')]
      .filter(el => { const box = el.getBoundingClientRect(); return box.width && box.right > limit + 0.5; })
      .slice(0, 4).map(el => `${el.tagName.toLowerCase()}.${el.className}`);
  });
  expect(overflowing, 'กล่องแจ้งปัญหาที่ 390px ล้นขอบ').toEqual([]);
  await page.screenshot({ path: 'artifacts/report-form-390.png', fullPage: true });
  // Scoped to the dialog: the screen underneath has a ยกเลิก of its own.
  await page.getByRole('dialog').getByRole('button', { name: 'ยกเลิก' }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
});
