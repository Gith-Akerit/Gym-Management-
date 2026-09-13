import React, { useState } from 'react';
import {
  api, Field, formatDateTime, formatPhone, formatPrice, MISMATCH_NOTE_MIN, Notice,
  orderStatusLabels, upload, useCountdown, useResource,
} from './shared.jsx';

const describe = pkg => (pkg.type === 'unlimited' || pkg.package_type_snapshot === 'unlimited'
  ? `เข้าได้ไม่จำกัดครั้ง ภายใน ${pkg.duration_days ?? pkg.duration_days_snapshot} วัน`
  : `เข้าได้ ${pkg.session_limit ?? pkg.session_limit_snapshot} ครั้ง ภายใน ${pkg.duration_days ?? pkg.duration_days_snapshot} วัน`);

/** Local wall-clock time formatted for a datetime-local input, Bangkok assumed. */
function nowForInput() {
  const d = new Date(Date.now() + 7 * 3600000);
  return d.toISOString().slice(0, 16);
}

// ------------------------------------------------------------- member: buying

export function MemberPackages({ onBuy }) {
  const { data, error, busy, reload } = useResource('/packages');
  const [pending, setPending] = useState(null), [buyError, setBuyError] = useState(null);

  async function buy(item) {
    setPending(item.id); setBuyError(null);
    try { onBuy((await api('/orders', { method: 'POST', body: { package_id: item.id } })).order.id); }
    catch (e) { setBuyError(e); } finally { setPending(null); }
  }

  if (busy) return <p role="status" className="empty">กำลังโหลดแพ็กเกจ…</p>;
  if (error) return <><Notice error={error}/><button onClick={() => reload().catch(() => {})}>ลองใหม่</button></>;
  if (!data.items.length) {
    return <div className="empty"><h2>ยังไม่เปิดขายแพ็กเกจ</h2>
      <p>ยิมกำลังจัดเตรียมแพ็กเกจและราคา สอบถามได้ที่เคาน์เตอร์</p></div>;
  }
  return <><h1>แพ็กเกจ</h1><Notice error={buyError}/>
    {data.items.map(item => {
      const price = formatPrice(item.price_thb);
      return <div className="pkg-card" key={item.id}>
        <div className="pkg-head"><div><h3>{item.name_th}</h3><p className="muted">{describe(item)}</p></div>
          <span className={price ? 'price' : 'price tbd'}>{price ?? 'รอประกาศราคา'}</span></div>
        {item.description && <p className="muted">{item.description}</p>}
        <button className="primary full" disabled={!price || pending === item.id} onClick={() => buy(item)}>
          {pending === item.id ? 'กำลังสร้างคำสั่งซื้อ…' : 'ซื้อแพ็กเกจนี้'}</button>
      </div>;
    })}</>;
}

/** Pay screen, status screen and slip form — one order, all of its states. */
export function MemberOrder({ orderId, onBack }) {
  const { data, error, busy, reload, setData } = useResource(`/orders/${orderId}`);
  if (busy) return <p role="status" className="empty">กำลังโหลดคำสั่งซื้อ…</p>;
  if (error) {
    return <><button onClick={onBack}>← กลับ</button><Notice error={error}/>
      <button onClick={() => reload().catch(() => {})}>ลองใหม่</button></>;
  }
  return <OrderScreen view={data} onBack={onBack} onChange={setData} onReload={() => reload().catch(() => {})}/>;
}

