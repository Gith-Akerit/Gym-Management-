import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, Empty, Loading, Notice, StateBox, useResource } from './shared.jsx';

/**
 * "รายงาน" — the five reports, on one screen with one set of filters.
 *
 * Built to the same plan as "เครื่องและโปรแกรม" and "อีเมลของระบบ": a tab
 * inside ตั้งค่ายิม, one column, blocks down the page. Every number on it comes
 * from the server already worded and already rounded -- the browser adds no
 * arithmetic of its own, because a total on the screen that disagrees with the
 * total in the CSV is worse than no total at all.
 *
 * Three rules run through the whole file.
 *
 * The empty state is judged from the TOTALS, never from `items.length`. The
 * check-in report fills a quiet Tuesday with a row of zeros on purpose, so a
 * week with nothing in it arrives as seven rows and would have read as "we
 * have data" forever.
 *
 * Every table that can be cut off says so, with the real total and the way to
 * get the rest: five thousand rows is the ceiling of the screen, not of the
 * report.
 *
 * And nothing on this screen changes anything. There is no button here that
 * writes -- which is why the print and download buttons can sit in the open
 * next to a table of members' names without a confirmation between them.
 */

const TZ_OFFSET_MS = 7 * 3600000;
const DAY_MS = 86400000;
/** Today in Bangkok, by the same rule every date in every report uses. */
const thaiToday = () => new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 10);
const daysBefore = (day, count) =>
  new Date(Date.parse(`${day}T00:00:00Z`) - count * DAY_MS).toISOString().slice(0, 10);

const REPORTS = [
  { key: 'staff', path: 'staff-activity', tab: 'พนักงาน',
    title: 'พนักงานทำอะไรไปบ้าง', sub: 'ทุกการกระทำที่ระบบบันทึกไว้ เรียงจากล่าสุด · ค่าเริ่มต้นคือวันนี้' },
  { key: 'sales', path: 'sales', tab: 'ยอดขาย',
    title: 'ยอดขาย', sub: 'นับจากวันที่รับเงินจริง · ของแถมและรายการที่กลับรายการแยกอยู่ด้านล่าง' },
  { key: 'checkins', path: 'checkins', tab: 'เช็คอิน',
    title: 'การเข้าใช้บริการ', sub: 'รายวัน ช่วงเวลาที่คนเยอะ และเหตุผลที่สแกนไม่ผ่าน' },
  { key: 'members', path: 'members', tab: 'สมาชิก',
    title: 'สมาชิก', sub: 'ใครกำลังจะหมดอายุ ใครหมดแล้ว และใครสมัครใหม่ในช่วงนี้' },
  { key: 'issues', path: 'issues', tab: 'แจ้งปัญหา',
    title: 'เรื่องที่แจ้งไว้', sub: 'เรื่องที่พนักงานส่งเข้ามา พร้อมจำนวนวันที่ค้าง' },
];

const VIEWS = [['expiring', 'จะหมดอายุเร็ว ๆ นี้'], ['active', 'ใช้งานอยู่ทั้งหมด'],
  ['expired', 'หมดอายุแล้ว'], ['new', 'สมัครใหม่ในช่วงนี้']];

/** `2026-09-20` → `20/09/2569`, the same shape the server prints in the CSV. */
const thaiDate = day => {
  if (!day) return '';
  const [year, month, date] = day.split('-');
  return `${date}/${month}/${Number(year) + 543}`;
};

const nf = new Intl.NumberFormat('th-TH');
/** `1200.00` from the server → `1,200.00` for reading. Never recomputed here. */
const money = text => nf.format(Number(text ?? 0));

/**
 * A bar chart made of two divs and a percentage.
 *
 * No canvas and no charting library: this page prints, and a canvas prints as
 * a grey box on half the printers in Thailand. Every bar carries its number as
 * text beside the bar rather than inside it -- a number written on top of the
 * fill is a number that needs a second colour to stay readable at 1:4.5, and
 * the one at the end of a very short bar would have nothing to sit on.
 */
