// What a member reads, and who is allowed to read it.
//
// The visibility rule comes straight from the Planner's file and is the thing
// to get right:
//
//   machines, articles  → PUBLIC. There is a QR sticker on the side of every
//                         machine. Somebody standing at it with a phone has
//                         not signed in and is not going to, and a page that
//                         asks them to is a sticker nobody scans twice.
//   home, programmes    → members whose membership is still live. This is the
//                         part they are paying for.
//
// The machine page is therefore served as HTML by the server rather than by
// the single-page app: it is opened from a sticker, once, by somebody standing
// up, on gym wifi. Shipping 400 KB of React to answer "how do I use this
// machine" is the difference between an answer and a spinner.

import { createRequire } from 'node:module';
import { z } from 'zod';
import { audit, transaction } from './db.js';
import { resolveTheme } from './theme.js';
import { brandShort, settingsRow } from './settings-routes.js';
import { SlipError } from './slips.js';
import { HttpError, parse } from './validation.js';

/** The same rule the browser prints the gym's number with. See shared/phone.cjs. */
const { formatPhone } = createRequire(import.meta.url)('../shared/phone.cjs');

const list = value => { try { return JSON.parse(value ?? '[]'); } catch { return []; } };

/** HTML escaping. Everything below builds a page by hand, so this is the wall. */
const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The YouTube id, or null for anything that is not a YouTube watch link. */
export function youTubeId(url) {
  const found = /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,20})/.exec(url ?? '');
  return found ? found[1] : null;
}

export const publicMachine = row => ({
  code: row.code, name_th: row.name_th, name_en: row.name_en, type: row.type,
  muscles: list(row.muscles), setup: row.setup, steps: list(row.steps),
  cautions: list(row.cautions), intensity_howto: row.intensity_howto,
  video: row.video_url
    ? { url: row.video_url, title: row.video_title, channel: row.video_channel, youtube_id: youTubeId(row.video_url) }
    : null,
  has_photo: !!row.photo_stored_name,
  photo_url: row.photo_stored_name ? `/api/public/machines/${row.code}/photo?v=${row.photo_updated_at ?? 0}` : null,
  reviewed: !!row.reviewed_at,
});

export const publicProgram = row => ({
  code: row.code, name_th: row.name_th, goal: row.goal, for_whom: row.for_whom,
  level: row.level, frequency_per_week: row.frequency_per_week,
  minutes_per_session: row.minutes_per_session,
  // Carried all the way to the screen on purpose: numbers nobody at this gym
  // has checked must not be printed as if the gym said them.
  values_are_examples: !!row.values_are_examples,
  trainer_note: row.trainer_note, progression: row.progression, next_program: row.next_program,
  stations: list(row.stations), reviewed: !!row.reviewed_at,
});

export const publicArticle = row => ({ code: row.code, title: row.title, body: list(row.body) });

const machineSchema = z.object({
  name_th: z.string().trim().min(1, 'กรุณากรอกชื่อเครื่อง').max(120),
  setup: z.string().max(600).optional(),
  steps: z.array(z.string().max(400)).max(12).optional(),
  cautions: z.array(z.string().max(400)).max(12).optional(),
  intensity_howto: z.string().max(600).optional(),
  video_url: z.string().trim().max(400).optional(),
  video_title: z.string().trim().max(200).optional(),
  video_channel: z.string().trim().max(120).optional(),
  reviewed: z.boolean().optional(),
  version: z.number().int().positive(),
}).strict();

const stationSchema = z.object({
  order: z.coerce.number().int().min(1).max(30),
  machine: z.string().trim().max(20),
  role: z.string().trim().max(60).optional(),
  duration: z.string().trim().max(60).nullish(),
  sets: z.string().trim().max(60).nullish(),
  reps: z.string().trim().max(60).nullish(),
  rest: z.string().trim().max(60).nullish(),
  note: z.string().trim().max(400).optional(),
}).strict();

const articleSchema = z.object({
  title: z.string().trim().min(1, 'กรุณากรอกชื่อบทความ').max(200),
  body: z.array(z.string().max(1200)).max(30).optional(),
  reviewed: z.boolean().optional(),
  version: z.number().int().positive(),
}).strict();

