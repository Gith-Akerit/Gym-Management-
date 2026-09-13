# QA probes — KENC-20

เขียนโดย QA Release Tester **ไม่มีไฟล์ใดในนี้ถูก import โดย production code**
และไม่มีการแก้ไข `server/`, `web/`, `mobile/`

## วิธีรัน

```bash
npm install
npm run build                 # จำเป็นก่อนรัน UI test (BUG-05 ของ Phase 1)
node --test qa/*.test.js      # ชุด API และข้อมูล
PLAYWRIGHT_CHANNEL=msedge npx playwright test    # ชุดเบราว์เซอร์
```

## ไฟล์

| ไฟล์ | ครอบคลุม |
|---|---|
| `qa-pkg.test.js` | Phase 2 · PKG-001..008, 010..017, 020..031, 040..053, 060..065, 070..073, 080..086 |
| `qa-pkg2.test.js` | Phase 2 follow-up + XCUT-001 (regression ของ Phase 1 บน branch Phase 2) |
| `../tests/ui/04-qa-pkg.spec.js` | PKG-033/045/053/080/081/082/083 บนเบราว์เซอร์จริง |

Phase 1 (`qa-matrix`, `qa-followup`, `qa-final`, `qa-proxy`) อยู่บน branch `qa/phase1-matrix-probes`

## เคสที่ตั้งใจให้ fail

เป็นบั๊กที่รายงานไว้บน KENC-20 แก้แล้วต้องเขียวทั้งหมด:

| เทสต์ | บั๊ก |
|---|---|
| `a slip sent late is stranded when the admin rejects it after the deadline` | P2-BUG-01 |
| `PKG-049 an approval made in error can be reversed and then re-decided` | P2-BUG-02 |
| `a package read from the API and written back unchanged multiplies its price by 100` | P2-BUG-03 |
| `a free package that is put on sale cannot be bought at all` | P2-BUG-04 |
| `PKG-053 a slip that does not match the price is flagged before approval` | P2-BUG-05 |
| `after a rejection the member is never shown the QR again` | P2-BUG-06 |
| `slip metadata handed to the member includes the storage filename and file hash` | P2-BUG-07 |
| `PKG-086 the docs state where slips live, how they are backed up and for how long` | P2-BUG-08 |
| `PKG-053 a short payment can be approved with no explanation at all` (UI) | P2-BUG-05 |
| `PKG-033 the payment screens degrade honestly when the network drops` | BUG-02 ของ Phase 1 |
