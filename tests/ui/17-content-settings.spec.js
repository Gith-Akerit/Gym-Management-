import { test, expect } from '@playwright/test';
import { contrastIn, go, PNG_PIXEL, signIn, tooFaint } from './counter.js';

// "เครื่องและโปรแกรม" — the screen that hands the content back to the gym.
//
// Everything a member reads used to arrive from a file a developer imported,
// which meant the numbers in a programme, the photograph of a machine and a
// YouTube link belonging to a stranger could only be changed by us. This is
// the owner's side of all three.
//
// Five states are walked here because each one is a different promise:
// the list as it stands, an edit that survives a reload, the press that takes
// the "ตัวเลขเป็นค่าตัวอย่าง" badge off a member's screen, a photograph
// arriving on the public machine page, and the owner putting the gym's name to
// the safety wording. A sixth check is the wall: staff never see the tab.

const OWNER = 'content-admin@example.test';
const STAFF = 'content-staff@example.test';

/** Opens ตั้งค่ายิม → เครื่องและโปรแกรม, and waits for the list. */
async function openContent(page, email = OWNER) {
  await signIn(page, email);
  await go(page, 'ตั้งค่ายิม');
  await page.getByRole('link', { name: 'เครื่องและโปรแกรม' }).click();
  await expect(page.getByRole('tab', { name: 'เครื่อง', exact: true })).toBeVisible();
}

/** Opens one row by its code and returns its body. */
async function openRow(page, code) {
  await page.locator('.crow').filter({ hasText: code }).getByRole('button').first().click();
  return page.locator('.crow.open');
}

