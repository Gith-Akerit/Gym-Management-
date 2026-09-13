import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPromptPayPayload, crc16, formatAmount, maskPromptPayId,
  normalisePromptPayId, parsePromptPayPayload,
} from '../server/promptpay.js';

// Everything here runs offline. Scanning a real QR with a bank app moves real
// money, so that case is deliberately not automated — see README.

test('CRC matches the published check value for CRC-16/CCITT-FALSE', () => {
  // "123456789" -> 0x29B1 is the check value defined for this CRC variant, so a
  // payload checksum can be trusted without paying anyone to find out.
  assert.equal(crc16('123456789'), '29B1');
  assert.equal(crc16(''), 'FFFF');
});

test('a payload decodes into the fields a bank app reads, with a valid CRC', () => {
  const payload = buildPromptPayPayload('0899999999', 422);
  const { fields, crcValid } = parsePromptPayPayload(payload);

  assert.equal(crcValid, true);
  assert.equal(fields['00'], '01');            // payload format
  assert.equal(fields['01'], '12');            // dynamic: one-time, amount fixed
  assert.equal(fields['58'], 'TH');
  assert.equal(fields['53'], '764');           // THB
  assert.equal(fields['54'], '4.22');
  assert.equal(fields['29'], '0016A00000067701011101130066899999999');
  assert.equal(payload.slice(-8, -4), '6304');
});

test('changing a single character invalidates the checksum', () => {
  const payload = buildPromptPayPayload('0899999999', 120000);
  assert.equal(parsePromptPayPayload(payload).crcValid, true);
  const tampered = payload.replace('54041200', '54040100');
  assert.equal(parsePromptPayPayload(tampered).crcValid, false);
});

test('the amount in the QR is exactly the amount charged', () => {
  assert.equal(formatAmount(120000), '1200');
  assert.equal(formatAmount(129950), '1299.50');
  assert.equal(formatAmount(5), '0.05');
  assert.equal(formatAmount(99999999), '999999.99');
  assert.equal(parsePromptPayPayload(buildPromptPayPayload('0899999999', 129950)).fields['54'], '1299.50');

  for (const bad of [0, -1, 1.5, 100000001]) assert.throws(() => formatAmount(bad));
});

test('mobile, national ID and e-Wallet identifiers each use their own tag', () => {
  assert.deepEqual(normalisePromptPayId('081-234-5678'), { type: 'mobile', tag: '01', value: '0066812345678' });
  assert.deepEqual(normalisePromptPayId('+66812345678'), { type: 'mobile', tag: '01', value: '0066812345678' });
  assert.deepEqual(normalisePromptPayId('1234567890123'), { type: 'national_id', tag: '02', value: '1234567890123' });
  assert.deepEqual(normalisePromptPayId('004999000000008'), { type: 'ewallet', tag: '03', value: '004999000000008' });

  // Tag 02 is 13 characters, tag 03 is 15; the lengths must follow.
  assert.match(parsePromptPayPayload(buildPromptPayPayload('1234567890123', 100)).fields['29'], /02131234567890123$/);
  assert.match(parsePromptPayPayload(buildPromptPayPayload('004999000000008', 100)).fields['29'], /0315004999000000008$/);

  for (const bad of ['', '12345', '0812345678901234567', 'ไม่ใช่เบอร์', null]) {
    assert.throws(() => normalisePromptPayId(bad), /PROMPTPAY_ID/);
  }
});

test('the merchant identifier is masked down to its last four digits', () => {
  assert.equal(maskPromptPayId('0899999999'), '******9999');
  assert.equal(maskPromptPayId('1234567890123'), '*********0123');
  assert.equal(maskPromptPayId(undefined), '****');
});