/**
 * The safety wording, and the press that puts the gym's name on it.
 *
 * `approved` is separate from the text for the same reason `reviewed` is on a
 * machine: editing a sentence is not the same act as standing behind it. The
 * owner can fix a typo without re-approving, and can approve without editing.
 */
const safetySchema = z.object({
  portal_home_title: z.string().trim().max(200).optional(),
  portal_home: z.array(z.string().max(600)).max(20).optional(),
  machine_footer: z.array(z.string().max(600)).max(20).optional(),
  program_before_start: z.array(z.string().max(600)).max(20).optional(),
  approved: z.boolean().optional(),
  version: z.number().int().positive(),
}).strict();

const programSchema = z.object({
  name_th: z.string().trim().min(1).max(120),
  stations: z.array(stationSchema).max(30),
  progression: z.string().max(800).optional(),
  trainer_note: z.string().max(800).optional(),
  // The press that says a trainer has been through the numbers. Once it is
  // true the import stops overwriting this row, so it is a real commitment.
  values_are_examples: z.boolean(),
  reviewed: z.boolean().optional(),
  version: z.number().int().positive(),
}).strict();

/** The four reads every part of this file needs. */
const readers = db => ({
  machines: () => db.prepare('SELECT * FROM machines ORDER BY sort_order, code').all(),
  machineRow: code => db.prepare('SELECT * FROM machines WHERE code=?').get(code) ?? null,
  articles: () => db.prepare('SELECT * FROM articles ORDER BY sort_order, code').all(),
  safety: () => db.prepare('SELECT * FROM safety_notices WHERE id=1').get() ?? {},
});

/**
 * Everything a stranger may read, registered BEFORE the session middleware.
 *
 * It has to be: somebody standing at a machine with a phone has no session and
 * is not going to get one. Registering these with the rest put them behind the
 * session guard and the sticker answered "please sign in again", which is the
 * one thing a sticker must never say.
 */
