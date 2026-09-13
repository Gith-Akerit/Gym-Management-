import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const labels = { active: 'ใช้งานอยู่', suspended: 'ถูกระงับ', expired: 'หมดอายุ' };
const packageStatusLabels = { draft: 'ร่าง ยังไม่เปิดขาย', active: 'เปิดขาย', archived: 'ปิดการขาย' };
const blank = { name: '', email: '', phone: '', date_of_birth: '', emergency_contact: '', status: 'active' };
const blankPackage = { code: '', name_th: '', type: 'unlimited', duration_days: 30, session_limit: '', price_satang: '', description: '', status: 'draft', sort_order: 0 };
const formatDate = value => new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' }).format(new Date(value));
const baht = new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB', minimumFractionDigits: 2 });
/** A null price means the gym has not published one yet — never render it as ฿0. */
const formatPrice = value => (value === null || value === undefined ? null : baht.format(value));
const formatPhone = value => (value ? value.replace(/^(0\d{1,2})(\d{3})(\d{3,4})$/, '$1-$2-$3') : null);

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { ...options, credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-Gym-Client': 'web' },
    body: options.body ? JSON.stringify(options.body) : undefined });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) { const error = new Error(data.error || 'ระบบขัดข้อง'); error.fields = data.fields; error.status = response.status; throw error; }
  return data;
}
function Field({ label, name, value, onChange, error, children, ...props }) {
  return <label className="field">{label}
    {children
      ? React.cloneElement(children, { name, value: value ?? '', onChange: e => onChange(e.target.value), 'aria-invalid': !!error })
      : <input name={name} value={value ?? ''} onChange={e => onChange(e.target.value)}
          aria-invalid={!!error} aria-describedby={error ? `${name}-error` : undefined} {...props}/>}
    {error && <span className="field-error" id={`${name}-error`}>{error}</span>}</label>;
}
function Notice({ error }) { return error && <div className="notice error" role="alert">{error.message || error}</div>; }

/** Loads a resource once, exposing the three states every screen has to render. */
function useResource(path, enabled = true) {
  const [state, setState] = useState({ data: null, error: null, busy: enabled });
  const reload = useCallback(async () => {
    setState(s => ({ ...s, busy: true, error: null }));
    try { const data = await api(path); setState({ data, error: null, busy: false }); return data; }
    catch (e) { setState({ data: null, error: e, busy: false }); throw e; }
  }, [path]);
  useEffect(() => { if (enabled) reload().catch(() => {}); }, [reload, enabled]);
  return { ...state, reload, setData: data => setState(s => ({ ...s, data })) };
}

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

function Login({ onLogin }) {
  const [email, setEmail] = useState(''), [challenge, setChallenge] = useState(null), [code, setCode] = useState('');
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
  return <div className="login-layout"><section className="welcome"><span className="eyebrow">ยิมของเรา</span>
    <h1>เริ่มต้นดูแลตัวเอง<br/>ได้ทุกวัน</h1><p>ข้อมูลสมาชิกของคุณ<br/>อยู่ใกล้แค่ปลายนิ้ว</p><div className="welcome-line"/>
    <span>เรียบง่าย พร้อมสำหรับวันของคุณ</span></section>
    <section className="card login-card"><div className="icon-mark" aria-hidden="true">G</div><h2>{challenge ? 'ยืนยันอีเมลของคุณ' : 'ยินดีต้อนรับ'}</h2>
      <p className="muted">{challenge ? `ส่งรหัส 6 หลักไปที่ ${email} แล้ว รหัสใช้ได้ 5 นาที` : 'เข้าสู่ระบบหรือสมัครสมาชิกด้วยอีเมล ไม่ต้องจำรหัสผ่าน'}</p>
      <form onSubmit={submit}>
        {!challenge ? <Field label="อีเมล" name="email" type="email" value={email} onChange={setEmail} required autoComplete="email" error={error?.fields?.email}/>
          : <Field label="รหัสยืนยัน 6 หลัก" name="code" value={code} onChange={setCode} required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" autoFocus/>}
        <Notice error={error}/><button className="primary full" disabled={busy}>{busy ? 'กำลังดำเนินการ…' : challenge ? 'ยืนยันและเข้าสู่ระบบ' : 'รับรหัสทางอีเมล'}</button>
      </form>
      {challenge && <><div className="login-actions"><button disabled={busy || remaining > 0} onClick={request}>{remaining ? `ส่งรหัสใหม่ได้ใน ${remaining} วินาที` : 'ส่งรหัสใหม่'}</button>
        <button disabled={busy} onClick={() => { setChallenge(null); setError(null); }}>เปลี่ยนอีเมล</button></div>
        <p className="fine">ไม่ได้รับอีเมล? ลองตรวจโฟลเดอร์จดหมายขยะ แล้วกดส่งรหัสใหม่ หากยังไม่ได้รับ กรุณาติดต่อพนักงานที่เคาน์เตอร์</p></>}
      <p className="fine">สมาชิกใหม่กรอกชื่อและเบอร์มือถือหลังยืนยันอีเมล</p>
    </section></div>;
}

function Onboarding({ onSaved }) {
  const [value, setValue] = useState({ name: '', phone: '', date_of_birth: '', emergency_contact: '' });
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  return <section className="card narrow"><span className="eyebrow">อีกนิดเดียว</span><h1>ทำความรู้จักกัน</h1><p className="muted">กรอกชื่อและเบอร์มือถือเพื่อสร้างบัตรสมาชิก</p>
    <form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(null); try { await api('/me/profile', { method: 'PUT', body: value }); await onSaved(); } catch(e) { setError(e); } finally { setBusy(false); } }}>
      <ProfileFields value={value} setValue={setValue} errors={error?.fields}/><Notice error={error}/><button className="primary full" disabled={busy}>{busy ? 'กำลังบันทึก…' : 'เริ่มใช้งาน'}</button>
    </form></section>;
}

