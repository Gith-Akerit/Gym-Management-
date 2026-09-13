// QA Release Tester — MEM-033/035/036/037/040/052 in a real browser.
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

const luminance = ([r, g, b]) => {
  const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const parse = css => (css.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
const ratio = (fg, bg) => {
  const [a, b] = [luminance(parse(fg)), luminance(parse(bg))].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
};

test('MEM-036 every form control on the login screen has a real label', async ({ page }) => {
  await page.goto('/');
  const report = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('input,select,textarea')) {
      const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      out.push({
        tag: el.tagName.toLowerCase(), type: el.type, id: el.id || null,
        labelFor: byFor ? byFor.textContent.trim() : null,
        wrappedInLabel: !!el.closest('label'),
        ariaLabel: el.getAttribute('aria-label'),
        placeholderOnly: !byFor && !el.closest('label') && !el.getAttribute('aria-label') && !!el.placeholder,
      });
    }
    return out;
  });
  console.log('MEM-036 login controls:\n' + JSON.stringify(report, null, 2));
  const unlabelled = report.filter(c => !c.labelFor && !c.wrappedInLabel && !c.ariaLabel);
  console.log('MEM-036 unlabelled controls:', JSON.stringify(unlabelled));
  expect(unlabelled).toEqual([]);
});

test('MEM-035 the login flow is reachable with the keyboard only', async ({ page }) => {
  await page.goto('/');
  const order = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return 'BODY';
      const s = getComputedStyle(el);
      return `${el.tagName.toLowerCase()}${el.type ? ':' + el.type : ''}["${(el.textContent || el.getAttribute('aria-label') || el.id || '').trim().slice(0, 24)}"] outline=${s.outlineStyle}/${s.outlineWidth}`;
    }));
  }
  console.log('MEM-035 tab order:\n  ' + order.join('\n  '));
  await page.keyboard.press('Shift+Tab');
  await page.getByLabel('อีเมล', { exact: true }).focus();
  await page.keyboard.type('kb@example.test');
  await page.keyboard.press('Enter');
  const submittedByEnter = await page.getByLabel('รหัสยืนยัน 6 หลัก').waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
  console.log('MEM-035 Enter in the email field submits the form:', submittedByEnter);
  expect(submittedByEnter).toBeTruthy();
  const ring = await page.evaluate(() => {
    const b = document.querySelector('button');
    b.focus();
    const s = getComputedStyle(b);
    return { outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, boxShadow: s.boxShadow };
  });
  console.log('MEM-035 focus indicator on a button:', JSON.stringify(ring));
});

test('MEM-036 contrast of primary text, buttons and error messages', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('อีเมล', { exact: true }).fill('bad-email');
  await page.getByRole('button', { name: 'รับรหัสทางอีเมล' }).click();
  await page.waitForTimeout(600);
  const samples = await page.evaluate(() => {
    const pick = sel => { const el = document.querySelector(sel); if (!el) return null;
      const s = getComputedStyle(el);
      let bg = s.backgroundColor, node = el;
      while (bg === 'rgba(0, 0, 0, 0)' && node.parentElement) { node = node.parentElement; bg = getComputedStyle(node).backgroundColor; }
      return { sel, text: (el.textContent || '').trim().slice(0, 40), color: s.color, background: bg, fontSize: s.fontSize }; };
    return [pick('h1'), pick('button'), pick('label'), pick('[role="alert"]'), pick('.notice'), pick('p')].filter(Boolean);
  });
  const rows = samples.map(s => ({ ...s, ratio: Number(ratio(s.color, s.background).toFixed(2)) }));
  console.log('MEM-036 contrast:\n' + JSON.stringify(rows, null, 2));
  const failing = rows.filter(r => r.ratio < 4.5);
  console.log('MEM-036 below 4.5:1 :', JSON.stringify(failing.map(f => `${f.sel} (${f.ratio}:1) "${f.text}"`)));
  expect(failing.map(f => `${f.sel} ${f.ratio}:1 "${f.text}"`)).toEqual([]);
});

