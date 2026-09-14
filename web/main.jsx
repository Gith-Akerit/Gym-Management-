import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import {
  api, Field, formatDate, formatDateTime, formatPhone, formatPrice, labels, Notice,
  packageStatusLabels, PilotContext, useResource, usePilot,
} from './shared.jsx';
import {
  MemberEntitlements, MemberOrder, MemberOrderHistory, MemberPackages,
  PaymentReview, SalesReport,
} from './payments.jsx';
import {
  CheckInLog, CheckInSummary, MemberCheckInHistory, MemberCheckInQr, StaffScanner,
} from './checkin.jsx';

/**
 * The line icons the navigation needs. On a phone the menu becomes a bottom
 * bar where the label is 11px, so the glyph is doing most of the work of
 * telling one item from another; without it the bar is a row of tiny words.
 */
const icons = {
  home: 'M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z',
  users: 'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6M21 19v-1a4 4 0 0 0-3-3.9',
  shield: 'M12 3 5 6v5c0 4.3 2.9 8.3 7 9.5 4.1-1.2 7-5.2 7-9.5V6z',
  slip: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h6M9 16h4',
  scan: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  box: 'M3 8 12 3l9 5-9 5zM3 8v8l9 5 9-5V8M12 13v8',
  gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1 2 2 0 1 1-4 0 1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 15a2 2 0 1 1 0-4 1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9 4.6a2 2 0 1 1 4 0 1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.6 1.6 0 0 0 19.4 11a2 2 0 1 1 0 4z',
  key: 'M15 7a4 4 0 1 1-3.9 5H9v2H7v2H4v-3l6.1-6.1A4 4 0 0 1 15 7',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M5 21v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1',
  out: 'M15 17l5-5-5-5M20 12H9M13 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h7',
};
const Icon = ({ name }) => <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d={icons[name]}/></svg>;

const blank = { name: '', email: '', phone: '', date_of_birth: '', emergency_contact: '', status: 'active' };
const blankPackage = { code: '', name_th: '', type: 'unlimited', duration_days: 30, session_limit: '', price_satang: '', description: '', status: 'draft', sort_order: 0 };

function ProfileFields({ value, setValue, errors = {}, includeEmail = false }) {
  const field = (name, label, props = {}) => <Field key={name} name={name} label={label} value={value[name]}
    onChange={v => setValue({ ...value, [name]: v })} error={errors[name]} {...props}/>;
  return <>
    {field('name', 'ชื่อ–นามสกุล', { required: true, maxLength: 120, autoComplete: 'name' })}
    {includeEmail && field('email', 'อีเมล', { required: true, type: 'email', autoComplete: 'email' })}
    {field('phone', 'เบอร์มือถือ', { required: true, type: 'tel', inputMode: 'tel', autoComplete: 'tel', placeholder: '08X-XXX-XXXX' })}
    <details><summary>ข้อมูลเพิ่มเติม (ไม่บังคับ)</summary>
      {field('date_of_birth', 'วันเกิด (ค.ศ.)', { type: 'date', min: '1900-01-01', max: new Date().toISOString().slice(0, 10) })}
      {field('emergency_contact', 'ผู้ติดต่อฉุกเฉินและเบอร์โทร', { maxLength: 200 })}
    </details>
  </>;
}

function PublicGymInfo() {
  const [data, setData] = useState(null);
  useEffect(() => {
    Promise.all([api('/public/gym'), api('/public/packages')])
      .then(([gym, packages]) => setData({ gym, packages: packages.items }))
      .catch(() => setData(null));
  }, []);
  if (!data?.gym?.profile) return null;
  const { profile, hours } = data.gym;
  return <section className="card public-info"><h2>{profile.brand_name_th || profile.name}</h2>
    {profile.address && <p className="muted">{profile.address}</p>}
    {profile.phone && <p className="muted">โทร <a href={`tel:${profile.phone}`}>{formatPhone(profile.phone)}</a></p>}
    <h3>เวลาเปิดทำการ</h3>
    {!profile.hours_confirmed && <div className="notice warn">เวลาเปิดทำการยังรอการยืนยันจากยิม กรุณาโทรสอบถามก่อนเดินทาง</div>}
    <dl>{hours.map(day => <React.Fragment key={day.weekday}>
      <dt>{day.label}</dt><dd>{day.closed ? 'ปิด' : `${day.open_time} – ${day.close_time} น.`}</dd>
    </React.Fragment>)}</dl>
    <h3 style={{ marginTop: 18 }}>แพ็กเกจ</h3>
    {!data.packages.length ? <p className="muted">ยังไม่เปิดขายแพ็กเกจ สอบถามได้ที่เคาน์เตอร์</p>
      : data.packages.map(item => <div className="pkg-card" key={item.id}>
        <div className="pkg-head"><div><h3>{item.name_th}</h3>
          <p className="muted">{item.type === 'unlimited'
            ? `เข้าได้ไม่จำกัดครั้ง ภายใน ${item.duration_days} วัน`
            : `เข้าได้ ${item.session_limit} ครั้ง ภายใน ${item.duration_days} วัน`}</p></div>
          <span className="price">{formatPrice(item.price_thb)}</span></div>
      </div>)}
    <p className="fine">สมัครสมาชิกด้วยอีเมลที่ช่องด้านบนเพื่อซื้อแพ็กเกจ</p>
  </section>;
}

/**
 * A sign-in the pilot CLI started on the server, handed over as a link.
 *
 * The very first administrator has nowhere to read their own code -- the screen
 * that shows codes is behind the login they are trying to pass -- so somebody
 * with root issues it at the terminal and sends them this. The id alone opens
 * nothing: it still needs the six digits, which expire in five minutes and
 * allow five attempts.
 */
function challengeFromLink() {
  const id = new URLSearchParams(window.location.search).get('challenge');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id ?? '')) return null;
  // Out of the address bar, so a shared screenshot or a back button does not
  // carry it around after it has been used.
  window.history.replaceState(null, '', window.location.pathname);
  return { challenge_id: id, from_link: true };
}

