import React, { useEffect, useRef, useState } from 'react';
import Brand from '../shared/brand.cjs';
import { MailSettings } from './mail-settings.jsx';
import { ContentSettings } from './content-settings.jsx';
import { AdminReports } from './admin-reports.jsx';
import { UserAccounts } from './user-accounts.jsx';
import { api, formatPhone, Loading, Mark, Notice, StateBox, upload, useResource } from './shared.jsx';

/**
 * "ตั้งค่ายิม" — the gym's own name, logo and colours.
 *
 * The screen is built around one fact: the owner cannot picture what a colour
 * will look like on a membership card, so the card is on the screen while they
 * choose. Everything on the right is live; nothing is saved until the bar at
 * the bottom says so.
 *
 * The colours in the preview come from `shared/brand.cjs` -- the same file the
 * server uses to draw the real card -- so what they see here is what comes out
 * of the printer, to the digit (Designer).
 */

const SYSTEM_GREEN = '#05603A';

/** The five numbers the owner is shown, so the arithmetic is not a secret. */
function ratioRows(derived) {
  const { ratios } = derived;
  return [
    { key: 'onSurface', label: 'ตัวอักษรบนปุ่มและหัวบัตร', value: ratios.onSurface, need: 4.5,
      bg: derived.brandSurface, fg: derived.onBrand, sample: 'ก' },
    { key: 'inkOnWhite', label: 'ตัวอักษรสีแบรนด์บนพื้นขาว', value: ratios.inkOnWhite, need: 4.5,
      bg: '#FFFFFF', fg: derived.brandInk, sample: 'ก' },
    { key: 'inkOnSoft', label: 'ตัวอักษรบนป้ายสีอ่อน', value: ratios.inkOnSoft, need: 4.5,
      bg: derived.brandSoft, fg: derived.brandInk, sample: 'ก' },
    { key: 'lineOnCanvas', label: 'เส้นขอบช่องกรอกบนพื้นหน้า', value: ratios.lineOnCanvas, need: 3,
      bg: '#EFF2F4', fg: derived.brandLine, sample: '▢' },
    { key: 'onSecondary', label: 'ตัวอักษรบนสีรอง (แถบล่างบัตร)', value: ratios.onSecondary, need: 4.5,
      bg: derived.brand2, fg: derived.onBrand2, sample: 'ก' },
  ];
}

/**
 * The membership card, drawn in HTML at a fraction of its real size.
 *
 * Not the PNG the server makes: that one costs a round trip per keystroke and
 * the whole point of this screen is that the colour follows the mouse. The
 * markup and every number in it are the Designer's, so the two agree.
 */
