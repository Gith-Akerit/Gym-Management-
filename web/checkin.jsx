import React, { useEffect, useRef, useState } from 'react';
import { Field, formatDateTime, Loading, Notice, StateBox, useResource } from './shared.jsx';
import { CameraScanner } from './camera.jsx';

const resultLabels = { allowed: 'เข้าใช้บริการได้', duplicate: 'เช็คอินไปแล้ว', denied: 'เข้าใช้บริการไม่ได้' };

// -------------------------------------------------------------------- staff

/**
 * The counter screen, which accepts a code two ways and does not care which.
 *
 * A USB or Bluetooth QR reader types into the box and presses Enter, which is
 * how most Thai gym counters already work, so the box keeps the focus. Ticking
 * the camera box instead points the tablet's own camera at the member's screen
 * (see camera.jsx). Both can be on at once.
 */
export function StaffScanner() {
  const [device, setDevice] = useState(() => localStorage.getItem('gym.device') || '');
  const [code, setCode] = useState('');
  const [outcome, setOutcome] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const [revision, setRevision] = useState(0);
  // The counter may have a USB reader, a tablet camera, or both. The camera is
  // remembered per device so staff do not have to switch it on every shift.
  const [camera, setCamera] = useState(() => localStorage.getItem('gym.camera') === 'on');
  const input = useRef(null);

  useEffect(() => { localStorage.setItem('gym.device', device); }, [device]);
  useEffect(() => { localStorage.setItem('gym.camera', camera ? 'on' : 'off'); }, [camera]);
  useEffect(() => { input.current?.focus(); }, [outcome]);

  async function submit(scanned) {
    const qr = (scanned ?? code).trim();
    if (!qr || busy) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch('/api/check-ins/verify', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Gym-Client': 'web' },
        body: JSON.stringify({ qr, device_label: device }),
      });
      const data = await response.json().catch(() => ({}));
      // A refusal is a normal answer here, not an error: the counter needs to
      // read it in one glance, not dig it out of a red banner.
      if (response.status === 200 || response.status === 409) {
        setOutcome(data);
        setRevision(n => n + 1);
      } else {
        const failure = new Error(data.error || 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง');
        failure.requestId = data.request_id;
        setError(failure);
      }
    } catch {
      setError(new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจอินเทอร์เน็ตแล้วสแกนอีกครั้ง'));
    } finally { setBusy(false); setCode(''); }
  }

  return <>
    <div className="page-heading"><div><span className="eyebrow">เคาน์เตอร์</span><h1>สแกนเช็คอิน</h1>
      <p className="muted">ให้สมาชิกเปิดรูปบัตรในแชต แล้วสแกนหรือวางรหัสในช่องด้านล่าง</p></div></div>

    {/* The photograph is the check, so it is the biggest thing on the screen
        and it arrives before the verdict does. A card is a picture in a chat
        app and can be forwarded; only the person at the counter can tell that
        the face is somebody else's, and only if looking is easier than not
        looking (Designer). "ไม่ใช่คนนี้" sits beside it so refusing is an
        ordinary thing to do rather than something to go and find. */}
    {outcome && <section className={`scan-result ${outcome.result}`} role="status" aria-live="assertive">
      {outcome.member?.photo_url
        ? <img className="scan-photo" src={`${outcome.member.photo_url}?at=${outcome.checked_in_at ?? ''}`}
            alt={`รูปถ่ายของ ${outcome.member.name}`}/>
        : <span className="scan-photo empty-photo" aria-hidden="true">ไม่มีรูป</span>}
      <div>
        <span className="scan-icon" aria-hidden="true">{outcome.result === 'allowed' ? '✓' : outcome.result === 'duplicate' ? '!' : '✕'}</span>
        <h2>{resultLabels[outcome.result]}</h2>
        {outcome.member && <p className="scan-member">{outcome.member.name} · {outcome.member.member_code}</p>}
        {outcome.failure_reason && <p className="scan-reason">{outcome.failure_reason}</p>}
        {outcome.remaining && <p className="scan-reason">
          {outcome.remaining.sessions_remaining === null
            ? `ใช้ได้ไม่จำกัดครั้ง ถึง ${formatDateTime(outcome.remaining.expires_at)}`
            : `เหลืออีก ${outcome.remaining.sessions_remaining} ครั้ง ถึง ${formatDateTime(outcome.remaining.expires_at)}`}</p>}
        {outcome.result === 'allowed' && <>
          <p className="scan-check">ดูรูปเทียบกับคนตรงหน้าก่อนให้เข้า</p>
          <button type="button" className="danger" onClick={() => setOutcome(null)}>ไม่ใช่คนนี้</button>
        </>}
      </div>
    </section>}

    <section className="card">
      <label className="check-row"><input type="checkbox" checked={camera} onChange={e => setCamera(e.target.checked)}/>
        <span>ใช้กล้องของเครื่องนี้สแกน (สำหรับแท็บเล็ตหน้าเคาน์เตอร์)</span></label>
      <CameraScanner active={camera} onScan={value => submit(value)}/>
      <form onSubmit={e => { e.preventDefault(); submit(); }}>
        <label className="field">รหัสจาก QR ของสมาชิก
          <input ref={input} name="qr" value={code} autoFocus autoComplete="off"
            placeholder="สแกนด้วยเครื่องอ่าน หรือวางรหัสที่นี่"
            onChange={e => setCode(e.target.value)}/></label>
        <Field name="device" label="ชื่อจุดสแกน (บันทึกไว้ในประวัติ)" value={device} onChange={setDevice} maxLength={60} placeholder="เช่น เคาน์เตอร์ 1"/>
        <Notice error={error}/>
        <div className="actions">
          <button className="primary" disabled={busy || !code.trim()}>{busy ? 'กำลังตรวจสอบ…' : 'ตรวจสอบ'}</button>
          {outcome && <button type="button" onClick={() => setOutcome(null)}>ล้างผลลัพธ์</button>}
        </div>
        <p className="fine">เครื่องอ่าน QR แบบ USB ส่วนใหญ่จะพิมพ์รหัสให้เองแล้วกด Enter ช่องนี้จึงโฟกัสไว้ตลอด</p>
      </form>
    </section>

    <CheckInLog key={revision} compact/>
  </>;
}

