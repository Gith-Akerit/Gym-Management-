import { useEffect, useState } from 'react';
import { api, Field, Loading, Notice, StateBox, upload, useResource } from './shared.jsx';

/**
 * "เครื่องและโปรแกรม" — the owner's side of what members read.
 *
 * Until this screen existed the content shipped in a file and could only be
 * changed by a developer running an import. That was fine for the first load
 * and wrong for everything after it: the numbers in a programme are the gym's
 * to decide, the photograph of a machine is the gym's own machine, and a
 * YouTube link belonging to somebody else stops working without warning.
 *
 * Three ideas shape it.
 *
 * "ตรวจแล้ว" is a commitment, not a tick. Pressing it writes who pressed it,
 * stops the next import from overwriting the row, and -- on a programme --
 * takes down the "ตัวเลขเป็นค่าตัวอย่าง" badge a member sees. So the button
 * says what it will do before it is pressed, and the row shows who pressed it
 * afterwards.
 *
 * Everything is one row at a time. A page that saves six machines at once is a
 * page where one validation error loses five machines' worth of typing, and
 * the person doing this is standing at a counter between customers.
 *
 * And the two links out -- print the QR sheet, see it as a member sees it --
 * are on this screen rather than in the menu, because they are the two things
 * somebody wants immediately after editing content and neither is worth a menu
 * entry of its own.
 */

/** The four things this screen edits, in the order the owner meets them. */
const SECTIONS = [
  ['machines', 'เครื่อง'],
  ['programs', 'โปรแกรม'],
  ['articles', 'บทความ'],
  ['safety', 'ข้อความความปลอดภัย'],
];

/** A list of lines edited as a textarea: one line in, one item out. */
const linesToText = lines => (lines ?? []).join('\n');
const textToLines = text => text.split('\n').map(line => line.trim()).filter(Boolean);

/** Who checked this row, said in a sentence rather than a timestamp. */
function ReviewedBy({ by, at, what = 'ตรวจแล้วโดย' }) {
  if (!by) return <span className="cstate todo">ยังไม่มีใครตรวจ</span>;
  const when = at
    ? new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' }).format(new Date(at))
    : null;
  return <span className="cstate done">{what} {by}{when ? ` · ${when}` : ''}</span>;
}

/**
 * The shell every editor sits in: a row that opens.
 *
 * Closed it shows the name and whether anybody has checked it. Open it shows
 * the fields. Six machines with every field on screen at once is a page nobody
 * can find anything on.
 */
function Row({ code, title, state, open, onToggle, children }) {
  return <div className={`crow${open ? ' open' : ''}`}>
    <button type="button" className="chead" aria-expanded={open} onClick={onToggle}>
      <span className="ccode">{code}</span>
      <span className="ctitle">{title}</span>
      {state}
      <span className="cchev" aria-hidden="true">{open ? '▾' : '▸'}</span>
    </button>
    {open && <div className="cbody">{children}</div>}
  </div>;
}

/** Save / cancel / "ตรวจแล้ว", with the sentence that says what the press means. */
function RowActions({ dirty, saving, onSave, onCancel, reviewed, onReview, reviewLabel, reviewNote }) {
  return <>
    {reviewNote && <p className="hint creview">{reviewNote}</p>}
    <div className="btn-row">
      <button className="btn primary" type="button" disabled={!dirty || saving} onClick={onSave}>
        {saving ? 'กำลังบันทึก…' : 'บันทึก'}
      </button>
      <button className="btn ghost" type="button" disabled={!dirty || saving} onClick={onCancel}>ยกเลิก</button>
      {!reviewed && <button className="btn" type="button" disabled={saving} onClick={onReview}>
        {reviewLabel ?? 'ตรวจแล้ว'}
      </button>}
    </div>
  </>;
}