function CardPreview({ derived, branding, name, shortName, phone, lineId, address, plate }) {
  const box = useRef(null);
  const [scale, setScale] = useState(0.3);
  useEffect(() => {
    const fit = () => { if (box.current) setScale(box.current.clientWidth / 1080); };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  const style = {
    '--brand-surface': derived.brandSurface, '--on-brand': derived.onBrand,
    '--brand-2': derived.brand2, '--on-brand-2': derived.onBrand2,
  };
  const place = [name, address].filter(Boolean).join(' · ');
  const reach = [phone && `โทร ${formatPhone(phone) ?? phone}`, lineId && `LINE ${lineId}`].filter(Boolean).join(' · ');
  return <div className="pvcard" ref={box} style={{ ...style, height: 1350 * scale }}>
    <div className="mcard" style={{ transform: `scale(${scale})` }}>
      <div className="top">
        {branding?.logo_url
          ? <span className={`gm logo${plate ? ' plate' : ''}`}><img src={branding.logo_url} alt=""/></span>
          : <div className="gm">{shortName}</div>}
        <div className="gn">{name}<span>{branding?.brand_en ?? ''}</span></div>
      </div>
      <div className="idrow">
        <div className="face"/>
        <div className="idtext"><div className="eyebrow">บัตรสมาชิก</div>
          <div className="who">สมชาย ทดสอบ</div><div className="code">GYM-4DBFF3A39A94</div></div>
      </div>
      <div className="qrzone"><div className="qrbox"/><div className="qrcap">ยื่นบัตรนี้ให้พนักงานสแกน</div></div>
      <div className="bar">
        <div className="brow"><div><span>แพ็กเกจ</span><b>รายเดือน ไม่จำกัดครั้ง</b></div>
          <div style={{ textAlign: 'right' }}><span>ใช้ได้ถึง</span><b>14 ต.ค. 2569</b></div></div>
        <div className="tel"><span>{place}</span><span className="num">{reach}</span></div>
      </div>
    </div>
  </div>;
}

/** The app bar as it will look, at the size it will look it. */
const BarPreview = ({ derived, branding, name, shortName, appbar }) => <div className="pvbar"
  data-appbar={appbar}
  style={{ '--brand-surface': derived.brandSurface, '--on-brand': derived.onBrand,
    '--brand-2': derived.brand2, '--brand-ink': derived.brandInk }}>
  <header className="appbar"><div className="appbar-in">
    {branding?.logo_url
      ? <img className="brandlogo" src={branding.logo_url} alt=""/>
      : <span className="mark" aria-hidden="true">{shortName}</span>}
    <div className="brand">{name}<small>เจ้าของยิม</small></div>
    <div className="spacer"/>
    <button className="btn auto" type="button" tabIndex={-1}>ออกจากระบบ</button>
  </div></header>
</div>;

/**
 * The two halves of "ตั้งค่ายิม", as tabs rather than two entries in the menu.
 *
 * The side menu already carries seven destinations. Adding one every time
 * something new arrives is the road to a menu nobody can scan, and email is a
 * setting of this gym in exactly the way its logo and its colours are
 * (Designer).
 *
 * The dot is the point of doing it this way: the owner sees from the tab that
 * something is unfinished behind it without opening it. It carries a label as
 * well as a colour, because a coloured dot on its own says nothing to somebody
 * who cannot tell yellow from red.
 */
const SettingsTabs = ({ tab, setTab, dot, canEdit }) => <div className="settabs">
  <a href="#brand" aria-current={tab === 'brand' ? 'page' : undefined}
    onClick={event => { event.preventDefault(); setTab('brand'); }}>ยิมและแบรนด์</a>
  <a href="#mail" aria-current={tab === 'mail' ? 'page' : undefined}
    onClick={event => { event.preventDefault(); setTab('mail'); }}>
    อีเมลของระบบ
    {dot === 'bad' && <span className="dotbad" role="img" aria-label="ส่งเมลทดสอบไม่สำเร็จ"/>}
    {dot === 'warn' && <span className="dotwarn" role="img" aria-label="ยังไม่ได้ตั้งค่าอีเมล"/>}
  </a>
  {/* The owner's only, unlike the two beside it: what a member reads is the
      gym's word to its customers, and every route behind this tab is admin. */}
  {canEdit && <a href="#content" aria-current={tab === 'content' ? 'page' : undefined}
    onClick={event => { event.preventDefault(); setTab('content'); }}>เครื่องและโปรแกรม</a>}
  {/* Both of these are the owner's alone, and not by being greyed out: every
      route behind them is admin, and a tab a member of staff can see but not
      open teaches them to keep pressing it. */}
  {canEdit && <a href="#reports" aria-current={tab === 'reports' ? 'page' : undefined}
    onClick={event => { event.preventDefault(); setTab('reports'); }}>รายงาน</a>}
  {canEdit && <a href="#users" aria-current={tab === 'users' ? 'page' : undefined}
    onClick={event => { event.preventDefault(); setTab('users'); }}>บัญชีผู้ใช้</a>}
</div>;

export function GymBranding({ role, onAuthError, onSaved, initialTab = 'brand', signedInAs, onSignedOut }) {
  // Seeded from outside so the corner menu can land straight on a tab: "ผู้ใช้
  // และสิทธิ์" in that menu is this screen with the accounts tab already open,
  // rather than a second copy of the same screen somewhere else.
  const [tab, setTab] = useState(initialTab);
  useEffect(() => { setTab(initialTab); }, [initialTab]);
  // Read out here rather than inside the tab, because the dot has to be right
  // before anybody opens it -- which is the entire reason the dot exists.
  const mail = useResource('/gym/mail-settings');
  const dot = !mail.data ? null
    : (!mail.data.ready ? 'warn' : (mail.data.test_reason ? 'bad' : null));
  const { data, error, busy, reload } = useResource('/gym/settings');
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false), [failure, setFailure] = useState(null);
  const [uploading, setUploading] = useState(false), [uploadError, setUploadError] = useState(null);
  const canEdit = role === 'admin';

  useEffect(() => {
    if (!data) return;
    setForm({
      brand_short: data.brand_short_source === 'gym' ? data.brand_short : '',
      color_primary: data.theme.brand,
      color_secondary: data.color_secondary_source === 'gym' ? data.theme.brand_2 : '',
      line_id: data.line_id ?? '',
      invite_code: data.invite_code ?? '',
      appbar_style: data.theme.appbar,
    });
  }, [data]);

  // The mail tab does not need the branding form, so it is answered before the
  // screen waits for one. One column rather than the colour page's form-beside-
  // preview: this tab's job is "fill it in and press send", and on a phone a
  // wall of Microsoft instructions above the form is how somebody gives up
  // before reaching it (Designer).
  // Answered before the branding form loads, like the mail tab: this one has
  // its own reads and does not need a colour on screen to be useful.
  if (tab === 'content' && canEdit) {
    return <div>
      <h1>ตั้งค่ายิม</h1>
      <p className="sub">เนื้อหาที่สมาชิกอ่านใน "ช่วยเล่น" และบนหน้าที่เปิดจาก QR ข้างเครื่อง
        · แก้ได้ทุกช่อง ไม่ต้องรอทีมพัฒนา</p>
      <SettingsTabs tab={tab} setTab={setTab} dot={dot} canEdit={canEdit}/>
      <ContentSettings onAuthError={onAuthError} onSaved={onSaved}/>
    </div>;
  }

  // Neither of these needs the branding form, so both are answered before the
  // screen waits for one -- the same shortcut the mail and content tabs take.
  if (tab === 'reports' && canEdit) {
    return <div>
      <h1>ตั้งค่ายิม</h1>
      <p className="sub">ตัวเลขของยิมนี้ · ดูบนจอ พิมพ์ลงกระดาษ หรือดาวน์โหลดเป็น CSV ไปเปิดใน Excel</p>
      <SettingsTabs tab={tab} setTab={setTab} dot={dot} canEdit={canEdit}/>
      <AdminReports/>
    </div>;
  }

  if (tab === 'users' && canEdit) {
    return <div>
      <h1>ตั้งค่ายิม</h1>
      <SettingsTabs tab={tab} setTab={setTab} dot={dot} canEdit={canEdit}/>
      <UserAccounts onAuthError={onAuthError} signedInAs={signedInAs} onSignedOut={onSignedOut}/>
    </div>;
  }

  if (tab === 'mail') {
    return <div className={canEdit ? '' : 'readonly'}>
      <h1>ตั้งค่ายิม</h1>
      <p className="sub">กล่องจดหมายที่ระบบใช้ส่งออก · ใช้ส่งบัตรสมาชิกให้ลูกค้า และลิงก์ลืมรหัสผ่านของพนักงาน</p>
      <SettingsTabs tab={tab} setTab={setTab} dot={dot} canEdit={canEdit}/>
      <MailSettings onAuthError={onAuthError}
        onSaved={message => { onSaved?.(message); mail.reload().catch(() => {}); }}
        onStatus={() => mail.reload().catch(() => {})}/>
    </div>;
  }

  if (busy || !form) return <><h1>ตั้งค่ายิม</h1><p className="sub">กำลังโหลด…</p>
    <Loading label="กำลังโหลดการตั้งค่า…" rows={3}/></>;
  if (error) return <><h1>ตั้งค่ายิม</h1><StateBox error={error} onRetry={() => reload().catch(() => {})}/></>;

  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  // Everything below is worked out in the browser as the owner types, by the
  // same file the server uses when it draws the card.
  const derived = Brand.deriveAll(form.color_primary || SYSTEM_GREEN, form.color_secondary || null);
  const shortName = (form.brand_short || '').trim() || data.brand_short;
  const plate = data.logo_avg ? Brand.logoNeedsPlate(data.logo_avg, derived.brandSurface) : false;
  const changed = [
    form.brand_short !== (data.brand_short_source === 'gym' ? data.brand_short : ''),
    form.color_primary !== data.theme.brand,
    form.color_secondary !== (data.color_secondary_source === 'gym' ? data.theme.brand_2 : ''),
    form.line_id !== (data.line_id ?? ''),
    form.invite_code !== (data.invite_code ?? ''),
    form.appbar_style !== data.theme.appbar,
  ].filter(Boolean).length;

  async function save() {
    setSaving(true); setFailure(null);
    try {
      await api('/gym/settings', { method: 'PUT', body: { ...form, version: data.version } });
      await reload();
      onSaved?.('บันทึกการตั้งค่ายิมแล้ว · บัตรใบใหม่ทุกใบจะใช้สีนี้');
    } catch (e) { setFailure(e); onAuthError(e); } finally { setSaving(false); }
  }

  async function sendLogo(file) {
    if (!file) return;
    setUploading(true); setUploadError(null);
    const body = new FormData();
    body.append('logo', file);
    // The logo is settings too: two owners on two tablets must not be able to
    // put back a logo the other one just replaced.
    body.append('version', String(data.version));
    try {
      await upload('/gym/settings/logo', body, 'PUT');
      await reload();
      onSaved?.('อัปโหลดโลโก้แล้ว');
    } catch (e) { setUploadError(e); onAuthError(e); } finally { setUploading(false); }
  }

  async function removeLogo() {
    setUploading(true); setUploadError(null);
    try {
      await api('/gym/settings/logo', { method: 'DELETE', body: { version: data.version } });
      await reload(); onSaved?.('เอาโลโก้ออกแล้ว');
    }
    catch (e) { setUploadError(e); onAuthError(e); } finally { setUploading(false); }
  }

  const preview = <div className="previewcol">
    <div>
      <div className="pvlabel">บัตรสมาชิก · 1080 × 1350</div>
      <CardPreview derived={derived} branding={data} name={data.brand} shortName={shortName}
        phone={data.phone} lineId={form.line_id} address={data.address} plate={plate}/>
    </div>
    <div>
      <div className="pvlabel">หัวแอป</div>
      <BarPreview derived={derived} branding={data} name={data.brand} shortName={shortName}
        appbar={form.appbar_style}/>
    </div>
    <div>
      <div className="pvlabel">ปุ่มและป้าย</div>
      <div className="pvbtns" style={{ '--brand-surface': derived.brandSurface, '--on-brand': derived.onBrand,
        '--brand-2': derived.brand2, '--on-brand-2': derived.onBrand2 }}>
        <button className="btn primary" type="button" tabIndex={-1}>บันทึก</button>
        <button className="btn ghost" type="button" tabIndex={-1}>ยกเลิก</button>
      </div>
      <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-3)', flexWrap: 'wrap' }}>
        <span className="chip ok">✓ ใช้งานอยู่</span><span className="chip bad">✕ หมดอายุ</span>
      </div>
      <p className="note" style={{ marginTop: 'var(--sp-3)', fontSize: 'var(--fs-14)' }}>
        ป้าย “ใช้งานอยู่/หมดอายุ” และผลสแกนไม่เปลี่ยนตามสีแบรนด์ เพราะสื่อว่าผ่านหรือไม่ผ่าน</p>
    </div>
  </div>;

  if (!canEdit) {
    return <div className="readonly">
      <h1>ตั้งค่ายิม</h1>
      <p className="sub">ดูได้อย่างเดียว · เฉพาะเจ้าของยิมที่แก้ไขได้</p>
      <SettingsTabs tab={tab} setTab={setTab} dot={dot} canEdit={canEdit}/>
      <div className="alert info" style={{ marginBottom: 'var(--sp-5)' }}><span className="ic">i</span>
        <div><b>คุณเข้าใช้งานในฐานะพนักงาน</b>
          <span>ถ้าต้องแก้ชื่อ โลโก้ หรือสี ให้แจ้งเจ้าของยิม · หน้านี้เปิดไว้เพื่อให้คุณตอบลูกค้าได้ว่าเบอร์โทรและ LINE
            ของยิมคืออะไร</span></div></div>
      <div className="setgrid">
        <div>
          <div className="sect">
            <h2>ข้อมูลยิม</h2>
            <div className="row"><span className="muted">ชื่อยิม</span><b>{data.brand}</b></div>
            <div className="row"><span className="muted">ชื่อย่อบนบัตร</span><b>{data.brand_short}</b></div>
            <div className="row"><span className="muted">เบอร์โทร</span>
              <b className="num">{formatPhone(data.phone) ?? '—'}</b></div>
            <div className="row"><span className="muted">LINE ID</span><b>{data.line_id || '—'}</b></div>
            <div className="row"><span className="muted">ที่อยู่</span><b>{data.address || '—'}</b></div>
          </div>
        </div>
        {preview}
      </div>
    </div>;
  }

  return <>
    <h1>ตั้งค่ายิม</h1>
    <p className="sub">ชื่อ โลโก้ และสีของยิม · มีผลกับหัวแอป ปุ่ม หน้าเข้าสู่ระบบ และบัตรสมาชิก</p>
    <SettingsTabs tab={tab} setTab={setTab} dot={dot} canEdit={canEdit}/>
    <div className="setgrid">
      <div>
        <div className="sect">
          <h2>ข้อมูลยิม</h2>
          <p className="note">ชื่อยิม เบอร์โทร และที่อยู่ แก้ที่หน้า “ข้อมูลยิม” เพราะใช้ร่วมกับเวลาเปิดทำการ</p>
          <div className="row"><span className="muted">ชื่อยิม</span><b>{data.brand}</b></div>
          <div className="field" style={{ marginTop: 'var(--sp-4)' }}>
            <label htmlFor="brand_short">ชื่อย่อบนบัตร</label>
            <input id="brand_short" value={form.brand_short} maxLength={12} style={{ maxWidth: 160 }}
              placeholder={data.brand_short} onChange={e => set('brand_short', e.target.value)}/>
            <p className="hint">2–3 ตัวอักษร ใช้แทนโลโก้เมื่อยังไม่ได้อัปโหลด · เว้นว่างไว้ ระบบจะย่อชื่อยิมให้เอง</p>
          </div>
        </div>

        <div className="sect">
          <h2>โลโก้</h2>
          <p className="note">PNG พื้นใสดีที่สุด · JPG ก็ได้ · ไม่เกิน 2 MB</p>
          {uploadError && <div className="alert err"><span className="ic">✕</span>
            <div><b>อัปโหลดโลโก้ไม่สำเร็จ</b><span>{uploadError.message}</span></div></div>}
          {uploading
            ? <div className="drop has">
                <div className="logobox skel"/>
                <div><b>กำลังอัปโหลดและย่อขนาด…</b>
                  <p className="note" style={{ margin: '2px 0 0' }}>กำลังดึงสีเด่นจากโลโก้ ใช้เวลาไม่ถึงวินาที</p></div>
              </div>
            : data.has_logo
              ? <div className="drop has">
                  <div className="logobox alpha"><img src={data.logo_url} alt="โลโก้ยิม"/></div>
                  <div>
                    <b>โลโก้ปัจจุบัน</b>
                    <p className="note" style={{ margin: '2px 0 10px' }}>
                      {plate ? 'บนบัตรจะมีแผ่นขาวรองให้ เพราะสีโลโก้ใกล้กับสีหัวบัตร' : 'บนบัตรวางบนหัวบัตรได้เลย ไม่ต้องมีแผ่นรอง'}</p>
                    <div className="btn-row">
                      <label className="btn ghost" style={{ minHeight: 48, fontSize: 'var(--fs-16)', width: 'auto' }}>
                        เปลี่ยนโลโก้
                        <input type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }}
                          aria-label="เปลี่ยนโลโก้" onChange={e => sendLogo(e.target.files?.[0])}/>
                      </label>
                      <button className="btn ghost" style={{ minHeight: 48, fontSize: 'var(--fs-16)', width: 'auto' }}
                        onClick={removeLogo}>เอาออก</button>
                    </div>
                  </div>
                </div>
              : <>
                  <div className="drop">
                    <div className="ic" aria-hidden="true">▣</div>
                    <b>เลือกไฟล์โลโก้</b>
                    <p className="note" style={{ margin: 0, maxWidth: '40ch' }}>
                      PNG พื้นใสดีที่สุด · JPG ก็ได้ · ไม่เกิน 2 MB</p>
                    <label className="btn primary" style={{ width: 'auto', minWidth: 220 }}>
                      เลือกไฟล์โลโก้
                      <input type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }}
                        aria-label="เลือกไฟล์โลโก้" onChange={e => sendLogo(e.target.files?.[0])}/>
                    </label>
                  </div>
                  <div className="alert info"><span className="ic">i</span>
                    <div><b>ยังไม่มีโลโก้ก็เริ่มใช้ได้</b>
                      <span>บัตรจะขึ้นชื่อย่อ “{shortName}” ในกรอบสีแบรนด์แทน ·
                        อัปโหลดทีหลังแล้วบัตรใบเดิมจะเปลี่ยนตามเองเมื่อส่งใหม่</span></div></div>
                </>}
        </div>

        <div className="sect">
          <h2>สีของยิม</h2>
          <p className="note">{data.has_logo
            ? 'สีเด่นที่ดึงจากโลโก้ กดเลือกได้เลย หรือจิ้มสีเองด้านล่าง'
            : 'ยังไม่มีโลโก้ให้ดึงสี เลือกสีเองได้เลย หรือใช้สีเขียวเริ่มต้นของระบบ'}</p>

          {data.palette.length > 0 && <>
            <div className="pvlabel" style={{ marginTop: 'var(--sp-4)' }}>
              {data.has_logo ? 'สีเด่นจากโลโก้' : 'สีของระบบ'}</div>
            <div className="swatches">{data.palette.map(hex =>
              <button key={hex} className="sw" type="button" aria-label={`ใช้สี ${hex}`}
                aria-pressed={form.color_primary.toUpperCase() === hex.toUpperCase()}
                onClick={() => set('color_primary', hex)}>
                <i style={{ background: hex }}/><span>{hex}</span>
              </button>)}
            </div>
          </>}

          <div className="colorrow" style={{ marginTop: 'var(--sp-5)' }}>
            <input type="color" className="swatch-in" aria-label="เลือกสีหลัก"
              value={form.color_primary} onChange={e => set('color_primary', e.target.value.toUpperCase())}/>
            <div className="field"><label htmlFor="color_primary">สีหลัก</label>
              <input id="color_primary" className="num" maxLength={7} spellCheck="false"
                value={form.color_primary} onChange={e => set('color_primary', e.target.value)}/></div>
          </div>

          <div className="colorrow" style={{ marginTop: 'var(--sp-4)' }}>
            <input type="color" className="swatch-in" aria-label="เลือกสีรอง"
              value={form.color_secondary || derived.brand2}
              onChange={e => set('color_secondary', e.target.value.toUpperCase())}/>
            <div className="field"><label htmlFor="color_secondary">สีรอง <span className="muted"
              style={{ fontWeight: 400 }}>(ไม่ใส่ก็ได้)</span></label>
              <input id="color_secondary" className="num" maxLength={7} spellCheck="false"
                placeholder="ระบบคำนวณให้" value={form.color_secondary}
                onChange={e => set('color_secondary', e.target.value)}/></div>
            <button className="btn ghost" style={{ width: 'auto', minHeight: 'var(--tap)', fontSize: 'var(--fs-16)' }}
              onClick={() => set('color_secondary', '')}>ให้ระบบคำนวณ</button>
          </div>
          <p className="hint" style={{ marginTop: 8 }}>สีรองใช้กับปุ่มตอนกด แถบล่างบัตร และพื้นหน้าเข้าสู่ระบบ</p>

          <label className="pick" style={{ marginTop: 'var(--sp-5)' }}>
            <input type="checkbox" checked={form.appbar_style === 'brand'} aria-label="ทำหัวแอปเป็นสีแบรนด์"
              onChange={e => set('appbar_style', e.target.checked ? 'brand' : 'light')}/>
            <span className="n"><b>ทำหัวแอปเป็นสีแบรนด์</b>
              <span className="sm">ค่าเริ่มต้นคือหัวขาวมีเส้นสีแบรนด์ใต้ ซึ่งปลอดภัยกับโลโก้ทุกแบบมากกว่า</span></span>
          </label>

          <div className="ratios">{ratioRows(derived).map(row =>
            <div key={row.key} className={`ratio ${row.value >= row.need ? 'pass' : 'fixed'}`}>
              <span className="dot" style={{ background: row.bg, color: row.fg, border: '1px solid var(--line)' }}
                aria-hidden="true">{row.sample}</span>
              <span className="lbl">{row.label}</span>
              <b>{row.value.toFixed(2)}:1</b>
            </div>)}
          </div>
          {derived.notes.map(note =>
            <div key={note.title} className={`alert ${note.level === 'warn' ? 'warn' : 'info'}`}>
              <span className="ic">!</span><div><b>{note.title}</b><span>{note.body}</span></div>
            </div>)}
        </div>

        <div className="sect">
          <h2>ข้อมูลติดต่อท้ายบัตร</h2>
          <p className="note">ไม่ใส่ก็ได้ · ช่องที่เว้นว่างจะไม่ขึ้นบนบัตร · เบอร์โทรและที่อยู่แก้ที่หน้า “ข้อมูลยิม”</p>
          <div className="row"><span className="muted">เบอร์โทร</span>
            <b className="num">{formatPhone(data.phone) ?? 'ไม่แสดงบนบัตร'}</b></div>
          <div className="row"><span className="muted">ที่อยู่</span><b>{data.address || '—'}</b></div>
          <div className="field" style={{ marginTop: 'var(--sp-4)', marginBottom: 0 }}>
            <label htmlFor="line_id">LINE ID</label>
            <input id="line_id" value={form.line_id} maxLength={60}
              onChange={e => set('line_id', e.target.value)}/>
            <p className="hint">พิมพ์ต่อท้ายเบอร์โทรที่ท้ายบัตร เว้นว่างไว้ก็ได้</p>
          </div>
        </div>

        {/* Not a colour and not on the card, but it belongs to the owner and
            nowhere else: a second screen for one field would be a screen
            nobody ever finds. Only the owner sees this block -- staff open
            this page to read the LINE ID aloud, not to hand out keys. */}
        {canEdit && <div className="sect">
          <h2>รหัสเชิญของยิม</h2>
          <p className="note">ฟอร์ม “ขอบัญชีพนักงาน” เปิดให้ใครก็กรอกได้ ตั้งรหัสเชิญไว้แล้วจะกรอกได้เฉพาะคนที่รู้รหัส
            · เว้นว่างไว้ = เปิดให้ทุกคน (คุณยังต้องกดอนุมัติเองอยู่ดี)</p>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="invite_code">รหัสเชิญ</label>
            <input id="invite_code" value={form.invite_code} maxLength={60} autoComplete="off"
              placeholder="เว้นว่างไว้ = ไม่ต้องใช้รหัสเชิญ"
              onChange={e => set('invite_code', e.target.value)}/>
            <p className="hint">บอกรหัสนี้กับพนักงานใหม่ตัวต่อตัว ไม่ส่งลงกลุ่ม · เปลี่ยนได้ทุกเมื่อ
              รหัสเดิมจะใช้ไม่ได้ทันทีที่บันทึก</p>
          </div>
        </div>}
      </div>
      {preview}
    </div>

    <Notice error={failure}/>
    <div className="savebar">
      <span className="grow">{changed
        ? `แก้ไขแล้ว ${changed} อย่าง · ยังไม่ได้บันทึก`
        : 'ยังไม่มีอะไรเปลี่ยน'}</span>
      <button className="btn ghost" disabled={!changed || saving}
        onClick={() => setForm({
          brand_short: data.brand_short_source === 'gym' ? data.brand_short : '',
          color_primary: data.theme.brand,
          color_secondary: data.color_secondary_source === 'gym' ? data.theme.brand_2 : '',
          line_id: data.line_id ?? '',
          invite_code: data.invite_code ?? '',
          appbar_style: data.theme.appbar,
        })}>คืนค่าเดิม</button>
      <button className="btn primary" disabled={!changed || saving} onClick={save}>
        {saving ? 'กำลังบันทึก…' : 'บันทึกการตั้งค่า'}</button>
    </div>
  </>;
}