function Bars({ rows, caption, unit = '' }) {
  const top = Math.max(1, ...rows.map(row => row.value));
  return <div className="bars">
    <p className="note bars-cap">{caption}</p>
    <ul>
      {rows.map(row => <li key={row.key ?? row.label}>
        <span className="blabel">{row.label}</span>
        <span className="btrack"><span className="bfill" style={{ width: `${(row.value / top) * 100}%` }}/></span>
        <span className="bnum">{row.text ?? nf.format(row.value)}{unit}</span>
      </li>)}
    </ul>
  </div>;
}

/** "แสดง 5,000 จาก 7,412 รายการ" — only when the server says it cut something. */
const Truncated = ({ shown, total }) => <p className="trunc" role="status">
  แสดง {nf.format(shown)} จาก {nf.format(total)} รายการ · ดาวน์โหลด CSV เพื่อดูทั้งหมด
</p>;

/** The sentence under every table: what this table adds up to. */
const TableWrap = ({ children }) => <div className="table-wrap">
  <table className="utable rtable">{children}</table></div>;

// ------------------------------------------------------ the five report bodies

function StaffActivity({ data }) {
  if (!data.total) {
    return <Empty icon="📋" title="ไม่มีรายการในช่วงนี้">
      ลองขยายช่วงวัน หรือเลือก "ทุกบัญชี" และ "ทุกประเภท" แล้วดูอีกครั้ง</Empty>;
  }
  return <>
    {data.truncated && <Truncated shown={data.items.length} total={data.total}/>}
    <TableWrap>
      <thead><tr><th>เวลา</th><th>บัญชี</th><th>รายการ</th><th>เกี่ยวกับ</th>
        <th>ผลลัพธ์</th><th>เหตุผล</th><th>จุดสแกน</th></tr></thead>
      <tbody>
        {data.items.map((row, index) => <tr key={`${row.iso}-${index}`}>
          <td data-label="เวลา" className="num">{row.when}</td>
          <td data-label="บัญชี">{row.actor}</td>
          <td data-label="รายการ"><b>{row.label}</b><span className="note">{row.kind}</span></td>
          <td data-label="เกี่ยวกับ">{row.about}</td>
          <td data-label="ผลลัพธ์">{row.result}</td>
          <td data-label="เหตุผล">{row.reason}</td>
          <td data-label="จุดสแกน">{row.device}</td>
        </tr>)}
        <tr className="sumrow"><td data-label="รวม"><b>รวม</b></td>
          <td colSpan={6}><b>{nf.format(data.total)} รายการ</b></td></tr>
      </tbody>
    </TableWrap>

    <h3>ยอดรวมต่อคนต่อวัน</h3>
    <TableWrap>
      <thead><tr><th>วันที่</th><th>บัญชี</th><th>ทั้งหมด</th><th>สมัครสมาชิก</th>
        <th>ขาย/แถม</th><th>เช็คอินผ่าน</th><th>เช็คอินอื่น ๆ</th></tr></thead>
      <tbody>
        {data.summary.map(row => <tr key={`${row.day}-${row.actor}`}>
          <td data-label="วันที่" className="num">{thaiDate(row.day)}</td>
          <td data-label="บัญชี">{row.actor}</td>
          <td data-label="ทั้งหมด" className="num">{nf.format(row.total)}</td>
          <td data-label="สมัครสมาชิก" className="num">{nf.format(row.signups)}</td>
          <td data-label="ขาย/แถม" className="num">{nf.format(row.sales)}</td>
          <td data-label="เช็คอินผ่าน" className="num">{nf.format(row.checkin_ok)}</td>
          <td data-label="เช็คอินอื่น ๆ" className="num">{nf.format(row.checkin_other)}</td>
        </tr>)}
        <tr className="sumrow"><td data-label="รวม"><b>รวม</b></td><td/>
          <td data-label="ทั้งหมด" className="num"><b>{nf.format(data.total)}</b></td>
          <td colSpan={4}/></tr>
      </tbody>
    </TableWrap>
  </>;
}

