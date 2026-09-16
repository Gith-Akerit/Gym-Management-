import { useEffect, useState } from 'react';
import { api, Field, Loading, StateBox, useBranding, useResource } from './shared.jsx';

/**
 * The member portal, "ช่วยเล่น".
 *
 * A different product from the counter app, not the counter app with menus
 * hidden. A member who is shown the shell of a staff system with things
 * greyed out spends the visit wondering what is behind them; a member who is
 * shown something built for them does not (Designer).
 *
 * So: no side rail, no role badge, three tabs along the bottom where a thumb
 * can reach them, and a reading width of 720px. Ninety-five per cent of the
 * time this is opened one-handed, standing in a gym, on a phone.
 */

const ICONS = {
  home: ['M4 11.5 12 4l8 7.5', 'M6 10.5V20h12v-9.5'],
  machines: ['M3 9h3v6H3zM18 9h3v6h-3z', 'M6 12h12', 'M8 7h2v10H8zM14 7h2v10h-2z'],
  articles: ['M5 4h11l3 3v13H5z', 'M9 9h6M9 13h6M9 17h3'],
  goal: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z', 'M12 11.4a.6.6 0 1 0 0 1.2.6.6 0 0 0 0-1.2Z'],
  chevron: ['m9 6 6 6-6 6'],
};

const Icon = ({ name, className }) => <svg className={className} viewBox="0 0 24 24" fill="none"
  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  {(ICONS[name] ?? []).map(d => <path key={d} d={d}/>)}
</svg>;

const TABS = [
  ['home', 'ช่วยเล่น', 'home'],
  ['machines', 'วิธีใช้เครื่อง', 'machines'],
  ['articles', 'เทคนิค', 'articles'],
];

/** The shell: a bar with the gym on it, the page, and three tabs. */
function Shell({ brand, branding, me, tab, setTab, onSignOut, children }) {
  return <>
    <header className="mtop">
      <div className="mtop-in">
        <span className="mk">
          {branding?.logo_url
            ? <img src={branding.logo_url} alt={`โลโก้ของ ${brand}`}/>
            : <span>{branding?.brand_short || 'ยม'}</span>}
        </span>
        {/* The gym's name and the page, and nothing about permissions: a
            member has no role to be told about (Designer). */}
        <div className="nm">{brand}<span>ช่วยเล่น</span></div>
        <div className="spacer"/>
        <button className="acct" type="button" aria-label={`บัญชีของ ${me?.name ?? ''}`}
          onClick={onSignOut}>{(me?.name ?? '?').trim().charAt(0)}</button>
      </div>
    </header>

    <nav className="mnav" aria-label="เมนูสมาชิก">
      <ul>{TABS.map(([key, label, icon]) => <li key={key}>
        <a href={`#${key}`} aria-current={tab === key ? 'page' : undefined}
          onClick={event => { event.preventDefault(); setTab(key); }}>
          <Icon name={icon}/>{label}</a>
      </li>)}</ul>
    </nav>

    <main className="mwrap">{children}</main>
  </>;
}

/** Screen H: the membership ran out. Reachable only from inside the door. */
function Expired({ detail, phone, onSignOut }) {
  return <div className="wall">
    <div className="wi" aria-hidden="true">⏳</div>
    <h1>สมาชิกหมดอายุแล้ว</h1>
    {detail?.expired_on && <div className="when">หมดอายุ {detail.expired_on}</div>}
    <p>ต่ออายุที่เคาน์เตอร์แล้วเข้าได้เลย <b>ด้วยรหัสผ่านเดิม ไม่ต้องตั้งใหม่</b></p>
    {/* Said out loud because a great many people assume an expired membership
        means the account is gone (Designer). */}
    <p className="note">บัญชีของคุณไม่ได้ถูกลบ ข้อมูลยังอยู่ครบ</p>
    {phone && <a className="btn primary xl" href={`tel:${phone}`}>โทรหายิม {phone}</a>}
    <button className="btn" style={{ marginTop: 'var(--sp-3)' }} onClick={onSignOut}>ออกจากระบบ</button>
  </div>;
}

