# Technical design — Gym Management (Phase 1)

เอกสารนี้อธิบายการตัดสินใจที่มีผลข้ามเฟส เพื่อให้ Phase 2 (ซื้อแพ็กเกจ) และ Phase 3 (เช็คอิน) ต่อยอดได้โดยไม่ต้องรื้อ

## ขอบเขตที่ล็อกไว้

| ข้อ | ค่าที่ตกลง | ผลต่อโค้ด |
|---|---|---|
| สาขา | สาขาเดียว | **ไม่มี** entity `Branch` และไม่มี `branch_id` ในตารางใด |
| สมัครสมาชิก | อีเมล + OTP สมัครเองได้ และแอดมินสร้างให้ได้ | `otp_challenges`, `otp_lockouts`, `sessions` |
| ชำระเงิน | PromptPay QR ของยิมเอง + อัปโหลดสลิป + แอดมินยืนยัน (ไม่มี payment provider) | Phase 2 |
| เช็คอิน | dynamic QR อายุสั้น ใช้ครั้งเดียว ให้พนักงานสแกน | Phase 3 |
| แพ็กเกจ | unlimited หรือจำกัดจำนวนครั้ง **ทุกแบบมีวันหมดอายุ** | `packages.duration_days` บังคับเสมอ |
| หักโควตา | หักใบที่หมดอายุเร็วสุดก่อน เท่ากันให้หักใบที่ซื้อก่อน | Phase 3 |
| จองคลาส/เทรนเนอร์ | ไม่มีใน MVP | — |

## สถาปัตยกรรม

```
เว็บ (React)  ─┐
แอป Expo      ─┼─→  Express API  ─→  SQLite (WAL)
                │         └────────→  SMTP (อีเมล OTP)
```

API เดียวให้บริการทั้งสอง client ต่างกันแค่วิธีถือ session: เว็บใช้ cookie `HttpOnly` + `SameSite=Strict`
มือถือใช้ bearer token เก็บใน `expo-secure-store` (คุกกี้ `SameSite=Strict` ใช้กับแอปเนทีฟไม่ได้)

### ทำไมเลือก SQLite

ยิมสาขาเดียว มีสมาชิกหลักร้อยถึงหลักพัน เขียนข้อมูลไม่กี่ครั้งต่อนาที `node:sqlite` มากับ Node 24 จึงไม่ต้องคอมไพล์
native module บน Windows ไม่ต้องดูแลเซิร์ฟเวอร์ฐานข้อมูลแยก และสำรองข้อมูลด้วยการคัดลอกไฟล์

โครงสร้างเขียนให้ย้ายไป PostgreSQL ได้เมื่อจำเป็น: ไม่มีฟีเจอร์เฉพาะ SQLite นอกจาก `STRICT` และ `GLOB`
การเข้าถึงฐานข้อมูลทั้งหมดอยู่ใน `server/db.js` กับ `server/app.js` และคำสั่งเขียนทุกชุดอยู่ในทรานแซกชันอยู่แล้ว

จุดที่ต้องระวังเมื่อโตขึ้น: SQLite เขียนได้ทีละรายการ ถ้าอนาคตมีการหักโควตาพร้อมกันจำนวนมาก (Phase 3 ช่วงเย็น)
ให้วัดก่อนย้าย ไม่ต้องย้ายล่วงหน้า

## โครงสร้างข้อมูล

### Phase 1 (migration 001, 002)

```
users(id, email UNIQUE COLLATE NOCASE, role, email_verified_at, created_at)
members(id, user_id UNIQUE → users, member_code UNIQUE, name, phone UNIQUE,
        date_of_birth, emergency_contact, status, version, joined_at, updated_at)
otp_challenges(id, email, code_hash, attempts, created_at, expires_at, consumed_at)
otp_lockouts(email PK, failures, locked_until, updated_at)
sessions(token_hash PK, user_id → users, expires_at)
rate_limits(bucket PK, hits, expires_at)
audit_logs(id, actor_id → users, action, entity_type, entity_id, before_json, after_json, created_at)

gym_profile(id=1, name, brand_name_th, address, location_note, phone_primary,
            phone_secondary, phone_display, timezone, currency,
            hours_confirmed, hours_note, version, updated_at)
gym_hours(weekday PK 0-6, closed, open_time, close_time, updated_at)
packages(id, code UNIQUE, name_th, type, duration_days, session_limit,
         price_satang, description, status, sort_order, version, created_at, updated_at)
```

