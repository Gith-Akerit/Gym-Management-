import { useState } from 'react';
import { api, Field, formatDateTime, formatPhone } from './shared.jsx';

/**
 * People waiting to be let in.
 *
 * Drawn above the form for adding somebody by hand, because a request that is
 * already waiting is more urgent than one the owner has not made yet -- and
 * because on the other end of it somebody cannot start work until this is
 * pressed. When there is nothing waiting the whole block is absent rather than
 * an empty heading: the owner opens this screen for other reasons most days.
 *
 * Approving is where the role is chosen, so the decision and the permission
 * are one action rather than two that can be half done. Refusing needs a
 * reason because the reason is sent to the person -- "no" on its own produces
 * a telephone call the owner has to answer anyway.
 */
export function PendingRequests({ list, working, onAuthError, onDone }) {
  const [role, setRole] = useState({});
  const [refusing, setRefusing] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);

  const items = list.data?.items ?? [];
  if (!items.length) return null;

  async function act(path, body, message) {
    setBusy(true); setFailure(null);
    try {
      await api(path, { method: 'POST', body });
      setRefusing(null); setReason('');
      onDone(message);
    } catch (error) { setFailure(error); onAuthError(error); } finally { setBusy(false); }
  }

  return <div className="block" style={{ marginBottom: 'var(--sp-5)', borderColor: 'var(--brand-line)' }}>
    <h2>รออนุมัติ <span className="chip bad" style={{ marginLeft: 8 }}>{items.length} คำขอ</span></h2>
    <p className="note">คนที่กด “ขอเข้าใช้งาน” จากหน้าเข้าสู่ระบบ · ยังเข้าระบบไม่ได้จนกว่าจะอนุมัติ</p>
    {failure && <div className="alert err" role="alert">
      <div className="ic" aria-hidden="true">✕</div><div><b>{failure.message}</b></div></div>}

    <div className="stack">{items.map(person => {
      const who = person.name || person.email;
      return <div key={person.id} className="rep unread">
        <div className="body">
          <b>{who}</b>
          <div className="m">{person.email}
            {person.phone ? ` · ${formatPhone(person.phone)}` : ''}
            {person.requested_at ? ` · ขอเมื่อ ${formatDateTime(person.requested_at)}` : ''}</div>
        </div>

        {refusing === person.id
          ? <div style={{ flex: '1 1 320px', minWidth: 0 }}>
              <Field name={`reject-${person.id}`} label={`เหตุผลที่ปฏิเสธ ${who}`}
                value={reason} onChange={setReason} maxLength={300}
                hint="ข้อความนี้ถูกส่งไปที่อีเมลของผู้สมัคร"/>
              <div className="pvbtns">
                <button className="btn danger" disabled={busy || !reason.trim()}
                  onClick={() => act(`/users/${person.id}/reject`, { reason: reason.trim() }, 'ปฏิเสธคำขอแล้ว')}>
                  ยืนยันการปฏิเสธ</button>
                <button className="btn" disabled={busy}
                  onClick={() => { setRefusing(null); setReason(''); }}>ยกเลิก</button>
              </div>
            </div>
          : <>
              <Field name={`role-${person.id}`} label={`สิทธิ์ที่จะให้ ${who}`}
                value={role[person.id] ?? 'staff'}
                onChange={value => setRole(current => ({ ...current, [person.id]: value }))}>
                <select>
                  <option value="staff">พนักงาน</option>
                  <option value="admin">ผู้ดูแลระบบ</option>
                </select>
              </Field>
              <button className="btn primary" disabled={busy || working}
                onClick={() => act(`/users/${person.id}/approve`, { role: role[person.id] ?? 'staff' }, `อนุมัติ ${who} แล้ว`)}>
                อนุมัติ</button>
              <button className="btn" disabled={busy || working}
                onClick={() => { setRefusing(person.id); setReason(''); }}>ปฏิเสธ</button>
            </>}
      </div>;
    })}</div>
  </div>;
}
