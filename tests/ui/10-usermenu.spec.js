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
  // The help group: reporting a problem, the owner's list of what was
  // reported, and the staff guide.
  expect(labels).toContain('แจ้งปัญหา');
  expect(labels).toContain('เรื่องที่แจ้งไว้');
  expect(labels).toContain('คู่มือการใช้งาน');
  await expect(page.getByRole('menuitem', { name: /^แจ้งปัญหา/ })).toBeEnabled();
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

// The ink on the panel, and on the button, once the surface underneath can
// change out from under both.
//
// This is the fourth time the same root has produced a bug: a colour is left
// to be inherited, and then something changes what it is inherited from. The
// panel paints its own white background but sat inside the dark scan stage, so
// the email in its header was white on white. The menu button was written
// after the "app bar in the gym's colour" block and was never added to it.
const ratio = (a, b) => {
  const lum = text => {
    const [r, g, bl] = text.match(/\d+/g).map(Number);
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
  };
  const [x, y] = [lum(a), lum(b)];
  return +((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2);
};

/** Every line of text in the open panel, against the colour behind it. */
const panelInk = page => page.evaluate(() => {
  const behind = el => {
    for (let node = el; node; node = node.parentElement) {
      const colour = getComputedStyle(node).backgroundColor;
      if (colour && !/, 0\)$/.test(colour)) return colour;
    }
    return 'rgb(255, 255, 255)';
  };
  return [...document.querySelectorAll('#usermenu-panel .who b, #usermenu-panel .who span,'
    + '#usermenu-panel .gl, #usermenu-panel [role="menuitem"]')]
    .filter(el => el.textContent.trim())
    .map(el => ({ text: el.textContent.trim().slice(0, 20), ink: getComputedStyle(el).color, on: behind(el) }));
});

test('every line in the panel is readable, including on the dark scan stage', async ({ page }) => {
  await signIn(page, ADMIN);
  // The scan stage sets a white ink on the whole branch; the panel puts a pale
  // surface inside it, so it has to set its own ink back.
  await expect(page.locator('.scanstage')).toBeVisible();
  await openUserMenu(page);

  const failures = [];
  for (const line of await panelInk(page)) {
    const seen = ratio(line.ink, line.on);
    if (seen < 4.5) failures.push(`"${line.text}" ${line.ink} บน ${line.on} = ${seen}:1`);
  }
  expect(failures, failures.join('\n')).toEqual([]);
});

test('the menu button follows the app bar into the gym colour', async ({ page }) => {
  await signIn(page, ADMIN);
  await go(page, 'ตั้งค่ายิม');
  // Off by default, which is why this went unseen: it only appears once an
  // owner ticks the box.
  await page.getByLabel(/ทำหัวแอปเป็นสีแบรนด์/).check();
  await page.getByRole('button', { name: 'บันทึกการตั้งค่า' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกการตั้งค่ายิมแล้ว' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.body.dataset.appbar)).toBe('brand');

  const lines = await page.locator('.appbar .avatar-btn').evaluate(el => {
    const bar = getComputedStyle(el.closest('.appbar')).backgroundColor;
    return [...el.querySelectorAll('.cav, .cav span')]
      .map(part => ({ ink: getComputedStyle(part).color, opacity: getComputedStyle(part).opacity, bar }));
  });
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    // Full opacity, always: the token guarantees 4.5:1 at full strength and
    // nothing below it (Designer).
    expect(line.opacity, 'ปุ่มเมนูใช้ opacity ลดความทึบ').toBe('1');
    expect(ratio(line.ink, line.bar), `${line.ink} บน ${line.bar}`).toBeGreaterThanOrEqual(4.5);
  }
  await page.screenshot({ path: 'artifacts/menu-brand-appbar-1280.png', fullPage: true });

  // Put the app bar back the way the rest of the suite expects to find it.
  await page.getByLabel(/ทำหัวแอปเป็นสีแบรนด์/).uncheck();
  await page.getByRole('button', { name: 'บันทึกการตั้งค่า' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกการตั้งค่ายิมแล้ว' })).toBeVisible();
});

test('the gym name gets out of the way on a narrow scan bar', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.scanbar')).toBeVisible();
  // At 390 the name had 24 px to live in, which drew "สุ…" -- less use than
  // nothing, and it was pushing the controls that matter.
  await expect(page.locator('.scanbar .brand')).toBeHidden();
  await expect(page.getByRole('button', { name: 'เมนู', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ไปหน้าจัดการ' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/menu-scan-390.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
});