### ที่จะเพิ่มใน Phase 2-3 (ยังไม่ได้สร้าง)

```
orders(id, member_id, package_id, price_satang_snapshot, status, created_at, expires_at)
payment_slips(id, order_id, file_key, file_hash, reference_no, transferred_at, uploaded_at)
entitlements(id, member_id, package_id, order_id, starts_at, expires_at, sessions_remaining, status)
check_ins(id, member_id, entitlement_id, result, failure_reason, device_id, checked_in_at)
```

## การตัดสินใจที่สำคัญ

**ราคาเก็บเป็นสตางค์ (integer)** — `price_satang` ไม่ใช่ทศนิยม 1,299.50 บาทคือ 129950 พอดี ไม่มีทางเพี้ยนจาก float
API คืนทั้ง `price_satang` และ `price_thb` เพื่อให้ฝั่งหน้าจอแสดงผลง่าย แต่ค่าที่เป็นความจริงคือสตางค์

**ราคาที่ยังไม่กำหนดเป็น `NULL` ไม่ใช่ 0** — เจ้าของยิมยังไม่ได้ให้ราคามา ระบบจึงต้องแยก “ฟรี” ออกจาก “ยังไม่รู้”
หน้าจอแสดงว่า “รอประกาศราคา” และแพ็กเกจที่ราคาเป็น `NULL` จะเปลี่ยนสถานะเป็น `active` ไม่ได้ ตรวจทั้งที่ schema และ validation

**ข้อมูลธุรกิจอยู่ในฐานข้อมูล ไม่ใช่ในโค้ดหรือ env** — เวลาเปิดทำการ เบอร์โทร ที่อยู่ และราคา แก้ได้ในหน้าแอดมิน
`hours_confirmed` แยก “ค่าที่ตั้งไว้ก่อน” ออกจาก “ค่าที่ยืนยันแล้ว” ตราบใดที่ยังไม่ยืนยัน แอปสมาชิกจะเตือนให้โทรสอบถาม
เพราะการแสดงเวลาเปิดที่อาจผิดให้ลูกค้าเห็นเหมือนเป็นความจริง แย่กว่าการบอกตรง ๆ ว่ายังไม่ยืนยัน

**เก็บ `version` ไว้ทำ optimistic locking** — ทุกการแก้ไขต้องส่ง `version` ที่อ่านมา ถ้าไม่ตรงจะได้ 409
ป้องกันกรณีเปิดสองแท็บแล้วบันทึกทับกันเงียบ ๆ (เคส MEM-015) ใช้กับ members, packages และ gym_profile

**ปิดการขายแทนการลบ (archive)** — Phase 2 จะมี order ที่อ้างถึง package ถ้าลบทิ้งข้อมูลธุรกรรมจะกำพร้า
`DELETE /api/packages/:id` จึงเปลี่ยนสถานะเป็น `archived` เท่านั้น สิทธิ์ที่ขายไปแล้วยังใช้ได้

**OTP lockout ต่ออีเมล ไม่ใช่ต่อคำขอ** — รหัส 6 หลักมีแค่ 1 ล้านค่า ถ้าจำกัดแค่ 5 ครั้งต่อคำขอ ผู้โจมตีขอรหัสใหม่
แล้วเดาต่อได้เรื่อย ๆ `otp_lockouts` จึงนับความผิดพลาดต่ออีเมล ครบ 5 ครั้งล็อก 15 นาที และล้างเมื่อเข้าสู่ระบบสำเร็จ

**ขอ OTP ด้วยอีเมลที่ไม่มีในระบบได้ 202 เหมือนกัน** — และผู้ใช้จะถูกสร้างก็ต่อเมื่อยืนยันรหัสสำเร็จแล้วเท่านั้น
ทำให้ไล่เก็บรายชื่ออีเมลลูกค้าจากผลตอบกลับไม่ได้

