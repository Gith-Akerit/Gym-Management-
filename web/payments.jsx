import React, { useState } from 'react';
import {
  api, Empty, Field, formatDateTime, formatPhone, formatPrice, Loading, MISMATCH_NOTE_MIN,
  Notice, orderStatusLabels, StateBox, useResource,
} from './shared.jsx';

const describe = pkg => (pkg.type === 'unlimited' || pkg.package_type_snapshot === 'unlimited'
  ? `เข้าได้ไม่จำกัดครั้ง ภายใน ${pkg.duration_days ?? pkg.duration_days_snapshot} วัน`
  : `เข้าได้ ${pkg.session_limit ?? pkg.session_limit_snapshot} ครั้ง ภายใน ${pkg.duration_days ?? pkg.duration_days_snapshot} วัน`);

// ------------------------------------------------------------- admin: review

export function PaymentReview({ onAuthError, readOnly = false }) {
  const [status, setStatus] = useState('awaiting_review');
  const { data, error, busy, reload } = useResource(`/admin/orders?status=${status}`);
  const [openId, setOpenId] = useState(null), [notice, setNotice] = useState('');

  const filters = [['awaiting_review', 'รอตรวจสอบ'], ['paid', 'อนุมัติแล้ว'], ['rejected', 'ถูกปฏิเสธ'], ['all', 'ทั้งหมด']];
  // No role overrides on the queue buttons: role="listitem" would take the
  // button role away, and with it every way of finding or announcing them.
  // The queue runs across the top rather than down a third column. Subtract a
  // 220px sidebar from a 1100px page and there is no room left to put the slip
  // photo beside the numbers it has to be checked against -- which is the whole
  // job of this screen, so the column is what gives way (Designer, page 7).
  return <div className="queue-layout">
    <div>
      <div className="page-heading"><div><span className="eyebrow">ตรวจสลิป</span><h1>คำสั่งซื้อ</h1>
        <p className="muted">เรียงจากที่รอนานที่สุดก่อน</p></div>
        {data && <span className="badge active">รอตรวจสอบ {data.awaiting_review} รายการ</span>}</div>
      {notice && <div className="notice" role="status">{notice}</div>}
      <nav className="tabs" aria-label="กรองตามสถานะ">{filters.map(([key, label]) =>
        <button key={key} onClick={() => setStatus(key)} aria-current={status === key ? 'page' : undefined}>{label}</button>)}</nav>
      <StateBox error={error} onRetry={() => reload().catch(() => {})}/>
      {busy ? <Loading label="กำลังโหลดคำสั่งซื้อ…" cards={1}/> : !error && (
        !data.items.length
          ? <Empty title={status === 'awaiting_review' ? 'ยังไม่มีสลิป' : 'ไม่มีรายการในสถานะนี้'}>
              {status === 'awaiting_review'
                ? 'เมื่อสมาชิกส่งสลิปมาแล้ว รายการจะขึ้นที่นี่โดยเรียงจากที่รอนานที่สุด'
                : 'ลองเลือกสถานะอื่นด้านบน'}</Empty>
          : <div className="queue-list" aria-label="คิวสลิป">{data.items.map(order =>
            <button key={order.id} className="queue-item"
              aria-current={order.id === openId ? 'true' : undefined}
              onClick={() => { setOpenId(order.id); setNotice(''); }}
              aria-label={`${order.price_thb === 0 ? 'มอบสิทธิ์ให้' : 'ตรวจสลิปของ'} ${order.member_name}`}>
              <span style={{ minWidth: 0, flex: 1 }}>
                <b>{order.member_name}</b>
                <small>{order.package_name_snapshot} · {order.price_thb === 0 ? 'ไม่มีค่าใช้จ่าย' : formatPrice(order.price_thb)}</small>
                <small>ส่งเมื่อ {formatDateTime(order.waiting_since)}</small></span>
              <span className={`tag ${order.status === 'paid' ? 'active' : 'draft'}`}>{orderStatusLabels[order.status]}</span>
            </button>)}</div>)}
    </div>
    {openId
      ? <ReviewDetail key={openId} id={openId} onAuthError={onAuthError} readOnly={readOnly} onBack={() => setOpenId(null)}
          onDone={message => { setOpenId(null); setNotice(message); reload().catch(() => {}); }}/>
      : !busy && !error && data?.items.length
        ? <p className="muted">เลือกรายการจากคิวด้านบนเพื่อดูสลิปและตัดสิน</p>
        : null}
  </div>;
}

