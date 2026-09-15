// QA Release Tester — the whole app wearing five different gyms (ba5fdf6).
//
//   UI_PORT=4391 node tests/ui-server.js &
//   UI_PORT=4391 PLAYWRIGHT_CHANNEL=msedge node qa/brand-sweep.mjs
//
// The theme now arrives from the server and repaints every screen. Two things
// that must survive that: the colours that mean pass and fail, which are not
// the gym's to choose, and the readability of every page the staff use all day.
// Both are checked against a gym that picked the worst colour it could.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { AUDIT } from './audit-probe.mjs';

const PORT = Number(process.env.UI_PORT || 4391);
const SITE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'admin12@example.test';
mkdirSync('artifacts/brand', { recursive: true });

// The colours a gym really picks off its own sign, plus the two extremes and
// the mid grey that neither black nor white sits well on.
const COLOURS = {
  'แดง': '#C81E1E',
  'เหลือง': '#F2C200',
  'ขาว': '#FFFFFF',
  'ดำ': '#000000',
  'เทากลาง': '#808080',
};

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
const password = await (await fetch(`${SITE}/__test/password`)).json();

async function api(token, method, path, body) {
  const res = await fetch(`${SITE}/api${path}`, { method,
    headers: { 'X-Gym-Client': 'mobile', 'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const signIn = async email => (await api(null, 'POST', '/auth/login',
  { email, password: password.password })).body.token;
const token = await signIn(ADMIN);
if (!token) { console.log(`could not sign in as ${ADMIN}`); process.exit(1); }
const paint = async hex => {
  const now = await api(token, 'GET', '/gym/settings');
  return api(token, 'PUT', '/gym/settings', { color_primary: hex, version: now.body.version });
};

// ------------------------------------------ the colours that are not the gym's
console.log('=== the things that mean pass and fail, in five different gyms ===');
const fixed = {};
for (const [name, hex] of Object.entries(COLOURS)) {
  const saved = await paint(hex);
  if (saved.status !== 200) { console.log(`  ${name}: could not save (${saved.status})`); continue; }
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto(SITE, { waitUntil: 'networkidle' });
  await page.getByLabel('อีเมล', { exact: true }).fill(ADMIN);
  await page.getByLabel('รหัสผ่าน', { exact: true }).fill(password.password);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await page.locator('.scanstage').waitFor({ timeout: 20000 });
  const read = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const want = ['--ok', '--ok-soft', '--deny', '--deny-soft', '--warn', '--brand-surface',
      '--on-brand', '--brand-2', '--brand-soft', '--brand-line', '--accent'];
    const out = {};
    for (const name of want) {
      const value = root.getPropertyValue(name).trim();
      if (value) out[name] = value.toUpperCase();
    }
    // And what a chip actually ends up painted, which is the thing a member of
    // staff reads across a counter.
    const swatch = document.createElement('span');
    swatch.className = 'chip ok';
    swatch.textContent = 'ผ่าน';
    document.body.append(swatch);
    const chip = getComputedStyle(swatch);
    const painted = { chip_ok_text: chip.color, chip_ok_background: chip.backgroundColor };
    swatch.remove();
    return { ...out, ...painted };
  });
  fixed[name] = read;
  console.log(`  ${name.padEnd(9)} ${hex}  ->  ${JSON.stringify(read)}`);
  await page.context().close();
}
const statusKeys = Object.keys(Object.values(fixed)[0] ?? {})
  .filter(k => /^--(ok|deny|warn|accent)/.test(k) || k.startsWith('chip_'));
const drift = statusKeys.filter(key => new Set(Object.values(fixed).map(row => row[key])).size > 1);
console.log('\n  status colours measured:', JSON.stringify(statusKeys));
console.log('  any that moved with the brand:', drift.length ? JSON.stringify(
  Object.fromEntries(drift.map(k => [k, Object.fromEntries(Object.entries(fixed).map(([n, r]) => [n, r[k]]))]))
) : 'none');

