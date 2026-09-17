// ยอดขายรายวัน สำหรับกระทบกับเงินเข้าบัญชีจริง.
//
// คิวตรวจสลิปที่เคยอยู่ไฟล์นี้ถูกถอดออกแล้ว: มันมีไว้ตรวจสลิปที่สมาชิกอัปโหลดเอง
// ซึ่งไม่มีทางเข้าอีกแล้ว ส่วนสลิปที่พนักงานแนบตอนรับเงินย้ายไปอยู่ในประวัติ
// การรับเงินของสมาชิกรายนั้นแทน (Mika)
import React from 'react';
import { formatPrice, Loading, Notice, useResource } from './shared.jsx';

export function SalesReport() {
  const { data, error, busy } = useResource('/admin/sales');
  if (busy) return <Loading label="กำลังโหลดยอดขาย…" rows={3}/>;
  if (error) return <Notice error={error}/>;
  if (!data.items.length) return <p className="muted">ยังไม่มียอดขายที่อนุมัติแล้ว</p>;
  return <table className="sales"><thead><tr><th>วันที่</th><th>จำนวนคำสั่งซื้อ</th><th>ยอดรวม</th></tr></thead>
    <tbody>{data.items.map(row => <tr key={row.day}>
      <td>{row.day}</td><td>{row.orders.toLocaleString('th-TH')}</td><td>{formatPrice(row.total_thb)}</td>
    </tr>)}</tbody></table>;
}
