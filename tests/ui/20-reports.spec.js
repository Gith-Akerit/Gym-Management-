import { test, expect } from '@playwright/test';
import { cardToken, contrastIn, go, scan, signIn, signUpMember, tooFaint } from './counter.js';

// The two tabs the owner reads the gym from: "รายงาน" and "บัญชีผู้ใช้".
//
// They sit inside ตั้งค่ายิม beside ยิมและแบรนด์ and อีเมลของระบบ, and every
// route behind either of them is admin-only. That is the first thing checked
// here, and it is checked by looking for the tab rather than by opening it:
// a staff member who can SEE a tab they cannot open learns to keep pressing it.
//
// The second is the one the server made possible and the screen could still
// get wrong. The check-in report fills a quiet day with a row of zeros on
// purpose, so a week with nothing in it arrives as seven rows -- and a screen
// that decides "is this empty" from `items.length` would call it full forever.
// The test asks for a week in 2025 that nothing happened in and insists on
// the empty state.
//
// Then the two things the owner does with a report once it is on the screen:
// take it away as a file, and put it on paper.

const ADMIN = 'rep-admin@example.test';
const STAFF = 'rep-staff@example.test';
const SIZES = [{ name: '1280', width: 1280, height: 900 }, { name: '390', width: 390, height: 844 }];
const CUSTOMER = 'สมพงษ์ อ่านรายงาน';

/**
 * A member, a sale and a scan, before anything is read.
 *
 * The other spec files leave plenty behind on the shared server, and a report
 * spec that depends on having been run after them is a spec that passes for
 * the wrong reason -- and fails on its own, which is how anybody debugging it
 * will run it. So this file puts its own afternoon into the gym first.
 */
test.beforeAll(async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: SIZES[0] })).newPage();
  await signIn(page, ADMIN);
  await page.getByRole('button', { name: 'เมนู', exact: true }).waitFor();

  // The gym ships with its packages as priceless drafts; 02-settings is what
  // puts one on sale. Done again here so this file stands on its own, and
  // idempotently, so running it after 02 changes nothing.
  const { items } = await (await page.request.get('/api/packages')).json();
  const monthly = items.find(row => row.code === 'UNLIMITED_30D');
  if (monthly.price_thb === null || monthly.status !== 'active') {
    const sold = await page.request.put(`/api/packages/${monthly.id}`, {
      headers: { 'X-Gym-Client': 'web' },
      data: { code: monthly.code, name_th: monthly.name_th, type: monthly.type,
        duration_days: monthly.duration_days, session_limit: monthly.session_limit,
        description: monthly.description, sort_order: monthly.sort_order,
        price_thb: 1200, status: 'active', version: monthly.version } });
    expect(sold.ok(), await sold.text()).toBe(true);
    // The console read the package list when it opened, so it has to read it
    // again before the sign-up form can offer what was just put on sale.
    await page.reload();
    await page.getByRole('button', { name: 'เมนู', exact: true }).waitFor();
  }

  await signUpMember(page, { name: CUSTOMER, phone: '0891110020', pkg: /รายเดือน Unlimited/ });
  const { qr } = await cardToken(page, CUSTOMER);
  await scan(page, qr);
  await page.close();
});

/** ตั้งค่ายิม, on the named tab. */
async function openTab(page, label) {
  await go(page, 'ตั้งค่ายิม');
  await expect(page.getByRole('heading', { name: 'ตั้งค่ายิม' })).toBeVisible();
  await page.locator('.settabs').getByRole('link', { name: label, exact: true }).click();
}

/** The report with this name showing, with its table or its empty box drawn. */
async function openReport(page, tab) {
  await page.locator('.reptabs').getByRole('tab', { name: tab, exact: true }).click();
  await expect(page.locator('.repbody, .empty').first()).toBeVisible();
}

/** Fills the two date boxes, which is what a person does before anything else. */
async function pickRange(page, from, to) {
  await page.getByLabel('ตั้งแต่วันที่').fill(from);
  await page.getByLabel('ถึงวันที่').fill(to);
}

