import { Badge } from '@/components/ui';
import type {
  AttendanceStatus,
  EmployeeStatus,
  PayrollEmployeeStatus,
  PayrollPeriodStatus,
} from '@/types';

type Tone = 'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'danger' | 'info';

const ATTENDANCE: Record<AttendanceStatus, { label: string; tone: Tone }> = {
  NORMAL: { label: 'ปกติ', tone: 'success' },
  LATE: { label: 'มาสาย', tone: 'warning' },
  OT: { label: 'ทำ OT', tone: 'info' },
  ABSENT: { label: 'ขาดงาน', tone: 'danger' },
  MISSING_DATA: { label: 'ข้อมูลไม่ครบ', tone: 'danger' },
  IN_PROGRESS: { label: 'กำลังทำงาน', tone: 'info' },
  LEAVE: { label: 'ลา', tone: 'secondary' },
  HOLIDAY: { label: 'วันหยุด', tone: 'outline' },
};

const PAYROLL_EMPLOYEE: Record<PayrollEmployeeStatus, { label: string; tone: Tone }> = {
  READY: { label: 'พร้อมจ่าย', tone: 'success' },
  PARTIAL: { label: 'คำนวณบางส่วน', tone: 'warning' },
  UNCONFIGURED: { label: 'ยังไม่ได้กำหนดค่าจ้าง', tone: 'danger' },
  ATTENDANCE_INCOMPLETE: { label: 'ข้อมูลเวลาไม่ครบ', tone: 'danger' },
  // Legacy values, still carried by rows calculated before readiness became
  // per-employee. Labelled as their successors so one period never shows two
  // different words for the same situation.
  NEEDS_REVIEW: { label: 'ต้องตรวจสอบ', tone: 'warning' },
  MISSING_DATA: { label: 'ข้อมูลเวลาไม่ครบ', tone: 'danger' },
  EXCLUDED: { label: 'ยกเว้น', tone: 'outline' },
};

/** Groups the payroll readiness screen sorts employees into. */
export const PAYROLL_STATUS_GROUPS: {
  key: PayrollEmployeeStatus[];
  label: string;
  tone: Tone;
  hint: string;
}[] = [
  {
    key: ['READY'],
    label: 'พร้อมคำนวณ',
    tone: 'success',
    hint: 'ข้อมูลครบ คำนวณเป็นยอดสุทธิได้ทันที',
  },
  {
    key: ['PARTIAL', 'NEEDS_REVIEW'],
    label: 'คำนวณได้บางส่วน',
    tone: 'warning',
    hint: 'คำนวณจากข้อมูลที่ทราบได้ แต่ยังไม่ใช่ยอดสุดท้าย',
  },
  {
    key: ['UNCONFIGURED'],
    label: 'ยังไม่ได้กำหนดค่าจ้าง',
    tone: 'danger',
    hint: 'ระบบจะแสดงเวลาทำงานจริง แต่จะไม่สร้างตัวเลขค่าจ้างขึ้นเอง',
  },
  {
    key: ['ATTENDANCE_INCOMPLETE', 'MISSING_DATA'],
    label: 'ข้อมูลเวลาไม่ครบ',
    tone: 'danger',
    hint: 'มีวันที่ผ่านมาแล้วซึ่งขาดเวลาเข้าหรือเวลาออก ต้องแก้ไขก่อนจึงจะได้ยอดสุดท้าย',
  },
  {
    key: ['EXCLUDED'],
    label: 'ถูกยกเว้น',
    tone: 'outline',
    hint: 'ไม่อยู่ในการคำนวณเงินเดือนตามนโยบายบริษัท',
  },
];

export const LATE_DEDUCTION_LABELS: Record<string, string> = {
  NONE: 'ไม่หัก',
  PER_HOUR_FROM_BASE: 'หักตามฐานเงินเดือนต่อชั่วโมง',
  FIXED_AMOUNT: 'กำหนดจำนวนเงินเอง',
};

export const LEAVE_DEDUCTION_LABELS: Record<string, string> = {
  NONE: 'ไม่หัก',
  PER_DAY_FROM_BASE: 'หักตามฐานเงินเดือนต่อวัน',
  FIXED_AMOUNT: 'กำหนดจำนวนเงินเอง',
};

export const ABSENCE_DEDUCTION_LABELS: Record<string, string> = {
  NONE: 'ไม่หัก',
  PER_DAY_FROM_BASE: 'หักตามฐานเงินเดือนต่อวัน',
  FIXED_AMOUNT: 'กำหนดจำนวนเงินเอง',
};

export const PERIOD_STATUS: Record<PayrollPeriodStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'ฉบับร่าง', tone: 'outline' },
  ATTENDANCE_REVIEW: { label: 'ตรวจสอบเวลาทำงาน', tone: 'info' },
  CALCULATED: { label: 'คำนวณแล้ว', tone: 'info' },
  REVIEW: { label: 'รอตรวจสอบ', tone: 'warning' },
  APPROVED: { label: 'อนุมัติแล้ว', tone: 'success' },
  PAID: { label: 'จ่ายแล้ว', tone: 'success' },
  LOCKED: { label: 'ล็อกแล้ว', tone: 'secondary' },
};

export const EMPLOYEE: Record<EmployeeStatus, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'ทำงานอยู่', tone: 'success' },
  PROBATION: { label: 'ทดลองงาน', tone: 'info' },
  INACTIVE: { label: 'ไม่ทำงานแล้ว', tone: 'secondary' },
  TERMINATED: { label: 'พ้นสภาพ', tone: 'danger' },
};

/** Employment status in Thai, for places that need the word rather than a badge. */
export const EMPLOYEE_STATUS_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(EMPLOYEE).map(([key, value]) => [key, value.label])
);

export const EMPLOYMENT_TYPE_LABELS: Record<string, string> = {
  MONTHLY: 'รายเดือน',
  DAILY: 'รายวัน',
  HOURLY: 'รายชั่วโมง',
  CONTRACT: 'สัญญาจ้าง',
};

export const LEAVE_TYPE_LABELS: Record<string, string> = {
  ANNUAL: 'ลาพักร้อน',
  SICK: 'ลาป่วย',
  PERSONAL: 'ลากิจ',
  MATERNITY: 'ลาคลอด',
  UNPAID: 'ลาไม่รับค่าจ้าง',
  OTHER: 'อื่น ๆ',
};

export const AttendanceStatusBadge = ({ status }: { status: AttendanceStatus }) => {
  const s = ATTENDANCE[status] ?? { label: status, tone: 'secondary' as Tone };
  return <Badge variant={s.tone}>{s.label}</Badge>;
};

export const PayrollEmployeeStatusBadge = ({ status }: { status: PayrollEmployeeStatus }) => {
  const s = PAYROLL_EMPLOYEE[status] ?? { label: status, tone: 'secondary' as Tone };
  return <Badge variant={s.tone}>{s.label}</Badge>;
};

export const PeriodStatusBadge = ({ status }: { status: PayrollPeriodStatus }) => {
  const s = PERIOD_STATUS[status] ?? { label: status, tone: 'secondary' as Tone };
  return <Badge variant={s.tone}>{s.label}</Badge>;
};

export const EmployeeStatusBadge = ({ status }: { status: EmployeeStatus }) => {
  const s = EMPLOYEE[status] ?? { label: status, tone: 'secondary' as Tone };
  return <Badge variant={s.tone}>{s.label}</Badge>;
};