function Sales({ data }) {
  // Money, not row count: a day with one order and a day with none are
  // different, and both have items in them once the packages are split out.
  const earned = data.total_satang > 0 || data.total_orders > 0;
  const perPeriod = new Map();
  for (const row of data.items) {
    const found = perPeriod.get(row.period) ?? { key: row.period, label: row.period_label, value: 0 };
    found.value += row.satang;
    perPeriod.set(row.period, found);
  }
  const bars = [...perPeriod.values()].reverse()
    .map(row => ({ ...row, text: money((row.value / 100).toFixed(2)) }));

  return <>
    {!earned
      ? <Empty icon="💵" title="ยังไม่มียอดขายในช่วงนี้">
          ยอดนับจากวันที่รับเงินจริง · ถ้าเพิ่งขายไปเมื่อสักครู่ ลองกด "วันนี้" แล้วดูอีกครั้ง</Empty>
      : <>
        <TableWrap>
          <thead><tr><th>{data.bucket === 'month' ? 'เดือน' : 'วันที่'}</th><th>แพ็กเกจ</th>
            <th>วิธีชำระ</th><th>จำนวนรายการ</th><th>บาท</th></tr></thead>
          <tbody>
            {data.items.map((row, index) => <tr key={`${row.period}-${row.package}-${row.payment_method}-${index}`}>
              <td data-label="ช่วง" className="num">{row.period_label}</td>
              <td data-label="แพ็กเกจ">{row.package}</td>
              <td data-label="วิธีชำระ">{row.payment_method}</td>
              <td data-label="จำนวนรายการ" className="num">{nf.format(row.orders)}</td>
              <td data-label="บาท" className="num">{money(row.baht)}</td>
            </tr>)}
            <tr className="sumrow"><td data-label="รวม"><b>รวม</b></td><td/><td/>
              <td data-label="จำนวนรายการ" className="num"><b>{nf.format(data.total_orders)}</b></td>
              <td data-label="บาท" className="num"><b>{money(data.total_baht)}</b></td></tr>
          </tbody>
        </TableWrap>
        <Bars rows={bars} unit=" บาท"
          caption={data.bucket === 'month' ? 'ยอดขายรายเดือน' : 'ยอดขายรายวัน'}/>
      </>}
    <p className="note">{data.note}</p>

    {!!data.granted.length && <><h3>แถมให้ (ไม่ได้รับเงิน)</h3>
      <TableWrap>
        <thead><tr><th>วันที่</th><th>แพ็กเกจ</th><th>จำนวนรายการ</th><th>มูลค่า (บาท)</th><th>เหตุผล</th></tr></thead>
        <tbody>{data.granted.map((row, index) => <tr key={`${row.period}-${index}`}>
          <td data-label="วันที่" className="num">{row.period_label}</td>
          <td data-label="แพ็กเกจ">{row.package}</td>
          <td data-label="จำนวนรายการ" className="num">{nf.format(row.orders)}</td>
          <td data-label="มูลค่า" className="num">{money(row.baht)}</td>
          <td data-label="เหตุผล">{row.note ?? ''}</td></tr>)}</tbody>
      </TableWrap></>}

    {!!data.reversed.length && <><h3>กลับรายการในช่วงนี้</h3>
      <TableWrap>
        <thead><tr><th>วันที่กลับรายการ</th><th>แพ็กเกจ</th><th>บาท</th><th>เหตุผล</th></tr></thead>
        <tbody>{data.reversed.map((row, index) => <tr key={`${row.period}-${index}`}>
          <td data-label="วันที่" className="num">{row.period_label}</td>
          <td data-label="แพ็กเกจ">{row.package}</td>
          <td data-label="บาท" className="num">{money(row.baht)}</td>
          <td data-label="เหตุผล">{row.reason ?? ''}</td></tr>)}</tbody>
      </TableWrap></>}
  </>;
}

