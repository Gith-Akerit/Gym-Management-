import { useEffect, useState } from 'react';
import { api, Field, formatDateTime, Loading, Notice, StateBox, useResource } from './shared.jsx';

/**
 * The "อีเมลของระบบ" tab in the gym's settings.
 *
 * A tab rather than a ninth item in the menu: email is a setting of the gym
 * like its logo and its colours, and a menu that grows every time something
 * new arrives is a menu that is unusable by spring (Designer).
 *
 * Two things shape everything below. The mailbox password is typed here and
 * never comes back out -- there is no route in this system that returns it --
 * so the field becomes a label and a button rather than an input full of dots
 * that would be a lie and an invitation to save over it by accident. And the
 * only honest proof that mail works is a letter that arrives, so the button
 * sends one and reports what the mail server really said.
 *
 * The failure panels are the part that took the most care. A screen that
 * prints `535 5.7.139 SmtpClientAuthentication is disabled` at a gym owner has
 * told them nothing and bought us a telephone call. The order is forced:
 * what happened → what it means → what YOU press → (folded away) the raw text.
 */

/** The Microsoft menu path, as chips the eye can follow one step at a time. */
const Path = ({ steps }) => <div className="mpath">
  {steps.map((step, at) => <span key={step}>{step}{at < steps.length - 1 ? '' : ''}</span>)
    .flatMap((node, at) => (at ? [<i key={`sep${at}`} aria-hidden="true">›</i>, node] : [node]))}
</div>;

/**
 * The three things that go wrong, and what the owner does about each.
 *
 * `smtp_disabled` and `password` both arrive from Microsoft as "535
 * authentication unsuccessful". Telling them apart is the whole reason this
 * table exists: the first sends the owner to a checkbox, the second to a
 * password, and getting it backwards wastes an afternoon.
 */
