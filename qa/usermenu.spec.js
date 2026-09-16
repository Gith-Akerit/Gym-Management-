// QA Release Tester — หมวด K: the menu in the top right corner (692ed75).
//
// Eight destinations became four on the rail and the rest behind one button.
// Two things can go wrong that nobody notices from the happy path: a row that
// is offered to somebody the server will refuse, and a menu that cannot be
// closed or escaped without a mouse — on a counter machine where the keyboard
// is often the fastest thing there is.
//
//   UI_PORT=<free> UI_PILOT_PORT=<free> PLAYWRIGHT_CHANNEL=msedge \
//     npx playwright test --config qa/playwright.qa.config.js
import { test, expect } from '@playwright/test';
import { signIn, openUserMenu, go } from '../tests/ui/counter.js';

const ADMIN = 'admin9@example.test';
const STAFF = 'staff4-ui@example.test';
const EVERYDAY = ['สแกนเช็คอิน', 'สมัครสมาชิก', 'สมาชิก', 'รับเงินและมอบแพ็กเกจ'];
/** The two that were shown-but-dead while the work was queued, and are live now. */
const NOT_YET = ['แจ้งปัญหา', 'คู่มือการใช้งาน'];

function ratio(a, b) {
  const parse = c => c.match(/\d+/g).slice(0, 3).map(Number);
  const lum = ([r, g, b]) => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const [x, y] = [lum(parse(a)), lum(parse(b))];
  return +(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05))).toFixed(2);
}

/** Everything the menu is offering, exactly as the browser has it. */
const menuRows = page => page.$$eval('#usermenu-panel [role="menuitem"]', rows => rows.map(el => {
  const box = el.getBoundingClientRect();
  return {
    label: el.querySelector('span:not(.ic)')?.firstChild?.textContent?.trim()
      ?? el.textContent.trim(),
    sub: el.querySelector('.sub')?.textContent.trim() ?? null,
    disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
    height: Math.round(box.height), width: Math.round(box.width),
    focusable: !el.disabled && el.tabIndex > -1,
  };
}));

// ================================================== K1 · what each role is offered
test('MENU-01 the menu offers exactly what the person is allowed to open', async ({ page }) => {
  const seen = {};
  for (const [role, email] of [['เจ้าของยิม', ADMIN], ['พนักงาน', STAFF]]) {
    await page.context().clearCookies();
    await signIn(page, email);
    // Signing in lands on the scan stage, which has no rail at all; the rail
    // only exists once you step off it.
    await page.getByRole('button', { name: 'ไปหน้าจัดการ' }).click();
    await page.locator('main .page').waitFor();
    const rail = await page.$$eval('.railnav a', els => els.map(a => a.textContent.trim()));
    await openUserMenu(page);
    const rows = await menuRows(page);
    seen[role] = { rail, menu: rows.map(r => r.label), rows };
    await page.keyboard.press('Escape');
  }
  console.log('MENU-01 the rail and the menu, by role:\n'
    + JSON.stringify({ 'เจ้าของยิม': { rail: seen['เจ้าของยิม'].rail, menu: seen['เจ้าของยิม'].menu },
      'พนักงาน': { rail: seen['พนักงาน'].rail, menu: seen['พนักงาน'].menu } }, null, 1));

  // The rail is the shift, and it is the same four for everybody: a member of
  // staff and the owner do the same job at the counter.
  for (const role of Object.keys(seen)) {
    expect(seen[role].rail, `${role}: the rail is not the everyday four`).toEqual(EVERYDAY);
    expect(seen[role].menu, `${role}: the menu repeats something already on the rail`)
      .not.toEqual(expect.arrayContaining(EVERYDAY));
    expect(seen[role].menu).toContain('ออกจากระบบ');
  }

  // What separates the two roles has to be exactly the owner's screens, and
  // nothing else: anything extra here is a row that leads to a 403.
  const ownerOnly = seen['เจ้าของยิม'].menu.filter(l => !seen['พนักงาน'].menu.includes(l));
  const staffOnly = seen['พนักงาน'].menu.filter(l => !seen['เจ้าของยิม'].menu.includes(l));
  console.log('MENU-01 only the owner is offered:', JSON.stringify(ownerOnly));
  console.log('MENU-01 only a member of staff is offered:', JSON.stringify(staffOnly));
  // Reading reports back joined the owner's side at `e049bed`, for the same
  // reason the rest of that list is the owner's: the pictures are of members.
  expect(ownerOnly.sort()).toEqual(['ข้อมูลยิม', 'ผู้ใช้และสิทธิ์', 'เรื่องที่แจ้งไว้', 'แพ็กเกจ'].sort());
  expect(staffOnly, 'a member of staff is offered something the owner is not').toEqual([]);

  // A greyed-out row that never works teaches staff to keep trying it. Since
  // `e049bed` there are none at all: the two that were waiting on the next
  // round are built, so nothing in this menu is decoration.
  for (const [role, row] of Object.entries(seen)) {
    const off = row.rows.filter(r => r.disabled).map(r => r.label);
    console.log(`MENU-01 ${role}: rows that cannot be pressed ->`, JSON.stringify(off));
    expect(off, `${role}: something is greyed out`).toEqual([]);
  }
});