function MachineEditor({ item, onSaved, onError }) {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const reset = () => setForm({
    name_th: item.name_th, setup: item.setup ?? '',
    steps: linesToText(item.steps), cautions: linesToText(item.cautions),
    intensity_howto: item.intensity_howto ?? '',
    video_url: item.video?.url ?? '', video_title: item.video?.title ?? '',
    video_channel: item.video?.channel ?? '',
  });
  useEffect(reset, [item]);
  if (!form) return null;

  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const dirty = form.name_th !== item.name_th || form.setup !== (item.setup ?? '')
    || form.steps !== linesToText(item.steps) || form.cautions !== linesToText(item.cautions)
    || form.intensity_howto !== (item.intensity_howto ?? '')
    || form.video_url !== (item.video?.url ?? '') || form.video_title !== (item.video?.title ?? '')
    || form.video_channel !== (item.video?.channel ?? '');

  async function save(reviewed) {
    setSaving(true);
    try {
      await api(`/machines/${item.code}`, { method: 'PUT', body: {
        name_th: form.name_th.trim(), setup: form.setup, steps: textToLines(form.steps),
        cautions: textToLines(form.cautions), intensity_howto: form.intensity_howto,
        video_url: form.video_url.trim(), video_title: form.video_title.trim(),
        video_channel: form.video_channel.trim(),
        ...(reviewed ? { reviewed: true } : {}),
        version: item.version,
      } });
      onSaved(reviewed ? `ตรวจแล้ว: ${form.name_th}` : `บันทึก ${item.code} แล้ว`);
    } catch (e) { onError(e); } finally { setSaving(false); }
  }

  async function sendPhoto(file) {
    if (!file) return;
    setPhotoBusy(true);
    try {
      const body = new FormData();
      body.append('photo', file);
      await upload(`/machines/${item.code}/photo`, body, 'PUT');
      onSaved(`อัปเดตรูป ${item.code} แล้ว`);
    } catch (e) { onError(e); } finally { setPhotoBusy(false); }
  }

  return <>
    <Field label="ชื่อเครื่อง" name={`name-${item.code}`} value={form.name_th}
      onChange={v => set('name_th', v)}/>
    <Field label="ตั้งเครื่องก่อนเริ่ม" name={`setup-${item.code}`} value={form.setup}
      onChange={v => set('setup', v)} hint="ประโยคเดียวที่คนยืนอยู่หน้าเครื่องอ่านแล้วทำตามได้">
      <textarea rows={2}/>
    </Field>
    <Field label="วิธีใช้ (บรรทัดละหนึ่งขั้นตอน)" name={`steps-${item.code}`} value={form.steps}
      onChange={v => set('steps', v)} hint="ขึ้นบรรทัดใหม่ = ข้อถัดไป · สูงสุด 12 ข้อ">
      <textarea rows={6}/>
    </Field>
    <Field label="ข้อควรระวัง (บรรทัดละหนึ่งข้อ)" name={`cautions-${item.code}`} value={form.cautions}
      onChange={v => set('cautions', v)}>
      <textarea rows={4}/>
    </Field>
    <Field label="ควรหนักแค่ไหน" name={`intensity-${item.code}`} value={form.intensity_howto}
      onChange={v => set('intensity_howto', v)}
      hint="วิธีให้ลูกค้าหาน้ำหนักเอง ไม่ใช่ตัวเลขตายตัว">
      <textarea rows={2}/>
    </Field>

    <h3 className="csub">คลิปวิดีโอ</h3>
    <p className="hint">คลิปเป็นของช่องอื่นบน YouTube เจ้าของช่องลบเมื่อไหร่ก็ได้ ถ้าลูกค้าแจ้งว่าเปิดไม่ได้
      ให้วางลิงก์ใหม่ตรงนี้ · ปล่อยว่างไว้ได้ หน้าเครื่องจะไม่มีส่วนคลิป</p>
    <Field label="ลิงก์ YouTube" name={`video-${item.code}`} value={form.video_url}
      onChange={v => set('video_url', v)} hint="วางลิงก์จากแถบที่อยู่ของ YouTube ได้ทุกแบบ"/>
    <Field label="ชื่อคลิป" name={`vtitle-${item.code}`} value={form.video_title}
      onChange={v => set('video_title', v)}/>
    <Field label="ชื่อช่อง" name={`vchannel-${item.code}`} value={form.video_channel}
      onChange={v => set('video_channel', v)}/>

    <h3 className="csub">รูปเครื่อง</h3>
    <div className="cphoto">
      {item.has_photo
        ? <img src={item.photo_url} alt={`รูปของ ${item.name_th}`}/>
        : <div className="cnophoto">ยังไม่มีรูป</div>}
      <div>
        <p className="hint">ถ่ายให้เห็นทั้งเครื่องและที่นั่ง จากมุมที่คนเดินเข้าหา ไฟสว่าง หนึ่งเครื่องหนึ่งรูป
          · รูปนี้ขึ้นบนหน้าที่ลูกค้าเปิดจาก QR ข้างเครื่อง</p>
        <label className="btn" htmlFor={`photo-${item.code}`}>
          {photoBusy ? 'กำลังอัปโหลด…' : (item.has_photo ? 'เปลี่ยนรูป' : 'เลือกรูปจากเครื่อง')}
        </label>
        <input id={`photo-${item.code}`} type="file" accept="image/jpeg,image/png,image/webp"
          style={{ display: 'none' }} disabled={photoBusy}
          onChange={e => sendPhoto(e.target.files?.[0])}/>
      </div>
    </div>

    <RowActions dirty={dirty} saving={saving} reviewed={item.reviewed}
      onSave={() => save(false)} onCancel={reset} onReview={() => save(true)}
      reviewNote={item.reviewed ? null
        : 'กด "ตรวจแล้ว" เมื่ออ่านครบแล้วว่าตรงกับเครื่องจริง · การนำเข้าเนื้อหารอบต่อไปจะไม่เขียนทับข้อความนี้อีก'}/>
    <p className="cfoot">
      <a href={`/m/${item.code}`} target="_blank" rel="noreferrer">ดูอย่างที่สมาชิกเห็น ↗</a>
    </p>
  </>;
}

