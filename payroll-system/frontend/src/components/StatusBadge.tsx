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
  LEAVE: { label: 'ลา', tone: 'secondary' },
  HOLIDAY: { label: 'วันหยุด', tone: 'outline' },
};

const PAYROLL_EMPLOYEE: Record<PayrollEmployeeStatus, { label: string; tone: Tone }> = {
  READY: { label: 'พร้อมจ่าย', tone: 'success' },
  NEEDS_REVIEW: { label: 'ต้องตรวจสอบ', tone: 'warning' },
  MISSING_DATA: { label: 'ข้อมูลไม่ครบ', tone: 'danger' },
  EXCLUDED: { label: 'ไม่รวมในรอบนี้', tone: 'outline' },
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

const EMPLOYEE: Record<EmployeeStatus, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'ทำงานอยู่', tone: 'success' },
  PROBATION: { label: 'ทดลองงาน', tone: 'info' },
  INACTIVE: { label: 'ไม่ทำงานแล้ว', tone: 'secondary' },
  TERMINATED: { label: 'พ้นสภาพ', tone: 'danger' },
};

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
