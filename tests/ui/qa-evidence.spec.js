// QA evidence capture for the bug report.
import { test, expect } from '@playwright/test';

async function login(page, email) {
  await page.goto('/');
  await page.getByLabel('อีเมล', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'รับรหัสทางอีเมล' }).click();
  await expect(page.getByLabel('รหัสยืนยัน 6 หลัก')).toBeVisible();
  const { code } = await (await page.request.get(`/__test/code?email=${email}`)).json();
  await page.getByLabel('รหัสยืนยัน 6 หลัก').fill(code);
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click();
}

test('evidence: English technical error rendered to a Thai admin', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await login(page, 'admin@example.test');
  await expect(page.getByRole('button', { name: 'แพ็กเกจ', exact: true })).toBeVisible();
  await page.route('**/api/**', route => route.abort('failed'));
  await page.getByRole('button', { name: 'แพ็กเกจ', exact: true }).click();
  await expect(page.getByText('Failed to fetch')).toBeVisible();
  await page.screenshot({ path: 'qa/evidence-failed-to-fetch.png', fullPage: true });
  await page.unroute('**/api/**');
});

test('evidence: English validation text rendered to a Thai admin', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await login(page, 'admin2@example.test');
  await page.getByRole('button', { name: 'แพ็กเกจ', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'แพ็กเกจทั้งหมด' })).toBeVisible();
  // Reproduce the raw Zod text through the API and show it next to the console.
  const res = await page.request.post('/api/members', {
    headers: { 'X-Gym-Client': 'web', 'Content-Type': 'application/json' },
    data: {},
  });
  const body = await res.json();
  console.log('evidence: POST /api/members {} ->', res.status(), JSON.stringify(body, null, 2));
  await page.screenshot({ path: 'qa/evidence-admin-packages.png', fullPage: true });
  expect(res.status()).toBe(400);
});
