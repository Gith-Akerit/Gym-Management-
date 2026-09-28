import { useState } from 'react';
import { api, Empty, formatDateTime, Loading, StateBox, useResource } from './shared.jsx';

/**
 * What the counter said was wrong, from the owner's side.
 *
 * The thumbnail is in the list on purpose: most reports are answered by
 * looking at the picture, and opening them one at a time to find out which one
 * is the real problem is how a list of five becomes a list nobody reads.
 *
 * Everything here is the owner's alone. The pictures have members on them.
 */

const STATUS = {
  new: { label: 'ใหม่', chip: 'bad' },
  reading: { label: 'กำลังดู', chip: 'warn' },
  done: { label: 'แก้แล้ว', chip: 'ok' },
  not_a_bug: { label: 'ไม่ใช่ปัญหา', chip: '' },
};

const FILTERS = [['', 'ทั้งหมด'], ['new', 'ใหม่'], ['reading', 'กำลังดู'], ['done', 'แก้แล้ว']];

function Detail({ report, onBack, onChanged }) {
  const [status, setStatus] = useState(report.status);
  const [note, setNote] = useState(report.internal_note);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  // Said on this screen rather than on the list behind it: the person who
  // pressed save is still looking at the report they saved.
  const [saved, setSaved] = useState('');

  async function save() {
    setBusy(true); setFailure(null); setSaved('');
    try {
      onChanged(await api(`/reports/${report.id}`, { method: 'PATCH', body: { status, internal_note: note } }));
      setSaved('บันทึกแล้ว');
    } catch (error) { setFailure(error); } finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true); setFailure(null);
    try { await api(`/reports/${report.id}`, { method: 'DELETE' }); onChanged(null, 'ลบเรื่องนี้แล้ว'); }
    catch (error) { setFailure(error); setBusy(false); }
  }

  return <>
    <button className="btn auto" onClick={onBack}>← กลับไปรายการ</button>
    <h1 style={{ marginTop: 'var(--sp-4)' }}>เรื่อง #{report.reference}</h1>
    <p className="sub">แจ้งเมื่อ {formatDateTime(report.created_at)} · {report.reported_by_email ?? 'ไม่ทราบผู้แจ้ง'}
      {report.screen ? ` · หน้า${report.screen}` : ''}</p>

    <div className="sect">
      <h2>สิ่งที่ผู้แจ้งเขียนมา</h2>
      <p style={{ fontSize: 'var(--fs-18)', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{report.message}</p>
    </div>

    <div className="sect">
      <h2>ภาพหน้าจอตอนที่กด</h2>
      {report.has_image
        ? <>
            <a href={report.image_url} target="_blank" rel="noreferrer">
              <img src={report.image_url} alt={`ภาพหน้าจอของเรื่อง #${report.reference}`}
                style={{ width: '100%', border: '2px solid var(--line)', borderRadius: 'var(--r-1)', display: 'block' }}/>
            </a>
            <p className="note">ภาพอาจมีชื่อและรูปของสมาชิก · ระบบบันทึกทุกครั้งที่มีคนเปิดดูภาพนี้</p>
          </>
        : <p className="note">เรื่องนี้ไม่มีภาพ — จับภาพไม่สำเร็จ หรือผู้แจ้งเลือกไม่ส่งภาพมา</p>}
    </div>

    <div className="sect">
      <h2>จัดการเรื่องนี้</h2>
      <div className="field">
        <label htmlFor="report-status">สถานะ</label>
        <select id="report-status" value={status} onChange={event => setStatus(event.target.value)}>
          {Object.entries(STATUS).map(([key, { label }]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="report-note">บันทึกภายใน</label>
        <textarea id="report-note" rows={3} maxLength={2000} value={note}
          onChange={event => setNote(event.target.value)}/>
        <p className="note">ผู้แจ้งไม่เห็นข้อความนี้</p>
      </div>
      {saved && <div className="banner ok" role="status">
        <div className="ic" aria-hidden="true">✓</div><div><b>{saved}</b></div></div>}
      {failure && <div className="alert err" role="alert">
        <div className="ic" aria-hidden="true">✕</div><div><b>{failure.message}</b></div></div>}
      <div className="pvbtns">
        <button className="btn primary" onClick={save} disabled={busy}>บันทึก</button>
        <button className="btn danger" onClick={remove} disabled={busy}>ลบเรื่องนี้</button>
      </div>
      <p className="note">ลบแล้วภาพหน้าจอจะถูกลบออกจากเครื่องด้วย ย้อนกลับไม่ได้</p>
    </div>
  </>;
}

export function ProblemReports({ onAuthError }) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(null);
  const [notice, setNotice] = useState('');
  const { data, error, busy, reload } = useResource(`/reports${filter ? `?status=${filter}` : ''}`);

  if (busy && !data) return <Loading label="กำลังโหลดเรื่องที่แจ้งไว้"/>;
  if (error) { onAuthError?.(error); return <StateBox error={error} onRetry={reload}/>; }

  if (open) {
    return <Detail report={open} onBack={() => setOpen(null)}
      onChanged={(updated, message) => { setOpen(updated); if (message) setNotice(message); reload(); }}/>;
  }

  const items = data?.items ?? [];
  return <>
    <h1>เรื่องที่แจ้งไว้</h1>
    <p className="sub">สิ่งที่พนักงานกดแจ้งจากหน้าจอ พร้อมภาพตอนที่กด</p>
    {notice && <div className="banner ok" role="status">
      <div className="ic" aria-hidden="true">✓</div><div><b>{notice}</b></div></div>}

    <div className="tabs" role="tablist">
      {FILTERS.map(([key, label]) => <button key={key} role="tab" type="button"
        aria-current={filter === key ? 'page' : undefined}
        onClick={() => { setFilter(key); setNotice(''); }}>
        {label}{key && data?.counts?.[key] ? ` ${data.counts[key]}` : ''}</button>)}
    </div>

    {!items.length
      ? <Empty icon="✓" title="ยังไม่มีเรื่องที่แจ้งเข้ามา">
          เมื่อพนักงานเจอปัญหาและกด “แจ้งปัญหา” ในเมนูมุมขวาบน เรื่องจะมาอยู่ที่นี่พร้อมภาพหน้าจอตอนที่กด
        </Empty>
      : <div className="stack">
        {items.map(report => <div key={report.id} className={`rep${report.status === 'new' ? ' unread' : ''}`}>
          <span className="thumb">
            {report.has_image
              ? <img src={report.image_url} alt=""/>
              : <span className="skel" style={{ display: 'block', width: '100%', height: '100%' }}/>}
          </span>
          <div className="body">
            <b>{report.message}</b>
            <div className="m">#{report.reference} · {formatDateTime(report.created_at)}
              {report.screen ? ` · หน้า${report.screen}` : ''} · {report.reported_by_email ?? 'ไม่ทราบผู้แจ้ง'}</div>
          </div>
          <span className={`chip ${STATUS[report.status].chip}`}>{STATUS[report.status].label}</span>
          <button className="btn" onClick={() => { setOpen(report); setNotice(''); }}>เปิดดู</button>
        </div>)}
      </div>}
  </>;
}
