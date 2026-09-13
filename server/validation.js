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