function CheckIns({ data }) {
  const sum = field => data.items.reduce((total, row) => total + row[field], 0);
  const allowed = sum('allowed'), duplicate = sum('duplicate'), denied = sum('denied');
  // THE rule: a week of quiet days is seven rows of zeros, so `items.length` is
  // never 0 for a valid range and would call an empty week "has data".
  const scanned = allowed + duplicate + denied;
  if (!scanned) {
    return <Empty icon="🚪" title="ไม่มีการสแกนในช่วงนี้">
      ไม่มีใครสแกนบัตรเลยในช่วงวันที่เลือก · ลองขยายช่วงวัน หรือกด "7 วัน"</Empty>;
  }
  return <>
    <TableWrap>
      <thead><tr><th>วันที่</th><th>เข้าใช้ได้</th><th>สแกนซ้ำ</th><th>ไม่ผ่าน</th><th>จำนวนคน (ไม่นับซ้ำ)</th></tr></thead>
      <tbody>
        {data.items.map(row => <tr key={row.day}>
          <td data-label="วันที่" className="num">{row.day_label}</td>
          <td data-label="เข้าใช้ได้" className="num">{nf.format(row.allowed)}</td>
          <td data-label="สแกนซ้ำ" className="num">{nf.format(row.duplicate)}</td>
          <td data-label="ไม่ผ่าน" className="num">{nf.format(row.denied)}</td>
          <td data-label="จำนวนคน" className="num">{nf.format(row.unique_members)}</td>
        </tr>)}
        <tr className="sumrow"><td data-label="รวม"><b>รวม</b></td>
          <td data-label="เข้าใช้ได้" className="num"><b>{nf.format(allowed)}</b></td>
          <td data-label="สแกนซ้ำ" className="num"><b>{nf.format(duplicate)}</b></td>
          <td data-label="ไม่ผ่าน" className="num"><b>{nf.format(denied)}</b></td>
          <td/></tr>
      </tbody>
    </TableWrap>

    <Bars caption="ช่วงเวลาที่คนเยอะ (เฉพาะที่เข้าใช้ได้)" unit=" ครั้ง"
      rows={data.busiest.map(row => ({ key: row.hour,
        label: `${String(row.hour).padStart(2, '0')}:00`, value: row.total }))}/>

    {!!data.reasons.length && <><h3>เหตุผลที่ไม่ผ่าน</h3>
      <TableWrap>
        <thead><tr><th>เหตุผล</th><th>จำนวนครั้ง</th></tr></thead>
        <tbody>{data.reasons.map(row => <tr key={row.group}>
          <td data-label="เหตุผล">{row.group}</td>
          <td data-label="จำนวนครั้ง" className="num">{nf.format(row.total)}</td></tr>)}
          <tr className="sumrow"><td data-label="รวม"><b>รวม</b></td>
            <td data-label="จำนวนครั้ง" className="num">
              <b>{nf.format(data.reasons.reduce((total, row) => total + row.total, 0))}</b></td></tr>
        </tbody>
      </TableWrap></>}
  </>;
}

function Members({ data }) {
  const empty = { expiring: 'ไม่มีสมาชิกที่กำลังจะหมดอายุ', active: 'ยังไม่มีสมาชิกที่ใช้งานอยู่',
    expired: 'ไม่มีสมาชิกที่หมดอายุค้างอยู่', new: 'ไม่มีใครสมัครใหม่ในช่วงนี้' }[data.view];
  return <>
    {!data.total
      ? <Empty icon="🧍" title={empty}>เลือกมุมมองอื่น หรือขยายช่วงวันแล้วดูอีกครั้ง</Empty>
      : <>
        {data.truncated && <Truncated shown={data.items.length} total={data.total}/>}
        <TableWrap>
          <thead><tr><th>รหัสสมาชิก</th><th>ชื่อ</th><th>เบอร์โทร</th><th>แพ็กเกจ</th>
            <th>หมดอายุ</th><th>เหลือกี่วัน</th><th>ครั้งคงเหลือ</th><th>วันที่สมัคร</th></tr></thead>
          <tbody>
            {data.items.map(row => <tr key={row.member_code}>
              <td data-label="รหัสสมาชิก" className="num">{row.member_code}</td>
              <td data-label="ชื่อ"><b>{row.name}</b></td>
              <td data-label="เบอร์โทร" className="num">{row.phone}</td>
              <td data-label="แพ็กเกจ">{row.package}</td>
              <td data-label="หมดอายุ" className="num">{row.expires_on}</td>
              <td data-label="เหลือกี่วัน" className="num">{row.days_left}</td>
              <td data-label="ครั้งคงเหลือ" className="num">{row.sessions_left}</td>
              <td data-label="วันที่สมัคร" className="num">{row.joined_on}</td>
            </tr>)}
            <tr className="sumrow"><td data-label="รวม"><b>รวม</b></td>
              <td colSpan={7}><b>{nf.format(data.total)} คน</b></td></tr>
          </tbody>
        </TableWrap>
      </>}

    {!!data.revoked.length && <><h3>สิทธิ์ที่ถูกยกเลิก (ไม่ใช่หมดอายุ)</h3>
      <p className="note">แพ็กเกจที่ยิมเรียกคืน คนละเรื่องกับแพ็กเกจที่หมดอายุตามเวลา</p>
      <TableWrap>
        <thead><tr><th>รหัสสมาชิก</th><th>ชื่อ</th><th>แพ็กเกจ</th><th>ยกเลิกเมื่อ</th><th>เหตุผล</th></tr></thead>
        <tbody>{data.revoked.map((row, index) => <tr key={`${row.member_code}-${index}`}>
          <td data-label="รหัสสมาชิก" className="num">{row.member_code}</td>
          <td data-label="ชื่อ">{row.name}</td>
          <td data-label="แพ็กเกจ">{row.package}</td>
          <td data-label="ยกเลิกเมื่อ" className="num">{row.revoked_on}</td>
          <td data-label="เหตุผล">{row.reason}</td></tr>)}</tbody>
      </TableWrap></>}
  </>;
}