function OrderScreen({ view, onBack, onChange, onReload }) {
  const { order, slip, payment_sla_text: sla } = view;
  const countdown = useCountdown(order.status === 'pending_payment' ? order.expires_at : null);
  const price = formatPrice(order.price_thb);
  // Only an unpaid order runs out of time. Once a slip is in, the money has
  // left the member's account and the order stays workable (QA P2-BUG-01).
  const stillOpen = order.status !== 'pending_payment' || order.expires_at > Date.now();
  const canSendSlip = !view.free
    && ['pending_payment', 'awaiting_review', 'rejected'].includes(order.status) && stillOpen;

  return <>
    <button onClick={onBack}>← กลับไปหน้าแพ็กเกจ</button>
    <h1>ชำระเงิน</h1>
    <section className="card">
      <div className="pkg-head"><div><h2>{order.package_name_snapshot}</h2>
        <p className="muted">{describe(order)}</p></div><span className="price">{price}</span></div>
      <span className={`tag ${order.status === 'paid' ? 'active' : 'draft'}`}>{orderStatusLabels[order.status]}</span>
    </section>

    {view.free && ['pending_payment', 'awaiting_review'].includes(order.status) && <div className="notice">
      <strong>แพ็กเกจนี้ไม่มีค่าใช้จ่าย</strong>
      <p>ไม่ต้องโอนเงินและไม่ต้องส่งสลิป รอพนักงานกดมอบสิทธิ์ให้{sla ? ` ${sla}` : ''}</p>
    </div>}

    {view.promptpay_payload !== null && <section className="card">
      <h2 style={{ textAlign: 'center' }}>PromptPay</h2>
      <img className="qr-image" alt={`QR พร้อมเพย์ จำนวน ${price}`} src={`/api/orders/${order.id}/qr.png`}/>
      <p className="qr-amount">{price}</p>
      <p className="muted">
        1. เปิดแอปธนาคาร แล้วสแกน QR นี้ (หรือบันทึกรูปแล้วเลือกจากคลังภาพ)<br/>
        2. ตรวจว่ายอดเงินตรงกับ {price} แล้วโอน<br/>
        3. กลับมาที่หน้านี้ แล้วส่งสลิปด้านล่าง
      </p>
      <a className="button secondary" href={`/api/orders/${order.id}/qr.png`} download>บันทึกรูป QR</a>
      {order.status === 'pending_payment' && <p className="fine">{countdown.expired
        ? 'คำสั่งซื้อหมดอายุแล้ว กรุณากดซื้อใหม่'
        : `คำสั่งซื้อนี้หมดอายุใน ${countdown.text} นาที`}</p>}
      {order.status === 'rejected' && <p className="fine">โอนตามยอดนี้แล้วส่งสลิปใหม่ได้เลย ไม่ต้องสั่งซื้อใหม่</p>}
    </section>}

    {order.status === 'awaiting_review' && <div className="notice warn">
      <strong>รอตรวจสอบการชำระเงิน</strong>
      <p>ส่งสลิปแล้ว พนักงานจะตรวจสอบ{sla ? ` ${sla}` : ''} <strong>สิทธิ์ยังใช้เข้ายิมไม่ได้จนกว่าจะอนุมัติ</strong></p>
    </div>}

    {order.status === 'rejected' && <div className="notice warn">
      <strong>สลิปไม่ผ่านการตรวจสอบ</strong>
      <p>เหตุผล: {order.rejection_reason}</p>
      <p>ส่งสลิปใหม่ได้จากด้านล่าง ไม่ต้องสั่งซื้อใหม่</p>
    </div>}

    {order.status === 'paid' && <div className="notice">
      <strong>อนุมัติแล้ว ใช้สิทธิ์ได้ทันที</strong>
      {view.entitlement && <p>ใช้ได้ถึง {formatDateTime(view.entitlement.expires_at)}
        {view.entitlement.sessions_remaining !== null && ` · เหลือ ${view.entitlement.sessions_remaining} ครั้ง`}</p>}
    </div>}

    {['expired', 'cancelled'].includes(order.status) && <div className="notice warn">
      <p>คำสั่งซื้อนี้{orderStatusLabels[order.status]} กรุณาเลือกแพ็กเกจและสั่งซื้อใหม่</p></div>}

    {canSendSlip && <SlipForm order={order} slip={slip} onSaved={onChange}/>}

    {slip && <section className="card"><h2>สลิปที่ส่งไว้</h2>
      <dl><dt>เลขอ้างอิง</dt><dd>{slip.reference_no}</dd>
        <dt>เวลาที่โอน</dt><dd>{formatDateTime(slip.transferred_at)}</dd>
        {slip.amount_thb_claimed !== null && <><dt>ยอดที่แจ้ง</dt><dd>{formatPrice(slip.amount_thb_claimed)}</dd></>}</dl>
      <img className="slip-preview" alt="สลิปที่ส่งไว้" src={`/api/slips/${slip.id}/image`}/>
      <button onClick={onReload}>รีเฟรชสถานะ</button></section>}
  </>;
}