test('MEM-033 the member app degrades honestly when the API is unreachable', async ({ page }) => {
  await login(page, 'admin@example.test');
  await expect(page.getByRole('button', { name: 'แพ็กเกจ', exact: true })).toBeVisible();
  await page.route('**/api/**', route => route.abort('failed'));
  await page.getByRole('button', { name: 'แพ็กเกจ', exact: true }).click();
  await page.waitForTimeout(1500);
  const visible = await page.evaluate(() => document.body.innerText.slice(0, 600));
  console.log('MEM-033 screen with the API down:\n' + visible);
  const blank = visible.trim().length === 0;
  console.log('MEM-033 blank white screen:', blank);
  expect(blank).toBeFalsy();
  await page.unroute('**/api/**');
});

test('MEM-040/052 member screens on a 320px phone: no overflow, tap targets, Thai copy', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  const overflow = [];
  const check = async label => {
    const r = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      offenders: [...document.querySelectorAll('*')]
        .filter(e => e.getBoundingClientRect().right > window.innerWidth + 1)
        .slice(0, 5).map(e => `${e.tagName.toLowerCase()}.${e.className}`),
    }));
    console.log(`MEM-040 ${label}: scrollWidth=${r.scrollWidth} innerWidth=${r.innerWidth} offenders=${JSON.stringify(r.offenders)}`);
    if (r.scrollWidth > r.innerWidth + 1) overflow.push(`${label}: ${JSON.stringify(r.offenders)}`);
  };
  await check('login');
  await login(page, 'phone320@example.test');
  await expect(page.getByLabel('ชื่อ–นามสกุล')).toBeVisible();
  await check('profile form');
  await page.getByLabel('ชื่อ–นามสกุล').fill('จอเล็ก ทดสอบ');
  await page.getByLabel('เบอร์มือถือ').fill('0893334455');
  await page.getByRole('button', { name: 'เริ่มใช้งาน' }).click();
  await expect(page.getByRole('heading', { name: 'จอเล็ก ทดสอบ' })).toBeVisible();
  await check('member home');
  const small = await page.evaluate(() => [...document.querySelectorAll('button,a[href]')]
    .map(e => ({ text: (e.textContent || '').trim().slice(0, 20), h: Math.round(e.getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width) }))
    .filter(b => b.h > 0 && b.h < 44));
  console.log('MEM-040 tap targets under 44px tall:', JSON.stringify(small));
  const latin = await page.evaluate(() => (document.body.innerText.match(/\b[A-Za-z]{4,}\b/g) || []));
  console.log('MEM-037 Latin words visible on the member home screen:', JSON.stringify([...new Set(latin)]));
  expect(overflow).toEqual([]);
});

test('MEM-052 signup screen tells the member where the code went and how to resend', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('อีเมล', { exact: true }).fill('guide@example.test');
  await page.getByRole('button', { name: 'รับรหัสทางอีเมล' }).click();
  await expect(page.getByLabel('รหัสยืนยัน 6 หลัก')).toBeVisible();
  const text = await page.evaluate(() => document.body.innerText);
  console.log('MEM-052 OTP screen copy:\n' + text);
  const mentionsAddress = text.includes('guide@example.test');
  const hasResend = /ส่งรหัสใหม่|ขอรหัสใหม่|ส่งรหัสอีกครั้ง/.test(text);
  const hasCountdown = /\d+\s*(วินาที|นาที)/.test(text);
  const hasSpamHint = /สแปม|ขยะ|junk/i.test(text);
  console.log('MEM-052 shows the address:', mentionsAddress, '| resend control:', hasResend, '| countdown:', hasCountdown, '| spam-folder hint:', hasSpamHint);
  expect(mentionsAddress).toBeTruthy();
  expect(hasResend).toBeTruthy();
});
