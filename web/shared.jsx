import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import Phone from '../shared/phone.cjs';

/**
 * Which of the two apps in this bundle a page is, decided in one place.
 *
 * `main.jsx` uses it to pick the component and this file uses it to name the
 * browser tab. Written twice it becomes possible for a page to render the
 * member's portal while the tab says "จัดการยิม" -- which is what it did
 * (QA BUG-13).
 */
export const MEMBER_PATHS = ['/m/login', '/m/portal'];
export const isMemberApp = (pathname = window.location.pathname) =>
  MEMBER_PATHS.includes(pathname.replace(/\/+$/, ''));

/**
 * Whether the gym is running in pilot mode: no mail provider and no PromptPay
 * account yet, so OTP codes are read out at the counter and packages are handed
 * over by an admin. Several screens change wording or disappear entirely, and
 * one of them is the login screen, which nobody is signed in to see -- hence a
 * context fed from the public config rather than anything on the session.
 */
export const PilotContext = createContext(false);
export const usePilot = () => useContext(PilotContext);

/**
 * The gym's initials, for the square before its name.
 *
 * One placeholder, used in the app bar, on the login screen and on the printed
 * card, so the three never disagree — which they did, with "SF" in the header
 * and "G" on the login card of the same page (QA ข้อ ง). It goes when the owner
 * sends a logo file.
 */
export function initials(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'ยม';
  return words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0];
}

/**
 * The square before the gym's name: its logo if it has sent one, its initials
 * if it has not. One component, so the app bar, the login screen and the scan
 * stage cannot end up showing three different things again.
 */
export const Mark = ({ branding, brand, className = 'mark', style }) => (branding?.logo_url
  ? <span className={`${className} haslogo`} style={style}>
      <img src={branding.logo_url} alt={`โลโก้ของ ${branding.brand ?? brand ?? ''}`}/></span>
  : <span className={className} style={style} aria-hidden="true">
      {branding?.brand_short || initials(brand)}</span>);

/**
 * The gym's own colours, on the page as soon as they are known.
 *
 * Set as CSS variables rather than compiled in, because the owner changes them
 * at the counter and the screen has to follow without a deploy. Every value
 * comes from the server, which is also what draws the card, so the two cannot
 * drift apart.
 */
export function useBranding() {
  const [branding, setBranding] = useState(null);
  const reload = useCallback(() => api('/public/theme').then(setBranding).catch(() => {}), []);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    const theme = branding?.theme;
    if (!theme) return;
    const style = document.documentElement.style;
    // The eight the Designer named, and only those: a ninth token invented
    // here is a colour the card would not know about.
    style.setProperty('--brand', theme.brand);
    style.setProperty('--brand-surface', theme.brand_surface);
    style.setProperty('--on-brand', theme.on_brand);
    style.setProperty('--brand-ink', theme.brand_ink);
    style.setProperty('--brand-soft', theme.brand_soft);
    style.setProperty('--brand-line', theme.brand_line);
    style.setProperty('--brand-2', theme.brand_2);
    style.setProperty('--on-brand-2', theme.on_brand_2);
    // White bar with a brand line under it unless the gym asked for the full
    // colour, which is a choice they make once (Designer, ข้อ 5).
    document.body.dataset.appbar = theme.appbar === 'brand' ? 'brand' : 'light';

    // BUG-08 (QA): the tab said "ยิมของเรา · สมาชิก" and Android painted the
    // top of the screen the old green, because both were baked into
    // index.html before this gym had a name or a colour. Both now come from
    // the same row everything else on screen comes from.
    // The member's tab says what the member opened, not what the staff app is
    // called: "สุขฤทัย ฟิตเนส · จัดการยิม" on a member's phone reads like they
    // landed somewhere they should not be (QA BUG-13).
    const product = isMemberApp() ? 'ช่วยเล่น' : 'จัดการยิม';
    document.title = branding.brand ? `${branding.brand} · ${product}` : `ระบบ${product}`;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme.brand_surface);
  }, [branding]);
  return [branding, reload];
}

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
/**
 * One rule, both products and the server-rendered machine page.
 *
 * Moved into shared/ the day two new customer-facing screens printed the
 * gym's number as 038541029 while every staff screen printed 038-541-029
 * (QA BUG-13): the helper was here, and the server had no way to reach it.
 */
