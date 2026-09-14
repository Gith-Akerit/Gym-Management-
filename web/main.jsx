import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import {
  api, Empty, Field, formatDate, formatDateTime, formatPhone, formatPrice, labels, Loading,
  Notice, orderStatusLabels, packageStatusLabels, PilotContext, StateBox, upload, useResource, usePilot,
} from './shared.jsx';
import { SalesReport } from './payments.jsx';
import { CheckInLog, CheckInSummary, StaffScanner } from './checkin.jsx';
import { PhotoCapture } from './camera.jsx';

/**
 * The gym's initials, for the square before its name.
 *
 * One placeholder, used in the app bar, on the login screen and on the printed
 * card, so the three never disagree — which they did, with "SF" in the header
 * and "G" on the login card of the same page (QA ข้อ ง). It goes when the owner
 * sends a logo file.
 */
export function initials(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'ยม';
  return words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0];
}

const blank = { name: '', email: '', phone: '', date_of_birth: '', emergency_contact: '', status: 'active' };
const blankPackage = { code: '', name_th: '', type: 'unlimited', duration_days: 30, session_limit: '', price_satang: '', description: '', status: 'draft', sort_order: 0 };

const MemberPhoto = ({ member, className = 'av' }) => (member.has_photo
  ? <span className={className}><img src={`/api/members/${member.id}/photo?v=${member.photo_updated_at ?? 0}`} alt=""/></span>
  : <span className={className} aria-hidden="true">{initials(member.name)}</span>);

/** What a member's membership is, in one line, for the list and the summary. */
function membershipLine(member) {
  if (!member.membership || member.membership.expires_at === null) return 'ยังไม่มีแพ็กเกจ';
  const { sessions_remaining: left, expires } = member.membership;
  return `${left === null ? 'ไม่จำกัดครั้ง' : `เหลือ ${left} ครั้ง`} · ถึง ${expires}`;
}

function ProfileFields({ value, setValue, errors = {}, includeEmail = false }) {
  const field = (name, label, props = {}) => <Field key={name} name={name} label={label} value={value[name]}
    onChange={v => setValue({ ...value, [name]: v })} error={errors[name]} {...props}/>;
  return <>
    {field('name', 'ชื่อ–นามสกุล', { required: true, maxLength: 120, autoComplete: 'name',
      hint: 'ชื่อนี้จะขึ้นบนบัตรและบนจอตอนสแกน' })}
    {field('phone', 'เบอร์มือถือ', { required: true, type: 'tel', inputMode: 'tel', autoComplete: 'tel',
      placeholder: '08X-XXX-XXXX', hint: 'ใช้โทรหาลูกค้าเมื่อแพ็กเกจใกล้หมด' })}
    {/* Optional: a walk-in has nothing to sign in to, and inventing an address
        to get past a required field is inventing data. */}
    {includeEmail && field('email', 'อีเมล (ไม่บังคับ)', { type: 'email', autoComplete: 'email' })}
    <details><summary>ข้อมูลเพิ่มเติม (ไม่บังคับ)</summary>
      {field('date_of_birth', 'วันเกิด (ค.ศ.)', { type: 'date', min: '1900-01-01', max: new Date().toISOString().slice(0, 10) })}
      {field('emergency_contact', 'ผู้ติดต่อฉุกเฉินและเบอร์โทร', { maxLength: 200 })}
    </details>
  </>;
}

// ------------------------------------------------------------------ sign in

/** The dark stage the login and set-password screens share. */
const Stage = ({ brand, title, children }) => <div className="scanstage" style={{ justifyContent: 'center' }}>
  <div style={{ maxWidth: 430, width: '100%', margin: '0 auto', padding: 'var(--sp-6)' }}>
    <div style={{ textAlign: 'center', marginBottom: 'var(--sp-6)' }}>
      <div className="mark" style={{ width: 66, height: 66, margin: '0 auto var(--sp-4)', fontSize: 22, background: '#fff', color: 'var(--accent)' }}>
        {initials(brand)}</div>
      <h1 style={{ color: '#fff' }}>{brand}</h1>
      <p style={{ margin: '4px 0 0', color: 'var(--on-dark-2)', fontSize: 'var(--fs-16)' }}>{title}</p>
    </div>
    {children}
  </div>
</div>;

/**
 * The counter sign-in.
 *
 * Only the people who work here have an account, so there is no "sign up" and
 * nothing to explain about codes and mailboxes.
 */
function Login({ brand, onLogin }) {
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onLogin(await api('/auth/login', { method: 'POST', body: { email, password } })); }
    // The password is deliberately left in the box: somebody who mistyped one
    // character should fix that character, not type twelve again.
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  return <Stage brand={brand} title="สำหรับพนักงานและเจ้าของยิมเท่านั้น">
    <form className="block" onSubmit={submit}>
      <Field label="อีเมล" name="email" type="email" value={email} onChange={setEmail}
        required autoComplete="username" disabled={busy}/>
      <div className={`field${error ? ' invalid' : ''}`}>
        <label htmlFor="password">รหัสผ่าน</label>
        <input id="password" name="password" type="password" value={password} autoComplete="current-password"
          required disabled={busy} aria-invalid={!!error} aria-describedby={error ? 'password-error' : undefined}
          onChange={e => setPassword(e.target.value)}/>
        {error && <p className="err" id="password-error" role="alert">✕ {error.message}</p>}
      </div>
      <button className="btn primary xl" disabled={busy} aria-disabled={busy || undefined}>
        {busy ? <><span className="spin"/>กำลังเข้าสู่ระบบ…</> : 'เข้าสู่ระบบ'}</button>
      <p className="note" style={{ margin: 'var(--sp-4) 0 0', textAlign: 'center', fontSize: 'var(--fs-14)' }}>
        ลืมรหัสผ่าน ให้เจ้าของยิมตั้งรหัสใหม่ให้ที่หน้า “ผู้ใช้และสิทธิ์”</p>
    </form>
  </Stage>;
}

/**
 * Setting a password from a link issued at the terminal.
 *
 * The only way into a gym whose administrator account predates passwords. No
 * session is needed and none is created: the owner types a password and then
 * signs in with it like anybody else.
 */
function SetPassword({ brand, token, onDone }) {
  const { data, error, busy } = useResource(`/auth/set-password/${token}`);
  const [password, setPassword] = useState(''), [again, setAgain] = useState('');
  const [working, setWorking] = useState(false), [failure, setFailure] = useState(null), [done, setDone] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (password !== again) { setFailure(new Error('รหัสผ่านสองช่องไม่ตรงกัน')); return; }
    setWorking(true); setFailure(null);
    try { await api('/auth/set-password', { method: 'POST', body: { token, password } }); setDone(true); }
    catch (e) { setFailure(e); } finally { setWorking(false); }
  }

  if (busy) return <Stage brand={brand} title="กำลังตรวจสอบลิงก์…"><div className="block"><Skeletonish/></div></Stage>;
  if (error) {
    return <Stage brand={brand} title="ลิงก์ตั้งรหัสผ่าน">
      <div className="block">
        <div className="banner bad"><div className="ic" aria-hidden="true">!</div>
          <div><b>ลิงก์นี้ใช้ไม่ได้แล้ว</b><span>{error.message}</span></div></div>
        <p className="note">ลิงก์ใช้ได้ครั้งเดียวและหมดอายุใน 24 ชั่วโมง ให้คนที่ติดตั้งระบบออกลิงก์ใหม่ด้วยคำสั่ง
          {' '}<code>npm run admin:set-password-link</code></p>
        <button className="btn" onClick={onDone}>ไปหน้าเข้าสู่ระบบ</button>
      </div>
    </Stage>;
  }
  if (done) {
    return <Stage brand={brand} title="ตั้งรหัสผ่านเรียบร้อย">
      <div className="block">
        <div className="banner ok"><div className="ic" aria-hidden="true">✓</div>
          <div><b>ตั้งรหัสผ่านให้ {data.email} แล้ว</b><span>เข้าสู่ระบบด้วยรหัสผ่านที่เพิ่งตั้งได้เลย</span></div></div>
        <button className="btn primary xl" onClick={onDone}>ไปหน้าเข้าสู่ระบบ</button>
      </div>
    </Stage>;
  }
  return <Stage brand={brand} title={`ตั้งรหัสผ่านของ ${data.email}`}>
    <form className="block" onSubmit={submit}>
      <div className="field">
        <label htmlFor="newpw">รหัสผ่านใหม่</label>
        <input id="newpw" type="password" value={password} autoComplete="new-password" required minLength={12}
          onChange={e => setPassword(e.target.value)}/>
        <p className="hint">อย่างน้อย 12 ตัวอักษร ใช้ประโยคที่จำได้ดีกว่าคำสั้น ๆ ที่มีสัญลักษณ์</p>
      </div>
      <div className={`field${failure ? ' invalid' : ''}`}>
        <label htmlFor="againpw">พิมพ์รหัสผ่านอีกครั้ง</label>
        <input id="againpw" type="password" value={again} autoComplete="new-password" required
          onChange={e => setAgain(e.target.value)}/>
        {failure && <p className="err" role="alert">✕ {failure.message}</p>}
      </div>
      <button className="btn primary xl" disabled={working}>
        {working ? <><span className="spin"/>กำลังบันทึก…</> : 'บันทึกรหัสผ่าน'}</button>
      <p className="note" style={{ margin: 'var(--sp-4) 0 0', fontSize: 'var(--fs-14)' }}>
        ลิงก์นี้ใช้ได้ครั้งเดียว กดบันทึกแล้วจะใช้ซ้ำไม่ได้</p>
    </form>
  </Stage>;
}