test('MENU-02 the rows that were waiting are built now, and they go somewhere', async ({ page }) => {
  await signIn(page, ADMIN);
  await openUserMenu(page);
  const rows = (await menuRows(page)).filter(r => NOT_YET.includes(r.label));
  console.log('MENU-02 the two rows that used to be closed:\n' + JSON.stringify(rows, null, 1));
  expect(rows.length, 'one of the two rows is gone').toBe(2);
  for (const row of rows) {
    // Inverted at `e049bed`: these were deliberately dead while the work was
    // queued, and both are live now. A row that is offered has to go somewhere.
    expect(row.disabled, `"${row.label}" is still closed`).toBe(false);
    expect(row.focusable, `"${row.label}" cannot be reached from the keyboard`).toBe(true);
    expect(row.height, `"${row.label}" is only ${row.height}px tall`).toBeGreaterThanOrEqual(44);
  }

  // And the one that opens a box really opens it, rather than closing the menu
  // and leaving the person looking at the screen they were already on.
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.getByRole('menuitem', { name: /^แจ้งปัญหา/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  console.log('MENU-02 pressing "แจ้งปัญหา" opens the box · javascript errors:', JSON.stringify(errors));
  expect(errors, 'opening the report box threw').toEqual([]);
});

// ============================================================ K2 · the keyboard
test('MENU-03 the whole menu works with no mouse at all', async ({ page }) => {
  await signIn(page, ADMIN);
  const button = page.getByRole('button', { name: 'เมนู', exact: true });
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#usermenu-panel')).toBeVisible();

  const first = await page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 20));
  expect(await page.evaluate(() => document.activeElement?.getAttribute('role')),
    'opening the menu left the focus behind on the button').toBe('menuitem');

  // Down through every row and round to the top: the count proves it wrapped
  // rather than stopping at the end.
  const order = [];
  const rows = await page.$$eval('#usermenu-panel [role="menuitem"]:not([aria-disabled="true"])', r => r.length);
  // `rows` presses from the first row land back on the first row if it wraps,
  // and the focus is left there — pressing once more would put the next
  // assertion one row out.
  for (let i = 0; i <= rows; i++) {
    order.push(await page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 20)));
    if (i < rows) await page.keyboard.press('ArrowDown');
  }
  console.log(`MENU-03 ${rows} rows the arrows can reach · first ${JSON.stringify(first)}`);
  console.log('MENU-03 walking down with ArrowDown:', JSON.stringify(order));
  expect(order[rows], 'ArrowDown does not wrap round to the first row').toBe(order[0]);

  await page.keyboard.press('ArrowUp');
  const up = await page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 20));
  console.log('MENU-03 and ArrowUp from the top goes to:', JSON.stringify(up));
  expect(up, 'ArrowUp does not wrap round to the last row').toBe(order[rows - 1]);

  // Escape closes it AND hands the focus back, or the person is left nowhere.
  await page.keyboard.press('Escape');
  await expect(page.locator('#usermenu-panel')).toBeHidden();
  const back = await page.evaluate(() => ({
    label: document.activeElement?.getAttribute('aria-label'),
    expanded: document.activeElement?.getAttribute('aria-expanded'),
  }));
  console.log('MENU-03 Escape gave the focus back to:', JSON.stringify(back));
  expect(back.label, 'Escape closed the menu and dropped the focus').toBe('เมนู');
  expect(back.expanded).toBe('false');
});

