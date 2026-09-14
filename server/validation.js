import { z } from 'zod';
export const email = z.string().trim().toLowerCase().email('กรุณากรอกอีเมลให้ถูกต้อง').max(254, 'อีเมลยาวเกินไป');
export const phone = z.string().trim().transform(s => s.replace(/[\s()-]/g, '').replace(/^\+66/, '0'))
  .pipe(z.string().regex(/^0[689]\d{8}$/, 'กรุณากรอกเบอร์มือถือไทย 10 หลัก'));
const dob = z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ใช้รูปแบบ ค.ศ. YYYY-MM-DD')])
  .nullable().refine(s => !s || (s >= '1900-01-01' && s <= new Date().toISOString().slice(0, 10)
    && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s), 'วันเกิดต้องเป็นวันที่จริงและไม่อยู่ในอนาคต')
  .transform(s => s || null);
export const profileFields = {
  name: z.string().trim().min(1, 'กรุณากรอกชื่อ').max(120, 'ชื่อยาวได้ไม่เกิน 120 ตัวอักษร'),
  phone,
  date_of_birth: dob.default(null),
  emergency_contact: z.string().trim().max(200, 'ข้อมูลติดต่อฉุกเฉินยาวได้ไม่เกิน 200 ตัวอักษร').default(''),
};
export const profileSchema = z.object(profileFields).strict();
export const status = z.enum(['active', 'suspended', 'expired'], { error: 'กรุณาเลือกสถานะที่ถูกต้อง' });
export const memberSchema = z.object({ ...profileFields, email, status: status.default('active') }).strict();
/**
 * Editing a member. date_of_birth and emergency_contact are optional *without*
 * a default: a client that omits them leaves the stored values alone. Giving
 * them defaults here silently wiped an emergency contact whenever somebody
 * renamed a member (BUG-03).
 */
export const updateSchema = z.object({
  ...profileFields,
  date_of_birth: dob.optional(),
  emergency_contact: z.string().trim().max(200, 'ข้อมูลติดต่อฉุกเฉินยาวได้ไม่เกิน 200 ตัวอักษร').optional(),
  email,
  status: status.default('active'),
  version: z.number().int().positive(),
}).strict();
export class HttpError extends Error {
  constructor(status, message, fields) { super(message); this.status = status; this.fields = fields; }
}
const THAI = /[฀-๿]/;

/**
 * Thai wording for the validation failures we did not write a message for —
 * a missing field, an unexpected key, a value out of range. Zod's own defaults
 * are English, and the people using this are a gym owner and their staff.
 */
function thaiMessage(issue) {
  const label = issue.path.length ? `"${issue.path.join('.')}"` : 'ข้อมูลที่ส่งมา';
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined
        ? (issue.path.length ? `กรุณากรอกข้อมูลในช่อง ${label}` : 'กรุณากรอกข้อมูลให้ครบ')
        : `รูปแบบข้อมูลของ ${label} ไม่ถูกต้อง`;
    case 'unrecognized_keys':
      return `ไม่รู้จักข้อมูล ${(issue.keys ?? []).map(k => `"${k}"`).join(', ')} กรุณาเปิดแอปใหม่แล้วลองอีกครั้ง`;
    case 'too_big':
      return `ค่าของ ${label} มากเกินกว่าที่ระบบรองรับ (ไม่เกิน ${issue.maximum})`;
    case 'too_small':
      return `ค่าของ ${label} น้อยเกินกว่าที่ระบบรองรับ (อย่างน้อย ${issue.minimum})`;
    default:
      return `รูปแบบข้อมูลของ ${label} ไม่ถูกต้อง`;
  }
}

export function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields = Object.fromEntries(result.error.issues.map(issue => [
      issue.path.join('.') || 'form',
      // Our own messages are already Thai; anything else came from the library.
      THAI.test(String(issue.message)) ? issue.message : thaiMessage(issue),
    ]));
    throw new HttpError(400, 'กรุณาตรวจสอบข้อมูลที่กรอก', fields);
  }
  return result.data;
}

// ------------------------------------------------------- gym profile settings

