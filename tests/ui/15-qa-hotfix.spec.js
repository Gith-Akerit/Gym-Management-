import { test, expect } from '@playwright/test';
import { cardToken, go, PNG_PIXEL, scan, signIn, signUpMember } from './counter.js';

// What QA found on the real machine, kept fixed.
//
// Every test here is a bug somebody hit while using this at a counter, not a
// thing we thought might go wrong. The two at the top are the pair that could
// send a member home with a card that has no face on it, which is the one
// thing the card exists to prevent.

test('a photograph the counter takes can actually be seen', async ({ page }) => {
  // BUG-01: helmet's default img-src is `'self' data:`, so every blob: preview
  // in the app was blocked. On screen that was an empty black frame beside the
  // words "รูปถ่ายเรียบร้อย" -- no error, no clue, nothing to act on.
  const blocked = [];
  page.on('console', message => {
    if (/Content Security Policy/i.test(message.text())) blocked.push(message.text());
  });

  await signIn(page, 'hotfix-admin@example.test');
  await go(page, 'สมัครสมาชิก');
  await page.getByLabel('เลือกรูปจากเครื่องแทน')
    .setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: PNG_PIXEL });

  const shot = page.locator('.photoframe img');
  await expect(shot).toBeVisible();
  // Visible is not enough: a blocked image is still a visible element with a
  // zero-height box and the alt text showing.
  expect(await shot.evaluate(img => img.naturalWidth), 'รูปถูก CSP บล็อก').toBeGreaterThan(0);
  expect(blocked, 'ไม่ควรมีอะไรถูก CSP บล็อกในเส้นทางถ่ายรูป').toEqual([]);
});

test('the shutter does not pretend the camera is ready, and leaving without a photo asks first', async ({ page }) => {
  // BUG-02: a real USB camera takes two to three seconds to produce a first
  // frame. The frame was black, the shutter was live, and pressing it returned
  // silently. A member was signed up with no photograph during the test.
  await signIn(page, 'hotfix-admin@example.test');
  await go(page, 'สมัครสมาชิก');

  // Nothing taken yet, and the frame says so rather than being a black box
  // that could equally mean "camera on, your face is not in it".
  await expect(page.getByText('ยังไม่ได้ถ่ายรูป', { exact: false })).toBeVisible();

  // Moving on with an empty frame is still allowed -- a broken camera must not
  // stop somebody being signed up -- but it is a decision now, and it says
  // what it costs.
  await page.getByRole('button', { name: 'ถัดไป · ชื่อและเบอร์' }).click();
  await expect(page.getByText('ยังไม่มีรูปถ่าย', { exact: false })).toBeVisible();
  await expect(page.getByText(/ใครยืมไปก็เข้าได้/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ชื่อและเบอร์ติดต่อ' })).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/hotfix-no-photo-warning-1280.png', fullPage: true });

  await page.getByRole('button', { name: 'ไปต่อโดยไม่มีรูป' }).click();
  await expect(page.getByRole('heading', { name: 'ชื่อและเบอร์ติดต่อ' })).toBeVisible();
});

test('"already checked in" is not painted like a refusal', async ({ page }) => {
  // BUG-03: duplicate shared the refusal's red. A new member of staff reads
  // red and turns away a customer who is entitled to walk in -- and the list
  // underneath was already drawing it as a third, neutral state, so the screen
  // disagreed with itself.
  await signIn(page, 'hotfix-admin@example.test');
  await signUpMember(page, { name: 'ซ้ำ ทดสอบสี', phone: '0893330099', pkg: /รายเดือน Unlimited/ });
  const member = await cardToken(page, 'ซ้ำ ทดสอบสี');

  await scan(page, member.qr, { device: 'เคาน์เตอร์ hotfix' });
  const result = page.locator('.result');
  await expect(result).toContainText('เข้าใช้บริการได้');
  const allowed = await result.evaluate(node => getComputedStyle(node).backgroundColor);

  await page.getByRole('button', { name: 'ยืนยันให้เข้า · สแกนคนถัดไป' }).click();
  await scan(page, member.qr);
  await expect(result).toContainText('เช็คอินไปแล้ว');

  // A third colour: neither the pass nor the refusal.
  await expect(result).toHaveClass(/again/);
  await expect(result).not.toHaveClass(/deny/);
  const again = await result.evaluate(node => getComputedStyle(node).backgroundColor);
  expect(again).not.toBe(allowed);

  // And the button still says the person may come in, which is the thing a
  // new member of staff is looking for.
  await expect(page.getByRole('button', { name: 'ยืนยันให้เข้า · สแกนคนถัดไป' })).toBeVisible();
  await expect(page.getByText('คนนี้เข้าได้ ระบบแค่บันทึกไปแล้วรอบนี้')).toBeVisible();
  await page.screenshot({ path: 'artifacts/hotfix-duplicate-colour-1280.png', fullPage: true });
});

