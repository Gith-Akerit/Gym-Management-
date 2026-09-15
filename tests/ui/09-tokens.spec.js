import { test, expect } from '@playwright/test';
import { go, signIn } from './counter.js';

// Every colour the app asks for has to be a colour that exists.
//
// `var(--something-that-is-not-defined)` does not fail. It does not warn. The
// property simply falls back to whatever it inherits, and the page carries on
// looking almost right. That is how `color: var(--accent-ink)` -- a name no
// stylesheet in this repo ever defined -- left the gym's initials white on a
// white plate on the login screen of every gym, green included, for a whole
// release. Nothing was red anywhere; QA found it by looking at the screen.
//
// So this sweeps every custom property the app names, from both the
// stylesheets and the inline `style` attributes of what is on screen, and
// checks each one resolves on `:root`. Lifted from QA's `BRAND-UI-04`
// (qa/brand-login.spec.js) into the team's own suite so it runs every time.

/** The custom properties named on this page that resolve to nothing. */
const danglingHere = page => page.evaluate(() => {
  const root = getComputedStyle(document.documentElement);
  const named = new Set();
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }   // a sheet from elsewhere
    for (const rule of rules) {
      for (const [, name] of (rule.cssText ?? '').matchAll(/var\(\s*(--[\w-]+)/g)) named.add(name);
    }
  }
  // Inline styles are only in the DOM of the screen currently drawn, which is
  // why this runs on several screens rather than one.
  for (const el of document.querySelectorAll('[style]')) {
    for (const [, name] of el.getAttribute('style').matchAll(/var\(\s*(--[\w-]+)/g)) named.add(name);
  }
  return [...named].filter(name => !root.getPropertyValue(name).trim());
});

test('no screen asks for a colour that is defined nowhere', async ({ page }) => {
  const found = new Map();
  const sweep = async where => {
    for (const name of await danglingHere(page)) {
      if (!found.has(name)) found.set(name, where);
    }
  };

  // Signed out first: the login screen is the one every gym sees before it has
  // anything at all, and it is where this went wrong.
  await page.goto('/');
  await expect(page.locator('.loginstage .mark')).toBeVisible();
  await sweep('หน้าเข้าสู่ระบบ');

  await signIn(page, 'brand-admin@example.test');
  for (const screen of ['สมาชิก', 'สมัครสมาชิก', 'รับเงินและมอบแพ็กเกจ', 'แพ็กเกจ',
    'ผู้ใช้และสิทธิ์', 'ข้อมูลยิม', 'ตั้งค่ายิม', 'ประวัติเช็คอิน', 'สแกนเช็คอิน']) {
    await go(page, screen);
    await sweep(screen);
  }

  expect(Object.fromEntries(found), 'สไตล์อ้างตัวแปรสีที่ไม่มีนิยามอยู่จริง').toEqual({});
});

// ---------------------------------------------------------------------------
// And the colour it names has to be the one that answers the question asked.
//
// `--brand-surface` is the gym's colour nudged until TEXT ON IT is readable.
// Nothing about it is measured against the card it sits on, so a primary
// button that used it for both fill and border read perfectly and had no
// edges at all in a pale gym: white on white, 1:1, with the settings screen
// still showing five green rows because that table measures the words.
//
// The boundary of a control is a different bar -- 3:1, WCAG 1.4.11 -- and the
// token that clears it is `--brand-line`. Both bars are checked here at once,
// because a fix that buys the outline by dimming the label is not a fix.
// Lifted from QA's `BRAND-UI-05` (qa/brand-login.spec.js).

const CONTROL_BOUNDARY = 3;
const TEXT = 4.5;
const DANGEROUS = ['#05603A', '#C81E1E', '#F2C200', '#FFFFFF', '#808080'];

