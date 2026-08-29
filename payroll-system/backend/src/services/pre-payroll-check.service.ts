import { prisma } from '../plugins/prisma.js';
import { loadSettings } from './settings.service.js';
import { dec } from '../utils/money.js';
import { dayjs, eachDay, isWeekend } from '../utils/datetime.js';
import { notFound } from '../utils/errors.js';

/**
 * Pre-payroll validation.
 *
 * Runs before Calculate and answers one question: is it safe to compute payroll
 * for this period? Findings are graded, and a BLOCKING finding stops the
 * calculation rather than producing numbers nobody should trust.
 */

export type CheckSeverity = 'BLOCKING' | 'WARNING' | 'INFO';

export interface CheckFinding {
  code: string;
  severity: CheckSeverity;
  title: string;
  detail: string;
  count: number;
  /** A short sample, so the UI can show who is affected without a second call. */
  samples: string[];
}

export interface PrePayrollReport {
  periodId: string;
  periodCode: string;
  periodName: string;
  startDate: string;
  endDate: string;
  canCalculate: boolean;
  blocking: number;
  warning: number;
  info: number;
  findings: CheckFinding[];
}

const SAMPLE_LIMIT = 10;

export async function runPrePayrollChecks(periodId: string): Promise<PrePayrollReport> {
  const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw notFound('Payroll period');

  const settings = await loadSettings();
  const findings: CheckFinding[] = [];

  const add = (f: Omit<CheckFinding, 'samples'> & { samples?: string[] }) => {
    if (f.count > 0) findings.push({ ...f, samples: (f.samples ?? []).slice(0, SAMPLE_LIMIT) });
  };

  // Employees who should appear on this payroll.
  const employees = await prisma.employee.findMany({
    where: {
      status: { in: ['ACTIVE', 'PROBATION'] },
      startDate: { lte: period.endDate },
      OR: [{ endDate: null }, { endDate: { gte: period.startDate } }],
    },
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      baseSalary: true,
      employmentType: true,
    },
  });
  const label = (e: { employeeCode: string; firstName: string; lastName: string }) =>
    `${e.employeeCode} ${e.firstName} ${e.lastName}`;

  // --- 1. employees with no attendance at all in the window ------------------
  const attendanceByEmployee = await prisma.attendanceRecord.groupBy({
    by: ['employeeId'],
    where: { workDate: { gte: period.startDate, lte: period.endDate } },
    _count: { _all: true },
  });
  const withAttendance = new Set(attendanceByEmployee.map((a) => a.employeeId));
  const noAttendance = employees.filter((e) => !withAttendance.has(e.id));

  add({
    code: 'NO_ATTENDANCE',
    severity: 'BLOCKING',
    title: 'พนักงานที่ไม่มีข้อมูลการลงเวลาเลยในรอบนี้',
    detail:
      'ระบบจะไม่คำนวณเงินเดือนเต็มจำนวนให้โดยอัตโนมัติ กรุณานำเข้าข้อมูลลงเวลา หรือเปลี่ยนสถานะพนักงานหากไม่ได้ทำงานในรอบนี้',
    count: noAttendance.length,
    samples: noAttendance.map(label),
  });

  // --- 2. incomplete punches -------------------------------------------------
  const missingPunch = await prisma.attendanceRecord.findMany({
    where: { workDate: { gte: period.startDate, lte: period.endDate }, status: 'MISSING_DATA' },
    select: { employeeCode: true, workDate: true },
    orderBy: [{ employeeCode: 'asc' }, { workDate: 'asc' }],
  });

  add({
    code: 'MISSING_PUNCH',
    severity: 'BLOCKING',
    title: 'วันที่มีข้อมูลเข้า-ออกไม่ครบ',
    detail: 'ต้องแก้ไขให้ครบก่อนคำนวณ มิฉะนั้นชั่วโมงทำงานจะต่ำกว่าความเป็นจริง',
    count: missingPunch.length,
    samples: missingPunch.map(
      (r) => `${r.employeeCode} — ${dayjs.utc(r.workDate).format('YYYY-MM-DD')}`
    ),
  });

  // --- 3. unknown employees from the most recent sync ------------------------
  const lastSync = await prisma.googleSheetSync.findFirst({
    orderBy: { startedAt: 'desc' },
    select: { errors: true, startedAt: true },
  });
  const syncErrors = (lastSync?.errors as { message?: string; employeeCode?: string }[] | null) ?? [];
  const unknownFromSync = syncErrors.filter((e) => e.message?.includes('Unknown employee_code'));

  add({
    code: 'UNKNOWN_EMPLOYEE_SYNC',
    severity: 'WARNING',
    title: 'รหัสพนักงานจากการซิงค์ล่าสุดที่ไม่รู้จัก',
    detail:
      'แถวเหล่านี้ไม่ถูกนำเข้า หากเป็นพนักงานจริงให้เพิ่มข้อมูลพนักงานแล้วซิงค์ใหม่ก่อนคำนวณ',
    count: unknownFromSync.length,
    samples: [...new Set(unknownFromSync.map((e) => e.employeeCode ?? '-'))],
  });

  // --- 4. overlapping payroll periods ---------------------------------------
  const overlapping = await prisma.payrollPeriod.findMany({
    where: {
      id: { not: period.id },
      startDate: { lte: period.endDate },
      endDate: { gte: period.startDate },
    },
    select: { name: true, code: true, startDate: true, endDate: true },
  });

  add({
    code: 'OVERLAPPING_PERIOD',
    severity: 'BLOCKING',
    title: 'ช่วงวันที่ทับซ้อนกับรอบเงินเดือนอื่น',
    detail: 'การทับซ้อนทำให้ข้อมูลลงเวลาถูกนับซ้ำในสองรอบ',
    count: overlapping.length,
    samples: overlapping.map(
      (p) =>
        `${p.name} (${dayjs.utc(p.startDate).format('YYYY-MM-DD')} ถึง ${dayjs.utc(p.endDate).format('YYYY-MM-DD')})`
    ),
  });

  // --- 5. salary configuration ----------------------------------------------
  const noSalary = employees.filter((e) => dec(e.baseSalary).lessThanOrEqualTo(0));
  add({
    code: 'MISSING_SALARY',
    severity: 'BLOCKING',
    title: 'พนักงานที่ยังไม่ได้กำหนดค่าจ้าง',
    detail: 'ค่าจ้างพื้นฐานเป็น 0 หรือไม่ได้ตั้งค่า จะทำให้คำนวณเงินเดือนไม่ถูกต้อง',
    count: noSalary.length,
    samples: noSalary.map(label),
  });

  const negativeSalary = employees.filter((e) => dec(e.baseSalary).isNegative());
  add({
    code: 'INVALID_SALARY',
    severity: 'BLOCKING',
    title: 'ค่าจ้างติดลบ',
    detail: 'ค่าจ้างพื้นฐานติดลบเป็นข้อมูลที่ผิดพลาด',
    count: negativeSalary.length,
    samples: negativeSalary.map(label),
  });

  // --- 6. payroll settings sanity -------------------------------------------
  const requiredSettings = [
    'STANDARD_WORK_DAYS',
    'STANDARD_WORK_HOURS',
    'WORK_START_TIME',
    'WORK_END_TIME',
    'OT_RATE_WEEKDAY',
  ];
  const badSettings = requiredSettings.filter((key) => {
    const raw = settings.string(key);
    if (!raw) return true;
    // The two divisors must be non-zero or every derived rate collapses to 0.
    if (key === 'STANDARD_WORK_DAYS' || key === 'STANDARD_WORK_HOURS') {
      return settings.decimal(key).lessThanOrEqualTo(0);
    }
    return false;
  });

  add({
    code: 'INVALID_SETTINGS',
    severity: 'BLOCKING',
    title: 'การตั้งค่าเงินเดือนไม่ถูกต้อง',
    detail: 'ค่าที่จำเป็นต่อการคำนวณว่างหรือเป็นศูนย์ กรุณาตรวจสอบที่หน้า ตั้งค่า → กฎการคำนวณ',
    count: badSettings.length,
    samples: badSettings,
  });

  // --- 7. unresolved attendance adjustments ---------------------------------
  // A correction recorded without a stated reason cannot be defended in an audit.
  const adjustmentsWithoutReason = await prisma.attendanceAdjustment.count({
    where: {
      reason: '',
      attendanceRecord: { workDate: { gte: period.startDate, lte: period.endDate } },
    },
  });
  add({
    code: 'ADJUSTMENT_NO_REASON',
    severity: 'WARNING',
    title: 'การแก้ไขเวลาทำงานที่ไม่มีเหตุผลกำกับ',
    detail: 'ควรระบุเหตุผลทุกครั้งเพื่อให้ตรวจสอบย้อนหลังได้',
    count: adjustmentsWithoutReason,
  });

  // --- 8. informational ------------------------------------------------------
  const correctedCount = await prisma.attendanceRecord.count({
    where: { workDate: { gte: period.startDate, lte: period.endDate }, isCorrected: true },
  });
  add({
    code: 'MANUAL_CORRECTIONS',
    severity: 'INFO',
    title: 'รายการลงเวลาที่แก้ไขด้วยมือ',
    detail: 'รายการเหล่านี้จะใช้ค่าที่แก้ไขแล้วในการคำนวณ ข้อมูลต้นฉบับยังถูกเก็บไว้',
    count: correctedCount,
  });

  const absentCount = await prisma.attendanceRecord.count({
    where: { workDate: { gte: period.startDate, lte: period.endDate }, isAbsent: true },
  });
  add({
    code: 'ABSENCES',
    severity: 'INFO',
    title: 'วันที่ขาดงาน',
    detail: 'จะถูกหักตามกฎการหักขาดงานที่ตั้งค่าไว้',
    count: absentCount,
  });

  const workingDays = eachDay(period.startDate, period.endDate).filter((d) => !isWeekend(d)).length;
  add({
    code: 'PERIOD_SHAPE',
    severity: 'INFO',
    title: 'ช่วงรอบเงินเดือน',
    detail: `${dayjs.utc(period.startDate).format('YYYY-MM-DD')} ถึง ${dayjs.utc(period.endDate).format('YYYY-MM-DD')} · วันทำงาน ${workingDays} วัน · พนักงาน ${employees.length} คน`,
    count: 1,
  });

  const blocking = findings.filter((f) => f.severity === 'BLOCKING').length;

  return {
    periodId: period.id,
    periodCode: period.code,
    periodName: period.name,
    startDate: dayjs.utc(period.startDate).format('YYYY-MM-DD'),
    endDate: dayjs.utc(period.endDate).format('YYYY-MM-DD'),
    canCalculate: blocking === 0,
    blocking,
    warning: findings.filter((f) => f.severity === 'WARNING').length,
    info: findings.filter((f) => f.severity === 'INFO').length,
    findings,
  };
}
