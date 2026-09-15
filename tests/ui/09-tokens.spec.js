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