// -------------------------------------- every screen, wearing the worst colour
const WORST = process.env.SWEEP_COLOUR || '#F2C200';
console.log(`\n=== every screen with the brand set to ${WORST} ===`);
await paint(WORST);
const findings = [];
async function look(page, screen, width) {
  await page.waitForTimeout(600);
  const r = await page.evaluate(AUDIT);
  const file = `artifacts/brand/${width}-${screen.replace(/[^฀-๿a-z0-9]+/gi, '_')}.png`;
  await page.screenshot({ path: file, fullPage: true });
  const problems = {
    ...(r.documentWidth > r.viewport + 1 && { scrolls_sideways: [r.documentWidth, r.viewport] }),
    ...(r.overflow.length && { overflow: r.overflow.slice(0, 4) }),
    ...(r.clipped.length && { clipped_text: r.clipped.slice(0, 4) }),
    ...(width === 390 && r.small.length && { tap_targets_under_44px: r.small.slice(0, 4) }),
    ...(r.contrast.length && { low_contrast: r.contrast.slice(0, 6) }),
  };
  findings.push({ screen, width, file, ...problems });
  console.log(`  ${String(width).padStart(4)}px  ${screen.padEnd(22)} `
    + (Object.keys(problems).length ? Object.keys(problems).join(', ') : 'clean'));
  return problems;
}

for (const width of [1280, 390]) {
  const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 },
    ...(width === 390 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(String(e)));

  // The login screen: nobody is signed in, and the theme still has to arrive.
  await page.goto(SITE, { waitUntil: 'networkidle' });
  await look(page, 'เข้าสู่ระบบ', width);
  const loginBrand = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--brand-surface').trim().toUpperCase());
  console.log(`  ${String(width).padStart(4)}px  the login screen already wears the gym colour: ${loginBrand}`);

  await page.getByLabel('อีเมล', { exact: true }).fill(ADMIN);
  await page.getByLabel('รหัสผ่าน', { exact: true }).fill(password.password);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await page.locator('.scanstage').waitFor({ timeout: 20000 });
  await look(page, 'สแกนเช็คอิน', width);

  await page.getByRole('button', { name: 'ไปหน้าจัดการ' }).click();
  await page.locator('main .page').waitFor({ timeout: 10000 });
  const tabs = await page.$$eval('.railnav a', els => els.map(a => a.textContent.trim()));
  if (width === 1280) console.log('  the owner\'s menu:', JSON.stringify(tabs));

  const go = async label => {
    if (await page.locator('.scanstage').isVisible().catch(() => false)) {
      await page.getByRole('button', { name: 'ไปหน้าจัดการ' }).click();
      await page.locator('main .page').waitFor();
    }
    const rail = page.locator('.railnav').getByRole('link', { name: label, exact: true });
    if (await rail.isVisible().catch(() => false)) { await rail.click(); return page.waitForTimeout(500); }
    const bottom = page.locator('.bottomnav');
    let item = bottom.getByRole('link', { name: label, exact: true });
    if (!await item.isVisible().catch(() => false)) {
      await bottom.getByRole('link', { name: 'เพิ่มเติม', exact: true }).click();
      item = bottom.getByRole('link', { name: label, exact: true });
    }
    await item.click();
    await page.waitForTimeout(500);
  };
  for (const label of tabs.filter(t => t !== 'สแกนเช็คอิน')) {
    try { await go(label); await look(page, label, width); }
    catch (e) { console.log(`  ${String(width).padStart(4)}px  ${label.padEnd(22)} could not open: ${String(e).split('\n')[0].slice(0, 60)}`); }
  }
  console.log(`  ${String(width).padStart(4)}px  javascript errors: ${JSON.stringify(jsErrors)}`);
  await ctx.close();
}

// Put the gym back the way it was found, so the next run does not inherit it.
await paint('#05603A');
console.log('\nthe gym is back to the colour it shipped with');

const bad = findings.filter(f => Object.keys(f).length > 3);
console.log(`\n${findings.length} screens · ${bad.length} with something to look at`);
for (const f of bad) {
  console.log(`--- ${f.screen} @ ${f.width}px (${f.file})`);
  for (const [k, v] of Object.entries(f)) {
    if (['screen', 'width', 'file'].includes(k)) continue;
    console.log(`  ${k}: ${JSON.stringify(v)}`);
  }
}
await browser.close();
