import { useEffect, useRef, useState } from 'react';
import { api } from './shared.jsx';

/**
 * Changing your own password, from the menu, without leaving the screen.
 *
 * A sheet rather than a page for one reason: this is not a journey anybody
 * plans. It is what somebody does in the thirty seconds after being handed a
 * temporary password, standing at the counter, with whatever they were doing
 * still on screen behind them.
 *
 * The old password is asked for even though the person is already signed in.
 * The session is exactly what an unattended tablet hands to a stranger, so
 * "already signed in" is not proof of anything at this particular moment.
 */
export function ChangePassword({ user, onClose, onDone }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const box = useRef(null);

  useEffect(() => { box.current?.querySelector('input')?.focus(); }, []);
  useEffect(() => {
    const onKey = event => { if (event.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const strength = next.length >= 16 ? 3 : next.length >= 12 ? 2 : next ? 1 : 0;

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    // Checked here rather than at the server, because the server cannot tell
    // a mistyped confirmation from a deliberate one and would have to guess.
    if (next !== again) { setFailure(new Error('รหัสผ่านใหม่สองช่องไม่ตรงกัน')); return; }
    setBusy(true); setFailure(null);
    try {
      const result = await api('/auth/change-password', {
        method: 'POST', body: { current_password: current, password: next },
      });
      onDone(result.other_sessions_closed > 0
        ? `เปลี่ยนรหัสผ่านแล้ว · เครื่องอื่นอีก ${result.other_sessions_closed} เครื่องถูกออกจากระบบ`
        : 'เปลี่ยนรหัสผ่านแล้ว');
    } catch (error) { setFailure(error); } finally { setBusy(false); }
  }

  return <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="changepw-title"
    onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className="sheet-in" ref={box} onSubmit={submit}>
      <div className="sheet-h">
        <h2 id="changepw-title">เปลี่ยนรหัสผ่าน</h2>
        <button className="iconbtn" type="button" onClick={onClose} aria-label="ปิด" disabled={busy}>✕</button>
      </div>

      <div className="sheet-b">
        <p className="note" style={{ marginTop: 0 }}>บัญชี <b>{user?.email}</b></p>

        <div className="field">
          <label htmlFor="cur-password">รหัสผ่านเดิม</label>
          <input id="cur-password" type="password" value={current} autoComplete="current-password"
            required disabled={busy} onChange={event => setCurrent(event.target.value)}/>
          {/* Said here rather than after the press: somebody handed a temporary
              password in a chat is about to look for it, and should know now. */}
          <p className="hint">ถ้าเพิ่งได้รหัสชั่วคราวมา ใช้รหัสนั้น</p>
        </div>

        <div className="field">
          <label htmlFor="next-password">รหัสผ่านใหม่</label>
          <input id="next-password" type="password" value={next} autoComplete="new-password"
            required minLength={12} disabled={busy} onChange={event => setNext(event.target.value)}/>
          <div className="pwbar" aria-hidden="true">
            {[1, 2, 3].map(step => <i key={step}
              className={strength >= step ? (strength === 1 ? 'weak' : 'on') : ''}/>)}
          </div>
          <p className="pwhint">อย่างน้อย 12 ตัวอักษร ใช้ประโยคที่จำได้ดีกว่าคำสั้น ๆ ที่มีสัญลักษณ์</p>
        </div>

        <div className={`field${failure ? ' invalid' : ''}`}>
          <label htmlFor="again-password">พิมพ์รหัสผ่านใหม่อีกครั้ง</label>
          <input id="again-password" type="password" value={again} autoComplete="new-password"
            required disabled={busy} onChange={event => setAgain(event.target.value)}/>
          {failure && <p className="err" role="alert">✕ {failure.message}</p>}
        </div>

        <div className="alert warn" style={{ textAlign: 'left' }}>
          <div className="ic" aria-hidden="true">!</div>
          <div><b>เครื่องอื่นที่เข้าไว้จะถูกออกจากระบบ</b>
            <span>เครื่องที่คุณถืออยู่ตอนนี้ไม่ถูกออก ทำงานต่อได้เลย</span></div>
        </div>
      </div>

      <div className="sheet-f">
        <button className="btn ghost" type="button" onClick={onClose} disabled={busy}>ยกเลิก</button>
        <button className="btn primary" disabled={busy || !current || next.length < 12}>
          {busy ? <><span className="spin"/>กำลังบันทึก…</> : 'บันทึกรหัสผ่านใหม่'}</button>
      </div>
    </form>
  </div>;
}