const DIAGNOSIS = {
  smtp_disabled: {
    title: 'กล่องนี้ยังไม่ได้เปิดให้โปรแกรมส่งเมลแทน',
    code: 'SMTP 535 5.7.139 · SmtpClientAuthentication is disabled',
    why: <>Microsoft ปิดการส่งเมลผ่านโปรแกรมภายนอกไว้เป็นค่าเริ่มต้นทุกกล่อง <b>นี่ไม่ใช่รหัสผ่านผิด</b> {}
      ต้องให้ผู้ดูแล Microsoft 365 ของยิมติ๊กเปิดให้กล่องนี้หนึ่งครั้ง</>,
    who: 'ทำตามนี้ (ผู้ดูแล Microsoft 365 ของยิมเป็นคนทำ)',
    steps: [
      { title: 'เข้าหน้าจัดการผู้ใช้', body: 'เข้า Microsoft 365 admin center ด้วยบัญชีผู้ดูแล',
        path: ['admin.microsoft.com', 'Users', 'Active users'] },
      { title: 'เลือกกล่องที่ใช้ส่ง', body: 'กดที่ชื่อผู้ใช้ แล้วไปแท็บ Mail',
        path: ['Mail', 'Email apps', 'Manage email apps'] },
      { title: 'ติ๊ก Authenticated SMTP แล้วกด Save changes',
        body: 'มีหลายรายการในนั้น ติ๊กเฉพาะบรรทัด Authenticated SMTP พอ ไม่ต้องแตะรายการอื่น' },
      // The step everybody skips, and the reason they conclude the system is
      // broken: they tick the box, press the button, see the same message.
      { title: 'รอ 10–15 นาที แล้วกลับมากดส่งทดสอบใหม่',
        body: 'Microsoft ใช้เวลาให้การตั้งค่ามีผล กดเร็วกว่านั้นอาจยังขึ้นข้อความเดิม' },
    ],
    caveat: { tone: 'warn', title: 'ถ้าองค์กรของคุณปิดการส่งแบบนี้ทั้งองค์กร',
      body: 'ผู้ดูแลอาจตั้งนโยบายห้ามไว้ระดับองค์กร ให้ส่งข้อความด้านล่างนี้ให้เขาดู '
        + 'ถ้าเปิดให้ไม่ได้จริง ๆ บอกทีมพัฒนาได้ มีวิธีต่อแบบอื่นที่ Microsoft แนะนำ แต่ต้องให้ผู้ดูแลอนุมัติแอปหนึ่งครั้ง' },
  },
  password: {
    title: 'Microsoft ไม่รับรหัสผ่านนี้',
    code: 'SMTP 535 5.7.3 · Authentication unsuccessful',
    why: <>ถ้ากล่องนี้เปิดยืนยันตัวตนสองขั้นอยู่ Microsoft จะไม่รับรหัสผ่านปกติจากโปรแกรมภายนอกเลย {}
      ต้องสร้าง <b>App password</b> 16 ตัวมาใช้แทน</>,
    who: 'ทำตามนี้ (คุณทำเองได้ ใช้เวลาไม่ถึง 2 นาที)',
    steps: [
      { title: 'เปิดหน้าข้อมูลความปลอดภัยของบัญชี', body: 'ล็อกอินด้วยกล่องนี้',
        path: ['myaccount.microsoft.com', 'Security info'] },
      { title: 'เพิ่มวิธีลงชื่อเข้าใช้แบบ App password',
        body: 'ถ้าไม่มีตัวเลือก App password แปลว่าผู้ดูแลปิดไว้ ให้ขอให้เปิดให้',
        path: ['Add sign-in method', 'App password', 'ตั้งชื่อว่า “ระบบยิม”'] },
      { title: 'คัดลอกรหัส 16 ตัวที่ได้มาทันที',
        body: 'Microsoft แสดงรหัสนี้ครั้งเดียว ปิดหน้าต่างแล้วดูย้อนหลังไม่ได้' },
      { title: 'กดแทนที่รหัสในระบบนี้แล้ววางลงไป',
        body: 'วางได้ทั้งแบบมีเว้นวรรคหรือไม่มี ระบบตัดเว้นวรรคให้เอง แล้วกดส่งทดสอบใหม่' },
    ],
    caveat: { tone: 'info', title: 'ถ้ากล่องนี้ไม่ได้เปิดยืนยันสองขั้น',
      body: 'ให้ตรวจว่าพิมพ์รหัสถูกต้อง โดยเฉพาะตัวพิมพ์ใหญ่–เล็ก และตรวจว่าอีเมลผู้ส่งตรงกับกล่องที่เป็นเจ้าของรหัสนั้นจริง '
        + '— กรอกอีเมลกล่องหนึ่งแต่ใส่รหัสของอีกกล่องหนึ่งจะขึ้นข้อความเดียวกันนี้' },
  },
  // QA: this one reached the server without reaching the screen. `no_tls` was
  // added to explainFailure and the table below was not touched, so a real
  // answer fell through to "cause unknown" -- the exact thing the fourth
  // branch existed to stop. The test at the bottom of
  // tests/mail-settings.test.js now compares the two lists so the next branch
  // cannot get here the same way.
  no_tls: {
    title: 'เซิร์ฟเวอร์นี้ไม่รองรับการเข้ารหัส',
    code: 'STARTTLS not supported · ไม่ได้ส่งรหัสผ่านออกไป',
    why: <>ระบบต่อไปถึงเครื่องปลายทางได้ แต่เครื่องนั้นไม่ยอมเข้ารหัสการเชื่อมต่อ {}
      <b>ระบบจึงตัดการเชื่อมต่อทิ้งโดยไม่ส่งรหัสผ่านของกล่องจดหมายออกไปเลย</b> {}
      เกือบทุกครั้งเกิดจากพิมพ์ชื่อเซิร์ฟเวอร์หรือพอร์ตผิด</>,
    who: 'ตรวจสองช่องนี้ (คุณทำเองได้)',
    steps: [
      { title: 'ตรวจว่าพอร์ตเป็น 587',
        body: 'Microsoft 365 ใช้พอร์ต 587 เท่านั้น · 465 เป็นการเข้ารหัสคนละแบบและ 25 ไม่เข้ารหัสเลย '
          + 'ทั้งสองค่าจะขึ้นข้อความนี้' },
      { title: 'ตรวจว่าชื่อเซิร์ฟเวอร์สะกดถูก',
        body: 'ค่าที่ถูกต้องคือ smtp.office365.com — ไม่ใช่ outlook.office365.com หรือชื่ออื่นที่ใกล้เคียง',
        path: ['smtp.office365.com', 'พอร์ต 587'] },
      { title: 'แก้แล้วกดบันทึก จากนั้นส่งทดสอบใหม่',
        body: 'ถ้ายังขึ้นข้อความเดิมทั้งที่ค่าถูกต้องแล้ว ให้กดแจ้งปัญหา อาจเป็นเรื่องเครือข่ายของเครื่อง' },
    ],
    caveat: { tone: 'info', title: 'ทำไมระบบถึงไม่ยอมส่ง',
      body: 'รหัสผ่านกล่องจดหมายของยิมจะถูกส่งข้ามเครือข่ายตอนล็อกอินเสมอ ถ้าการเชื่อมต่อไม่ถูกเข้ารหัส '
        + 'ใครก็ตามที่ดักอยู่ระหว่างทางจะอ่านรหัสนั้นได้ · ส่งไม่สำเร็จจึงเป็นผลที่ถูกต้องกว่า' },
  },

  network: {
    title: 'ต่อเซิร์ฟเวอร์อีเมลไม่ได้',
    code: 'ETIMEDOUT / ECONNREFUSED · connect',
    why: 'อาการนี้เกิดจาก 3 อย่าง เรียงตามที่พบบ่อยที่สุด ให้ไล่ตรวจตามลำดับ',
    who: 'ไล่ตรวจตามลำดับนี้',
    steps: [
      { title: 'พอร์ตหรือชื่อเซิร์ฟเวอร์พิมพ์ผิด',
        body: 'ค่าที่ถูกต้องสำหรับ Microsoft 365 คือ smtp.office365.com พอร์ต 587 เท่านั้น '
          + 'ถ้าเผลอใส่ 465 หรือ 25 จะขึ้นข้อความนี้ กดแก้ไขการตั้งค่าแล้วเทียบดู' },
      { title: 'ผู้ให้บริการเซิร์ฟเวอร์บล็อกพอร์ต 587 ไว้',
        body: 'ผู้ให้บริการหลายเจ้าปิดพอร์ตส่งเมลไว้กันสแปม ต้องแจ้งเปิดให้ — เรื่องนี้ทีมพัฒนาติดต่อให้ได้ '
          + 'บอกในระบบแจ้งปัญหาได้เลย' },
      { title: 'เครือข่ายขัดข้องชั่วคราว',
        body: 'ถ้าเพิ่งใช้ได้เมื่อวาน ลองกดส่งทดสอบใหม่อีกครั้งในอีก 5 นาที' },
    ],
  },
  sender: {
    title: 'กล่องนี้ส่งในนามอีเมลผู้ส่งที่กรอกไว้ไม่ได้',
    code: 'SMTP 550 5.7.60 · SendAsDenied',
    why: 'Microsoft ยอมให้กล่องหนึ่งส่งในนามตัวเองเท่านั้น เว้นแต่ผู้ดูแลจะให้สิทธิ์ส่งแทนไว้',
    who: 'วิธีแก้',
    steps: [
      { title: 'ให้อีเมลผู้ส่งเป็นกล่องเดียวกับชื่อผู้ใช้',
        body: 'กดแก้ไขการตั้งค่า แล้วกรอกอีเมลเดียวกันทั้งสองช่อง นี่คือวิธีที่ถูกสำหรับยิมนี้' },
    ],
  },
  // The fourth case: an answer nobody anticipated still lands on a screen that
  // says what to do next, rather than a blank red box.
  unknown: {
    title: 'ส่งไม่สำเร็จ และยังไม่ทราบสาเหตุ',
    code: 'ไม่ตรงกับอาการที่รู้จัก',
    why: 'ข้อความที่เซิร์ฟเวอร์ตอบกลับมาไม่ตรงกับสามอาการที่พบบ่อย',
    who: 'ทำอย่างนี้',
    steps: [
      { title: 'กดแจ้งปัญหาจากเมนูมุมขวาบน',
        body: 'คัดลอกข้อความจากเซิร์ฟเวอร์ด้านล่างแนบไปด้วย ทีมดูแลตรวจให้ได้' },
    ],
  },
};

