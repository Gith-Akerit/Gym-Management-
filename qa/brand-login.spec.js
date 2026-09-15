// QA Release Tester — the first screen anybody sees, in a gym that is not green.
//
//   UI_PORT=<port> npx playwright test qa/brand-login.spec.js
//
// The login stage was a fixed dark panel until `ba5fdf6`; now its background is
// the gym's own second colour. The inks on it did not move with it. This is the
// same shape as UI-01, which is what the reporter opened this issue about, so it
// gets a spec of its own rather than a line in a sweep.
import { test, expect } from '@playwright/test';
import { signIn, go } from '../tests/ui/counter.js';

const ADMIN = 'admin11@example.test';

/** Contrast as WCAG counts it, between two `rgb(...)` strings. */
function ratio(a, b) {
  const parse = c => c.match(/\d+/g).slice(0, 3).map(Number);
  const lum = ([r, g, b]) => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const [x, y] = [lum(parse(a)), lum(parse(b))];
  return +(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05))).toFixed(2);
}

const paint = async (page, hex) => {
  await page.goto('/');
  // These probes sign out and back in between colours, so the sign-in form is
  // there on some passes and not on others.
  if (await page.getByLabel('อีเมล', { exact: true }).isVisible().catch(() => false)) {
    await signIn(page, ADMIN);
  }
  await go(page, 'ตั้งค่ายิม');
  await page.getByLabel('สีหลัก', { exact: true }).fill(hex);
  await page.getByLabel('สีหลัก', { exact: true }).blur();
  const save = page.getByRole('button', { name: 'บันทึกการตั้งค่า' });
  // The button is disabled when nothing changed, which is the case whenever the
  // gym is already the colour being asked for.
  if (await save.isDisabled()) return;
  await save.click();
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกการตั้งค่ายิมแล้ว' })).toBeVisible();
};

/** Everything on the login hero, as it is actually painted. */
const hero = page => page.evaluate(() => {
  const at = selector => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const style = getComputedStyle(el);
    let background = style.backgroundColor;
    for (let node = el; node && /, 0\)$/.test(background); node = node.parentElement) {
      background = getComputedStyle(node).backgroundColor;
    }
    return { text: el.textContent.trim().slice(0, 30), color: style.color, background,
      // Fading text to make it look secondary is the trick that broke the
      // bottom band of the card: the measured colour then says one thing and
      // the eye sees another. Hierarchy comes from size and weight instead.
      opacity: Number(style.opacity), fontSize: style.fontSize, fontWeight: style.fontWeight };
  };
  return {
    stage: getComputedStyle(document.querySelector('.loginstage')).backgroundColor,
    mark: at('.loginstage .mark'),
    name: at('.loginstage h1'),
    subtitle: at('.loginstage h1 + p'),
  };
});

test.afterEach(async ({ page }) => {
  // The gym belongs to the other specs too; hand it back the way it was found.
  await paint(page, '#05603A').catch(() => {});
});

test('BRAND-UI-01 the gym badge on the login screen can be read', async ({ page }) => {
  for (const colour of ['#05603A', '#F2C200']) {
    await paint(page, colour);
    await page.context().clearCookies();
    await page.goto('/');
    await expect(page.locator('.loginstage .mark')).toBeVisible();
    const seen = await hero(page);
    console.log(`BRAND-UI-01 ${colour}: ${JSON.stringify(seen.mark)}`
      + ` -> ${ratio(seen.mark.color, seen.mark.background)}:1`);
    // The initials are the whole of the badge when there is no logo yet, which
    // is every gym on its first day.
    expect(seen.mark.text, 'the badge has nothing in it').not.toBe('');
    expect(ratio(seen.mark.color, seen.mark.background),
      `the initials are ${seen.mark.color} on ${seen.mark.background}`).toBeGreaterThanOrEqual(4.5);
  }
});