function Home({ data, onOpenProgram, setTab }) {
  return <>
    <div className="hello">
      <h1>สวัสดี {data.name}</h1>
      <p>วันนี้จะเล่นอะไรดี เลือกเป้าหมายแล้วทำตามทีละท่าได้เลย</p>
    </div>

    {data.safety?.body?.length > 0 && <div className="safety">
      <b><span aria-hidden="true">!</span>{data.safety.title || 'ก่อนเริ่มเล่น อ่านสักครู่'}</b>
      {data.safety.body.map(line => <p key={line}>{line}</p>)}
    </div>}

    <div className="sechead"><h2>โปรแกรมแนะนำ</h2></div>
    <div className="goals">
      {data.programs.map(program => <a key={program.code} href={`#program-${program.code}`} className="goal"
        onClick={event => { event.preventDefault(); onOpenProgram(program.code); }}>
        <span className="gi"><Icon name="goal"/></span>
        <span className="gt"><b>{program.name_th}</b>
          <span>{[program.level, program.frequency_per_week, program.minutes_per_session]
            .filter(Boolean).join(' · ')}</span></span>
        <span className="go"><Icon name="chevron"/></span>
      </a>)}
      {!data.programs.length && <p className="note">ยังไม่มีโปรแกรมในระบบ ถามพนักงานที่เคาน์เตอร์ได้</p>}
    </div>

    <div className="sechead"><h2>ทางลัด</h2></div>
    <div className="quick">
      <a className="qcard" href="#machines" onClick={e => { e.preventDefault(); setTab('machines'); }}>
        <span className="qi"><Icon name="machines"/></span>
        <b>วิธีใช้เครื่อง</b><span>{data.machines.length} เครื่อง</span>
      </a>
      <a className="qcard" href="#articles" onClick={e => { e.preventDefault(); setTab('articles'); }}>
        <span className="qi"><Icon name="articles"/></span>
        <b>เทคนิค</b><span>{data.articles.length} เรื่อง</span>
      </a>
    </div>
  </>;
}

function Program({ code, onBack }) {
  const { data, error, busy } = useResource(`/m/programs/${code}`);
  if (busy) return <Loading label="กำลังโหลดโปรแกรม…" rows={4}/>;
  if (error) return <StateBox error={error}/>;
  const { program, before_start: before } = data;

  return <>
    <div className="phero">
      <h1>{program.name_th}</h1>
      <p>{program.for_whom}</p>
      <div className="pstats">
        <div><span>ระดับ</span><b>{program.level || '—'}</b></div>
        <div><span>กี่วันต่อสัปดาห์</span><b>{program.frequency_per_week || '—'}</b></div>
        <div><span>ต่อครั้ง</span><b>{program.minutes_per_session || '—'}</b></div>
      </div>
    </div>

    {before?.length > 0 && <div className="safety">
      <b><span aria-hidden="true">!</span>ก่อนเริ่มทุกครั้ง</b>
      {before.map(line => <p key={line}>{line}</p>)}
    </div>}

    {/* The numbers below carry this gym's name, so a member reads them as
        instruction from the gym. While nobody at the gym has checked them,
        that has to be on the screen -- not in a README (Planner, Mika). */}
    {program.values_are_examples && <div className="tip">
      <span className="ti" aria-hidden="true">i</span>
      <div><b>ตัวเลขเป็นค่าตัวอย่างเริ่มต้น</b>
        <p>{program.trainer_note || 'เทรนเนอร์ของยิมปรับให้เหมาะกับคุณได้ ถามที่เคาน์เตอร์ได้เลย'}</p></div>
    </div>}

    <div className="sechead"><h2>ทำตามลำดับนี้</h2></div>
    <ol className="steps-x">
      {program.stations.map(station => <li key={station.order}>
        <div className="xb">
          <b>{station.machine_name}</b>
          {station.role && <span className="note" style={{ display: 'block' }}>{station.role}</span>}
          <div className="dose">
            {station.sets && <div><span>เซ็ต</span><b>{station.sets}</b></div>}
            {station.reps && <div><span>ครั้ง</span><b>{station.reps}</b></div>}
            {station.duration && <div><span>เวลา</span><b>{station.duration}</b></div>}
            {station.rest && <div><span>พัก</span><b>{station.rest}</b></div>}
          </div>
          {station.note && <p className="note" style={{ marginTop: 8 }}>{station.note}</p>}
          {/* The machine page is the public one behind the sticker: written
              once, read from both places. */}
          {station.machine_exists && <a className="xlink" href={`/m/${station.machine}`}>
            ดูวิธีใช้ <Icon name="chevron"/></a>}
        </div>
      </li>)}
    </ol>

    {program.progression && <>
      <div className="sechead"><h2>เพิ่มน้ำหนักเมื่อไหร่</h2></div>
      <p className="note">{program.progression}</p>
    </>}
    {program.next_program && <p className="note">{program.next_program}</p>}

    <a className="backlink" href="#home" onClick={e => { e.preventDefault(); onBack(); }}>
      ← กลับหน้าแรก</a>
  </>;
}

const MachineList = ({ items }) => <>
  <div className="hello"><h1>วิธีใช้เครื่อง</h1>
    <p>เปิดหน้าไหนก็ได้ · หน้าเดียวกับที่สแกน QR ที่ตัวเครื่องในยิม</p></div>
  <div className="goals">
    {items.map(machine => <a key={machine.code} className="goal" href={`/m/${machine.code}`}>
      <span className="gi"><Icon name="machines"/></span>
      <span className="gt"><b>{machine.name_th}</b>
        <span>{machine.muscles.join(' · ') || machine.name_en}</span></span>
      <span className="go"><Icon name="chevron"/></span>
    </a>)}
  </div>
</>;

