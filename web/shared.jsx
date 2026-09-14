import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

/**
 * Whether the gym is running in pilot mode: no mail provider and no PromptPay
 * account yet, so OTP codes are read out at the counter and packages are handed
 * over by an admin. Several screens change wording or disappear entirely, and
 * one of them is the login screen, which nobody is signed in to see -- hence a
 * context fed from the public config rather than anything on the session.
 */
export const PilotContext = createContext(false);
export const usePilot = () => useContext(PilotContext);

export const labels = { active: 'ใช้งานอยู่', suspended: 'ถูกระงับ', expired: 'หมดอายุ' };
export const packageStatusLabels = { draft: 'ร่าง ยังไม่เปิดขาย', active: 'เปิดขาย', archived: 'ปิดการขาย' };
export const orderStatusLabels = {
  pending_payment: 'รอชำระเงิน',
  awaiting_review: 'รอตรวจสอบ',
  paid: 'อนุมัติแล้ว',
  rejected: 'ถูกปฏิเสธ',
  expired: 'หมดอายุ',
  cancelled: 'ยกเลิกแล้ว',
};

/** Mirrors the server rule: a mismatched amount needs a written reason. */
export const MISMATCH_NOTE_MIN = 10;

export const formatDate = value => new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' }).format(new Date(value));
export const formatDateTime = value => new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(new Date(value));
const baht = new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB', minimumFractionDigits: 2 });
/** A null price means the gym has not published one yet — never render it as ฿0. */
export const formatPrice = value => (value === null || value === undefined ? null : baht.format(value));
export const formatPhone = value => (value ? value.replace(/^(0\d{1,2})(\d{3})(\d{3,4})$/, '$1-$2-$3') : null);

export async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, { ...options, credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Gym-Client': 'web' },
      body: options.body ? JSON.stringify(options.body) : undefined });
  } catch (cause) {
    // fetch only rejects when the request never got an answer. The browser's
    // own wording for that is English ("Failed to fetch"), so replace it.
    if (cause.name === 'AbortError') throw cause;
    const error = new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจอินเทอร์เน็ตแล้วกดลองใหม่');
    error.offline = true;
    throw error;
  }
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง');
    error.fields = data.fields; error.status = response.status; error.requestId = data.request_id;
    throw error;
  }
  return data;
}

/** Multipart variant: the browser sets its own Content-Type with the boundary. */
export async function upload(path, formData) {
  let response;
  try {
    response = await fetch(`/api${path}`, { method: 'POST', credentials: 'include',
      headers: { 'X-Gym-Client': 'web' }, body: formData });
  } catch {
    const error = new Error('อัปโหลดไม่สำเร็จ เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจอินเทอร์เน็ตแล้วลองใหม่');
    error.offline = true;
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง');
    error.fields = data.fields; error.status = response.status; error.requestId = data.request_id;
    throw error;
  }
  return data;
}

export function Field({ label, name, value, onChange, error, children, ...props }) {
  return <label className="field">{label}
    {children
      ? React.cloneElement(children, { name, value: value ?? '', onChange: e => onChange(e.target.value), 'aria-invalid': !!error })
      : <input name={name} value={value ?? ''} onChange={e => onChange(e.target.value)}
          aria-invalid={!!error} aria-describedby={error ? `${name}-error` : undefined} {...props}/>}
    {error && <span className="field-error" id={`${name}-error`}>{error}</span>}</label>;
}

export function Notice({ error }) {
  if (!error) return null;
  return <div className="notice error" role="alert">
    {error.message || error}
    {error.requestId && <span className="fine"> (รหัสอ้างอิงสำหรับแจ้งปัญหา: {error.requestId})</span>}
  </div>;
}

/**
 * The four shapes every screen shows while it has nothing to show, from the
 * Designer's state set. Three rules run through all of them: never leave the
 * screen blank while loading, say why there is nothing rather than only that
 * there is nothing, and always offer the way forward.
 */