function ReviewDetail({ id, onBack, onDone, onAuthError, readOnly = false }) {
  const { data, error, busy, reload } = useResource(`/admin/orders/${id}`);
  const [checked, setChecked] = useState(false), [note, setNote] = useState(''), [reason, setReason] = useState('');
  const [working, setWorking] = useState(false), [actionError, setActionError] = useState(null);

  if (busy) return <Loading label="กำลังโหลด…" rows={3}/>;
  if (error) return <><button className="back" onClick={onBack}>← กลับ</button><Notice error={error}/></>;

  // A package that costs nothing has no transfer behind it, so this screen
  // stops being a slip check and becomes "give this member the package".
  const { order, slip, member, duplicates, amount_mismatch: mismatch, free } = data;
  const noteLongEnough = note.trim().length >= MISMATCH_NOTE_MIN;
  async function act(path, body, message) {
    setWorking(true); setActionError(null);
    try { await api(path, { method: 'POST', body: { version: order.version, ...body } }); onDone(message); }
    catch (e) { setActionError(e); onAuthError(e); reload().catch(() => {}); } finally { setWorking(false); }
  }

  return <section className="card"><button className="back" onClick={onBack} disabled={working}>← กลับรายการ</button>
    <h1>{free ? 'มอบสิทธิ์แพ็กเกจฟรี' : 'ตรวจสลิป'}</h1>
    <div className="review-grid">
      <div>{slip
        ? <a href={`/api/slips/${slip.id}/image`} target="_blank" rel="noreferrer">
            <img className="slip-review" alt="สลิปการโอนเงิน" src={`/api/slips/${slip.id}/image`}/></a>
        : <div className="qr-frame"><span>{free ? 'แพ็กเกจนี้ไม่มีค่าใช้จ่าย จึงไม่มีสลิป' : 'ยังไม่มีสลิป'}</span></div>}
        {slip && <p className="fine">คลิกที่รูปเพื่อเปิดขนาดเต็ม</p>}</div>
      <div>
        <dl>
          <dt>สมาชิก</dt><dd>{member.name} · {member.member_code}</dd>
          <dt>ติดต่อ</dt><dd>{member.email ? <>{member.email}<br/></> : null}{formatPhone(member.phone)}</dd>
          <dt>แพ็กเกจ</dt><dd>{order.package_name_snapshot} · {describe(order)}</dd>
          <dt>ยอดที่ต้องได้รับ</dt><dd><strong>{free ? 'ไม่มีค่าใช้จ่าย' : formatPrice(order.price_thb)}</strong></dd>
          {slip && <><dt>ยอดที่สมาชิกแจ้ง</dt>
            <dd>{slip.amount_thb_claimed === null ? 'ไม่ได้แจ้ง' : formatPrice(slip.amount_thb_claimed)}</dd>
            <dt>เลขอ้างอิง</dt><dd>{slip.reference_no}</dd>
            <dt>เวลาที่โอน</dt><dd>{formatDateTime(slip.transferred_at)}</dd>
            <dt>ส่งสลิปเมื่อ</dt><dd>{formatDateTime(slip.uploaded_at)}</dd></>}
          <dt>สถานะ</dt><dd>{orderStatusLabels[order.status]}</dd>
          {order.rejection_reason && <><dt>เหตุผลที่ปฏิเสธ</dt><dd>{order.rejection_reason}</dd></>}
        </dl>

        {mismatch && <div className="notice warn" role="alert">
          <strong>ยอดไม่ตรง</strong>
          <p>สมาชิกแจ้งยอด {formatPrice(slip.amount_thb_claimed)} แต่แพ็กเกจราคา {formatPrice(order.price_thb)}
            {' '}หากจะอนุมัติ กรุณาระบุเหตุผลในช่องหมายเหตุ</p></div>}

        {duplicates.length > 0 && <div className="notice warn" role="alert">
          <strong>สลิปหรือเลขอ้างอิงนี้เคยใช้แล้ว</strong>
          <ul>{duplicates.map(d => <li key={d.id}>
            {d.kind === 'file' ? 'รูปเดียวกัน' : 'เลขอ้างอิงเดียวกัน'} · {d.reference_no} · {formatDateTime(d.uploaded_at)}
          </li>)}</ul></div>}

        {data.slip_history.length > 1 && <p className="fine">สมาชิกส่งสลิปมาแล้ว {data.slip_history.length} ครั้ง แสดงใบล่าสุด</p>}

        <Notice error={actionError}/>

        {readOnly && <p className="fine">พนักงานดูได้อย่างเดียว การอนุมัติหรือปฏิเสธสลิปเป็นสิทธิ์ของผู้ดูแลระบบ</p>}
        {!readOnly && order.status === 'awaiting_review' && <>
          <Field name="note" label={mismatch ? 'เหตุผลที่อนุมัติทั้งที่ยอดไม่ตรง (บังคับ)' : 'หมายเหตุ (บันทึกไว้ในประวัติ)'}
            value={note} onChange={setNote} maxLength={300}
            error={mismatch && !noteLongEnough ? `กรุณาระบุเหตุผลอย่างน้อย ${MISMATCH_NOTE_MIN} ตัวอักษร` : undefined}/>
          {!free && <label className="check-row"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)}/>
            <span>ตรวจกับแอปธนาคารแล้วว่าเงินเข้าจริงตามยอดและเวลานี้</span></label>}
          <div className="actions">
            <button className="primary" disabled={(!free && !checked) || working || (mismatch && !noteLongEnough)}
              onClick={() => act(`/admin/orders/${order.id}/approve`,
                free ? { note } : { checked_against_bank: true, note }, free ? 'มอบสิทธิ์แล้ว' : 'อนุมัติแล้ว')}>
              {working ? 'กำลังบันทึก…' : free ? 'มอบสิทธิ์ (ไม่มีค่าใช้จ่าย)' : 'อนุมัติและให้สิทธิ์'}</button>
          </div>
          <p className="fine">{free
            ? 'แพ็กเกจนี้ราคา 0 บาท ไม่มีเงินโอนให้ตรวจ จึงไม่มีช่องยืนยันเงินเข้า กดปุ่มแล้วสมาชิกได้สิทธิ์ทันที'
            : `ปุ่มอนุมัติจะกดได้เมื่อติ๊กช่องด้านบน เพราะไม่มีข้อมูลจากผู้ให้บริการชำระเงินมายืนยันแทน${mismatch ? ' และเมื่อยอดไม่ตรง ต้องเขียนเหตุผลไว้ในประวัติด้วย' : ''}`}</p>
          <Field name="reason" label={free ? 'เหตุผลที่ไม่มอบสิทธิ์' : 'เหตุผลที่ปฏิเสธ'} value={reason} onChange={setReason} maxLength={300}/>
          <button className="danger" disabled={!reason.trim() || working}
            onClick={() => act(`/admin/orders/${order.id}/reject`, { reason },
              free ? 'ไม่มอบสิทธิ์แล้ว' : 'ปฏิเสธสลิปแล้ว')}>{free ? 'ไม่มอบสิทธิ์' : 'ปฏิเสธสลิป'}</button>
        </>}

        {!readOnly && ['expired', 'cancelled'].includes(order.status) && <div className="secondary-actions" style={{ display: 'block' }}>
          <p className="fine">คำสั่งซื้อนี้ปิดไปแล้ว ถ้าสมาชิกโอนเงินมาจริง เปิดกลับมาให้ตรวจสอบได้โดยไม่ต้องให้โอนซ้ำ</p>
          <button disabled={working}
            onClick={() => act(`/admin/orders/${order.id}/reopen`, { minutes: 1440 }, 'เปิดคำสั่งซื้อกลับมาแล้ว')}>
            เปิดคำสั่งซื้อกลับมา</button>
        </div>}

        {!readOnly && order.status === 'paid' && <div className="secondary-actions" style={{ display: 'block' }}>
          <Field name="reason" label="เหตุผลที่ยกเลิกการอนุมัติ" value={reason} onChange={setReason} maxLength={300}/>
          <button className="danger" disabled={!reason.trim() || working}
            onClick={() => act(`/admin/orders/${order.id}/reverse`, { reason }, 'ยกเลิกการอนุมัติแล้ว')}>
            ยกเลิกการอนุมัติและเพิกถอนสิทธิ์</button>
        </div>}
      </div>
    </div>
  </section>;
}

export function SalesReport() {
  const { data, error, busy } = useResource('/admin/sales');
  if (busy) return <Loading label="กำลังโหลดยอดขาย…" rows={3}/>;
  if (error) return <Notice error={error}/>;
  if (!data.items.length) return <p className="muted">ยังไม่มียอดขายที่อนุมัติแล้ว</p>;
  return <table className="sales"><thead><tr><th>วันที่</th><th>จำนวนคำสั่งซื้อ</th><th>ยอดรวม</th></tr></thead>
    <tbody>{data.items.map(row => <tr key={row.day}>
      <td>{row.day}</td><td>{row.orders.toLocaleString('th-TH')}</td><td>{formatPrice(row.total_thb)}</td>
    </tr>)}</tbody></table>;
}
