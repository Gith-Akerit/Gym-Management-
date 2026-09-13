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
export const updateSchema = memberSchema.extend({ version: z.number().int().positive() });
export class HttpError extends Error {
  constructor(status, message, fields) { super(message); this.status = status; this.fields = fields; }
}
export function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields = Object.fromEntries(result.error.issues.map(i => [i.path.join('.') || 'form', i.message]));
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
const price = z.union([z.literal(''), z.null(), z.undefined(),
  z.coerce.number().min(0, 'ราคาต้องไม่ติดลบ').max(1000000, 'ราคาสูงเกินกว่าที่ระบบรองรับ')
    .refine(n => Number.isInteger(Math.round(n * 100)) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-9,
      'ราคาใส่ทศนิยมได้ไม่เกิน 2 ตำแหน่ง')])
  .transform(v => (v === '' || v === null || v === undefined ? null : Math.round(v * 100)));

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
  price_satang: price.default(null),
  description: z.string().trim().max(500, 'คำอธิบายยาวได้ไม่เกิน 500 ตัวอักษร').default(''),
  status: z.enum(['draft', 'active', 'archived'], { error: 'กรุณาเลือกสถานะแพ็กเกจ' }).default('draft'),
  sort_order: z.coerce.number().int().min(0).max(999).default(0),
};
/** Rules that hold whether the package is being created or edited. */
const packageRules = schema => schema
  .refine(p => (p.type === 'limited_sessions') === (p.session_limit !== null),
    { message: 'แพ็กเกจแบบจำกัดครั้งต้องระบุจำนวนครั้ง ส่วนแบบ unlimited ต้องเว้นว่าง', path: ['session_limit'] })
  .refine(p => p.status !== 'active' || p.price_satang !== null,
    { message: 'ต้องกรอกราคาก่อนจึงจะเปิดขายแพ็กเกจได้', path: ['price_satang'] });

export const packageSchema = packageRules(z.object(packageFields).strict());
export const packageUpdateSchema = packageRules(
  z.object({ ...packageFields, version: z.number().int().positive() }).strict());
