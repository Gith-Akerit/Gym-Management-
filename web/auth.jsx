import { useEffect, useState } from 'react';
import { api, Field } from './shared.jsx';

/**
 * Everything that happens before somebody is signed in.
 *
 * One stage, many panels (Designer): the logo, the gym's name and a card, with
 * only the inside of the card changing. Somebody walking from sign-up to
 * "check your email" to "waiting for approval" should feel they stayed in one
 * place rather than being thrown between three screens.
 *
 * Two rules run through all of it. Nothing here ever reveals whether an
 * address has an account -- every answer is the same sentence whatever is
 * true. And the ink on the stage comes from `--on-brand-2`, never from white
 * and never through `opacity`, because the stage is the gym's own colour.
 */

/** The official Google mark. Drawing one by hand breaks their brand terms. */
const GoogleMark = () => <svg className="g" viewBox="0 0 48 48" aria-hidden="true">
  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
  <path fill="none" d="M0 0h48v48H0z"/>
</svg>;

/** The stage every panel sits on. */
const Stage = ({ brand, branding, title, children, help = true }) =>
  <div className="authstage">
    <div className="authbox">
      <div className="authtop">
        <span className="mk">
          {branding?.logo_url
            ? <img src={branding.logo_url} alt={`โลโก้ของ ${brand}`}/>
            : <span>{branding?.brand_short || 'ยม'}</span>}
        </span>
        <h1>{brand}</h1>
        <p>{title}</p>
      </div>
      <div className="authcard">{children}</div>
      {help && branding?.phone && <p className="authhelp">
        ติดปัญหา โทรหายิมได้ที่ <b>{branding.phone}</b></p>}
    </div>
  </div>;

/** A result panel: a round icon, a sentence, and something to do next. */
const Result = ({ tone = 'mail', icon, title, children, actions }) => <div className="authres">
  <div className={`ic ${tone}`} aria-hidden="true">{icon}</div>
  <h2>{title}</h2>
  {children}
  {actions}
</div>;