test('the owner sees every machine and what has been checked', async ({ page }) => {
  await openContent(page);

  // Closed rows say two things and no more: what it is, and whether anybody at
  // this gym has been through it. Six machines with every field on screen is a
  // page nobody can find anything on.
  const rows = page.locator('.crow');
  await expect(rows).toHaveCount(6);
  await expect(page.getByText('ลู่วิ่งไฟฟ้า').first()).toBeVisible();
  await expect(page.locator('.cstate.todo').first()).toBeVisible();

  // The two links out are here rather than in the menu: they are what somebody
  // wants immediately after editing content, and neither earns a menu entry.
  await expect(page.getByRole('link', { name: 'พิมพ์แผ่น QR' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'ดูอย่างที่สมาชิกเห็น' })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/content-list-390.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('an edit to a machine reaches the page behind the sticker', async ({ page }) => {
  await openContent(page);
  const body = await openRow(page, 'M-02');

  // The wording a member reads, changed by the gym without a deploy.
  await body.getByLabel('ข้อควรระวัง (บรรทัดละหนึ่งข้อ)')
    .fill('ตั้งความสูงเบาะให้เข่างอเล็กน้อยตอนขาเหยียดสุด\nอย่าปั่นจนเข่าล็อก');
  // And the link to somebody else's clip, which can stop working any day.
  await body.getByLabel('ลิงก์ YouTube').fill('https://www.youtube.com/watch?v=aaaaaaaaaaa');
  await body.getByLabel('ชื่อคลิป').fill('คลิปที่ยิมเลือกเอง');
  await body.getByRole('button', { name: 'บันทึก' }).click();
  await expect(page.getByText(/บันทึก M-02 แล้ว/)).toBeVisible();

  // The public page is the proof: it is what the member actually opens.
  const machine = await page.context().newPage();
  await machine.goto('/m/M-02');
  await expect(machine.getByText('อย่าปั่นจนเข่าล็อก')).toBeVisible();
  await expect(machine.getByText('คลิปที่ยิมเลือกเอง')).toBeVisible();
  await machine.close();
});

test('pressing ตรวจแล้ว takes the example badge off the member screen', async ({ page }) => {
  await openContent(page);
  await page.getByRole('tab', { name: 'โปรแกรม' }).click();
  const body = await openRow(page, 'P-START');

  // Said out loud before the press, because it is a commitment rather than a
  // tick: it stops the next import overwriting the row and it changes what a
  // member is told about the numbers.
  await expect(page.getByText(/ตัวเลขในโปรแกรมนี้ยังเป็นค่าตัวอย่าง/)).toBeVisible();
  await body.getByLabel('เซ็ตของสถานีที่ 2').fill('3 เซ็ต');
  await body.getByRole('button', { name: 'ตรวจแล้ว' }).click();
  await expect(page.getByText(/สมาชิกจะไม่เห็นป้ายค่าตัวอย่างอีก/)).toBeVisible();

  // The row now says who stands behind it.
  await expect(page.locator('.crow').filter({ hasText: 'P-START' })
    .locator('.cstate.done')).toContainText(OWNER);
});

test('a photograph the owner uploads is the one on the public page', async ({ page }) => {
  await openContent(page);
  const body = await openRow(page, 'M-03');
  await expect(body.getByText('ยังไม่มีรูป')).toBeVisible();

  await body.getByLabel('เลือกรูปจากเครื่อง')
    .setInputFiles({ name: 'machine.png', mimeType: 'image/png', buffer: PNG_PIXEL });
  await expect(page.getByText(/อัปเดตรูป M-03 แล้ว/)).toBeVisible();

  // Served without a session, because the sticker is scanned by people who
  // have not signed in and never will.
  const anonymous = await page.context().browser().newContext();
  const visitor = await anonymous.newPage();
  await visitor.goto('/m/M-03');
  const shot = visitor.locator('img.shot');
  await expect(shot).toBeVisible();
  expect(await (await visitor.request.get(await shot.getAttribute('src'))).status()).toBe(200);
  await anonymous.close();
});

test('the safety wording takes the owner press, and says who gave it', async ({ page }) => {
  await openContent(page);
  await page.getByRole('tab', { name: 'ข้อความความปลอดภัย' }).click();
  await expect(page.getByText('ยังไม่ได้อนุมัติ')).toBeVisible();

  await page.getByLabel('ข้อความท้ายหน้าเครื่อง (ที่เปิดจาก QR)')
    .fill('เก็บอุปกรณ์เข้าที่ทุกครั้งหลังใช้เสร็จ\nมีอะไรไม่แน่ใจ ถามพนักงานได้ตลอด');
  await page.getByRole('button', { name: 'บันทึก' }).click();
  await expect(page.getByText(/บันทึกข้อความความปลอดภัยแล้ว/)).toBeVisible();
  // Editing is not approving: the gym has not put its name to it yet.
  await expect(page.getByText('ยังไม่ได้อนุมัติ')).toBeVisible();

  await page.getByRole('button', { name: 'อนุมัติข้อความชุดนี้' }).click();
  await expect(page.getByText('อนุมัติแล้ว')).toBeVisible();
  await expect(page.getByText(OWNER)).toBeVisible();

  const machine = await page.context().newPage();
  await machine.goto('/m/M-01');
  await expect(machine.getByText('เก็บอุปกรณ์เข้าที่ทุกครั้งหลังใช้เสร็จ')).toBeVisible();
  await machine.close();
});

test('staff never see the tab, and the routes behind it refuse them', async ({ page }) => {
  await signIn(page, STAFF);
  await go(page, 'ตั้งค่ายิม');
  await expect(page.getByRole('link', { name: 'อีเมลของระบบ' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'เครื่องและโปรแกรม' })).toHaveCount(0);

  // Not just hidden: what a member reads is the gym's word to its customers,
  // and every route behind the tab answers only to the owner.
  for (const path of ['/api/machines', '/api/programs', '/api/articles', '/api/safety']) {
    const answer = await page.request.get(path);
    expect(answer.status(), `${path} ตอบ ${answer.status()}`).toBe(403);
  }
});

test('every word on the screen can be read, on a phone and on a desktop', async ({ page }) => {
  await openContent(page);
  await openRow(page, 'M-01');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(tooFaint(await contrastIn(page)), `เครื่องและโปรแกรม ที่ ${width}px`).toEqual([]);
  }

  await page.getByRole('tab', { name: 'ข้อความความปลอดภัย' }).click();
  await expect(page.getByLabel('หัวข้อบนหน้าแรกของช่วยเล่น')).toBeVisible();
  expect(tooFaint(await contrastIn(page)), 'ข้อความความปลอดภัย').toEqual([]);
  await page.screenshot({ path: 'artifacts/content-safety-390.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
});
