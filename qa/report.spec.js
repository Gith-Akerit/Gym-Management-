// QA Release Tester — หมวด L in the browser (b4cd3a1).
//
// The part that can only be checked with a real page: whether the picture that
// reaches the owner is a picture of the screen, or a blank rectangle where a
// camera used to be. A capture that silently produces an empty frame is the
// exact failure this feature exists to stop somebody else having.
import { test, expect } from '@playwright/test';
import { signIn, openUserMenu, go, signUpMember } from '../tests/ui/counter.js';

const ADMIN = 'admin7@example.test';
const STAFF = 'staff3-ui@example.test';

/** Opens the report box from the corner menu and fills in the one required field. */
async function report(page, words) {
  await openUserMenu(page);
  await page.getByRole('menuitem', { name: /^แจ้งปัญหา/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel(/ใช้ไม่ได้อย่างไร/).fill(words);
}

/**
 * Sends what is in the box and dismisses the receipt.
 *
 * The receipt is `aria-modal`, and its button is named for what it is for
 * rather than "close". Leaving it open blocks everything behind it, so a miss
 * here is not swallowed — the next step would hang instead of failing.
 */
async function sendIt(page, expected = /ส่งเรื่องแล้ว/) {
  await page.getByRole('button', { name: /^ส่งเรื่อง/ }).click();
  // `.first()`: the receipt says "ส่งเรื่องแล้ว" as its heading and repeats the
  // reference just below, so a loose match finds two and strict mode refuses.
  await expect(page.getByText(expected).first()).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'กลับไปทำงานต่อ' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

/** How much of the captured picture is not one flat colour. */
const inkOf = async (page, url) => page.evaluate(async src => {
  const bitmap = await createImageBitmap(await (await fetch(src)).blob());
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const shades = new Set();
  for (let at = 0; at < data.length; at += 4 * 37) {
    shades.add(`${data[at] >> 4},${data[at + 1] >> 4},${data[at + 2] >> 4}`);
  }
  return { size: [bitmap.width, bitmap.height], distinct_colours: shades.size };
}, url);

// ====================================== the picture is of the screen
test('REPORT-UI-01 the picture is of the screen, on every kind of screen', async ({ page }) => {
  // Three full cycles, each rasterising the whole DOM through a library that is
  // only fetched when the button is pressed. Slow on purpose, not stuck.
  test.setTimeout(180000);
  const captured = {};
  const screens = {
    'สมาชิก': async () => { await go(page, 'สมาชิก'); },
    // The two with a live camera: a <video> paints nothing into a DOM capture
    // unless the frame is drawn to a canvas first, so these are the two that
    // can quietly produce an empty box.
    'สแกนเช็คอิน': async () => { await go(page, 'สแกนเช็คอิน'); },
    // Step one of signing somebody up IS the camera step, so arriving is
    // enough — no need to fill the form to reach a live <video>.
    'สมัครสมาชิก': async () => {
      await go(page, 'สมัครสมาชิก');
      await expect(page.getByRole('heading', { name: 'สมัครสมาชิกใหม่' })).toBeVisible();
    },
  };
  await signIn(page, ADMIN);
  for (const [name, open] of Object.entries(screens)) {
    await open();
    await page.waitForTimeout(700);
    await report(page, `QA ตรวจภาพจากหน้า ${name}`);
    // The tick is on by default; this is the path that must carry a picture.
    await sendIt(page);
    captured[name] = true;
  }

  // Now read them back as the owner, and look at the pixels rather than at a
  // 201: a blank rectangle also arrives with a 201.
  await go(page, 'เรื่องที่แจ้งไว้');
  const rows = await page.$$eval('.rep', els => els.map(el => ({

    text: el.innerText.replace(/\s+/g, ' ').slice(0, 60),
    thumb: el.querySelector('.thumb img')?.getAttribute('src') ?? null,
  })));
  console.log('REPORT-UI-01 what reached the owner:\n' + JSON.stringify(rows, null, 1));
  expect(rows.length, 'the reports did not reach the owner list').toBeGreaterThanOrEqual(3);

  const looked = {};
  for (const row of rows.slice(0, 3)) {
    expect(row.thumb, `a report arrived with no picture: ${row.text}`).toBeTruthy();
    looked[row.text.slice(0, 26)] = await inkOf(page, row.thumb);
  }
  console.log('REPORT-UI-01 the pictures themselves:\n' + JSON.stringify(looked, null, 1));
  for (const [what, seen] of Object.entries(looked)) {
    expect(seen.size[0], `${what}: the picture has no width`).toBeGreaterThan(200);
    // A blank box is one or two colours. A screen is dozens.
    expect(seen.distinct_colours, `${what}: the picture is a blank rectangle`).toBeGreaterThan(6);
  }
  expect(Object.keys(captured).length).toBe(3);
});

test('REPORT-UI-02 turning the picture off sends the words and nothing else', async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page, ADMIN);
  await go(page, 'สมาชิก');
  await report(page, 'QA ไม่ส่งภาพมาด้วย');
  const tick = page.getByLabel(/ส่งภาพหน้าจอ/);
  await expect(tick).toBeChecked();
  await tick.uncheck();
  await sendIt(page);

  await go(page, 'เรื่องที่แจ้งไว้');
  const mine = await page.$$eval('.rep', els => els.map(el => ({
    text: el.innerText.replace(/\s+/g, ' ').slice(0, 40),
    thumb: el.querySelector('.thumb img')?.getAttribute('src') ?? null })));
  const row = mine.find(r => r.text.includes('ไม่ส่งภาพ'));
  console.log('REPORT-UI-02 the report that was sent with the tick off:', JSON.stringify(row));
  expect(row, 'the report never arrived').toBeTruthy();
  expect(row.thumb, 'a picture was sent even though the tick was off').toBeFalsy();
});

// ================================================== the line going down
test('REPORT-UI-03 a report written during an outage is kept and sent later', async ({ page, context }) => {
  test.setTimeout(120000);
  await signIn(page, STAFF);
  await go(page, 'สมาชิก');
  await context.setOffline(true);
  await report(page, 'QA เขียนตอนเน็ตหลุด');
  await sendIt(page, /เก็บ.*ไว้ในเครื่อง/);

  // The menu has to say so, or the shift ends believing it was sent.
  await openUserMenu(page);
  const waiting = await page.getByRole('menuitem', { name: /แจ้งปัญหา/ }).innerText();
  const stored = await page.evaluate(() =>
    (JSON.parse(localStorage.getItem('gym.reports.pending') ?? '[]')).length);
  console.log('REPORT-UI-03 while the line is down: menu says', JSON.stringify(waiting.trim()),
    '· kept in the browser:', stored);
  expect(waiting, 'the menu does not say anything is waiting').toMatch(/รอส่ง/);
  expect(stored, 'nothing was kept in the browser').toBeGreaterThan(0);
  await page.keyboard.press('Escape');

  // And when the line comes back it goes by itself, without anybody pressing
  // anything: the member of staff has moved on.
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => page.evaluate(() =>
    (JSON.parse(localStorage.getItem('gym.reports.pending') ?? '[]')).length),
  { timeout: 20000 }).toBe(0);
  await openUserMenu(page);
  const after = await page.getByRole('menuitem', { name: /แจ้งปัญหา/ }).innerText();
  console.log('REPORT-UI-03 once the line is back: menu says', JSON.stringify(after.trim()));
  expect(after, 'the menu still says something is waiting').not.toMatch(/รอส่ง/);
  await page.keyboard.press('Escape');

  // It really arrived, not just left the queue.
  await logOutAndIn(page, ADMIN);
  await go(page, 'เรื่องที่แจ้งไว้');
  const texts = await page.$$eval('.rep', els => els.map(el => el.innerText));
  console.log('REPORT-UI-03 the owner now has', texts.length, 'report(s)');
  expect(texts.join(' '), 'the queued report never reached the owner').toContain('เน็ตหลุด');
});