const optionalText = (max, message) => z.union([z.literal(''), z.string().trim().max(max, message)])
  .nullable().default(null).transform(s => (s ? s : null));
const landline = z.union([z.literal(''), z.string().trim()
  .transform(s => s.replace(/[\s()-]/g, '').replace(/^\+66/, '0'))
  .pipe(z.string().regex(/^0\d{8,9}$/, 'กรุณากรอกเบอร์โทรไทย 9-10 หลัก'))])
  .nullable().default(null).transform(s => (s ? s : null));
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'ใช้รูปแบบเวลา HH:MM');

export const gymSchema = z.object({
  name: z.string().trim().min(1, 'กรุณากรอกชื่อยิม').max(120, 'ชื่อยิมยาวได้ไม่เกิน 120 ตัวอักษร'),
  brand_name_th: z.string().trim().max(120, 'ชื่อภาษาไทยยาวได้ไม่เกิน 120 ตัวอักษร').default(''),
  address: optionalText(300, 'ที่อยู่ยาวได้ไม่เกิน 300 ตัวอักษร'),
  location_note: optionalText(200, 'หมายเหตุสถานที่ยาวได้ไม่เกิน 200 ตัวอักษร'),
  phone_primary: landline,
  phone_secondary: landline,
  phone_display: z.enum(['primary', 'secondary', 'hidden'], { error: 'กรุณาเลือกเบอร์ที่จะแสดงในแอป' }).default('primary'),
  hours_confirmed: z.boolean().default(false),
  hours_note: z.string().trim().max(200, 'หมายเหตุเวลาเปิดยาวได้ไม่เกิน 200 ตัวอักษร').default(''),
  payment_sla_text: z.string().trim().min(1, 'กรุณาระบุข้อความแจ้งเวลายืนยันสลิป').max(200, 'ข้อความยาวได้ไม่เกิน 200 ตัวอักษร').default('ภายใน 30 นาทีในเวลาทำการ'),
  order_ttl_minutes: z.coerce.number().int('ต้องเป็นจำนวนเต็ม').min(5, 'ต้องให้เวลาชำระเงินอย่างน้อย 5 นาที').max(1440, 'ให้เวลาชำระเงินได้ไม่เกิน 24 ชั่วโมง').default(60),
  check_in_window_minutes: z.coerce.number().int('ต้องเป็นจำนวนเต็ม').min(1, 'ต้องอย่างน้อย 1 นาที').max(720, 'ได้ไม่เกิน 12 ชั่วโมง').default(5),
  check_in_token_seconds: z.coerce.number().int('ต้องเป็นจำนวนเต็ม').min(15, 'QR ต้องมีอายุอย่างน้อย 15 วินาที').max(600, 'QR ควรมีอายุไม่เกิน 10 นาที เพื่อไม่ให้แชร์กันได้').default(60),
  version: z.number().int().positive(),
}).strict();

export const hoursSchema = z.object({
  hours: z.array(z.object({
    weekday: z.number().int().min(0).max(6),
    closed: z.boolean().default(false),
    open_time: time.nullable().default(null),
    close_time: time.nullable().default(null),
  }).strict().refine(d => d.closed || (d.open_time && d.close_time && d.open_time < d.close_time),
    'วันที่เปิดทำการต้องมีเวลาเปิดและเวลาปิด และเวลาเปิดต้องก่อนเวลาปิด'))
    .length(7, 'ต้องส่งเวลาเปิดครบทั้ง 7 วัน')
    .refine(list => new Set(list.map(d => d.weekday)).size === 7, 'วันซ้ำกัน กรุณาส่งวันละ 1 รายการ'),
}).strict();

// ------------------------------------------------------------------- packages

// Prices are held in satang so a baht amount can never drift through a float.
// Two ways in, each meaning exactly what its name says: price_satang is the
// stored unit, price_thb is what a person types. Reading price_satang and
// writing it straight back used to multiply the price by 100 (QA P2-BUG-03).
const blank = v => v === '' || v === null || v === undefined;
const satangField = z.union([z.literal(''), z.null(), z.undefined(),
  z.coerce.number().min(0, 'ราคาต้องไม่ติดลบ').max(100000000, 'ราคาสูงเกินกว่าที่ระบบรองรับ')
    .refine(Number.isInteger, 'ราคาหน่วยสตางค์ต้องเป็นจำนวนเต็ม ถ้าต้องการใส่เป็นบาทให้ใช้ price_thb')])
  .transform(v => (blank(v) ? null : v));
