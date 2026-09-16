import { useEffect, useState } from 'react';
import { api, Field, formatDateTime, Loading, Notice, StateBox, useResource } from './shared.jsx';

/**
 * Where the gym owner turns email on.
 *
 * The gym already has a mailbox on Office 365 that staff read, so the letters
 * go out through that rather than a third-party service: no new account, no
 * bill, and the member sees an address they would recognise.
 *
 * Two things shape this screen. The password is typed here and never shown
 * back -- there is no route in the system that returns it -- so the form has
 * to say "มีรหัสผ่านอยู่แล้ว" instead of filling the box with dots that would
 * be a lie. And the only honest proof that it works is a letter that actually
 * arrives, so the button sends one, to the person pressing it, and reports
 * what the mail server really said.
 */
export function MailSettings({ onAuthError, onSaved }) {
  const { data, error, busy, reload } = useResource('/gym/mail-settings');
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false), [failure, setFailure] = useState(null);
  const [testing, setTesting] = useState(false), [test, setTest] = useState(null);

  useEffect(() => {
    if (!data) return;
    setForm({
      host: data.host, port: String(data.port), username: data.username,
      from_email: data.from_email, from_name: data.from_name,
      // Absent means "leave the stored one alone". Empty string is a different
      // instruction and the screen never sends it by accident.
      password: null,
    });
  }, [data]);

  if (busy || !form) return <><h1>ตั้งค่าอีเมล</h1><p className="sub">กำลังโหลด…</p>
    <Loading label="กำลังโหลดการตั้งค่าอีเมล…" rows={3}/></>;
  if (error) return <><h1>ตั้งค่าอีเมล</h1><StateBox error={error} onRetry={() => reload().catch(() => {})}/></>;

  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const changed = form.host !== data.host || form.port !== String(data.port)
    || form.username !== data.username || form.from_email !== data.from_email
    || form.from_name !== data.from_name || form.password !== null;

  async function save() {
    setSaving(true); setFailure(null); setTest(null);
    try {
      await api('/gym/mail-settings', { method: 'PUT', body: {
        host: form.host, port: Number(form.port), starttls: true,
        username: form.username, from_email: form.from_email, from_name: form.from_name,
        ...(form.password === null ? {} : { password: form.password }),
        version: data.version,
      } });
      await reload();
      setForm(current => ({ ...current, password: null }));
      onSaved?.('บันทึกการตั้งค่าอีเมลแล้ว');
    } catch (e) { setFailure(e); onAuthError(e); } finally { setSaving(false); }
  }

  async function sendTest() {
    setTesting(true); setTest(null); setFailure(null);
    try {
      const result = await api('/gym/mail-settings/test', { method: 'POST', body: {} });
      setTest({ ok: true, message: result.message });
      await reload();
    } catch (e) {
      setTest({ ok: false, message: e.message });
      onAuthError(e);
      await reload().catch(() => {});
    } finally { setTesting(false); }
  }

  return <>
    <h1>ตั้งค่าอีเมล</h1>
    <p className="sub">กล่องจดหมายที่ระบบใช้ส่งออก · ใช้ส่งลิงก์ลืมรหัสผ่าน และส่งบัตรสมาชิกให้ลูกค้า</p>

    {/* Without the key there is nowhere safe to put the password, and a form
        that accepted one anyway would be storing it in the clear. Says the
        exact command rather than "contact your administrator". */}
    {!data.key_ready && <div className="banner bad" role="alert">
      <div className="ic" aria-hidden="true">!</div>
      <div><b>เครื่องนี้ยังไม่พร้อมเก็บรหัสผ่านอย่างปลอดภัย</b>
        <span>ผู้ดูแลเครื่องต้องตั้งค่า <code>SETTINGS_ENC_KEY</code> ใน <code>.env</code> แล้วรีสตาร์ตก่อน
          จึงจะกรอกหน้านี้ได้ · วิธีทำอยู่ใน <code>docs/deploy.md</code></span></div>
    </div>}

    {data.key_ready && (data.ready
      ? <div className="banner ok" role="status">
          <div className="ic" aria-hidden="true">✓</div>
          <div><b>ระบบส่งอีเมลได้แล้ว</b>
            <span>{data.tested_at
              ? `ทดสอบล่าสุด ${formatDateTime(data.tested_at)} · ${data.test_ok ? 'สำเร็จ' : `ไม่สำเร็จ — ${data.test_detail}`}`
              : 'ยังไม่เคยกดส่งทดสอบ กดปุ่มด้านล่างเพื่อพิสูจน์ว่าส่งออกได้จริง'}</span></div>
        </div>
      : <div className="banner bad" role="status">
          <div className="ic" aria-hidden="true">!</div>
          <div><b>ยังส่งอีเมลไม่ได้</b>
            <span>ระหว่างนี้ระบบทำงานได้ตามปกติทุกอย่าง แค่ไม่มีจดหมายออกไป —
              ลิงก์ตั้งรหัสผ่านให้พนักงาน สร้างได้เองที่หน้า “ผู้ใช้และสิทธิ์” แล้วส่งให้เขาทางอื่น</span></div>
        </div>)}

    <div className="block" style={{ marginTop: 'var(--sp-5)' }}>
      <h2>กล่องจดหมายของยิม</h2>
      <p className="note">ค่าเริ่มต้นเป็นของ Office 365 ซึ่งเป็นของที่ยิมนี้ใช้อยู่ ไม่ต้องแก้ถ้าไม่ได้ย้ายผู้ให้บริการ</p>
      <div className="two">
        <Field name="mail-host" label="เซิร์ฟเวอร์อีเมล (SMTP)" value={form.host}
          onChange={value => set('host', value)} disabled={!data.key_ready}
          error={failure?.fields?.host}/>
        <Field name="mail-port" label="พอร์ต" value={form.port} inputMode="numeric"
          onChange={value => set('port', value)} disabled={!data.key_ready}
          error={failure?.fields?.port} hint="587 คือ STARTTLS ซึ่งเป็นค่าที่ Office 365 ใช้"/>
      </div>

      <Field name="mail-username" label="ชื่อผู้ใช้ (อีเมลที่ใช้ล็อกอินกล่องนี้)" type="email"
        value={form.username} onChange={value => set('username', value)}
        disabled={!data.key_ready} autoComplete="off" error={failure?.fields?.username}
        placeholder="info@suklutai.co.th"/>

      <div className="field">
        <label htmlFor="mail-password">รหัสผ่านของกล่องจดหมาย</label>
        {form.password === null
          ? <div className="btn-row" style={{ alignItems: 'center' }}>
              <span className={`chip ${data.has_password ? 'ok' : 'bad'}`} style={{ marginRight: 8 }}>
                {data.has_password ? '✓ ตั้งไว้แล้ว' : '✕ ยังไม่ได้ตั้ง'}</span>
              <button className="btn ghost auto" type="button" disabled={!data.key_ready}
                onClick={() => set('password', '')}>
                {data.has_password ? 'เปลี่ยนรหัสผ่าน' : 'กรอกรหัสผ่าน'}</button>
            </div>
          : <>
              <input id="mail-password" type="password" value={form.password} autoComplete="new-password"
                onChange={event => set('password', event.target.value)}/>
              <button className="btn ghost auto" type="button" style={{ marginTop: 8 }}
                onClick={() => set('password', null)}>ยกเลิกการเปลี่ยนรหัสผ่าน</button>
            </>}
        {/* The one thing that costs a day if nobody says it: Microsoft refuses
            an ordinary password on a mailbox with two-step verification, and
            the refusal reads like a wrong password. */}
        <p className="hint">ถ้ากล่องนี้เปิดยืนยันตัวตนสองขั้น ต้องใช้ <b>App password</b> ไม่ใช่รหัสปกติ ·
          รหัสถูกเก็บแบบเข้ารหัสไว้บนเครื่อง และไม่มีหน้าจอไหนแสดงกลับมาอีก</p>
        {failure?.fields?.password && <p className="err" role="alert">✕ {failure.fields.password}</p>}
      </div>

      <h2 style={{ marginTop: 'var(--sp-6)' }}>ผู้รับเห็นอะไร</h2>
      <div className="two">
        <Field name="mail-from" label="อีเมลผู้ส่ง" type="email" value={form.from_email}
          onChange={value => set('from_email', value)} disabled={!data.key_ready}
          error={failure?.fields?.from_email}
          hint="ปกติเป็นอีเมลเดียวกับชื่อผู้ใช้ กล่องอื่นจะถูกปฏิเสธ"/>
        <Field name="mail-from-name" label="ชื่อผู้ส่ง (ไม่บังคับ)" value={form.from_name}
          onChange={value => set('from_name', value)} disabled={!data.key_ready}
          error={failure?.fields?.from_name}
          hint="เว้นว่างไว้ ระบบใช้ชื่อยิมให้เอง"/>
      </div>

      <Notice error={failure}/>
      <div className="btn-row" style={{ marginTop: 'var(--sp-5)' }}>
        <button className="btn primary" disabled={!data.key_ready || !changed || saving} onClick={save}>
          {saving ? 'กำลังบันทึก…' : 'บันทึกการตั้งค่าอีเมล'}</button>
        {/* Sends to whoever pressed it, never to an address typed into a box:
            a button that posts anywhere is a button that sends mail in this
            gym's name to anybody. */}
        <button className="btn ghost" disabled={!data.ready || testing || changed} onClick={sendTest}>
          {testing ? 'กำลังส่ง…' : 'ส่งเมลทดสอบถึงตัวเอง'}</button>
      </div>
      {changed && <p className="note">บันทึกก่อน แล้วจึงกดส่งทดสอบได้</p>}

      {test && <div className={`banner ${test.ok ? 'ok' : 'bad'}`} role="alert" style={{ marginTop: 'var(--sp-4)' }}>
        <div className="ic" aria-hidden="true">{test.ok ? '✓' : '!'}</div>
        <div><b>{test.ok ? 'ส่งสำเร็จ' : 'ส่งไม่สำเร็จ'}</b><span>{test.message}</span></div>
      </div>}
    </div>

    <div className="block">
      <h2>ต้องทำอะไรฝั่ง Microsoft 365 บ้าง</h2>
      <p className="note">ทำครั้งเดียว โดยผู้ดูแล Microsoft 365 ของยิม</p>
      <ol style={{ paddingLeft: 22, lineHeight: 1.8, margin: 0 }}>
        <li>เปิด <b>Authenticated SMTP</b> ให้กล่องนี้ — Microsoft 365 admin center →
          Users → เลือกผู้ใช้ → Mail → Manage email apps → ติ๊ก Authenticated SMTP</li>
        <li>ถ้ากล่องเปิดยืนยันตัวตนสองขั้น ให้สร้าง <b>App password</b> แล้วใช้รหัสนั้นในช่องด้านบน</li>
        <li>กลับมากด “ส่งเมลทดสอบถึงตัวเอง” เพื่อยืนยันว่าออกจริง</li>
      </ol>
      <p className="note" style={{ marginBottom: 0 }}>ถ้ากดแล้วขึ้นว่ารหัสผ่านไม่ถูกต้อง ทั้งที่แน่ใจว่าถูก
        เกือบทุกครั้งคือข้อ 1 ยังไม่ได้เปิด</p>
    </div>
  </>;
}