/**
 * The six lines a member reads before the first station.
 *
 * Not in the table below with the sets and reps, because they are a different
 * kind of claim: "เหมาะกับใคร" is the gym telling somebody this programme is
 * for them. They were read-only until QA pointed out what that meant -- the
 * owner could lock a row with "ตรวจแล้ว" but could not change a word of this
 * part first, so wording nobody at the gym had agreed to became permanent.
 */
const ABOUT = [
  ['goal', 'เป้าหมาย', 'คำเดียวหรือวลีสั้น ๆ เช่น "เริ่มต้น" "ลดน้ำหนัก"'],
  ['level', 'ระดับ', 'เช่น "มือใหม่"'],
  ['frequency_per_week', 'กี่วันต่อสัปดาห์', 'เช่น "2–3 วัน โดยเว้นอย่างน้อย 1 วันระหว่างรอบ"'],
  ['minutes_per_session', 'ใช้เวลาต่อครั้ง', 'เช่น "30–40 นาที"'],
  ['for_whom', 'เหมาะกับใคร', 'ประโยคเดียวที่สมาชิกอ่านแล้วรู้ว่าใช่ตัวเองหรือไม่', true],
  ['next_program', 'จบแล้วไปต่อที่ไหน', 'บอกให้ชัดว่าให้ปรึกษาพนักงานก่อนหรือไม่', true],
];

