import { test, expect } from '@playwright/test';
import { openUserMenu, scanReady, signIn } from './counter.js';

// Pressing "แจ้งปัญหา" while the lens is reading.
//
// The team's own report spec already walks the scan stage and passed on the
// very build where this was broken -- QA ran it and watched it go green in
// four seconds while the real machine sat on "กำลังจับภาพหน้าจอ…" for over
// three minutes with no way out but a reload (BUG-14). The difference was the
// QR loop: the spec reached the scan screen, but not with a camera decoding
// frames as fast as the browser allows.
//
// So this one insists on the conditions rather than the screen:
//
//   * `BarcodeDetector` is removed before the page loads, which forces the
//     jsQR path -- the expensive one, reading every frame into a canvas and
//     hunting it. That is the loop QA's evidence implicates.
//   * the video is actually playing, with real dimensions, before anything is
//     pressed. A camera that never started is the state that made the old
//     spec pass.
//
// Then it checks the three answers: the loop stops decoding while the picture
// is taken and starts again afterwards, the wait has a way out of it, and a
// capture somebody gave up on cannot reopen itself later on top of their work.

const STAFF = 'report-staff@example.test';

/** Chrome has BarcodeDetector; the gym's tablets mostly do not. Take the slow road. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { delete window.BarcodeDetector; });
});

/** The scan screen with the lens genuinely reading, which is the whole point. */
async function scanningForReal(page) {
  await signIn(page, STAFF);
  await scanReady(page);
  const camera = page.locator('.cam video');
  await expect(camera).toBeVisible();
  // Not "a video element exists" -- frames are arriving and have a size, so
  // the decode loop has something to chew on every frame.
  await expect.poll(async () => camera.evaluate(el => el.videoWidth * el.videoHeight),
    { message: 'กล้องจำลองต้องส่งภาพจริงก่อน ไม่งั้นเทสต์นี้ไม่ได้ตรวจอะไร' }).toBeGreaterThan(0);
  await expect(page.locator('.cam[data-scanning="live"]')).toBeVisible();
}

/** Every value `data-scanning` takes from now on, recorded as it happens. */
async function watchScanState(page) {
  await page.evaluate(() => {
    window.__scanStates = [];
    const box = document.querySelector('.cam');
    window.__scanWatch = new MutationObserver(() => {
      window.__scanStates.push(document.querySelector('.cam')?.dataset.scanning ?? 'gone');
    });
    window.__scanWatch.observe(box, { attributes: true, attributeFilter: ['data-scanning'] });
  });
}

test('the picture is taken while the lens is reading, and the lens comes back', async ({ page }) => {
  await scanningForReal(page);
  await watchScanState(page);

  await openUserMenu(page);
  await page.getByRole('menuitem', { name: /^แจ้งปัญหา/ }).click();

  // The answer arrives. On the gym's machine it never did.
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'แจ้งปัญหา' }))
    .toBeVisible({ timeout: 15000 });
  // With a picture, or with the sentence that says there is none: the first
  // capture on a cold page loads the screenshot library while the camera is
  // running, and on a slow machine that can outlast the eight-second clock.
  // Both endings are answers; the hang was not.
  await expect(page.getByRole('img', { name: /ภาพหน้าจอที่ระบบจับไว้/ })
    .or(page.getByText(/จับภาพหน้าจอไม่สำเร็จ/)).first()).toBeVisible();

  // And it was taken with the loop held: this is the fix at the cause, not the
  // timeout that catches it afterwards.
  const states = await page.evaluate(() => window.__scanStates);
  expect(states, 'ลูปอ่าน QR ต้องถูกพักระหว่างจับภาพ').toContain('paused');

  await page.getByLabel(/ใช้ไม่ได้อย่างไร/).fill('สแกนบัตรแล้วไม่ขึ้นชื่อ ขณะกล้องเปิดอยู่');
  await page.getByRole('button', { name: 'ส่งเรื่อง' }).click();
  await expect(page.getByRole('dialog')).toContainText('ส่งเรื่องแล้ว');
  await page.getByRole('button', { name: 'กลับไปทำงานต่อ' }).click();

  // Back to work, reading cards again. A flag left set is a camera that never
  // reads another member in, and nothing on screen would say why.
  await expect(page.locator('.cam[data-scanning="live"]')).toBeVisible();
  await expect(page.locator('.cam video')).toBeVisible();
});

