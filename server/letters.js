// The five letters, filled in.
//
// The wording, the markup and the plain-text twin all come out of the
// Designer's `server/emails/mkmail.cjs` -- this file only puts values into the
// holes and hands the result to whatever is sending. Nothing here writes
// sentences: an email edited in two places is an email whose HTML and plain
// text say different things, which is exactly the failure `mkmail.cjs` exists
// to prevent.
//
// Every message is transactional. No List-Unsubscribe, no images, no
// webfonts, one link at most -- see docs in the spec. The one rule enforced
// here rather than in the template: if the gym has not filled in a telephone
// number, the sentence offering it is removed rather than printed with a dash.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('./emails/', import.meta.url));
const read = name => readFileSync(join(HERE, name), 'utf8');

const SUBJECTS = JSON.parse(read('subjects.json'));

/** Both halves of one letter, loaded once. */
const load = key => ({
  html: read(`${key}.html`),
  text: read(`${key}.txt`),
  subject: SUBJECTS.find(entry => entry.file === key)?.subject ?? '',
});

const TEMPLATES = Object.fromEntries(
  ['1-verify-email', '2-approved', '3-rejected', '4-reset-password', '5-member-welcome']
    .map(key => [key, load(key)]));

/** What an administrator can do, in the words the app itself uses. */
const ROLE_DETAIL = {
  staff: 'สแกนเช็คอิน · สมัครสมาชิก · รับเงินและมอบแพ็กเกจ',
  admin: 'จัดการได้ทุกอย่าง รวมตั้งค่ายิม แพ็กเกจ และอนุมัติผู้ใช้',
};

/**
 * Removes any line that still mentions a value the gym does not have.
 *
 * A letter that says "โทร -" is worse than one that does not mention the
 * telephone at all: it looks like the system lost something.
 */
function dropEmptyLines(text, missing) {
  if (!missing.length) return text;
  const holes = new RegExp(`\\{\\{(${missing.join('|')})\\}\\}`);
  return text.split('\n').filter(line => !holes.test(line)).join('\n');
}

function dropEmptyHtml(html, missing) {
  if (!missing.length) return html;
  const holes = new RegExp(`\\{\\{(${missing.join('|')})\\}\\}`);
  // The templates put one sentence per line, so a line is the unit that can be
  // removed without leaving an unbalanced tag behind.
  return html.split('\n').filter(line => !holes.test(line)).join('\n');
}

const fill = (template, values) =>
  template.replace(/\{\{([a-z_]+)\}\}/g, (whole, key) => (key in values ? String(values[key]) : whole));

/**
 * @param {'1-verify-email'|'2-approved'|'3-rejected'|'4-reset-password'|'5-member-welcome'} key
 * @param {object} values gym name, colours and whatever that letter needs
 * @returns {{subject: string, html: string, text: string}}
 */
export function letter(key, values = {}) {
  const template = TEMPLATES[key];
  if (!template) throw new Error(`no such letter: ${key}`);

  const all = {
    gym_name: 'ยิม',
    gym_phone: '',
    brand_surface: '#05603A',
    on_brand: '#FFFFFF',
    name: '',
    ...values,
  };
  // The Designer's rule: the name falls back to the part of the address in
  // front of the @, never to an empty greeting.
  if (!all.name) all.name = String(all.email ?? '').split('@')[0] || 'คุณผู้ใช้งาน';
  if (all.role && !all.role_label) {
    all.role_label = all.role === 'admin' ? 'ผู้ดูแลระบบ' : 'พนักงาน';
    all.role_detail = ROLE_DETAIL[all.role] ?? ROLE_DETAIL.staff;
  }

  const missing = ['gym_phone', 'expires_at', 'setpw_url'].filter(field => !all[field]);
  return {
    subject: fill(template.subject, all),
    html: fill(dropEmptyHtml(template.html, missing), all),
    text: fill(dropEmptyLines(template.text, missing), all),
  };
}

/** Every variable the templates ask for, for the test that checks coverage. */
export function variablesUsed() {
  const found = new Set();
  for (const template of Object.values(TEMPLATES)) {
    for (const source of [template.html, template.text, template.subject]) {
      for (const [, key] of source.matchAll(/\{\{([a-z_]+)\}\}/g)) found.add(key);
    }
  }
  return [...found].sort();
}