function Issues({ data }) {
  if (!data.total) {
    return <Empty icon="✉️" title={data.status === 'open' ? 'ไม่มีเรื่องที่ยังค้าง' : 'ไม่มีเรื่องแจ้งเข้ามาในช่วงนี้'}>
      {data.status === 'open'
        ? 'เรื่องที่ปิดไปแล้วดูได้โดยเลือก "ทุกสถานะ"'
        : 'ขยายช่วงวันแล้วดูอีกครั้ง'}</Empty>;
  }
  return <>
    {data.truncated && <Truncated shown={data.items.length} total={data.total}/>}
    <TableWrap>
      <thead><tr><th>เลขเรื่อง</th><th>วันที่แจ้ง</th><th>ค้างมากี่วัน</th><th>สถานะ</th>
        <th>ผู้แจ้ง</th><th>หน้าที่เกิด</th><th>ข้อความ</th></tr></thead>
      <tbody>
        {data.items.map(row => <tr key={row.reference}>
          <td data-label="เลขเรื่อง" className="num">{row.reference}</td>
          <td data-label="วันที่แจ้ง" className="num">{row.when}</td>
          <td data-label="ค้างมากี่วัน" className="num">{nf.format(row.waiting_days)}</td>
          <td data-label="สถานะ">{row.status}</td>
          <td data-label="ผู้แจ้ง">{row.reporter}</td>
          <td data-label="หน้าที่เกิด">{row.screen}</td>
          <td data-label="ข้อความ">{row.message}</td>
        </tr>)}
        <tr className="sumrow"><td data-label="รวม"><b>รวม</b></td>
          <td colSpan={6}><b>{nf.format(data.total)} เรื่อง</b></td></tr>
      </tbody>
    </TableWrap>
  </>;
}

// ------------------------------------------------------------- the screen itself

/**
 * One report at a time, and never the last one's numbers under this one's name.
 *
 * `useResource` keeps what it has while it fetches the next thing, which is
 * right for a list that is being searched and wrong here: the five reports are
 * five different shapes, and the frame between "the owner pressed ยอดขาย" and
 * "the sales figures arrived" drew the sales table out of the staff report's
 * rows -- a blank screen, because `granted.length` of `undefined` throws.
 *
 * So the answer is filed under the address it came from, and anything whose
 * address is not the one on screen counts as still loading. The number on each
 * request is the same guard the report button uses: an answer to a question
 * nobody is asking any more is dropped rather than rendered.
 */
function useReport(path) {
  const [state, setState] = useState({ path: null, data: null, error: null });
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = seq.current + 1;
    seq.current = mine;
    try {
      const data = await api(path);
      if (seq.current === mine) setState({ path, data, error: null });
    } catch (error) {
      if (seq.current === mine) setState({ path, data: null, error });
    }
  }, [path]);
  useEffect(() => { load(); }, [load]);
  const current = state.path === path;
  return { data: current ? state.data : null, error: current ? state.error : null,
    busy: !current, reload: load };
}