test('the lens stops once there is an answer, so history is not a wall of duplicates', async ({ page }) => {
  // BUG-04: the loop kept reading the card that was still being held up while
  // staff compared the photograph to the face -- which takes longer than four
  // seconds every time -- and each read wrote another row. One day's history
  // was 15 duplicates to 3 real entries.
  await signIn(page, 'hotfix-admin@example.test');
  await signUpMember(page, { name: 'ลูป หยุดสแกน', phone: '0893330098', pkg: /รายเดือน Unlimited/ });
  const member = await cardToken(page, 'ลูป หยุดสแกน');

  await scan(page, member.qr, { device: 'เคาน์เตอร์ hotfix' });
  await expect(page.locator('.result')).toContainText('เข้าใช้บริการได้');
  // The camera is off while the answer is on screen, and the frame says so
  // rather than looking broken.
  await expect(page.getByText('หยุดสแกนไว้ก่อน', { exact: false })).toBeVisible();
  await expect(page.locator('.cam .laser')).toHaveCount(0);

  // Long enough that the old four-second loop would have fired twice.
  await page.waitForTimeout(9000);
  const rows = await (await page.request.get('/api/check-ins?scope=all')).json();
  const mine = rows.items.filter(row => row.member_name === 'ลูป หยุดสแกน');
  expect(mine.length, 'ถือบัตรค้างหน้ากล้องต้องไม่เขียนแถวซ้ำ').toBe(1);
});

test('the package code rule is on the screen before the press, not after it', async ({ page }) => {
  // QA จุดสะดุด 5: somebody typed QA-TEST-PKG1, pressed save, and had it
  // thrown back by a rule nothing had mentioned.
  await signIn(page, 'hotfix-admin@example.test');
  await go(page, 'แพ็กเกจ');
  await page.getByRole('button', { name: 'เพิ่มแพ็กเกจ' }).click();
  await expect(page.getByText(/ห้ามมีขีด/)).toBeVisible();
  await expect(page.getByText(/MONTH_30D/)).toBeVisible();
});