async function logOutAndIn(page, email) {
  await openUserMenu(page);
  await page.getByRole('menuitem', { name: 'ออกจากระบบ', exact: true }).click();
  await expect(page.getByRole('button', { name: 'เข้าสู่ระบบ' })).toBeVisible();
  await signIn(page, email);
}

// ========================================= หมวด K ที่ค้าง · กลับด้านเคส disabled
test('MENU-11 the two rows that were closed are open now, and the owner has one more', async ({ page }) => {
  const seen = {};
  for (const [role, email] of [['เจ้าของยิม', ADMIN], ['พนักงาน', STAFF]]) {
    await page.context().clearCookies();
    await signIn(page, email);
    await openUserMenu(page);
    seen[role] = await page.$$eval('#usermenu-panel [role="menuitem"]', rows => rows.map(el => ({
      label: el.querySelector('span:not(.ic)')?.firstChild?.textContent?.trim() ?? el.textContent.trim(),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
    })));
    await page.keyboard.press('Escape');
  }
  console.log('MENU-11 the menu now:\n' + JSON.stringify(seen, null, 1));
  for (const [role, rows] of Object.entries(seen)) {
    const off = rows.filter(r => r.disabled).map(r => r.label);
    expect(off, `${role}: something is still greyed out`).toEqual([]);
    for (const label of ['แจ้งปัญหา', 'คู่มือการใช้งาน']) {
      expect(rows.map(r => r.label), `${role}: "${label}" is gone`).toContain(label);
    }
  }
  // Reading reports back is the owner's, so the row is too.
  const ownerLabels = seen['เจ้าของยิม'].map(r => r.label);
  const staffLabels = seen['พนักงาน'].map(r => r.label);
  expect(ownerLabels, 'the owner has nowhere to read reports').toContain('เรื่องที่แจ้งไว้');
  expect(staffLabels, 'a member of staff is offered the owner\'s report list')
    .not.toContain('เรื่องที่แจ้งไว้');
});

