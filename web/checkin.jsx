import React, { useEffect, useRef, useState } from 'react';
import { Field, formatDateTime, Loading, Mark, StateBox, useResource } from './shared.jsx';
import { CameraScanner } from './camera.jsx';
import { onScanningPause, scanningPaused } from './capture.js';
import { UserMenu } from './usermenu.jsx';

const resultLabels = { allowed: 'เข้าใช้บริการได้', duplicate: 'เช็คอินไปแล้ว', denied: 'เข้าใช้บริการไม่ได้' };
const resultIcon = { allowed: '✓', duplicate: '!', denied: '✕' };

/**
 * The counter screen.
 *
 * A dark stage, on purpose and not for taste: the member is holding a phone
 * with a glass screen, and a bright page behind the camera reflects off it and
 * costs reads. It is the only screen used standing up with somebody waiting,
 * so it fills the window and carries nothing else (Designer, แบบ 2).
 *
 * The photograph is the check. It arrives before the verdict, it is larger
 * than the verdict, and "ไม่ใช่คนนี้" sits beside the confirmation so refusing
 * is an ordinary thing to do rather than something to go and find.
 */
export function StaffScanner({ brand = 'ยิมของเรา', branding, user, menu = [], onPick, onOpenMember, onLeave }) {
  const [device, setDevice] = useState(() => localStorage.getItem('gym.device') || '');
  const [code, setCode] = useState('');
  const [outcome, setOutcome] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const [revision, setRevision] = useState(0);
  const [camera, setCamera] = useState(() => localStorage.getItem('gym.camera') !== 'off');
  const [cameraError, setCameraError] = useState(null);
  const [typing, setTyping] = useState(false);
  const input = useRef(null);

  // Mirrored into React state only so the attribute above can move; the loop
  // itself reads the flag directly, every frame.
  const [scanPaused, setScanPaused] = useState(scanningPaused());
  useEffect(() => onScanningPause(setScanPaused), []);
  useEffect(() => { localStorage.setItem('gym.device', device); }, [device]);
  useEffect(() => { localStorage.setItem('gym.camera', camera ? 'on' : 'off'); }, [camera]);
  useEffect(() => { if (typing) input.current?.focus(); }, [typing, outcome]);

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

  const member = outcome?.member ?? null;
  const remaining = outcome?.remaining ?? null;
  const revoked = outcome?.result === 'denied' && /ถูกยกเลิก/.test(outcome.failure_reason ?? '');
  // สิทธิ์หมดพอดีกับครั้งนี้ — นับเฉพาะตอนที่เข้าได้จริง ไม่ใช่ตอนถูกปฏิเสธ
  // (ถูกปฏิเสธเพราะสิทธิ์หมด มีข้อความของมันเองอยู่แล้ว)
  const lastVisit = (outcome?.result === 'allowed' || outcome?.result === 'duplicate')
    && remaining?.sessions_remaining === 0;

  return <div className="scanstage">
    <div className="scanbar">
      <Mark branding={branding} brand={brand}/>
      <div className="brand">จุดสแกน{device ? ` · ${device}` : ''}
        <small>{brand} · {user?.role === 'admin' ? 'เจ้าของยิม' : 'พนักงาน'}</small></div>
      <div className="spacer"/>
      <button className="btn auto" onClick={onLeave}>ไปหน้าจัดการ</button>
      {/* The same menu as every other screen. This is the screen staff stand at
          all day, so leaving it out would mean walking off the stage to reach
          anything -- including, once it lands, reporting what just went wrong. */}
      <UserMenu user={user} groups={menu} onPick={onPick} footer={brand}/>
    </div>

    <div className={`scanbody${outcome && !busy ? ' hasresult' : ''}`}>
      <div>
        <div className={`cam${camera && !cameraError ? '' : ' off'}`}
          /* Says out loud whether the lens is reading right now. It stops while
             the screen is being photographed (QA BUG-14), and a flag that is
             never cleared is a camera that silently never reads a card again --
             so it is on the page where a test, and a person, can see it. */
          data-scanning={scanPaused ? 'paused' : 'live'}
          style={cameraError ? { borderColor: 'var(--deny)' } : undefined}>
          {/* BUG-04 (QA): the loop kept reading the card that was still being
              held up while staff compared the photograph to the face -- which
              takes longer than four seconds every time -- and each read wrote
              another row. A day's history was 15 duplicates to 3 real entries.
              The lens stops looking once there is an answer on screen, and
              starts again when somebody says they are ready for the next
              person. */}
          <CameraScanner active={camera && !cameraError && !outcome && !busy}
            onScan={value => submit(value)} onError={setCameraError}/>
          {(!camera || cameraError) && <span className="camhint">
            {cameraError ? 'กล้องถูกปิดอยู่' : 'กล้องปิดอยู่'}</span>}
          {camera && !cameraError && outcome && <span className="camhint">
            หยุดสแกนไว้ก่อน · กด “สแกนคนถัดไป” เมื่อพร้อม</span>}
          {camera && !cameraError && !outcome && !busy && <><span className="frame"/><span className="laser"/></>}
          {/* Visible, not only in the DOM: while the screen is being
              photographed the lens stops reading, and somebody holding a card
              up to it deserves to know why nothing is happening. */}
          {scanPaused && camera && !cameraError && <span className="campause" role="status">
            พักการอ่านบัตรชั่วคราว</span>}
        </div>
        <div className="darkbtns">
          {cameraError
            ? <button className="btn primary" onClick={() => { setCameraError(null); setCamera(true); }}>
                ขออนุญาตใช้กล้องอีกครั้ง</button>
            : <button className="btn" onClick={() => setCamera(!camera)}>{camera ? 'ปิดกล้อง' : 'เปิดกล้อง'}</button>}
          <button className="btn" onClick={() => setTyping(!typing)}>พิมพ์รหัสเอง</button>
        </div>
        {typing && <form className="soft" style={{ marginTop: 'var(--sp-4)', background: 'transparent', borderColor: 'rgba(255,255,255,.4)' }}
          onSubmit={e => { e.preventDefault(); submit(); }}>
          <div className="field">
            <label htmlFor="qr" style={{ color: 'var(--on-dark)' }}>รหัสสมาชิก หรือรหัสจาก QR</label>
            <input ref={input} id="qr" name="qr" value={code} autoComplete="off"
              placeholder="เช่น GYM-1A2B3C4D5E6F"
              onChange={e => setCode(e.target.value)}/>
            {/* ผลทดสอบของผู้ใช้ ข้อ 2: ป้ายเดิมบอกว่า "รหัสจาก QR" ซึ่งเป็นสิ่งที่
                ไม่มีใครอ่านออกจากบัตร คนที่หน้าเคาน์เตอร์จึงพิมพ์รหัสสมาชิกที่
                พิมพ์อยู่ใต้ QR ลงไป — ตอนนี้รับได้จริงแล้ว ป้ายจึงบอกตามนั้น */}
            <p className="hint" style={{ color: 'var(--on-dark-2)' }}>
              พิมพ์รหัสสมาชิกที่อยู่ใต้ QR บนบัตรได้เลย หรือใช้เครื่องอ่านบัตรวางรหัสจาก QR ลงช่องนี้</p>
          </div>
          <Field name="device" label="ชื่อจุดสแกน (บันทึกไว้ในประวัติ)" value={device} onChange={setDevice}
            maxLength={60} placeholder="เช่น เคาน์เตอร์ 1"/>
          <button className="btn primary" disabled={busy || !code.trim()}>{busy ? 'กำลังตรวจสอบ…' : 'ตรวจสอบ'}</button>
        </form>}
        {!typing && !cameraError && <p style={{ color: 'var(--on-dark-2)', fontSize: 'var(--fs-16)', marginTop: 'var(--sp-4)' }}>
          จอมืดช่วยลดแสงสะท้อนบนหน้าจอลูกค้า ทำให้กล้องอ่านบัตรติดง่ายขึ้น</p>}
      </div>

      <div>
        {error && <div className="dark-err" role="alert">
          <div className="ic" aria-hidden="true">!</div>
          <b>{error.message}</b>
          <p>ประวัติและสิทธิ์ของลูกค้าไม่ได้หายไปไหน ลองสแกนอีกครั้งเมื่อเน็ตกลับมา</p>
        </div>}

        {/* The camera help gives way the moment there is something to report:
            somebody who typed a code in is waiting for an answer, not for
            instructions about a permission they have already worked around. */}
        {!error && cameraError && !busy && !outcome && <>
          <div className="dark-err" role="alert">
            <div className="ic" aria-hidden="true">!</div>
            <b>เบราว์เซอร์ไม่ให้ใช้กล้อง</b>
            <p>ยังเช็คอินให้ลูกค้าได้ตามปกติด้วยการพิมพ์รหัสใต้ QR บนบัตร งานไม่หยุด</p>
            <div className="darkbtns" style={{ justifyContent: 'center' }}>
              <button className="btn primary" onClick={() => setTyping(true)}>พิมพ์รหัสจากบัตรแทน</button>
            </div>
          </div>
          {/* BUG-07 (QA): this used to name "the padlock beside the address
              bar", which the counter tablet does not have — and the tablet is
              the device the gym actually bought this for. Three ways, named by
              the machine in front of the person reading it. */}
          <div className="checkline" style={{ marginTop: 'var(--sp-5)' }}>
            <b>วิธีเปิดกล้องคืน · ทำตามเครื่องที่คุณใช้อยู่</b>
            <div style={{ marginTop: 'var(--sp-3)' }}>
              <b>คอมพิวเตอร์ (Chrome/Edge)</b><br/>
              กดไอคอนซ้ายของช่อง URL (รูปกุญแจหรือรูปเลื่อน) → “กล้อง” → อนุญาต → โหลดหน้านี้ใหม่
            </div>
            <div style={{ marginTop: 'var(--sp-3)' }}>
              <b>แท็บเล็ต/มือถือ Android</b><br/>
              ตั้งค่าของเครื่อง → แอป → Chrome → สิทธิ์ → กล้อง → อนุญาต แล้วกลับมาโหลดหน้านี้ใหม่
            </div>
            <div style={{ marginTop: 'var(--sp-3)' }}>
              <b>iPad/iPhone (Safari)</b><br/>
              ตั้งค่า → Safari → กล้อง → อนุญาต · ถ้าเพิ่มหน้านี้ไว้ที่หน้าโฮม ให้ดูที่ ตั้งค่า → แอปนั้น → กล้อง
            </div>
            <span style={{ color: 'var(--on-dark-2)', fontSize: 'var(--fs-14)', display: 'block', marginTop: 'var(--sp-3)' }}>
              ถ้าเปิดผ่าน http:// ธรรมดาเบราว์เซอร์จะไม่ให้ใช้กล้องเลย ต้องเป็น https:// เท่านั้น — แจ้งทีมติดตั้ง</span>
          </div>
        </>}

        {!error && busy && <>
          <div className="result wait">
            <div className="rface skel" style={{ borderColor: 'rgba(255,255,255,.35)' }}/>
            <div className="rbody">
              <div className="rv"><span className="spin"/>กำลังตรวจสอบ…</div>
              <div className="skel skel-line" style={{ width: '70%', height: 34, marginTop: 22 }}/>
              <div className="skel skel-line" style={{ width: '45%' }}/>
            </div>
          </div>
          <div className="checkline">ยังไม่ใช่ผลผ่าน <b>อย่าเพิ่งให้ลูกค้าเข้า</b> จนกว่าจะเห็นผลและรูปถ่าย</div>
        </>}

        {!error && !cameraError && !busy && !outcome && <div className="dark-empty">
          <div className="ic" aria-hidden="true">▢</div>
          <b>พร้อมสแกน</b>
          <p>ให้ลูกค้าเปิดรูปบัตรในมือถือแล้วยื่นเข้ากรอบ ระบบอ่านและตรวจให้เอง ไม่ต้องกดปุ่ม</p>
        </div>}

        {!error && !busy && outcome && <>
          {/* BUG-03 (QA): duplicate shared the refusal's red. A new member of
              staff reads red and turns the customer away, when the answer is
              "they may come in, we simply wrote it down already". The list
              below was already drawing it as a third, neutral state -- the big
              panel disagreed with it. */}
          <section className={`result${outcome.result === 'allowed' ? ''
            : outcome.result === 'duplicate' ? ' again' : ' deny'}`} role="status" aria-live="assertive">
            {member?.photo_url
              ? <span className="rface"><img src={`${member.photo_url}?at=${outcome.checked_in_at ?? ''}`}
                  alt={`รูปถ่ายของ ${member.name}`}/></span>
              : <span className="rface" style={{ display: 'grid', placeItems: 'center', fontSize: 'var(--fs-20)' }}>ไม่มีรูป</span>}
            <div className="rbody">
              <div className="rv"><i aria-hidden="true">{resultIcon[outcome.result]}</i>{resultLabels[outcome.result]}</div>
              {member && <>
                <div className="rname">{member.name}</div>
                <div className="rcode">{member.member_code}</div>
              </>}
              {remaining && <div className="rfacts">
                <div><span>แพ็กเกจ</span><b>{remaining.sessions_remaining === null
                  ? 'ไม่จำกัดครั้ง' : `เหลือ ${remaining.sessions_remaining} ครั้ง`}</b></div>
                <div><span>ใช้ได้ถึง</span><b className="num">{formatDateTime(remaining.expires_at)}</b></div>
              </div>}
              {/* "เข้าใช้บริการได้" คู่กับ "เหลือ 0 ครั้ง" เป็นคู่ที่อ่านแล้วงง
                  ที่จริงมันแปลว่าเพิ่งใช้ครั้งสุดท้ายไป ซึ่งเป็นเรื่องที่ต้องบอก
                  ตอนลูกค้ายังยืนอยู่ตรงหน้า ไม่ใช่ให้เขารู้ตอนมาครั้งหน้าแล้วสแกนไม่ผ่าน
                  (เจอในผลทดสอบของผู้ใช้ รอบที่ 2 — สมาชิกรายปีที่ถูกตั้งแพ็กเกจไว้ 1 ครั้ง) */}
              {lastVisit && <p className="reason"><b>ครั้งนี้เป็นครั้งสุดท้ายของแพ็กเกจนี้</b> —
                บอกลูกค้าตอนนี้เลยว่าครั้งหน้าต้องต่อแพ็กเกจก่อนถึงจะเข้าได้</p>}
              {outcome.failure_reason && <p className="reason">{outcome.failure_reason}</p>}
            </div>
          </section>

          {outcome.result === 'allowed' && <div className="checkline">
            <b>ดูรูปเทียบกับคนตรงหน้าก่อนให้เข้า</b> — บัตรเป็นรูปภาพ ส่งต่อกันได้ รูปถ่ายคือด่านที่คนส่งต่อบัตรผ่านไม่ได้</div>}
          {outcome.result === 'duplicate' && <div className="checkline">
            <b>คนนี้เข้าได้ ระบบแค่บันทึกไปแล้วรอบนี้</b> — ดูรูปเทียบหน้าเหมือนเดิมแล้วให้เข้าได้เลย
            ไม่ต้องหักสิทธิ์ซ้ำและไม่ต้องสแกนใหม่</div>}
          {revoked && <div className="checkline">
            <b>ให้ลูกค้าใช้บัตรใบล่าสุดที่ยิมส่งให้</b> ถ้าเขาไม่มี ให้เปิดหน้าสมาชิกรายนี้แล้วกด “ส่งบัตรซ้ำ” ·
            ถ้าเขายืนยันว่าไม่เคยได้รับบัตรใหม่ ให้แจ้งเจ้าของยิม อาจมีคนอื่นถือบัตรเก่าอยู่</div>}

          <div className="darkbtns">
            <button className="btn primary" onClick={() => setOutcome(null)}>
              {outcome.result === 'denied' ? 'สแกนคนถัดไป' : 'ยืนยันให้เข้า · สแกนคนถัดไป'}</button>
            {outcome.result !== 'denied' && <button className="btn" onClick={() => setOutcome(null)}>ไม่ใช่คนนี้</button>}
            {member && onOpenMember && <button className="btn" onClick={() => onOpenMember(member)}>เปิดหน้าสมาชิกรายนี้</button>}
          </div>

          <RecentScans key={revision}/>
        </>}
      </div>
    </div>
  </div>;
}

