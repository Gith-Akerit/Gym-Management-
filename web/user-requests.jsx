import { useState } from 'react';
import { api, Field, formatDateTime, formatPhone, initials } from './shared.jsx';

/**
 * People waiting to be let in.
 *
 * A warning-coloured box at the very top of "ผู้ใช้และสิทธิ์", above everything
 * else on the screen, because on the other end of it somebody cannot start
 * work until this is pressed. When nothing is waiting the box is absent
 * rather than an empty heading -- the owner opens this screen for other
 * reasons most days.
 *
 * The two buttons say the role out loud ("อนุมัติเป็น พนักงาน / ผู้ดูแลระบบ")
 * instead of a dropdown beside one "อนุมัติ": the role IS the decision, and a
 * dropdown left on its default is how somebody ends up an administrator by
 * accident.
 *
 * Nobody can be approved before their address has answered. A request the
 * owner cannot act on yet says why, and offers the one thing that helps --
 * send the letter again.
 */
export function PendingRequests({ list, working, onAuthError, onDone }) {
  const [refusing, setRefusing] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const [resent, setResent] = useState({});

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

  async function resend(person) {
    setBusy(true); setFailure(null);
    try {
      await api(`/users/${person.id}/resend-verify`, { method: 'POST', body: {} });
      setResent(current => ({ ...current, [person.id]: true }));
    } catch (error) { setFailure(error); onAuthError(error); } finally { setBusy(false); }
  }

  return <div className="queue">
    <h2><span aria-hidden="true">⏳</span>รออนุมัติ {items.length} คำขอ</h2>
    {/* The only sentence on this screen that can prevent a stranger getting a
        key to the till, so it is the one directly under the heading. */}
    <p className="note"><b>อนุมัติเฉพาะคนที่รู้จักตัวจริง</b> — ใครก็กรอกฟอร์มขอบัญชีได้
      ถ้าไม่แน่ใจว่าเป็นใคร โทรถามก่อนแล้วค่อยกด</p>
    {failure && <div className="alert err" role="alert">
      <div className="ic" aria-hidden="true">✕</div><div><b>{failure.message}</b></div></div>}

    {items.map(person => {
      const who = person.name || person.email;
      const verified = !!person.email_verified_at;
      return <div key={person.id} className="qitem">
        <div className="av" aria-hidden="true">{initials(who)}</div>
        <div className="who">
          <b>{who}</b>
          <div className="m">{person.email}
            {person.phone ? ` · ${formatPhone(person.phone)}` : ''}</div>
          <div className="m">{person.requested_at ? `ขอเมื่อ ${formatDateTime(person.requested_at)}` : ''}</div>
        </div>

        {refusing === person.id
          ? <div style={{ flex: '1 1 100%' }}>
              <Field name={`reject-${person.id}`} label={`เหตุผลที่ปฏิเสธ ${who}`}
                value={reason} onChange={setReason} maxLength={300}
                hint="ข้อความนี้ถูกส่งไปที่อีเมลของผู้สมัคร"/>
              <div className="acts">
                <button className="btn danger" disabled={busy || !reason.trim()}
                  onClick={() => act(`/users/${person.id}/reject`, { reason: reason.trim() }, 'ปฏิเสธคำขอแล้ว')}>
                  ยืนยันการปฏิเสธ</button>
                <button className="btn" disabled={busy}
                  onClick={() => { setRefusing(null); setReason(''); }}>ยกเลิก</button>
              </div>
            </div>
          : <>
              {!verified && <p className="waitnote">
                <b>ยังยืนยันอีเมลไม่สำเร็จ</b> — อนุมัติไม่ได้จนกว่าเจ้าตัวจะกดลิงก์ในอีเมล
                ถ้าเขาบอกว่าไม่ได้รับ ให้ส่งใหม่อีกครั้ง
                {resent[person.id] && <span> · <b>ส่งอีเมลยืนยันใหม่แล้ว</b></span>}</p>}
              <div className="acts">
                <button className="btn primary" disabled={busy || working || !verified}
                  aria-disabled={!verified || undefined}
                  title={verified ? undefined : 'ยังยืนยันอีเมลไม่สำเร็จ'}
                  onClick={() => act(`/users/${person.id}/approve`, { role: 'staff' }, `อนุมัติ ${who} เป็นพนักงานแล้ว`)}>
                  อนุมัติเป็น พนักงาน</button>
                <button className="btn" disabled={busy || working || !verified}
                  aria-disabled={!verified || undefined}
                  title={verified ? undefined : 'ยังยืนยันอีเมลไม่สำเร็จ'}
                  onClick={() => act(`/users/${person.id}/approve`, { role: 'admin' }, `อนุมัติ ${who} เป็นผู้ดูแลระบบแล้ว`)}>
                  อนุมัติเป็น ผู้ดูแลระบบ</button>
                {!verified && <button className="btn" disabled={busy}
                  onClick={() => resend(person)}>ส่งอีเมลยืนยันอีกครั้ง</button>}
                <button className="btn danger" disabled={busy || working}
                  onClick={() => { setRefusing(person.id); setReason(''); }}>ปฏิเสธ</button>
              </div>
            </>}
      </div>;
    })}
  </div>;
}