export function MailSettings({ onAuthError, onSaved, onStatus }) {
  const { data, error, busy, reload } = useResource('/gym/mail-settings');
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false), [failure, setFailure] = useState(null);
  const [testing, setTesting] = useState(false), [test, setTest] = useState(null);
  const [peek, setPeek] = useState(false);

  useEffect(() => {
    if (!data || data.staff) return;
    setForm({
      host: data.host, port: String(data.port), username: data.username,
      from_email: data.from_email, from_name: data.from_name,
      // null means "leave the stored one alone", which is what a form that
      // cannot show the current value has to mean by default.
      password: null,
    });
  }, [data]);

  if (busy) return <Loading label="กำลังโหลดการตั้งค่าอีเมล…" rows={3}/>;
  if (error) return <StateBox error={error} onRetry={() => reload().catch(() => {})}/>;

  // Screen 8: a member of staff opened the tab. The question they get asked at
  // the counter is "do customers get their card by email?" and that is the
  // whole of what they are told -- no host, no username, and no hint about the
  // mailbox the gym signs in with.
  if (data.staff) {
    return <div className={`mstat ${data.ready ? 'on' : 'off'}`} role="status">
      <div className="ic" aria-hidden="true">{data.ready ? '✓' : '!'}</div>
      <div className="tx">
        <b>{data.ready ? 'ระบบส่งอีเมลได้ตามปกติ' : 'ระบบยังส่งอีเมลไม่ได้'}</b>
        <p>{data.ready
          ? 'ลูกค้าที่กรอกอีเมลไว้จะได้รับบัตรสมาชิกทางอีเมล และลิงก์ลืมรหัสผ่านส่งออกได้ตามปกติ'
          : 'ลูกค้าจะยังไม่ได้รับบัตรทางอีเมล และกดลืมรหัสผ่านแล้วจะไม่มีเมลออก · แจ้งเจ้าของยิมให้ตั้งค่าให้'}</p>
      </div>
    </div>;
  }
  if (!form) return <Loading label="กำลังโหลดการตั้งค่าอีเมล…" rows={3}/>;

  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const changed = form.host !== data.host || form.port !== String(data.port)
    || form.username !== data.username || form.from_email !== data.from_email
    || form.from_name !== data.from_name || form.password !== null;

  // Caught on the screen before anything is sent, because Microsoft answers it
  // with a message that reads exactly like a wrong password -- and an owner
  // who retypes their password ten times is an owner nobody helped.
  const senderMismatch = form.from_email && form.username && form.from_email !== form.username;

  async function save() {
    setSaving(true); setFailure(null); setTest(null);
    try {
      await api('/gym/mail-settings', { method: 'PUT', body: {
        host: form.host.trim(), port: Number(form.port), starttls: true,
        username: form.username.trim(), from_email: form.from_email.trim(), from_name: form.from_name,
        // Microsoft shows an App password in groups of four; people paste it
        // with the spaces in. Taking them out here is kinder than refusing it.
        ...(form.password === null ? {} : { password: form.password.replace(/\s+/g, '') }),
        version: data.version,
      } });
      await reload();
      setForm(current => ({ ...current, password: null }));
      setPeek(false);
      onSaved?.('บันทึกการตั้งค่าอีเมลแล้ว');
    } catch (e) { setFailure(e); onAuthError(e); } finally { setSaving(false); }
  }

  async function sendTest() {
    setTesting(true); setTest(null); setFailure(null);
    try {
      const result = await api('/gym/mail-settings/test', { method: 'POST', body: {} });
      setTest({ ok: true, message: result.message });
    } catch (e) {
      setTest({ ok: false, reason: e.reason ?? 'unknown', message: e.message, raw: e.raw ?? '' });
      onAuthError(e);
    } finally {
      setTesting(false);
      await reload().catch(() => {});
      // The dot on the tab is drawn by the page above this one, from its own
      // copy of the same row. Without this it keeps yesterday's answer until
      // somebody navigates away and back -- which is exactly when a dot is
      // worth nothing.
      onStatus?.();
    }
  }

  // The failure to draw: the one that just happened, or the one written down
  // from last time so a reload does not lose the instructions.
  const shownFailure = test && !test.ok ? test
    : (!data.test_ok && data.test_reason
      ? { reason: data.test_reason, message: data.test_detail, raw: data.test_raw }
      : null);
  const diagnosis = shownFailure ? (DIAGNOSIS[shownFailure.reason] ?? DIAGNOSIS.unknown) : null;

  const status = testing ? 'busy' : shownFailure ? 'err' : data.ready ? 'on' : 'off';

  return <>
    {/* Always first, because the owner's first question is "does it work right
        now?". Never colour alone: an icon and a sentence say it too. */}
    <div className={`mstat ${status}`} role="status">
      <div className="ic" aria-hidden="true">
        {status === 'busy' ? <span className="mspin"/> : status === 'on' ? '✓' : '!'}
      </div>
      <div className="tx">
        {status === 'busy' && <>
          <b>กำลังส่งเมลทดสอบ…</b>
          <p>ไม่เกิน 30 วินาที ไม่ต้องกดซ้ำ</p>
        </>}
        {status === 'on' && <>
          <b>ระบบส่งอีเมลได้</b>
          <p>ลูกค้าจะได้รับบัตรสมาชิกและลิงก์ตั้งรหัสผ่านทางอีเมลตามปกติ
            {data.tested_at && <span className="when">ส่งทดสอบสำเร็จล่าสุด {formatDateTime(data.tested_at)}</span>}</p>
        </>}
        {status === 'off' && <>
          <b>ระบบยังส่งอีเมลไม่ได้</b>
          {/* Said as consequences, not as a state. "ยังไม่ได้ตั้งค่า" does not
              tell anybody that their customers are not getting their cards. */}
          <p>ตอนนี้ลูกค้าจะ<b>ไม่ได้รับ</b>บัตรสมาชิกทางอีเมล และ<b>กดลืมรหัสผ่านแล้วไม่มีเมลออก</b> ·
            กรอกกล่องอีเมลของยิมด้านล่างแล้วกดส่งทดสอบหนึ่งครั้งก็ใช้ได้ทันที</p>
        </>}
        {status === 'err' && <>
          <b>ส่งเมลทดสอบไม่สำเร็จ</b>
          <p>ดูขั้นตอนแก้ด้านล่าง เจ้าของยิมทำเองได้ทั้งหมด
            {data.tested_at && <span className="when">ลองล่าสุด {formatDateTime(data.tested_at)}</span>}</p>
        </>}
      </div>
    </div>

    {test?.ok && <div className="mstat on" role="status">
      <div className="ic" aria-hidden="true">✓</div>
      <div className="tx"><b>ส่งเมลทดสอบแล้ว</b>
        <p>{test.message} · มองหาหัวข้อที่ขึ้นต้นว่า “ทดสอบการส่งอีเมลของ…”
          ครั้งแรกอาจไปอยู่ในกล่องจดหมายขยะ ถ้าเจอที่นั่นให้กดย้ายมากล่องหลัก</p></div>
    </div>}

    {!data.key_ready && <div className="alert err" role="alert">
      <div className="ic" aria-hidden="true">!</div>
      <div><b>เครื่องนี้ยังไม่พร้อมเก็บรหัสผ่านอย่างปลอดภัย</b>
        <span>ผู้ดูแลเครื่องต้องตั้งค่า <code>SETTINGS_ENC_KEY</code> ใน <code>.env</code> แล้วรีสตาร์ตก่อน
          จึงจะกรอกหน้านี้ได้ · วิธีทำอยู่ใน <code>docs/deploy.md</code></span></div>
    </div>}

    {diagnosis && <div className="diag">
      <div className="hd">
        <b>{diagnosis.title}</b>
        <span className="code">{diagnosis.code}</span>
      </div>
      <div className="bd">
        <p className="why">{diagnosis.why}</p>
        <div className="lbl">{diagnosis.who}</div>
        <ol className="fixlist">
          {diagnosis.steps.map(step => <li key={step.title}>
            <div className="fb">
              <b>{step.title}</b>
              {step.body}
              {step.path && <Path steps={step.path}/>}
            </div>
          </li>)}
        </ol>
        {diagnosis.caveat && <div className={`alert ${diagnosis.caveat.tone}`}>
          <div className="ic" aria-hidden="true">{diagnosis.caveat.tone === 'warn' ? '!' : 'i'}</div>
          <div><b>{diagnosis.caveat.title}</b><span>{diagnosis.caveat.body}</span></div>
        </div>}
        {/* Last, folded, and labelled for what it is actually for. Put first it
            would be the thing the owner reads, and it would end the visit. */}
        {shownFailure.raw && <details className="raw">
          <summary>ข้อความดิบจากเซิร์ฟเวอร์ (สำหรับส่งต่อให้ฝ่ายไอที)</summary>
          <pre>{shownFailure.raw}</pre>
        </details>}
      </div>
    </div>}

    <div className="sect">
      <h2>กล่องจดหมายของยิม</h2>
      <p className="note">ค่าเริ่มต้นเป็นของ Office 365 ซึ่งเป็นของที่ยิมนี้ใช้อยู่ ไม่ต้องแก้ถ้าไม่ได้ย้ายผู้ให้บริการ</p>

      <div className="pair">
        <Field name="mail-host" label="เซิร์ฟเวอร์อีเมล (SMTP)" value={form.host}
          onChange={value => set('host', value)} disabled={!data.key_ready}
          error={failure?.fields?.host}/>
        <Field name="mail-port" label="พอร์ต" value={form.port} inputMode="numeric"
          onChange={value => set('port', value)} disabled={!data.key_ready}
          error={failure?.fields?.port}/>
      </div>
      <p className="hint" style={{ marginTop: 'calc(var(--sp-3) * -1)', marginBottom: 'var(--sp-4)' }}>
        587 คือ STARTTLS ซึ่งเป็นค่าที่ Microsoft 365 ใช้</p>

      <Field name="mail-username" label="ชื่อผู้ใช้ (อีเมลที่ใช้ล็อกอินกล่องนี้)" type="email"
        value={form.username} onChange={value => set('username', value)}
        disabled={!data.key_ready} autoComplete="off" error={failure?.fields?.username}
        placeholder="info@suklutai.co.th"/>

      <div className="field">
        <label htmlFor="mail-password">รหัสผ่านของกล่องจดหมาย</label>
        {form.password === null
          ? <div className="secret">
              {/* A label and a button, not an input holding fake dots: an input
                  with a value in it invites a save-over by accident, and is a
                  target for a browser extension to read. */}
              <span className="dots">{data.has_password ? '••••••••••••' : 'ยังไม่ได้ตั้ง'}</span>
              <span className={`chip ${data.has_password ? 'ok' : 'bad'}`}>
                {data.has_password ? '✓ ตั้งค่าไว้แล้ว' : '✕ ยังไม่ได้ตั้ง'}</span>
              <button className="btn ghost" type="button" disabled={!data.key_ready}
                onClick={() => { set('password', ''); setPeek(false); }}>
                {data.has_password ? 'แทนที่รหัส' : 'กรอกรหัสผ่าน'}</button>
            </div>
          : <>
              <div className="pwwrap">
                <input id="mail-password" type={peek ? 'text' : 'password'} value={form.password}
                  autoComplete="new-password" spellCheck="false"
                  onChange={event => set('password', event.target.value)}/>
                {/* Only while it is being typed. After it is saved there is no
                    way to read it back, on this screen or any other. */}
                <button className="peek" type="button" onClick={() => setPeek(on => !on)}
                  aria-pressed={peek}>{peek ? 'ซ่อนรหัส' : 'ดูรหัส'}</button>
              </div>
              <button className="btn ghost auto" type="button" style={{ marginTop: 8 }}
                onClick={() => { set('password', null); setPeek(false); }}>ยกเลิกการเปลี่ยนรหัส</button>
            </>}
        <p className="hint">ถ้ากล่องนี้เปิดยืนยันตัวตนสองขั้น ต้องใช้ <b>App password</b> ไม่ใช่รหัสปกติ ·
          รหัสถูกเก็บแบบเข้ารหัสบนเครื่อง และไม่มีหน้าจอไหนแสดงกลับมาอีก</p>
        {failure?.fields?.password && <p className="err" role="alert">✕ {failure.fields.password}</p>}
      </div>

      <h2 style={{ marginTop: 'var(--sp-6)' }}>ผู้รับเห็นอะไร</h2>
      <Field name="mail-from" label="อีเมลผู้ส่ง" type="email" value={form.from_email}
        onChange={value => set('from_email', value)} disabled={!data.key_ready}
        error={failure?.fields?.from_email}/>
      {senderMismatch && <div className="alert warn" role="alert" style={{ marginTop: 'calc(var(--sp-3) * -1)' }}>
        <div className="ic" aria-hidden="true">!</div>
        <div><b>อีเมลผู้ส่งไม่ตรงกับชื่อผู้ใช้</b>
          <span>Microsoft จะปฏิเสธ และข้อความที่ได้จะอ่านเหมือนรหัสผ่านผิด — ให้ใช้กล่องเดียวกันทั้งสองช่อง</span></div>
      </div>}
      <Field name="mail-from-name" label="ชื่อผู้ส่ง (ไม่บังคับ)" value={form.from_name}
        onChange={value => set('from_name', value)} disabled={!data.key_ready}
        error={failure?.fields?.from_name} hint="เว้นว่างไว้ ระบบใช้ชื่อยิมให้เอง"/>

      <Notice error={failure}/>
      <div className="btn-row" style={{ marginTop: 'var(--sp-5)' }}>
        <button className="btn primary" disabled={!data.key_ready || !changed || saving || senderMismatch}
          onClick={save}>{saving ? 'กำลังบันทึก…' : 'บันทึกการตั้งค่าอีเมล'}</button>
      </div>
    </div>

    <div className="testbox">
      <h3>ส่งเมลทดสอบ</h3>
      <p className="note" style={{ margin: 0 }}>วิธีเดียวที่พิสูจน์ได้จริงว่าส่งออกได้ คือส่งแล้วมีจดหมายถึงจริง</p>
      <div className="to">
        <span className="lb">ส่งถึง</span>
        <span className="ad">{form.from_email || 'ยังไม่ได้กรอกอีเมลผู้ส่ง'}</span>
      </div>
      {/* Written on the screen rather than left looking like a missing feature:
          a box you could type a destination into would be a machine for sending
          mail as this gym to anybody, the moment an owner account leaked. */}
      <p className="note">ส่งถึงกล่องผู้ส่งเองเท่านั้น ไม่มีช่องให้พิมพ์ปลายทาง —
        ถ้าพิมพ์ปลายทางได้ หน้านี้จะกลายเป็นเครื่องส่งเมลในนามยิมให้ใครก็ได้ทันทีที่บัญชีผู้ดูแลหลุด</p>
      <button className="btn primary" disabled={!data.ready || testing || changed} onClick={sendTest}>
        {testing ? 'กำลังส่ง…' : 'ส่งเมลทดสอบ'}</button>
      {changed && <p className="note" style={{ marginBottom: 0 }}>บันทึกก่อน แล้วจึงกดส่งทดสอบได้</p>}
      {!data.ready && !changed && <p className="note" style={{ marginBottom: 0 }}>
        กรอกให้ครบทั้งสี่ช่องแล้วบันทึกก่อน จึงจะส่งทดสอบได้</p>}
    </div>

    <div className="helpbox">
      <h3>คำถามที่เจอบ่อย</h3>
      <p>สองเรื่องนี้คือสาเหตุเกือบทั้งหมดที่ส่งไม่ออกในครั้งแรก</p>
      <div className="qa">
        <b>Authenticated SMTP คืออะไร ต้องทำไหม</b>
        <p>Microsoft ปิดการส่งเมลผ่านโปรแกรมภายนอกไว้ทุกกล่องเป็นค่าเริ่มต้น ต้องให้ผู้ดูแล Microsoft 365
          ติ๊กเปิดให้กล่องนี้หนึ่งครั้งที่ Users › Active users › Mail › Manage email apps</p>
      </div>
      <div className="qa">
        <b>App password คืออะไร ต้องใช้เมื่อไหร่</b>
        <p>ถ้ากล่องเปิดยืนยันตัวตนสองขั้น ต้องสร้างรหัสเฉพาะ 16 ตัวที่ myaccount.microsoft.com › Security info
          แล้วใช้รหัสนั้นแทนรหัสปกติ · ถ้าไม่ได้เปิดสองขั้น ใช้รหัสปกติได้เลย</p>
      </div>
    </div>
  </>;
}