test('MENU-04 pressing outside closes it, and says so to a screen reader', async ({ page }) => {
  await signIn(page, ADMIN);
  const button = await openUserMenu(page);
  expect(await button.getAttribute('aria-expanded')).toBe('true');
  expect(await button.getAttribute('aria-haspopup')).toBe('menu');
  expect(await button.getAttribute('aria-controls')).toBe('usermenu-panel');

  await page.mouse.click(12, 400);
  await expect(page.locator('#usermenu-panel')).toBeHidden();
  console.log('MENU-04 after a press outside: aria-expanded ->',
    await button.getAttribute('aria-expanded'));
  expect(await button.getAttribute('aria-expanded')).toBe('false');
});

// ================================================== K3 · the hand, and the phone
test('MENU-05 every row is big enough to hit, on a phone and on a counter screen', async ({ page }) => {
  const report = {};
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.context().clearCookies();
    await signIn(page, ADMIN);
    const button = await openUserMenu(page);
    const rows = await menuRows(page);
    const trigger = await button.boundingBox();
    const small = rows.filter(r => r.height < 44).map(r => `${r.label} ${r.height}px`);
    report[`${width}px`] = { rows: rows.length, shortest: Math.min(...rows.map(r => r.height)),
      under_44: small, the_button: [Math.round(trigger.width), Math.round(trigger.height)] };
    if (width === 390) {
      // A sheet at the bottom, not a dropdown hanging off a corner a thumb
      // cannot reach.
      const panel = await page.locator('#usermenu-panel').boundingBox();
      const viewport = page.viewportSize();
      report['390px'].sheet = { bottom_gap: Math.round(viewport.height - (panel.y + panel.height)),
        width_of_screen: Math.round((panel.width / viewport.width) * 100) + '%',
        scrim: await page.locator('.scrim').isVisible() };
    }
    await page.keyboard.press('Escape');
  }
  console.log('MENU-05 the size of what has to be hit:\n' + JSON.stringify(report, null, 1));
  for (const [where, row] of Object.entries(report)) {
    expect(row.under_44, `${where}: rows too small to hit`).toEqual([]);
    expect(row.the_button[1], `${where}: the menu button itself is only ${row.the_button[1]}px tall`)
      .toBeGreaterThanOrEqual(44);
  }
  // On a phone the sheet sits against the bottom edge and spans the screen.
  expect(report['390px'].sheet.bottom_gap, 'the sheet is not against the bottom of the screen')
    .toBeLessThanOrEqual(24);
  expect(report['390px'].sheet.scrim, 'there is nothing behind the sheet to press to dismiss it').toBe(true);
});