function Articles({ items }) {
  const [open, setOpen] = useState(null);
  const { data } = useResource('/public/articles');
  const full = data?.items ?? [];
  if (open) {
    const article = full.find(entry => entry.code === open);
    return <>
      <div className="hello"><h1>{article?.title ?? ''}</h1></div>
      {(article?.body ?? []).map(line => <p key={line}>{line}</p>)}
      <a className="backlink" href="#articles" onClick={e => { e.preventDefault(); setOpen(null); }}>
        ← กลับรายการเทคนิค</a>
    </>;
  }
  return <>
    <div className="hello"><h1>เทคนิค</h1><p>เรื่องที่มือใหม่ถามบ่อยที่สุด</p></div>
    <div className="goals">
      {items.map(article => <a key={article.code} className="goal" href={`#article-${article.code}`}
        onClick={e => { e.preventDefault(); setOpen(article.code); }}>
        <span className="gi"><Icon name="articles"/></span>
        <span className="gt"><b>{article.title}</b></span>
        <span className="go"><Icon name="chevron"/></span>
      </a>)}
    </div>
  </>;
}

/** The member's sign-in, at /m/login. Answers one sentence whatever is true. */
function MemberLogin({ brand, branding, onSignedIn }) {
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError(null);
    try { onSignedIn(await api('/auth/member/login', { method: 'POST', body: { email, password } })); }
    catch (failure) { setError(failure); } finally { setBusy(false); }
  }

  return <div className="authstage">
    <div className="authbox">
      <div className="authtop">
        <span className="mk">
          {branding?.logo_url
            ? <img src={branding.logo_url} alt={`โลโก้ของ ${brand}`}/>
            : <span>{branding?.brand_short || 'ยม'}</span>}
        </span>
        <h1>{brand}</h1>
        <p>ช่วยเล่น · สำหรับสมาชิก</p>
      </div>
      <form className="authcard" onSubmit={submit}>
        <h2>เข้าสู่ระบบสมาชิก</h2>
        {/* Says which address, so somebody who never gave one stops guessing
            (Designer): they cannot get in and the counter has to add it. */}
        <p className="lead">ใช้อีเมลที่ให้ไว้ตอนสมัครสมาชิกที่เคาน์เตอร์</p>
        <Field label="อีเมล" name="m-email" type="email" value={email} onChange={setEmail}
          required autoComplete="username" disabled={busy}/>
        <div className={`field${error ? ' invalid' : ''}`}>
          <label htmlFor="m-password">รหัสผ่าน</label>
          <input id="m-password" type="password" value={password} autoComplete="current-password"
            required disabled={busy} onChange={event => setPassword(event.target.value)}/>
          {error && <p className="err" role="alert">✕ {error.message}</p>}
        </div>
        <button className="btn primary xl" disabled={busy}>
          {busy ? <><span className="spin"/>กำลังเข้าสู่ระบบ…</> : 'เข้าสู่ระบบ'}</button>
      </form>
      <p className="authhelp">ยังไม่เคยตั้งรหัสผ่าน ให้เปิดลิงก์ในอีเมลที่ยิมส่งบัตรสมาชิกไปให้ ·
        ลิงก์หมดอายุแล้วขอใหม่ได้ที่เคาน์เตอร์</p>
    </div>
  </div>;
}

export function MemberPortal() {
  const [branding] = useBranding();
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('home');
  const [program, setProgram] = useState(null);
  const [home, setHome] = useState(null);
  const [expired, setExpired] = useState(null);

  const brand = branding?.brand || 'ยิมของเรา';

  useEffect(() => {
    api('/m/me').then(setMe).catch(() => setMe(null)).finally(() => setLoading(false));
  }, []);

  // The home payload is behind the paid-up gate, so its refusal is what turns
  // on screen H -- checked per request, not once at sign-in.
  useEffect(() => {
    if (!me) return;
    setExpired(null);
    api('/m/home').then(setHome).catch(failure => {
      if (failure.status === 402) setExpired(failure);
      else setHome(null);
    });
  }, [me]);

  const signOut = async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* gone either way */ }
    setMe(null); setHome(null); setExpired(null);
  };

  if (loading) return <main className="empty" role="status">กำลังเปิด…</main>;
  if (!me) {
    return <MemberLogin brand={brand} branding={branding}
      onSignedIn={() => api('/m/me').then(setMe).catch(() => setMe(null))}/>;
  }
  if (expired || me.active === false) {
    return <Shell brand={brand} branding={branding} me={me} tab={tab} setTab={setTab} onSignOut={signOut}>
      <Expired detail={expired ?? me} phone={branding?.phone} onSignOut={signOut}/>
    </Shell>;
  }
  if (!home) return <main className="empty" role="status">กำลังโหลด…</main>;

  return <Shell brand={brand} branding={branding} me={me}
    tab={tab} setTab={key => { setTab(key); setProgram(null); }} onSignOut={signOut}>
    {tab === 'home' && (program
      ? <Program code={program} onBack={() => setProgram(null)}/>
      : <Home data={home} onOpenProgram={setProgram} setTab={setTab}/>)}
    {tab === 'machines' && <MachineList items={home.machines}/>}
    {tab === 'articles' && <Articles items={home.articles}/>}
  </Shell>;
}