export function registerPublicContentRoutes({ app, db, machineStore }) {
  const { machines, machineRow, articles, safety } = readers(db);

  /**
   * The four lines that turn the still into a player, served as a file.
   *
   * Not inline in the page: the app's CSP is `script-src 'self'`, and loosening
   * that to allow inline script -- on the one page in this system a stranger
   * can open without signing in -- to save a request would be the wrong trade
   * by a wide margin.
   */
  app.get('/m/_play.js', (req, res) => {
    res.type('application/javascript');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(`document.addEventListener('click', function (event) {
  var button = event.target.closest('[data-video]');
  if (!button) return;
  var frame = document.createElement('iframe');
  frame.width = '100%'; frame.height = '220'; frame.style.border = '0';
  frame.allow = 'accelerometer; encrypted-media; picture-in-picture';
  frame.allowFullscreen = true;
  frame.src = 'https://www.youtube-nocookie.com/embed/' + button.dataset.video + '?autoplay=1';
  button.replaceWith(frame);
});
`);
  });

  app.get('/api/public/machines', (req, res) =>
    res.json({ items: machines().map(publicMachine) }));
  app.get('/api/public/machines/:code', (req, res) => {
    const row = machineRow(req.params.code);
    if (!row) throw new HttpError(404, 'ไม่พบเครื่องนี้');
    res.json({ machine: publicMachine(row), safety_footer: list(safety().machine_footer) });
  });
  app.get('/api/public/articles', (req, res) => res.json({ items: articles().map(publicArticle) }));

  app.get('/api/public/machines/:code/photo', (req, res) => {
    const row = machineRow(req.params.code);
    if (!row?.photo_stored_name) throw new HttpError(404, 'ยังไม่มีรูปของเครื่องนี้');
    let bytes;
    try { bytes = machineStore?.read(row.photo_stored_name) ?? null; } catch { bytes = null; }
    if (!bytes) throw new HttpError(404, 'ไม่พบไฟล์รูป');
    res.set('Content-Type', row.photo_content_type);
    // A photograph of a machine is the one image here that is not personal
    // data, so it may be cached -- but never sniffed into something else.
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(bytes);
  });

  /**
   * The page behind the sticker on the machine.
   *
   * Server-rendered, no JavaScript, one request. Somebody is standing next to
   * the thing with one hand on a phone; every kilobyte is a second of them
   * looking at a blank screen while a stranger waits to use the machine.
   *
   * The video is a picture and a button until it is pressed -- an embedded
   * YouTube iframe drags a megabyte per clip onto gym wifi, and five of them
   * on a programme page is five megabytes for something most people never
   * play (Designer).
   */
  app.get('/m/:code', (req, res, next) => {
    const row = machineRow(req.params.code.toUpperCase());
    if (!row) return next();
    const machine = publicMachine(row);
    const theme = resolveTheme(settingsRow(db));
    const gym = db.prepare('SELECT * FROM gym_profile WHERE id=1').get() ?? {};
    const name = gym.brand_name_th || gym.name || 'ยิม';
    const item = text => `<li>${esc(text)}</li>`;

    res.type('html').send(`<!doctype html>
<html lang="th"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="${esc(theme.brand_surface)}">
<title>${esc(machine.name_th)} · ${esc(name)}</title>
<style>
:root{--brand:${esc(theme.brand_surface)};--on-brand:${esc(theme.on_brand)};--ink:#0E1418;--ink2:#3D4852;
  --line:#E4E9ED;--canvas:#EFF2F4;--bad:#C62A1E;--bad-soft:#FBE9E7}
*{box-sizing:border-box}
body{margin:0;background:var(--canvas);color:var(--ink);
  font:16px/1.7 Tahoma,'Leelawadee UI','Sukhumvit Set',-apple-system,'Segoe UI',Roboto,sans-serif}
header{background:var(--brand);color:var(--on-brand);padding:18px 20px}
header b{display:block;font-size:14px;font-weight:700;opacity:.95}
header h1{margin:4px 0 0;font-size:24px;line-height:1.3}
header span{font-size:15px}
main{max-width:720px;margin:0 auto;padding:20px 16px 48px}
section{background:#fff;border:2px solid var(--line);border-radius:12px;padding:18px;margin-bottom:16px}
h2{margin:0 0 10px;font-size:19px}
ol,ul{margin:0;padding-left:22px}
li{margin-bottom:8px}
img.shot{width:100%;border-radius:10px;display:block;border:2px solid var(--line)}
.warn{background:var(--bad-soft);border-color:var(--bad)}
.warn h2{color:var(--bad)}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 14px;padding:0;list-style:none}
.chips li{margin:0;background:#fff;border:2px solid var(--line);border-radius:999px;padding:4px 12px;font-size:14px}
.play{display:block;width:100%;border:2px solid var(--line);border-radius:10px;overflow:hidden;
  background:#000;cursor:pointer;padding:0;position:relative}
.play img{width:100%;display:block;opacity:.85}
.play .btn{position:absolute;inset:0;display:grid;place-items:center;color:#fff;font-size:44px;
  text-shadow:0 2px 10px rgba(0,0,0,.6)}
.vnote{margin:10px 0 0;font-size:14px;color:var(--ink2)}
footer{max-width:720px;margin:0 auto;padding:0 16px 40px;color:var(--ink2);font-size:14px}
</style>
</head><body>
<header>
  <b>${esc(name)}</b>
  <h1>${esc(machine.name_th)}</h1>
  ${machine.name_en ? `<span>${esc(machine.name_en)}</span>` : ''}
</header>
<main>
  ${machine.muscles.length ? `<ul class="chips">${machine.muscles.map(item).join('')}</ul>` : ''}
  ${machine.has_photo ? `<section><img class="shot" src="${esc(machine.photo_url)}" alt="${esc(machine.name_th)}"></section>` : ''}
  ${machine.setup ? `<section><h2>ก่อนเริ่ม ตั้งเครื่องอย่างนี้</h2><p>${esc(machine.setup)}</p></section>` : ''}
  ${machine.steps.length ? `<section><h2>วิธีใช้</h2><ol>${machine.steps.map(item).join('')}</ol></section>` : ''}
  ${machine.cautions.length ? `<section class="warn"><h2>ข้อควรระวัง</h2><ul>${machine.cautions.map(item).join('')}</ul></section>` : ''}
  ${machine.intensity_howto ? `<section><h2>ควรหนักแค่ไหน</h2><p>${esc(machine.intensity_howto)}</p></section>` : ''}
  ${machine.video?.youtube_id ? `<section><h2>ดูคลิป</h2>
    <button class="play" data-video="${esc(machine.video.youtube_id)}" aria-label="เล่นคลิป ${esc(machine.video.title)}">
      <img src="https://i.ytimg.com/vi/${esc(machine.video.youtube_id)}/hqdefault.jpg" alt="" referrerpolicy="no-referrer">
      <span class="btn" aria-hidden="true">▶</span>
    </button>
    <p class="vnote">${esc(machine.video.title)}${machine.video.channel ? ` · ${esc(machine.video.channel)}` : ''}<br>
      คลิปนี้เป็นของช่องอื่นบน YouTube กดแล้วจึงเริ่มโหลด · ถ้าเปิดไม่ได้ แปลว่าเจ้าของคลิปลบไปแล้ว
      ให้ถามพนักงานที่เคาน์เตอร์แทน</p></section>` : ''}
  ${list(safety().machine_footer).length
    ? `<section><h2>ก่อนใช้ครั้งแรก</h2><ul>${list(safety().machine_footer).map(item).join('')}</ul></section>`
    : ''}
</main>
<footer>${esc(name)}${gym.phone_primary ? ` · โทร ${esc(formatPhone(gym.phone_primary))}` : ''}</footer>
${machine.video?.youtube_id ? '<script src="/m/_play.js" defer></script>' : ''}
</body></html>`);
  });

}