/** The four numbers across the top, which is what the screen is opened for. */
function Today() {
  const { data, error, busy } = useResource('/admin/reports/today');
  if (busy) return <div className="todaybar" aria-busy="true">
    {[0, 1, 2, 3].map(i => <div className="tcard" key={i}><span className="skel skel-line" style={{ width: '70%' }}/>
      <span className="skel skel-line" style={{ width: '45%', height: 28 }}/></div>)}</div>;
  if (error || !data) return null;      // the reports below still work without it
  const cards = [
    { label: 'ยอดขายวันนี้', value: money(data.sales_baht), unit: 'บาท',
      note: `${nf.format(data.sales_orders)} รายการ` },
    { label: 'เช็คอินวันนี้', value: nf.format(data.checkins), unit: 'ครั้ง',
      note: `${nf.format(data.people)} คน` },
    { label: 'สมาชิกใหม่วันนี้', value: nf.format(data.new_members), unit: 'คน', note: '' },
    { label: 'จะหมดอายุใน 7 วัน', value: nf.format(data.expiring_7), unit: 'คน',
      note: data.expiring_7 ? 'ดูรายชื่อในแท็บ "สมาชิก"' : '' },
  ];
  return <div className="todaybar">
    {cards.map(card => <div className="tcard" key={card.label}>
      <span className="tlabel">{card.label}</span>
      <b className="tvalue">{card.value}<span> {card.unit}</span></b>
      <span className="note">{card.note}</span>
    </div>)}
  </div>;
}

