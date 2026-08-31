import { SettingValueType } from '@prisma/client';

export interface SettingDefinition {
  key: string;
  value: string;
  valueType: SettingValueType;
  group: string;
  label: string;
  description?: string;
}

/**
 * Every payroll rule the engine reads lives here as a seedable default.
 * Nothing in payroll-calculator.service.ts hardcodes a rate or a threshold -
 * it resolves each value through PayrollSettings, so a business-rule change is
 * a settings edit, not a code change.
 *
 * The Thai statutory defaults (5% SSO capped at 750 THB/month, the 2024
 * progressive personal income tax ladder, 50% expense allowance capped at
 * 100,000 THB and the 60,000 THB personal allowance) are provided as starting
 * values and are editable in Settings.
 */
export const DEFAULT_PAYROLL_SETTINGS: SettingDefinition[] = [
  // --- Working time ---
  // The company policy is a fixed 08:30-17:30 day for monthly staff. These two
  // keys are the authority; the legacy WORK_START_TIME / WORK_END_TIME pair is
  // kept only as a fallback for installations that have not been migrated.
  {
    key: 'MONTHLY_WORK_START_TIME',
    value: '08:30',
    valueType: SettingValueType.TIME,
    group: 'ATTENDANCE',
    label: 'เวลาเริ่มงานพนักงานรายเดือน',
    description: 'เข้างานหลังเวลานี้ถือว่ามาสาย นับนาทีสายจากเวลานี้',
  },
  {
    key: 'MONTHLY_WORK_END_TIME',
    value: '17:30',
    valueType: SettingValueType.TIME,
    group: 'ATTENDANCE',
    label: 'เวลาเลิกงานพนักงานรายเดือน',
    description: 'เวลาเลิกงานคงที่ ไม่เลื่อนตามเวลาที่เข้างาน',
  },
  {
    key: 'MONTHLY_FLEX_ARRIVAL_MINUTES',
    value: '0',
    valueType: SettingValueType.NUMBER,
    group: 'ATTENDANCE',
    label: 'ช่วงเข้างานยืดหยุ่น (นาที) — ยกเลิกแล้ว',
    description:
      'นโยบายปัจจุบันไม่มีช่วงเข้างานยืดหยุ่น ค่านี้ต้องเป็น 0 เก็บไว้เพื่อความเข้ากันได้ย้อนหลังเท่านั้น',
  },
  {
    key: 'WORK_START_TIME',
    value: '08:30',
    valueType: SettingValueType.TIME,
    group: 'ATTENDANCE',
    label: 'เวลาเริ่มงาน (ค่าสำรอง)',
    description: 'ใช้เมื่อยังไม่ได้ตั้งค่า MONTHLY_WORK_START_TIME',
  },
  {
    key: 'WORK_END_TIME',
    value: '17:30',
    valueType: SettingValueType.TIME,
    group: 'ATTENDANCE',
    label: 'เวลาเลิกงาน (ค่าสำรอง)',
    description: 'ใช้เมื่อยังไม่ได้ตั้งค่า MONTHLY_WORK_END_TIME',
  },
  {
    key: 'BREAK_MINUTES',
    value: '60',
    valueType: SettingValueType.NUMBER,
    group: 'ATTENDANCE',
    label: 'เวลาพักกลางวัน (นาที)',
    description: 'Unpaid break deducted from the worked duration.',
  },
  {
    key: 'LATE_GRACE_MINUTES',
    value: '0',
    valueType: SettingValueType.NUMBER,
    group: 'ATTENDANCE',
    label: 'ผ่อนผันการมาสาย (นาที)',
    description:
      'นโยบายปัจจุบันไม่ผ่อนผัน เข้างานหลังเวลาเริ่มงานแม้ 1 นาทีถือว่าสาย ค่านี้ต้องเป็น 0',
  },
  {
    key: 'DAILY_DEDUCT_BREAK',
    value: 'false',
    valueType: SettingValueType.BOOLEAN,
    group: 'ATTENDANCE',
    label: 'หักเวลาพักจากพนักงานรายวัน',
    description: 'ปิดไว้เพื่อคิดเวลารายวันตามเวลาเข้า-ออกจริงโดยไม่หักพักอัตโนมัติ',
  },
  {
    key: 'DAILY_OT_ENABLED',
    value: 'false',
    valueType: SettingValueType.BOOLEAN,
    group: 'OT',
    label: 'คำนวณ OT พนักงานรายวัน',
    description: 'ปิดไว้จนกว่าบริษัทจะกำหนดกฎ OT สำหรับพนักงานรายวันอย่างชัดเจน',
  },
  {
    key: 'MONTHLY_OT_ENABLED',
    value: 'false',
    valueType: SettingValueType.BOOLEAN,
    group: 'OT',
    label: 'คำนวณ OT พนักงานรายเดือน',
    description: 'ปิดไว้จนกว่าบริษัทจะกำหนดหรืออนุมัติกฎ OT รายเดือนอย่างชัดเจน',
  },
  {
    key: 'OT_REQUIRES_APPROVAL',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    group: 'OT',
    label: 'OT ต้องได้รับอนุมัติก่อนจ่าย — ยังไม่เปิดใช้งาน',
    description:
      'เวลาที่อยู่เกินเวลาเลิกงานเป็นเพียงเวลาที่สังเกตได้ ต้องอนุมัติก่อนจึงจะกลายเป็น OT ที่จ่ายเงิน',
  },
  // Deliberately blank. The company has not stated its monetary OT multiplier,
  // and guessing one would put an invented number on a payslip. The pre-payroll
  // check raises MISSING_OT_RATE while approved OT exists and this is unset.
  {
    key: 'MONTHLY_OT_MULTIPLIER',
    value: '',
    valueType: SettingValueType.DECIMAL,
    group: 'OT',
    label: 'ตัวคูณ OT พนักงานรายเดือน',
    description: 'ยังไม่กำหนด ต้องตั้งค่าก่อนจึงจะคำนวณเงิน OT ของพนักงานรายเดือนได้',
  },
  {
    key: 'DAILY_OT_MULTIPLIER',
    value: '',
    valueType: SettingValueType.DECIMAL,
    group: 'OT',
    label: 'ตัวคูณ OT พนักงานรายวัน',
    description: 'ยังไม่กำหนด ต้องตั้งค่าก่อนจึงจะคำนวณเงิน OT ของพนักงานรายวันได้',
  },
  {
    key: 'HOURLY_OT_MULTIPLIER',
    value: '',
    valueType: SettingValueType.DECIMAL,
    group: 'OT',
    label: 'ตัวคูณ OT พนักงานรายชั่วโมง',
    description: 'ยังไม่กำหนด ต้องตั้งค่าก่อนจึงจะคำนวณเงิน OT ของพนักงานรายชั่วโมงได้',
  },
  {
    key: 'STANDARD_WORK_HOURS',
    value: '8',
    valueType: SettingValueType.DECIMAL,
    group: 'ATTENDANCE',
    label: 'ชั่วโมงทำงานมาตรฐานต่อวัน',
  },
  {
    key: 'STANDARD_WORK_DAYS',
    value: '22',
    valueType: SettingValueType.NUMBER,
    group: 'ATTENDANCE',
    label: 'จำนวนวันทำงานมาตรฐานต่อเดือน',
    description: 'Divisor for converting a monthly salary into a daily rate.',
  },
  {
    key: 'MIN_OT_MINUTES',
    value: '30',
    valueType: SettingValueType.NUMBER,
    group: 'OT',
    label: 'เวลาขั้นต่ำที่นับเป็น OT (นาที)',
    description: 'Overtime shorter than this is ignored.',
  },
  {
    key: 'EARLY_LEAVE_GRACE_MINUTES',
    value: '0',
    valueType: SettingValueType.NUMBER,
    group: 'ATTENDANCE',
    label: 'ผ่อนผันการออกก่อนเวลา (นาที)',
  },
  {
    key: 'COUNT_WEEKEND_AS_WORKDAY',
    value: 'false',
    valueType: SettingValueType.BOOLEAN,
    group: 'ATTENDANCE',
    label: 'นับวันเสาร์-อาทิตย์เป็นวันทำงาน — ยกเลิกแล้ว',
    description:
      'ไม่มีผลกับการคำนวณอีกต่อไป ใช้ "วันทำงาน" (WORKING_DAYS) เป็นตัวกำหนดเพียงอย่างเดียว เก็บไว้เพื่อความเข้ากันได้ย้อนหลัง',
  },
  {
    key: 'WORKING_DAYS',
    value: 'MON,TUE,WED,THU,FRI,SAT',
    valueType: SettingValueType.STRING,
    group: 'ATTENDANCE',
    label: 'วันทำงานประจำสัปดาห์',
    description: 'วันทำงานที่ใช้ร่วมกันในปฏิทิน การลงเวลา และรอบเงินเดือน',
  },

  // --- OT ---
  {
    key: 'OT_RATE_WEEKDAY',
    value: '1.5',
    valueType: SettingValueType.DECIMAL,
    group: 'OT',
    label: 'อัตรา OT วันธรรมดา (เท่า)',
  },
  {
    key: 'OT_RATE_WEEKEND',
    value: '2',
    valueType: SettingValueType.DECIMAL,
    group: 'OT',
    label: 'อัตรา OT วันหยุดสุดสัปดาห์ (เท่า)',
  },
  {
    key: 'OT_RATE_HOLIDAY',
    value: '3',
    valueType: SettingValueType.DECIMAL,
    group: 'OT',
    label: 'อัตรา OT วันหยุดนักขัตฤกษ์ (เท่า)',
  },
  {
    key: 'OT_ENABLED',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    group: 'OT',
    label: 'เปิดใช้งานการคำนวณ OT',
  },

  // --- Deductions ---
  {
    key: 'LATE_DEDUCTION_MODE',
    value: 'PER_MINUTE',
    valueType: SettingValueType.STRING,
    group: 'DEDUCTION',
    label: 'รูปแบบการหักมาสาย',
    description: 'NONE | PER_MINUTE | PER_OCCURRENCE',
  },
  {
    key: 'LATE_DEDUCTION_AMOUNT',
    value: '0',
    valueType: SettingValueType.DECIMAL,
    group: 'DEDUCTION',
    label: 'จำนวนเงินหักต่อหน่วย (บาท)',
    description:
      'Fixed amount per late minute or per late occurrence. Leave at 0 to derive the deduction from the hourly rate instead.',
  },
  {
    key: 'LATE_DEDUCTION_USE_HOURLY_RATE',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    group: 'DEDUCTION',
    label: 'หักมาสายตามอัตราค่าจ้างรายชั่วโมง',
  },
  {
    key: 'ABSENCE_DEDUCTION_MODE',
    value: 'DAILY_RATE',
    valueType: SettingValueType.STRING,
    group: 'DEDUCTION',
    label: 'รูปแบบการหักขาดงาน',
    description: 'NONE | DAILY_RATE | FIXED',
  },
  {
    key: 'ABSENCE_DEDUCTION_AMOUNT',
    value: '0',
    valueType: SettingValueType.DECIMAL,
    group: 'DEDUCTION',
    label: 'จำนวนเงินหักขาดงานแบบคงที่ (บาท/วัน)',
  },
  // The company converts a monthly salary to a day and an hour with fixed
  // divisors, never with the calendar length of the month or the number of
  // scheduled working days - those would make the same absence cost a
  // different amount in February than in March.
  {
    key: 'MONTHLY_SALARY_DAY_DIVISOR',
    value: '30',
    valueType: SettingValueType.NUMBER,
    group: 'DEDUCTION',
    label: 'ตัวหารเงินเดือนเป็นรายวัน (วัน)',
    description: 'เงินเดือน ÷ ค่านี้ = ค่าจ้างต่อวัน ใช้กับการหักขาดงานและหักมาสาย',
  },
  {
    key: 'STANDARD_PAID_HOURS_PER_DAY',
    value: '8',
    valueType: SettingValueType.NUMBER,
    group: 'DEDUCTION',
    label: 'ชั่วโมงทำงานมาตรฐานต่อวัน (ชั่วโมง)',
    description: 'ค่าจ้างต่อวัน ÷ ค่านี้ = ค่าจ้างต่อชั่วโมง ใช้คำนวณการหักมาสาย',
  },
  {
    key: 'LATE_DEDUCTION_ROUND_UP_HOURS',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    group: 'DEDUCTION',
    label: 'ปัดการหักมาสายขึ้นเป็นช่วงละ 1 ชั่วโมง',
    description: 'สายกี่นาทีก็ตามในชั่วโมงแรกหัก 1 ชั่วโมง (ceil(นาทีสาย ÷ 60))',
  },

  // --- Social security ---
  {
    key: 'SSO_ENABLED',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    group: 'SOCIAL_SECURITY',
    label: 'เปิดใช้งานประกันสังคม',
  },
  {
    key: 'SSO_RATE',
    value: '0.05',
    valueType: SettingValueType.DECIMAL,
    group: 'SOCIAL_SECURITY',
    label: 'อัตราประกันสังคม',
  },
  {
    key: 'SSO_MIN_BASE',
    value: '1650',
    valueType: SettingValueType.DECIMAL,
    group: 'SOCIAL_SECURITY',
    label: 'ฐานค่าจ้างขั้นต่ำ (บาท)',
  },
  {
    key: 'SSO_MAX_BASE',
    value: '15000',
    valueType: SettingValueType.DECIMAL,
    group: 'SOCIAL_SECURITY',
    label: 'ฐานค่าจ้างสูงสุด (บาท)',
  },
  {
    key: 'SSO_MAX_CONTRIBUTION',
    value: '750',
    valueType: SettingValueType.DECIMAL,
    group: 'SOCIAL_SECURITY',
    label: 'เงินสมทบสูงสุดต่อเดือน (บาท)',
  },

  // --- Tax ---
  {
    key: 'TAX_ENABLED',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    group: 'TAX',
    label: 'เปิดใช้งานการคำนวณภาษี',
  },
  {
    key: 'TAX_PERSONAL_ALLOWANCE',
    value: '60000',
    valueType: SettingValueType.DECIMAL,
    group: 'TAX',
    label: 'ค่าลดหย่อนส่วนตัวต่อปี (บาท)',
  },
  {
    key: 'TAX_EXPENSE_RATE',
    value: '0.5',
    valueType: SettingValueType.DECIMAL,
    group: 'TAX',
    label: 'อัตราหักค่าใช้จ่าย',
  },
  {
    key: 'TAX_EXPENSE_CAP',
    value: '100000',
    valueType: SettingValueType.DECIMAL,
    group: 'TAX',
    label: 'เพดานหักค่าใช้จ่ายต่อปี (บาท)',
  },
  {
    key: 'TAX_BRACKETS',
    value: JSON.stringify([
      { upTo: 150000, rate: 0 },
      { upTo: 300000, rate: 0.05 },
      { upTo: 500000, rate: 0.1 },
      { upTo: 750000, rate: 0.15 },
      { upTo: 1000000, rate: 0.2 },
      { upTo: 2000000, rate: 0.25 },
      { upTo: 5000000, rate: 0.3 },
      { upTo: null, rate: 0.35 },
    ]),
    valueType: SettingValueType.JSON,
    group: 'TAX',
    label: 'ขั้นบันไดภาษีเงินได้บุคคลธรรมดา',
    description: 'Progressive brackets. upTo=null marks the final open-ended bracket.',
  },

  // --- Payroll behaviour ---
  {
    key: 'PAYROLL_CYCLE_START_DAY',
    value: '26',
    valueType: SettingValueType.NUMBER,
    group: 'PAYROLL',
    label: 'วันเริ่มรอบเงินเดือน (วันที่ของเดือนก่อนหน้า)',
    description:
      'Day of the PREVIOUS month the cycle opens on. With 26/25 a September period runs 26 Aug to 25 Sep. Set to 1 for a plain calendar month.',
  },
  {
    key: 'PAYROLL_CYCLE_END_DAY',
    value: '25',
    valueType: SettingValueType.NUMBER,
    group: 'PAYROLL',
    label: 'วันสิ้นสุดรอบเงินเดือน (วันที่ของเดือนนั้น)',
    description:
      'Day of the period month the cycle closes on. Use 31 (or 0) for the last day of the month.',
  },
  {
    key: 'PAYROLL_PAYMENT_DAY',
    value: '28',
    valueType: SettingValueType.NUMBER,
    group: 'PAYROLL',
    label: 'วันจ่ายเงินเดือนของเดือน',
  },
  {
    key: 'PRORATE_NEW_HIRES',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    group: 'PAYROLL',
    label: 'คำนวณเงินเดือนตามสัดส่วนสำหรับพนักงานเข้าใหม่',
  },
  {
    key: 'BLOCK_APPROVE_ON_MISSING_DATA',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    group: 'PAYROLL',
    label: 'ห้ามอนุมัติเมื่อยังมีข้อมูลไม่ครบ',
  },
  {
    key: 'ATTENDANCE_CLOSE_GRACE_MINUTES',
    value: '0',
    valueType: SettingValueType.NUMBER,
    group: 'ATTENDANCE',
    label: 'เวลาผ่อนผันหลังเลิกงานก่อนถือว่าข้อมูลไม่ครบ (นาที)',
    description: 'ใช้เฉพาะการจำแนก check-out ที่ยังไม่มาในวันปัจจุบัน ค่าเริ่มต้น 0 นาที',
  },
  {
    key: 'PAYSLIP_PREFIX',
    value: 'PS',
    valueType: SettingValueType.STRING,
    group: 'PAYROLL',
    label: 'คำนำหน้าเลขที่สลิปเงินเดือน',
  },

  // --- Google Sheets ---
  {
    key: 'GOOGLE_SYNC_ENABLED',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    group: 'GOOGLE_SHEETS',
    label: 'อัปเดตข้อมูล Google Sheets อัตโนมัติ',
    description: 'ดึงข้อมูลเข้า-ออกงาน พนักงาน และการลา เป็นรอบโดยอัตโนมัติ (อ่านอย่างเดียว)',
  },
  {
    key: 'GOOGLE_SYNC_INTERVAL_SECONDS',
    value: '60',
    valueType: SettingValueType.NUMBER,
    group: 'GOOGLE_SHEETS',
    label: 'รอบการอัปเดต (วินาที)',
    description: 'ขั้นต่ำ 30 วินาที ค่าที่ต่ำกว่านี้จะถูกปรับขึ้นเป็น 30 อัตโนมัติ · ค่าเริ่มต้น 60',
  },
  {
    key: 'SHEET_AUTO_CREATE_EMPLOYEE',
    value: 'false',
    valueType: SettingValueType.BOOLEAN,
    group: 'GOOGLE_SHEETS',
    label: 'สร้างพนักงานอัตโนมัติเมื่อพบรหัสใหม่ — ยังไม่เปิดใช้งาน',
    description:
      'ยังไม่มีผลกับการซิงก์ ขณะนี้รหัสพนักงานที่ไม่รู้จักจะถูกรายงานเป็นข้อผิดพลาดเสมอ ไม่มีการสร้างพนักงานอัตโนมัติ',
  },
  {
    key: 'SHEET_OVERWRITE_CORRECTED',
    value: 'false',
    valueType: SettingValueType.BOOLEAN,
    group: 'GOOGLE_SHEETS',
    label: 'อนุญาตให้การซิงค์ทับข้อมูลที่แก้ไขด้วยมือ',
    description: 'Keep false so manual corrections are never silently overwritten.',
  },
];

export const DEFAULT_SETTINGS_MAP: Record<string, string> = Object.fromEntries(
  DEFAULT_PAYROLL_SETTINGS.map((s) => [s.key, s.value])
);