/** Contrast as WCAG counts it, between two `rgb(...)` strings. */
function ratio(a, b) {
  const channels = text => text.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
  const lum = ([r, g, b]) => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const [x, y] = [lum(channels(a)), lum(channels(b))];
  return +((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2);
}

/** Signed in and waited for: the API calls below need the session to exist. */
const enter = async page => {
  await signIn(page, 'brand-admin@example.test');
  // Signing in lands on the scan stage, which has no app bar, so wait for the
  // one control both it and the counter screens carry.
  await page.getByRole('button', { name: 'ออกจากระบบ' }).waitFor();
};

/** A colour saved the way the screen saves one, then waited for on the page. */
async function paint(page, hex) {
  const status = await page.evaluate(async colour => {
    const headers = { 'Content-Type': 'application/json', 'X-Gym-Client': 'web' };
    const { version } = await (await fetch('/api/gym/settings', { credentials: 'include', headers })).json();
    return (await fetch('/api/gym/settings', { method: 'PUT', credentials: 'include', headers,
      body: JSON.stringify({ color_primary: colour, version }) })).status;
  }, hex);
  expect(status, `บันทึกสี ${hex} ไม่สำเร็จ`).toBe(200);
  await page.reload();
  await page.waitForFunction(want => getComputedStyle(document.documentElement)
    .getPropertyValue('--brand-surface').trim().toUpperCase() === want, hex);
}

/**
 * Waits for the paint to stop moving.
 *
 * `.btn` transitions its background, so for a few frames after a colour change
 * the computed value is an interpolation between the old colour and the new
 * one -- a colour no token ever named, measured against an ink that already
 * changed. Two consecutive frames that agree mean the transition is over.
 */
const settled = page => page.waitForFunction(() => {
  const el = document.querySelector('.btn.primary');
  if (!el) return true;
  const now = getComputedStyle(el).backgroundColor;
  const same = window.__lastFill === now;
  window.__lastFill = now;
  return same;
});

/** Every primary button drawn on this screen, and what it is drawn on. */
const primaryButtons = page => page.evaluate(() => {
  // The button's own background is often transparent over a card; the colour a
  // person sees behind it is the first ancestor that paints one.
  const behind = el => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const colour = getComputedStyle(node).backgroundColor;
      if (colour && !/, 0\)$/.test(colour)) return colour;
    }
    return 'rgb(255, 255, 255)';
  };
  return [...document.querySelectorAll('.btn.primary')]
    .filter(el => el.getBoundingClientRect().width > 0)
    .map(el => {
      const style = getComputedStyle(el);
      return {
        label: el.textContent.trim().slice(0, 24),
        fill: style.backgroundColor,
        border: style.borderTopWidth === '0px' ? null : style.borderTopColor,
        ink: style.color,
        card: behind(el),
      };
    });
});

test('a button still looks like a button whatever colour the gym picked', async ({ page }) => {
  const failures = [];
  const measure = async where => {
    await settled(page);
    for (const seen of await primaryButtons(page)) {
      // Either the fill or the border may be what marks the edge; the control
      // is bounded if either one of them clears the bar.
      const outline = Math.max(ratio(seen.fill, seen.card),
        seen.border ? ratio(seen.border, seen.card) : 0);
      const label = ratio(seen.ink, seen.fill);
      if (outline < CONTROL_BOUNDARY) {
        failures.push(`${where} · ปุ่ม "${seen.label}" ไม่เหลือขอบให้เห็น `
          + `${seen.fill} บน ${seen.card} = ${outline}:1 (ต้อง ${CONTROL_BOUNDARY})`);
      }
      if (label < TEXT) {
        failures.push(`${where} · ตัวอักษรบนปุ่ม "${seen.label}" `
          + `${seen.ink} บน ${seen.fill} = ${label}:1 (ต้อง ${TEXT})`);
      }
    }
  };

  await enter(page);
  for (const colour of DANGEROUS) {
    await paint(page, colour);
    for (const screen of ['สมัครสมาชิก', 'ตั้งค่ายิม']) {
      await go(page, screen);
      await measure(`${colour} · ${screen}`);
    }
    // The login screen is the one every gym sees first, and the only one where
    // the primary button sits on the gym's own second colour.
    await page.context().clearCookies();
    await page.goto('/');
    await page.locator('.btn.primary').waitFor();
    await measure(`${colour} · หน้าเข้าสู่ระบบ`);
    await enter(page);
  }

  // Put the gym back the way the rest of the suite expects to find it.
  await paint(page, '#05603A');
  expect(failures, failures.join('\n')).toEqual([]);
});