export function AdminReports() {
  const [key, setKey] = useState('staff');
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  const [actor, setActor] = useState('all'), [kind, setKind] = useState('all');
  const [bucket, setBucket] = useState('day');
  const [view, setView] = useState('expiring');
  const [status, setStatus] = useState('open');
  const report = REPORTS.find(item => item.key === key);

  const query = new URLSearchParams();
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  if (key === 'staff') {
    if (actor !== 'all') query.set('actor', actor);
    if (kind !== 'all') query.set('kind', kind);
  }
  if (key === 'sales') query.set('bucket', bucket);
  if (key === 'members') query.set('view', view);
  if (key === 'issues') query.set('status', status);
  const path = `/admin/reports/${report.path}?${query}`;
  const { data, error, busy, reload } = useReport(path);
  // The two lists that fill the staff report's own dropdowns travel with its
  // payload. Kept here so they do not empty out while the next answer is on
  // its way -- a select whose options vanish is a select that loses its value.
  const [facets, setFacets] = useState({ actors: [], kinds: [] });
  useEffect(() => {
    if (data?.actors && data?.kinds) setFacets({ actors: data.actors, kinds: data.kinds });
  }, [data]);

  /** The shortcuts, in Bangkok days, because every date in the reports is. */
  const today = thaiToday();
  const shortcuts = [
    ['วันนี้', today, today],
    ['7 วัน', daysBefore(today, 6), today],
    ['เดือนนี้', `${today.slice(0, 7)}-01`, today],
  ];
  const chosen = shortcuts.find(([, start, end]) => start === from && end === to)?.[0];

  // The download is a plain link, not a fetch: the browser saves the file the
  // way it saves any other, with the name the server chose, and nothing the
  // report contains ever passes through this page's memory.
  const csvHref = `/api${path}&format=csv`;
  // A 400 here is the server explaining what is wrong with the filter, in a
  // sentence written for the person reading it. It must not be swallowed by
  // the generic "ระบบขัดข้อง" box.
  const badFilter = error?.status === 400 ? error : null;

  return <div className="reportpage">
    <Today/>

    <div className="repfilters noprint">
      <div className="reptabs" role="tablist" aria-label="เลือกรายงาน">
        {REPORTS.map(item => <button key={item.key} type="button" role="tab"
          aria-selected={item.key === key} onClick={() => setKey(item.key)}>{item.tab}</button>)}
      </div>

      <div className="repfilter-row">
        <div className="field">
          <label htmlFor="rep-from">ตั้งแต่วันที่</label>
          <input id="rep-from" type="date" value={from} max={to || undefined}
            onChange={event => setFrom(event.target.value)}/>
        </div>
        <div className="field">
          <label htmlFor="rep-to">ถึงวันที่</label>
          <input id="rep-to" type="date" value={to} min={from || undefined}
            onChange={event => setTo(event.target.value)}/>
        </div>
        <div className="field quickdays">
          <span className="flabel">ช่วงที่ใช้บ่อย</span>
          <div className="btn-row">
            {shortcuts.map(([label, start, end]) => <button key={label} type="button"
              className={`btn auto${chosen === label ? ' primary' : ' ghost'}`}
              aria-pressed={chosen === label}
              onClick={() => { setFrom(start); setTo(end); }}>{label}</button>)}
            <button type="button" className="btn ghost auto" disabled={!from && !to}
              onClick={() => { setFrom(''); setTo(''); }}>ค่าเริ่มต้น</button>
          </div>
        </div>
      </div>

      <div className="repfilter-row">
        {key === 'staff' && <>
          <div className="field">
            <label htmlFor="rep-actor">บัญชี</label>
            <select id="rep-actor" value={actor} onChange={event => setActor(event.target.value)}>
              <option value="all">ทุกบัญชี</option>
              {facets.actors.map(row => <option key={row.id} value={row.id}>{row.email}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="rep-kind">ประเภท</label>
            <select id="rep-kind" value={kind} onChange={event => setKind(event.target.value)}>
              <option value="all">ทุกประเภท</option>
              {facets.kinds.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
        </>}
        {key === 'sales' && <div className="field">
          <label htmlFor="rep-bucket">จัดกลุ่มตาม</label>
          <select id="rep-bucket" value={bucket} onChange={event => setBucket(event.target.value)}>
            <option value="day">รายวัน</option><option value="month">รายเดือน</option>
          </select>
        </div>}
        {key === 'members' && <div className="field">
          <label htmlFor="rep-view">มุมมอง</label>
          <select id="rep-view" value={view} onChange={event => setView(event.target.value)}>
            {VIEWS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>}
        {key === 'issues' && <div className="field">
          <label htmlFor="rep-status">สถานะ</label>
          <select id="rep-status" value={status} onChange={event => setStatus(event.target.value)}>
            <option value="open">เฉพาะที่ยังค้าง</option><option value="all">ทุกสถานะ</option>
          </select>
        </div>}
        <div className="field repactions">
          <span className="flabel">ไฟล์และกระดาษ</span>
          <div className="btn-row">
            {/* `download` and not `target="_blank"`: a tab that opens and shuts
                again looks like nothing happened on a counter tablet. */}
            <a className={`btn auto${busy || error ? ' disabled' : ''}`} href={csvHref} download
              aria-disabled={busy || !!error}
              onClick={event => { if (busy || error) event.preventDefault(); }}>ดาวน์โหลด CSV</a>
            <button type="button" className="btn ghost auto" disabled={busy || !!error}
              onClick={() => window.print()}>พิมพ์</button>
          </div>
        </div>
      </div>
    </div>

    <h2>{report.title}</h2>
    <p className="sub">{report.sub}</p>
    {data?.range && <p className="note rrange">ช่วงที่แสดง <b>{thaiDate(data.range.from)} – {thaiDate(data.range.to)}</b>
      {!from && !to && ' (ค่าเริ่มต้นของรายงานนี้)'}</p>}

    <Notice error={badFilter}/>
    {!badFilter && <StateBox error={error} onRetry={() => reload().catch(() => {})}/>}
    {busy && <Loading label="กำลังรวบรวมข้อมูล…" avatar={false} rows={3}/>}
    {!busy && !error && data && <div className="repbody">
      {key === 'staff' && <StaffActivity data={data}/>}
      {key === 'sales' && <Sales data={data}/>}
      {key === 'checkins' && <CheckIns data={data}/>}
      {key === 'members' && <Members data={data}/>}
      {key === 'issues' && <Issues data={data}/>}
    </div>}
  </div>;
}