// ------------------------------------------------------------- shared views

export function CheckInLog({ compact = false }) {
  const [date, setDate] = useState('');
  const [q, setQ] = useState('');
  // compact is the scanner's own recent list, where a junk scan that just
  // happened is exactly what staff want to see.
  const [scope, setScope] = useState(compact ? 'all' : 'identified');
  const query = `/check-ins?${new URLSearchParams({ scope, ...(date && { date }), ...(q && { q }) })}`;
  const { data, error, busy, reload } = useResource(query);

  return <section className="card">
    <h2>{compact ? 'เช็คอินล่าสุด' : 'ประวัติการเช็คอิน'}</h2>
    {!compact && <>
      <nav className="tabs" aria-label="ชุดรายการเช็คอิน">
        <button onClick={() => setScope('identified')} aria-current={scope === 'identified' ? 'page' : undefined}>
          รายชื่อสมาชิก</button>
        <button onClick={() => setScope('unknown')} aria-current={scope === 'unknown' ? 'page' : undefined}>
          QR ไม่ถูกต้อง{data?.unknown_total ? ` (${data.unknown_total.toLocaleString('th-TH')})` : ''}</button>
      </nav>
      {scope === 'unknown' && <p className="muted">รายการที่สแกนแล้วระบุตัวสมาชิกไม่ได้ เช่น QR ปลอมหรืออ่านไม่ออก
        แยกไว้ที่นี่เพื่อไม่ให้กลบประวัติการเข้าใช้บริการจริง</p>}
      <div className="search-row">
        <Field name="checkin-date" label="วันที่" value={date} onChange={setDate} type="date"/>
        {scope === 'identified' && <Field name="checkin-q" label="ค้นหาสมาชิก" value={q} onChange={setQ} type="search" placeholder="ชื่อ หรือรหัสสมาชิก" maxLength={120}/>}
        <span className="muted">{data ? `${data.total.toLocaleString('th-TH')} รายการ` : ''}</span>
      </div>
    </>}
    <StateBox error={error} onRetry={() => reload().catch(() => {})}/>
    {busy ? <Loading label="กำลังโหลด…" rows={3}/> : !error && (
      !data.items.length ? <p className="muted">ยังไม่มีรายการ</p>
        : <div className="member-list">{data.items.slice(0, compact ? 5 : 20).map(item =>
          <div className="member-row" key={item.id}>
            <span className="member-name"><strong>{item.member_name ?? 'ไม่ทราบสมาชิก'}</strong>
              <small>{formatDateTime(item.checked_in_at)}{item.device_label ? ` · ${item.device_label}` : ''}
                {item.failure_reason ? ` · ${item.failure_reason}` : ''}</small></span>
            <span className={`tag ${item.result === 'allowed' ? 'active' : 'draft'}`}>{resultLabels[item.result]}</span>
          </div>)}</div>)}
  </section>;
}

export function CheckInSummary() {
  const { data, error, busy } = useResource('/check-ins/summary');
  if (busy) return <Loading label="กำลังโหลดสรุป…" rows={2}/>;
  if (error) return <Notice error={error}/>;
  if (!data.items.length) return <p className="muted">ยังไม่มีการเช็คอิน</p>;
  return <table className="sales"><thead><tr><th>วันที่</th><th>เข้าใช้บริการ</th><th>ซ้ำ</th><th>ถูกปฏิเสธ</th></tr></thead>
    <tbody>{data.items.map(row => <tr key={row.day}>
      <td>{row.day}</td><td>{row.allowed}</td><td>{row.duplicate}</td><td>{row.denied}</td>
    </tr>)}</tbody></table>;
}
