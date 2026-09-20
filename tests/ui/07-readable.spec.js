import { test, expect } from '@playwright/test';
import { contrastIn, go, PASSWORD, scanReady, signIn, tooFaint } from './counter.js';

// Things a test with an accessible name in its hand cannot see.
//
// Every earlier spec found the sign-in fields with getByLabel and passed while
// the labels were white on white: the name was in the DOM, the contrast was
// 1.0, and the owner opened the page to two unlabelled boxes (QA UI-01). These
// measure what a person would actually see -- the colour of the pixels, and
// how tall the thing they have to hit with a thumb is.

/** Everything a finger has to land on, with the height it was given. */
function tapTargets(page) {
  return page.evaluate(() => Array.from(
    document.querySelectorAll('input:not([type=hidden]):not([type=file]), select, button, a.btn, .btn'))
    .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
    .map(el => ({
      // A checkbox is 24px of box inside a label you tap anywhere on, so the
      // row is the target, not the box.
      what: `${el.tagName.toLowerCase()}${el.type ? `[${el.type}]` : ''} ` +
        `${el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 24) || el.id || ''}`.trim(),
      height: Math.round((el.closest('label.check-row') ?? el).getBoundingClientRect().height),
    })));
}

/** Sets the gym colour the way the settings screen will: from the app itself. */
const paint = (page, colour) => page.evaluate(async hex => {
  const headers = { 'Content-Type': 'application/json', 'X-Gym-Client': 'web' };
  // A save carries the version it opened with, or the server refuses it: it
  // has no way to tell a first save from one that would put back a colour
  // somebody at another tablet just changed.
  const { version } = await (await fetch('/api/gym/settings', { credentials: 'include', headers })).json();
  const response = await fetch('/api/gym/settings', {
    method: 'PUT', credentials: 'include', headers,
    body: JSON.stringify({ color_primary: hex, version }),
  });
  return response.status;
}, colour);

const tooSmall = found => found.filter(item => item.height < 44);

test('every label on the sign-in screen can actually be read', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'เข้าสู่ระบบ' })).toBeVisible();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const faint = tooFaint(await contrastIn(page));
    expect(faint, `หน้าเข้าสู่ระบบ at ${width}px has text below 4.5:1`).toEqual([]);
  }
  // Named explicitly, because these two are the ones that were invisible and a
  // general sweep can quietly stop covering them.
  const labels = await page.locator('.authcard label').allInnerTexts();
  expect(labels).toEqual(['อีเมล', 'รหัสผ่าน']);
});

test('every label on the set-password screen can actually be read', async ({ page, request }) => {
  const issued = await request.post('/__test/setup-link', {
    data: { email: 'contrast-ui@example.test' }, headers: { 'X-Gym-Client': 'web' },
  });
  const { token } = await issued.json();
  await page.goto(`/?setpw=${token}`);
  await expect(page.getByRole('button', { name: 'บันทึกรหัสผ่าน' })).toBeVisible();

  // The screen the gym owner opens from a link in a chat, on a phone, once.
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const faint = tooFaint(await contrastIn(page));
    expect(faint, `หน้าตั้งรหัสผ่าน at ${width}px has text below 4.5:1`).toEqual([]);
  }
  expect(await page.locator('.authcard label').allInnerTexts()).toEqual(['รหัสผ่านใหม่', 'พิมพ์รหัสผ่านอีกครั้ง']);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/ui-setpassword-390.png', fullPage: true });
});

test('the counter screens can be read once somebody is signed in', async ({ page }) => {
  await signIn(page, 'contrast2-ui@example.test', PASSWORD);
  await page.setViewportSize({ width: 390, height: 844 });
  await scanReady(page);
  // The dark stage is the other direction: white on near-black, and the same
  // rule has to hold there.
  expect(tooFaint(await contrastIn(page)), 'หน้าสแกน').toEqual([]);

  for (const tab of ['สมาชิก', 'สมัครสมาชิก', 'รับเงินและมอบแพ็กเกจ', 'ผู้ใช้และสิทธิ์', 'ข้อมูลยิม']) {
    await go(page, tab);
    expect(tooFaint(await contrastIn(page)), tab).toEqual([]);
  }
});

test('a thumb can hit every control on a phone', async ({ page }) => {
  await signIn(page, 'contrast2-ui@example.test');
  await page.setViewportSize({ width: 390, height: 844 });

  // The role dropdown in the users table was 21px tall, and it is the control
  // that decides what somebody is allowed to do.
  await go(page, 'ผู้ใช้และสิทธิ์');
  await expect(page.getByRole('heading', { name: 'ผู้ใช้และสิทธิ์' })).toBeVisible();
  expect(tooSmall(await tapTargets(page)), 'หน้าผู้ใช้และสิทธิ์').toEqual([]);

  await go(page, 'ข้อมูลยิม');
  await expect(page.getByLabel('เวลาเปิดวันจันทร์')).toBeVisible();
  expect(tooSmall(await tapTargets(page)), 'หน้าข้อมูลยิม').toEqual([]);
  await page.screenshot({ path: 'artifacts/ui-gym-390.png', fullPage: true });
});

test('the gym own colour reaches the screen, and stays readable there', async ({ page }) => {
  // 07 runs last, so this is the one spec that may repaint the whole app.
  await signIn(page, 'contrast2-ui@example.test');
  await scanReady(page);
  const token = name => page.evaluate(key =>
    getComputedStyle(document.documentElement).getPropertyValue(key).trim().toUpperCase(), name);
  const accent = () => token('--brand-surface');
  expect(await accent()).toBe('#05603A');

  // A bright yellow: the case where white text would disappear and the server
  // has to hand back black instead.
  // Through the page rather than the API context: the session cookie is
  // SameSite=Strict, which is exactly what stops anything but the app itself
  // from using it.
  expect(await paint(page, '#FFD400')).toBe(200);
  await page.reload();
  await scanReady(page);
  expect(await accent()).toBe('#FFD400');
  expect(await token('--on-brand')).toBe('#0E1418');
  // The colour that means "passed" is the system's, not the gym's: a red gym
  // must not turn the "ใช้งานอยู่" chip red (Designer, ข้อ 3).
  expect(await token('--ok')).toBe('#05603A');

  // The colours are the gym's, the contrast rule is still the app's.
  await go(page, 'สมาชิก');
  expect(tooFaint(await contrastIn(page)), 'หน้าสมาชิกด้วยสีของยิม').toEqual([]);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(tooFaint(await contrastIn(page)), `หน้าสมาชิกด้วยสีของยิม at ${width}px`).toEqual([]);
    await page.screenshot({ path: `artifacts/ui-branding-${width}.png`, fullPage: true });
  }

  // Put it back, so a rerun of the suite starts where this one did.
  expect(await paint(page, '#05603A')).toBe(200);
});