**per-IP rate limit คิดจาก IP ของผู้ใช้จริง** — production บังคับ HTTPS จึงมี reverse proxy เสมอ
ถ้าไม่ตั้ง `trust proxy` ทุกคำขอจะมาจาก IP ของ proxy ตัวเดียว แล้วสมาชิกทั้งยิมจะแชร์โควตาก้อนเดียว (QA BUG-01)
`createApp` ตั้ง `trust proxy` เป็น 1 เป็นค่าเริ่มต้น และ `TRUST_PROXY` ปรับตามจำนวน hop จริงตอน deploy
เพดานต่อ IP เป็นเพียงด่านกัน DoS ด่านกันสแปมจริงคือเพดานต่ออีเมลกับ cooldown 60 วินาที

**ข้อความผิดพลาดทุกข้อความที่ผู้ใช้เห็นเป็นภาษาไทย** — `parse()` แทนที่ข้อความ default ภาษาอังกฤษของ zod
ด้วยข้อความไทยที่แมปจาก `issue.code` ส่วนข้อความที่เราเขียนเองผ่านไปตามเดิม วิธีนี้ไม่ผูกกับ internal ของ zod
และกันไม่ให้ข้อความอังกฤษหลุดเมื่อเพิ่ม schema ใหม่ในเฟสถัดไป

**PUT สมาชิกที่ไม่ส่งฟิลด์ไม่บังคับ จะไม่ลบค่าเดิม** — เดิม `updateSchema` มี `.default()` ทำให้ client ที่ส่งเฉพาะ
ฟิลด์ที่แก้ ลบวันเกิดและเบอร์ผู้ติดต่อฉุกเฉินทิ้งเงียบ ๆ (QA BUG-03) ตอนนี้ฟิลด์ที่ไม่ส่งมาจะคงค่าเดิมไว้

**ค้นหาด้วยเบอร์โทรถูก normalize ก่อน** — `081-234-5678`, `+66812345678` และ `0812345678` ถือเป็นเบอร์เดียวกัน
ทั้งตอนบันทึกและตอนค้นหา อักขระพิเศษใน keyword ถูก escape ให้เป็นตัวอักษรธรรมดา

**audit log บันทึก before/after เป็น JSON** — Phase 2 จะไม่มีหลักฐานจาก payment provider การยืนยันของแอดมิน
จึงเป็นหลักฐานเดียวที่เหลือ `entity_type` ถูกเพิ่มใน migration 002 เพื่อรองรับ order และ slip ในเฟสถัดไป

## สัญญา API (Phase 1)

| Method | Path | สิทธิ์ | หมายเหตุ |
|---|---|---|---|
| GET | `/api/public/gym` | สาธารณะ | เวลาเปิด ที่อยู่ เบอร์ที่เลือกให้แสดง — ไม่ต้องล็อกอิน |
| GET | `/api/public/packages` | สาธารณะ | เฉพาะแพ็กเกจที่เปิดขาย — ไม่ต้องล็อกอิน |
| POST | `/api/auth/request-otp` | สาธารณะ | 202 เสมอ ไม่บอกว่าอีเมลมีอยู่หรือไม่ |
| POST | `/api/auth/verify-otp` | สาธารณะ | สร้างผู้ใช้เมื่อยืนยันสำเร็จ |
| POST | `/api/auth/logout` | ล็อกอินแล้ว | ลบ session |
| GET | `/api/me` | ล็อกอินแล้ว | ข้อมูลตัวเองและโปรไฟล์สมาชิก |
| PUT | `/api/me/profile` | สมาชิก | สร้างโปรไฟล์ครั้งแรก |
| GET | `/api/members` | แอดมิน | ค้นหา + แบ่งหน้า |
| POST/GET/PUT/DELETE | `/api/members[/:id]` | แอดมิน | `DELETE` = ระงับ ไม่ใช่ลบ |
| GET | `/api/members/:id/audit` | แอดมิน | ประวัติการแก้ไข |
| GET | `/api/gym` | ล็อกอินแล้ว | แอดมินเห็นครบ สมาชิกเห็นเฉพาะข้อมูลสาธารณะ |
| PUT | `/api/gym`, `/api/gym/hours` | แอดมิน | ต้องส่ง `version` |
| GET | `/api/packages` | ล็อกอินแล้ว | สมาชิกเห็นเฉพาะ `active` |
| POST/GET/PUT/DELETE | `/api/packages[/:id]` | แอดมิน | `DELETE` = archive |