export const formatPhone = Phone.formatPhone;

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
    // Whatever else the server put in the body. A refusal the screen has to
    // ACT on -- which of three mail failures this was, or that a membership
    // expired on the 3rd -- arrives here, and dropping it on the floor forces
    // the screen to guess from the wording of a sentence.
    const { error: _message, fields: _fields, request_id: _id, ...rest } = data ?? {};
    Object.assign(error, rest);
    throw error;
  }
  return data;
}

/** Multipart variant: the browser sets its own Content-Type with the boundary. */
export async function upload(path, formData, method = 'POST') {
  let response;
  try {
    response = await fetch(`/api${path}`, { method, credentials: 'include',
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

export function Field({ label, name, value, onChange, error, hint, children, ...props }) {
  return <div className={`field${error ? ' invalid' : ''}`}>
    <label htmlFor={name}>{label}</label>
    {children
      ? React.cloneElement(children, { id: name, name, value: value ?? '', onChange: e => onChange(e.target.value), 'aria-invalid': !!error })
      : <input id={name} name={name} value={value ?? ''} onChange={e => onChange(e.target.value)}
          aria-invalid={!!error} aria-describedby={error ? `${name}-error` : undefined} {...props}/>}
    {hint && !error && <p className="hint">{hint}</p>}
    {error && <p className="err" id={`${name}-error`}>✕ {error}</p>}
  </div>;
}

export function Notice({ error, children }) {
  if (!error && !children) return null;
  if (!error) return <div className="banner ok"><div className="ic" aria-hidden="true">✓</div><div>{children}</div></div>;
  return <div className="banner bad" role="alert">
    <div className="ic" aria-hidden="true">!</div>
    <div><b>{error.message || error}</b>
      {error.requestId && <span>รหัสอ้างอิงสำหรับแจ้งปัญหา: {error.requestId}</span>}</div>
  </div>;
}

/**
 * The four shapes every screen shows while it has nothing to show, from the
 * Designer's state set. Three rules run through all of them: never leave the
 * screen blank while loading, say why there is nothing rather than only that
 * there is nothing, and always offer the way forward.
 */

/** A grey outline the shape of the thing being fetched, not a spinner. */
export function Skeleton({ rows = 4, avatar = true }) {
  const widths = [['46%', '72%'], ['38%', '64%'], ['52%', '68%'], ['42%', '58%']];
  return <div className="list" aria-busy="true" aria-label="กำลังโหลด">
    {Array.from({ length: rows }, (_, i) =>
      <div className="skel-row" key={i}>
        {avatar && <span className="skel skel-av"/>}
        <span style={{ flex: 1 }}>
          <span className="skel skel-line" style={{ width: widths[i % 4][0], height: 22, display: 'block' }}/>
          <span className="skel skel-line" style={{ width: widths[i % 4][1], display: 'block' }}/>
        </span>
      </div>)}
  </div>;
}

/** What is being waited for, in words, beside the grey shapes. */
export function Loading({ label, rows, avatar }) {
  return <>
    <p className="sub" role="status">{label}</p>
    <Skeleton rows={rows} avatar={avatar}/>
  </>;
}

/**
 * Nothing here, and why. Never only "no results": the Designer's rule is that
 * an empty screen says what to try next and offers the way to do it.
 */
export function Empty({ icon = '🔍', title, children, action }) {
  return <div className="empty">
    <div className="ic" aria-hidden="true">{icon}</div>
    <b>{title}</b>
    <p>{children}</p>
    {action}
  </div>;
}

/**
 * A request that did not come back. Losing the network is not the counter's
 * fault: it is drawn with what to try, a way to try it, and a reminder that
 * nothing was lost -- and never a raw message or a stack trace.
 */
export function StateBox({ error, onRetry, children }) {
  if (!error) return null;
  const offline = !!error.offline;
  return <div className="errbox" role="alert">
    <div className="ic" aria-hidden="true">!</div>
    <b>{offline ? 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' : 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง'}</b>
    <p>{offline
      ? 'อาจเป็นเพราะอินเทอร์เน็ตหลุดชั่วคราว ข้อมูลไม่ได้หายไปไหน ลองอีกครั้งได้เลย'
      : 'ถ้าเกิดซ้ำหลายครั้ง แจ้งทีมติดตั้งพร้อมเวลาที่เกิด'}
      {error.requestId && <span className="note"> (รหัสอ้างอิง: {error.requestId})</span>}</p>
    <div className="btn-row" style={{ justifyContent: 'center', maxWidth: 420, margin: '0 auto' }}>
      {onRetry && <button className="btn primary" onClick={() => onRetry()}>ลองอีกครั้ง</button>}
      {children}
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