test('staff are not offered the two tabs at all', async ({ page }) => {
  await signIn(page, STAFF);
  await go(page, 'ตั้งค่ายิม');
  await expect(page.getByRole('heading', { name: 'ตั้งค่ายิม' })).toBeVisible();
  const tabs = page.locator('.settabs');
  await expect(tabs.getByRole('link', { name: 'ยิมและแบรนด์', exact: true })).toBeVisible();
  await expect(tabs.getByRole('link', { name: 'รายงาน', exact: true })).toHaveCount(0);
  await expect(tabs.getByRole('link', { name: 'บัญชีผู้ใช้', exact: true })).toHaveCount(0);
  // And not merely hidden from the menu: the doors themselves are shut.
  expect((await page.request.get('/api/admin/reports/today')).status()).toBe(403);
  expect((await page.request.get('/api/admin/reports/sales')).status()).toBe(403);
});

test('the bar across the top answers before any report is chosen', async ({ page }) => {
  await signIn(page, ADMIN);
  await openTab(page, 'รายงาน');
  const bar = page.locator('.todaybar .tcard');
  await expect(bar).toHaveCount(4);
  for (const label of ['ยอดขายวันนี้', 'เช็คอินวันนี้', 'สมาชิกใหม่วันนี้', 'จะหมดอายุใน 7 วัน']) {
    await expect(page.locator('.todaybar').getByText(label, { exact: true })).toBeVisible();
  }
});

test('a week nobody came is empty, however many rows it arrives as', async ({ page }) => {
  await signIn(page, ADMIN);
  await openTab(page, 'รายงาน');
  await openReport(page, 'เช็คอิน');
  await pickRange(page, '2025-01-01', '2025-01-07');

  // The whole point: the server sends a row per day whether anybody came or
  // not, so this range has seven of them and no scans in any of them.
  const quiet = await page.request.get('/api/admin/reports/checkins?from=2025-01-01&to=2025-01-07');
  const body = await quiet.json();
  expect(body.items.length, 'เซิร์ฟเวอร์ต้องเติมวันว่างเป็นแถวศูนย์ ไม่ใช่ส่งรายการเปล่า').toBe(7);
  const scanned = body.items.reduce((total, row) => total + row.allowed + row.duplicate + row.denied, 0);
  expect(scanned).toBe(0);

  await expect(page.getByText('ไม่มีการสแกนในช่วงนี้')).toBeVisible();
  await expect(page.locator('.rtable')).toHaveCount(0);

  // And a range that does have scans in it shows the table, so the empty box
  // is not simply always on.
  await page.getByRole('button', { name: '7 วัน', exact: true }).click();
  await expect(page.locator('.rtable').first()).toBeVisible();
  await expect(page.getByText('ไม่มีการสแกนในช่วงนี้')).toHaveCount(0);
});

test('the download button hands over a real file', async ({ page }) => {
  await signIn(page, ADMIN);
  await openTab(page, 'รายงาน');
  await openReport(page, 'ยอดขาย');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'ดาวน์โหลด CSV' }).click(),
  ]);
  expect(download.suggestedFilename(), 'ชื่อไฟล์ต้องบอกว่าเป็นรายงานอะไรของช่วงไหน').toMatch(/^sales-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/);

  // Opened and read, not only counted: a CSV without the BOM is a CSV that
  // opens in Excel on Windows as rubbish, which is the machine the gym has.
  const stream = await download.createReadStream();
  const text = await new Promise((resolve, reject) => {
    const parts = [];
    stream.on('data', part => parts.push(part));
    stream.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    stream.on('error', reject);
  });
  expect(text.startsWith('﻿'), 'ไฟล์ต้องขึ้นต้นด้วย BOM ไม่งั้น Excel อ่านภาษาไทยเพี้ยน').toBe(true);
  expect(text).toContain('ยอดขาย');
  expect(text).toContain('รวม');
  // The privacy rule follows the file out of the door.
  expect(text).not.toContain('before_json');
  expect(text).not.toContain('after_json');
});

