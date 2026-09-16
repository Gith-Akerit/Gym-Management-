/* ==========================================================================
   mkmail.js — สร้างเทมเพลตอีเมล 5 ฉบับ (HTML + ข้อความล้วน)
   รันด้วย: node build/mkmail.js   ->  เขียนลงโฟลเดอร์ emails/
   ตัวแปรใช้รูปแบบ {{name}} นักพัฒนาแทนค่าด้วยอะไรก็ได้ที่ใช้อยู่
   ========================================================================== */
const fs = require('fs');
const path = require('path');

/* ฟอนต์: Tahoma มาก่อนเพราะเป็นฟอนต์ไทยที่มีแน่นอนที่สุดบน Windows/Outlook
   ห้ามใช้ webfont ในอีเมล — ลูกค้าหลายเจ้าไม่โหลดให้ */
const FONT = "Tahoma,'Leelawadee UI','Sukhumvit Set',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";

const INK = '#0E1418', INK2 = '#3D4852', LINE = '#E4E9ED', CANVAS = '#EFF2F4';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ปุ่มแบบตาราง — Outlook ไม่รองรับ padding บน <a> ต้องใช้ td เป็นตัวรองรับ */
function button(label, url) {
  return `      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
        <tr>
          <td align="center" bgcolor="{{brand_surface}}" style="border-radius:10px;">
            <a href="${url}" style="display:inline-block;padding:16px 30px;font:bold 17px/1.2 ${FONT};color:{{on_brand}};text-decoration:none;border-radius:10px;">${label}</a>
          </td>
        </tr>
      </table>`;
}

function fallbackLink(url) {
  return `      <p style="margin:0 0 20px;font:normal 14px/1.7 ${FONT};color:${INK2};">
        ถ้าปุ่มกดไม่ได้ ให้คัดลอกลิงก์นี้ไปวางในเบราว์เซอร์<br>
        <span style="word-break:break-all;color:${INK2};">${url}</span>
      </p>`;
}

function note(text) {
  return `      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
        <tr><td style="background:${CANVAS};border:2px solid ${LINE};border-radius:8px;padding:14px 16px;font:normal 15px/1.7 ${FONT};color:${INK2};">
          ${text}
        </td></tr>
      </table>`;
}

function html(o) {
  const body = o.blocks.join('\n');
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(o.title)}</title>
</head>
<body style="margin:0;padding:0;background:${CANVAS};-webkit-text-size-adjust:100%;">

<!-- บรรทัดพรีวิวในกล่องจดหมาย ซ่อนจากเนื้อความ -->
<div style="display:none;font-size:1px;color:${CANVAS};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${esc(o.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CANVAS};">
<tr><td align="center" style="padding:24px 12px;">

  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#FFFFFF;border:2px solid ${INK};border-radius:12px;">

    <!-- แถบชื่อยิม: ใช้สีพื้น ไม่ใช้รูป เพื่อให้ไม่พังเมื่อลูกค้าปิดการโหลดรูป -->
    <tr><td bgcolor="{{brand_surface}}" style="padding:20px 28px;border-radius:10px 10px 0 0;">
      <span style="font:bold 20px/1.3 ${FONT};color:{{on_brand}};">{{gym_name}}</span>
    </td></tr>

    <tr><td style="padding:28px 28px 8px;">
      <h1 style="margin:0 0 14px;font:bold 22px/1.45 ${FONT};color:${INK};">${o.h1}</h1>
${body}
    </td></tr>

    <tr><td style="padding:0 28px 28px;">
      <div style="border-top:2px solid ${LINE};padding-top:16px;font:normal 14px/1.7 ${FONT};color:${INK2};">
        <strong style="color:${INK};">{{gym_name}}</strong>${o.showPhone === false ? '' : ' &middot; โทร {{gym_phone}}'}<br>
        อีเมลนี้ส่งอัตโนมัติ กรุณาอย่าตอบกลับ
      </div>
    </td></tr>

  </table>