function SlipForm({ order, slip, onSaved }) {
  const [file, setFile] = useState(null), [reference, setReference] = useState('');
  const [transferred, setTransferred] = useState(nowForInput());
  const [amount, setAmount] = useState(String(order.price_thb));
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const errors = error?.fields ?? {};

  async function submit(e) {
    e.preventDefault();
    if (!file) { setError(new Error('กรุณาแนบรูปสลิปการโอนเงิน')); return; }
    setBusy(true); setError(null);
    const form = new FormData();
    form.append('slip', file);
    form.append('reference_no', reference);
    form.append('transferred_at', transferred);
    form.append('amount_thb', amount);
    try { onSaved(await upload(`/orders/${order.id}/slip`, form)); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }

  return <section className="card"><h2>{slip ? 'ส่งสลิปใหม่' : 'ส่งสลิปการโอนเงิน'}</h2>
    <form onSubmit={submit}>
      <label className="field">รูปสลิป (JPG, PNG หรือ WEBP ไม่เกิน 5 MB)
        <input type="file" name="slip" accept="image/jpeg,image/png,image/webp"
          onChange={e => { setFile(e.target.files?.[0] ?? null); setError(null); }}/></label>
      <Field name="reference_no" label="เลขอ้างอิงในสลิป" value={reference} onChange={setReference}
        error={errors.reference_no} required maxLength={40} placeholder="เช่น 202609141030ABC"/>
      <label className="field">วันและเวลาที่โอน
        <input type="datetime-local" name="transferred_at" value={transferred}
          onChange={e => setTransferred(e.target.value)} required/>
        {errors.transferred_at && <span className="field-error">{errors.transferred_at}</span>}</label>
      <Field name="amount_thb" label="ยอดที่โอน (บาท)" value={amount} onChange={setAmount}
        error={errors.amount_thb} type="number" min={0} step="0.01"/>
      <p className="fine">เลขอ้างอิงและเวลาโอนช่วยให้พนักงานตรวจกับแอปธนาคารได้เร็วขึ้น</p>
      <Notice error={error}/>
      <button className="primary full" disabled={busy}>{busy ? 'กำลังส่งสลิป…' : 'ส่งสลิป'}</button>
    </form></section>;
}

export function MemberOrderHistory({ onOpen }) {
  const { data, error, busy, reload } = useResource('/orders');
  if (busy) return <p role="status" className="empty">กำลังโหลดประวัติ…</p>;
  if (error) return <><Notice error={error}/><button onClick={() => reload().catch(() => {})}>ลองใหม่</button></>;
  if (!data.items.length) return <p className="muted">ยังไม่มีประวัติการสั่งซื้อ</p>;
  return <div className="member-list">{data.items.map(order =>
    <button key={order.id} className="member-row" onClick={() => onOpen(order.id)}>
      <span className="member-name"><strong>{order.package_name_snapshot}</strong>
        <small>{formatDateTime(order.created_at)} · {formatPrice(order.price_thb)}</small></span>
      <span className={`tag ${order.status === 'paid' ? 'active' : 'draft'}`}>{orderStatusLabels[order.status]}</span>
    </button>)}</div>;
}

export function MemberEntitlements() {
  const { data, error, busy } = useResource('/entitlements');
  if (busy) return <p role="status" className="muted">กำลังโหลดสิทธิ์…</p>;
  if (error) return <Notice error={error}/>;
  if (!data.items.length) {
    return <p className="muted">ยังไม่มีแพ็กเกจที่ใช้งานได้ เลือกซื้อได้ที่แท็บแพ็กเกจ</p>;
  }
  return <dl>{data.items.map(item => <React.Fragment key={item.id}>
    <dt>ใช้ได้ถึง</dt>
    <dd>{formatDateTime(item.expires_at)}
      {item.sessions_remaining !== null && ` · เหลือ ${item.sessions_remaining} จาก ${item.sessions_total} ครั้ง`}</dd>
  </React.Fragment>)}</dl>;
}

// ------------------------------------------------------------- admin: review

export function PaymentReview({ onAuthError, readOnly = false }) {
  const [status, setStatus] = useState('awaiting_review');
  const { data, error, busy, reload } = useResource(`/admin/orders?status=${status}`);
  const [openId, setOpenId] = useState(null), [notice, setNotice] = useState('');

  if (openId) {
    return <ReviewDetail id={openId} onAuthError={onAuthError} readOnly={readOnly} onBack={() => setOpenId(null)}
      onDone={message => { setOpenId(null); setNotice(message); reload().catch(() => {}); }}/>;
  }
  const filters = [['awaiting_review', 'รอตรวจสอบ'], ['paid', 'อนุมัติแล้ว'], ['rejected', 'ถูกปฏิเสธ'], ['all', 'ทั้งหมด']];
  return <>
    <div className="page-heading"><div><span className="eyebrow">ตรวจสลิป</span><h1>คำสั่งซื้อ</h1>
      <p className="muted">เรียงจากที่รอนานที่สุดก่อน</p></div>
      {data && <span className="badge active">รอตรวจสอบ {data.awaiting_review} รายการ</span>}</div>
    {notice && <div className="notice" role="status">{notice}</div>}
    <nav className="tabs" aria-label="กรองตามสถานะ">{filters.map(([key, label]) =>
      <button key={key} onClick={() => setStatus(key)} aria-current={status === key ? 'page' : undefined}>{label}</button>)}</nav>
    <Notice error={error}/>{error && <button onClick={() => reload().catch(() => {})}>ลองใหม่</button>}
    {busy ? <p role="status" className="empty">กำลังโหลดคำสั่งซื้อ…</p> : !error && (
      !data.items.length ? <div className="empty"><h2>ไม่มีรายการในสถานะนี้</h2></div>
        : <section className="card">{data.items.map(order => <button key={order.id} className="member-row"
          onClick={() => { setOpenId(order.id); setNotice(''); }} aria-label={`ตรวจสลิปของ ${order.member_name}`}>
          <span className="member-name"><strong>{order.member_name}</strong>
            <small>{order.package_name_snapshot} · {formatPrice(order.price_thb)} · ส่งเมื่อ {formatDateTime(order.waiting_since)}</small></span>
          <span className={`tag ${order.status === 'paid' ? 'active' : 'draft'}`}>{orderStatusLabels[order.status]}</span>
          <span aria-hidden="true">›</span>
        </button>)}</section>)}
  </>;
}

function ReviewDetail({ id, onBack, onDone, onAuthError, readOnly = false }) {
  const { data, error, busy, reload } = useResource(`/admin/orders/${id}`);
  const [checked, setChecked] = useState(false), [note, setNote] = useState(''), [reason, setReason] = useState('');
  const [working, setWorking] = useState(false), [actionError, setActionError] = useState(null);

  if (busy) return <p role="status" className="empty">กำลังโหลด…</p>;
  if (error) return <><button onClick={onBack}>← กลับ</button><Notice error={error}/></>;

  const { order, slip, member, duplicates, amount_mismatch: mismatch } = data;
  const noteLongEnough = note.trim().length >= MISMATCH_NOTE_MIN;
  async function act(path, body, message) {
    setWorking(true); setActionError(null);
    try { await api(path, { method: 'POST', body: { version: order.version, ...body } }); onDone(message); }
    catch (e) { setActionError(e); onAuthError(e); reload().catch(() => {}); } finally { setWorking(false); }
  }

  return <section className="card"><button onClick={onBack} disabled={working}>← กลับรายการ</button>
    <h1>ตรวจสลิป</h1>
    <div className="review-grid">
      <div>{slip
        ? <a href={`/api/slips/${slip.id}/image`} target="_blank" rel="noreferrer">
            <img className="slip-review" alt="สลิปการโอนเงิน" src={`/api/slips/${slip.id}/image`}/></a>
        : <div className="qr-frame"><span>ยังไม่มีสลิป</span></div>}
        {slip && <p className="fine">คลิกที่รูปเพื่อเปิดขนาดเต็ม</p>}</div>
      <div>
        <dl>
          <dt>สมาชิก</dt><dd>{member.name} · {member.member_code}</dd>
          <dt>ติดต่อ</dt><dd>{member.email}<br/>{formatPhone(member.phone)}</dd>
          <dt>แพ็กเกจ</dt><dd>{order.package_name_snapshot} · {describe(order)}</dd>
          <dt>ยอดที่ต้องได้รับ</dt><dd><strong>{formatPrice(order.price_thb)}</strong></dd>
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
          <label className="check-row"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)}/>
            <span>ตรวจกับแอปธนาคารแล้วว่าเงินเข้าจริงตามยอดและเวลานี้</span></label>
          <div className="actions">
            <button className="primary" disabled={!checked || working || (mismatch && !noteLongEnough)}
              onClick={() => act(`/admin/orders/${order.id}/approve`, { checked_against_bank: true, note }, 'อนุมัติแล้ว')}>
              {working ? 'กำลังบันทึก…' : 'อนุมัติและให้สิทธิ์'}</button>
          </div>
          <p className="fine">ปุ่มอนุมัติจะกดได้เมื่อติ๊กช่องด้านบน เพราะไม่มีข้อมูลจากผู้ให้บริการชำระเงินมายืนยันแทน
            {mismatch ? ' และเมื่อยอดไม่ตรง ต้องเขียนเหตุผลไว้ในประวัติด้วย' : ''}</p>
          <Field name="reason" label="เหตุผลที่ปฏิเสธ" value={reason} onChange={setReason} maxLength={300}/>
          <button className="danger" disabled={!reason.trim() || working}
            onClick={() => act(`/admin/orders/${order.id}/reject`, { reason }, 'ปฏิเสธสลิปแล้ว')}>ปฏิเสธสลิป</button>
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
  if (busy) return <p role="status" className="muted">กำลังโหลดยอดขาย…</p>;
  if (error) return <Notice error={error}/>;
  if (!data.items.length) return <p className="muted">ยังไม่มียอดขายที่อนุมัติแล้ว</p>;
  return <table className="sales"><thead><tr><th>วันที่</th><th>จำนวนคำสั่งซื้อ</th><th>ยอดรวม</th></tr></thead>
    <tbody>{data.items.map(row => <tr key={row.day}>
      <td>{row.day}</td><td>{row.orders.toLocaleString('th-TH')}</td><td>{formatPrice(row.total_thb)}</td>
    </tr>)}</tbody></table>;
}