test('on paper there are no filters, no menu and no buttons', async ({ page }) => {
  await signIn(page, ADMIN);
  await openTab(page, 'รายงาน');
  await openReport(page, 'เช็คอิน');
  await expect(page.locator('.repfilters')).toBeVisible();

  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.repfilters')).toBeHidden();
  await expect(page.locator('.settabs')).toBeHidden();
  await expect(page.locator('.appbar')).toBeHidden();
  // What is left is the report: its heading, the range it covers and the
  // numbers. A printout that does not say which days it covers is a printout
  // that means nothing on a desk a week later.
  await expect(page.getByRole('heading', { name: 'การเข้าใช้บริการ' })).toBeVisible();
  await expect(page.locator('.rrange')).toBeVisible();
  await page.emulateMedia({ media: 'screen' });
});

test('every bar carries its own number', async ({ page }) => {
  await signIn(page, ADMIN);
  await openTab(page, 'รายงาน');
  await openReport(page, 'เช็คอิน');
  await page.getByRole('button', { name: '7 วัน', exact: true }).click();

  const chart = page.locator('.bars').first();
  await expect(chart).toBeVisible();
  const bars = chart.locator('li');
  await expect(bars).toHaveCount(24);          // one per hour, quiet ones included
  const numbers = await chart.locator('.bnum').allInnerTexts();
  expect(numbers).toHaveLength(24);
  expect(numbers.every(text => /\d/.test(text)), `ตัวเลขที่อ่านได้: ${numbers.join(' | ')}`).toBe(true);
});

test('creating an account hands over the link that makes it usable', async ({ page }) => {
  await signIn(page, ADMIN);
  await openTab(page, 'บัญชีผู้ใช้');
  await expect(page.getByRole('heading', { name: 'ผู้ใช้และสิทธิ์' })).toBeVisible();

  const address = `tabmade-${Date.now()}@example.test`;
  await page.getByLabel('อีเมล', { exact: true }).fill(address);
  await page.getByRole('button', { name: 'สร้างบัญชี' }).click();

  // No password was typed, so the account cannot be signed in to -- and the
  // one-time link that fixes that arrives with it rather than needing a second
  // press on a row the owner then has to find.
  await expect(page.getByRole('heading', { name: `ลิงก์ตั้งรหัสผ่านของ ${address}` })).toBeVisible();
  await expect(page.getByText('ใช้ได้ครั้งเดียว')).toBeVisible();
  await expect(page.getByText('อย่าโพสต์ลงกลุ่ม')).toBeVisible();
  await expect(page.getByRole('button', { name: 'คัดลอกลิงก์' })).toBeVisible();
  const url = await page.locator('#pwlink').inputValue();
  expect(url).toMatch(/\?setpw=[A-Za-z0-9_-]{43}$/);
});

test('both tabs are readable and fit, at 1280 and at 390', async ({ page }) => {
  await signIn(page, ADMIN);
  for (const size of SIZES) {
    await page.setViewportSize(size);

    await openTab(page, 'รายงาน');
    await openReport(page, 'พนักงาน');
    expect(tooFaint(await contrastIn(page)), `รายงาน ที่ ${size.width}px`).toEqual([]);
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth),
    `แท็บรายงานล้นขอบที่ ${size.width}px`).toBe(false);
    // Photographed on the check-in report rather than the staff one: the staff
    // report is a day of everything this suite did, and a picture twenty-four
    // thousand pixels tall shows nobody anything. This one has the table, the
    // totals row and the chart in one frame.
    await openReport(page, 'เช็คอิน');
    await page.getByRole('button', { name: '7 วัน', exact: true }).click();
    await expect(page.locator('.bars')).toBeVisible();
    await page.screenshot({ path: `artifacts/ui-reports-${size.name}.png`, fullPage: true });

    await openTab(page, 'บัญชีผู้ใช้');
    await expect(page.getByRole('heading', { name: 'ผู้ใช้และสิทธิ์' })).toBeVisible();
    expect(tooFaint(await contrastIn(page)), `บัญชีผู้ใช้ ที่ ${size.width}px`).toEqual([]);
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth),
    `แท็บบัญชีผู้ใช้ล้นขอบที่ ${size.width}px`).toBe(false);
    await page.screenshot({ path: `artifacts/ui-user-accounts-${size.name}.png`, fullPage: true });
  }
});