const bahtField = z.union([z.literal(''), z.null(), z.undefined(),
  z.coerce.number().min(0, 'ราคาต้องไม่ติดลบ').max(1000000, 'ราคาสูงเกินกว่าที่ระบบรองรับ')
    .refine(n => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9, 'ราคาใส่ทศนิยมได้ไม่เกิน 2 ตำแหน่ง')])
  .transform(v => (blank(v) ? null : Math.round(v * 100)));

export const packageFields = {
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{3,32}$/, 'รหัสแพ็กเกจใช้ A-Z 0-9 และ _ ยาว 3-32 ตัว'),
  name_th: z.string().trim().min(1, 'กรุณากรอกชื่อแพ็กเกจ').max(120, 'ชื่อแพ็กเกจยาวได้ไม่เกิน 120 ตัวอักษร'),
  type: z.enum(['unlimited', 'limited_sessions'], { error: 'กรุณาเลือกประเภทแพ็กเกจ' }),
  duration_days: z.coerce.number().int('จำนวนวันต้องเป็นจำนวนเต็ม')
    .min(1, 'อายุแพ็กเกจต้องอย่างน้อย 1 วัน').max(3650, 'อายุแพ็กเกจยาวได้ไม่เกิน 3,650 วัน'),
  session_limit: z.union([z.literal(''), z.null(), z.undefined(),
    z.coerce.number().int('จำนวนครั้งต้องเป็นจำนวนเต็ม').min(1, 'จำนวนครั้งต้องอย่างน้อย 1')
      .max(1000, 'จำนวนครั้งได้ไม่เกิน 1,000')])
    .transform(v => (v === '' || v === undefined ? null : v)).default(null),
  price_satang: satangField.default(null),
  price_thb: bahtField.default(null),
  description: z.string().trim().max(500, 'คำอธิบายยาวได้ไม่เกิน 500 ตัวอักษร').default(''),
  status: z.enum(['draft', 'active', 'archived'], { error: 'กรุณาเลือกสถานะแพ็กเกจ' }).default('draft'),
  sort_order: z.coerce.number().int().min(0).max(999).default(0),
};
/** Rules that hold whether the package is being created or edited. */
const packageRules = schema => schema
  .refine(p => !(p.price_satang !== null && p.price_thb !== null),
    { message: 'ส่งราคาได้ทางเดียว เลือกระหว่าง price_thb (บาท) หรือ price_satang (สตางค์)', path: ['price_thb'] })
  .transform(p => {
    const { price_thb, ...rest } = p;
    return { ...rest, price_satang: p.price_satang ?? price_thb ?? null };
  })
  .refine(p => (p.type === 'limited_sessions') === (p.session_limit !== null),
    { message: 'แพ็กเกจแบบจำกัดครั้งต้องระบุจำนวนครั้ง ส่วนแบบ unlimited ต้องเว้นว่าง', path: ['session_limit'] })
  .refine(p => p.status !== 'active' || p.price_satang !== null,
    { message: 'ต้องกรอกราคาก่อนจึงจะเปิดขายแพ็กเกจได้', path: ['price_satang'] });

export const packageSchema = packageRules(z.object(packageFields).strict());
export const packageUpdateSchema = packageRules(
  z.object({ ...packageFields, version: z.number().int().positive() }).strict());

// --------------------------------------------------------- orders and slips

// Thailand keeps a fixed UTC+7 offset all year, so a wall-clock time from the
// member's screen maps to one instant without needing a timezone library.
export const BANGKOK_OFFSET = '+07:00';
export const bangkokLocalToEpoch = local => Date.parse(`${local}:00${BANGKOK_OFFSET}`);

export const orderSchema = z.object({ package_id: z.uuid('กรุณาเลือกแพ็กเกจ') }).strict();