/**
 * The answer for a sticker that no longer matches a machine.
 *
 * `/m/:code` hands an unknown code onward so the portal's own two screens can
 * claim their paths, and whatever was left at the end of the line answered
 * with Express's default page: `Cannot GET /m/M-99`, in English, under the
 * heading "Error". The person reading it is standing next to the machine with
 * a phone in one hand, and it is the first thing this gym has ever shown them
 * (QA BUG-11).
 *
 * Registered by whoever owns the listening server, because it has to come
 * after the single-page app's routes and after the static files -- so both
 * `server/start.js` and the browser suite's server call this, and a test in
 * tests/machine-page.test.js checks that neither one forgets.
 */
export function registerMachineFallback({ app, db }) {
  app.use('/m', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let name = 'ยิม';
    let theme = resolveTheme(null);
    // A page whose whole job is to be the friendly end of the line must not be
    // able to throw: it is registered after createApp's error handler, so an
    // error here lands back on the English page it exists to replace.
    try {
      const gym = db.prepare('SELECT * FROM gym_profile WHERE id=1').get() ?? {};
      name = gym.brand_name_th || gym.name || 'ยิม';
      theme = resolveTheme(settingsRow(db));
    } catch { /* fall back to the plain wording below */ }

    res.status(404).type('html').send(`<!doctype html>
<html lang="th"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="${esc(theme.brand_surface)}">
<title>ไม่พบเครื่องนี้ · ${esc(name)}</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#EFF2F4;color:#0E1418;
  font:16px/1.7 Tahoma,'Leelawadee UI','Sukhumvit Set',-apple-system,'Segoe UI',Roboto,sans-serif}
header{background:${esc(theme.brand_surface)};color:${esc(theme.on_brand)};padding:18px 20px}
header b{display:block;font-size:14px;font-weight:700;opacity:.95}
header h1{margin:4px 0 0;font-size:24px;line-height:1.3}
main{max-width:720px;margin:0 auto;padding:20px 16px 48px}
section{background:#fff;border:2px solid #E4E9ED;border-radius:12px;padding:18px}
p{margin:0 0 10px}
p:last-child{margin:0;color:#3D4852;font-size:14px}
</style>
</head><body>
<header>
  <b>${esc(name)}</b>
  <h1>ไม่พบเครื่องนี้</h1>
</header>
<main><section>
  <p>สติกเกอร์นี้อาจเป็นของเครื่องที่ย้ายออกไปแล้ว หรือรหัสเปลี่ยนไป</p>
  <p><b>ถามพนักงานที่เคาน์เตอร์ได้เลย</b> เขาเปิดวิธีใช้เครื่องนี้ให้ดูได้ทันที</p>
  <p>ถ้าคุณเป็นสมาชิกและเข้าสู่ระบบอยู่แล้ว ดูวิธีใช้เครื่องทั้งหมดได้ในเมนู "เครื่อง" ของ "ช่วยเล่น"</p>
</section></main>
</body></html>`);
  });
}