test('MENU-12 the guide opens from the menu', async ({ page }) => {
  await signIn(page, STAFF);
  await openUserMenu(page);
  const row = page.getByRole('menuitem', { name: /^คู่มือการใช้งาน/ });
  await expect(row).toBeEnabled();
  const [opened] = await Promise.all([
    page.context().waitForEvent('page').catch(() => null),
    row.click(),
  ]);
  const target = opened ?? page;
  await target.waitForLoadState('domcontentloaded').catch(() => {});
  const got = await target.request.get('/manual.pdf');
  console.log('MENU-12 /manual.pdf ->', got.status(), got.headers()['content-type'],
    '·', (await got.body()).length, 'bytes');
  expect(got.status(), 'the guide is not there').toBe(200);
  expect(got.headers()['content-type']).toContain('pdf');
  expect((await got.body()).length).toBeGreaterThan(10000);
  if (opened) await opened.close();
});

test('MENU-13 the scan bar at 390 no longer squeezes the gym name to nothing', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, ADMIN);
  await expect(page.locator('.scanbar')).toBeVisible();
  const bar = await page.evaluate(() => {
    const el = document.querySelector('.scanbar .brand');
    if (!el) return { present: false };
    const box = el.getBoundingClientRect();
    return { present: true, shown: getComputedStyle(el).display !== 'none',
      width: Math.round(box.width), content: Math.round(el.scrollWidth) };
  });
  console.log('MENU-13 the gym name on the scan bar at 390px:', JSON.stringify(bar));
  // Either it is hidden outright, or it has enough room to read. What must not
  // happen is the middle: present, 24px wide, showing one character and "…".
  const usable = !bar.present || !bar.shown || bar.width >= bar.content;
  expect(usable, `it is ${bar.width}px wide for ${bar.content}px of text`).toBe(true);
});
