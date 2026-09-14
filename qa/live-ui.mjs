// QA Release Tester — the new look, measured on the running gym.
//
//   node qa/live-ui.mjs
//
// Only the screens a visitor can reach without signing in: the QA sessions were
// cleaned off the box after the last round, and the owner's account is not ours
// to borrow. The rest is covered locally against a build with the same asset
// hashes as the one the box is serving, which the script checks first.
import { chromium } from 'playwright';
import { mkdirSync, readdirSync } from 'node:fs';
import { AUDIT } from './audit-probe.mjs';

const SITE = 'https://srv1979069.hstgr.cloud';
const SHOTS = 'artifacts/live';
mkdirSync(SHOTS, { recursive: true });

const html = await (await fetch(SITE)).text();
const served = [...html.matchAll(/assets\/(index-[A-Za-z0-9_-]+\.(?:css|js))/g)].map(m => m[1]);
const built = readdirSync('dist/assets');
console.log('assets the box is serving:', JSON.stringify(served));
console.log('assets in the local build :', JSON.stringify(built.filter(f => f.startsWith('index-'))));
console.log('same build:', served.every(f => built.includes(f)) ? 'yes' : 'NO — the box is on a different bundle');
console.log('');

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
for (const [width, height] of [[1280, 900], [390, 844]]) {
  const ctx = await browser.newContext({ viewport: { width, height },
    ...(width === 390 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('response', r => { if (r.status() >= 400 && !r.url().endsWith('/api/me')) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto(SITE, { waitUntil: 'networkidle' });

  const r = await page.evaluate(AUDIT);
  await page.screenshot({ path: `${SHOTS}/live-home-${width}.png`, fullPage: true });
  console.log(`--- หน้าแรก (สาธารณะ) @ ${width}px`);
  console.log('   page scrolls sideways:', r.documentWidth > r.viewport + 1,
    `(document ${r.documentWidth} / viewport ${r.viewport})`);
  console.log('   elements past the edge:', JSON.stringify(r.overflow));
  console.log('   text cut off by its box:', JSON.stringify(r.clipped));
  console.log('   contrast below the threshold:', JSON.stringify(r.contrast));
  if (width === 390) console.log('   tap targets under 44px:', JSON.stringify(r.small));
  console.log('   javascript / request errors:', JSON.stringify(errors));

  // The one screen past the login that a visitor can still open.
  await page.getByLabel('อีเมล', { exact: true }).fill(`qa-look-${width}@example.test`);
  await page.getByRole('button', { name: /ขอรหัสเข้าใช้งาน|รับรหัสทางอีเมล/ }).click();
  await page.getByLabel('รหัสยืนยัน 6 หลัก').waitFor({ timeout: 15000 });
  const r2 = await page.evaluate(AUDIT);
  await page.screenshot({ path: `${SHOTS}/live-code-${width}.png`, fullPage: true });
  console.log(`--- หน้ากรอกรหัส @ ${width}px`);
  console.log('   page scrolls sideways:', r2.documentWidth > r2.viewport + 1);
  console.log('   elements past the edge:', JSON.stringify(r2.overflow));
  console.log('   contrast below the threshold:', JSON.stringify(r2.contrast));
  console.log('');
  await ctx.close();
}
await browser.close();