const Skeletonish = () => <>
  <span className="skel skel-line" style={{ width: '60%', height: 22, display: 'block' }}/>
  <span className="skel skel-line" style={{ width: '85%', display: 'block' }}/>
</>;

// ----------------------------------------------------------------- members

function MemberList({ onOpen, onSignUp, onAuthError }) {
  const [q, setQ] = useState(''), [page, setPage] = useState(1), [revision, setRevision] = useState(0);
  const [data, setData] = useState(null), [busy, setBusy] = useState(true), [error, setError] = useState(null);
  useEffect(() => {
    const abort = new AbortController(); setBusy(true); setError(null);
    const timer = setTimeout(async () => {
      try { setData(await api(`/members?q=${encodeURIComponent(q)}&page=${page}`, { signal: abort.signal })); }
      catch (e) { if (e.name !== 'AbortError') { setError(e); onAuthError(e); } }
      finally { if (!abort.signal.aborted) setBusy(false); }
    }, 200);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [q, page, revision]);

  const search = <div className="searchbig">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
      <circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
    <input type="search" value={q} aria-label="ค้นหาสมาชิก" disabled={busy && !data}
      placeholder="ชื่อ เบอร์โทร หรือรหัสสมาชิก" onChange={e => { setQ(e.target.value); setPage(1); }}/>
  </div>;

  return <>
    <h1>สมาชิก</h1>
    {busy ? <p className="sub" role="status">กำลังโหลดรายชื่อ…</p>
      : error ? <p className="sub">โหลดรายชื่อไม่สำเร็จ</p>
        : <p className="sub">{data.total.toLocaleString('th-TH')} คน{q ? ` · ค้นหา “${q}”` : ''}</p>}
    {search}
    {busy ? <Loading label="กำลังโหลดรายชื่อ…"/>
      : error ? <StateBox error={error} onRetry={() => setRevision(n => n + 1)}/>
        : !data.items.length
          ? <Empty title={q ? `ไม่พบสมาชิกชื่อ “${q}”` : 'ยังไม่มีสมาชิก'}
              action={<div className="btn-row" style={{ justifyContent: 'center', maxWidth: 420, margin: '0 auto' }}>
                {q && <button className="btn ghost" onClick={() => setQ('')}>ล้างคำค้นหา</button>}
                <button className="btn primary" onClick={onSignUp}>สมัครสมาชิกใหม่</button>
              </div>}>
              {q ? 'ลองพิมพ์เบอร์โทรหรือรหัสสมาชิกแทน หรือถ้ายังไม่เคยสมัคร ให้สมัครใหม่ที่เคาน์เตอร์ได้เลย'
                : 'สมัครคนแรกที่เคาน์เตอร์ได้เลย ใช้เวลาไม่ถึงหนึ่งนาที'}</Empty>
          : <div className="list">{data.items.map(member => <div className="item" key={member.id}>
              <MemberPhoto member={member}/>
              <div className="who">
                <b>{member.name}</b>
                <span>{membershipLine(member)} · <span className="num">{formatPhone(member.phone)}</span></span>
              </div>
              <span className={`chip ${member.status === 'active' ? 'ok' : member.status === 'expired' ? 'warn' : 'bad'}`}>
                {member.status === 'active' ? '✓ ' : member.status === 'expired' ? '◷ ' : '✕ '}{labels[member.status]}</span>
              <button className="btn ghost" onClick={() => onOpen(member)}
                aria-label={`เปิดสมาชิก ${member.name}`}>ดูบัตร</button>
            </div>)}</div>}
    {!busy && !error && data.total > 20 && <div className="pagination">
      <button disabled={page <= 1} onClick={() => setPage(page - 1)}>ก่อนหน้า</button>
      <span>หน้า {page} / {Math.max(1, Math.ceil(data.total / 20))}</span>
      <button disabled={page * 20 >= data.total} onClick={() => setPage(page + 1)}>ถัดไป</button>
    </div>}
  </>;
}

// ------------------------------------------------------------------ sign-up

const STEPS = ['1 · ถ่ายรูป', '2 · ชื่อและเบอร์', '3 · แพ็กเกจและเงิน'];

/**
 * Three steps, one subject each.
 *
 * A single long form is faster for somebody who already knows it by heart and
 * worse for everybody else: the Designer's rule is that the person at the desk
 * is often new, has a customer in front of them, and must not be able to skip
 * the photograph — which is the only thing standing between a forwarded card
 * and a free membership.
 */
function SignUp({ packages, onDone, onCancel, onAuthError }) {
  const [step, setStep] = useState(0);
  const [photo, setPhoto] = useState(null), [preview, setPreview] = useState(null);
  const [value, setValue] = useState({ ...blank });
  const [packageId, setPackageId] = useState(''), [method, setMethod] = useState('cash');
  const [amount, setAmount] = useState(''), [note, setNote] = useState(''), [slip, setSlip] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  // What has already reached the server, so pressing the button again after a
  // refusal finishes the job instead of repeating it.
  const [memberId, setMemberId] = useState(null);
  const [photoSaved, setPhotoSaved] = useState(false), [saleSaved, setSaleSaved] = useState(false);
  const chosen = packages.find(item => item.id === packageId) ?? null;

  function take(file) {
    setPhotoSaved(false);
    setPhoto(file);
    setPreview(url => { if (url) URL.revokeObjectURL(url); return URL.createObjectURL(file); });
  }

  /**
   * Saves what is not saved yet.
   *
   * Three requests, and the middle one can be refused -- a photograph that
   * will not open is turned away at the door now. Pressing the button again
   * after that must finish the signup, not sign the same person up twice, so
   * each step remembers whether it is already done.
   */
  async function save() {
    setBusy(true); setError(null);
    try {
      let id = memberId;
      if (!id) {
        id = (await api('/members', { method: 'POST', body: {
          name: value.name, phone: value.phone, email: value.email || null,
          date_of_birth: value.date_of_birth || null, emergency_contact: value.emergency_contact || '',
        } })).id;
        setMemberId(id);
      }
      if (photo && !photoSaved) {
        const form = new FormData();
        form.append('photo', photo);
        // Back to the camera on a refusal: the answer to "this file will not
        // open" is another picture, and the member is still standing there.
        try { await upload(`/members/${id}/photo`, form, 'PUT'); setPhotoSaved(true); }
        catch (e) { setStep(0); throw e; }
      }
      if (packageId && !saleSaved) {
        const sale = new FormData();
        sale.append('package_id', packageId);
        sale.append('payment_method', method);
        sale.append('note', note);
        if (slip) sale.append('slip', slip);
        await upload(`/members/${id}/grant`, sale);
        setSaleSaved(true);
      }
      onDone(id, 'ออกบัตรให้สมาชิกใหม่แล้ว');
    // Nothing typed is cleared: the counter has a customer standing there.
    } catch (e) { setError(e); onAuthError(e); } finally { setBusy(false); }
  }

  const steps = <div className="steps">{STEPS.map((label, i) =>
    <div key={label} className={`step${i === step ? ' on' : i < step ? ' done' : ''}`}>
      {label}{i < step ? ' ✓' : ''}</div>)}</div>;

  return <>
    <h1>สมัครสมาชิกใหม่</h1>
    <p className="sub">{step === 2
      ? 'ขั้นสุดท้าย กดบันทึกแล้วระบบจะสร้างรูปบัตรให้ทันที'
      : 'ทำทีละขั้น ขั้นละเรื่องเดียว ลูกค้าไม่ต้องกรอกอะไรเองและไม่ต้องมีอีเมล'}</p>
    {steps}
    <Notice error={error}/>

    {step === 0 && <><div className="block">
      <h2>ถ่ายรูปลูกค้า</h2>
      <p className="note" style={{ margin: '0 0 var(--sp-4)' }}>
        รูปนี้จะอยู่บนบัตร และขึ้นบนจอทุกครั้งที่สแกน ใช้ดูว่าเป็นเจ้าของบัตรตัวจริงหรือไม่</p>
      <PhotoCapture onCapture={take} busy={busy} preview={preview}/>
      <label className="field" style={{ marginTop: 'var(--sp-4)' }}>
        <span style={{ display: 'block', fontWeight: 700, marginBottom: 8 }}>เลือกรูปจากเครื่องแทน</span>
        <input type="file" accept="image/jpeg,image/png,image/webp"
          onChange={e => { const file = e.target.files?.[0]; if (file) take(file); }}/>
      </label>
    </div>
    <div className="btn-row" style={{ marginTop: 'var(--sp-4)' }}>
      <button className="btn ghost" style={{ flex: '0 0 140px' }} onClick={onCancel}>ยกเลิก</button>
      <button className="btn primary xl" style={{ flex: 1 }} onClick={() => setStep(1)}>ถัดไป · ชื่อและเบอร์</button>
    </div></>}

    {step === 1 && <><div className="block">
      {preview && <div style={{ display: 'flex', gap: 'var(--sp-5)', alignItems: 'center', marginBottom: 'var(--sp-5)' }}>
        <img src={preview} alt="รูปที่เพิ่งถ่าย" style={{ width: 96, height: 96, borderRadius: '50%', objectFit: 'cover', border: '4px solid var(--accent)', flex: 'none' }}/>
        <div><b style={{ fontSize: 'var(--fs-18)' }}>รูปถ่ายเรียบร้อย</b>
          <p className="note" style={{ margin: 0 }}>ถ้าหน้าไม่ชัดหรือย้อนแสง ถ่ายใหม่ได้</p>
          <button className="btn ghost auto" style={{ marginTop: 8 }} onClick={() => setStep(0)}>ถ่ายรูปใหม่</button></div>
      </div>}
      <h2>ชื่อและเบอร์ติดต่อ</h2>
      <ProfileFields value={value} setValue={setValue} includeEmail errors={error?.fields}/>
    </div>
    <div className="btn-row" style={{ marginTop: 'var(--sp-4)' }}>
      <button className="btn ghost" style={{ flex: '0 0 140px' }} onClick={() => setStep(0)}>ย้อนกลับ</button>
      <button className="btn primary xl" style={{ flex: 1 }} disabled={!value.name.trim() || !value.phone.trim()}
        onClick={() => setStep(2)}>ถัดไป · แพ็กเกจและเงิน</button>
    </div></>}

    {step === 2 && <><div className="block">
      <h2>เลือกแพ็กเกจ</h2>
      <PackagePicker packages={packages} value={packageId} onChange={id => {
        setPackageId(id);
        const item = packages.find(p => p.id === id);
        setAmount(item ? String(item.price_thb) : '');
      }}/>
      {packageId && <>
        <h2 style={{ marginTop: 'var(--sp-6)' }}>รับเงิน</h2>
        <MethodPicker value={method} onChange={setMethod} onSlip={setSlip} slip={slip}/>
        <Field name="signup-amount" label="จำนวนเงินที่รับจริง (บาท)" value={amount} onChange={setAmount}
          inputMode="decimal"
          error={chosen && method !== 'none' && amount !== '' && Number(amount) < chosen.price_thb
            ? `ยอดที่รับ (${amount} ฿) น้อยกว่าราคาแพ็กเกจ (${chosen.price_thb} ฿) — ถ้ายังไม่เก็บครบ ให้เลือก “ไม่ได้รับเงิน (แถมให้)” แล้วเขียนเหตุผลไว้`
            : undefined}/>
        <Field name="signup-note" label={method === 'none' ? 'เหตุผล (บันทึกไว้ในประวัติ)' : 'บันทึกช่วยจำ (ไม่บังคับ)'}
          value={note} onChange={setNote} maxLength={300}
          hint={method === 'none' ? 'บังคับกรอก เขียนให้คนอื่นอ่านย้อนหลังแล้วเข้าใจ' : undefined}/>
        {chosen && <div className="total"><span>รวมที่ต้องเก็บ</span><b>{chosen.price_thb.toLocaleString('th-TH')} ฿</b></div>}
      </>}
      {!packages.length && <p className="note">ยังไม่มีแพ็กเกจที่กรอกราคาไว้ สมัครไว้ก่อนได้ แล้วค่อยมอบแพ็กเกจที่หน้า “รับเงินและมอบแพ็กเกจ”</p>}
    </div>
    <div className="btn-row" style={{ marginTop: 'var(--sp-4)' }}>
      <button className="btn ghost" style={{ flex: '0 0 140px' }} onClick={() => setStep(1)}>ย้อนกลับ</button>
      <button className="btn primary xl" style={{ flex: 1 }} disabled={busy || (method === 'none' && packageId && !note.trim())}
        onClick={save}>{busy ? <><span className="spin"/>กำลังบันทึก…</> : 'บันทึกและออกบัตร'}</button>
    </div></>}
  </>;
}

const PackagePicker = ({ packages, value, onChange }) => <div className="stack">
  {packages.map(item => <label key={item.id} className={`pick${value === item.id ? ' sel' : ''}`}>
    <input type="radio" name="package" checked={value === item.id} onChange={() => onChange(item.id)}
      aria-label={`${item.name_th} ${item.price_thb} บาท`}/>
    <span className="n"><b>{item.name_th}</b>
      <span className="sm">{item.duration_days} วัน · {item.type === 'unlimited' ? 'ไม่จำกัดครั้ง' : `${item.session_limit} ครั้ง`}</span></span>
    <b className="num">{item.price_thb.toLocaleString('th-TH')} ฿</b>
  </label>)}
</div>;

const MethodPicker = ({ value, onChange, onSlip, slip }) => <>
  <div className="stack">
    {[['cash', 'เงินสด', null],
      ['transfer', 'โอนเข้าบัญชี', 'แนบรูปสลิปไว้เป็นหลักฐาน'],
      ['none', 'ไม่ได้รับเงิน (แถมให้)', 'ไม่นับเข้ายอดขาย แต่บันทึกจำนวนไว้']].map(([key, label, sub]) =>
      <label key={key} className={`pick${value === key ? ' sel' : ''}`}>
        <input type="radio" name="method" checked={value === key} onChange={() => onChange(key)} aria-label={label}/>
        <span className="n"><b>{label}</b>{sub && <span className="sm">{sub}</span>}</span>
      </label>)}
  </div>
  {value === 'transfer' && <label className="field" style={{ marginTop: 'var(--sp-4)' }}>
    <span style={{ display: 'block', fontWeight: 700, marginBottom: 8 }}>แนบรูปสลิป (ไม่บังคับ)</span>
    <input type="file" accept="image/jpeg,image/png,image/webp"
      onChange={e => onSlip(e.target.files?.[0] ?? null)}/>
    {slip && <p className="hint">แนบแล้ว: {slip.name}</p>}
  </label>}
</>;

// -------------------------------------------------------------------- card

/**
 * The card, on the screen of whoever is going to send it.
 *
 * Two ways of getting it to a member, kept apart by behaviour rather than only
 * by name: "ส่งบัตรซ้ำ" hands out a signed link to the very same card, and
 * "ออกบัตรใหม่" is behind a confirmation because it kills the one the member
 * is already carrying (Mika, ข้อ 3).
 */
function MemberCard({ member, canReissue, onBack, onChanged, onAuthError }) {
  const { data, error, busy, reload } = useResource(`/members/${member.id}/card`);
  const [link, setLink] = useState(null), [confirm, setConfirm] = useState(false);
  const [working, setWorking] = useState(false), [failure, setFailure] = useState(null);
  const [reason, setReason] = useState('ลูกค้าแจ้งว่าบัตรหลุดไปถึงคนอื่น');
  const [stamp, setStamp] = useState(member.photo_updated_at ?? 0), [preview, setPreview] = useState(null);
  const [photoFailure, setPhotoFailure] = useState(null);
  // A new query string whenever anything drawn on the card changes, so a
  // reissued card is not the browser's copy of the cancelled one.
  // The readability goes in the key too: when a stored photograph turns out to
  // be unusable, the card on this screen has to be the one with the silhouette
  // -- the card that will actually be sent -- not the browser's memory of it.
  const src = `/api/members/${member.id}/card.png?v=${data?.card_version ?? 0}-${stamp}-${data?.photo_readable}`;
  // `photo_readable === false` means there is a photograph on file that the
  // server could not open -- an upload cut off halfway, usually. The card is
  // drawn with the silhouette instead of failing, so the only place anybody
  // finds out is here, where they can photograph the member again.
  const brokenPhoto = data?.photo_readable === false;

  /** Replaces the photograph from this screen, which is where the news lands. */
  async function savePhoto(file) {
    setWorking(true); setPhotoFailure(null);
    const form = new FormData();
    form.append('photo', file);
    try {
      const saved = await upload(`/members/${member.id}/photo`, form, 'PUT');
      setPreview(url => { if (url) URL.revokeObjectURL(url); return URL.createObjectURL(file); });
      setStamp(saved.photo_updated_at ?? Date.now());
      await reload().catch(() => {});
      onChanged('บันทึกรูปถ่ายใหม่แล้ว บัตรใบเดิมยังใช้ได้ ไม่ต้องออกใหม่');
    } catch (e) { setPhotoFailure(e); onAuthError(e); } finally { setWorking(false); }
  }

  async function resend() {
    setWorking(true); setFailure(null);
    try { setLink(await api(`/members/${member.id}/card/link`, { method: 'POST', body: {} })); }
    catch (e) { setFailure(e); onAuthError(e); } finally { setWorking(false); }
  }

  async function share() {
    setFailure(null);
    try {
      const response = await fetch(src, { credentials: 'include' });
      if (!response.ok) throw new Error('โหลดรูปบัตรไม่สำเร็จ กรุณาลองใหม่');
      const file = new File([await response.blob()], `${member.member_code}.png`, { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: member.name });
      else window.open(src, '_blank', 'noopener');
    } catch (e) { if (e.name !== 'AbortError') setFailure(e); }
  }

  async function reissue() {
    setWorking(true); setFailure(null);
    try {
      await api(`/members/${member.id}/card/reissue`, { method: 'POST', body: { reason } });
      setConfirm(false); setLink(null);
      await reload().catch(() => {});
      onChanged('ออกบัตรใหม่แล้ว บัตรใบเดิมใช้ไม่ได้ทันที');
    } catch (e) { setFailure(e); onAuthError(e); } finally { setWorking(false); }
  }

  if (confirm) {
    return <div style={{ maxWidth: 620 }}>
      <h1>ออกบัตรใหม่ให้ {member.name}</h1>
      <p className="sub">ตรวจให้แน่ใจก่อน การกระทำนี้ย้อนกลับไม่ได้</p>
      <div className="confirm">
        <h2>สิ่งที่จะเกิดขึ้นทันที</h2>
        <ul className="warnlist">
          <li><b>บัตรใบเดิมจะสแกนไม่ผ่านอีกเลย</b> ใครถือรูปเก่าอยู่ก็ใช้ไม่ได้ รวมถึงตัวลูกค้าเอง</li>
          <li>ระบบสร้างรูปบัตรใบใหม่ให้ทันที ใช้รูปถ่ายและแพ็กเกจเดิม</li>
          <li><b>คุณต้องส่งรูปใบใหม่ให้ลูกค้า</b> ไม่งั้นเขาจะเข้ายิมไม่ได้ในครั้งถัดไป</li>
          <li>สิทธิ์คงเหลือและประวัติเช็คอินไม่เปลี่ยน</li>
        </ul>
        <Field name="reissue-reason" label="เหตุผล (บันทึกไว้ในประวัติ)" value={reason} onChange={setReason}
          hint="บังคับกรอก เพื่อให้ตรวจย้อนหลังได้ว่าทำไมถึงออกใบใหม่" maxLength={300}>
          <select>
            <option>ลูกค้าแจ้งว่าบัตรหลุดไปถึงคนอื่น</option>
            <option>ลูกค้าทำรูปหาย ขอใหม่</option>
            <option>พบการใช้บัตรซ้ำผิดปกติ</option>
          </select>
        </Field>
        <Notice error={failure}/>
        <div className="btn-row">
          <button className="btn ghost" onClick={() => setConfirm(false)}>ยกเลิก</button>
          <button className="btn danger" disabled={working || !reason.trim()} onClick={reissue}>
            {working ? 'กำลังออกบัตรใหม่…' : 'ยืนยัน ออกบัตรใหม่'}</button>
        </div>
      </div>
    </div>;
  }

  return <>
    <button className="btn auto ghost" style={{ marginBottom: 'var(--sp-4)' }} onClick={onBack}>← กลับรายชื่อสมาชิก</button>
    <h1>บัตรสมาชิก</h1>
    <p className="sub">{member.name} · <span className="num">{member.member_code}</span></p>
    <StateBox error={error} onRetry={() => reload().catch(() => {})}/>
    {busy ? <Loading label="กำลังสร้างบัตร…" rows={2} avatar={false}/> : !error && <>
      {brokenPhoto
        ? <div className="banner bad" role="alert"><div className="ic" aria-hidden="true">!</div>
            <div><b>รูปถ่ายของสมาชิกรายนี้ใช้ไม่ได้ กรุณาถ่ายใหม่</b>
              <span>ไฟล์รูปเสียหรืออัปโหลดไม่ครบ บัตรจึงขึ้นเป็นภาพเงาแทน ถ่ายใหม่ด้านล่างแล้วบัตรจะมีรูปทันที
                โดยไม่ต้องออกบัตรใหม่</span></div></div>
        : !data.photo_readable && <div className="banner bad"><div className="ic" aria-hidden="true">!</div>
            <div><b>ยังไม่มีรูปถ่ายของสมาชิกรายนี้</b>
              <span>บัตรออกได้ แต่พนักงานจะเทียบหน้าตอนสแกนไม่ได้ ซึ่งเป็นด่านเดียวที่กันการส่งบัตรต่อ</span></div></div>}
      <div className="cardgrid">
        <div>
          <img className="cardshot" src={src} alt={`บัตรสมาชิกของ ${member.name}`}/>
          <p className="note" style={{ marginTop: 'var(--sp-3)' }}>
            ไฟล์ PNG 1080 × 1350 px — สัดส่วนเดียวกับรูปที่ LINE แสดงเต็มความกว้างในแชต
            ลูกค้าเปิดแล้ว QR เต็มจอทันที ไม่ต้องกดซูม</p>

          {/* Open on its own when there is nothing usable to show, folded away
              when there is: a working photograph is rarely worth changing, and
              a broken one has to be fixable without anybody hunting for it. */}
          <details className="block" style={{ marginTop: 'var(--sp-5)' }} open={!data.photo_readable}>
            <summary><b>รูปถ่ายของสมาชิก</b></summary>
            <p className="note" style={{ margin: 'var(--sp-3) 0' }}>
              ถ่ายใหม่ได้ตลอด รูปเปลี่ยนแล้วบัตรใบเดิมยังใช้ได้ QR ไม่เปลี่ยน เพราะ QR ผูกกับตัวคน ไม่ได้ผูกกับรูป</p>
            <PhotoCapture onCapture={savePhoto} busy={working}
              preview={preview ?? (data.photo_readable ? `/api/members/${member.id}/photo?v=${stamp}` : null)}/>
            <label className="field" style={{ marginTop: 'var(--sp-4)' }}>
              <span style={{ display: 'block', fontWeight: 700, marginBottom: 8 }}>เลือกรูปจากเครื่องแทน</span>
              <input type="file" accept="image/jpeg,image/png,image/webp" disabled={working}
                onChange={e => { const file = e.target.files?.[0]; if (file) savePhoto(file); }}/>
            </label>
            <Notice error={photoFailure}/>
          </details>
        </div>
        <div className="stack">
          <a className="btn primary xl" href={src} download={`${member.member_code}.png`}>บันทึกรูปบัตร</a>
          <button className="btn xl" onClick={share}>ส่งบัตรให้ลูกค้า</button>
          <button className="btn ghost" disabled={working} onClick={resend}>ส่งบัตรซ้ำ (ลิงก์ 7 วัน)</button>
          {link && <div className="soft">
            <b>ลิงก์ดาวน์โหลดบัตรใบเดิม</b>
            <p className="note" style={{ margin: '6px 0' }}>
              ใช้ได้ถึง {formatDateTime(link.expires_at)} · เป็นบัตรใบเดิม ไม่ใช่ใบใหม่</p>
            <input readOnly className="num" aria-label="ลิงก์บัตร" value={`${window.location.origin}${link.url}`}
              onFocus={e => e.target.select()}/>
          </div>}
          <Notice error={failure}/>
          <div className="soft">
            <h2 style={{ marginBottom: 'var(--sp-3)' }}>บัตรใบนี้</h2>
            <div className="row"><span className="muted">ออกเมื่อ</span>
              <b className="num">{data.card_issued_at ? formatDate(data.card_issued_at) : '—'}</b></div>
            <div className="row"><span className="muted">ครั้งที่</span><b className="num">{data.card_version}</b></div>
            <div className="row"><span className="muted">สถานะ</span><span className="chip ok">✓ ใช้งานได้</span></div>
            {canReissue && <details style={{ marginTop: 'var(--sp-4)' }}>
              <summary>เมนูเพิ่มเติม</summary>
              <button className="btn ghost" style={{ marginTop: 'var(--sp-3)' }} onClick={() => setConfirm(true)}>
                ออกบัตรใหม่</button>
              <p className="note" style={{ margin: 'var(--sp-3) 0 0', fontSize: 'var(--fs-14)' }}>
                ใช้เมื่อบัตรหลุดไปถึงคนอื่น เมื่อออกใบใหม่ <b>บัตรเก่าจะสแกนไม่ผ่านทันที</b></p>
            </details>}
          </div>
        </div>
      </div>
      <PaymentHistory memberId={member.id} name={member.name}/>
    </>}
  </>;
}

const METHOD_LABELS = {
  cash: 'เงินสด', transfer: 'โอนเข้าบัญชี', none: 'ไม่ได้รับเงิน (แถมให้)', promptpay: 'พร้อมเพย์ (ระบบเดิม)',
};

/**
 * What this member has paid, and the slip that came with it.
 *
 * This is where the old "ตรวจสลิป" queue went. That queue was a list of slips
 * members had uploaded themselves, and there is no member app left to upload
 * one -- but the slip a member of staff attaches while taking a transfer is
 * still evidence somebody will want months later. The question they ask is
 * always about one person, so it lives on that person's screen.
 */
function PaymentHistory({ memberId, name }) {
  const { data, error, busy } = useResource(`/members/${memberId}/payments`);
  const [open, setOpen] = useState(null);
  if (busy || error || !data?.items.length) return null;

  return <div className="block" style={{ marginTop: 'var(--sp-6)' }}>
    <h2>ประวัติการรับเงิน</h2>
    <p className="note" style={{ margin: '0 0 var(--sp-4)' }}>
      ทุกครั้งที่ {name} จ่ายเงินหรือได้รับแพ็กเกจ พร้อมชื่อคนที่บันทึกไว้ · เก็บไว้เทียบกับเงินเข้าบัญชีจริง</p>
    <div className="list">{data.items.map(order => <div className="item" key={order.id}>
      <div className="who">
        <b>{order.package_name_snapshot}</b>
        <span>{formatDateTime(order.created_at)} · {METHOD_LABELS[order.payment_method] ?? order.payment_method}
          {order.recorded_by ? ` · โดย ${order.recorded_by}` : ''}
          {order.review_note ? ` · ${order.review_note}` : ''}</span>
      </div>
      <b className="num" style={{ fontSize: 'var(--fs-20)' }}>
        {order.manual_grant ? '0 ฿' : `${order.price_thb.toLocaleString('th-TH')} ฿`}</b>
      <span className={`chip ${order.status === 'paid' ? 'ok' : order.status === 'rejected' ? 'bad' : 'neutral'}`}>
        {orderStatusLabels[order.status]}</span>
      {order.slip
        ? <button className="btn ghost" onClick={() => setOpen(open === order.id ? null : order.slip.id)}
            aria-label={`ดูสลิปของ ${order.package_name_snapshot}`}>
            {open === order.slip.id ? 'ซ่อนสลิป' : 'ดูสลิป'}</button>
        : <span className="note">ไม่มีสลิป</span>}
      {open === order.slip?.id && <div style={{ flexBasis: '100%' }}>
        {/* Opened in place rather than in a tab: whoever is checking it has the
            amount and the date on the same screen, which is the comparison. */}
        <a href={`/api/slips/${order.slip.id}/image`} target="_blank" rel="noreferrer">
          <img src={`/api/slips/${order.slip.id}/image`} alt={`สลิปของ ${order.package_name_snapshot}`}
            style={{ maxWidth: 360, width: '100%', borderRadius: 'var(--r-1)', border: '2px solid var(--line)' }}/></a>
        <p className="note" style={{ margin: '6px 0 0' }}>
          {order.slip.reference_no ? `เลขอ้างอิง ${order.slip.reference_no} · ` : ''}กดที่รูปเพื่อเปิดขนาดเต็ม</p>
      </div>}
    </div>)}</div>
  </div>;
}

// --------------------------------------------------- money at the counter

/**
 * Taking the money and handing the package over, in one screen.
 *
 * The summary panel is the point: an expiry that moves by a month is the
 * mistake that hurts most and the one nobody notices until the member is
 * turned away, so the old date and the new one sit side by side before the
 * button is pressed (Designer).
 */
function PaymentGrant({ member, packages, onDone, onPickMember, onAuthError }) {
  const [packageId, setPackageId] = useState(''), [method, setMethod] = useState('cash');
  const [note, setNote] = useState(''), [slip, setSlip] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const chosen = packages.find(item => item.id === packageId) ?? null;
  const current = member?.membership?.expires_at ?? null;
  // Renewing runs from today, not from the old expiry: the server grants from
  // the moment it is asked, so the panel must say the same thing it will do.
  const next = chosen ? Date.now() + chosen.duration_days * 86400000 : null;

  async function save() {
    setBusy(true); setError(null);
    const form = new FormData();
    form.append('package_id', packageId);
    form.append('payment_method', method);
    form.append('note', note);
    if (slip) form.append('slip', slip);
    try {
      await upload(`/members/${member.id}/grant`, form);
      onDone(method === 'none' ? 'มอบแพ็กเกจแล้ว' : 'บันทึกการชำระเงินและมอบแพ็กเกจแล้ว');
    } catch (e) { setError(e); onAuthError(e); } finally { setBusy(false); }
  }

  return <>
    <h1>รับเงินและมอบแพ็กเกจ</h1>
    <p className="sub">บันทึกว่ารับเงินแล้ว แล้วมอบแพ็กเกจในขั้นตอนเดียว · ทุกครั้งถูกบันทึกว่าใครทำและเมื่อไร</p>
    <Notice error={error}/>
    <div className="cardgrid">
      <div className="block">
        <h2>1. เลือกสมาชิก</h2>
        {member
          ? <div className="item" style={{ borderColor: 'var(--accent)', borderWidth: 3 }}>
              <MemberPhoto member={member}/>
              <div className="who"><b>{member.name}</b><span>{membershipLine(member)}</span></div>
              <button className="btn ghost" onClick={onPickMember}>เปลี่ยน</button>
            </div>
          : <button className="btn primary" onClick={onPickMember}>เลือกสมาชิกจากรายชื่อ</button>}

        <h2 style={{ marginTop: 'var(--sp-6)' }}>2. แพ็กเกจที่จะมอบ</h2>
        {packages.length
          ? <PackagePicker packages={packages} value={packageId} onChange={setPackageId}/>
          : <p className="note">ยังไม่มีแพ็กเกจที่กรอกราคาไว้ กรุณาตั้งราคาในหน้าแพ็กเกจก่อน</p>}
        <p className="note" style={{ marginTop: 'var(--sp-3)' }}>
          แสดงเฉพาะแพ็กเกจที่กรอกราคาไว้แล้ว (รวมราคา 0 บาท) ถ้าไม่เห็นแพ็กเกจที่ต้องการ ให้ตั้งราคาในหน้าแพ็กเกจก่อน</p>

        <h2 style={{ marginTop: 'var(--sp-6)' }}>3. รับเงินอย่างไร</h2>
        <MethodPicker value={method} onChange={setMethod} onSlip={setSlip} slip={slip}/>
        <Field name="grant-note" label={method === 'none' ? 'เหตุผล (บันทึกไว้ในประวัติ)' : 'บันทึกช่วยจำ (ไม่บังคับ)'}
          value={note} onChange={setNote} maxLength={300}
          error={error?.fields?.note}
          hint="เขียนให้คนอื่นอ่านย้อนหลังแล้วเข้าใจ เช่น “ต่ออายุรายเดือน รับเงินสดที่เคาน์เตอร์”"/>
      </div>

      <div className="stack">
        <div className="soft">
          <h2 style={{ marginBottom: 'var(--sp-3)' }}>สรุปก่อนบันทึก</h2>
          <div className="row"><span className="muted">สมาชิก</span><b>{member?.name ?? '—'}</b></div>
          <div className="row"><span className="muted">แพ็กเกจ</span><b>{chosen?.name_th ?? '—'}</b></div>
          <div className="row"><span className="muted">หมดอายุเดิม</span>
            <b className="num">{current ? formatDate(current) : 'ยังไม่มีแพ็กเกจ'}</b></div>
          <div className="row"><span className="muted">หมดอายุใหม่</span>
            <b className="num">{next ? formatDate(next) : '—'}</b></div>
          <div className="total"><span>รับเงิน</span>
            <b>{method === 'none' ? '0 ฿' : `${(chosen?.price_thb ?? 0).toLocaleString('th-TH')} ฿`}</b></div>
        </div>
        <button className="btn primary xl" disabled={!member || !packageId || busy || (method === 'none' && !note.trim())}
          onClick={save}>{busy ? <><span className="spin"/>กำลังบันทึก…</> : 'บันทึกและมอบแพ็กเกจ'}</button>
        <p className="note" style={{ fontSize: 'var(--fs-14)' }}>
          หลังบันทึก สิทธิ์ของลูกค้าจะอัปเดตทันที <b>ไม่ต้องออกบัตรใหม่</b> บัตรใบเดิมยังใช้ได้
          เพราะ QR ผูกกับตัวคน ไม่ได้ผูกกับแพ็กเกจ</p>
      </div>
    </div>
  </>;
}

// ---------------------------------------------------------------- packages

function PackageEditor({ item, onCancel, onSaved, onAuthError }) {
  const toForm = row => ({ ...blankPackage, ...row, session_limit: row.session_limit ?? '', price_satang: row.price_thb ?? '' });
  const [form, setForm] = useState(item ? toForm(item) : { ...blankPackage });
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const errors = error?.fields ?? {};
  const set = (key, value) => setForm({ ...form, [key]: value });

  async function save(e) {
    e.preventDefault(); setBusy(true); setError(null);
    const body = {
      code: form.code, name_th: form.name_th, type: form.type,
      duration_days: Number(form.duration_days),
      session_limit: form.type === 'limited_sessions' ? Number(form.session_limit) : null,
      price_thb: form.price_satang === '' ? null : Number(form.price_satang),
      description: form.description, status: form.status, sort_order: Number(form.sort_order),
      ...(item && { version: item.version }),
    };
    try {
      await api(item ? `/packages/${item.id}` : '/packages', { method: item ? 'PUT' : 'POST', body });
      onSaved(item ? 'บันทึกแพ็กเกจแล้ว' : 'เพิ่มแพ็กเกจแล้ว');
    } catch (e) { setError(e); onAuthError(e); } finally { setBusy(false); }
  }

  return <div style={{ maxWidth: 620 }}>
    <button className="btn auto ghost" style={{ marginBottom: 'var(--sp-4)' }} onClick={onCancel}>← กลับรายการแพ็กเกจ</button>
    <h1>{item ? 'แก้ไขแพ็กเกจ' : 'เพิ่มแพ็กเกจ'}</h1>
    <form className="block" onSubmit={save}>
      <Field name="code" label="รหัสแพ็กเกจ" value={form.code} onChange={v => set('code', v)} error={errors.code} required/>
      <Field name="name_th" label="ชื่อแพ็กเกจ" value={form.name_th} onChange={v => set('name_th', v)} error={errors.name_th} required/>
      <Field name="type" label="ประเภท" value={form.type} onChange={v => set('type', v)} error={errors.type}>
        <select><option value="unlimited">ไม่จำกัดครั้ง</option><option value="limited_sessions">จำกัดจำนวนครั้ง</option></select>
      </Field>
      <div className="two">
        <Field name="duration_days" label="อายุแพ็กเกจ (วัน)" value={form.duration_days} onChange={v => set('duration_days', v)} error={errors.duration_days} type="number" min={1}/>
        {form.type === 'limited_sessions' && <Field name="session_limit" label="จำนวนครั้ง" value={form.session_limit} onChange={v => set('session_limit', v)} error={errors.session_limit} type="number" min={1}/>}
      </div>
      <Field name="price_satang" label="ราคา (บาท)" value={form.price_satang} onChange={v => set('price_satang', v)}
        error={errors.price_thb ?? errors.price_satang} inputMode="decimal"
        hint="แพ็กเกจที่ยังไม่กรอกราคาจะมอบให้ใครไม่ได้ · ราคา 0 บาทคือแพ็กเกจฟรีจริง"/>
      <Field name="status" label="สถานะแพ็กเกจ" value={form.status} onChange={v => set('status', v)} error={errors.status}>
        <select>{Object.entries(packageStatusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
      </Field>
      <Notice error={error}/>
      <div className="btn-row">
        <button className="btn ghost" type="button" onClick={onCancel}>ยกเลิก</button>
        <button className="btn primary" disabled={busy}>{busy ? 'กำลังบันทึก…' : 'บันทึกแพ็กเกจ'}</button>
      </div>
    </form>
  </div>;
}

function Packages({ onAuthError }) {
  const [revision, setRevision] = useState(0), [editor, setEditor] = useState(null), [notice, setNotice] = useState('');
  const { data, error, busy, reload } = useResource(`/packages?r=${revision}`);
  if (editor) {
    return <PackageEditor key={editor.id || 'new'} item={editor.id ? editor : null} onAuthError={onAuthError}
      onCancel={() => setEditor(null)}
      onSaved={message => { setEditor(null); setNotice(message); setRevision(n => n + 1); }}/>;
  }
  return <>
    <h1>แพ็กเกจ</h1>
    <p className="sub">แพ็กเกจที่ยังไม่กรอกราคาจะไม่ขึ้นในหน้ารับเงิน · ราคา 0 บาทคือแพ็กเกจฟรีจริง มอบได้และไม่กระทบยอดขาย</p>
    {notice && <div className="banner ok" role="status"><div className="ic" aria-hidden="true">✓</div><div><b>{notice}</b></div></div>}
    <button className="btn primary auto" style={{ marginBottom: 'var(--sp-5)' }}
      onClick={() => { setEditor({}); setNotice(''); }}>＋ เพิ่มแพ็กเกจ</button>
    <StateBox error={error} onRetry={() => reload().catch(() => {})}/>
    {busy ? <Loading label="กำลังโหลดแพ็กเกจ…" avatar={false}/> : !error && <div className="list">
      {data.items.map(item => <div className="item" key={item.id}>
        <div className="who"><b>{item.name_th}</b>
          <span>{item.duration_days} วัน · {item.type === 'unlimited' ? 'ไม่จำกัดครั้ง' : `${item.session_limit} ครั้ง`}</span></div>
        <b className="num" style={{ fontSize: 'var(--fs-24)', color: item.price_thb === null ? 'var(--warn)' : undefined }}>
          {item.price_thb === null ? 'ยังไม่ตั้งราคา' : `${item.price_thb.toLocaleString('th-TH')} ฿`}</b>
        <span className={`chip ${item.price_thb === null ? 'warn' : item.status === 'active' ? 'ok' : 'neutral'}`}>
          {item.price_thb === null ? '◷ มอบไม่ได้' : item.status === 'active' ? '✓ เปิดขาย' : packageStatusLabels[item.status]}</span>
        <button className={item.price_thb === null ? 'btn primary' : 'btn ghost'}
          onClick={() => { setEditor(item); setNotice(''); }}
          aria-label={`แก้ไข ${item.name_th}`}>{item.price_thb === null ? 'ตั้งราคา' : 'แก้ไข'}</button>
      </div>)}
    </div>}
  </>;
}

// -------------------------------------------------------- users and roles

const roleLabels = { admin: 'ผู้ดูแลระบบ', staff: 'พนักงาน', member: 'สมาชิก' };

function Users({ onAuthError, signedInAs, onSignedOut }) {
  const [q, setQ] = useState(''), [page, setPage] = useState(1);
  const { data, error, busy, reload } = useResource(`/users?q=${encodeURIComponent(q)}&page=${page}`);
  const [email, setEmail] = useState(''), [role, setRole] = useState('staff'), [secret, setSecret] = useState('');
  const [working, setWorking] = useState(false), [actionError, setActionError] = useState(null), [notice, setNotice] = useState('');
  const [setting, setSetting] = useState(null), [newPassword, setNewPassword] = useState('');

  async function act(path, options, message, farewell) {
    setWorking(true); setActionError(null); setNotice('');
    try {
      await api(path, options);
      if (farewell) return onSignedOut(farewell);
      setNotice(message);
      await reload();
    } catch (e) { setActionError(e); onAuthError(e); } finally { setWorking(false); }
  }
  const endsMyOwnSession = user => user.email === signedInAs;
  const invite = () => act('/users', { method: 'POST', body: { email, role, ...(secret ? { password: secret } : {}) } }, 'สร้างบัญชีแล้ว')
    .then(() => { setEmail(''); setSecret(''); });

  /** A password the owner can read aloud: letters, digits, no lookalikes. */
  const suggest = () => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const digits = '23456789';
    const pick = set => set[Math.floor(Math.random() * set.length)];
    return `Gym-${Array.from({ length: 4 }, () => pick(alphabet)).join('')}-${Array.from({ length: 4 }, () => pick(digits)).join('')}`;
  };

  if (setting) {
    return <div style={{ maxWidth: 620 }}>
      <h1>ตั้งรหัสผ่านใหม่ให้ {setting.email}</h1>
      <p className="sub">ใช้เมื่อพนักงานลืมรหัสผ่าน ไม่มีการส่งอีเมล คุณบอกรหัสให้เขาโดยตรง</p>
      <div className="block">
        <Field name="new-password" label="รหัสผ่านใหม่" value={newPassword} onChange={setNewPassword} className="num"
          error={actionError?.fields?.password}
          hint="แสดงเป็นตัวอักษรปกติเพื่อให้คุณอ่านให้เขาฟังได้ถูก · ไม่มีการเก็บรหัสนี้ไว้ที่ไหนหลังกดบันทึก"/>
        <div className="btn-row" style={{ marginBottom: 'var(--sp-5)' }}>
          <button className="btn ghost" onClick={() => setNewPassword(suggest())}>สุ่มรหัสผ่านให้</button>
        </div>
        <div className="banner bad"><div className="ic" aria-hidden="true">!</div>
          <div><b>กดบันทึกแล้วเขาจะถูกออกจากระบบทันที</b>
            <span>ถ้าเขากำลังสแกนอยู่หน้าเคาน์เตอร์ ให้บอกเขาก่อน</span></div></div>
        <Notice error={actionError}/>
        <div className="btn-row" style={{ marginTop: 'var(--sp-5)' }}>
          <button className="btn ghost" onClick={() => { setSetting(null); setActionError(null); }}>ยกเลิก</button>
          <button className="btn primary" disabled={working || newPassword.trim().length < 12}
            onClick={() => act(`/users/${setting.id}/password`, { method: 'PUT', body: { password: newPassword } },
              `ตั้งรหัสผ่านใหม่ให้ ${setting.email} แล้ว`).then(() => { setSetting(null); setNewPassword(''); })}>
            {working ? 'กำลังบันทึก…' : 'บันทึกรหัสผ่านใหม่'}</button>
        </div>
      </div>
    </div>;
  }

  return <>
    <h1>ผู้ใช้และสิทธิ์</h1>
    <p className="sub">ใครเข้าระบบได้และเข้าในฐานะอะไร · คนละเรื่องกับหน้า “สมาชิก” ซึ่งเป็นรายชื่อคนที่มาออกกำลังกาย</p>
    {notice && <div className="banner ok" role="status"><div className="ic" aria-hidden="true">✓</div><div><b>{notice}</b></div></div>}

    <div className="block" style={{ marginBottom: 'var(--sp-5)' }}>
      <h2>เพิ่มบัญชีพนักงานหรือผู้ดูแลระบบ</h2>
      <div className="two">
        <Field name="new-user-email" label="อีเมล" type="email" value={email} onChange={setEmail}
          placeholder="staff2@example.com" error={actionError?.fields?.email}/>
        <Field name="new-user-role" label="สิทธิ์ของบัญชีใหม่" value={role} onChange={setRole}>
          <select>
            <option value="staff">พนักงาน — สแกนเช็คอินและสมัครสมาชิก</option>
            <option value="admin">ผู้ดูแลระบบ — จัดการทุกอย่าง</option>
          </select>
        </Field>
      </div>
      <div className="two">
        <Field name="new-user-password" label="ตั้งรหัสผ่านให้เขา (ไม่บังคับ)" value={secret} onChange={setSecret}
          error={actionError?.fields?.password}
          hint="อย่างน้อย 12 ตัวอักษร · บอกเขาแบบตัวต่อตัว ไม่ส่งลงกลุ่ม · เว้นว่างไว้แล้วตั้งทีหลังได้"/>
        <div className="field" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={() => setSecret(suggest())}>สุ่มรหัสผ่านให้</button>
        </div>
      </div>
      <Notice error={actionError}/>
      <button className="btn primary auto" disabled={!email.trim() || working} onClick={invite}>
        {working ? 'กำลังบันทึก…' : 'สร้างบัญชี'}</button>
    </div>

    <h2>บัญชีที่มีอยู่ {data && <span className="chip neutral" style={{ marginLeft: 8 }}>
      ผู้ดูแลระบบที่ใช้งานได้ {data.admins} คน</span>}</h2>
    <div className="searchbig" style={{ marginTop: 'var(--sp-4)' }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
        <circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input type="search" value={q} aria-label="ค้นหาบัญชี" placeholder="อีเมล หรือชื่อสมาชิก"
        onChange={e => { setQ(e.target.value); setPage(1); }}/>
    </div>
    <StateBox error={error} onRetry={() => reload().catch(() => {})}/>
    {busy ? <Loading label="กำลังโหลด…" avatar={false}/> : !error && (
      !data.items.length ? <Empty title="ไม่พบบัญชีที่ค้นหา">ลองพิมพ์อีเมลเต็ม หรือล้างคำค้นหาเพื่อดูทั้งหมด</Empty>
        : <div className="table-wrap"><table className="utable" style={{ border: '2px solid var(--line-strong)', borderRadius: 'var(--r-2)', overflow: 'hidden' }}>
          <thead><tr><th>อีเมล</th><th>สิทธิ์</th><th>รหัสผ่าน</th><th>สถานะ</th><th/></tr></thead>
          <tbody>{data.items.map(user => <tr key={user.id}>
            <td data-label="อีเมล"><b>{user.email}</b>{user.member_name && <span className="note"> · {user.member_name}</span>}</td>
            <td data-label="สิทธิ์">
              <select aria-label={`สิทธิ์ของ ${user.email}`} value={user.role} disabled={working}
                onChange={e => act(`/users/${user.id}/role`, { method: 'PUT', body: { role: e.target.value } },
                  `เปลี่ยนสิทธิ์ของ ${user.email} แล้ว`,
                  endsMyOwnSession(user) && e.target.value !== user.role
                    ? 'เปลี่ยนสิทธิ์ของบัญชีคุณแล้ว ออกจากระบบ' : undefined)}>
                {Object.entries(roleLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select></td>
            <td data-label="รหัสผ่าน">{user.role === 'member'
              ? <span className="muted">ไม่ต้องใช้</span>
              : <span className={`chip ${user.has_password ? 'ok' : 'bad'}`}>
                {user.has_password ? '✓ ตั้งแล้ว' : '✕ ยังไม่ได้ตั้ง'}</span>}</td>
            <td data-label="สถานะ"><span className={`chip ${user.status === 'suspended' ? 'bad' : 'ok'}`}>
              {user.status === 'suspended' ? '✕ ถูกระงับ' : '✓ ใช้งานได้'}</span></td>
            <td data-label="">
              {user.role !== 'member' && <button className="btn ghost" disabled={working}
                aria-label={`ตั้งรหัสผ่านของ ${user.email}`}
                onClick={() => { setSetting(user); setNewPassword(suggest()); setActionError(null); }}>ตั้งรหัสใหม่</button>}
              <button className={user.status === 'suspended' ? 'btn ghost' : 'btn danger'} disabled={working}
                aria-label={`${user.status === 'suspended' ? 'คืนสิทธิ์' : 'ระงับ'}บัญชี ${user.email}`}
                onClick={() => act(`/users/${user.id}/${user.status === 'suspended' ? 'restore' : 'suspend'}`,
                  { method: 'POST', body: {} },
                  `${user.status === 'suspended' ? 'คืนสิทธิ์' : 'ระงับ'}บัญชี ${user.email} แล้ว`,
                  endsMyOwnSession(user) && user.status !== 'suspended'
                    ? 'ระงับบัญชีของคุณแล้ว ออกจากระบบ' : undefined)}>
                {user.status === 'suspended' ? 'คืนสิทธิ์' : 'ระงับบัญชี'}</button>
            </td>
          </tr>)}</tbody>
        </table></div>)}
    <p className="note" style={{ marginTop: 'var(--sp-4)' }}>
      การเปลี่ยนสิทธิ์หรือระงับบัญชีจะเตะคนนั้นออกจากระบบทันที <b>บอกเขาก่อนกด</b> ถ้าเขากำลังยืนสแกนอยู่หน้าเคาน์เตอร์ ·
      ระบบไม่ยอมให้เหลือผู้ดูแลระบบ 0 คน · การตั้งรหัสผ่านใหม่ก็เตะออกจากระบบเช่นกัน</p>
  </>;
}

// ----------------------------------------------------------- gym settings

function GymSettings({ onAuthError }) {
  const { data, error, busy, setData } = useResource('/gym');
  const [form, setForm] = useState(null), [hours, setHours] = useState(null);
  const [saving, setSaving] = useState(false), [saveError, setSaveError] = useState(null), [notice, setNotice] = useState('');
  useEffect(() => { if (data?.profile) { setForm({ ...data.profile }); setHours(data.hours.map(h => ({ ...h }))); } }, [data]);

  if (busy || !form) return <Loading label="กำลังโหลดข้อมูลยิม…" avatar={false}/>;
  if (error) return <StateBox error={error}/>;
  const errors = saveError?.fields ?? {};
  const set = (key, value) => setForm({ ...form, [key]: value });
  const setDay = (weekday, patch) => setHours(hours.map(d => (d.weekday === weekday ? { ...d, ...patch } : d)));

  async function saveProfile(e) {
    e.preventDefault(); setSaving(true); setSaveError(null); setNotice('');
    const { created_at, updated_at, timezone, currency, id, ...rest } = form;
    try { setData(await api('/gym', { method: 'PUT', body: rest })); setNotice('บันทึกข้อมูลยิมแล้ว'); }
    catch (e) { setSaveError(e); onAuthError(e); } finally { setSaving(false); }
  }
  async function saveHours() {
    setSaving(true); setSaveError(null); setNotice('');
    try {
      setData(await api('/gym/hours', { method: 'PUT', body: { hours: hours.map(({ weekday, closed, open_time, close_time }) =>
        ({ weekday, closed, open_time: closed ? null : open_time, close_time: closed ? null : close_time })) } }));
      setNotice('บันทึกเวลาเปิดทำการแล้ว');
    } catch (e) { setSaveError(e); onAuthError(e); } finally { setSaving(false); }
  }

  return <>
    <h1>ข้อมูลยิม</h1>
    <p className="sub">ทุกอย่างในหน้านี้แก้ได้เอง ไม่มีค่าไหนถูกฝังไว้ในโค้ด · ชื่อและเบอร์โทรจะไปขึ้นบนบัตรสมาชิกทุกใบ</p>
    {notice && <div className="banner ok" role="status"><div className="ic" aria-hidden="true">✓</div><div><b>{notice}</b></div></div>}
    <Notice error={saveError}/>
    <form className="block" onSubmit={saveProfile}>
      <h2>รายละเอียดยิม</h2>
      <Field name="name" label="ชื่อยิม (ภาษาอังกฤษ)" value={form.name} onChange={v => set('name', v)} error={errors.name} required/>
      <Field name="brand_name_th" label="ชื่อยิม (ภาษาไทย)" value={form.brand_name_th} onChange={v => set('brand_name_th', v)} error={errors.brand_name_th}/>
      <Field name="address" label="ที่อยู่" value={form.address ?? ''} onChange={v => set('address', v)} error={errors.address}/>
      <Field name="location_note" label="อำเภอ จังหวัด (ขึ้นบนบัตร)" value={form.location_note ?? ''} onChange={v => set('location_note', v)} error={errors.location_note}/>
      <div className="two">
        <Field name="phone_primary" label="เบอร์โทรหลัก" value={form.phone_primary ?? ''} onChange={v => set('phone_primary', v)} error={errors.phone_primary} type="tel"/>
        <Field name="phone_secondary" label="เบอร์โทรสำรอง" value={form.phone_secondary ?? ''} onChange={v => set('phone_secondary', v)} error={errors.phone_secondary} type="tel"/>
      </div>
      <Field name="phone_display" label="เบอร์ที่แสดงบนบัตรและหน้าสาธารณะ" value={form.phone_display} onChange={v => set('phone_display', v)}>
        <select><option value="primary">เบอร์หลัก</option><option value="secondary">เบอร์สำรอง</option><option value="hidden">ไม่แสดงเบอร์</option></select>
      </Field>
      <label className="check-row"><input type="checkbox" checked={form.hours_confirmed} onChange={e => set('hours_confirmed', e.target.checked)}/>
        <span>ยืนยันเวลาเปิดทำการแล้ว (เอาคำเตือนออกจากหน้าสาธารณะ)</span></label>
      <button className="btn primary auto" disabled={saving}>{saving ? 'กำลังบันทึก…' : 'บันทึกข้อมูลยิม'}</button>
    </form>

    <div className="block">
      <h2>การเช็คอิน</h2>
      <Field name="check_in_window_minutes" label="สแกนซ้ำภายในกี่นาทีถือเป็นครั้งเดียวกัน" value={form.check_in_window_minutes}
        onChange={v => set('check_in_window_minutes', v)} error={errors.check_in_window_minutes} type="number" min={1} max={720}
        hint="บัตรถาวรถูกสแกนซ้ำโดยบังเอิญบ่อย ค่านี้คือสิ่งที่กันการหักสิทธิ์ซ้ำ"/>
      <form onSubmit={saveProfile}>
        <button className="btn primary auto" disabled={saving}>{saving ? 'กำลังบันทึก…' : 'บันทึกการเช็คอิน'}</button>
      </form>
    </div>

    <div className="block">
      <h2>เวลาเปิดทำการ</h2>
      {hours.map(day => <div className="hours-grid" key={day.weekday}>
        <strong>{day.label}</strong>
        <label className="check-row" style={{ margin: 0 }}><input type="checkbox" checked={day.closed}
          onChange={e => setDay(day.weekday, { closed: e.target.checked })} aria-label={`ปิดวัน${day.label}`}/><span>ปิด</span></label>
        <input type="time" value={day.open_time ?? ''} disabled={day.closed} aria-label={`เวลาเปิดวัน${day.label}`}
          onChange={e => setDay(day.weekday, { open_time: e.target.value })}/>
        <input type="time" value={day.close_time ?? ''} disabled={day.closed} aria-label={`เวลาปิดวัน${day.label}`}
          onChange={e => setDay(day.weekday, { close_time: e.target.value })}/>
      </div>)}
      <button className="btn primary auto" style={{ marginTop: 'var(--sp-4)' }} onClick={saveHours} disabled={saving}>
        {saving ? 'กำลังบันทึก…' : 'บันทึกเวลาเปิดทำการ'}</button>
    </div>

    <div className="block">
      <h2>ยอดขายรายวัน</h2>
      <p className="note">ใช้เทียบกับรายการเงินเข้าบัญชีจริง นับเฉพาะที่รับเงินจริง ไม่รวมแพ็กเกจที่แถมให้</p>
      <SalesReport/>
    </div>
  </>;
}

// ------------------------------------------------------------- app shell

const NAV = [
  ['scan', 'สแกนเช็คอิน', 'สแกน'],
  ['signup', 'สมัครสมาชิก', 'สมัคร'],
  ['members', 'สมาชิก', 'สมาชิก'],
  ['payment', 'รับเงินและมอบแพ็กเกจ', 'รับเงิน'],
  ['packages', 'แพ็กเกจ', null],
  ['users', 'ผู้ใช้และสิทธิ์', null],
  ['gym', 'ข้อมูลยิม', null],
  ['checkin', 'ประวัติเช็คอิน', null],
];

function Shell({ brand, role, tabs, tab, setTab, onLogout, pilot, children }) {
  const [more, setMore] = useState(false);
  const primary = tabs.filter(([, , short]) => short);
  const secondary = tabs.filter(([, , short]) => !short);
  return <>
    {pilot && <div className="pilot-banner" role="status">
      <b>โหมดทดลอง</b><span>ยังไม่ได้ผูกบัญชีพร้อมเพย์ — รับเงินและมอบแพ็กเกจที่หน้าสมาชิกได้ตามปกติ</span></div>}
    <header className="appbar"><div className="appbar-in">
      <div className="mark" aria-hidden="true">{initials(brand)}</div>
      <div className="brand">{brand}<small>{role === 'admin' ? 'เจ้าของยิม' : 'พนักงาน'}</small></div>
      <div className="spacer"/>
      <button className="btn auto" onClick={onLogout}>ออกจากระบบ</button>
    </div></header>
    <main className="wrap"><div className="page">
      <nav aria-label="เมนูหลัก">
        <ul className="railnav">{tabs.map(([key, label]) =>
          <li key={key}><a href={`#${key}`} aria-current={tab === key ? 'page' : undefined}
            onClick={e => { e.preventDefault(); setTab(key); }}>{label}</a></li>)}</ul>
      </nav>
      <div>{children}</div>
    </div></main>
    <nav className="bottomnav" aria-label="เมนูหลัก (มือถือ)">
      <ul>
        {primary.map(([key, label, short]) => <li key={key}>
          <a href={`#${key}`} aria-current={tab === key ? 'page' : undefined}
            aria-label={label} onClick={e => { e.preventDefault(); setTab(key); setMore(false); }}>{short}</a></li>)}
        {secondary.length > 0 && <li>
          <a href="#more" aria-expanded={more} onClick={e => { e.preventDefault(); setMore(!more); }}>เพิ่มเติม</a></li>}
      </ul>
      {more && <ul style={{ display: 'block', borderTop: '2px solid var(--line)' }}>
        {secondary.map(([key, label]) => <li key={key} style={{ display: 'block' }}>
          <a href={`#${key}`} style={{ justifyContent: 'flex-start', padding: '0 var(--sp-5)', minHeight: 56 }}
            aria-current={tab === key ? 'page' : undefined}
            onClick={e => { e.preventDefault(); setTab(key); setMore(false); }}>{label}</a></li>)}
      </ul>}
    </nav>
  </>;
}

function Console({ user, gym, brand, onLogout, onAuthError, onSignedOut }) {
  const pilot = usePilot();
  const [tab, setTab] = useState('scan');
  const [open, setOpen] = useState(null);      // the member whose card is showing
  const [target, setTarget] = useState(null);  // the member being sold a package
  const [notice, setNotice] = useState('');
  const { data: packages } = useResource('/packages');
  const sellable = (packages?.items ?? []).filter(item => item.price_thb !== null && item.status === 'active');
  const admin = user.role === 'admin';
  // Only the owner sets prices, hands out roles or edits the gym's own facts.
  const tabs = NAV.filter(([key]) => (['users', 'gym', 'packages'].includes(key) ? admin : true));

  // The scan screen is a stage of its own: dark, full bleed, no rail. It is
  // the only screen used while standing up with somebody waiting.
  if (tab === 'scan') {
    return <StaffScanner brand={brand} role={user.role} onLogout={onLogout}
      onOpenMember={member => { setOpen(member); setTab('members'); }}
      onLeave={() => setTab('members')}/>;
  }

  const banner = notice && <div className="banner ok" role="status">
    <div className="ic" aria-hidden="true">✓</div><div><b>{notice}</b></div></div>;

  return <Shell brand={brand} role={user.role} tabs={tabs} tab={tab} setTab={key => { setTab(key); setNotice(''); setOpen(null); }}
    onLogout={onLogout} pilot={pilot}>
    {banner}
    {tab === 'signup' && <SignUp packages={sellable} onAuthError={onAuthError}
      onCancel={() => setTab('members')}
      onDone={async (id, message) => {
        const member = await api(`/members/${id}`).catch(() => null);
        setNotice(message); setOpen(member); setTab('members');
      }}/>}
    {tab === 'members' && (open
      ? <MemberCard member={open} canReissue={admin} onAuthError={onAuthError}
          onBack={() => { setOpen(null); setNotice(''); }}
          onChanged={message => setNotice(message)}/>
      : <MemberList onAuthError={onAuthError} onSignUp={() => setTab('signup')}
          onOpen={member => { setOpen(member); setNotice(''); }}/>)}
    {tab === 'payment' && (target
      ? <PaymentGrant member={target} packages={sellable} onAuthError={onAuthError}
          onPickMember={() => setTarget(null)}
          onDone={message => { setNotice(message); setTarget(null); }}/>
      : <><h1>รับเงินและมอบแพ็กเกจ</h1>
          <p className="sub">เลือกสมาชิกที่จะรับเงินและมอบแพ็กเกจให้</p>
          <MemberList onAuthError={onAuthError} onSignUp={() => setTab('signup')}
            onOpen={member => setTarget(member)}/></>)}
    {tab === 'packages' && <Packages onAuthError={onAuthError}/>}
    {tab === 'users' && <Users onAuthError={onAuthError} signedInAs={user.email} onSignedOut={onSignedOut}/>}
    {tab === 'gym' && <GymSettings onAuthError={onAuthError}/>}
    {tab === 'checkin' && <><h1>ประวัติเช็คอิน</h1>
      <p className="sub">ดูว่าใครเข้ายิมเมื่อไร และใครถูกปฏิเสธเพราะอะไร</p>
      <CheckInLog/>
      <div className="block"><h2>สรุปรายวัน</h2><CheckInSummary/></div></>}
  </Shell>;
}

// -------------------------------------------------------------------- root

function setupTokenFromUrl() {
  const token = new URLSearchParams(window.location.search).get('setpw');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) return null;
  // Out of the address bar, so a shared screenshot or a back button does not
  // carry it around after it has been used.
  window.history.replaceState(null, '', window.location.pathname);
  return token;
}

function App() {
  const [user, setUser] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState(null);
  const [gym, setGym] = useState(null), [pilot, setPilot] = useState(false), [farewell, setFarewell] = useState('');
  const [setupToken, setSetupToken] = useState(setupTokenFromUrl);
  const onAuthError = e => { if (e.status === 401) setUser(null); };
  useEffect(() => {
    api('/me').then(setUser).catch(e => { if (e.status !== 401) setError(e); }).finally(() => setLoading(false));
  }, []);
  useEffect(() => { api('/public/config').then(config => setPilot(!!config.pilot_mode)).catch(() => setPilot(false)); }, []);
  useEffect(() => { api('/public/gym').then(setGym).catch(() => setGym(null)); }, []);
  useEffect(() => { if (user) api('/gym').then(setGym).catch(() => {}); }, [user]);

  const logout = async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* the session is gone either way */ }
    setUser(null);
  };
  const brand = gym?.profile?.brand_name_th || gym?.profile?.name || 'ยิมของเรา';

  if (loading) return <main className="empty" role="status">กำลังเปิดยิมของเรา…</main>;

  return <PilotContext.Provider value={pilot}>
    {setupToken
      ? <SetPassword brand={brand} token={setupToken} onDone={() => setSetupToken(null)}/>
      : !user
        ? <>
            {farewell && <div className="scanstage" style={{ minHeight: 0, padding: 'var(--sp-5)' }}>
              <div className="banner ok" style={{ maxWidth: 430, margin: '0 auto' }} role="status">
                <div className="ic" aria-hidden="true">✓</div><div><b>{farewell}</b></div></div></div>}
            <Login brand={brand} onLogin={u => { setError(null); setFarewell(''); setUser(u); }}/>
          </>
        : <Console user={user} gym={gym} brand={brand} onLogout={logout} onAuthError={onAuthError}
            onSignedOut={message => { setFarewell(message); setError(null); setUser(null); }}/>}
    {error && !user && <div className="wrap"><Notice error={error}/></div>}
  </PilotContext.Provider>;
}

createRoot(document.getElementById('root')).render(<App/>);
