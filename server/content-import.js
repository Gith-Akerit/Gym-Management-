#!/usr/bin/env node
/**
 * Loads the member portal's content from a file the Planner writes.
 *
 *   npm run content:import                      (docs/content/member-content.json)
 *   npm run content:import -- ./some-file.json
 *
 * Written as an import rather than a seed for one reason: this content is
 * edited in two places. The team writes the first draft in a file, and the
 * gym's trainer corrects the numbers on a screen afterwards. So a second run
 * must not quietly throw away what the trainer typed.
 *
 * The rule is therefore: a row somebody has REVIEWED is never overwritten.
 * Everything else is brought up to date, and anything new is added. The script
 * says which of the three happened to every row, because "imported 6 machines"
 * is not something anybody can check.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase, migrate, transaction } from './db.js';

const DEFAULT_FILE = 'docs/content/member-content.json';

const asJson = value => JSON.stringify(value ?? []);

export function importContent(db, content, now = Date.now()) {
  const report = { machines: [], programs: [], articles: [], safety: null };

  const upsert = (table, code, columns, values) => {
    const before = db.prepare(`SELECT reviewed_at FROM ${table} WHERE code=?`).get(code);
    if (before?.reviewed_at) {
      // Somebody at the gym has signed this off. Their numbers win over the
      // file every time -- that is the whole point of the review column.
      report[table].push({ code, action: 'kept' });
      return;
    }
    if (before) {
      db.prepare(`UPDATE ${table} SET ${columns.map(c => `${c}=?`).join(',')},
        version=version+1,updated_at=? WHERE code=?`).run(...values, now, code);
      report[table].push({ code, action: 'updated' });
      return;
    }
    db.prepare(`INSERT INTO ${table}(code,${columns.join(',')},updated_at) VALUES(?,${
      columns.map(() => '?').join(',')},?)`).run(code, ...values, now);
    report[table].push({ code, action: 'added' });
  };

  transaction(db, () => {
    (content.machines ?? []).forEach((machine, at) => {
      upsert('machines', machine.code,
        ['name_th', 'name_en', 'type', 'muscles', 'setup', 'steps', 'cautions',
          'intensity_howto', 'video_url', 'video_title', 'video_channel', 'sort_order'],
        [machine.name_th, machine.name_en ?? '', machine.type === 'cardio' ? 'cardio' : 'strength',
          asJson(machine.muscles), machine.setup ?? '', asJson(machine.steps), asJson(machine.cautions),
          machine.intensity_howto ?? '', machine.video?.url ?? '', machine.video?.title ?? '',
          machine.video?.channel ?? '', at]);
    });

    (content.programs ?? []).forEach((program, at) => {
      upsert('programs', program.code,
        ['name_th', 'goal', 'for_whom', 'level', 'frequency_per_week', 'minutes_per_session',
          'values_are_examples', 'trainer_note', 'progression', 'next_program', 'stations', 'sort_order'],
        [program.name_th, program.goal ?? '', program.for_whom ?? '', program.level ?? '',
          program.frequency_per_week ?? '', program.minutes_per_session ?? '',
          program.values_are_examples === false ? 0 : 1, program.trainer_note ?? '',
          program.progression ?? '', program.next_program ?? '', asJson(program.stations), at]);
    });

    (content.articles ?? []).forEach((article, at) => {
      upsert('articles', article.code, ['title', 'body', 'sort_order'],
        [article.title, asJson(article.body), at]);
    });

    // The safety wording is the gym's own advice, so an import never replaces
    // a version the owner has already approved.
    const safety = content.safety;
    if (safety) {
      const current = db.prepare('SELECT approved_at FROM safety_notices WHERE id=1').get();
      if (current?.approved_at) {
        report.safety = 'kept';
      } else {
        db.prepare(`UPDATE safety_notices SET portal_home_title=?,portal_home=?,machine_footer=?,
          program_before_start=?,version=version+1,updated_at=? WHERE id=1`)
          .run(safety.portal_home?.title ?? '', asJson(safety.portal_home?.body),
            asJson(safety.machine_footer), asJson(safety.program_before_start), now);
        report.safety = current ? 'updated' : 'added';
      }
    }
  });

  return report;
}

/** Only when run as a command, so the function above stays testable. */
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
  || process.argv[1]?.endsWith('content-import.js')) {
  // Before anything reads process.env. Without it the command opened
  // ./data/gym.sqlite instead of the DATABASE_PATH in .env, created that file,
  // wrote the content into it and printed "เพิ่ม 6" for a database the app
  // never opens -- the install looked done and every sticker led to a blank
  // page (QA BUG-09).
  //
  // Here rather than at the top of the file like the other commands, because
  // this one is also a library: tests/ui-server.js imports importContent, and
  // a module that reads a developer's .env as a side effect of being imported
  // would quietly hand the browser suite that developer's PILOT_MODE.
  await import('./load-env.js');
  const file = resolve(process.argv[2] ?? DEFAULT_FILE);
  const db = openDatabase(process.env.DATABASE_PATH || './data/gym.sqlite');
  migrate(db);
  const report = importContent(db, JSON.parse(readFileSync(file, 'utf8')));
  const count = (rows, action) => rows.filter(row => row.action === action).length;
  for (const table of ['machines', 'programs', 'articles']) {
    const rows = report[table];
    console.log(`${table}: เพิ่ม ${count(rows, 'added')} · อัปเดต ${count(rows, 'updated')} `
      + `· ไม่แตะเพราะมีคนตรวจแล้ว ${count(rows, 'kept')}`);
    for (const row of rows.filter(entry => entry.action === 'kept')) {
      console.log(`  ${row.code} ถูกตรวจแล้ว ข้อมูลในไฟล์ไม่ถูกเขียนทับ`);
    }
  }
  console.log(`ข้อความความปลอดภัย: ${report.safety ?? 'ไม่มีในไฟล์'}`);
  db.close();
}
