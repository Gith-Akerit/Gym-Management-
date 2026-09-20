import { test, expect } from '@playwright/test';
import { go, openUserMenu, scanReady, signIn } from './counter.js';

// Whether the report actually arrives with a picture.
//
// The picture is the reason this feature exists, and on the gym's machine the
// first press on any page produced a report without one -- five times out of
// five. Ten seconds of waiting, then "จับภาพหน้าจอไม่สำเร็จ". QA measured it
// apart: 42 ms of that was downloading the screenshot library and the rest was
// the library loading and compiling while the QR loop had the main thread. Most
// staff press the button once per page, so in practice almost every report the
// owner received had no picture in it (BUG-16).
//
// And when a picture did arrive, the panel announcing the capture was in the
// middle of it, over the thing being reported (BUG-17).
//
// Both are checked here against what actually comes out: the request that
// proves the library was fetched before anybody pressed anything, a capture on
// a deliberately slowed-down machine, and a pixel from underneath where the
// panel sits.

const STAFF = 'report-staff@example.test';

/** Every request the page makes for the screenshot library, as it happens. */
function watchModuleRequests(page) {
  const seen = [];
  page.on('request', request => {
    if (/\/assets\/dist-[\w-]+\.js/.test(request.url())) seen.push(Date.now());
  });
  return seen;
}

test('the screenshot library is already there before anybody presses the button', async ({ page }) => {
  const requested = watchModuleRequests(page);
  await signIn(page, STAFF);
  await scanReady(page);

  // Asked for while the counter is quiet. Nobody has opened the menu yet.
  await expect.poll(() => requested.length,
    { message: 'ต้องโหลดโมดูลจับภาพล่วงหน้า ไม่ใช่ตอนกดปุ่ม', timeout: 10000 }).toBeGreaterThan(0);
  const before = requested.length;

  // And it is kept: pressing the button does not fetch it a second time.
  await openUserMenu(page);
  await page.getByRole('menuitem', { name: /^แจ้งปัญหา/ }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'แจ้งปัญหา' }))
    .toBeVisible({ timeout: 15000 });
  expect(requested.length, 'กดแล้วต้องไม่โหลดซ้ำ ใช้ promise เดิม').toBe(before);
  await page.keyboard.press('Escape');
});

test('the member portal never pays for a button it does not have', async ({ page }) => {
  // 113 ms and 24 KB for a way to report a problem that the member's app does
  // not offer. The counter's app preloads; the portal must not.
  const requested = watchModuleRequests(page);
  await page.context().clearCookies();
  await page.goto('/m/login');
  await expect(page.getByRole('button', { name: 'เข้าสู่ระบบ' })).toBeVisible();
  await page.waitForTimeout(4000);                 // longer than the idle timeout
  expect(requested, 'หน้าสมาชิกต้องไม่โหลดโมดูลจับภาพ').toEqual([]);
});

test('a slow machine still gets its picture on the first press of a page', async ({ page }) => {
  const client = await page.context().newCDPSession(page);
  await signIn(page, STAFF);
  await scanReady(page);
  // Wait for the preload to have happened, then make the machine six times
  // slower than this one -- the condition that turned the first capture into
  // ten seconds of nothing on the gym's tablet.
  await page.waitForTimeout(2500);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 6 });

  await openUserMenu(page);
  await page.getByRole('menuitem', { name: /^แจ้งปัญหา/ }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'แจ้งปัญหา' }))
    .toBeVisible({ timeout: 20000 });
  // The first press of the page, and it has a picture. That is the whole bug.
  await expect(page.getByRole('img', { name: /ภาพหน้าจอที่ระบบจับไว้/ })).toBeVisible();
  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.keyboard.press('Escape');
});

test('the panel announcing the capture is not in the capture', async ({ page }) => {
  await signIn(page, STAFF);
  await go(page, 'สมาชิก');
  await expect(page.getByRole('heading', { name: 'สมาชิก' })).toBeVisible();
  await page.waitForTimeout(2500);                 // let the preload finish

  // A block of a colour nothing else on the screen uses, put where the panel
  // will sit. If the panel ends up in the picture, this is what it covers.
  const spot = await page.evaluate(() => {
    const mark = document.createElement('div');
    mark.id = 'capture-probe';
    mark.style.cssText = 'position:absolute;left:0;right:0;top:0;height:260px;'
      + 'background:#FF00FF;z-index:1';
    document.body.prepend(mark);
    const box = mark.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  });

  await openUserMenu(page);
  await page.getByRole('menuitem', { name: /^แจ้งปัญหา/ }).click();
  const shot = page.getByRole('img', { name: /ภาพหน้าจอที่ระบบจับไว้/ });
  await expect(shot).toBeVisible({ timeout: 20000 });

  // Read the picture the gym would receive, and look at the pixel the panel
  // was sitting on top of.
  const pixel = await page.evaluate(async ({ x, y }) => {
    const img = document.querySelector('img[alt*="ภาพหน้าจอที่ระบบจับไว้"]');
    const source = new Image();
    source.src = img.src;
    await source.decode();
    const scale = source.naturalWidth / document.documentElement.clientWidth;
    const canvas = document.createElement('canvas');
    canvas.width = source.naturalWidth;
    canvas.height = source.naturalHeight;
    canvas.getContext('2d').drawImage(source, 0, 0);
    const [r, g, b] = canvas.getContext('2d')
      .getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data;
    return { r, g, b };
  }, spot);

  // Magenta: what was on the screen. The panel is a white card on a dark
  // scrim, so if it had been captured this pixel would be neither.
  expect(pixel.r, `สีที่ได้ rgb(${pixel.r},${pixel.g},${pixel.b})`).toBeGreaterThan(200);
  expect(pixel.g).toBeLessThan(80);
  expect(pixel.b).toBeGreaterThan(200);

  await page.keyboard.press('Escape');
  await page.evaluate(() => document.getElementById('capture-probe')?.remove());
});