function Login({ onLogin }) {
  const pilot = usePilot();
  const [email, setEmail] = useState(''), [challenge, setChallenge] = useState(challengeFromLink), [code, setCode] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [remaining, setRemaining] = useState(0);
  useEffect(() => { if (!remaining) return; const timer = setTimeout(() => setRemaining(remaining - 1), 1000); return () => clearTimeout(timer); }, [remaining]);
  async function request() {
    setBusy(true); setError(null);
    try { setChallenge(await api('/auth/request-otp', { method: 'POST', body: { email } })); setCode(''); setRemaining(60); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function submit(e) {
    e.preventDefault(); if (!challenge) return request();
    setBusy(true); setError(null);
    try { onLogin(await api('/auth/verify-otp', { method: 'POST', body: { challenge_id: challenge.challenge_id, code } })); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  return <main className="app-main"><div className="container login-layout"><section className="welcome"><span className="eyebrow">ยิมของเรา</span>
    <h1>เริ่มต้นดูแลตัวเอง<br/>ได้ทุกวัน</h1><p>ข้อมูลสมาชิกของคุณ<br/>อยู่ใกล้แค่ปลายนิ้ว</p><div className="welcome-line"/>
    <span>เรียบง่าย พร้อมสำหรับวันของคุณ</span></section>
    <section className="card login-card"><div className="icon-mark" aria-hidden="true">G</div><h2>{challenge ? 'ยืนยันอีเมลของคุณ' : 'ยินดีต้อนรับ'}</h2>
      <p className="muted">{!challenge
        ? 'เข้าสู่ระบบหรือสมัครสมาชิกด้วยอีเมล ไม่ต้องจำรหัสผ่าน'
        : challenge.from_link
          ? 'กรอกรหัส 6 หลักที่ได้จากหน้าจอผู้ดูแลระบบ รหัสใช้ได้ 5 นาที'
          : pilot
            ? `ขอรหัส 6 หลักของ ${email} จากเจ้าหน้าที่ที่เคาน์เตอร์หรือทาง LINE รหัสใช้ได้ 5 นาที`
            : `ส่งรหัส 6 หลักไปที่ ${email} แล้ว รหัสใช้ได้ 5 นาที`}</p>
      <form onSubmit={submit}>
        {!challenge ? <Field label="อีเมล" name="email" type="email" value={email} onChange={setEmail} required autoComplete="email" error={error?.fields?.email}/>
          : <Field label="รหัสยืนยัน 6 หลัก" name="code" value={code} onChange={setCode} required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" autoFocus/>}
        <Notice error={error}/><button className="primary full" disabled={busy}>{busy ? 'กำลังดำเนินการ…' : challenge ? 'ยืนยันและเข้าสู่ระบบ' : pilot ? 'ขอรหัสเข้าใช้งาน' : 'รับรหัสทางอีเมล'}</button>
      </form>
      {challenge && <><div className="login-actions">
        {/* Asking again would retire the code the link was issued for, so the
            only way on from here is forward or back to the email form. */}
        {!challenge.from_link && <button disabled={busy || remaining > 0} onClick={request}>{remaining ? `ส่งรหัสใหม่ได้ใน ${remaining} วินาที` : 'ส่งรหัสใหม่'}</button>}
        <button disabled={busy} onClick={() => { setChallenge(null); setError(null); }}>{challenge.from_link ? 'เข้าด้วยอีเมลอื่น' : 'เปลี่ยนอีเมล'}</button></div>
        <p className="fine">{challenge.from_link
          ? 'ลิงก์นี้ใช้ได้ครั้งเดียวและหมดอายุใน 5 นาที ถ้าหมดอายุแล้วให้ขอรหัสใหม่จากผู้ดูแลระบบ'
          : pilot
            ? 'ขณะนี้ระบบอยู่ในโหมดทดลอง ยังไม่ส่งอีเมล เจ้าหน้าที่จะเป็นผู้แจ้งรหัสให้คุณ'
            : 'ไม่ได้รับอีเมล? ลองตรวจโฟลเดอร์จดหมายขยะ แล้วกดส่งรหัสใหม่ หากยังไม่ได้รับ กรุณาติดต่อพนักงานที่เคาน์เตอร์'}</p></>}
      <p className="fine">สมาชิกใหม่กรอกชื่อและเบอร์มือถือหลังยืนยันอีเมล</p>
    </section>
    <PublicGymInfo/></div></main>;
}

function Onboarding({ onSaved, notice }) {
  const [value, setValue] = useState({ name: '', phone: '', date_of_birth: '', emergency_contact: '' });
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  return <main className="app-main"><div className="container">{notice}
    <section className="card narrow"><span className="eyebrow">อีกนิดเดียว</span><h1>ทำความรู้จักกัน</h1><p className="muted">กรอกชื่อและเบอร์มือถือเพื่อสร้างบัตรสมาชิก</p>
    <form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(null); try { await api('/me/profile', { method: 'PUT', body: value }); await onSaved(); } catch(e) { setError(e); } finally { setBusy(false); } }}>
      <ProfileFields value={value} setValue={setValue} errors={error?.fields}/><Notice error={error}/><button className="primary full" disabled={busy}>{busy ? 'กำลังบันทึก…' : 'เริ่มใช้งาน'}</button>
    </form></section></div></main>;
}

// --------------------------------------------------------------- member app

function MemberHome({ member, gym }) {
  return <>
    <section className="member-card"><span className="eyebrow">บัตรสมาชิกของคุณ</span>
      <div className="avatar" aria-hidden="true">{member.name.slice(0, 1)}</div>
      <h1>{member.name}</h1><p className="member-code">{member.member_code}</p>
      <span className={`badge ${member.status}`}>{labels[member.status]}</span>
      <p className="card-foot">เป็นสมาชิกตั้งแต่ {formatDate(member.joined_at)}</p></section>
    {member.status !== 'active' && <div className="notice warn">{member.status === 'suspended'
      ? 'บัญชีสมาชิกถูกระงับ กรุณาติดต่อพนักงานที่ยิม' : 'สถานะสมาชิกหมดอายุ กรุณาติดต่อพนักงานที่ยิม'}</div>}
    <section className="card"><h2>QR สำหรับเช็คอิน</h2>
      {member.status === 'active'
        ? <MemberCheckInQr/>
        : <p className="muted">เปิดรหัสเช็คอินไม่ได้ขณะที่สถานะสมาชิกยังไม่ปกติ กรุณาติดต่อพนักงานที่ยิม</p>}
    </section>
    <section className="card"><h2>แพ็กเกจปัจจุบัน</h2><MemberEntitlements/></section>
    {gym?.profile && <p className="fine">{gym.profile.brand_name_th || gym.profile.name}{gym.profile.address ? ` · ${gym.profile.address}` : ''}</p>}
  </>;
}

function GymInfo({ gym }) {
  if (!gym?.profile) return null;
  const { profile, hours } = gym;
  return <section className="card"><h2>ข้อมูลยิม</h2>
    <dl>
      <dt>ชื่อ</dt><dd>{profile.brand_name_th || profile.name}</dd>
      {profile.address && <><dt>ที่อยู่</dt><dd>{profile.address}{profile.location_note ? ` (${profile.location_note})` : ''}</dd></>}
      {profile.phone && <><dt>โทรศัพท์</dt><dd><a href={`tel:${profile.phone}`}>{formatPhone(profile.phone)}</a></dd></>}
    </dl>
    <h3 style={{ marginTop: 18 }}>เวลาเปิดทำการ</h3>
    {!profile.hours_confirmed && <div className="notice warn">เวลาเปิดทำการยังรอการยืนยันจากยิม กรุณาโทรสอบถามก่อนเดินทาง</div>}
    <dl>{hours.map(day => <React.Fragment key={day.weekday}>
      <dt>{day.label}</dt><dd>{day.closed ? 'ปิด' : `${day.open_time} – ${day.close_time} น.`}</dd>
    </React.Fragment>)}</dl></section>;
}

function MemberAccount({ member, gym, refresh, onLogout, onOpenOrder }) {
  const [error, setError] = useState(null), [busy, setBusy] = useState(false);
  return <>
    <h1>บัญชีของฉัน</h1>
    <section className="card"><h2>ข้อมูลของฉัน</h2>
      <dl><dt>อีเมล</dt><dd>{member.email}</dd><dt>เบอร์มือถือ</dt><dd>{formatPhone(member.phone)}</dd>
        <dt>รหัสสมาชิก</dt><dd>{member.member_code}</dd>
        {member.date_of_birth && <><dt>วันเกิด</dt><dd>{formatDate(member.date_of_birth)}</dd></>}
        {member.emergency_contact && <><dt>ผู้ติดต่อฉุกเฉิน</dt><dd>{member.emergency_contact}</dd></>}</dl>
      <p className="muted">หากต้องการแก้ไขข้อมูล กรุณาติดต่อพนักงาน</p>
      <Notice error={error}/>
      <div className="actions">
        <button disabled={busy} onClick={async () => { setBusy(true); setError(null); try { await refresh(); } catch(e) { setError(e); } finally { setBusy(false); } }}>{busy ? 'กำลังโหลด…' : 'รีเฟรชข้อมูล'}</button>
        <button onClick={onLogout}>ออกจากระบบ</button>
      </div>
    </section>
    <section className="card"><h2>ประวัติการเข้าใช้บริการ</h2><MemberCheckInHistory/></section>
    <section className="card"><h2>ประวัติการสั่งซื้อ</h2><MemberOrderHistory onOpen={onOpenOrder}/></section>
    <GymInfo gym={gym}/>
  </>;
}

function MemberApp({ member, gym, refresh, onLogout, notice }) {
  const pilot = usePilot();
  const [tab, setTab] = useState('home');
  const [orderId, setOrderId] = useState(null);
  // In pilot mode there is nothing to buy: the gym has no PromptPay account
  // wired up yet, and packages are handed over by staff.
  const tabs = [['home', 'หน้าแรก', 'home'], ...(pilot ? [] : [['packages', 'แพ็กเกจ', 'box']]),
    ['account', 'บัญชี', 'user']];
  const open = id => { setOrderId(id); setTab('packages'); };
  // Few enough screens for a tab bar rather than a sidebar: across the top on a
  // desktop, along the bottom where a thumb reaches on a phone.
  return <>
    <nav className="tabnav" aria-label="เมนูหลัก"><div className="container">{tabs.map(([key, label, icon]) =>
      <button key={key} onClick={() => { setTab(key); if (key !== 'packages') setOrderId(null); }}
        aria-current={tab === key ? 'page' : undefined}><Icon name={icon}/>{label}</button>)}</div></nav>
    <main className="app-main"><div className="container">
      {notice}
      <div className="member-shell">
        {tab === 'home' && <MemberHome member={member} gym={gym}/>}
        {tab === 'packages' && (orderId
          ? <MemberOrder key={orderId} orderId={orderId} onBack={() => setOrderId(null)}/>
          : <MemberPackages onBuy={setOrderId}/>)}
        {tab === 'account' && <MemberAccount member={member} gym={gym} refresh={refresh} onLogout={onLogout} onOpenOrder={open}/>}
      </div>
    </div></main>
  </>;
}

// ------------------------------------------------------------ admin: members

/**
 * The code a member is waiting for, on the screen the staff member already has
 * open. Pilot mode only: outside it the member has the code in their inbox and
 * nobody else should be able to read it.
 */
function PilotOtp({ member }) {
  const { data, error, busy, reload } = useResource(`/members/${member.id}`);
  if (busy || error) return null;
  return <section className="card pilot-otp">
    <h2>รหัสเข้าใช้งานล่าสุด</h2>
    {data.pilot_otp
      ? <><p className="otp-code">{data.pilot_otp.code}</p>
          <p className="fine">ใช้ได้ถึง {formatDateTime(data.pilot_otp.expires_at)} · บอกรหัสนี้ให้สมาชิกทางโทรศัพท์หรือ LINE</p></>
      : <p className="muted">ยังไม่มีรหัสที่ใช้ได้ ให้สมาชิกกด “ขอรหัสเข้าใช้งาน” ในแอปก่อน แล้วกดปุ่มด้านล่าง</p>}
    <button onClick={() => reload().catch(() => {})}>โหลดรหัสล่าสุด</button>
  </section>;
}

/** Hands a member a package outright: no order to pay, no slip, no QR. */
function GrantPackage({ member, onGranted, onAuthError }) {
  const { data, error } = useResource('/packages');
  const [packageId, setPackageId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false), [grantError, setGrantError] = useState(null);
  const choices = (data?.items ?? []).filter(item => item.price_satang !== null);

  async function grant() {
    setBusy(true); setGrantError(null);
    try {
      await api(`/members/${member.id}/grant`, { method: 'POST', body: { package_id: packageId, note } });
      onGranted('มอบแพ็กเกจแล้ว');
    } catch (e) { setGrantError(e); onAuthError(e); } finally { setBusy(false); }
  }

  return <section className="card"><h2>มอบแพ็กเกจ</h2>
    <p className="muted">ให้สิทธิ์กับสมาชิกรายนี้โดยตรง ไม่ผ่านการชำระเงิน ยอดนี้จะไม่ถูกนับเป็นรายได้ในสรุปยอดขาย</p>
    <Notice error={error}/>
    {!choices.length ? <p className="muted">ยังไม่มีแพ็กเกจที่กรอกราคาไว้ กรุณาตั้งราคาในหน้าแพ็กเกจก่อน</p> : <>
      <label className="field">แพ็กเกจที่จะมอบ
        <select aria-label="แพ็กเกจที่จะมอบ" value={packageId} onChange={e => setPackageId(e.target.value)}>
          <option value="">— เลือกแพ็กเกจ —</option>
          {choices.map(item => <option key={item.id} value={item.id}>
            {item.name_th} · {item.price_thb === 0 ? 'ไม่มีค่าใช้จ่าย' : formatPrice(item.price_thb)}</option>)}
        </select></label>
      <Field name="grant-note" label="เหตุผล (บันทึกไว้ในประวัติ)" value={note} onChange={setNote} maxLength={300}
        placeholder="เช่น ทดลองใช้ในช่วง pilot"/>
      <Notice error={grantError}/>
      <button className="primary" disabled={!packageId || !note.trim() || busy} onClick={grant}>
        {busy ? 'กำลังมอบสิทธิ์…' : 'มอบแพ็กเกจให้สมาชิกรายนี้'}</button>
    </>}
  </section>;
}

/** Every code requested recently, so the counter can answer "what is mine?". */
function PilotOtpBoard() {
  const { data, error, busy, reload } = useResource('/admin/pilot/otp-codes');
  return <><div className="page-heading"><div><span className="eyebrow">โหมดทดลอง</span>
    <h1>รหัสเข้าใช้งานล่าสุด</h1>
    <p className="muted">ระบบยังไม่ส่งอีเมล บอกรหัสให้สมาชิกที่เคาน์เตอร์หรือทาง LINE</p></div>
    <button onClick={() => reload().catch(() => {})} disabled={busy}>{busy ? 'กำลังโหลด…' : 'โหลดใหม่'}</button></div>
    <Notice error={error}/>
    <section className="card">
      {busy ? <p role="status" className="empty">กำลังโหลด…</p>
        : !data?.items.length ? <p className="muted">ยังไม่มีใครขอรหัสในช่วง 5 นาทีที่ผ่านมา</p>
          : <div className="member-list">{data.items.map(item => <div className="member-row" key={`${item.email}-${item.created_at}`}>
            <span className="member-name"><strong>{item.email}</strong>
              <small>ขอเมื่อ {formatDateTime(item.created_at)} · ใช้ได้ถึง {formatDateTime(item.expires_at)}</small></span>
            <span className={`otp-code ${item.used ? 'used' : ''}`}>{item.used ? 'ใช้ไปแล้ว' : item.code}</span>
          </div>)}</div>}
    </section>
    <p className="fine">รหัสหายไปเมื่อหมดอายุหรือเมื่อเซิร์ฟเวอร์รีสตาร์ต ไม่ได้ถูกบันทึกลงฐานข้อมูล</p></>;
}

function MemberEditor({ member, onCancel, onSaved, onAuthError }) {
  const pilot = usePilot();
  const [value, setValue] = useState(member ? { ...blank, ...member } : { ...blank });
  const [error, setError] = useState(null), [busy, setBusy] = useState(false), [audit, setAudit] = useState(null);
  async function save(e) {
    e.preventDefault(); setBusy(true); setError(null);
    const { name, email, phone, date_of_birth, emergency_contact, status } = value;
    try {
      await api(member ? `/members/${member.id}` : '/members', { method: member ? 'PUT' : 'POST', body: { name, email, phone, date_of_birth, emergency_contact, status, ...(member && { version: member.version }) } });
      onSaved(member ? 'บันทึกข้อมูลแล้ว' : 'เพิ่มสมาชิกแล้ว');
    } catch(e) { setError(e); onAuthError(e); } finally { setBusy(false); }
  }
  async function deactivate() {
    if (!window.confirm(`ระงับสมาชิก ${member.name}? ประวัติจะยังคงอยู่`)) return;
    setBusy(true); setError(null);
    try { await api(`/members/${member.id}`, { method: 'DELETE', body: { version: member.version } }); onSaved('ระงับสมาชิกแล้ว'); }
    catch(e) { setError(e); onAuthError(e); } finally { setBusy(false); }
  }
  return <section className="card narrow"><button onClick={onCancel} disabled={busy}>← กลับรายชื่อสมาชิก</button><h1>{member ? 'ข้อมูลสมาชิก' : 'เพิ่มสมาชิก'}</h1>
    {member && <p className="muted">{member.member_code}</p>}
    {member && pilot && <PilotOtp member={member}/>}
    <form onSubmit={save}><ProfileFields value={value} setValue={setValue} includeEmail errors={error?.fields}/>
      <label className="field">สถานะสมาชิก<select aria-label="สถานะสมาชิก" value={value.status} onChange={e => setValue({ ...value, status: e.target.value })}>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <Notice error={error}/><div className="actions"><button className="primary" disabled={busy}>{busy ? 'กำลังบันทึก…' : 'บันทึกสมาชิก'}</button><button type="button" onClick={onCancel} disabled={busy}>ยกเลิก</button></div>
    </form>
    {member && <GrantPackage member={member} onAuthError={onAuthError} onGranted={onSaved}/>}
    {member && <div className="secondary-actions"><button className="danger" onClick={deactivate} disabled={busy || member.status === 'suspended'}>ระงับสมาชิก</button>
      <button disabled={busy} onClick={async () => { try { setAudit(await api(`/members/${member.id}/audit`)); } catch(e) { setError(e); onAuthError(e); } }}>ดูประวัติการแก้ไข</button></div>}
    {audit && <section className="audit"><h2>ประวัติการแก้ไข</h2>{audit.items.map(item => <div key={item.id}><strong>{{ 'member.create': 'สร้างสมาชิก', 'member.update': 'แก้ไขข้อมูล', 'member.deactivate': 'ระงับสมาชิก' }[item.action] ?? item.action}</strong><span className="muted"> · {formatDate(item.created_at)}</span>
      <p className="fine">ผู้ดำเนินการ: {item.actor_id}</p></div>)}</section>}
  </section>;
}

function MemberAdmin({ onAuthError }) {
  const [q, setQ] = useState(''), [page, setPage] = useState(1), [data, setData] = useState(null), [busy, setBusy] = useState(true);
  const [error, setError] = useState(null), [editor, setEditor] = useState(null), [revision, setRevision] = useState(0), [notice, setNotice] = useState('');
  useEffect(() => {
    const abort = new AbortController(); setBusy(true); setError(null);
    const timer = setTimeout(async () => {
      try { const result = await api(`/members?q=${encodeURIComponent(q)}&page=${page}`, { signal: abort.signal }); setData(result); }
      catch(e) { if (e.name !== 'AbortError') { setError(e); onAuthError(e); } }
      finally { if (!abort.signal.aborted) setBusy(false); }
    }, 200);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [q, page, revision]);
  if (editor) return <MemberEditor key={editor.id || 'new'} member={editor.id ? editor : null} onAuthError={onAuthError} onCancel={() => { setEditor(null); setRevision(n => n + 1); }}
    onSaved={message => { setEditor(null); setNotice(message); setRevision(n => n + 1); }}/>;
  return <><div className="page-heading"><div><span className="eyebrow">ดูแลสมาชิก</span><h1>สมาชิกทั้งหมด</h1><p className="muted">ค้นหาและจัดการข้อมูลสมาชิกในที่เดียว</p></div>
    <button className="primary" onClick={() => { setEditor({}); setNotice(''); }}>＋ เพิ่มสมาชิก</button></div>
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="card"><div className="search-row"><Field name="search" label="ค้นหาสมาชิก" type="search" value={q} onChange={v => { setQ(v); setPage(1); }} placeholder="ชื่อ เบอร์โทร อีเมล หรือรหัสสมาชิก" maxLength={120}/>
      <span className="muted">{data ? `${data.total.toLocaleString('th-TH')} คน` : ''}</span></div>
      <Notice error={error}/>{error && <button onClick={() => setRevision(n => n + 1)}>ลองใหม่</button>}
      {busy ? <p role="status" className="empty">กำลังโหลดสมาชิก…</p> : !error && <>
        {!data?.items.length ? <div className="empty"><h2>{q ? 'ไม่พบสมาชิกที่ค้นหา' : 'ยังไม่มีสมาชิก'}</h2><p className="muted">{q ? 'ลองค้นหาด้วยชื่อ เบอร์โทร หรืออีเมลอื่น' : 'เริ่มด้วยปุ่ม “เพิ่มสมาชิก” หรือให้สมาชิกสมัครผ่านแอป'}</p></div>
          : <div className="table-wrap"><table className="table table-members">
            {/* A table on a desktop and a stack of cards on a phone, from one
                piece of markup: data-label carries the column name into the
                card, where there is no header row left to read it from. */}
            <thead><tr><th>สมาชิก</th><th>สถานะ</th><th>เบอร์โทร</th><th>วันที่สมัคร</th><th/></tr></thead>
            <tbody>{data.items.map(member => <tr key={member.id}>
              <td data-label=""><span className="person">
                <span className="avatar" aria-hidden="true">{member.name.slice(0, 1)}</span>
                <span><span className="person-name">{member.name}</span>
                  <span className="person-meta num">{member.member_code}</span></span></span></td>
              <td data-label="สถานะ"><span className={`badge ${member.status}`}>{labels[member.status]}</span></td>
              <td data-label="เบอร์โทร" className="num nowrap">{formatPhone(member.phone)}</td>
              <td data-label="วันที่สมัคร" className="nowrap">{formatDate(member.joined_at)}</td>
              <td className="cell-actions"><span className="actions">
                <button className="sm" onClick={() => { setEditor(member); setNotice(''); }}
                  aria-label={`แก้ไข ${member.name}`}>แก้ไข</button></span></td>
            </tr>)}</tbody>
          </table></div>}
        <div className="pagination"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>ก่อนหน้า</button><span>หน้า {page} / {Math.max(1, Math.ceil((data?.total || 0) / 20))}</span><button disabled={page * 20 >= (data?.total || 0)} onClick={() => setPage(page + 1)}>ถัดไป</button></div>
      </>}
    </section></>;
}

// ----------------------------------------------------------- admin: packages

function PackageEditor({ item, onCancel, onSaved, onAuthError }) {
  const toForm = row => ({ ...blankPackage, ...row,
    session_limit: row.session_limit ?? '', price_satang: row.price_thb ?? '' });
  const [value, setValue] = useState(item ? toForm(item) : { ...blankPackage });
  const [error, setError] = useState(null), [busy, setBusy] = useState(false);
  const set = (name, v) => setValue(current => ({ ...current, [name]: v }));
  async function save(e) {
    e.preventDefault(); setBusy(true); setError(null);
    const body = {
      code: value.code, name_th: value.name_th, type: value.type,
      duration_days: value.duration_days, description: value.description,
      status: value.status, sort_order: value.sort_order,
      session_limit: value.type === 'limited_sessions' ? value.session_limit : '',
      price_thb: value.price_satang,
      ...(item && { version: item.version }),
    };
    try { await api(item ? `/packages/${item.id}` : '/packages', { method: item ? 'PUT' : 'POST', body });
      onSaved(item ? 'บันทึกแพ็กเกจแล้ว' : 'เพิ่มแพ็กเกจแล้ว'); }
    catch(e) { setError(e); onAuthError(e); } finally { setBusy(false); }
  }
  async function archive() {
    if (!window.confirm(`ปิดการขาย ${value.name_th}? สิทธิ์ที่ขายไปแล้วจะยังใช้ได้`)) return;
    setBusy(true); setError(null);
    try { await api(`/packages/${item.id}`, { method: 'DELETE', body: { version: item.version } }); onSaved('ปิดการขายแพ็กเกจแล้ว'); }
    catch(e) { setError(e); onAuthError(e); } finally { setBusy(false); }
  }
  const errors = error?.fields ?? {};
  return <section className="card narrow"><button onClick={onCancel} disabled={busy}>← กลับรายการแพ็กเกจ</button>
    <h1>{item ? 'แก้ไขแพ็กเกจ' : 'เพิ่มแพ็กเกจ'}</h1>
    <form onSubmit={save}>
      <Field name="name_th" label="ชื่อแพ็กเกจ" value={value.name_th} onChange={v => set('name_th', v)} error={errors.name_th} required maxLength={120}/>
      <Field name="code" label="รหัสแพ็กเกจ (A-Z 0-9 _)" value={value.code} onChange={v => set('code', v)} error={errors.code} required maxLength={32} placeholder="UNLIMITED_30D"/>
      <label className="field">ประเภท
        <select aria-label="ประเภทแพ็กเกจ" value={value.type} onChange={e => set('type', e.target.value)}>
          <option value="unlimited">รายเดือน ไม่จำกัดครั้ง</option>
          <option value="limited_sessions">จำกัดจำนวนครั้ง</option>
        </select>
        {errors.type && <span className="field-error">{errors.type}</span>}</label>
      <div className="row-2">
        <Field name="duration_days" label="อายุแพ็กเกจ (วัน)" value={value.duration_days} onChange={v => set('duration_days', v)} error={errors.duration_days} type="number" min={1} max={3650} required/>
        {value.type === 'limited_sessions' &&
          <Field name="session_limit" label="จำนวนครั้ง" value={value.session_limit} onChange={v => set('session_limit', v)} error={errors.session_limit} type="number" min={1} max={1000} required/>}
      </div>
      <Field name="price_thb" label="ราคา (บาท) — เว้นว่างได้ถ้ายังไม่กำหนด" value={value.price_satang} onChange={v => set('price_satang', v)} error={errors.price_thb ?? errors.price_satang} type="number" min={0} step="0.01"/>
      <Field name="description" label="คำอธิบาย" value={value.description} onChange={v => set('description', v)} error={errors.description} maxLength={500}/>
      <div className="row-2">
        <label className="field">สถานะ
          <select aria-label="สถานะแพ็กเกจ" value={value.status} onChange={e => set('status', e.target.value)}>
            {Object.entries(packageStatusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          {errors.status && <span className="field-error">{errors.status}</span>}</label>
        <Field name="sort_order" label="ลำดับการแสดง" value={value.sort_order} onChange={v => set('sort_order', v)} error={errors.sort_order} type="number" min={0} max={999}/>
      </div>
      <p className="fine">ต้องกรอกราคาก่อนจึงจะเปลี่ยนสถานะเป็น “เปิดขาย” ได้ แพ็กเกจที่ยังเป็นร่างจะไม่แสดงให้สมาชิกเห็น</p>
      <Notice error={error}/>
      <div className="actions"><button className="primary" disabled={busy}>{busy ? 'กำลังบันทึก…' : 'บันทึกแพ็กเกจ'}</button>
        <button type="button" onClick={onCancel} disabled={busy}>ยกเลิก</button></div>
    </form>
    {item && item.status !== 'archived' && <div className="secondary-actions">
      <button className="danger" onClick={archive} disabled={busy}>ปิดการขายแพ็กเกจ</button></div>}
  </section>;
}

function PackageAdmin({ onAuthError }) {
  const { data, error, busy, reload } = useResource('/packages');
  const [editor, setEditor] = useState(null), [notice, setNotice] = useState('');
  if (editor) return <PackageEditor key={editor.id || 'new'} item={editor.id ? editor : null} onAuthError={onAuthError}
    onCancel={() => setEditor(null)}
    onSaved={message => { setEditor(null); setNotice(message); reload().catch(() => {}); }}/>;
  return <><div className="page-heading"><div><span className="eyebrow">แพ็กเกจ</span><h1>แพ็กเกจทั้งหมด</h1>
    <p className="muted">ตั้งราคาและเปิดขายได้เอง ไม่ต้องแก้โค้ด</p></div>
    <button className="primary" onClick={() => { setEditor({}); setNotice(''); }}>＋ เพิ่มแพ็กเกจ</button></div>
    {notice && <div className="notice" role="status">{notice}</div>}
    <Notice error={error}/>{error && <button onClick={() => reload().catch(() => {})}>ลองใหม่</button>}
    {busy ? <p role="status" className="empty">กำลังโหลดแพ็กเกจ…</p> : !error && (
      !data.items.length ? <div className="empty"><h2>ยังไม่มีแพ็กเกจ</h2><p>เริ่มด้วยปุ่ม “เพิ่มแพ็กเกจ”</p></div>
        : <section className="card">{data.items.map(item => {
          const price = formatPrice(item.price_thb);
          return <button key={item.id} className="pkg-card" style={{ width: '100%', textAlign: 'left' }} onClick={() => { setEditor(item); setNotice(''); }} aria-label={`แก้ไข ${item.name_th}`}>
            <div className="pkg-head"><div><h3>{item.name_th}</h3>
              <p className="muted">{item.code} · {item.type === 'unlimited' ? `ไม่จำกัดครั้ง ${item.duration_days} วัน` : `${item.session_limit} ครั้ง ${item.duration_days} วัน`}</p>
              <span className={`tag ${item.status}`}>{packageStatusLabels[item.status]}</span></div>
              <span className={price ? 'price' : 'price tbd'}>{price ?? 'รอกำหนดราคา'}</span></div>
          </button>;
        })}</section>)}
    <p className="fine">แพ็กเกจร่างมาจาก seed ของทีมวางแผน ราคายังว่างไว้จนกว่าเจ้าของยิมจะกรอกเอง</p></>;
}

// ----------------------------------------------------------- admin: gym info

function GymSettings({ onAuthError }) {
  const { data, error, busy, reload, setData } = useResource('/gym');
  const [form, setForm] = useState(null), [hours, setHours] = useState(null);
  const [saveError, setSaveError] = useState(null), [saving, setSaving] = useState(false), [notice, setNotice] = useState('');
  useEffect(() => {
    if (!data?.profile) return;
    setForm({ ...data.profile, address: data.profile.address ?? '', location_note: data.profile.location_note ?? '',
      phone_primary: data.profile.phone_primary ?? '', phone_secondary: data.profile.phone_secondary ?? '' });
    setHours(data.hours);
  }, [data]);
  if (busy) return <p role="status" className="empty">กำลังโหลดข้อมูลยิม…</p>;
  if (error) return <><Notice error={error}/><button onClick={() => reload().catch(() => {})}>ลองใหม่</button></>;
  if (!data.profile) return <div className="empty"><h2>ยังไม่ได้ตั้งค่าข้อมูลยิม</h2><p>รัน <code>npm run db:seed</code> เพื่อสร้างค่าเริ่มต้น</p></div>;
  if (!form || !hours) return null;
  const set = (name, v) => setForm(current => ({ ...current, [name]: v }));
  const setDay = (weekday, patch) => setHours(current => current.map(d => (d.weekday === weekday ? { ...d, ...patch } : d)));
  const errors = saveError?.fields ?? {};

  async function saveProfile(e) {
    e.preventDefault(); setSaving(true); setSaveError(null); setNotice('');
    const { id, timezone, currency, updated_at, ...rest } = form;
    try { setData(await api('/gym', { method: 'PUT', body: rest })); setNotice('บันทึกข้อมูลยิมแล้ว'); }
    catch(e) { setSaveError(e); onAuthError(e); } finally { setSaving(false); }
  }
  async function saveHours() {
    setSaving(true); setSaveError(null); setNotice('');
    try {
      setData(await api('/gym/hours', { method: 'PUT', body: { hours: hours.map(({ weekday, closed, open_time, close_time }) =>
        ({ weekday, closed, open_time: closed ? null : open_time, close_time: closed ? null : close_time })) } }));
      setNotice('บันทึกเวลาเปิดทำการแล้ว');
    } catch(e) { setSaveError(e); onAuthError(e); } finally { setSaving(false); }
  }

  return <><div className="page-heading"><div><span className="eyebrow">ตั้งค่า</span><h1>ข้อมูลยิม</h1>
    <p className="muted">ทุกอย่างในหน้านี้แก้ได้เอง ไม่มีค่าไหนถูกฝังไว้ในโค้ด</p></div></div>
    {notice && <div className="notice" role="status">{notice}</div>}
    {!form.hours_confirmed && <div className="notice warn">เวลาเปิดทำการยังไม่ได้ยืนยัน — สมาชิกจะเห็นคำเตือนให้โทรสอบถามก่อนเดินทาง ติ๊ก “ยืนยันเวลาเปิดทำการแล้ว” เมื่อข้อมูลถูกต้อง</div>}
    <Notice error={saveError}/>
    <section className="card"><h2>รายละเอียดยิม</h2>
      <form onSubmit={saveProfile}>
        <Field name="name" label="ชื่อยิม (ภาษาอังกฤษ)" value={form.name} onChange={v => set('name', v)} error={errors.name} required maxLength={120}/>
        <Field name="brand_name_th" label="ชื่อยิม (ภาษาไทย)" value={form.brand_name_th} onChange={v => set('brand_name_th', v)} error={errors.brand_name_th} maxLength={120}/>
        <Field name="address" label="ที่อยู่" value={form.address} onChange={v => set('address', v)} error={errors.address} maxLength={300}/>
        <Field name="location_note" label="หมายเหตุสถานที่" value={form.location_note} onChange={v => set('location_note', v)} error={errors.location_note} maxLength={200}/>
        <div className="row-2">
          <Field name="phone_primary" label="เบอร์โทรหลัก" value={form.phone_primary} onChange={v => set('phone_primary', v)} error={errors.phone_primary} type="tel"/>
          <Field name="phone_secondary" label="เบอร์โทรสำรอง" value={form.phone_secondary} onChange={v => set('phone_secondary', v)} error={errors.phone_secondary} type="tel"/>
        </div>
        <label className="field">เบอร์ที่แสดงในแอปสมาชิก
          <select aria-label="เบอร์ที่แสดงในแอปสมาชิก" value={form.phone_display} onChange={e => set('phone_display', e.target.value)}>
            <option value="primary">เบอร์หลัก</option><option value="secondary">เบอร์สำรอง</option><option value="hidden">ไม่แสดงเบอร์</option>
          </select></label>
        <Field name="hours_note" label="หมายเหตุเวลาเปิดทำการ (ภายใน)" value={form.hours_note} onChange={v => set('hours_note', v)} error={errors.hours_note} maxLength={200}/>
        <label className="check-row"><input type="checkbox" checked={form.hours_confirmed} onChange={e => set('hours_confirmed', e.target.checked)}/>
          <span>ยืนยันเวลาเปิดทำการแล้ว (เอาคำเตือนออกจากแอปสมาชิก)</span></label>
        <h3 style={{ marginTop: 20 }}>การชำระเงิน</h3>
        <Field name="payment_sla_text" label="ข้อความแจ้งสมาชิกว่าจะตรวจสลิปเมื่อไร" value={form.payment_sla_text}
          onChange={v => set('payment_sla_text', v)} error={errors.payment_sla_text} required maxLength={200}/>
        <Field name="order_ttl_minutes" label="เวลาที่ให้ชำระเงินต่อคำสั่งซื้อ (นาที)" value={form.order_ttl_minutes}
          onChange={v => set('order_ttl_minutes', v)} error={errors.order_ttl_minutes} type="number" min={5} max={1440}/>
        <h3 style={{ marginTop: 20 }}>การเช็คอิน</h3>
        <Field name="check_in_token_seconds" label="อายุ QR เช็คอิน (วินาที)" value={form.check_in_token_seconds}
          onChange={v => set('check_in_token_seconds', v)} error={errors.check_in_token_seconds} type="number" min={15} max={600}/>
        <Field name="check_in_window_minutes" label="สแกนซ้ำภายในกี่นาทีถือเป็นครั้งเดียวกัน" value={form.check_in_window_minutes}
          onChange={v => set('check_in_window_minutes', v)} error={errors.check_in_window_minutes} type="number" min={1} max={720}/>
        <p className="fine">QR ยิ่งอายุสั้นยิ่งแชร์กันยาก แต่ต้องพอให้สมาชิกเดินจากประตูถึงเคาน์เตอร์</p>
        <p className="fine">บัญชี PromptPay ที่รับเงินตั้งค่าที่ตัวแปร PROMPTPAY_ID ตอน deploy ไม่ได้เก็บไว้ในหน้านี้หรือในโค้ด</p>
        <div className="actions"><button className="primary" disabled={saving}>{saving ? 'กำลังบันทึก…' : 'บันทึกข้อมูลยิม'}</button></div>
      </form></section>

    <section className="card"><h2>เวลาเปิดทำการ</h2>
      {hours.map(day => <div className="hours-grid" key={day.weekday}>
        <strong>{day.label}</strong>
        <label className="check-row" style={{ margin: 0 }}><input type="checkbox" checked={day.closed}
          onChange={e => setDay(day.weekday, { closed: e.target.checked })} aria-label={`ปิดวัน${day.label}`}/><span>ปิด</span></label>
        <input type="time" value={day.open_time ?? ''} disabled={day.closed} aria-label={`เวลาเปิดวัน${day.label}`}
          onChange={e => setDay(day.weekday, { open_time: e.target.value })}/>
        <input type="time" value={day.close_time ?? ''} disabled={day.closed} aria-label={`เวลาปิดวัน${day.label}`}
          onChange={e => setDay(day.weekday, { close_time: e.target.value })}/>
      </div>)}
      <div className="actions"><button className="primary" onClick={saveHours} disabled={saving}>{saving ? 'กำลังบันทึก…' : 'บันทึกเวลาเปิดทำการ'}</button></div>
    </section>

    <section className="card"><h2>ยอดขายรายวัน</h2>
      <p className="muted">ใช้เทียบกับรายการเงินเข้าบัญชีจริง นับเฉพาะคำสั่งซื้อที่อนุมัติแล้ว</p>
      <SalesReport/></section></>;
}

// ------------------------------------------------------- admin: users/roles

const roleLabels = { admin: 'ผู้ดูแลระบบ', staff: 'พนักงาน', member: 'สมาชิก' };

/**
 * Who may sign in, and what they may do. Separate from the members screen:
 * that one is about people who train here, this one is about access. Without
 * it a freshly installed gym had one account and no way to make a second, so
 * nobody could work the scanner.
 */
function UserAdmin({ onAuthError, signedInAs, onSignedOut }) {
  const [q, setQ] = useState(''), [page, setPage] = useState(1);
  const { data, error, busy, reload } = useResource(`/users?q=${encodeURIComponent(q)}&page=${page}`);
  const [email, setEmail] = useState(''), [role, setRole] = useState('staff');
  const [working, setWorking] = useState(false), [actionError, setActionError] = useState(null), [notice, setNotice] = useState('');

  /**
   * @param farewell shown on the login screen when the action just ended this
   *   admin's own session. Without it the console simply vanishes mid-click and
   *   the login page gives no reason (QA PM-17).
   */
  async function act(path, options, message, farewell) {
    setWorking(true); setActionError(null); setNotice('');
    try {
      await api(path, options);
      // Reloading the list would only 401 and report itself as an error.
      if (farewell) return onSignedOut(farewell);
      setNotice(message);
      await reload();
    } catch (e) { setActionError(e); onAuthError(e); } finally { setWorking(false); }
  }
  /** Changing your own role or suspending yourself ends your session server-side. */
  const endsMyOwnSession = user => user.email === signedInAs;
  const invite = () => act('/users', { method: 'POST', body: { email, role } }, 'สร้างบัญชีแล้ว')
    .then(() => setEmail(''));

  return <>
    <div className="page-heading"><div><span className="eyebrow">ผู้ใช้และสิทธิ์</span><h1>บัญชีผู้ใช้</h1>
      <p className="muted">ใครเข้าระบบได้บ้าง และเข้าได้ในฐานะอะไร</p></div></div>
    {notice && <div className="notice" role="status">{notice}</div>}

    <section className="card"><h2>เพิ่มบัญชีพนักงานหรือผู้ดูแลระบบ</h2>
      <p className="muted">ไม่มีรหัสผ่านให้ตั้ง เจ้าของอีเมลนี้จะเข้าระบบด้วยรหัสที่ส่งไปเหมือนทุกบัญชี
        ส่วนสมาชิกให้สมัครเองในแอปหรือเพิ่มที่หน้าสมาชิก</p>
      <div className="search-row">
        <Field name="new-user-email" label="อีเมล" type="email" value={email} onChange={setEmail}
          placeholder="staff@example.com" error={actionError?.fields?.email}/>
        <label className="field">สิทธิ์
          <select aria-label="สิทธิ์ของบัญชีใหม่" value={role} onChange={e => setRole(e.target.value)}>
            <option value="staff">พนักงาน — สแกนเช็คอินและดูประวัติ</option>
            <option value="admin">ผู้ดูแลระบบ — จัดการทุกอย่าง</option>
          </select></label>
      </div>
      <Notice error={actionError}/>
      <button className="primary" disabled={!email.trim() || working} onClick={invite}>
        {working ? 'กำลังบันทึก…' : 'สร้างบัญชี'}</button>
    </section>

    <section className="card">
      <div className="search-row">
        <Field name="user-search" label="ค้นหาบัญชี" type="search" value={q} onChange={v => { setQ(v); setPage(1); }}
          placeholder="อีเมล หรือชื่อสมาชิก" maxLength={120}/>
        <span className="muted">{data ? `${data.total.toLocaleString('th-TH')} บัญชี · ผู้ดูแลระบบที่ใช้งานได้ ${data.admins} คน` : ''}</span>
      </div>
      <Notice error={error}/>{error && <button onClick={() => reload().catch(() => {})}>ลองใหม่</button>}
      {busy ? <p role="status" className="empty">กำลังโหลด…</p> : !error && (
        !data.items.length ? <p className="muted">ไม่พบบัญชีที่ค้นหา</p>
          : <div className="table-wrap"><table className="table table-users">
            <thead><tr><th>บัญชี</th><th>สถานะ</th><th>สิทธิ์</th><th/></tr></thead>
            <tbody>{data.items.map(user => <tr key={user.id}>
              <td data-label=""><span className="person">
                <span><span className="person-name">{user.email}</span>
                  {user.member_name && <span className="person-meta">{user.member_name}</span>}</span></span></td>
              <td data-label="สถานะ"><span className={`badge ${user.status === 'suspended' ? 'suspended' : 'active'}`}>
                {user.status === 'suspended' ? 'ถูกระงับ' : 'ใช้งานได้'}</span></td>
              <td data-label="สิทธิ์"><label className="field inline-field">เปลี่ยนสิทธิ์
                <select aria-label={`สิทธิ์ของ ${user.email}`} value={user.role} disabled={working}
                  onChange={e => act(`/users/${user.id}/role`, { method: 'PUT', body: { role: e.target.value } },
                    `เปลี่ยนสิทธิ์ของ ${user.email} แล้ว`,
                    endsMyOwnSession(user) && e.target.value !== user.role
                      ? 'เปลี่ยนสิทธิ์ของบัญชีคุณแล้ว ออกจากระบบ' : undefined)}>
                  {Object.entries(roleLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                </select></label></td>
              <td className="cell-actions"><span className="actions">
                <button className={user.status === 'suspended' ? 'sm' : 'sm danger'} disabled={working}
                  aria-label={`${user.status === 'suspended' ? 'คืนสิทธิ์' : 'ระงับ'}บัญชี ${user.email}`}
                  onClick={() => act(`/users/${user.id}/${user.status === 'suspended' ? 'restore' : 'suspend'}`,
                    { method: 'POST', body: {} },
                    `${user.status === 'suspended' ? 'คืนสิทธิ์' : 'ระงับ'}บัญชี ${user.email} แล้ว`,
                    endsMyOwnSession(user) && user.status !== 'suspended'
                      ? 'ระงับบัญชีของคุณแล้ว ออกจากระบบ' : undefined)}>
                  {user.status === 'suspended' ? 'คืนสิทธิ์' : 'ระงับบัญชี'}</button></span></td>
            </tr>)}</tbody>
          </table></div>)}
      <div className="pagination"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>ก่อนหน้า</button>
        <span>หน้า {page} / {Math.max(1, Math.ceil((data?.total || 0) / 20))}</span>
        <button disabled={page * 20 >= (data?.total || 0)} onClick={() => setPage(page + 1)}>ถัดไป</button></div>
    </section>
    <p className="fine">ระงับบัญชีคือห้ามเข้าสู่ระบบ ไม่ใช่การระงับสมาชิกภาพ — สถานะสมาชิกแก้ที่หน้า “สมาชิก”
      ระบบไม่ยอมให้ลดสิทธิ์หรือระงับจนไม่เหลือผู้ดูแลระบบที่ใช้งานได้เลย</p>
  </>;
}

/**
 * The staff and admin frame: a sidebar on a desktop, a bottom bar on a phone,
 * from one piece of markup. The old build put the menu in a wrapping row of
 * pill buttons above the content, which on a wide screen left the page with no
 * structure at all -- everything floated at the top left and nothing lined up.
 */
function SideNav({ label, tabs, tab, setTab }) {
  return <nav className="sidenav" aria-label={label}>{tabs.map(([key, text, icon]) =>
    <button key={key} onClick={() => setTab(key)} aria-current={tab === key ? 'page' : undefined}>
      <Icon name={icon}/>{text}</button>)}</nav>;
}

function Console({ nav, notice, children }) {
  const pilot = usePilot();
  return <main className="app-main"><div className="container with-sidebar">
    {nav}
    <div>{pilot && <PilotBanner/>}{notice}{children}</div>
  </div></main>;
}

function Staff({ onAuthError, notice }) {
  const pilot = usePilot();
  const [tab, setTab] = useState('scan');
  // No payments in pilot mode, so no queue of slips to look at.
  const tabs = [['scan', 'สแกนเช็คอิน', 'scan'], ['history', 'ประวัติเช็คอิน', 'clock'],
    ...(pilot ? [] : [['queue', 'คิวสลิป', 'slip']])];
  return <Console nav={<SideNav label="เมนูพนักงาน" tabs={tabs} tab={tab} setTab={setTab}/>} notice={notice}>
    {tab === 'scan' && <StaffScanner/>}
    {tab === 'history' && <CheckInLog/>}
    {tab === 'queue' && <PaymentReview onAuthError={onAuthError} readOnly/>}
  </Console>;
}

function Admin({ onAuthError, signedInAs, onSignedOut, notice }) {
  const pilot = usePilot();
  const [tab, setTab] = useState('members');
  // The slip queue is replaced by the list of OTP codes, because in pilot mode
  // reading a code out is the job that actually happens at the counter.
  const tabs = [['members', 'สมาชิก', 'users'], ['users', 'ผู้ใช้และสิทธิ์', 'shield'],
    ...(pilot ? [['codes', 'รหัส OTP', 'key']] : [['review', 'ตรวจสลิป', 'slip']]),
    ['scan', 'สแกนเช็คอิน', 'scan'], ['checkin', 'เช็คอิน', 'clock'],
    ['packages', 'แพ็กเกจ', 'box'], ['gym', 'ข้อมูลยิม', 'gear']];
  return <Console nav={<SideNav label="เมนูผู้ดูแลระบบ" tabs={tabs} tab={tab} setTab={setTab}/>} notice={notice}>
    {tab === 'members' && <MemberAdmin onAuthError={onAuthError}/>}
    {tab === 'users' && <UserAdmin onAuthError={onAuthError} signedInAs={signedInAs} onSignedOut={onSignedOut}/>}
    {/* The same counter screen staff get: on a small gym the owner is often the
        one at the desk, and until now they had no way to scan anybody in. */}
    {tab === 'scan' && <StaffScanner/>}
    {tab === 'codes' && <PilotOtpBoard/>}
    {tab === 'review' && <PaymentReview onAuthError={onAuthError}/>}
    {tab === 'checkin' && <><div className="page-heading"><div><span className="eyebrow">เช็คอิน</span>
      <h1>การเข้าใช้บริการ</h1><p className="muted">ดูว่าใครเข้ายิมเมื่อไร และใครถูกปฏิเสธเพราะอะไร</p></div></div>
      <CheckInLog/>
      <section className="card"><h2>สรุปรายวัน</h2><CheckInSummary/></section></>}
    {tab === 'packages' && <PackageAdmin onAuthError={onAuthError}/>}
    {tab === 'gym' && <GymSettings onAuthError={onAuthError}/>}
  </Console>;
}

/** Always on screen while piloting, so nobody mistakes this for the real thing. */
function PilotBanner() {
  return <div className="pilot-banner" role="status">
    <strong>โหมดทดลอง</strong>
    <span>ยังไม่ส่งอีเมลและยังไม่รับชำระเงิน — รหัสเข้าใช้งานดูได้ในแท็บ “รหัส OTP”
      และมอบแพ็กเกจให้สมาชิกได้จากหน้าสมาชิกรายคน</span>
  </div>;
}

function App() {
  const [user, setUser] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState(null);
  const [gym, setGym] = useState(null), [pilot, setPilot] = useState(false), [farewell, setFarewell] = useState('');
  async function refresh() { const result = await api('/me'); setUser(result); return result; }
  const onAuthError = e => { if (e.status === 401) setUser(null); };
  useEffect(() => { refresh().catch(e => { if (e.status !== 401) setError(e); }).finally(() => setLoading(false)); }, []);
  // Read before anyone signs in: the login screen is one of the screens that
  // changes, and it is the first thing a member sees.
  useEffect(() => { api('/public/config').then(config => setPilot(!!config.pilot_mode)).catch(() => setPilot(false)); }, []);
  // Gym facts are shown on several member screens; load them once per session.
  // The public name comes from the open endpoint, so the header carries the
  // gym's own name before anybody has signed in rather than a placeholder.
  useEffect(() => { if (user) api('/gym').then(setGym).catch(() => setGym(null)); }, [user]);
  useEffect(() => { api('/public/gym').then(setGym).catch(() => setGym(null)); }, []);
  const logout = async () => { try { await api('/auth/logout', { method: 'POST' }); setUser(null); } catch(e) { setError(e); onAuthError(e); } };
  if (loading) return <main className="empty" role="status">กำลังเปิดยิมของเรา…</main>;
  const brand = gym?.profile?.brand_name_th || gym?.profile?.name || 'ยิมของเรา';
  /** The same bar on every screen; what sits on the right of it changes. */
  const appHeader = actions => <header className="app-header"><div className="container">
    <span className="brand">
      <span className="brand-symbol" aria-hidden="true">SF</span>
      <span><span className="brand-name">{brand}</span>
        {gym?.profile?.name && gym.profile.name !== brand && <span className="brand-sub">{gym.profile.name}</span>}</span>
    </span>
    {actions}
  </div></header>;
  const shell = (children, header = null) => <PilotContext.Provider value={pilot}>
    <div className="app">{header}{children}
      <footer className="app-footer"><div className="container">
        <span>{brand} · ทุกวันเป็นวันเริ่มต้นที่ดี</span>
        <span className="fine">ระบบจัดการสมาชิกและเช็คอิน</span>
      </div></footer>
    </div>
  </PilotContext.Provider>;

  if (!user) {
    return shell(<>
      {farewell && <main className="app-main"><div className="container">
        <div className="notice" role="status">{farewell}</div>
        <Notice error={error}/>
      </div></main>}
      <Login onLogin={u => { setError(null); setFarewell(''); setUser(u); }}/>
    </>, appHeader(null));
  }

  const notice = <Notice error={error}/>;
  // One header on every screen: who the gym is, who you are signed in as, and
  // the way out. The old build had none of it on the member side at all.
  const header = appHeader(<span className="header-actions">
    <span className="role-label">{user.role === 'admin' ? 'ผู้ดูแลระบบ' : user.role === 'staff' ? 'พนักงาน' : 'สมาชิก'}</span>
    <button className="sm" onClick={logout}><Icon name="out"/>ออกจากระบบ</button>
  </span>);

  return shell(user.role === 'admin'
    ? <Admin onAuthError={onAuthError} signedInAs={user.email} notice={notice}
        onSignedOut={message => { setFarewell(message); setError(null); setUser(null); }}/>
    : user.role === 'staff' ? <Staff onAuthError={onAuthError} notice={notice}/>
    : user.member ? <MemberApp member={user.member} gym={gym} onLogout={logout} notice={notice}
        refresh={async () => { try { await refresh(); } catch(e) { onAuthError(e); throw e; } }}/>
      : <Onboarding onSaved={refresh} notice={notice}/>, header);
}
createRoot(document.getElementById('root')).render(<App/>);