/**
 * Fields that travel alongside the slip image. The reference number and the
 * transfer time are what let the system spot the same transfer being reused for
 * a second order, which is the cheapest fraud available without a provider.
 */
export const slipSchema = z.object({
  reference_no: z.string().trim().min(4, 'เลขอ้างอิงสั้นเกินไป').max(40, 'เลขอ้างอิงยาวเกินไป')
    .regex(/^[A-Za-z0-9-]+$/, 'เลขอ้างอิงใช้ตัวเลข ตัวอักษรอังกฤษ และขีดกลางเท่านั้น'),
  transferred_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, 'กรุณาเลือกวันและเวลาที่โอน')
    .refine(value => Number.isFinite(bangkokLocalToEpoch(value)), 'วันและเวลาที่โอนไม่ถูกต้อง'),
  amount_thb: z.union([z.literal(''), z.null(), z.undefined(),
    z.coerce.number().min(0, 'ยอดเงินต้องไม่ติดลบ').max(1000000, 'ยอดเงินสูงเกินกว่าที่ระบบรองรับ')])
    .transform(v => (v === '' || v === null || v === undefined ? null : Math.round(v * 100))).default(null),
}).strict();

/**
 * Approving is the moment money becomes membership, and there is no third party
 * to appeal to afterwards, so the admin has to state they compared the slip with
 * the bank app first.
 */
export const MISMATCH_NOTE_MIN = 10;

export const approveSchema = z.object({
  version: z.coerce.number().int().positive(),
  checked_against_bank: z.literal(true, { error: 'ต้องยืนยันว่าตรวจกับแอปธนาคารแล้วก่อนอนุมัติ' }),
  note: z.string().trim().max(300, 'หมายเหตุยาวได้ไม่เกิน 300 ตัวอักษร').default(''),
}).strict();

/**
 * When the slip does not match the price, the note stops being optional. This
 * is the only moment money becomes membership and there is no provider record
 * to appeal to, so a short payment must never pass without a written reason.
 */
export const approveMismatchSchema = approveSchema.refine(
  input => input.note.length >= MISMATCH_NOTE_MIN,
  { message: `ยอดในสลิปไม่ตรงกับราคา กรุณาระบุเหตุผลอย่างน้อย ${MISMATCH_NOTE_MIN} ตัวอักษรก่อนอนุมัติ`, path: ['note'] });

/**
 * A package that costs nothing has no transfer to check, so the admin is not
 * asked to swear one arrived. Nothing is dropped quietly either: sending
 * checked_against_bank with a free order is refused rather than recorded,
 * because the record would be an attestation about money that never moved.
 */
export const grantSchema = z.object({
  version: z.coerce.number().int().positive(),
  note: z.string().trim().max(300, 'หมายเหตุยาวได้ไม่เกิน 300 ตัวอักษร').default(''),
}).strict();

/**
 * Handing a member a package with no money involved. The note is required
 * rather than optional: a membership nobody paid for is exactly the entry
 * somebody will ask about in six months, and "because the owner said so" is
 * only useful if it is written down at the time.
 */
export const manualGrantSchema = z.object({
  package_id: z.uuid('กรุณาเลือกแพ็กเกจ'),
  note: z.string().trim().min(1, 'กรุณาระบุเหตุผลที่มอบแพ็กเกจนี้').max(300, 'หมายเหตุยาวได้ไม่เกิน 300 ตัวอักษร'),
}).strict();

export const rejectSchema = z.object({
  version: z.coerce.number().int().positive(),
  reason: z.string().trim().min(1, 'กรุณาระบุเหตุผลที่ปฏิเสธ').max(300, 'เหตุผลยาวได้ไม่เกิน 300 ตัวอักษร'),
}).strict();

export const reverseSchema = z.object({
  version: z.coerce.number().int().positive(),
  reason: z.string().trim().min(1, 'กรุณาระบุเหตุผลที่ยกเลิกการอนุมัติ').max(300, 'เหตุผลยาวได้ไม่เกิน 300 ตัวอักษร'),
}).strict();
