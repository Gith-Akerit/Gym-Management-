// QA Release Tester — visual audit of the counter app at 1280 and 390.
//
// The project's own layout spec checks that nothing sticks out sideways. This
// adds the three things a person notices that a bounding box does not: text a
// box cuts off, targets a finger cannot hit, and contrast.
//
// Runs its own server on a private port, so it never fights the browser suite
// for 4310/4311.
//
//   node qa/ui-audit.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { AUDIT } from './audit-probe.mjs';

const PORT = Number(process.env.QA_UI_PORT || 4398);
const SITE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'counter-test-password';
const SHOTS = 'artifacts/audit';
mkdirSync(SHOTS, { recursive: true });

const server = spawn(process.execPath, ['tests/ui-server.js'], {
  env: { ...process.env, UI_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
for (let i = 0; i < 120; i++) {
  try { if ((await fetch(`${SITE}/api/health`)).ok) break; } catch { /* booting */ }
  await new Promise(r => setTimeout(r, 200));
}
console.log(`server up on ${PORT}\n`);

const findings = [];
async function audit(page, screen, width) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.waitForTimeout(400);
  const r = await page.evaluate(AUDIT);
  const file = `${SHOTS}/${String(findings.length + 1).padStart(2, '0')}-${width}.png`;
  await page.screenshot({ path: file, fullPage: true });
  const problems = {
    ...(r.documentWidth > r.viewport + 1 && { page_scrolls_sideways: [r.documentWidth, r.viewport] }),
    ...(r.overflow.length && { overflow: r.overflow }),
    ...(r.clipped.length && { clipped_text: r.clipped }),
    ...(width === 390 && r.small.length && { tap_targets_under_44px: r.small }),
    ...(r.contrast.length && { low_contrast: r.contrast }),
  };
  findings.push({ screen, width, file, ...problems });
  console.log(`  ${String(width).padStart(4)}px  ${screen.padEnd(28)} `
    + (Object.keys(problems).length ? Object.keys(problems).join(', ') : 'clean'));
}

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });

/** The menu is a rail on a desktop and a bar on a phone; four screens are on
 *  the bar and the rest sit behind "เพิ่มเติม". */
async function go(page, label) {
  const onStage = await page.locator('.scanstage').isVisible().catch(() => false);
  if (onStage && label === 'สแกนเช็คอิน') return;
  if (onStage) await page.getByRole('button', { name: 'ไปหน้าจัดการ' }).click();
  const rail = page.locator('.railnav').getByRole('link', { name: label, exact: true });
  if (await rail.isVisible().catch(() => false)) return rail.click();
  const bottom = page.locator('.bottomnav');
  let item = bottom.getByRole('link', { name: label, exact: true });
  if (!await item.isVisible().catch(() => false)) {
    await bottom.getByRole('link', { name: 'เพิ่มเติม' }).click();
    item = bottom.getByRole('link', { name: label, exact: true });
  }
  await item.click();
  await page.waitForTimeout(300);
}

const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const jsErrors = [];
page.on('pageerror', e => jsErrors.push(String(e)));

console.log('screen                               findings');
for (const width of [1280, 390]) {
  // The screen everybody starts on, before anybody has signed in.
  const anon = await (await browser.newContext()).newPage();
  await anon.goto(SITE);
  await audit(anon, 'เข้าสู่ระบบ', width);
  await anon.context().close();

  if (width === 1280) {
    await page.goto(SITE);
    await page.getByLabel('อีเมล', { exact: true }).fill('layout-admin@example.test');
    await page.getByLabel('รหัสผ่าน', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
    await page.locator('.scanstage').waitFor({ timeout: 15000 });
  }

  await go(page, 'สแกนเช็คอิน');
  await audit(page, 'สแกนเช็คอิน', width);

  for (const label of ['สมาชิก', 'ผู้ใช้และสิทธิ์', 'ตรวจสลิป', 'ประวัติเช็คอิน',
    'แพ็กเกจ', 'ข้อมูลยิม', 'รับเงินและมอบแพ็กเกจ', 'สมัครสมาชิก']) {
    try {
      await go(page, label);
      await audit(page, label, width);
    } catch (error) {
      console.log(`  ${String(width).padStart(4)}px  ${label.padEnd(28)} could not be opened: `
        + String(error).split('\n')[0].slice(0, 80));
    }
  }

  // One member's own page, where the card and the photograph live.
  try {
    await go(page, 'สมาชิก');
    await page.getByRole('button', { name: /^เปิดสมาชิก/ }).first().click();
    await page.waitForTimeout(800);
    await audit(page, 'สมาชิกรายคน (บัตร)', width);
  } catch {
    console.log(`  ${String(width).padStart(4)}px  สมาชิกรายคน                  no members to open`);
  }
}

console.log(`\njavascript errors on any screen: ${JSON.stringify(jsErrors)}`);
const withProblems = findings.filter(f => Object.keys(f).length > 3);
console.log(`${findings.length} screenshots · ${withProblems.length} screens with something to look at\n`);
for (const f of withProblems) {
  console.log(`--- ${f.screen} @ ${f.width}px  (${f.file})`);
  for (const [kind, detail] of Object.entries(f)) {
    if (['screen', 'width', 'file'].includes(kind)) continue;
    console.log(`  ${kind}: ${JSON.stringify(detail)}`);
  }
}
await browser.close();
server.kill();