export function AuthScreens({ brand, branding, onLogin, initialPanel = 'login' }) {
  // Whether this gym takes sign-ups from the front door at all. Off is the
  // normal answer and the one this gym gave: the four people who work here
  // were given accounts, and a public form that puts strangers in an approval
  // queue is a thing to decide to have. Everything behind it still exists --
  // the flag turns the door back on -- so a gym that wants it gets the whole
  // journey, queue and letters included, without another release.
  const open = branding?.self_signup !== false;
  const [panel, setPanel] = useState(initialPanel);
  const [sentTo, setSentTo] = useState('');
  const [rejectReason, setRejectReason] = useState('');

  const show = (next, detail = {}) => {
    if (detail.email !== undefined) setSentTo(detail.email);
    if (detail.reason !== undefined) setRejectReason(detail.reason);
    setPanel(next);
  };

  if (panel === 'signup' && open) {
    return <Stage brand={brand} branding={branding} title="ขอบัญชีพนักงาน">
      <SignUpPanel branding={branding} onSent={email => show('verify-sent', { email })}
        onCancel={() => show('login')}/>
    </Stage>;
  }

  if (panel === 'verify-sent') {
    return <Stage brand={brand} branding={branding} title="ขอบัญชีพนักงาน">
      <Result icon="✉" title="ส่งอีเมลยืนยันแล้ว">
        <p>เปิดกล่องจดหมายของ</p>
        <div className="mailto">{sentTo}</div>
        <p>แล้วกดลิงก์ในอีเมลเพื่อยืนยันว่าเป็นอีเมลของคุณจริง</p>
        <div className="nextsteps">
          <b>หลังจากนั้นจะเกิดอะไรขึ้น</b>
          <ol>
            <li>กดลิงก์ในอีเมลเพื่อยืนยัน</li>
            <li>เจ้าของยิมตรวจคำขอและกำหนดสิทธิ์ให้</li>
            <li>ได้รับอีเมลแจ้งผล แล้วเข้าสู่ระบบด้วยรหัสผ่านที่ตั้งไว้</li>
          </ol>
        </div>
        <p className="note">ไม่พบอีเมล ลองดูในโฟลเดอร์จดหมายขยะ · ระหว่างนี้ยังเข้าใช้งานไม่ได้</p>
      </Result>
      <button className="btn" onClick={() => show('login')}>กลับไปหน้าเข้าสู่ระบบ</button>
    </Stage>;
  }

  if (panel === 'pending') {
    return <Stage brand={brand} branding={branding} title="คำขอของคุณ">
      {/* The riskiest panel in the set: the one somebody telephones about.
          It says plainly that nothing has gone wrong yet (Designer). */}
      <Result tone="wait" icon="⏳" title="รอเจ้าของยิมอนุมัติ">
        <p><b>คำขอของคุณยังไม่ถูกปฏิเสธ</b> แค่ยังไม่มีใครกดอนุมัติ</p>
        <div className="nextsteps">
          <b>ตอนนี้อยู่ขั้นไหน</b>
          <ol>
            <li>ส่งคำขอแล้ว ✓</li>
            <li>ยืนยันอีเมลแล้ว ✓</li>
            <li>เจ้าของยิมกำลังจะกดอนุมัติและกำหนดสิทธิ์</li>
          </ol>
        </div>
        <p className="note">เมื่ออนุมัติแล้วจะมีอีเมลแจ้ง แล้วเข้าสู่ระบบด้วยรหัสผ่านเดิมได้ทันที</p>
      </Result>
      {branding?.phone && <a className="btn primary xl" href={`tel:${branding.phone}`}>
        โทรหายิม {branding.phone}</a>}
      <button className="btn" style={{ marginTop: 'var(--sp-3)' }}
        onClick={() => show('login')}>กลับไปหน้าเข้าสู่ระบบ</button>
    </Stage>;
  }

  if (panel === 'rejected') {
    return <Stage brand={brand} branding={branding} title="คำขอของคุณ">
      <Result tone="stop" icon="✕" title="คำขอไม่ได้รับอนุมัติ">
        <p>เจ้าของยิมไม่ได้อนุมัติคำขอเข้าใช้งานนี้</p>
        {rejectReason && <div className="nextsteps"><b>เหตุผลที่ได้รับ</b>
          <p style={{ margin: 0 }}>{rejectReason}</p></div>}
        <p className="note">ถ้าคิดว่าเป็นความเข้าใจผิด ติดต่อเจ้าของยิมได้โดยตรง</p>
      </Result>
      {branding?.phone && <a className="btn primary xl" href={`tel:${branding.phone}`}>
        โทรหายิม {branding.phone}</a>}
      <button className="btn" style={{ marginTop: 'var(--sp-3)' }}
        onClick={() => show('login')}>กลับไปหน้าเข้าสู่ระบบ</button>
    </Stage>;
  }

  if (panel === 'forgot') {
    return <Stage brand={brand} branding={branding} title="ลืมรหัสผ่าน">
      <ForgotPanel mailReady={branding?.mail_ready !== false} phone={branding?.phone}
        onSent={email => show('reset-sent', { email })} onCancel={() => show('login')}/>
    </Stage>;
  }

  if (panel === 'reset-sent') {
    return <Stage brand={brand} branding={branding} title="ลืมรหัสผ่าน">
      {/* The same sentence whatever is true, because the server answers the
          same way and a screen that hinted otherwise would give it away. */}
      <Result icon="✉" title="ถ้ามีบัญชีนี้อยู่ เราส่งอีเมลไปแล้ว">
        <div className="mailto">{sentTo}</div>
        <p>เปิดกล่องจดหมายแล้วกดลิงก์ในอีเมลเพื่อตั้งรหัสผ่านใหม่</p>
        <div className="nextsteps">
          <b>ข้อควรรู้</b>
          <ol>
            <li>ลิงก์ใช้ได้ <b>30 นาที</b> และใช้ได้ครั้งเดียว</li>
            <li>ถ้าไม่พบอีเมล ลองดูในโฟลเดอร์จดหมายขยะ</li>
            <li>ตั้งรหัสใหม่แล้วจะถูกออกจากระบบทุกเครื่อง</li>
          </ol>
        </div>
      </Result>
      <button className="btn" onClick={() => show('login')}>กลับไปหน้าเข้าสู่ระบบ</button>
    </Stage>;
  }

  return <Stage brand={brand} branding={branding} title="สำหรับพนักงานและเจ้าของยิมเท่านั้น">
    <LoginPanel open={open} phone={branding?.phone} mailReady={branding?.mail_ready !== false} onLogin={onLogin} onForgot={() => show('forgot')} onSignup={() => show('signup')}
      onPending={() => show('pending')} onRejected={reason => show('rejected', { reason })}/>
  </Stage>;
}