export function registerContentRoutes({ app, db, now, admin, member, paidUp, origin,
  machineStore, receiveMachinePhoto }) {
  const { machines, machineRow, articles, safety } = readers(db);

  // ------------------------------------------------------- the member's side

  app.get('/api/m/home', member, paidUp, (req, res) => {
    const notices = safety();
    res.json({
      name: req.member.name,
      programs: db.prepare('SELECT * FROM programs ORDER BY sort_order, code').all().map(publicProgram)
        .map(({ stations, ...rest }) => rest),
      machines: machines().map(publicMachine).map(({ steps, cautions, ...rest }) => rest),
      articles: articles().map(publicArticle).map(({ body, ...rest }) => rest),
      safety: { title: notices.portal_home_title ?? '', body: list(notices.portal_home) },
    });
  });

  app.get('/api/m/programs/:code', member, paidUp, (req, res) => {
    const row = db.prepare('SELECT * FROM programs WHERE code=?').get(req.params.code);
    if (!row) throw new HttpError(404, 'ไม่พบโปรแกรมนี้');
    const program = publicProgram(row);
    // Every station names a machine, and the screen has to show its name and
    // link to its page. Resolved here so the browser makes one request.
    const named = program.stations.map(station => {
      const machine = machineRow(station.machine);
      return { ...station, machine_name: machine?.name_th ?? station.machine,
        machine_exists: !!machine };
    });
    res.json({ program: { ...program, stations: named },
      before_start: list(safety().program_before_start) });
  });

  // ------------------------------------------------------- the owner's side

  app.get('/api/machines', admin, (req, res) => res.json({
    items: machines().map(row => ({ ...publicMachine(row), version: row.version,
      reviewed_by: row.reviewed_by, reviewed_at: row.reviewed_at })),
  }));

  app.put('/api/machines/:code', admin, (req, res) => {
    const input = parse(machineSchema, req.body);
    const result = transaction(db, () => {
      const before = machineRow(req.params.code);
      if (!before) throw new HttpError(404, 'ไม่พบเครื่องนี้');
      if (before.version !== input.version) {
        throw new HttpError(409, 'ข้อมูลเปลี่ยนแล้ว กรุณาโหลดหน้าใหม่ก่อนบันทึก');
      }
      db.prepare(`UPDATE machines SET name_th=?,setup=?,steps=?,cautions=?,intensity_howto=?,
        video_url=?,video_title=?,video_channel=?,reviewed_by=?,reviewed_at=?,
        version=version+1,updated_at=? WHERE code=?`)
        .run(input.name_th, input.setup ?? before.setup,
          input.steps ? JSON.stringify(input.steps) : before.steps,
          input.cautions ? JSON.stringify(input.cautions) : before.cautions,
          input.intensity_howto ?? before.intensity_howto,
          input.video_url ?? before.video_url, input.video_title ?? before.video_title,
          input.video_channel ?? before.video_channel,
          input.reviewed ? req.user.email : (input.reviewed === false ? null : before.reviewed_by),
          input.reviewed ? now() : (input.reviewed === false ? null : before.reviewed_at),
          now(), before.code);
      audit(db, req.user.id, 'content.machine_edited', before.code, null,
        { name: input.name_th, reviewed: !!input.reviewed }, now(), 'machine');
      return publicMachine(machineRow(before.code));
    });
    res.json(result);
  });

  app.put('/api/machines/:code/photo', admin, receiveMachinePhoto, (req, res) => {
    if (!req.file) throw new HttpError(400, 'กรุณาเลือกไฟล์รูป');
    const before = machineRow(req.params.code);
    if (!before) throw new HttpError(404, 'ไม่พบเครื่องนี้');
    // `save`, and the content type it worked out from the bytes themselves --
    // not `write`, which is not a method this store has, and not the type the
    // browser claimed. Written against a store this route never had a screen
    // or a test to exercise, so every upload answered 500 with a reference
    // number and nothing else (found while building the screen).
    let stored;
    try { stored = machineStore.save(req.file.buffer); }
    catch (error) {
      if (error instanceof SlipError) throw new HttpError(400, error.message);
      throw error;
    }
    const previous = before.photo_stored_name;
    db.prepare('UPDATE machines SET photo_stored_name=?,photo_content_type=?,photo_updated_at=?,version=version+1 WHERE code=?')
      .run(stored.storedName, stored.contentType, now(), before.code);
    // Only after the row points at the new one: a crash between the two must
    // leave an extra file, never a row pointing at nothing.
    if (previous) { try { machineStore.remove(previous); } catch { /* already gone */ } }
    res.json(publicMachine(machineRow(before.code)));
  });

  app.get('/api/programs', admin, (req, res) => res.json({
    items: db.prepare('SELECT * FROM programs ORDER BY sort_order, code').all()
      .map(row => ({ ...publicProgram(row), version: row.version, reviewed_by: row.reviewed_by })),
  }));

  app.put('/api/programs/:code', admin, (req, res) => {
    const input = parse(programSchema, req.body);
    const result = transaction(db, () => {
      const before = db.prepare('SELECT * FROM programs WHERE code=?').get(req.params.code);
      if (!before) throw new HttpError(404, 'ไม่พบโปรแกรมนี้');
      if (before.version !== input.version) {
        throw new HttpError(409, 'ข้อมูลเปลี่ยนแล้ว กรุณาโหลดหน้าใหม่ก่อนบันทึก');
      }
      db.prepare(`UPDATE programs SET name_th=?,stations=?,progression=?,trainer_note=?,
        values_are_examples=?,reviewed_by=?,reviewed_at=?,version=version+1,updated_at=? WHERE code=?`)
        .run(input.name_th, JSON.stringify(input.stations), input.progression ?? before.progression,
          input.trainer_note ?? before.trainer_note, input.values_are_examples ? 1 : 0,
          input.reviewed ? req.user.email : (input.reviewed === false ? null : before.reviewed_by),
          input.reviewed ? now() : (input.reviewed === false ? null : before.reviewed_at),
          now(), before.code);
      audit(db, req.user.id, 'content.program_edited', before.code, null,
        { name: input.name_th, values_are_examples: input.values_are_examples }, now(), 'program');
      return publicProgram(db.prepare('SELECT * FROM programs WHERE code=?').get(before.code));
    });
    res.json(result);
  });

  app.get('/api/articles', admin, (req, res) => res.json({
    items: articles().map(row => ({ ...publicArticle(row), version: row.version,
      reviewed_by: row.reviewed_by, reviewed_at: row.reviewed_at })),
  }));

  app.put('/api/articles/:code', admin, (req, res) => {
    const input = parse(articleSchema, req.body);
    const result = transaction(db, () => {
      const before = db.prepare('SELECT * FROM articles WHERE code=?').get(req.params.code);
      if (!before) throw new HttpError(404, 'ไม่พบบทความนี้');
      if (before.version !== input.version) {
        throw new HttpError(409, 'ข้อมูลเปลี่ยนแล้ว กรุณาโหลดหน้าใหม่ก่อนบันทึก');
      }
      db.prepare(`UPDATE articles SET title=?,body=?,reviewed_by=?,reviewed_at=?,
        version=version+1,updated_at=? WHERE code=?`)
        .run(input.title, input.body ? JSON.stringify(input.body) : before.body,
          input.reviewed ? req.user.email : (input.reviewed === false ? null : before.reviewed_by),
          input.reviewed ? now() : (input.reviewed === false ? null : before.reviewed_at),
          now(), before.code);
      audit(db, req.user.id, 'content.article_edited', before.code, null,
        { title: input.title, reviewed: !!input.reviewed }, now(), 'article');
      return publicArticle(db.prepare('SELECT * FROM articles WHERE code=?').get(before.code));
    });
    res.json(result);
  });

  /** The safety wording as the owner edits it, with who signed it off. */
  const safetyView = row => ({
    portal_home_title: row.portal_home_title ?? '',
    portal_home: list(row.portal_home),
    machine_footer: list(row.machine_footer),
    program_before_start: list(row.program_before_start),
    approved_by: row.approved_by ?? null,
    approved_at: row.approved_at ?? null,
    version: row.version ?? 1,
  });

  app.get('/api/safety', admin, (req, res) => res.json(safetyView(safety())));

  app.put('/api/safety', admin, (req, res) => {
    const input = parse(safetySchema, req.body);
    const result = transaction(db, () => {
      const before = safety();
      if ((before.version ?? 1) !== input.version) {
        throw new HttpError(409, 'ข้อมูลเปลี่ยนแล้ว กรุณาโหลดหน้าใหม่ก่อนบันทึก');
      }
      const text = key => (input[key] ? JSON.stringify(input[key]) : before[key]);
      db.prepare(`UPDATE safety_notices SET portal_home_title=?,portal_home=?,machine_footer=?,
        program_before_start=?,approved_by=?,approved_at=?,version=version+1,updated_at=? WHERE id=1`)
        .run(input.portal_home_title ?? before.portal_home_title,
          text('portal_home'), text('machine_footer'), text('program_before_start'),
          input.approved ? req.user.email : (input.approved === false ? null : before.approved_by),
          input.approved ? now() : (input.approved === false ? null : before.approved_at),
          now());
      // Worth a row of its own: this is the gym saying these words are theirs.
      audit(db, req.user.id, 'content.safety_changed', 'safety_notices',
        { approved_by: before.approved_by }, { approved: !!input.approved }, now(), 'safety');
      return safetyView(safety());
    });
    res.json(result);
  });

  /**
   * One sheet of QR codes, one per machine, to print and cut up.
   *
   * Server-rendered for the printer rather than drawn in the app: this is a
   * thing somebody does once, on a desktop, with the print dialogue open --
   * and a page that owns its own page-break rules prints the same on every
   * machine in the gym's office.
   *
   * Under `/api` even though it answers HTML, because that is where the
   * session cookie is scoped -- and this one is the owner's, unlike the
   * machine pages the QR codes on it point at.
   */
  app.get('/api/machines/qr-sheet', admin, async (req, res) => {
    const QR = (await import('qrcode')).default;
    const rows = machines();
    const gym = db.prepare('SELECT * FROM gym_profile WHERE id=1').get() ?? {};
    const name = gym.brand_name_th || gym.name || 'ยิม';
    const theme = resolveTheme(settingsRow(db));
    const cards = await Promise.all(rows.map(async row => {
      const url = `${origin}/m/${row.code}`;
      const png = await QR.toDataURL(url, { margin: 1, width: 420, errorCorrectionLevel: 'M' });
      return `<div class="qr">
        <div class="t">${esc(name)}</div>
        <h2>${esc(row.name_th)}</h2>
        <img src="${png}" alt="QR ของ ${esc(row.name_th)}">
        <div class="c">${esc(row.code)}</div>
        <div class="h">สแกนเพื่อดูวิธีใช้เครื่องนี้</div>
      </div>`;
    }));
    res.type('html').send(`<!doctype html>
<html lang="th"><head><meta charset="utf-8"><title>แผ่น QR ติดเครื่อง · ${esc(name)}</title>
<style>
@page{size:A4;margin:12mm}
body{margin:0;font:14px/1.5 Tahoma,'Leelawadee UI','Sukhumvit Set',sans-serif;color:#0E1418}
.sheet{display:grid;grid-template-columns:1fr 1fr;gap:10mm}
.qr{border:2px dashed #9AA3AB;border-radius:6mm;padding:6mm;text-align:center;break-inside:avoid}
.qr .t{font-size:12px;color:#3D4852}
.qr h2{margin:2mm 0 4mm;font-size:18px;color:${esc(theme.brand_ink)}}
.qr img{width:52mm;height:52mm}
.qr .c{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#3D4852;margin-top:2mm}
.qr .h{font-size:13px;margin-top:2mm}
.note{margin:0 0 6mm;font-size:13px;color:#3D4852}
@media print{.note{display:none}}
</style></head><body>
<p class="note">กด Ctrl+P เพื่อพิมพ์ · ตัดตามเส้นประแล้วติดที่เครื่องแต่ละเครื่อง ·
  สมาชิกและคนทั่วไปสแกนได้เลยโดยไม่ต้องเข้าสู่ระบบ</p>
<div class="sheet">${cards.join('')}</div>
</body></html>`);
  });
}
