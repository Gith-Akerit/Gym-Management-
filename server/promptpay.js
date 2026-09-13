// PromptPay QR payload, EMVCo "Merchant Presented QR" (EMV QRCPS).
//
// The gym receives money straight into its own bank account, so there is no
// payment provider generating this for us. If the payload is wrong by a single
// byte no bank app can read it and nobody can pay, which is why every piece
// below is built from the spec and covered by tests that run offline.

const ID_PAYLOAD_FORMAT = '00';
const ID_POINT_OF_INITIATION = '01';
const ID_MERCHANT_PROMPTPAY = '29';
const ID_COUNTRY = '58';
const ID_CURRENCY = '53';
const ID_AMOUNT = '54';
const ID_CRC = '63';

const PROMPTPAY_AID = 'A000000677010111';
const CURRENCY_THB = '764';
const COUNTRY_TH = 'TH';
// 11 = static (reusable, no amount), 12 = dynamic (one-time, amount included).
const DYNAMIC = '12';

/** EMVCo tag-length-value. Length is the character count, zero padded to two. */
function tlv(id, value) {
  const length = String(value.length).padStart(2, '0');
  if (value.length > 99) throw new Error(`EMVCo value for tag ${id} is too long`);
  return `${id}${length}${value}`;
}

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final xor. */
export function crc16(input) {
  let crc = 0xffff;
  for (const byte of Buffer.from(input, 'utf8')) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Works out which kind of PromptPay ID this is and returns it in the form the
 * spec wants. Mobile numbers become 0066 plus the number without its leading 0.
 */
export function normalisePromptPayId(raw) {
  const digits = String(raw ?? '').replace(/[\s()+-]/g, '');
  if (/^0\d{9}$/.test(digits)) return { type: 'mobile', tag: '01', value: `0066${digits.slice(1)}` };
  if (/^66\d{9}$/.test(digits)) return { type: 'mobile', tag: '01', value: `00${digits}` };
  if (/^\d{13}$/.test(digits)) return { type: 'national_id', tag: '02', value: digits };
  if (/^\d{15}$/.test(digits)) return { type: 'ewallet', tag: '03', value: digits };
  throw new Error('PROMPTPAY_ID must be a Thai mobile number, a 13 digit national ID, or a 15 digit e-Wallet ID');
}

/** Baht as EMVCo expects it: at most two decimals, no thousands separator. */
export function formatAmount(satang) {
  if (!Number.isInteger(satang) || satang <= 0) throw new Error('Amount must be a positive whole number of satang');
  if (satang > 100000000) throw new Error('Amount is above what the QR supports');
  const baht = Math.floor(satang / 100);
  const remainder = satang % 100;
  return remainder === 0 ? String(baht) : `${baht}.${String(remainder).padStart(2, '0')}`;
}

/**
 * Builds the string that goes inside the QR image.
 * @param {string} promptPayId mobile number, national ID or e-Wallet ID
 * @param {number} satang amount to charge, in satang
 */
export function buildPromptPayPayload(promptPayId, satang) {
  const account = normalisePromptPayId(promptPayId);
  const merchant = tlv('00', PROMPTPAY_AID) + tlv(account.tag, account.value);
  const body =
    tlv(ID_PAYLOAD_FORMAT, '01') +
    tlv(ID_POINT_OF_INITIATION, DYNAMIC) +
    tlv(ID_MERCHANT_PROMPTPAY, merchant) +
    tlv(ID_COUNTRY, COUNTRY_TH) +
    tlv(ID_CURRENCY, CURRENCY_THB) +
    tlv(ID_AMOUNT, formatAmount(satang));
  // The CRC covers the tag and length of field 63 as well, hence the '6304'.
  const withCrcHeader = `${body}${ID_CRC}04`;
  return `${withCrcHeader}${crc16(withCrcHeader)}`;
}

/**
 * Reads a payload back into its fields. Used by the tests and by the admin
 * diagnostics so the QR can be checked without moving real money.
 */
export function parsePromptPayPayload(payload) {
  const fields = {};
  let index = 0;
  while (index < payload.length) {
    const id = payload.slice(index, index + 2);
    const length = Number(payload.slice(index + 2, index + 4));
    if (!/^\d{2}$/.test(id) || !Number.isInteger(length)) throw new Error('Malformed EMVCo payload');
    const value = payload.slice(index + 4, index + 4 + length);
    if (value.length !== length) throw new Error('Malformed EMVCo payload');
    fields[id] = value;
    index += 4 + length;
  }
  const crcOffset = payload.lastIndexOf(`${ID_CRC}04`);
  const expected = crc16(payload.slice(0, crcOffset + 4));
  return { fields, crcValid: crcOffset > 0 && fields[ID_CRC] === expected, expectedCrc: expected };
}

/**
 * Reads the merchant PromptPay ID from the environment. It is the owner's own
 * phone number or national ID, so it never belongs in the repository and is
 * masked wherever it is logged or shown.
 */
export function loadPromptPayId(env = process.env) {
  const raw = env.PROMPTPAY_ID;
  if (!raw) throw new Error('Set PROMPTPAY_ID to the account that receives payments');
  normalisePromptPayId(raw);
  return raw;
}

/** `0812345678` becomes `08X-XXX-5678`: enough to confirm, useless if leaked. */
export function maskPromptPayId(raw) {
  const digits = String(raw ?? '').replace(/[\s()+-]/g, '');
  if (digits.length < 4) return '****';
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}