// ============================================ K4 · the dark stage, and the brand
test('MENU-06 the menu is on the scan stage and readable there, in any gym', async ({ page }) => {
  const report = {};
  for (const colour of ['#DD610B', '#F2C200', '#FFFFFF']) {
    await page.context().clearCookies();
    await signIn(page, ADMIN);
    await go(page, 'ตั้งค่ายิม');
    await page.getByLabel('สีหลัก', { exact: true }).fill(colour);
    await page.getByLabel('สีหลัก', { exact: true }).blur();
    const save = page.getByRole('button', { name: 'บันทึกการตั้งค่า' });
    if (!await save.isDisabled()) {
      await save.click();
      await expect(page.getByRole('status').filter({ hasText: 'บันทึกการตั้งค่ายิมแล้ว' })).toBeVisible();
    }
    await go(page, 'สแกนเช็คอิน');
    await expect(page.locator('.scanstage')).toBeVisible();

    const button = page.getByRole('button', { name: 'เมนู', exact: true });
    await expect(button, `${colour}: the menu is missing from the scan stage`).toBeVisible();
    // Measured off the rendered pixels: the trigger sits on a translucent patch
    // over a dark bar, so nothing in the computed styles is what a person sees.
    const shot = await button.screenshot();
    const ink = await page.evaluate(async bytes => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      const inset = Math.round(Math.min(canvas.width, canvas.height) * 0.15);
      const { data } = canvas.getContext('2d')
        .getImageData(inset, inset, canvas.width - inset * 2, canvas.height - inset * 2);
      const counts = new Map();
      for (let at = 0; at < data.length; at += 4) {
        const key = `rgb(${data[at]}, ${data[at + 1]}, ${data[at + 2]})`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const lum = text => {
        const [r, g, b] = text.match(/\d+/g).map(Number);
        const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const plate = ranked[0][0];
      const letters = ranked.filter(([, n]) => n > 12)
        .sort((a, b) => Math.abs(lum(b[0]) - lum(plate)) - Math.abs(lum(a[0]) - lum(plate)))[0]?.[0] ?? plate;
      return { plate, letters };
    }, Array.from(shot));

    await openUserMenu(page);
    const panel = await page.evaluate(() => {
      const el = document.querySelector('#usermenu-panel');
      const row = el.querySelector('[role="menuitem"]:not([aria-disabled="true"])');
      const bg = getComputedStyle(el).backgroundColor;
      return { panel: bg, row: getComputedStyle(row).color,
        header: getComputedStyle(el.querySelector('.who b')).color };
    });
    report[colour] = { trigger_on_dark: ratio(ink.letters, ink.plate), ink,
      row_on_panel: ratio(panel.row, panel.panel), header_on_panel: ratio(panel.header, panel.panel) };
    await page.keyboard.press('Escape');
  }
  console.log('MENU-06 the menu on the dark scan stage:\n' + JSON.stringify(report, null, 1));
  for (const [colour, row] of Object.entries(report)) {
    expect(row.trigger_on_dark, `${colour}: the menu button on the dark bar is ${row.trigger_on_dark}:1`)
      .toBeGreaterThanOrEqual(4.5);
    expect(row.row_on_panel, `${colour}: a menu row is ${row.row_on_panel}:1 on the panel`)
      .toBeGreaterThanOrEqual(4.5);
    expect(row.header_on_panel, `${colour}: the address at the top of the menu is ${row.header_on_panel}:1`)
      .toBeGreaterThanOrEqual(4.5);
  }
});

test('MENU-07 the app bar in full-colour mode fades nothing', async ({ page }) => {
  await signIn(page, ADMIN);
  await go(page, 'ตั้งค่ายิม');
  // The mode the owner turns on to make the bar the gym's own colour.
  const report = {};
  // The gym as it is today, the two pale ones, and the green it shipped with:
  // the bar is painted `--brand-surface`, so every ink on it has to follow.
  for (const colour of ['#DD610B', '#F2C200', '#FFFFFF', '#05603A']) {
    await go(page, 'ตั้งค่ายิม');
    await page.getByLabel('สีหลัก', { exact: true }).fill(colour);
    await page.getByLabel('สีหลัก', { exact: true }).blur();
    const full = page.getByLabel('ทำหัวแอปเป็นสีแบรนด์');
    await expect(full, 'there is no way to turn the full-colour app bar on').toHaveCount(1);
    if (!await full.isChecked()) await full.check();
    const save = page.getByRole('button', { name: 'บันทึกการตั้งค่า' });
    if (!await save.isDisabled()) await save.click();
    // The mode is written onto `body`, not the root element.
    await expect.poll(() => page.evaluate(() => document.body.dataset.appbar)).toBe('brand');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement)
      .getPropertyValue('--brand-surface').trim().toUpperCase())).toBe(colour);

    report[colour] = await page.evaluate(() => {
      const appbar = document.querySelector('.appbar');
      const behind = getComputedStyle(appbar).backgroundColor;
      const of = sel => {
        const el = appbar.querySelector(sel);
        if (!el) return null;
        const s = getComputedStyle(el);
        return { text: el.textContent.trim().slice(0, 20), colour: s.color,
          opacity: Number(s.opacity), weight: s.fontWeight, behind };
      };
      return { 'ชื่อยิม': of('.brand'), 'บรรทัดรองของชื่อยิม': of('.brand small'),
        'ชื่อบัญชีบนปุ่มเมนู': of('.cav'), 'role บนปุ่มเมนู': of('.cav span') };
    });
  }
  console.log('MENU-07 every ink on the full-colour app bar:\n'
    + JSON.stringify(Object.fromEntries(Object.entries(report).map(([c, rows]) =>
      [c, Object.fromEntries(Object.entries(rows).map(([k, v]) =>
        [k, v && `${ratio(v.colour, v.behind)}:1 · opacity ${v.opacity}`]))])), null, 1));

  for (const [colour, rows] of Object.entries(report)) {
    for (const [what, row] of Object.entries(rows)) {
      if (!row) continue;
      // Fading text to look secondary spends the contrast the token was
      // calculated to provide — the same trap as the bottom band of the card.
      expect(row.opacity, `${colour}: ${what} is faded to ${row.opacity}`).toBe(1);
      expect(ratio(row.colour, row.behind),
        `${colour}: ${what} ("${row.text}") is ${ratio(row.colour, row.behind)}:1 on ${row.behind}`)
        .toBeGreaterThanOrEqual(4.5);
    }
  }

  // Put it back, so the next spec does not inherit a bar it did not ask for.
  await go(page, 'ตั้งค่ายิม');
  await page.getByLabel('ทำหัวแอปเป็นสีแบรนด์').uncheck();
  const again = page.getByRole('button', { name: 'บันทึกการตั้งค่า' });
  if (!await again.isDisabled()) await again.click();
});

