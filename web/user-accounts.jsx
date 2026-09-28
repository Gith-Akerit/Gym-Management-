import React, { useState } from 'react';
import { api, Empty, Field, formatDateTime, Loading, Notice, StateBox, useResource } from './shared.jsx';
import { PendingRequests } from './user-requests.jsx';

/**
 * "บัญชีผู้ใช้" — who may sign in, and as what.
 *
 * Its own file rather than a block inside `main.jsx` because it is now a tab
 * of ตั้งค่ายิม as well as an entry in the corner menu, and a screen
 * imported from two places cannot live in the file that imports one of them.
 * Nothing in it changed in the move except the name it is exported under.
 */


const roleLabels = { admin: 'ผู้ดูแลระบบ', staff: 'พนักงาน', member: 'สมาชิก' };

export function UserAccounts({ onAuthError, signedInAs, onSignedOut }) {
  const [q, setQ] = useState(''), [page, setPage] = useState(1);
  const { data, error, busy, reload } = useResource(`/users?q=${encodeURIComponent(q)}&page=${page}`);
  const requests = useResource('/users/requests');
  const [email, setEmail] = useState(''), [role, setRole] = useState('staff'), [secret, setSecret] = useState('');
  const [working, setWorking] = useState(false), [actionError, setActionError] = useState(null), [notice, setNotice] = useState('');
  // { email, url, expires_at } for the one link on screen. One at a time on
  // purpose: a list of live links is a list of ways into other people's
  // accounts, sitting on a shared counter tablet.
  const [link, setLink] = useState(null);
  const [copied, setCopied] = useState(false);

  async function makeLink(user) {
    setWorking(true); setActionError(null); setNotice(''); setCopied(false);
    try { setLink(await api(`/users/${user.id}/password-link`, { method: 'POST', body: {} })); }
    catch (e) { setActionError(e); onAuthError(e); } finally { setWorking(false); }
  }

  async function act(path, options, message, farewell) {
    setWorking(true); setActionError(null); setNotice('');
    try {
      const result = await api(path, options);
      if (farewell) return onSignedOut(farewell);
      setNotice(message);
      await reload();
      return result;
    } catch (e) { setActionError(e); onAuthError(e); return null; } finally { setWorking(false); }
  }
  const endsMyOwnSession = user => user.email === signedInAs;

  /**
   * Creating an account, and the link that makes it usable.
   *
   * An account with no password is an account nobody can sign in to, and the
   * owner has no way to set one for somebody else that does not involve
   * reading it out loud. So the server issues the link with the account and it
   * lands here -- the same box, the same copy button and the same warning as
   * the member's portal link, because it is the same kind of thing: handed
   * over once, face to face, and dead on use.
   */
  const invite = () => act('/users',
    { method: 'POST', body: { email, role, ...(secret ? { password: secret } : {}) } },
    secret ? 'สร้างบัญชีแล้ว' : 'สร้างบัญชีแล้ว · ส่งลิงก์ตั้งรหัสผ่านให้เจ้าตัว')
    .then(created => {
      if (!created) return;
      setEmail(''); setSecret(''); setCopied(false);
      if (created.setup_link) setLink({ email: created.email, ...created.setup_link });
    });

  /** A password the owner can read aloud: letters, digits, no lookalikes. */
  const suggest = () => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const digits = '23456789';
    const pick = set => set[Math.floor(Math.random() * set.length)];
    return `Gym-${Array.from({ length: 4 }, () => pick(alphabet)).join('')}-${Array.from({ length: 4 }, () => pick(digits)).join('')}`;
  };

  return <>
    {/* An h2, not an h1: ตั้งค่ายิม above it owns the h1 now that this is one
        of its tabs. The words are unchanged -- they are what the manual, the
        corner menu and the staff all call this screen. */}
    <h2 className="tabhead">ผู้ใช้และสิทธิ์</h2>
    <p className="sub">ใครเข้าระบบได้และเข้าในฐานะอะไร · คนละเรื่องกับหน้า “สมาชิก” ซึ่งเป็นรายชื่อคนที่มาออกกำลังกาย</p>
    {notice && <div className="banner ok" role="status"><div className="ic" aria-hidden="true">✓</div><div><b>{notice}</b></div></div>}

    <PendingRequests list={requests} working={working} onAuthError={onAuthError}
      onDone={message => { setNotice(message); requests.reload(); reload(); }}/>

    <div className="block" style={{ marginBottom: 'var(--sp-5)' }}>
      <h2>เพิ่มบัญชีพนักงานหรือผู้ดูแลระบบ</h2>
      <div className="two">
        <Field name="new-user-email" label="อีเมล" type="email" value={email} onChange={setEmail}
          placeholder="staff2@example.com" error={actionError?.fields?.email}/>
        <Field name="new-user-role" label="สิทธิ์ของบัญชีใหม่" value={role} onChange={setRole}>
          <select>
            <option value="staff">พนักงาน — สแกนเช็คอินและสมัครสมาชิก</option>
            <option value="admin">ผู้ดูแลระบบ — จัดการทุกอย่าง</option>
          </select>
        </Field>
      </div>
      <div className="two">
        <Field name="new-user-password" label="ตั้งรหัสผ่านให้เขา (ไม่บังคับ)" value={secret} onChange={setSecret}
          error={actionError?.fields?.password}
          hint="อย่างน้อย 12 ตัวอักษร · บอกเขาแบบตัวต่อตัว ไม่ส่งลงกลุ่ม · เว้นว่างไว้แล้วตั้งทีหลังได้"/>
        <div className="field" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={() => setSecret(suggest())}>สุ่มรหัสผ่านให้</button>
        </div>
      </div>
      <Notice error={actionError}/>
      <button className="btn primary auto" disabled={!email.trim() || working} onClick={invite}>
        {working ? 'กำลังบันทึก…' : 'สร้างบัญชี'}</button>
    </div>

    {link && <div className="block" style={{ borderColor: 'var(--warn)', marginBottom: 'var(--sp-5)' }}>
      <h2>ลิงก์ตั้งรหัสผ่านของ {link.email}</h2>
      <p className="note">ส่งลิงก์นี้ให้เจ้าตัวโดยตรง · <b>ใช้ได้ครั้งเดียว</b> และหมดอายุ
        {' '}{formatDateTime(link.expires_at)} · คนที่ถือลิงก์นี้ตั้งรหัสผ่านของบัญชีนั้นได้ อย่าโพสต์ลงกลุ่ม</p>
      <div className="field">
        <label htmlFor="pwlink">ลิงก์</label>
        {/* Readable and selectable rather than hidden behind a copy button
            alone: on a counter tablet the copy button is the fast path, but
            somebody reading it out over the telephone needs to see it. */}
        <input id="pwlink" readOnly value={link.url} onFocus={e => e.target.select()}
          style={{ fontFamily: 'var(--font-num)' }}/>
      </div>
      <div className="btn-row">
        <button className="btn primary" onClick={() => {
          navigator.clipboard?.writeText(link.url).then(() => setCopied(true)).catch(() => setCopied(false));
        }}>{copied ? '✓ คัดลอกแล้ว' : 'คัดลอกลิงก์'}</button>
        <button className="btn ghost" onClick={() => { setLink(null); setCopied(false); }}>ปิด</button>
      </div>
    </div>}

    <h2>บัญชีที่มีอยู่ {data && <span className="chip neutral" style={{ marginLeft: 8 }}>
      ผู้ดูแลระบบที่ใช้งานได้ {data.admins} คน</span>}</h2>
    <div className="searchbig" style={{ marginTop: 'var(--sp-4)' }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
        <circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input type="search" value={q} aria-label="ค้นหาบัญชี" placeholder="อีเมล หรือชื่อสมาชิก"
        onChange={e => { setQ(e.target.value); setPage(1); }}/>
    </div>
    <StateBox error={error} onRetry={() => reload().catch(() => {})}/>
    {busy ? <Loading label="กำลังโหลด…" avatar={false}/> : !error && (
      !data.items.length ? <Empty title="ไม่พบบัญชีที่ค้นหา">ลองพิมพ์อีเมลเต็ม หรือล้างคำค้นหาเพื่อดูทั้งหมด</Empty>
        : <div className="table-wrap"><table className="utable" style={{ border: '2px solid var(--line-strong)', borderRadius: 'var(--r-2)', overflow: 'hidden' }}>
          <thead><tr><th>อีเมล</th><th>สิทธิ์</th><th>รหัสผ่าน</th><th>สถานะ</th><th/></tr></thead>
          <tbody>{data.items.map(user => <tr key={user.id}>
            <td data-label="อีเมล"><b>{user.email}</b>{user.member_name && <span className="note"> · {user.member_name}</span>}</td>
            <td data-label="สิทธิ์">
              {/* Your own row is read-only: the server refuses a change to your
                  own permissions, and a dropdown that always errors is worse
                  than one that is plainly not yours to use. */}
              <select aria-label={`สิทธิ์ของ ${user.email}`} value={user.role}
                disabled={working || endsMyOwnSession(user)}
                title={endsMyOwnSession(user) ? 'เปลี่ยนสิทธิ์ของตัวเองไม่ได้ ให้ผู้ดูแลระบบอีกคนเป็นคนเปลี่ยนให้' : undefined}
                onChange={e => act(`/users/${user.id}/role`, { method: 'PUT', body: { role: e.target.value } },
                  `เปลี่ยนสิทธิ์ของ ${user.email} แล้ว`)}>
                {Object.entries(roleLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
              {endsMyOwnSession(user) && <span className="note">บัญชีของคุณเอง</span>}</td>
            <td data-label="รหัสผ่าน">{user.role === 'member'
              ? <span className="muted">ไม่ต้องใช้</span>
              : <span className={`chip ${user.has_password ? 'ok' : 'bad'}`}>
                {user.has_password ? '✓ ตั้งแล้ว' : '✕ ยังไม่ได้ตั้ง'}</span>}</td>
            <td data-label="สถานะ"><span className={`chip ${user.status === 'suspended' ? 'bad' : 'ok'}`}>
              {user.status === 'suspended' ? '✕ ถูกระงับ' : '✓ ใช้งานได้'}</span></td>
            {/* A link, never a password. The button that used to set somebody
                else's password outright is gone: a password the owner types has
                to be said out loud to be handed over, and out loud turned into a
                group chat more than once. A link is handed over once and dies on
                use — and it is the way in while the gym's mailbox settings are
                still empty. */}
            <td data-label="">
              {user.role !== 'member' && <button className="btn ghost" disabled={working}
                aria-label={`สร้างลิงก์ตั้งรหัสผ่านของ ${user.email}`}
                onClick={() => makeLink(user)}>สร้างลิงก์ตั้งรหัสผ่าน</button>}
              <button className={user.status === 'suspended' ? 'btn ghost' : 'btn danger'} disabled={working}
                aria-label={`${user.status === 'suspended' ? 'คืนสิทธิ์' : 'ระงับ'}บัญชี ${user.email}`}
                onClick={() => act(`/users/${user.id}/${user.status === 'suspended' ? 'restore' : 'suspend'}`,
                  { method: 'POST', body: {} },
                  `${user.status === 'suspended' ? 'คืนสิทธิ์' : 'ระงับ'}บัญชี ${user.email} แล้ว`,
                  endsMyOwnSession(user) && user.status !== 'suspended'
                    ? 'ระงับบัญชีของคุณแล้ว ออกจากระบบ' : undefined)}>
                {user.status === 'suspended' ? 'คืนสิทธิ์' : 'ระงับบัญชี'}</button>
            </td>
          </tr>)}</tbody>
        </table></div>)}
    <p className="note" style={{ marginTop: 'var(--sp-4)' }}>
      การเปลี่ยนสิทธิ์หรือระงับบัญชีจะเตะคนนั้นออกจากระบบทันที <b>บอกเขาก่อนกด</b> ถ้าเขากำลังยืนสแกนอยู่หน้าเคาน์เตอร์ ·
      ระบบไม่ยอมให้เหลือผู้ดูแลระบบ 0 คน · การตั้งรหัสผ่านใหม่ก็เตะออกจากระบบเช่นกัน ·
      ทุกคนเปลี่ยนรหัสผ่านของตัวเองได้จากเมนูมุมขวาบน</p>
  </>;
}