test('the wait has a way out, and what was cancelled stays cancelled', async ({ page }) => {
  await scanningForReal(page);
  await openUserMenu(page);
  await page.getByRole('menuitem', { name: /^แจ้งปัญหา/ }).click();

  // The panel that covered every control underneath it now carries the way
  // out. Whether the capture is still running or already finished, one of the
  // two is on screen and neither is a dead end.
  const cancel = page.getByRole('button', { name: 'ยกเลิก' });
  const dialog = page.getByRole('dialog').getByRole('heading', { name: 'แจ้งปัญหา' });
  await expect(cancel.or(dialog).first()).toBeVisible();
  if (await cancel.isVisible()) {
    await cancel.click();
    // Straight back to work: the scan screen, the camera, no panel over it.
    await expect(page.locator('.cam[data-scanning="live"]')).toBeVisible();
    await expect(page.getByText('กำลังจับภาพหน้าจอ…')).toHaveCount(0);
    // And the capture that was abandoned does not surface a minute later on
    // top of whatever the person went on to do.
    await page.waitForTimeout(3000);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } else {
    // The capture beat the click. The screen is the form, which is the other
    // acceptable end of this -- never a panel with nothing on it.
    await expect(dialog).toBeVisible();
  }
  await expect(page.locator('.scanstage')).toBeVisible();
});

test('a screenshot library that will not load hands the lens back', async ({ page }) => {
  // BUG-15, QA's own reproduction: the chunk that draws the picture fails to
  // load -- a tab left open across a deploy pointing at a hashed filename that
  // no longer exists, or a tablet off the wifi for one second. The form must
  // still open (it did), and the lens must start reading again (it did not:
  // the flag was set before the import and released only after it, so a failed
  // import left the camera live, the screen normal, and every card held up to
  // it ignored until somebody reloaded the page).
  await page.route('**/assets/dist-*.js', route => route.abort());
  await scanningForReal(page);
  await watchScanState(page);

  await openUserMenu(page);
  await page.getByRole('menuitem', { name: /^แจ้งปัญหา/ }).click();

  // The form arrives, saying plainly that there is no picture with it.
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'แจ้งปัญหา' }))
    .toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/จับภาพหน้าจอไม่สำเร็จ/)).toBeVisible();
  await page.keyboard.press('Escape');

  // The whole point: back to reading cards, not a camera that looks alive and
  // sees nothing.
  await expect(page.locator('.cam[data-scanning="live"]')).toBeVisible();
  const states = await page.evaluate(() => window.__scanStates);
  expect(states.at(-1), `ลำดับที่เห็น: ${states.join(' → ')}`).toBe('live');
});

test('the pause is something a person can see, not only a test', async ({ page }) => {
  await scanningForReal(page);
  // The badge is what somebody holding a card up to a camera that has stopped
  // reading needs: an explanation, and a promise that it comes back. Recorded
  // as it happens rather than looked for afterwards, because how long a
  // capture takes depends on the machine.
  await expect(page.locator('.campause')).toHaveCount(0);
  await page.evaluate(() => {
    window.__badge = [];
    const box = document.querySelector('.cam');
    new MutationObserver(() => {
      const el = box.querySelector('.campause');
      if (!el) return;
      const rect = el.getBoundingClientRect();
      window.__badge.push({ text: el.textContent.trim(), w: Math.round(rect.width), h: Math.round(rect.height) });
    }).observe(box, { childList: true, subtree: true });
  });

  await openUserMenu(page);
  await page.getByRole('menuitem', { name: /^แจ้งปัญหา/ }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'แจ้งปัญหา' }))
    .toBeVisible({ timeout: 15000 });

  const seen = await page.evaluate(() => window.__badge);
  expect(seen.length, 'ต้องมีป้ายบอกว่าพักการอ่านบัตรระหว่างจับภาพ').toBeGreaterThan(0);
  expect(seen[0].text).toContain('พักการอ่านบัตรชั่วคราว');
  // Drawn, not merely present: a zero-sized element explains nothing.
  expect(seen[0].w).toBeGreaterThan(80);
  expect(seen[0].h).toBeGreaterThan(20);

  await page.keyboard.press('Escape');
  // Gone again the moment the lens is back, or it becomes a sign nobody reads.
  await expect(page.locator('.campause')).toHaveCount(0);
  await expect(page.locator('.cam[data-scanning="live"]')).toBeVisible();
});