/** The last few people through the door, on the dark stage beside the result. */
function RecentScans() {
  const { data, error, busy } = useResource('/check-ins?scope=all');
  if (busy || error || !data?.items.length) return null;
  return <ul className="dlog">{data.items.slice(0, 4).map(item => <li key={item.id}>
    <span className="mini" aria-hidden="true"/>
    <span style={{ flex: 1 }}><b>{item.member_name ?? 'ไม่ทราบสมาชิก'}</b>{' '}
      <span className="num" style={{ opacity: 0.75 }}>{formatDateTime(item.checked_in_at)}</span></span>
    <span className={`chip ${item.result === 'allowed' ? 'ok' : item.result === 'duplicate' ? 'neutral' : 'bad'}`}>
      {resultIcon[item.result]} {resultLabels[item.result]}</span>
  </li>)}</ul>;
}

// ------------------------------------------------------------- shared views

export function CheckInLog({ compact = false }) {
  const [date, setDate] = useState('');
  const [q, setQ] = useState('');
  const [scope, setScope] = useState(compact ? 'all' : 'identified');
  const query = `/check-ins?${new URLSearchParams({ scope, ...(date && { date }), ...(q && { q }) })}`;
  const { data, error, busy, reload } = useResource(query);

  return <div className="block">
    <h2>{compact ? 'เช็คอินล่าสุด' : 'ประวัติการเช็คอิน'}</h2>
    {!compact && <>
      <nav className="tabs" aria-label="ชุดรายการเช็คอิน">
        <button onClick={() => setScope('identified')} aria-current={scope === 'identified' ? 'page' : undefined}>
          รายชื่อสมาชิก</button>
        <button onClick={() => setScope('unknown')} aria-current={scope === 'unknown' ? 'page' : undefined}>
          QR ไม่ถูกต้อง{data?.unknown_total ? ` (${data.unknown_total.toLocaleString('th-TH')})` : ''}</button>
      </nav>
      {scope === 'unknown' && <p className="note">รายการที่สแกนแล้วระบุตัวสมาชิกไม่ได้ เช่น QR ปลอมหรืออ่านไม่ออก
        แยกไว้ที่นี่เพื่อไม่ให้กลบประวัติการเข้าใช้บริการจริง</p>}
      <div className="two">
        <Field name="checkin-date" label="วันที่" value={date} onChange={setDate} type="date"
          hint="รูปแบบ วว/ดด/ปปปป (ค.ศ.)"/>
        {scope === 'identified' && <Field name="checkin-q" label="ค้นหาสมาชิก" value={q} onChange={setQ} type="search"
          placeholder="ชื่อ หรือรหัสสมาชิก" maxLength={120}/>}
      </div>
    </>}
    <StateBox error={error} onRetry={() => reload().catch(() => {})}/>
    {busy ? <Loading label="กำลังโหลด…" rows={3}/> : !error && (
      !data.items.length ? <p className="note">ยังไม่มีรายการ</p>
        : <div className="list">{data.items.slice(0, compact ? 5 : 20).map(item =>
          <div className="item" key={item.id}>
            <div className="who"><b>{item.member_name ?? 'ไม่ทราบสมาชิก'}</b>
              <span>{formatDateTime(item.checked_in_at)}{item.device_label ? ` · ${item.device_label}` : ''}
                {item.failure_reason ? ` · ${item.failure_reason}` : ''}</span></div>
            <span className={`chip ${item.result === 'allowed' ? 'ok' : item.result === 'duplicate' ? 'neutral' : 'bad'}`}>
              {resultIcon[item.result]} {resultLabels[item.result]}</span>
          </div>)}</div>)}
  </div>;
}

export function CheckInSummary() {
  const { data, error, busy } = useResource('/check-ins/summary');
  if (busy) return <Loading label="กำลังโหลดสรุป…" rows={2} avatar={false}/>;
  if (error) return <StateBox error={error}/>;
  if (!data.items.length) return <p className="note">ยังไม่มีการเช็คอิน</p>;
  return <table className="sales">
    <thead><tr><th>วันที่</th><th>เข้าใช้บริการ</th><th>ซ้ำ</th><th>ถูกปฏิเสธ</th></tr></thead>
    <tbody>{data.items.map(row => <tr key={row.day}>
      <td>{row.day}</td><td>{row.allowed}</td><td>{row.duplicate}</td><td>{row.denied}</td>
    </tr>)}</tbody>
  </table>;
}