test('the pilot banner is one line and says what staff CAN do', async ({ page }) => {
  // QA จุดสะดุด 1: two full lines on a 390 screen, on every screen, saying
  // "no PromptPay account linked" -- which reads as "this system is not live
  // yet" to somebody who is about to take cash across the counter.
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, 'hotfix-admin@example.test');
  await go(page, 'สมาชิก');
  const banner = page.locator('.pilot-banner');
  if (await banner.count()) {
    await expect(banner).toContainText('รับเงินสด/โอนนอกระบบได้ตามปกติ');
    const height = await banner.evaluate(node => node.getBoundingClientRect().height);
    expect(height, 'แถบโหมดทดลองต้องเหลือบรรทัดเดียว').toBeLessThan(44);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('the browser tab and the phone status bar wear the gym colour', async ({ page }) => {
  // BUG-08: both were baked into index.html before this gym had a name or a
  // colour, so Android painted the top of the screen the old green.
  await page.goto('/');
  await expect.poll(() => page.title(), { message: 'ชื่อแท็บต้องเป็นชื่อยิม' })
    .not.toBe('ระบบจัดการยิม');
  const theme = await page.locator('meta[name="theme-color"]').getAttribute('content');
  expect(theme).not.toBe('#175C50');
  expect(theme).toMatch(/^#[0-9A-Fa-f]{6}$/);
});

test('the camera help names the machine in front of the person reading it', async ({ page }) => {
  // BUG-07: it told everybody to press "the padlock beside the address bar",
  // which the counter tablet -- the device the gym bought this for -- does not
  // have.
  await page.context().clearPermissions();
  await signIn(page, 'hotfix-staff@example.test');
  await expect(page.locator('.scanstage')).toBeVisible();
  // The help only appears when the camera is actually refused, so this asserts
  // on the copy being present in the build rather than forcing a refusal the
  // fake-camera flag makes impossible.
  const help = await page.evaluate(async () => {
    const source = await (await fetch('/assets/' + [...document.querySelectorAll('script[src]')]
      .map(s => s.src.split('/assets/')[1]).find(Boolean))).text();
    return {
      tablet: source.includes('แท็บเล็ต/มือถือ Android'),
      ipad: source.includes('iPad/iPhone'),
      padlockOnly: source.includes('กดไอคอนรูปกุญแจ 🔒 ข้างช่อง URL'),
    };
  });
  expect(help.tablet, 'ต้องมีวิธีของแท็บเล็ต Android').toBe(true);
  expect(help.ipad, 'ต้องมีวิธีของ iPad').toBe(true);
  expect(help.padlockOnly, 'คำแนะนำเดิมที่อ้างกุญแจข้าง URL อย่างเดียวต้องไม่เหลือ').toBe(false);
});

test('an address typed wrong at the desk is fixed at the desk, by whoever is on shift', async ({ page }) => {
  // QA-01: there was no screen for this. One character wrong in an address
  // meant the member's card -- a QR that opens the door -- had been emailed to
  // a stranger, and nothing in the app could change it.
  await signIn(page, 'hotfix-staff@example.test');
  await go(page, 'สมัครสมาชิก');
  await page.getByLabel('เลือกรูปจากเครื่องแทน')
    .setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: PNG_PIXEL });
  await page.getByRole('button', { name: 'ถัดไป · ชื่อและเบอร์' }).click();
  await page.getByLabel('ชื่อ–นามสกุล').fill('QA-TEST พิมพ์ผิด');
  await page.getByLabel('เบอร์มือถือ').fill('0899000654');
  await page.getByLabel('อีเมล (ไม่บังคับ)').fill('wrogn@example.test');
  await page.getByRole('button', { name: 'ถัดไป · แพ็กเกจและเงิน' }).click();
  await page.getByRole('button', { name: 'บันทึกและออกบัตร' }).click();
  await expect(page.getByRole('heading', { name: 'บัตรสมาชิก' })).toBeVisible();

  // QA-04: the wizard posts the card without waiting, so a mail server having
  // a bad minute was completely silent. Said out loud on the card screen.
  await expect.poll(async () => {
    const box = await (await page.request.get('/__test/outbox?to=wrogn@example.test')).json();
    return box.items.length;
  }).toBeGreaterThan(0);

  // A member of staff -- not the owner -- opens the correction.
  await page.getByRole('button', { name: 'แก้ไขข้อมูลสมาชิก' }).click();
  await expect(page.getByRole('heading', { name: 'แก้ไขข้อมูลสมาชิก' })).toBeVisible();
  await expect(page.getByText(/ทุกการแก้ไขถูกบันทึกไว้/)).toBeVisible();
  await page.getByLabel('อีเมล (ไม่บังคับ)').fill('right@example.test');
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();

  // The card already went to the old address, so the screen says where, and
  // offers the only thing that actually fixes it.
  await expect(page.getByRole('heading', { name: /แก้อีเมลแล้ว/ })).toBeVisible();
  await expect(page.getByText(/wrogn@example\.test/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'ออกบัตรใหม่ · ฆ่าบัตรใบเดิม' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/qa01-email-changed-1280.png', fullPage: true });

  await page.getByRole('button', { name: 'ไม่ต้องออกบัตรใหม่' }).click();
  await expect(page.getByRole('heading', { name: 'บัตรสมาชิก' })).toBeVisible();

  // QA-04 again: the new address has had nothing, and the card screen says so
  // rather than leaving a button nobody reads as the only signal.
  await expect(page.getByText('ยังไม่ได้ส่งบัตรทางอีเมล')).toBeVisible();
  await expect(page.getByText(/right@example\.test/)).toBeVisible();
  await page.screenshot({ path: 'artifacts/qa04-card-not-sent-1280.png', fullPage: true });
});

test('the way back in on the front screen is big enough to hit', async ({ page }) => {
  // QA-03: 26px. The one way back in on the front screen, pressed by somebody
  // who is already in a hurry, and the only control in the system under 44.
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const box = await page.getByRole('button', { name: 'ลืมรหัสผ่าน' }).boundingBox();
    expect(box.height, `ปุ่มลืมรหัสผ่านที่ ${width}px สูง ${box.height}px`).toBeGreaterThanOrEqual(44);
  }
  // QA-07: every other screen formats the number; these two printed it raw.
  const shown = await page.locator('.authfoot').innerText();
  if (/\d/.test(shown)) expect(shown, 'เบอร์บนหน้าแรกต้องจัดรูปแบบเหมือนหน้าอื่น').toMatch(/\d{2,3}-\d{3}-\d{3,4}/);
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('on a desktop browser, handing the card over saves the file instead of failing silently',
  async ({ page }) => {
    // ผลทดสอบของผู้ใช้ ข้อ 5: "การใช้งานในโทรศัพท์จะเสถียรกว่าในคอม เวลาส่งหรือ
    // บันทึก QR ให้กับสมาชิก" — the phone gets a share sheet; the desktop got a
    // `window.open` fired several awaits after the click, which the browser had
    // already stopped treating as a click and blocked. Nothing opened and
    // nothing said so.
    await page.addInitScript(() => {
      // A desktop browser with no share sheet, which is most of them. Defined
      // over rather than deleted: these live on Navigator.prototype, so
      // `delete navigator.canShare` removes an own property that was never
      // there and leaves the real one answering.
      for (const name of ['canShare', 'share']) {
        Object.defineProperty(window.navigator, name, { configurable: true, value: undefined });
      }
    });
    await signIn(page, 'handoff-admin@example.test');
    await signUpMember(page, { name: 'ส่งบัตรจากคอม', phone: '0895550011' });

    const download = page.waitForEvent('download', { timeout: 10000 });
    await page.getByRole('button', { name: 'ส่งบัตรให้ลูกค้า' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^GYM-[0-9A-Z]+\.png$/);

    // And it says where the file went, because a download that appears in a
    // corner of the browser is not an answer to "did the customer get it".
    await expect(page.getByRole('status').filter({ hasText: 'บันทึกรูปบัตรของ ส่งบัตรจากคอม ลงเครื่องแล้ว' }))
      .toBeVisible();
    await expect(page.getByText('แนบไฟล์นี้ส่งให้ลูกค้าได้เลย', { exact: false })).toBeVisible();
  });