หลักที่ Phase 2-3 ต้องรักษาไว้: ไม่ลบ endpoint หรือ field ที่มือถือใช้อยู่โดยไม่แจ้ง (เคส XCUT-003)

## สิ่งที่ Phase 2 ต้องทำตั้งแต่ต้น ไม่ใช่มาแก้ทีหลัง

1. **ยืนยันสลิปต้อง idempotent** — แอดมินดับเบิลคลิก หรือแอดมินสองคนกดพร้อมกัน ต้องได้ entitlement ใบเดียว
   ใช้ `UPDATE orders SET status='paid' WHERE id=? AND status='awaiting_review'` แล้วตรวจ `changes === 1` ในทรานแซกชันเดียวกับการสร้าง entitlement
2. **ราคาคิดจากฝั่งเซิร์ฟเวอร์เสมอ** — อ่านจาก `packages.price_satang` ไม่เชื่อค่าที่ client ส่งมา และ snapshot ราคาลงใน order
3. **สลิปเป็นข้อมูลส่วนบุคคล** — เก็บใน private storage ตั้งชื่อไฟล์เองฝั่งเซิร์ฟเวอร์ ตรวจ magic bytes ไม่ใช่นามสกุล
   ไม่รับ SVG เข้าถึงผ่าน signed URL อายุสั้น ถอด EXIF และตั้งอายุการเก็บไว้ 1 ปี
4. **กันสลิปซ้ำ** — เก็บ hash ของไฟล์และเลขอ้างอิงสลิป เตือนแอดมินเมื่อซ้ำ
5. **PromptPay ID อ่านจาก env** และ mask ใน log เพราะเป็นเบอร์โทรของเจ้าของกิจการ
6. **สถานะ order** `pending_payment → awaiting_review → paid | rejected | expired | cancelled` ทุกสถานะต้องมีทางออก

## สิ่งที่ Phase 3 ต้องทำตั้งแต่ต้น

0. **สิทธิ์ของ role `staff`** — Phase 1 ให้ staff ล็อกอินได้แต่ทำอะไรไม่ได้เลย Phase 3 ต้องเปิดให้ staff
   สแกน QR, ดูผลและประวัติเช็คอิน และดูคิวสลิปแบบอ่านอย่างเดียว โดยไม่ให้สิทธิ์อนุมัติสลิปหรือแก้ข้อมูลสมาชิก

1. **QR เป็น signed token อายุสั้น ใช้ครั้งเดียว** ไม่ใช่รหัสสมาชิกแบบคงที่ ไม่งั้นแคปหน้าจอส่งให้เพื่อนใช้ได้
2. **ตรวจอายุ QR ด้วยเวลาของเซิร์ฟเวอร์** ไม่ใช่เวลาของเครื่องสมาชิก
3. **หักโควตาแบบ atomic** — `UPDATE entitlements SET sessions_remaining = sessions_remaining - 1 WHERE id=? AND sessions_remaining > 0`
   แล้วตรวจจำนวนแถวที่เปลี่ยน โควตาห้ามติดลบแม้ยิงพร้อมกัน
4. **เลือก entitlement ที่หมดอายุเร็วสุดก่อน** ถ้าวันหมดอายุเท่ากันให้ใช้ใบที่ซื้อก่อน
5. **สถานะสมาชิกมาก่อนสิทธิ์แพ็กเกจ** — สมาชิกที่ถูกระงับต้องเช็คอินไม่ผ่านแม้แพ็กเกจยังไม่หมดอายุ
6. **เขตเวลา Asia/Bangkok** สำหรับการตัดสินวันหมดอายุ ไม่ใช่ UTC

## การทดสอบ

- `npm test` — 30 เคสระดับ API ครอบคลุม migration ขึ้น-ลง-ขึ้น, OTP และ lockout, สิทธิ์, IDOR, injection, การ seed และ validation ของแพ็กเกจ
- `npm run test:ui` — 6 เส้นทางผ่านเบราว์เซอร์จริง รวมหน้าจอ 320-390 px และตรวจว่าไม่มี JS error
- ที่ยัง **ไม่ได้** ทดสอบ: แอป Expo บนอุปกรณ์จริง (ไม่มี Android SDK / Xcode บนเครื่องที่พัฒนา) และทุกอย่างของ Phase 2-3 ที่ยังไม่มีโค้ด
