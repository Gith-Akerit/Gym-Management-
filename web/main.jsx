import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const labels = { active: 'ใช้งานอยู่', suspended: 'ถูกระงับ', expired: 'หมดอายุ' };
const blank = { name: '', email: '', phone: '', date_of_birth: '', emergency_contact: '', status: 'active' };
const formatDate = value => new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' }).format(new Date(value));
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { ...options, credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-Gym-Client': 'web' },
    body: options.body ? JSON.stringify(options.body) : undefined });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) { const error = new Error(data.error || 'ระบบขัดข้อง'); error.fields = data.fields; error.status = response.status; throw error; }
  return data;
}
function Field({ label, name, value, onChange, error, ...props }) {
  return <label className="field">{label}<input name={name} value={value ?? ''} onChange={e => onChange(e.target.value)}
    aria-invalid={!!error} aria-describedby={error ? `${name}-error` : undefined} {...props}/>
    {error && <span className="field-error" id={`${name}-error`}>{error}</span>}</label>;
}
function Notice({ error }) { return error && <div className="notice error" role="alert">{error.message || error}</div>; }
function ProfileFields({ value, setValue, errors = {}, includeEmail = false }) {
  const field = (name, label, props = {}) => <Field key={name} name={name} label={label} value={value[name]}
    onChange={v => setValue({ ...value, [name]: v })} error={errors[name]} {...props}/>;
  return <>
    {field('name', 'ชื่อ–นามสกุล', { required: true, maxLength: 120, autoComplete: 'name' })}
    {includeEmail && field('email', 'อีเมล', { required: true, type: 'email', autoComplete: 'email' })}
    {field('phone', 'เบอร์มือถือ', { required: true, type: 'tel', autoComplete: 'tel', placeholder: '08x xxx xxxx' })}
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
      {challenge && <div className="login-actions"><button disabled={busy || remaining > 0} onClick={request}>{remaining ? `ส่งรหัสใหม่ได้ใน ${remaining} วินาที` : 'ส่งรหัสใหม่'}</button>
        <button disabled={busy} onClick={() => { setChallenge(null); setError(null); }}>เปลี่ยนอีเมล</button></div>}
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
function MemberProfile({ member, refresh }) {
  const [error, setError] = useState(null), [busy, setBusy] = useState(false);
  return <div className="profile-layout"><section className="member-card"><span className="eyebrow">บัตรสมาชิกของคุณ</span><div className="avatar" aria-hidden="true">{member.name.slice(0, 1)}</div>
    <h1>{member.name}</h1><p className="member-code">{member.member_code}</p><span className={`badge ${member.status}`}>{labels[member.status]}</span>
    <p className="card-foot">เป็นสมาชิกตั้งแต่ {formatDate(member.joined_at)}</p></section>
    <section className="card"><h2>ข้อมูลของฉัน</h2><dl><dt>อีเมล</dt><dd>{member.email}</dd><dt>เบอร์มือถือ</dt><dd>{member.phone}</dd>
      {member.date_of_birth && <><dt>วันเกิด</dt><dd>{formatDate(member.date_of_birth)}</dd></>}
      {member.emergency_contact && <><dt>ผู้ติดต่อฉุกเฉิน</dt><dd>{member.emergency_contact}</dd></>}</dl>
      {member.status !== 'active' && <div className="notice">{member.status === 'suspended' ? 'บัญชีสมาชิกถูกระงับ กรุณาติดต่อพนักงานที่ยิม' : 'สถานะสมาชิกหมดอายุ กรุณาติดต่อพนักงานที่ยิม'}</div>}
      <p className="muted">หากต้องการแก้ไขข้อมูล กรุณาติดต่อพนักงาน</p><Notice error={error}/>
      <button disabled={busy} onClick={async () => { setBusy(true); setError(null); try { await refresh(); } catch(e) { setError(e); } finally { setBusy(false); } }}>{busy ? 'กำลังโหลด…' : 'รีเฟรชข้อมูล'}</button>
    </section></div>;
}
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
      <label className="field">สถานะสมาชิก<select value={value.status} onChange={e => setValue({ ...value, status: e.target.value })}>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <Notice error={error}/><div className="actions"><button className="primary" disabled={busy}>{busy ? 'กำลังบันทึก…' : 'บันทึกสมาชิก'}</button><button type="button" onClick={onCancel} disabled={busy}>ยกเลิก</button></div>
    </form>
    {member && <div className="secondary-actions"><button className="danger" onClick={deactivate} disabled={busy || member.status === 'suspended'}>ระงับสมาชิก</button>
      <button disabled={busy} onClick={async () => { try { setAudit(await api(`/members/${member.id}/audit`)); } catch(e) { setError(e); onAuthError(e); } }}>ดูประวัติการแก้ไข</button></div>}
    {audit && <section className="audit"><h2>ประวัติการแก้ไข</h2>{audit.items.map(item => <div key={item.id}><strong>{{ 'member.create': 'สร้างสมาชิก', 'member.update': 'แก้ไขข้อมูล', 'member.deactivate': 'ระงับสมาชิก' }[item.action]}</strong><span className="muted"> · {formatDate(item.created_at)}</span>
      <p className="fine">ผู้ดำเนินการ: {item.actor_id}</p></div>)}</section>}
  </section>;
}
function Admin({ onAuthError }) {
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
    onSaved={message => { setEditor(null); setNotice(message); setRevision(n => n + 1); }}/ >;
  return <><div className="page-heading"><div><span className="eyebrow">ดูแลสมาชิก</span><h1>สมาชิกทั้งหมด</h1><p className="muted">ค้นหาและจัดการข้อมูลสมาชิกในที่เดียว</p></div>
    <button className="primary" onClick={() => { setEditor({}); setNotice(''); }}>＋ เพิ่มสมาชิก</button></div>
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="card"><div className="search-row"><Field name="search" label="ค้นหาสมาชิก" type="search" value={q} onChange={v => { setQ(v); setPage(1); }} placeholder="ชื่อ เบอร์โทร อีเมล หรือรหัสสมาชิก" maxLength={120}/>
      <span className="muted">{data ? `${data.total.toLocaleString('th-TH')} คน` : ''}</span></div>
      <Notice error={error}/>{error && <button onClick={() => setRevision(n => n + 1)}>ลองใหม่</button>}
      {busy ? <p role="status" className="empty">กำลังโหลดสมาชิก…</p> : !error && <>
        {!data?.items.length ? <div className="empty"><h2>{q ? 'ไม่พบสมาชิกที่ค้นหา' : 'ยังไม่มีสมาชิก'}</h2><p className="muted">{q ? 'ลองค้นหาด้วยชื่อ เบอร์โทร หรืออีเมลอื่น' : 'เริ่มด้วยปุ่ม “เพิ่มสมาชิก” หรือให้สมาชิกสมัครผ่านแอป'}</p></div>
          : <div className="member-list">{data.items.map(member => <button key={member.id} className="member-row" onClick={() => { setEditor(member); setNotice(''); }} aria-label={`แก้ไข ${member.name}`}>
            <span className="list-avatar" aria-hidden="true">{member.name.slice(0, 1)}</span><span className="member-name"><strong>{member.name}</strong><small>{member.member_code} · {member.phone}</small></span><span className={`badge ${member.status}`}>{labels[member.status]}</span><span aria-hidden="true">›</span>
          </button>)}</div>}
        <div className="pagination"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>ก่อนหน้า</button><span>หน้า {page} / {Math.max(1, Math.ceil((data?.total || 0) / 20))}</span><button disabled={page * 20 >= (data?.total || 0)} onClick={() => setPage(page + 1)}>ถัดไป</button></div>
      </>}
    </section></>;
}
function App() {
  const [user, setUser] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState(null);
  async function refresh() { const result = await api('/me'); setUser(result); return result; }
  const onAuthError = e => { if (e.status === 401) setUser(null); };
  useEffect(() => { refresh().catch(e => { if (e.status !== 401) setError(e); }).finally(() => setLoading(false)); }, []);
  if (loading) return <main className="empty" role="status">กำลังเปิดยิมของเรา…</main>;
  if (!user) return <><Notice error={error}/><Login onLogin={u => { setError(null); setUser(u); }}/></>;
  return <><header><div className="brand"><span className="brand-symbol">G</span><strong>ยิมของเรา</strong><span className="role-label">{user.role === 'admin' ? 'ผู้ดูแลระบบ' : user.role === 'staff' ? 'พนักงาน' : 'สมาชิก'}</span></div>
    <button onClick={async () => { try { await api('/auth/logout', { method: 'POST' }); setUser(null); } catch(e) { setError(e); onAuthError(e); } }}>ออกจากระบบ</button></header>
    <main><Notice error={error}/>{user.role === 'admin' ? <Admin onAuthError={onAuthError}/> : user.role === 'staff' ? <section className="card"><h1>บัญชีพนักงาน</h1><p>เข้าสู่ระบบแล้ว สิทธิ์จัดการสมาชิกสงวนไว้สำหรับผู้ดูแลระบบ</p></section>
      : user.member ? <MemberProfile member={user.member} refresh={async () => { try { await refresh(); } catch(e) { onAuthError(e); throw e; } }}/>
        : <Onboarding onSaved={refresh}/>}</main><footer>ยิมของเรา · ทุกวันเป็นวันเริ่มต้นที่ดี</footer></>;
}
createRoot(document.getElementById('root')).render(<App/>);
