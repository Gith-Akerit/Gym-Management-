import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';

// Source: Planner's seed JSON on KENC-20. Nothing here is confirmed business
// data — the reporter edits all of it from the admin console. Anything still
// unanswered (opening hours, prices) is seeded as a draft or left NULL so the
// app never shows an invented fact as if it were true.
export const GYM_PROFILE = {
  name: 'Suklutai Fitness',
  brand_name_th: 'สุขฤทัย ฟิตเนส',
  address: '95 ถ.ราษฎรอุทิศ ต.บางคล้า อ.บางคล้า จ.ฉะเชิงเทรา 24110',
  location_note: 'ชั้น 5 ของสุขฤทัยอพาร์ตเมนต์ (รอเจ้าของยืนยัน)',
  phone_primary: '038541029',
  phone_secondary: '0863307368',
  phone_display: 'primary',
  hours_confirmed: 0,
  hours_note: 'ข้อมูลจาก directory ขัดกัน: จันทร์-เสาร์ 15:00-21:00 หรือ 17:00-22:00 — ตั้งค่าชุดแรกไว้ก่อน รอเจ้าของยืนยัน',
};

// weekday 0 = Sunday. Seeded with the first candidate from the directory.
export const GYM_HOURS = [
  { weekday: 0, closed: 1, open_time: null, close_time: null },
  ...[1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, closed: 0, open_time: '15:00', close_time: '21:00' })),
];

// `description` is read by the customer at the counter while they decide, so
// it says what the package gives them and nothing else. That these are drafts
// waiting for the owner's real price is carried by `status` and by the empty
// `price_satang`, which is where the screens already look for it -- not by a
// note to ourselves in the middle of the sales copy.
export const PACKAGE_DRAFTS = [
  {
    code: 'UNLIMITED_30D', name_th: 'รายเดือน Unlimited', type: 'unlimited',
    duration_days: 30, session_limit: null, price_satang: null, sort_order: 10,
    description: 'เข้าใช้บริการได้ไม่จำกัดครั้งภายใน 30 วันนับจากวันที่เริ่มใช้',
  },
  {
    code: 'VISIT_10_90D', name_th: '10 ครั้ง ใช้ได้ 90 วัน', type: 'limited_sessions',
    duration_days: 90, session_limit: 10, price_satang: null, sort_order: 20,
    description: 'เข้าใช้บริการได้ 10 ครั้ง ภายใน 90 วันนับจากวันที่เริ่มใช้',
  },
  {
    code: 'TRIAL_1_VISIT', name_th: 'ทดลองเล่นฟรี 1 ครั้ง', type: 'limited_sessions',
    duration_days: 7, session_limit: 1, price_satang: 0, sort_order: 30,
    description: 'ทดลองเล่นฟรี 1 ครั้ง ใช้ได้ภายใน 7 วัน สำหรับผู้ที่ยังไม่เคยเป็นสมาชิก',
  },
];

/**
 * Inserts configuration that is missing and never overwrites what staff edited,
 * so it is safe to re-run after every deploy.
 */
export function seedConfiguration(db, now = Date.now()) {
  return transaction(db, () => {
    const created = { profile: false, hours: 0, packages: [] };
    if (!db.prepare('SELECT 1 FROM gym_profile WHERE id=1').get()) {
      db.prepare(`INSERT INTO gym_profile(id,name,brand_name_th,address,location_note,phone_primary,
        phone_secondary,phone_display,hours_confirmed,hours_note,updated_at)
        VALUES(1,?,?,?,?,?,?,?,?,?,?)`).run(GYM_PROFILE.name, GYM_PROFILE.brand_name_th,
        GYM_PROFILE.address, GYM_PROFILE.location_note, GYM_PROFILE.phone_primary,
        GYM_PROFILE.phone_secondary, GYM_PROFILE.phone_display, GYM_PROFILE.hours_confirmed,
        GYM_PROFILE.hours_note, now);
      created.profile = true;
    }
    for (const day of GYM_HOURS) {
      if (db.prepare('SELECT 1 FROM gym_hours WHERE weekday=?').get(day.weekday)) continue;
      db.prepare('INSERT INTO gym_hours(weekday,closed,open_time,close_time,updated_at) VALUES(?,?,?,?,?)')
        .run(day.weekday, day.closed, day.open_time, day.close_time, now);
      created.hours += 1;
    }
    for (const pkg of PACKAGE_DRAFTS) {
      if (db.prepare('SELECT 1 FROM packages WHERE code=?').get(pkg.code)) continue;
      db.prepare(`INSERT INTO packages(id,code,name_th,type,duration_days,session_limit,price_satang,
        description,status,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'draft',?,?,?)`)
        .run(randomUUID(), pkg.code, pkg.name_th, pkg.type, pkg.duration_days, pkg.session_limit,
          pkg.price_satang, pkg.description, pkg.sort_order, now, now);
      created.packages.push(pkg.code);
    }
    return created;
  });
}