function ProgramEditor({ item, onSaved, onError }) {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const reset = () => setForm({
    name_th: item.name_th,
    ...Object.fromEntries(ABOUT.map(([key]) => [key, item[key] ?? ''])),
    stations: (item.stations ?? []).map(station => ({ ...station })),
    progression: item.progression ?? '', trainer_note: item.trainer_note ?? '',
  });
  useEffect(reset, [item]);
  if (!form) return null;

  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const setStation = (index, key, value) => setForm(current => ({
    ...current,
    stations: current.stations.map((station, i) => (i === index ? { ...station, [key]: value } : station)),
  }));
  const dirty = JSON.stringify(form) !== JSON.stringify({
    name_th: item.name_th,
    ...Object.fromEntries(ABOUT.map(([key]) => [key, item[key] ?? ''])),
    stations: item.stations ?? [],
    progression: item.progression ?? '', trainer_note: item.trainer_note ?? '',
  });

  async function save({ reviewed = false } = {}) {
    setSaving(true);
    try {
      await api(`/programs/${item.code}`, { method: 'PUT', body: {
        name_th: form.name_th.trim(),
        ...Object.fromEntries(ABOUT.map(([key]) => [key, form[key]])),
        stations: form.stations.map(station => ({
          order: station.order, machine: station.machine, role: station.role ?? '',
          duration: station.duration || null, sets: station.sets || null,
          reps: station.reps || null, rest: station.rest || null, note: station.note ?? '',
        })),
        progression: form.progression, trainer_note: form.trainer_note,
        // Pressing "ตรวจแล้ว" is what takes the badge off the member's screen.
        values_are_examples: reviewed ? false : item.values_are_examples,
        ...(reviewed ? { reviewed: true } : {}),
        version: item.version,
      } });
      onSaved(reviewed ? `ตรวจแล้ว: ${form.name_th} · สมาชิกจะไม่เห็นป้ายค่าตัวอย่างอีก` : 'บันทึกโปรแกรมแล้ว');
    } catch (e) { onError(e); } finally { setSaving(false); }
  }

  return <>
    {item.values_are_examples && <div className="cwarn" role="status">
      <b>ตัวเลขในโปรแกรมนี้ยังเป็นค่าตัวอย่าง</b>
      <p>สมาชิกเห็นป้ายบอกไว้บนหน้าจอว่ายังไม่มีใครที่ยิมตรวจ · กด "ตรวจแล้ว" เมื่อเซ็ต ครั้ง และเวลาพัก
        เหมาะกับลูกค้าของคุณจริง ป้ายจะหายไปทันที</p>
    </div>}
    <Field label="ชื่อโปรแกรม" name={`pname-${item.code}`} value={form.name_th}
      onChange={v => set('name_th', v)}/>

    <h3 className="csub">โปรแกรมนี้คืออะไร</h3>
    <p className="hint">หกบรรทัดนี้คือสิ่งที่สมาชิกอ่านเหนือรายการท่า
      · ถ้าไม่ตรงกับที่ยิมแนะนำจริง แก้ตรงนี้ก่อนกด "ตรวจแล้ว"</p>
    {ABOUT.map(([key, label, hint, long]) => <Field key={key} label={label}
      name={`${key}-${item.code}`} value={form[key]} hint={hint}
      onChange={v => set(key, v)}>
      {long ? <textarea rows={2}/> : undefined}
    </Field>)}

    <h3 className="csub">สถานีในโปรแกรม</h3>
    <table className="ctable">
      <thead><tr>
        <th>ลำดับ</th><th>เครื่อง</th><th>บทบาท</th><th>เซ็ต</th><th>ครั้ง</th><th>พัก</th><th>เวลา</th>
      </tr></thead>
      <tbody>
        {form.stations.map((station, index) => <tr key={`${station.order}-${station.machine}`}>
          <td>{station.order}</td>
          <td><code>{station.machine}</code></td>
          <td><input aria-label={`บทบาทของสถานีที่ ${station.order}`} value={station.role ?? ''}
            onChange={e => setStation(index, 'role', e.target.value)}/></td>
          <td><input aria-label={`เซ็ตของสถานีที่ ${station.order}`} value={station.sets ?? ''}
            onChange={e => setStation(index, 'sets', e.target.value)}/></td>
          <td><input aria-label={`ครั้งของสถานีที่ ${station.order}`} value={station.reps ?? ''}
            onChange={e => setStation(index, 'reps', e.target.value)}/></td>
          <td><input aria-label={`เวลาพักของสถานีที่ ${station.order}`} value={station.rest ?? ''}
            onChange={e => setStation(index, 'rest', e.target.value)}/></td>
          <td><input aria-label={`ระยะเวลาของสถานีที่ ${station.order}`} value={station.duration ?? ''}
            onChange={e => setStation(index, 'duration', e.target.value)}/></td>
        </tr>)}
      </tbody>
    </table>
    <p className="hint">ช่องว่างได้ · เครื่องคาร์ดิโอมักใส่แค่ "เวลา" ส่วนเครื่องมีน้ำหนักใส่เซ็ตกับครั้ง</p>

    <Field label="เพิ่มน้ำหนักเมื่อไหร่" name={`prog-${item.code}`} value={form.progression}
      onChange={v => set('progression', v)}><textarea rows={3}/></Field>
    <Field label="หมายเหตุจากเทรนเนอร์" name={`note-${item.code}`} value={form.trainer_note}
      onChange={v => set('trainer_note', v)}><textarea rows={3}/></Field>

    <RowActions dirty={dirty} saving={saving} reviewed={item.reviewed}
      onSave={() => save()} onCancel={reset} onReview={() => save({ reviewed: true })}
      reviewNote={item.reviewed ? null
        : 'กด "ตรวจแล้ว" แล้วป้าย "ตัวเลขเป็นค่าตัวอย่าง" จะหายจากหน้าจอของสมาชิก และการนำเข้ารอบต่อไปจะไม่เขียนทับ'}/>
  </>;
}