/** A grey outline the shape of the thing being fetched, not a spinner. */
export function Skeleton({ rows = 3, avatar = false }) {
  return <div aria-hidden="true">{Array.from({ length: rows }, (_, i) =>
    <div className="sk-row" key={i}>
      {avatar && <span className="skeleton sk-avatar"/>}
      <span style={{ flex: 1 }}>
        <span className="skeleton sk-line t" style={{ display: 'block' }}/>
        <span className="skeleton sk-line s xs" style={{ display: 'block' }}/>
      </span>
    </div>)}</div>;
}

/** Cards rather than rows: the catalogue and the package screens load into this. */
export function SkeletonCards({ count = 2 }) {
  return <div aria-hidden="true">{Array.from({ length: count }, (_, i) =>
    <div className="card" key={i}>
      <span className="skeleton sk-line t" style={{ display: 'block' }}/>
      <span className="skeleton sk-line s" style={{ display: 'block' }}/>
      <span className="skeleton sk-line xs" style={{ display: 'block' }}/>
    </div>)}</div>;
}

/** What is being waited for, in words, under the grey shapes. */
export function Loading({ label, rows, cards, avatar }) {
  return <>
    {cards ? <SkeletonCards count={cards}/> : <Skeleton rows={rows} avatar={avatar}/>}
    <p className="loading-note" role="status">{label}</p>
  </>;
}

/**
 * Nothing here, and why. An empty queue is a good state and gets no button; an
 * empty list somebody can fill gets exactly one.
 */
export function Empty({ title, children, action }) {
  return <div className="empty"><b>{title}</b><p>{children}</p>{action}</div>;
}

/**
 * A request that did not come back. Losing the network is not the system's
 * fault and is drawn in the warning colour with what the member should try;
 * anything else is an error, and never shows a raw message or a stack trace.
 */
export function StateBox({ error, onRetry, children }) {
  if (!error) return null;
  const offline = !!error.offline;
  return <div className={`state-box ${offline ? 'offline' : 'error'}`} role="alert">
    <div>
      <h3>{offline ? 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' : 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง'}</h3>
      <p>{offline
        ? 'กรุณาตรวจอินเทอร์เน็ตแล้วกดลองใหม่ ข้อมูลที่กรอกไว้ยังอยู่ ไม่ต้องกรอกซ้ำ'
        : 'ถ้ายังไม่ได้ กรุณาติดต่อพนักงานที่เคาน์เตอร์หรือทาง LINE'}
        {error.requestId && <span className="fine"> (รหัสอ้างอิงสำหรับแจ้งปัญหา: {error.requestId})</span>}</p>
      {children}
      {onRetry && <button onClick={() => onRetry()}>ลองใหม่</button>}
    </div>
  </div>;
}

/** Loads a resource, exposing the three states every screen has to render. */
export function useResource(path, enabled = true) {
  const [state, setState] = useState({ data: null, error: null, busy: enabled });
  const reload = useCallback(async () => {
    setState(s => ({ ...s, busy: true, error: null }));
    try { const data = await api(path); setState({ data, error: null, busy: false }); return data; }
    catch (e) { setState({ data: null, error: e, busy: false }); throw e; }
  }, [path]);
  useEffect(() => { if (enabled) reload().catch(() => {}); }, [reload, enabled]);
  return { ...state, reload, setData: data => setState(s => ({ ...s, data })) };
}

/** Minutes and seconds left, recomputed every second, floored at zero. */
export function useCountdown(deadline) {
  const [left, setLeft] = useState(() => (deadline ? Math.max(0, deadline - Date.now()) : 0));
  useEffect(() => {
    if (!deadline) return undefined;
    setLeft(Math.max(0, deadline - Date.now()));
    const timer = setInterval(() => setLeft(Math.max(0, deadline - Date.now())), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  const total = Math.floor(left / 1000);
  return {
    // No deadline means nothing to count down, not something that ran out.
    expired: Boolean(deadline) && left <= 0,
    text: `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`,
  };
}