// ================================================== K5 · nothing else moved
test('MENU-08 every screen is still reachable, by rail or by menu', async ({ page }) => {
  await signIn(page, ADMIN);
  const everywhere = [...EVERYDAY, 'แพ็กเกจ', 'ผู้ใช้และสิทธิ์', 'ข้อมูลยิม', 'ตั้งค่ายิม', 'ประวัติเช็คอิน'];
  const landed = {};
  for (const label of everywhere) {
    await go(page, label);
    // `go()` returns on the click; the screen behind it is rendered a tick
    // later, and reading too early reports a real page as an empty one.
    await page.locator('.scanstage, main h1, main h2').first().waitFor();
    landed[label] = await page.evaluate(() => {
      if (document.querySelector('.scanstage')) return 'สแกนเช็คอิน';
      return document.querySelector('main h1')?.textContent.trim()
        ?? document.querySelector('main h2')?.textContent.trim() ?? '(no heading)';
    });
  }
  console.log('MENU-08 where each way in actually lands:\n' + JSON.stringify(landed, null, 1));
  for (const [label, heading] of Object.entries(landed)) {
    expect(heading, `"${label}" led nowhere`).not.toBe('(no heading)');
  }
  // The two that used to be "เพิ่มเติม" rows must still arrive somewhere real.
  expect(landed['ผู้ใช้และสิทธิ์']).toContain('ผู้ใช้');
  expect(landed['ประวัติเช็คอิน']).toContain('ประวัติ');
});