function ArticleEditor({ item, onSaved, onError }) {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const reset = () => setForm({ title: item.title, body: linesToText(item.body) });
  useEffect(reset, [item]);
  if (!form) return null;

  const dirty = form.title !== item.title || form.body !== linesToText(item.body);
  async function save(reviewed) {
    setSaving(true);
    try {
      await api(`/articles/${item.code}`, { method: 'PUT', body: {
        title: form.title.trim(), body: textToLines(form.body),
        ...(reviewed ? { reviewed: true } : {}), version: item.version,
      } });
      onSaved(reviewed ? `ตรวจแล้ว: ${form.title}` : 'บันทึกบทความแล้ว');
    } catch (e) { onError(e); } finally { setSaving(false); }
  }

  return <>
    <Field label="ชื่อบทความ" name={`atitle-${item.code}`} value={form.title}
      onChange={v => setForm(c => ({ ...c, title: v }))}/>
    <Field label="เนื้อหา (บรรทัดละหนึ่งย่อหน้า)" name={`abody-${item.code}`} value={form.body}
      onChange={v => setForm(c => ({ ...c, body: v }))}><textarea rows={10}/></Field>
    <RowActions dirty={dirty} saving={saving} reviewed={item.reviewed_at}
      onSave={() => save(false)} onCancel={reset} onReview={() => save(true)}
      reviewNote={item.reviewed_at ? null : 'กด "ตรวจแล้ว" เมื่ออ่านครบแล้ว การนำเข้ารอบต่อไปจะไม่เขียนทับ'}/>
  </>;
}

/**
 * The safety wording, and the one press that puts the gym's name on it.
 *
 * Kept apart from the machines and the programmes because it is a different
 * kind of thing: this is advice the gym gives, in the gym's name, and the
 * person who has to stand behind it is the owner rather than whoever typed it.
 */
function SafetyEditor({ onSaved, onError }) {
  const { data, error, busy, reload } = useResource('/safety');
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  // A block body on purpose: an effect must return either nothing or a cleanup
  // function, and `data && setForm(...)` returns null on the first render --
  // which React treats as a broken effect and unmounts the whole tab over.
  const reset = () => {
    if (!data) return;
    setForm({
      portal_home_title: data.portal_home_title,
      portal_home: linesToText(data.portal_home),
      machine_footer: linesToText(data.machine_footer),
      program_before_start: linesToText(data.program_before_start),
    });
  };
  useEffect(reset, [data]);

  if (busy) return <Loading label="กำลังโหลดข้อความความปลอดภัย…" rows={3}/>;
  if (error) return <StateBox error={error} onRetry={() => reload().catch(() => {})}/>;
  if (!form) return null;

  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const dirty = form.portal_home_title !== data.portal_home_title
    || form.portal_home !== linesToText(data.portal_home)
    || form.machine_footer !== linesToText(data.machine_footer)
    || form.program_before_start !== linesToText(data.program_before_start);

  async function save(approved) {
    setSaving(true);
    try {
      await api('/safety', { method: 'PUT', body: {
        portal_home_title: form.portal_home_title,
        portal_home: textToLines(form.portal_home),
        machine_footer: textToLines(form.machine_footer),
        program_before_start: textToLines(form.program_before_start),
        ...(approved ? { approved: true } : {}),
        version: data.version,
      } });
      await reload().catch(() => {});
      onSaved(approved ? 'อนุมัติข้อความความปลอดภัยแล้ว' : 'บันทึกข้อความความปลอดภัยแล้ว');
    } catch (e) { onError(e); } finally { setSaving(false); }
  }

  return <div className="csafety">
    <div className={data.approved_by ? 'cwarn ok' : 'cwarn'} role="status">
      <b>{data.approved_by ? 'อนุมัติแล้ว' : 'ยังไม่ได้อนุมัติ'}</b>
      <p>{data.approved_by
        ? <>ข้อความชุดนี้ผ่านการอนุมัติโดย <ReviewedBy by={data.approved_by} at={data.approved_at} what="" /></>
        : 'ข้อความชุดนี้คือคำแนะนำที่ยิมเป็นผู้ให้ และขึ้นหน้าจอพร้อมชื่อยิม · อ่านให้ครบแล้วกดอนุมัติ'}</p>
    </div>
    <Field label="หัวข้อบนหน้าแรกของช่วยเล่น" name="safety-title" value={form.portal_home_title}
      onChange={v => set('portal_home_title', v)}/>
    <Field label="ข้อความบนหน้าแรกของช่วยเล่น (บรรทัดละหนึ่งข้อ)" name="safety-home"
      value={form.portal_home} onChange={v => set('portal_home', v)}><textarea rows={5}/></Field>
    <Field label="ข้อความท้ายหน้าเครื่อง (ที่เปิดจาก QR)" name="safety-machine"
      value={form.machine_footer} onChange={v => set('machine_footer', v)}><textarea rows={5}/></Field>
    <Field label="ข้อความก่อนเริ่มโปรแกรม" name="safety-program"
      value={form.program_before_start} onChange={v => set('program_before_start', v)}>
      <textarea rows={5}/>
    </Field>
    <RowActions dirty={dirty} saving={saving} reviewed={!!data.approved_by}
      onSave={() => save(false)} onCancel={reset} onReview={() => save(true)}
      reviewLabel="อนุมัติข้อความชุดนี้"
      reviewNote={data.approved_by ? null
        : 'การอนุมัติบันทึกชื่อผู้อนุมัติและวันที่ไว้ เป็นหลักฐานว่ายิมตรวจข้อความชุดนี้แล้ว'}/>
  </div>;
}