function LoginPanel({ open, phone, mailReady, onLogin, onForgot, onSignup, onPending, onRejected }) {
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError(null);
    try { onLogin(await api('/auth/login', { method: 'POST', body: { email, password } })); }
    catch (failure) {
      // The two answers that are not really errors: the account exists and the
      // password was right, it is just not open yet. Those get their own panel
      // rather than a red line under a form (Designer).
      if (/รอเจ้าของยิมอนุมัติ/.test(failure.message)) return onPending();
      if (/ไม่ได้รับอนุมัติ/.test(failure.message)) {
        return onRejected((/\((.+)\)/.exec(failure.message) ?? [])[1] ?? '');
      }
      setError(failure);
    } finally { setBusy(false); }
  }

  return <>
    <form onSubmit={submit}>
      <Field label="อีเมล" name="email" type="email" value={email} onChange={setEmail}
        required autoComplete="username" disabled={busy}/>
      <div className={`field${error ? ' invalid' : ''}`}>
        <label htmlFor="password">รหัสผ่าน</label>
        <input id="password" name="password" type="password" value={password} autoComplete="current-password"
          required disabled={busy} aria-invalid={!!error} aria-describedby={error ? 'password-error' : undefined}
          onChange={event => setPassword(event.target.value)}/>
        {error && <p className="err" id="password-error" role="alert">✕ {error.message}</p>}
      </div>
      <button className="authlink" type="button" onClick={onForgot}
        style={{ background: 'none', border: 0, cursor: 'pointer', marginLeft: 'auto' }}>ลืมรหัสผ่าน</button>
      <button className="btn primary xl" disabled={busy} aria-disabled={busy || undefined}>
        {busy ? <><span className="spin"/>กำลังเข้าสู่ระบบ…</> : 'เข้าสู่ระบบ'}</button>
    </form>

    {/* Everything below this line belongs to the sign-up door. With it shut,
        the card holds exactly two things -- the form and the way back in when
        a password is forgotten -- rather than two dead buttons explaining
        themselves. */}
    {!open ? null : <>
    <div className="orline">หรือ</div>
    {/* "ดำเนินการต่อ" rather than "เข้าสู่ระบบ": somebody with no account will
        press this too, and they should land on the waiting panel rather than
        on an error telling them they do not exist (Designer). */}
    <button className="gbtn" type="button" disabled aria-disabled="true"
      title="กำลังพัฒนา จะเปิดใช้ในรอบถัดไป">
      <GoogleMark/>ดำเนินการต่อด้วย Google
    </button>
    <p className="note" style={{ textAlign: 'center', marginTop: 'var(--sp-2)', fontSize: 'var(--fs-14)' }}>
      กำลังพัฒนา จะเปิดใช้ในรอบถัดไป</p>

    <div className="authfoot">
      ยังไม่มีบัญชี{' '}
      <button type="button" onClick={onSignup}
        style={{ background: 'none', border: 0, cursor: 'pointer', font: 'inherit', color: 'var(--brand-ink)', fontWeight: 700 }}>
        ขอบัญชีพนักงาน</button>
    </div>
    </>}

    {/* Designer: with the sign-up door shut, somebody who opens this page
        without an account hunts for a button that is not there and gives up.
        The gap has to be filled with the answer, not left silent. */}
    {!open && <div className="authfoot">
      บัญชีพนักงานออกให้โดยเจ้าของยิมเท่านั้น
      {phone && <> · ต้องการบัญชีใหม่ โทร <b>{phone}</b></>}
      {/* Until the gym fills in its mailbox, "ลืมรหัสผ่าน" posts nothing --
          so the way back in is named here rather than discovered by waiting
          for a letter that never arrives (QA). */}
      {!mailReady && <><br/>ลืมรหัสผ่าน ให้เจ้าของยิมสร้างลิงก์ตั้งรหัสผ่านให้จากหน้า “ผู้ใช้และสิทธิ์”</>}
    </div>}
  </>;
}

