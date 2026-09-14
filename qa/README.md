# QA probes — KENC-20 (แอปเคาน์เตอร์)

เขียนโดย QA Release Tester **ไม่มีไฟล์ใดในนี้ถูก import โดย production code**
และไม่มีการแก้ไข `server/`, `web/`

## วิธีรัน

```bash
npm install
npm run build
node --test qa/*.test.js                          # probe ของ QA
PLAYWRIGHT_CHANNEL=msedge npm run test:ui         # ชุดเบราว์เซอร์ของทีมพัฒนา
node qa/ui-audit.mjs                              # ตรวจการแสดงผลทุกหน้า 1280/390
```

## ไฟล์

| ไฟล์ | ครอบคลุม |
|---|---|
| `matrix-counter.md` | **test matrix ของโจทย์ใหม่** 9 หมวด ใช้แทน matrix เดิมทั้งชุด |
| `qa-counter.test.js` | CARD-01..03, PHOTO-01..02, MIG-01..02, GONE-01 — บัตร รูปถ่าย migration 007 และซากของแอปสมาชิก |
| `qa-pilot.test.js` | `env:set`, entrypoint, deployment package |
| `qa-proxy.test.js` | โควตาต่อ IP หลัง proxy |
| `ui-audit.mjs` + `audit-probe.mjs` | ตรวจการแสดงผลทุกหน้า × 1280/390 (ล้นกรอบ, ข้อความถูกตัด, ปุ่มเล็กกว่า 44px, contrast) |
| `live-ui.mjs` | ตรวจการแสดงผลหน้าสาธารณะบนเครื่องจริง พร้อมเทียบ hash ของ bundle |
| `live-round.mjs` | ไล่ matrix หมวด A–G และ I บนเครื่องจริงผ่าน API (ต้องมี `QA_SETPW_TOKEN` · รหัสผ่านเก็บนอก repo) |
| `live-screens.mjs` | ไล่ทุกหน้าของแอปเคาน์เตอร์บนเครื่องจริง × 1280/390 พร้อมเก็บภาพ (UI-01, XCUT-06) |

## สถานะบน `release/pilot` (`cf6fa58`)

| ชุด | ผล |
|---|---|
| `node --test qa/*.test.js` | **18/18** |
| `npm test` (ชุดของทีมพัฒนา) | **114/114** |
| `PLAYWRIGHT_CHANNEL=msedge npm run test:ui` | **21/21** บน Edge |
| `python3 -B tests/bootstrap-env.test.py` | **ยังรันไม่ได้** ไม่มี Python ในเครื่องนี้ |

## probe ที่ถูกปลดออกในรอบนี้ และเหตุผล

โจทย์เปลี่ยนที่ `cf6fa58`: ไม่มีแอปสมาชิก ไม่มี OTP ไม่มีการซื้อฝั่งสมาชิก
probe ที่ทดสอบสิ่งเหล่านั้นจึงไม่ได้ "พัง" — **สิ่งที่มันเฝ้าอยู่ไม่มีแล้ว** เก็บไว้เป็นสีแดงถาวร
มีแต่จะกลบของจริง จึงลบทิ้งตามของที่มันทดสอบ ไม่ใช่ปิดไว้เฉย ๆ

| ไฟล์ที่ลบ | เคยเฝ้าอะไร | ตอนนี้ความตั้งใจนั้นอยู่ที่ไหน |
|---|---|---|
| `qa-matrix`, `qa-followup`, `qa-final` | สมัครสมาชิกด้วย OTP, โปรไฟล์, rate limit ของ OTP | matrix หมวด A (ล็อกอินรหัสผ่าน + lockout) |
| `qa-chk` | QR ใช้ครั้งเดียวและการกวาด token | matrix หมวด C และ E (บัตรถาวร) |
| `qa-pkg`, `qa-pkg2`, `qa-race` | ซื้อแพ็กเกจ, ส่งสลิป, แข่งกันอนุมัติ | matrix หมวด F (รับเงินที่เคาน์เตอร์) |
| `qa-pilotmode`, `qa-pilotcode` | โหมดทดลองและ CLI รหัสแอดมินคนแรก | เลิกใช้ OTP แล้ว — matrix AUTH-14/15 |
| `qa-users` | ผู้ใช้และสิทธิ์รุ่นที่สมาชิกมีบัญชี | matrix หมวด G (ยกเคสมาครบ) |
| `recover-pilot-code.mjs`, `qa-accounts*.sql`, `live-final.mjs` | เครื่องมือของรอบ pilot mode | ไม่ใช้แล้ว |

`qa-pilot.test.js` ถูกตัดเฉพาะ PILOT-01..03 ที่ยิงผ่าน `POST /orders` ส่วนเคส deployment คงไว้ทั้งหมด

## หมายเหตุที่ยังใช้ได้อยู่

- **ชุดเบราว์เซอร์ผูกพอร์ต 4310/4311 ตายตัว** และ `tests/free-port.js` สั่ง `taskkill` ใครก็ตามที่ถือพอร์ตนั้น
  บนเครื่องที่มีหลาย agent ทำงานพร้อมกัน สองรันจะฆ่ากันเอง — เขียนผลลงไฟล์แล้วค่อย grep
  และเคลียร์พอร์ตก่อนรัน (ตรวจ PID กับ `multica daemon status` ทุกครั้งก่อนสั่งหยุด)
  `ui-audit.mjs` ยกเซิร์ฟเวอร์เองบนพอร์ต 4397/4398 จึงไม่ชนใคร
- **นาฬิกาของ fixture หยุดนิ่ง** ถ้าเคสหนึ่งทำสองอย่างที่ต้องเรียงตามเวลา ต้อง `tick()` คั่น
  ไม่งั้น audit สองแถวจะมี `created_at` เท่ากันและลำดับขึ้นกับ id