export function ContentSettings({ onAuthError, onSaved }) {
  const [section, setSection] = useState('machines');
  const [open, setOpen] = useState(null);
  const [failure, setFailure] = useState(null);
  const machines = useResource('/machines');
  const programs = useResource('/programs', section === 'programs');
  const articles = useResource('/articles', section === 'articles');

  const fail = e => {
    if (e.status === 401) return onAuthError?.();
    setFailure(e);
  };
  const saved = async (message, resource) => {
    setFailure(null);
    await resource?.reload().catch(() => {});
    onSaved?.(message);
  };

  const list = { machines, programs, articles }[section];
  const unreviewed = (machines.data?.items ?? []).filter(item => !item.reviewed).length;

  return <div className="content-settings">
    <div className="cnav" role="tablist" aria-label="ส่วนของเนื้อหา">
      {SECTIONS.map(([key, label]) => <button key={key} type="button" role="tab"
        aria-selected={section === key} className={section === key ? 'on' : ''}
        onClick={() => { setSection(key); setOpen(null); setFailure(null); }}>{label}</button>)}
    </div>

    <div className="btn-row cactions">
      <a className="btn" href="/api/machines/qr-sheet" target="_blank" rel="noreferrer">พิมพ์แผ่น QR</a>
      <a className="btn ghost" href="/m/login" target="_blank" rel="noreferrer">ดูอย่างที่สมาชิกเห็น</a>
    </div>

    <Notice error={failure}/>

    {section === 'safety'
      ? <SafetyEditor onSaved={message => saved(message)} onError={fail}/>
      : <>
        {section === 'machines' && unreviewed > 0 && <p className="hint">
          ยังไม่ได้ตรวจ {unreviewed} เครื่อง จาก {machines.data?.items.length ?? 0} เครื่อง
        </p>}
        {list.busy && <Loading label="กำลังโหลดเนื้อหา…" rows={3}/>}
        {list.error && <StateBox error={list.error} onRetry={() => list.reload().catch(() => {})}/>}
        {list.data?.items.map(item => <Row key={item.code} code={item.code}
          title={item.name_th ?? item.title}
          state={section === 'programs' && item.values_are_examples
            ? <span className="cstate todo">ตัวเลขยังเป็นค่าตัวอย่าง</span>
            : <ReviewedBy by={item.reviewed_by} at={item.reviewed_at}/>}
          open={open === item.code}
          onToggle={() => { setOpen(open === item.code ? null : item.code); setFailure(null); }}>
          {section === 'machines' && <MachineEditor item={item}
            onSaved={message => saved(message, machines)} onError={fail}/>}
          {section === 'programs' && <ProgramEditor item={item}
            onSaved={message => saved(message, programs)} onError={fail}/>}
          {section === 'articles' && <ArticleEditor item={item}
            onSaved={message => saved(message, articles)} onError={fail}/>}
        </Row>)}
        {list.data?.items.length === 0 && <p className="hint">
          ยังไม่มีเนื้อหาในระบบ · ทีมติดตั้งนำเข้าให้ด้วยคำสั่ง <code>content:import</code>
        </p>}
      </>}
  </div>;
}