// --------------------------------------------------------------- member app

function PackageSummary({ item }) {
  const price = formatPrice(item.price_thb);
  return <div className="pkg-card"><div className="pkg-head"><div>
    <h3>{item.name_th}</h3>
    <p className="muted">{item.type === 'unlimited'
      ? `เข้าได้ไม่จำกัดครั้ง ภายใน ${item.duration_days} วัน`
      : `เข้าได้ ${item.session_limit} ครั้ง ภายใน ${item.duration_days} วัน`}</p>
  </div><span className={price ? 'price' : 'price tbd'}>{price ?? 'รอประกาศราคา'}</span></div>
    {item.description && <p className="muted">{item.description}</p>}</div>;
}

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
      <div className="qr-frame" role="img" aria-label="ยังไม่เปิดใช้งานการเช็คอินด้วย QR"><span>QR เช็คอิน<br/>เปิดใช้งานในเฟสถัดไป</span></div>
      <p className="muted">ระบบเช็คอินด้วย QR ให้พนักงานสแกน อยู่ระหว่างพัฒนา ตอนนี้แจ้งชื่อหรือรหัสสมาชิกกับพนักงานที่เคาน์เตอร์ได้ตามปกติ</p>
    </section>
    <section className="card"><h2>แพ็กเกจปัจจุบัน</h2>
      <p className="muted">ระบบซื้อแพ็กเกจและบันทึกสิทธิ์จะเปิดใช้งานในเฟสถัดไป สอบถามสิทธิ์คงเหลือได้ที่เคาน์เตอร์</p></section>
    {gym?.profile && <p className="fine">{gym.profile.brand_name_th || gym.profile.name}{gym.profile.address ? ` · ${gym.profile.address}` : ''}</p>}
  </>;
}

function MemberPackages() {
  const { data, error, busy, reload } = useResource('/packages');
  if (busy) return <p role="status" className="empty">กำลังโหลดแพ็กเกจ…</p>;
  if (error) return <><Notice error={error}/><button onClick={() => reload().catch(() => {})}>ลองใหม่</button></>;
  if (!data.items.length) return <div className="empty"><h2>ยังไม่เปิดขายแพ็กเกจ</h2>
    <p>ยิมกำลังจัดเตรียมแพ็กเกจและราคา สอบถามได้ที่เคาน์เตอร์</p></div>;
  return <><h1>แพ็กเกจ</h1>
    {data.items.map(item => <PackageSummary key={item.id} item={item}/>)}
    <p className="fine">การสั่งซื้อผ่านแอปด้วย PromptPay จะเปิดใช้งานในเฟสถัดไป ตอนนี้ซื้อแพ็กเกจได้ที่เคาน์เตอร์</p></>;
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

function MemberAccount({ member, gym, refresh, onLogout }) {
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
    <GymInfo gym={gym}/>
  </>;
}

function MemberApp({ member, gym, refresh, onLogout }) {
  const [tab, setTab] = useState('home');
  const tabs = [['home', 'หน้าแรก'], ['packages', 'แพ็กเกจ'], ['account', 'บัญชี']];
  return <div className="member-shell">
    {tab === 'home' && <MemberHome member={member} gym={gym}/>}
    {tab === 'packages' && <MemberPackages/>}
    {tab === 'account' && <MemberAccount member={member} gym={gym} refresh={refresh} onLogout={onLogout}/>}
    <nav className="app-nav" aria-label="เมนูหลัก">{tabs.map(([key, label]) =>
      <button key={key} onClick={() => setTab(key)} aria-current={tab === key ? 'page' : undefined}>{label}</button>)}</nav>
  </div>;
}

// ---------------------------------------------------------------- admin: members

function MemberEditor({ member, onCancel, onSaved, onAuthError }) {
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
    <form onSubmit={save}><ProfileFields value={value} setValue={setValue} includeEmail errors={error?.fields}/>
      <label className="field">สถานะสมาชิก<select aria-label="สถานะสมาชิก" value={value.status} onChange={e => setValue({ ...value, status: e.target.value })}>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <Notice error={error}/><div className="actions"><button className="primary" disabled={busy}>{busy ? 'กำลังบันทึก…' : 'บันทึกสมาชิก'}</button><button type="button" onClick={onCancel} disabled={busy}>ยกเลิก</button></div>
    </form>
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
          : <div className="member-list">{data.items.map(member => <button key={member.id} className="member-row" onClick={() => { setEditor(member); setNotice(''); }} aria-label={`แก้ไข ${member.name}`}>
            <span className="list-avatar" aria-hidden="true">{member.name.slice(0, 1)}</span><span className="member-name"><strong>{member.name}</strong><small>{member.member_code} · {formatPhone(member.phone)}</small></span><span className={`badge ${member.status}`}>{labels[member.status]}</span><span aria-hidden="true">›</span>
          </button>)}</div>}
        <div className="pagination"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>ก่อนหน้า</button><span>หน้า {page} / {Math.max(1, Math.ceil((data?.total || 0) / 20))}</span><button disabled={page * 20 >= (data?.total || 0)} onClick={() => setPage(page + 1)}>ถัดไป</button></div>
      </>}
    </section></>;
}

