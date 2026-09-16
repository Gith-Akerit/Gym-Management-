import { useState } from 'react';
import { api, Field } from './shared.jsx';

/**
 * Asking for an account, from the screen everybody lands on.
 *
 * Until now an account existed because the owner made one and read a password
 * out loud. This is the other direction: the person asks, and the owner
 * decides. Nothing here grants anything -- the form's whole job is to collect
 * enough for somebody to recognise who is asking.
 *
 * The reply is the same sentence whether or not that address already has an
 * account, because otherwise this form answers "which addresses belong to this
 * gym?" for anybody who types one in.
 *
 * Built from the components the rest of the app already uses. The Designer's
 * spec for this screen is still on its way; when it lands this is re-skinned,
 * and the flow underneath does not change.
 */
export function SignUpRequest({ onCancel }) {
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const [sent, setSent] = useState(false);
  const set = key => value => setForm(current => ({ ...current, [key]: value }));

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setFailure(null);
    try { await api('/auth/signup', { method: 'POST', body: form }); setSent(true); }
    catch (error) { setFailure(error); } finally { setBusy(false); }
  }

  if (sent) {
    return <div className="block">
      <div className="banner ok" role="status">
        <div className="ic" aria-hidden="true">✓</div>
        <div><b>ส่งคำขอแล้ว</b>
          <span>เจ้าของยิมจะอนุมัติและกำหนดสิทธิ์ให้</span></div>
      </div>
      {/* Said plainly: the person is going to try signing in in a minute and
          should know now that it will not work yet. */}
      <p className="note">เมื่ออนุมัติแล้วจะมีอีเมลแจ้งไปที่ <b>{form.email}</b> แล้วเข้าสู่ระบบด้วยรหัสผ่านที่ตั้งไว้ได้ทันที
        · ระหว่างนี้ยังเข้าใช้งานไม่ได้ ถ้ารอนานผิดปกติ ติดต่อเจ้าของยิมได้โดยตรง</p>
      <button className="btn primary xl" onClick={onCancel}>กลับไปหน้าเข้าสู่ระบบ</button>
    </div>;
  }

  return <form className="block" onSubmit={submit}>
    <Field label="ชื่อ–นามสกุล" name="signup-name" value={form.name} onChange={set('name')}
      required maxLength={120} disabled={busy} error={failure?.fields?.name}
      hint="เจ้าของยิมใช้ชื่อนี้ดูว่าใครเป็นคนขอ"/>
    <Field label="อีเมล" name="signup-email" type="email" value={form.email} onChange={set('email')}
      required autoComplete="username" disabled={busy} error={failure?.fields?.email}/>
    <Field label="เบอร์มือถือ" name="signup-phone" type="tel" value={form.phone} onChange={set('phone')}
      required disabled={busy} error={failure?.fields?.phone} placeholder="08xxxxxxxx"/>
    <Field label="ตั้งรหัสผ่าน" name="signup-password" type="password" value={form.password} onChange={set('password')}
      required autoComplete="new-password" disabled={busy} error={failure?.fields?.password}
      hint="อย่างน้อย 12 ตัวอักษร · ใช้รหัสนี้เข้าสู่ระบบทันทีที่ได้รับอนุมัติ"/>

    {failure && !failure.fields && <div className="alert err" role="alert">
      <div className="ic" aria-hidden="true">✕</div><div><b>{failure.message}</b></div></div>}

    <button className="btn primary xl" disabled={busy} aria-disabled={busy || undefined}>
      {busy ? <><span className="spin"/>กำลังส่งคำขอ…</> : 'ส่งคำขอเข้าใช้งาน'}</button>
    <button className="btn" type="button" onClick={onCancel} disabled={busy}
      style={{ marginTop: 'var(--sp-3)' }}>ยกเลิก</button>
    <p className="note" style={{ margin: 'var(--sp-4) 0 0', fontSize: 'var(--fs-14)' }}>
      บัญชีนี้สำหรับพนักงานและเจ้าของยิม ไม่ใช่สำหรับสมาชิกที่มาออกกำลังกาย —
      สมาชิกใช้บัตรที่ได้รับตอนสมัคร ไม่ต้องมีบัญชี</p>
  </form>;
}
