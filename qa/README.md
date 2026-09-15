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
| `live-round2..5.mjs` | รอบต่อเนื่องบนเครื่องจริง: ขอบเขตชื่อ/เบอร์, บัตรของชื่อยาวและไม่มีรูป, ออกบัตรใหม่ซ้ำ, สิทธิ์พนักงาน, บัญชีและ audit, โควตาต่อ IP และการเก็บกวาดข้อมูล QA |
| `qa-branding.test.js` | หมวด J ทั้งหมดฝั่ง API: สิทธิ์, โลโก้ที่ถูกปฏิเสธ, บัตรเดิมหลังเปลี่ยนสี, พรีวิวเทียบพิกเซลบัตร, `version` |
| `brand-sweep.mjs` | ทุกหน้า × 1280/390 ในยิม 5 สี พร้อมวัดว่าสีที่แปลว่าผ่าน/ไม่ผ่านขยับตามแบรนด์หรือไม่ |
| `brand-login.spec.js` + `playwright.qa.config.js` | หน้าล็อกอินและแถบจอสแกนในยิมที่ไม่ใช่สีเขียว (วัดจากพิกเซลจริง) |
| `qa-deploy-paths.test.js` | BRAND-14: ทุก `*_STORAGE_PATH` ที่โค้ดอ่าน ถูกตั้งไว้ใต้ `/data` ครบทั้ง compose/fly/render · และ `tests/deploy-paths.test.js` ของทีมจับได้จริงเมื่อถอดออกทีละตัว |

## สถานะบน `release/pilot` (`6aea79d`)

| ชุด | ผล |
|---|---|
| `node --test qa/*.test.js` | **50/50** |
| `npm test` (ชุดของทีมพัฒนา) | **172/172** |
| `PLAYWRIGHT_CHANNEL=msedge npm run test:ui` | **41/41** บน Edge (รวม `09-tokens.spec.js` ที่ยก BRAND-UI-04 เข้าชุดถาวร) |
| `python3 -B tests/bootstrap-env.test.py` | **ยังรันไม่ได้** ไม่มี Python ในเครื่องนี้ |
| `node qa/live-round*.mjs` บนเครื่องจริง | ไล่หมวด A–G และ I ครบเท่าที่ทำจากระยะไกลได้ ที่ `170ee35` |
| `npx playwright test --config qa/playwright.qa.config.js` | **4/4** |

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
- **อย่าผสมนาฬิกาของ fixture กับนาฬิกาจริง** `server/admin-link.js` รันเป็นอีกโปรเซสและประทับเวลาจริง
  ถ้า fixture ตรึงไว้ที่วันเวลาหนึ่ง แล้ว `tick(DAY)` อาจไปหยุด**ก่อน**วันหมดอายุที่ CLI เขียนไว้
  ผลคือ probe เขียวตอนเช้าและแดงตอนบ่ายโดยที่ product ไม่ได้เปลี่ยนอะไร (`qa-links.test.js` เจอมาแล้ว)
  ถ้าเคสไหนต้องใช้ CLI ให้ fixture เริ่มที่ `Date.now()` และอย่า assert ลำดับของแถว audit ที่มาจากสองโปรเซส