// --------------------------------------------------------------- admin: packages

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
      price_satang: value.price_satang,
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
      <Field name="price_satang" label="ราคา (บาท) — เว้นว่างได้ถ้ายังไม่กำหนด" value={value.price_satang} onChange={v => set('price_satang', v)} error={errors.price_satang} type="number" min={0} step="0.01"/>
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

// ------------------------------------------------------------- admin: gym info

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
    </section></>;
}

function Admin({ onAuthError }) {
  const [tab, setTab] = useState('members');
  const tabs = [['members', 'สมาชิก'], ['packages', 'แพ็กเกจ'], ['gym', 'ข้อมูลยิม']];
  return <>
    <nav className="tabs" aria-label="เมนูผู้ดูแลระบบ">{tabs.map(([key, label]) =>
      <button key={key} onClick={() => setTab(key)} aria-current={tab === key ? 'page' : undefined}>{label}</button>)}</nav>
    {tab === 'members' && <MemberAdmin onAuthError={onAuthError}/>}
    {tab === 'packages' && <PackageAdmin onAuthError={onAuthError}/>}
    {tab === 'gym' && <GymSettings onAuthError={onAuthError}/>}
  </>;
}

function App() {
  const [user, setUser] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState(null);
  const [gym, setGym] = useState(null);
  async function refresh() { const result = await api('/me'); setUser(result); return result; }
  const onAuthError = e => { if (e.status === 401) setUser(null); };
  useEffect(() => { refresh().catch(e => { if (e.status !== 401) setError(e); }).finally(() => setLoading(false)); }, []);
  // Gym facts are shown on several member screens; load them once per session.
  useEffect(() => { if (user) api('/gym').then(setGym).catch(() => setGym(null)); else setGym(null); }, [user]);
  const logout = async () => { try { await api('/auth/logout', { method: 'POST' }); setUser(null); } catch(e) { setError(e); onAuthError(e); } };
  if (loading) return <main className="empty" role="status">กำลังเปิดยิมของเรา…</main>;
  if (!user) return <><Notice error={error}/><Login onLogin={u => { setError(null); setUser(u); }}/></>;
  const brand = gym?.profile?.brand_name_th || gym?.profile?.name || 'ยิมของเรา';
  return <><header><div className="brand"><span className="brand-symbol" aria-hidden="true">G</span><strong>{brand}</strong>
    <span className="role-label">{user.role === 'admin' ? 'ผู้ดูแลระบบ' : user.role === 'staff' ? 'พนักงาน' : 'สมาชิก'}</span></div>
    <button onClick={logout}>ออกจากระบบ</button></header>
    <main><Notice error={error}/>{user.role === 'admin' ? <Admin onAuthError={onAuthError}/>
      : user.role === 'staff' ? <section className="card"><h1>บัญชีพนักงาน</h1><p>เข้าสู่ระบบแล้ว สิทธิ์จัดการสมาชิกสงวนไว้สำหรับผู้ดูแลระบบ</p>
        <p className="muted">หน้าสแกน QR เช็คอินสำหรับพนักงานจะเปิดใช้งานในเฟสถัดไป</p></section>
      : user.member ? <MemberApp member={user.member} gym={gym} onLogout={logout}
          refresh={async () => { try { await refresh(); } catch(e) { onAuthError(e); throw e; } }}/>
        : <Onboarding onSaved={refresh}/>}</main>
    <footer>{brand} · ทุกวันเป็นวันเริ่มต้นที่ดี</footer></>;
}
createRoot(document.getElementById('root')).render(<App/>);
