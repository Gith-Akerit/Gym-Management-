import React, { useCallback, useEffect, useState } from 'react';

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

export const formatDate = value => new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' }).format(new Date(value));
export const formatDateTime = value => new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(new Date(value));
const baht = new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB', minimumFractionDigits: 2 });
/** A null price means the gym has not published one yet — never render it as ฿0. */
export const formatPrice = value => (value === null || value === undefined ? null : baht.format(value));
export const formatPhone = value => (value ? value.replace(/^(0\d{1,2})(\d{3})(\d{3,4})$/, '$1-$2-$3') : null);

export async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { ...options, credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-Gym-Client': 'web' },
    body: options.body ? JSON.stringify(options.body) : undefined });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) { const error = new Error(data.error || 'ระบบขัดข้อง'); error.fields = data.fields; error.status = response.status; throw error; }
  return data;
}

/** Multipart variant: the browser sets its own Content-Type with the boundary. */
export async function upload(path, formData) {
  const response = await fetch(`/api${path}`, { method: 'POST', credentials: 'include',
    headers: { 'X-Gym-Client': 'web' }, body: formData });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || 'ระบบขัดข้อง'); error.fields = data.fields; error.status = response.status; throw error; }
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
  return error && <div className="notice error" role="alert">{error.message || error}</div>;
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
