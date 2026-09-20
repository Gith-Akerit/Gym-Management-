// Bytes that have no business being in a source file.
//
// A NUL landed in server/admin-reports.js because a template literal was
// written with a real zero byte where `\0` was meant. Nothing broke -- the
// string still worked as a separator -- but git called the file binary, so
// `git diff` showed nothing, `grep` refused to print its lines, and a reviewer
// reading the diff of that commit could not see the code at all (QA).
//
// Cheap to check, and the cost of not checking is a file that quietly stops
// being reviewable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE = /\.(js|jsx|cjs|mjs|css|sql|html)$/;

function sources(folder) {
  const found = [];
  const walk = dir => {
    for (const entry of readdirSync(`${ROOT}${dir}`, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (SOURCE.test(entry.name)) found.push(path);
    }
  };
  walk(folder);
  return found;
}

test('no source file carries a byte that makes git call it binary', () => {
  const files = [...sources('server'), ...sources('web'), ...sources('shared'), ...sources('tests')];
  assert.ok(files.length > 40, `พบไฟล์แค่ ${files.length} ไฟล์ — ตัวกวาดอาจอ่านไม่เจอแล้ว`);

  const offenders = [];
  for (const file of files) {
    const bytes = readFileSync(`${ROOT}${file}`);
    const at = bytes.indexOf(0);
    if (at >= 0) offenders.push(`${file} (ไบต์ที่ ${at})`);
  }
  assert.deepEqual(offenders, [],
    'ไฟล์เหล่านี้มีไบต์ NUL ดิบ · git จะถือว่าเป็นไฟล์ไบนารี แล้ว diff กับ grep '
    + 'จะไม่แสดงบรรทัดในนั้นเลย — เขียนเป็น \0 ในสตริงแทน');
});

test('the separator that started it is an escape now, and still separates', () => {
  // The key it builds groups the summary by day and account. Two accounts on
  // the same day must not collapse into one bucket, which is what a separator
  // that appears in real data would do -- and no email or date contains one.
  const source = readFileSync(`${ROOT}server/admin-reports.js`, 'utf8');
  const escaped = '${day}' + String.fromCharCode(92) + '0${row.actor}';
  assert.ok(source.includes(escaped), 'ตัวคั่นต้องเขียนเป็น escape ไม่ใช่ไบต์ดิบ');
});
