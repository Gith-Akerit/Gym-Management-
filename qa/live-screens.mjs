// QA Release Tester — the screens on the running gym (170ee35).
//
//   node qa/live-screens.mjs
//
// The scan screen is a stage of its own with no rail, so every move starts by
// leaving it. At 390px the rail is replaced by the bottom bar, whose secondary
// tabs hide behind "เพิ่มเติม".
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { AUDIT } from './audit-probe.mjs';

const SITE = 'https://srv1979069.hstgr.cloud';
const PW = JSON.parse(readFileSync('../qa-live-password.json', 'utf8'));
mkdirSync('artifacts/live', { recursive: true });

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
const findings = [];
async function look(page, screen, width) {
  await page.waitForTimeout(600);
  const r = await page.evaluate(AUDIT);
  const file = `artifacts/live/${width}-${screen.replace(/[^฀-๿a-z0-9]+/gi, '_')}.png`;
  await page.screenshot({ path: file, fullPage: true });
  const problems = {
    ...(r.documentWidth > r.viewport + 1 && { scrolls_sideways: [r.documentWidth, r.viewport] }),
    ...(r.overflow.length && { overflow: r.overflow }),
    ...(r.clipped.length && { clipped_text: r.clipped }),
    ...(width === 390 && r.small.length && { tap_targets_under_44px: r.small }),
    ...(r.contrast.length && { low_contrast: r.contrast }),
  };
  findings.push({ screen, width, file, ...problems });
  console.log(`  ${String(width).padStart(4)}px  ${screen.padEnd(24)} `
    + (Object.keys(problems).length ? Object.keys(problems).join(', ') : 'clean'));
}

// ------------------------------------------------- UI-01 on the running gym
console.log('--- UI-01 · the labels the reporter said were invisible');
for (const width of [1280, 390]) {
  const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 },
    ...(width === 390 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const page = await ctx.newPage();
  await page.goto(SITE, { waitUntil: 'networkidle' });
  const labels = await page.evaluate(() => [...document.querySelectorAll('label')].map(el => {
    const rgb = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null;
      const [r, g, b, a = 1] = m[1].split(',').map(Number); return { r, g, b, a }; };
    const lum = ({ r, g, b }) => { const f = v => { v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    let bg = { r: 255, g: 255, b: 255 };
    for (let n = el; n; n = n.parentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (c && c.a !== 0) { bg = c; break; }
    }
    const fg = rgb(getComputedStyle(el).color);
    const ratio = (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05);
    return { text: el.textContent.trim().slice(0, 20), color: getComputedStyle(el).color,
      on: `rgb(${bg.r}, ${bg.g}, ${bg.b})`, ratio: Math.round(ratio * 100) / 100 };
  }));
  console.log(`   ${width}px:`, JSON.stringify(labels));
  await page.screenshot({ path: `artifacts/live/login-${width}.png`, fullPage: true });
  await ctx.close();
}

// ---------------------------------------------------------- the whole console
async function sweep(width) {
  const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 },
    ...(width === 390 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(String(e)));
  await page.goto(SITE, { waitUntil: 'networkidle' });
  await page.getByLabel('อีเมล', { exact: true }).fill('qa-admin@example.test');
  await page.getByLabel('รหัสผ่าน', { exact: true }).fill(PW.admin);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await page.locator('.scanstage').waitFor({ timeout: 25000 });
  console.log(`\n=== ${width}px ===`);
  await look(page, 'สแกนเช็คอิน', width);

  await page.getByRole('button', { name: 'ไปหน้าจัดการ' }).click();
  await page.locator("main .page").waitFor({ timeout: 10000 });
  const tabs = await page.$$eval('.railnav a', els => els.map(a => a.textContent.trim()));
  if (width === 1280) {
    console.log('   the owner\'s menu:', JSON.stringify(tabs));
    console.log('   a "ตรวจสลิป" tab still exists:', tabs.some(t => t.includes('ตรวจสลิป')));
  }

  const go = async label => {
    if (await page.locator('.scanstage').isVisible().catch(() => false)) {
      await page.getByRole('button', { name: 'ไปหน้าจัดการ' }).click();
      await page.locator("main .page").waitFor();
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
    catch (e) { console.log(`  ${String(width).padStart(4)}px  ${label.padEnd(24)} could not open: ${String(e).split('\n')[0].slice(0, 70)}`); }
  }

  // The member's own page: the card, and the receipts history that replaced
  // the slip-review queue.
  try {
    await go('สมาชิก');
    await page.getByRole('button', { name: /ทดสอบรอบสุดท้าย|^เปิด/ }).first().click();
    await page.waitForTimeout(1500);
    await look(page, 'สมาชิกรายคน', width);
    const history = await page.evaluate(() => {
      const heads = [...document.querySelectorAll('h2')].map(h => h.textContent.trim());
      const block = [...document.querySelectorAll('.block')]
        .find(b => b.querySelector('h2')?.textContent.includes('ประวัติการรับเงิน'));
      return { headings: heads, receipts: block ? block.innerText.replace(/\s+/g, ' ').slice(0, 400) : null };
    });
    console.log(`  ${width}px member page headings:`, JSON.stringify(history.headings));
    console.log(`  ${width}px ประวัติการรับเงิน:`, JSON.stringify(history.receipts));
  } catch (e) { console.log('   could not open a member:', String(e).split('\n')[0].slice(0, 80)); }

  console.log(`  ${width}px javascript errors:`, JSON.stringify(jsErrors));
  await ctx.close();
}

for (const width of [1280, 390]) await sweep(width);

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