function SignUpPanel({ branding, onSent, onCancel }) {
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '', invite_code: '' });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const set = key => value => setForm(current => ({ ...current, [key]: value }));
  const strength = form.password.length >= 16 ? 3 : form.password.length >= 12 ? 2 : form.password ? 1 : 0;

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setFailure(null);
    try { await api('/auth/signup', { method: 'POST', body: form }); onSent(form.email); }
    catch (error) { setFailure(error); } finally { setBusy(false); }
  }

  return <form onSubmit={submit}>
    <h2>ขอบัญชีพนักงาน</h2>
    <p className="lead">บัญชีนี้สำหรับพนักงานและเจ้าของยิม — สมาชิกที่มาออกกำลังกายใช้บัตรที่ได้รับตอนสมัคร
      ไม่ต้องมีบัญชี</p>

    <Field label="ชื่อ–นามสกุล" name="signup-name" value={form.name} onChange={set('name')}
      required maxLength={120} disabled={busy} error={failure?.fields?.name}
      hint="เจ้าของยิมใช้ชื่อนี้ดูว่าใครเป็นคนขอ"/>
    <Field label="อีเมล" name="signup-email" type="email" value={form.email} onChange={set('email')}
      required autoComplete="username" disabled={busy} error={failure?.fields?.email}/>
    <Field label="เบอร์มือถือ" name="signup-phone" type="tel" value={form.phone} onChange={set('phone')}
      required disabled={busy} error={failure?.fields?.phone} placeholder="08xxxxxxxx"/>
    <div className="field">
      <label htmlFor="signup-password">ตั้งรหัสผ่าน</label>
      <input id="signup-password" name="signup-password" type="password" required minLength={12}
        autoComplete="new-password" disabled={busy} value={form.password}
        onChange={event => set('password')(event.target.value)}/>
      <div className="pwbar" aria-hidden="true">
        {[1, 2, 3].map(step => <i key={step}
          className={strength >= step ? (strength === 1 ? 'weak' : 'on') : ''}/>)}
      </div>
      <p className="pwhint">อย่างน้อย 12 ตัวอักษร · ใช้รหัสนี้เข้าสู่ระบบทันทีที่ได้รับอนุมัติ</p>
      {failure?.fields?.password && <p className="err" role="alert">✕ {failure.fields.password}</p>}
    </div>

    {branding?.needs_invite_code && <Field label="รหัสเชิญของยิม" name="signup-invite"
      value={form.invite_code} onChange={set('invite_code')} disabled={busy} maxLength={60}
      hint="ยิมนี้ต้องใช้รหัสเชิญ ขอได้จากเจ้าของยิมหรือหัวหน้างาน"/>}

    {failure && !failure.fields && <div className="alert err" role="alert">
      <div className="ic" aria-hidden="true">✕</div><div><b>{failure.message}</b></div></div>}

    <button className="btn primary xl" disabled={busy} aria-disabled={busy || undefined}>
      {busy ? <><span className="spin"/>กำลังส่งคำขอ…</> : 'ส่งคำขอ'}</button>
    <button className="btn" type="button" onClick={onCancel} disabled={busy}
      style={{ marginTop: 'var(--sp-3)' }}>ยกเลิก</button>
  </form>;
}

