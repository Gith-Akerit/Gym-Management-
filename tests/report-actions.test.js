// Every action the system records has a sentence a person can read.
//
// The reports translate `audit_logs.action` into Thai from one table. An action
// added next month and never translated does not break anything -- it shows up
// on the owner's screen as `content.machine_edited` in the group "อื่น ๆ",
// which is the honest fallback and also the thing nobody notices for a year.
//
// So this reads the server for the actions actually written, rather than a
// list somebody has to remember to update. Same idea as deploy-paths.test.js:
// the code is the source, the table is what has to keep up with it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { ACTIONS, describeAction } from '../server/admin-reports.js';

const ROOT = new URL('../server/', import.meta.url);

/** Every string literal handed to `audit(...)` as its action argument. */
function actionsWritten() {
  const found = new Map();
  const files = readdirSync(ROOT).filter(name => name.endsWith('.js'));
  for (const file of files) {
    const source = readFileSync(new URL(file, ROOT), 'utf8');
    // audit(db, actor, 'the.action', ...) -- the third argument, on one line
    // or wrapped onto the next, which is how half of them are written.
    for (const [, action] of source.matchAll(/audit\(\s*db,\s*[^,]+,\s*'([a-z_]+\.[a-z_]+)'/g)) {
      found.set(action, file);
    }
  }
  return found;
}

test('every action the server writes has a Thai sentence in the report table', () => {
  const written = actionsWritten();
  assert.ok(written.size >= 20,
    `พบ action แค่ ${written.size} ตัว — regex อาจอ่านไฟล์ไม่เจอแล้ว`);

  const missing = [...written].filter(([action]) => !ACTIONS[action]);
  assert.deepEqual(missing.map(([action, file]) => `${action} (${file})`), [],
    'action เหล่านี้ถูกบันทึกลง audit_logs แต่ไม่มีคำแปลในรายงาน '
    + 'เจ้าของยิมจะเห็นเป็นรหัสดิบในกลุ่ม "อื่น ๆ" — เพิ่มใน ACTIONS ของ server/admin-reports.js');
});

test('the two that only the reports made possible are there, and say what they are', () => {
  // Without these the report can say what somebody did but not when they were
  // on shift, which was the question that started this round.
  for (const action of ['user.login', 'user.logout']) {
    assert.ok(ACTIONS[action], `${action} ต้องมีคำแปล`);
    assert.equal(describeAction(action)[0], 'เข้าสู่ระบบ');
  }
  // And the scan results, which are not written by `audit` at all -- they are
  // built from `check_ins` -- still need their sentences.
  for (const action of ['checkin.allowed', 'checkin.duplicate', 'checkin.denied']) {
    assert.equal(describeAction(action)[0], 'เช็คอิน');
  }
});

test('an action nobody has translated falls back rather than disappearing', () => {
  const [group, label] = describeAction('something.nobody.named');
  assert.equal(group, 'อื่น ๆ');
  assert.equal(label, 'something.nobody.named');
});
