import { test, expect } from '@playwright/test';
import { go, openUserMenu, signIn } from './counter.js';

// The menu in the corner.
//
// The left rail carried all eight destinations, which put "ผู้ใช้และสิทธิ์" --
// opened about once a month -- in the path of somebody heading for the scan
// screen for the fortieth time that shift. The four everyday screens stayed
// where the hand already goes; everything else moved here.
//
// Two things are checked that a screenshot cannot show: that a member of staff
// is not offered a screen they will be refused at, and that the menu can be
// driven without a mouse, because the counter machine has a keyboard and the
// tablet does not.

const ADMIN = 'menu-admin@example.test';
const STAFF = 'menu-staff@example.test';

/** The labels in the menu, in the order they are drawn, without their notes. */
const menuLabels = page => page.locator('#usermenu-panel [role="menuitem"]')
  .evaluateAll(items => items.map(el => {
    const note = el.querySelector('.sub')?.textContent ?? '';
    return el.textContent.replace(note, '').trim();
  }));

test('the everyday four stay on the rail and the rest move into the menu', async ({ page }) => {
  await signIn(page, ADMIN);
  await go(page, 'สมาชิก');

  const rail = await page.locator('.railnav a').allInnerTexts();
  expect(rail).toEqual(['สแกนเช็คอิน', 'สมัครสมาชิก', 'สมาชิก', 'รับเงินและมอบแพ็กเกจ']);

  await openUserMenu(page);
  const labels = await menuLabels(page);
  for (const away of ['แพ็กเกจ', 'ผู้ใช้และสิทธิ์', 'ข้อมูลยิม', 'ตั้งค่ายิม', 'ประวัติเช็คอิน']) {
    expect(labels, `${away} หายไปจากเมนู`).toContain(away);
  }
  // Approved and not built yet: shown, so "where do I report this?" has an
  // answer, but not clickable, so nothing pretends to work.
  expect(labels).toContain('แจ้งปัญหา');
  expect(labels).toContain('คู่มือการใช้งาน');
  await expect(page.getByRole('menuitem', { name: 'แจ้งปัญหา' })).toBeDisabled();
  expect(labels.at(-1)).toBe('ออกจากระบบ');
  await page.screenshot({ path: 'artifacts/menu-admin-1280.png', fullPage: true });
});

test('the menu takes you to a screen, and the screen is the one it named', async ({ page }) => {
  await signIn(page, ADMIN);
  await go(page, 'ตั้งค่ายิม');
  await expect(page.getByRole('heading', { name: 'ตั้งค่ายิม' })).toBeVisible();
  // Picking something closes it: a panel left hanging over the screen you just
  // asked for is a panel you have to dismiss before you can work.
  await expect(page.locator('#usermenu-panel')).toHaveCount(0);
});

test('a member of staff is not offered what they would be refused', async ({ page }) => {
  await signIn(page, STAFF);
  await go(page, 'สมาชิก');
  await openUserMenu(page);
  const labels = await menuLabels(page);

  // Greyed-out rows teach people to keep trying the thing that will never
  // work; the owner's screens are simply not there (Designer).
  for (const owners of ['ผู้ใช้และสิทธิ์', 'แพ็กเกจ', 'ข้อมูลยิม']) {
    expect(labels, `พนักงานไม่ควรเห็น ${owners}`).not.toContain(owners);
  }
  // What they do keep: the settings page opens read-only, because staff are
  // the ones asked "what is your LINE?" over the phone.
  expect(labels).toContain('ตั้งค่ายิม');
  expect(labels).toContain('ออกจากระบบ');
  await page.screenshot({ path: 'artifacts/menu-staff-1280.png', fullPage: true });
});

test('the menu is on the scan screen too, which is where the shift is spent', async ({ page }) => {
  await signIn(page, ADMIN);
  await expect(page.locator('.scanstage')).toBeVisible();
  await openUserMenu(page);

  // The bar is dark, so the ink on the button has to be the dark stage's, not
  // the gym's colour -- the same mistake as BRAND-03 one screen over.
  const [ink, plate] = await page.locator('.scanbar .avatar-btn').evaluate(el => {
    const style = getComputedStyle(el);
    return [style.color, getComputedStyle(el.closest('.scanstage')).backgroundColor];
  });
  const ratio = (a, b) => {
    const lum = text => {
      const [r, g, bl] = text.match(/\d+/g).map(Number);
      const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
    };
    const [x, y] = [lum(a), lum(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  expect(ratio(ink, plate), `ปุ่มเมนูบนจอสแกน ${ink} บน ${plate}`).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: 'artifacts/menu-scan-1280.png', fullPage: true });
});

test('the menu works without a mouse and gives the focus back', async ({ page }) => {
  await signIn(page, ADMIN);
  await go(page, 'สมาชิก');
  const button = await openUserMenu(page);

  // Opening a menu and leaving the focus on the button behind it is how a menu
  // becomes unreachable from a keyboard.
  const first = page.locator('#usermenu-panel [role="menuitem"]').first();
  await expect(first).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#usermenu-panel [role="menuitem"]').nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(first).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.locator('#usermenu-panel')).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
});

test('on a phone it is a sheet at the bottom, in reach of a thumb', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.setViewportSize({ width: 390, height: 844 });
  await go(page, 'สมาชิก');

  // The bar at the bottom carries the same four and nothing else: no more
  // "เพิ่มเติม" leading to a second list.
  const bar = await page.locator('.bottomnav a').allInnerTexts();
  expect(bar).toEqual(['สแกน', 'สมัคร', 'สมาชิก', 'รับเงิน']);

  await openUserMenu(page);
  const panel = page.locator('#usermenu-panel');
  const [box, height] = await Promise.all([
    panel.boundingBox(),
    page.evaluate(() => window.innerHeight),
  ]);
  // Anchored to the bottom rather than hanging off the top right corner.
  expect(height - (box.y + box.height)).toBeLessThan(40);
  expect(box.width).toBeGreaterThan(300);
  // Every row big enough to hit with a thumb.
  const shortest = await page.locator('#usermenu-panel [role="menuitem"]')
    .evaluateAll(items => Math.min(...items.map(el => el.getBoundingClientRect().height)));
  expect(shortest).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: 'artifacts/menu-admin-390.png', fullPage: true });

  // Tapping outside closes it, which on a sheet is what the dark area is for.
  await page.locator('.scrim').click({ position: { x: 20, y: 20 } });
  await expect(panel).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 900 });
});