</td></tr>
</table>
</body>
</html>
`;
}

function p(text) {
  return `      <p style="margin:0 0 16px;font:normal 16px/1.75 ${FONT};color:${INK2};">${text}</p>`;
}
function strongP(text) {
  return `      <p style="margin:0 0 16px;font:normal 16px/1.75 ${FONT};color:${INK};">${text}</p>`;
}

/* -------------------------------------------------------------- 5 ฉบับ --- */
const MAILS = {

  '1-verify-email': {
    subject: 'ยืนยันอีเมลของคุณ — {{gym_name}}',
    preheader: 'กดลิงก์เพื่อยืนยันอีเมล จากนั้นรอเจ้าของยิมอนุมัติ',
    title: 'ยืนยันอีเมล',
    h1: 'ยืนยันอีเมลของคุณ',
    blocks: [
      p('สวัสดีคุณ <strong style="color:' + INK + ';">{{name}}</strong>'),
      p('มีการขอบัญชีใช้งานระบบของ {{gym_name}} ด้วยอีเมลนี้ กดปุ่มด้านล่างเพื่อยืนยันว่าเป็นอีเมลของคุณจริง'),
      button('ยืนยันอีเมล', '{{verify_url}}'),
      fallbackLink('{{verify_url}}'),
      note('ลิงก์นี้ใช้ได้ <strong style="color:' + INK + ';">24 ชั่วโมง</strong><br>' +
        'ยืนยันแล้ว <strong style="color:' + INK + ';">ยังเข้าใช้งานไม่ได้ทันที</strong> ต้องรอเจ้าของยิมกดอนุมัติและกำหนดสิทธิ์ให้ก่อน จะมีอีเมลแจ้งอีกฉบับเมื่ออนุมัติแล้ว'),
      p('ถ้าคุณไม่ได้เป็นคนขอบัญชีนี้ ไม่ต้องทำอะไร ลิงก์จะหมดอายุไปเอง')
    ],
    text: [
      'ยืนยันอีเมลของคุณ',
      '',
      'สวัสดีคุณ {{name}}',
      '',
      'มีการขอบัญชีใช้งานระบบของ {{gym_name}} ด้วยอีเมลนี้',
      'เปิดลิงก์ด้านล่างเพื่อยืนยันว่าเป็นอีเมลของคุณจริง',
      '',
      '{{verify_url}}',
      '',
      'ลิงก์นี้ใช้ได้ 24 ชั่วโมง',
      '',
      'ยืนยันแล้วยังเข้าใช้งานไม่ได้ทันที ต้องรอเจ้าของยิมกดอนุมัติและ',
      'กำหนดสิทธิ์ให้ก่อน จะมีอีเมลแจ้งอีกฉบับเมื่ออนุมัติแล้ว',
      '',
      'ถ้าคุณไม่ได้เป็นคนขอบัญชีนี้ ไม่ต้องทำอะไร ลิงก์จะหมดอายุไปเอง',
      '',
      '--',
      '{{gym_name}} · โทร {{gym_phone}}',
      'อีเมลนี้ส่งอัตโนมัติ กรุณาอย่าตอบกลับ'
    ]
  },

  '2-approved': {
    subject: 'บัญชีของคุณใช้งานได้แล้ว — {{gym_name}}',
    preheader: 'เจ้าของยิมอนุมัติแล้ว เข้าใช้งานได้เลย',
    title: 'บัญชีใช้งานได้แล้ว',
    h1: 'บัญชีของคุณใช้งานได้แล้ว',
    blocks: [
      p('สวัสดีคุณ <strong style="color:' + INK + ';">{{name}}</strong>'),
      p('เจ้าของยิมอนุมัติคำขอของคุณแล้ว เข้าใช้งานระบบของ {{gym_name}} ได้ทันที'),
      note('สิทธิ์ของคุณคือ <strong style="color:' + INK + ';">{{role_label}}</strong><br>{{role_detail}}'),
      button('เข้าสู่ระบบ', '{{login_url}}'),
      fallbackLink('{{login_url}}'),
      strongP('เข้าด้วย{{signin_method}}'),
      p('ถ้าเข้าไม่ได้หรือลืมรหัสผ่าน กด “ลืมรหัสผ่าน” ที่หน้าเข้าสู่ระบบได้เลย')
    ],
    text: [
      'บัญชีของคุณใช้งานได้แล้ว',
      '',
      'สวัสดีคุณ {{name}}',
      '',
      'เจ้าของยิมอนุมัติคำขอของคุณแล้ว เข้าใช้งานระบบของ {{gym_name}}',
      'ได้ทันที',
      '',
      'สิทธิ์ของคุณคือ {{role_label}}',
      '{{role_detail}}',
      '',
      'เข้าสู่ระบบที่',
      '{{login_url}}',
      '',
      'เข้าด้วย{{signin_method}}',
      '',
      'ถ้าเข้าไม่ได้หรือลืมรหัสผ่าน กด "ลืมรหัสผ่าน" ที่หน้าเข้าสู่ระบบได้เลย',
      '',
      '--',
      '{{gym_name}} · โทร {{gym_phone}}',
      'อีเมลนี้ส่งอัตโนมัติ กรุณาอย่าตอบกลับ'
    ]
  },

  '3-rejected': {
    subject: 'คำขอใช้งานระบบไม่ได้รับอนุมัติ — {{gym_name}}',
    preheader: 'ติดต่อยิมได้โดยตรงถ้าคิดว่าเป็นความเข้าใจผิด',
    title: 'คำขอไม่ได้รับอนุมัติ',
    h1: 'คำขอใช้งานระบบไม่ได้รับอนุมัติ',
    blocks: [
      p('สวัสดีคุณ <strong style="color:' + INK + ';">{{name}}</strong>'),
      p('เจ้าของยิมไม่ได้อนุมัติคำขอใช้งานระบบของ {{gym_name}} สำหรับอีเมลนี้'),
      note('ถ้าคิดว่าเป็นความเข้าใจผิด ติดต่อยิมได้โดยตรงที่ ' +
        '<strong style="color:' + INK + ';">{{gym_phone}}</strong><br>' +
        'บัญชีนี้ไม่ได้ถูกสร้างขึ้น และข้อมูลที่กรอกไว้จะถูกลบตามรอบ'),
      p('ถ้าคุณไม่ได้เป็นคนขอบัญชีนี้ ไม่ต้องทำอะไร')
    ],
    text: [
      'คำขอใช้งานระบบไม่ได้รับอนุมัติ',
      '',
      'สวัสดีคุณ {{name}}',
      '',
      'เจ้าของยิมไม่ได้อนุมัติคำขอใช้งานระบบของ {{gym_name}}',
      'สำหรับอีเมลนี้',
      '',
      'ถ้าคิดว่าเป็นความเข้าใจผิด ติดต่อยิมได้โดยตรงที่ {{gym_phone}}',
      '',
      'บัญชีนี้ไม่ได้ถูกสร้างขึ้น และข้อมูลที่กรอกไว้จะถูกลบตามรอบ',
      '',
      'ถ้าคุณไม่ได้เป็นคนขอบัญชีนี้ ไม่ต้องทำอะไร',
      '',
      '--',
      '{{gym_name}} · โทร {{gym_phone}}',
      'อีเมลนี้ส่งอัตโนมัติ กรุณาอย่าตอบกลับ'
    ]
  },

  '4-reset-password': {
    subject: 'ตั้งรหัสผ่านใหม่ — {{gym_name}}',
    preheader: 'ลิงก์ใช้ได้ 30 นาที และใช้ได้ครั้งเดียว',
    title: 'ตั้งรหัสผ่านใหม่',
    h1: 'ตั้งรหัสผ่านใหม่',
    blocks: [
      p('สวัสดีคุณ <strong style="color:' + INK + ';">{{name}}</strong>'),
      p('มีการขอตั้งรหัสผ่านใหม่สำหรับบัญชี <strong style="color:' + INK + ';">{{email}}</strong> ในระบบของ {{gym_name}}'),
      button('ตั้งรหัสผ่านใหม่', '{{reset_url}}'),
      fallbackLink('{{reset_url}}'),
      note('ลิงก์นี้ใช้ได้ <strong style="color:' + INK + ';">30 นาที</strong> และ' +
        '<strong style="color:' + INK + ';">ใช้ได้ครั้งเดียว</strong><br>' +
        'หมดอายุแล้วขอใหม่ได้ ไม่จำกัดจำนวนครั้ง'),
      strongP('ถ้าคุณไม่ได้เป็นคนขอ ไม่ต้องทำอะไร รหัสผ่านเดิมยังใช้ได้ตามปกติ'),
      p('อย่าส่งต่ออีเมลฉบับนี้ให้ใคร คนที่มีลิงก์นี้ตั้งรหัสผ่านบัญชีคุณได้')
    ],
    text: [
      'ตั้งรหัสผ่านใหม่',
      '',
      'สวัสดีคุณ {{name}}',
      '',
      'มีการขอตั้งรหัสผ่านใหม่สำหรับบัญชี {{email}}',
      'ในระบบของ {{gym_name}}',
      '',
      'เปิดลิงก์ด้านล่างเพื่อตั้งรหัสผ่านใหม่',
      '',
      '{{reset_url}}',
      '',
      'ลิงก์นี้ใช้ได้ 30 นาที และใช้ได้ครั้งเดียว',
      'หมดอายุแล้วขอใหม่ได้ ไม่จำกัดจำนวนครั้ง',
      '',
      'ถ้าคุณไม่ได้เป็นคนขอ ไม่ต้องทำอะไร รหัสผ่านเดิมยังใช้ได้ตามปกติ',
      '',
      'อย่าส่งต่ออีเมลฉบับนี้ให้ใคร คนที่มีลิงก์นี้ตั้งรหัสผ่านบัญชีคุณได้',
      '',
      '--',
      '{{gym_name}} · โทร {{gym_phone}}',
      'อีเมลนี้ส่งอัตโนมัติ กรุณาอย่าตอบกลับ'
    ]
  },

  '5-member-welcome': {
    subject: 'บัตรสมาชิกของคุณ — {{gym_name}}',
    preheader: 'บัตรสมาชิกแนบมากับอีเมลนี้ เปิดตอนมาที่ยิมได้เลย',
    title: 'บัตรสมาชิก',
    h1: 'ยินดีต้อนรับสู่ {{gym_name}}',
    blocks: [
      p('สวัสดีคุณ <strong style="color:' + INK + ';">{{name}}</strong>'),
      p('คุณเป็นสมาชิกของ {{gym_name}} เรียบร้อยแล้ว บัตรสมาชิกของคุณแนบมากับอีเมลฉบับนี้'),
      note('รหัสสมาชิก <strong style="color:' + INK + ';">{{member_code}}</strong><br>' +
        '{{membership_line}}'),
      strongP('ตอนมาที่ยิม เปิดรูปบัตรให้พนักงานสแกน ไม่ต้องพกบัตรแข็งและไม่ต้องจำรหัส'),
      p('เก็บรูปบัตรไว้ในเครื่อง หรือบันทึกลงอัลบั้มรูปไว้ก็ได้ ถ้าหาไม่เจอ ขอใหม่ได้ที่เคาน์เตอร์'),
      p('อย่าส่งต่อรูปบัตรให้คนอื่น รูปบัตรคือสิ่งที่ใช้เข้ายิมแทนตัวคุณ')
    ],
    text: [
      'ยินดีต้อนรับสู่ {{gym_name}}',
      '',
      'สวัสดีคุณ {{name}}',
      '',
      'คุณเป็นสมาชิกของ {{gym_name}} เรียบร้อยแล้ว',
      'บัตรสมาชิกของคุณแนบมากับอีเมลฉบับนี้',
      '',
      'รหัสสมาชิก {{member_code}}',
      '{{membership_line}}',
      '',
      'ตอนมาที่ยิม เปิดรูปบัตรให้พนักงานสแกน',
      'ไม่ต้องพกบัตรแข็งและไม่ต้องจำรหัส',
      '',
      'เก็บรูปบัตรไว้ในเครื่อง หรือบันทึกลงอัลบั้มรูปไว้ก็ได้',
      'ถ้าหาไม่เจอ ขอใหม่ได้ที่เคาน์เตอร์',
      '',
      'อย่าส่งต่อรูปบัตรให้คนอื่น รูปบัตรคือสิ่งที่ใช้เข้ายิมแทนตัวคุณ',
      '',
      '--',
      '{{gym_name}} · โทร {{gym_phone}}',
      'อีเมลนี้ส่งอัตโนมัติ กรุณาอย่าตอบกลับ'
    ]
  }
};

/* ------------------------------------------------------------- เขียนไฟล์ - */
const OUT = path.join(__dirname, '..', 'emails');
fs.mkdirSync(OUT, { recursive: true });

const index = [];
for (const key of Object.keys(MAILS)) {
  const m = MAILS[key];
  fs.writeFileSync(path.join(OUT, key + '.html'), html(m));
  fs.writeFileSync(path.join(OUT, key + '.txt'), m.text.join('\n') + '\n');
  index.push({ file: key, subject: m.subject, preheader: m.preheader });
}
fs.writeFileSync(path.join(OUT, 'subjects.json'), JSON.stringify(index, null, 2) + '\n');
console.log('เขียน ' + (index.length * 2 + 1) + ' ไฟล์ลง emails/');
index.forEach(i => console.log('  ' + i.file + '  →  ' + i.subject));