test('BRAND-UI-02 the gym name and the line under it survive a pale brand colour', async ({ page }) => {
  const report = {};
  for (const colour of ['#05603A', '#C81E1E', '#F2C200', '#FFFFFF']) {
    await paint(page, colour);
    await page.context().clearCookies();
    await page.goto('/');
    await expect(page.locator('.loginstage h1')).toBeVisible();
    const seen = await hero(page);
    report[colour] = {
      stage: seen.stage,
      name: ratio(seen.name.color, seen.name.background),
      subtitle: ratio(seen.subtitle.color, seen.subtitle.background),
      faded: [seen.name.opacity, seen.subtitle.opacity].filter(o => o < 1),
      sizes: [seen.name.fontSize, seen.subtitle.fontSize],
      weights: [seen.name.fontWeight, seen.subtitle.fontWeight],
    };
  }
  console.log('BRAND-UI-02 the login hero in four gyms:\n' + JSON.stringify(report, null, 1));
  for (const [colour, row] of Object.entries(report)) {
    // The gym name is 24-28px bold, so 3:1 is its bar; the line under it is
    // 16px body text and needs 4.5:1.
    expect(row.name, `${colour}: the gym name is ${row.name}:1 on ${row.stage}`).toBeGreaterThanOrEqual(3);
    expect(row.subtitle, `${colour}: the line under it is ${row.subtitle}:1 on ${row.stage}`)
      .toBeGreaterThanOrEqual(4.5);
    // Both lines carry the same ink; what separates them is size and weight,
    // not a faded copy of the first (the decision on this thread).
    expect(row.faded, `${colour}: something on the hero is faded with opacity`).toEqual([]);
    expect(row.sizes[0], `${colour}: the gym name is not larger than the line under it`)
      .not.toBe(row.sizes[1]);
  }
});

test('BRAND-UI-03 the gym badge on the scanner can be read too', async ({ page }) => {
  const report = {};
  for (const colour of ['#05603A', '#F2C200']) {
    await paint(page, colour);
    await go(page, 'สแกนเช็คอิน');
    await expect(page.locator('.scanbar')).toBeVisible();
    const declared = await page.evaluate(() => {
      const el = document.querySelector('.scanbar .mark');
      return { text: el.textContent.trim(), color: getComputedStyle(el).color };
    });
    // The badge is a translucent white patch over a dark bar, so nothing in the
    // computed styles is the colour a person actually sees. The pixels are.
    const shot = await page.locator('.scanbar .mark').screenshot();
    const ink = await page.evaluate(async bytes => {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      // The middle of the badge only: the rounded corners are antialiased
      // against the dark stage behind and would be read as "the letters".
      const inset = Math.round(Math.min(canvas.width, canvas.height) * 0.2);
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
      // The ink is whatever is furthest from the plate in brightness and still
      // covers enough pixels to be a stroke rather than an edge.
      const letters = ranked.filter(([, n]) => n > 15)
        .sort((a, b) => Math.abs(lum(b[0]) - lum(plate)) - Math.abs(lum(a[0]) - lum(plate)))[0]?.[0] ?? plate;
      return { plate, letters };
    }, Array.from(shot));
    report[colour] = { ...declared, ...ink, ratio: ratio(ink.letters, ink.plate) };
  }
  console.log('BRAND-UI-03 the badge on the scan bar, measured off the screen:\n'
    + JSON.stringify(report, null, 1));
  for (const [colour, row] of Object.entries(report)) {
    expect(row.ratio, `${colour}: the initials come out ${row.letters} on ${row.plate}`)
      .toBeGreaterThanOrEqual(4.5);
  }
});

test('BRAND-UI-04 no screen asks for a colour the stylesheet does not define', async ({ page }) => {
  await page.goto('/');
  // A `var()` that resolves to nothing does not fail loudly: the property falls
  // back to whatever it inherits, which is how white text ended up on a white
  // plate. Everything the app names has to exist.
  const dangling = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const named = new Set();
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        for (const match of (rule.cssText ?? '').matchAll(/var\(\s*(--[\w-]+)/g)) named.add(match[1]);
      }
    }
    for (const el of document.querySelectorAll('[style]')) {
      for (const match of el.getAttribute('style').matchAll(/var\(\s*(--[\w-]+)/g)) named.add(match[1]);
    }
    return [...named].filter(name => !root.getPropertyValue(name).trim());
  });
  console.log('BRAND-UI-04 colours the app asks for and nothing defines:', JSON.stringify(dangling));
  expect(dangling, 'a style names a custom property that is defined nowhere').toEqual([]);
});
