// The wait that used to have no end.
//
// Pressing "แจ้งปัญหา" on the scan screen photographs the screen first, so the
// picture is of the problem rather than of the box asking about it. On the
// machine at the gym that photograph never came back: the QR loop and the
// screenshot library between them left the promise unsettled, the panel
// covered every control underneath, and staff had no way out but reloading the
// page -- measured at over three minutes, on the screen they stand in front of
// all day (QA BUG-14).
//
// Two things are checked here, both without a browser. The clock, because a
// promise that never settles is the whole subject and the only honest way to
// test it is to hand one over. And the flag the scan loop reads, because the
// loop and the capture live in different component trees and a flag that
// nobody clears is a camera that never reads a card again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPTURE_TIMEOUT_MS, onScanningPause, scanningPaused, setScanningPaused, withTimeout }
  from '../web/capture.js';

test('a promise that never settles gives up on its own', async () => {
  const never = new Promise(() => {});
  await assert.rejects(() => withTimeout(never, 20), /จับภาพหน้าจอไม่ทัน/);

  // And the caller is told, rather than left holding a promise: the screen
  // turns that rejection into the "picture failed" form, which already works.
  const answer = await withTimeout(Promise.resolve('data:image/png;base64,x'), 20);
  assert.equal(answer, 'data:image/png;base64,x');
  await assert.rejects(() => withTimeout(Promise.reject(new Error('เบราว์เซอร์ปฏิเสธ')), 20),
    /เบราว์เซอร์ปฏิเสธ/);

  // Eight seconds: long enough that a slow tablet still gets its picture,
  // short enough that nobody standing at a counter thinks the app has died.
  assert.equal(CAPTURE_TIMEOUT_MS, 8000);
});

test('the timer is cleared, so a finished capture leaves nothing running', async () => {
  // A test runner that exits cleanly is the assertion: an uncleared timer of
  // this length would hold the process open for eight seconds after the last
  // test, which is how a "leak" here would announce itself.
  const before = process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;
  await withTimeout(Promise.resolve(1), CAPTURE_TIMEOUT_MS);
  assert.equal(process.getActiveResourcesInfo().filter(name => name === 'Timeout').length, before);
});

test('the scan loop is told to stop decoding, and told to start again', () => {
  const seen = [];
  const stop = onScanningPause(value => seen.push(value));
  assert.equal(scanningPaused(), false);

  setScanningPaused(true);
  assert.equal(scanningPaused(), true, 'ลูปอ่าน QR ต้องหยุดถอดรหัสระหว่างจับภาพ');
  setScanningPaused(true);                                  // no second shout
  setScanningPaused(false);
  assert.equal(scanningPaused(), false, 'จับภาพเสร็จแล้วต้องกลับมาอ่านบัตรได้ ไม่งั้นกล้องตายเงียบ');
  assert.deepEqual(seen, [true, false]);

  stop();
  setScanningPaused(true);
  assert.deepEqual(seen, [true, false], 'เลิกฟังแล้วต้องไม่ถูกเรียกอีก');
  setScanningPaused(false);
});