function ForgotPanel({ mailReady, phone, onSent, onCancel }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setFailure(null);
    try { await api('/auth/forgot', { method: 'POST', body: { email } }); onSent(email); }
    catch (error) { setFailure(error); } finally { setBusy(false); }
  }

  return <form onSubmit={submit}>
    <h2>ลืมรหัสผ่าน</h2>
    <p className="lead">กรอกอีเมลที่ใช้เข้าสู่ระบบ เราจะส่งลิงก์ตั้งรหัสผ่านใหม่ไปให้</p>
    {/* QA จุดสะดุด 6: the screen has to say which of the two worlds this gym is
        in. Sending somebody to a form that will silently post nothing is worse
        than telling them to telephone -- they wait for a letter that is never
        coming. */}
    {!mailReady && <div className="alert warn" role="status">
      <div className="ic" aria-hidden="true">!</div>
      <div><b>ยิมนี้ยังไม่ได้ตั้งค่าการส่งอีเมล</b>
        <span>กดส่งได้ตามปกติ แต่ตอนนี้จะยังไม่มีจดหมายออก — ให้ติดต่อเจ้าของยิม
          {phone ? ` ที่ ${phone} ` : ' '}เพื่อขอลิงก์ตั้งรหัสผ่าน เจ้าของยิมสร้างให้ได้จากหน้า “ผู้ใช้และสิทธิ์”</span></div>
    </div>}
    <Field label="อีเมล" name="forgot-email" type="email" value={email} onChange={setEmail}
      required autoComplete="username" disabled={busy} error={failure?.fields?.email}/>
    {failure && !failure.fields && <div className="alert err" role="alert">
      <div className="ic" aria-hidden="true">✕</div><div><b>{failure.message}</b></div></div>}
    <button className="btn primary xl" disabled={busy} aria-disabled={busy || undefined}>
      {busy ? <><span className="spin"/>กำลังส่ง…</> : 'ส่งลิงก์ตั้งรหัสผ่านใหม่'}</button>
    <button className="btn" type="button" onClick={onCancel} disabled={busy}
      style={{ marginTop: 'var(--sp-3)' }}>กลับไปหน้าเข้าสู่ระบบ</button>
  </form>;
}

/**
 * The panel the verification link opens.
 *
 * It grants nothing -- the account still waits for the owner -- so it says so
 * rather than implying the person is now in.
 */
export function VerifyEmail({ brand, branding, token, onDone }) {
  const [state, setState] = useState({ busy: true });
  useEffect(() => {
    api(`/auth/verify/${token}`)
      .then(result => setState({ busy: false, result }))
      .catch(error => setState({ busy: false, error }));
  }, [token]);

  return <Stage brand={brand} branding={branding} title="ยืนยันอีเมล">
    {state.busy && <Result icon="…" title="กำลังตรวจสอบลิงก์…"><p>รอสักครู่</p></Result>}
    {state.error && <>
      <Result tone="stop" icon="!" title="ลิงก์นี้ใช้ไม่ได้แล้ว">
        <p>{state.error.message}</p>
        <p className="note">ลิงก์ยืนยันใช้ได้ครั้งเดียวและหมดอายุใน 24 ชั่วโมง
          ขอลิงก์ใหม่ได้จากเจ้าของยิม</p>
      </Result>
      <button className="btn primary xl" onClick={onDone}>ไปหน้าเข้าสู่ระบบ</button>
    </>}
    {state.result && <>
      <Result tone="done" icon="✓" title="ยืนยันอีเมลแล้ว">
        <p>ขั้นต่อไปคือเจ้าของยิมกดอนุมัติและกำหนดสิทธิ์ให้</p>
        <p className="note">เมื่ออนุมัติแล้วจะมีอีเมลแจ้ง แล้วเข้าสู่ระบบด้วยรหัสผ่านที่ตั้งไว้ได้ทันที</p>
      </Result>
      <button className="btn primary xl" onClick={onDone}>ไปหน้าเข้าสู่ระบบ</button>
    </>}
  </Stage>;
}

export { Stage as AuthStage, Result as AuthResult };
