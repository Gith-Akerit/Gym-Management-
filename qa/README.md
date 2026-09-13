# QA probes — KENC-20 Phase 1 (PR #1)

เขียนโดย QA Release Tester เพื่อยืนยันเคส MEM-001 ถึง MEM-054 และ XCUT-004/005/008
**ไม่มีไฟล์ใดในนี้ถูก import โดย production code** และไม่มีการแก้ไข `server/`, `web/`, `mobile/`

## วิธีรัน

```bash
npm install
npm run build                 # จำเป็นก่อนรัน UI test (ดู BUG-05)
node --test qa/*.test.js      # ชุด API/ข้อมูล
PLAYWRIGHT_CHANNEL=msedge npx playwright test    # ชุดเบราว์เซอร์
```

## ไฟล์

| ไฟล์ | ครอบคลุม |
|---|---|
| `qa-matrix.test.js` | MEM-001 ถึง MEM-054, XCUT-004/005/008 |
| `qa-followup.test.js` | MEM-047 (แก้ probe รอบแรก), MEM-034 แบบเข้ม, XCUT-003/009, MEM-028/030/032/033 |
| `qa-final.test.js` | MEM-002 data integrity, MEM-019/023/024, staff role, XCUT-006 |
| `qa-proxy.test.js` | BUG-01 — per-IP throttle หลัง reverse proxy |
| `../tests/ui/qa-a11y.spec.js` | MEM-033/035/036/037/040/052 บนเบราว์เซอร์จริง |
| `../tests/ui/qa-evidence.spec.js` | ภาพหลักฐานของ BUG-02 |

## เคสที่ตั้งใจให้ fail

`qa-*.test.js` มี 4 เคสที่ **fail โดยตั้งใจ** เพราะเป็นบั๊กที่รายงานไว้ ถ้าแก้บั๊กแล้วเคสเหล่านี้ต้องเขียว:

- `MEM-002 (data integrity) a PUT that omits optional fields wipes them` → BUG-03
- `MEM-034 (strict) every field message reaching the user is Thai` → BUG-02
- `XCUT-004 .env.example covers every variable the code reads` → BUG-04
- `OTP per-IP budget ... every client behind a proxy shares it` → BUG-01
