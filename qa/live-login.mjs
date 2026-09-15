import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { AUDIT } from './audit-probe.mjs';
const SITE = 'https://srv1979069.hstgr.cloud';
mkdirSync('artifacts/live', { recursive: true });
const browser = await chromium.launch({ channel: 'msedge' });
for (const [w, h] of [[1280, 900], [390, 844]]) {
  const page = await (await browser.newContext({ viewport: { width: w, height: h },
    ...(w === 390 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(SITE, { waitUntil: 'networkidle' });
  const r = await page.evaluate(AUDIT);
  await page.screenshot({ path: `artifacts/live/login-${w}.png`, fullPage: true });
  const invisible = await page.evaluate(() => [...document.querySelectorAll('label')]
    .filter(el => getComputedStyle(el).color === 'rgb(255, 255, 255)')
    .map(el => el.textContent.trim()));
  console.log(`--- หน้าเข้าสู่ระบบ @ ${w}px`);
  console.log('   scrolls sideways:', r.documentWidth > r.viewport + 1,
    '| overflow:', JSON.stringify(r.overflow), '| clipped:', JSON.stringify(r.clipped));
  console.log('   contrast below threshold:', JSON.stringify(r.contrast.map(c =>
    ({ text: c.text, ratio: c.ratio, color: c.color, bg: c.background }))));
  console.log('   labels rendered white:', JSON.stringify(invisible));
  console.log('   javascript errors:', JSON.stringify(errors));
  await page.context().close();
}
await browser.close();
