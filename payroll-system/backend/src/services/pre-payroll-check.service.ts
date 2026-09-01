import { PayrollEmployeeStatus, type EmployeePayProfile, type EmploymentType } from '@prisma/client';
import { resolveReadiness, type ReadinessAction } from '../utils/payroll-readiness.js';
import { prisma } from '../plugins/prisma.js';
import { loadSettingsForDate, type PayrollSettings } from './settings.service.js';
import { dec } from '../utils/money.js';
import { companyClock, eachDay, formatDateOnly } from '../utils/datetime.js';
import { isScheduledWorkday } from './schedule-policy.service.js';
import { notFound } from '../utils/errors.js';
import { effectiveEmploymentStart, payrollEligibleEmployeeWhere } from './employee-payroll-eligibility.service.js';
import { attendanceCloseMinutes, classifyOpenPunch } from '../utils/attendance-window.js';
import { loadPeriodContext } from './payroll-employee-context.service.js';

export type CheckSeverity = 'BLOCKING' | 'WARNING' | 'INFO';
export interface CheckFinding { code: string; severity: CheckSeverity; title: string; detail: string; count: number; samples: string[] }

/**
 * One employee's readiness, resolved before any money is computed.
 *
 * BLOCKING is now reserved for findings that would make every row wrong - an
 * overlapping period, broken settings, a negative wage. Anything about a single
 * person is a WARNING and travels on that person's row instead, because
 * refusing to calculate 8 employees over 1 unset hourly rate helps nobody.
 */
export interface EmployeeReadiness {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  employmentType: EmploymentType;
  status: PayrollEmployeeStatus;
  payConfigured: boolean;
  reasons: string[];
  /** What the UI should offer to fix this row, if anything. */
  action: ReadinessAction | null;
  /** Has a punch open today, still within working hours. */
  inProgressToday: boolean;
}

export interface PrePayrollReport {
  periodId: string; periodCode: string; periodName: string; startDate: string; endDate: string;
  canCalculate: boolean; isPreview: boolean; periodClosed: boolean;
  blocking: number; warning: number; info: number;
  readiness: {
    employees: number; ready: number; partial: number; unconfigured: number;
    incompleteAttendance: number; excluded: number; inProgressToday: number;
    /** Retained for callers that still read the previous field name. */
    missingPay: number;
  };
  employees: EmployeeReadiness[];
  findings: CheckFinding[];
}

const SAMPLE_LIMIT = 10;

// Re-exported from utils so existing importers keep working.
export { attendanceCloseMinutes, classifyOpenPunch };

function profileCovers(profile: EmployeePayProfile, date: Date) {
  return profile.isActive && profile.effectiveFrom <= date && (profile.effectiveTo === null || profile.effectiveTo >= date);
}

function validProfile(profile: EmployeePayProfile | undefined, employmentType: EmploymentType) {
  if (!profile) return false;
  if (employmentType === 'MONTHLY' || employmentType === 'CONTRACT') {
    return profile.payType === 'MONTHLY' && dec(profile.monthlySalary ?? 0).greaterThan(0);
  }
  return profile.payType === 'HOURLY' && dec(profile.hourlyRate ?? 0).greaterThan(0);
}

export async function runPrePayrollChecks(periodId: string): Promise<PrePayrollReport> {
  const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw notFound('Payroll period');
  const settings = await loadSettingsForDate(period.endDate);
  const findings: CheckFinding[] = [];
  const add = (f: Omit<CheckFinding, 'samples'> & { samples?: string[] }) => {
    if (f.count > 0) findings.push({ ...f, samples: (f.samples ?? []).slice(0, SAMPLE_LIMIT) });
  };

  const employees = await prisma.employee.findMany({
    where: payrollEligibleEmployeeWhere(period),
    select: {
      id: true, employeeCode: true, firstName: true, lastName: true, baseSalary: true,
      employmentType: true, startDate: true, endDate: true, reactivatedAt: true, attendanceRequired: true, leaveTrackingRequired: true,
      payProfiles: { where: { isActive: true, effectiveFrom: { lte: period.endDate }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: period.startDate } }] }, orderBy: { effectiveFrom: 'asc' } },
    },
  });
  const label = (e: typeof employees[number]) => `${e.employeeCode} ${e.firstName} ${e.lastName}`;
  const employeeIds = employees.map((e) => e.id);
  const [attendance, leaves, holidays] = await Promise.all([
    prisma.attendanceRecord.findMany({
      where: { employeeId: { in: employeeIds }, workDate: { gte: period.startDate, lte: period.endDate } },
      select: { employeeId: true, employeeCode: true, workDate: true, checkIn: true, checkOut: true, status: true },
      orderBy: [{ employeeCode: 'asc' }, { workDate: 'asc' }],
    }),
    prisma.leaveRecord.findMany({ where: { employeeId: { in: employeeIds }, status: 'APPROVED', startDate: { lte: period.endDate }, endDate: { gte: period.startDate } }, select: { employeeId: true, startDate: true, endDate: true } }),
    prisma.holiday.findMany({ where: { date: { gte: period.startDate, lte: period.endDate } }, select: { date: true } }),
  ]);

  const clock = companyClock();
  const today = new Date(`${clock.date}T00:00:00.000Z`);
  const closeMinutes = attendanceCloseMinutes(settings);
  const periodClosed = formatDateOnly(period.endDate) < clock.date || (formatDateOnly(period.endDate) === clock.date && clock.minutes >= closeMinutes);
  const isPreview = !periodClosed;
  add({ code: 'PERIOD_STILL_OPEN', severity: 'WARNING', title: 'รอบเงินเดือนยังไม่สิ้นสุดวันนี้', detail: 'คำนวณประมาณการได้ แต่ยังไม่สามารถอนุมัติ จ่าย หรือล็อกรอบได้', count: isPreview ? 1 : 0 });

  const holidayDates = new Set(holidays.map((h) => formatDateOnly(h.date)));
  const leaveDates = new Map<string, Set<string>>();
  for (const leave of leaves) {
    const dates = leaveDates.get(leave.employeeId) ?? new Set<string>();
    eachDay(leave.startDate, leave.endDate).forEach((d) => dates.add(formatDateOnly(d)));
    leaveDates.set(leave.employeeId, dates);
  }
  const expectedDates = new Map<string, Date[]>();
  for (const e of employees) {
    const hired = effectiveEmploymentStart(e);
    const start = hired > period.startDate ? hired : period.startDate;
    const periodToNow = period.endDate > today ? today : period.endDate;
    const end = e.endDate && e.endDate < periodToNow ? e.endDate : periodToNow;
    const approved = leaveDates.get(e.id) ?? new Set<string>();
    expectedDates.set(e.id, start > end ? [] : eachDay(start, end).filter((d) => isScheduledWorkday(d, settings) && !holidayDates.has(formatDateOnly(d)) && !approved.has(formatDateOnly(d))));
  }

  const attendanceIds = new Set(attendance.map((r) => r.employeeId));
  const noAttendance = employees.filter((e) => e.attendanceRequired && (expectedDates.get(e.id)?.length ?? 0) > 0 && !attendanceIds.has(e.id));
  add({ code: 'NO_ATTENDANCE', severity: 'WARNING', title: 'พนักงานที่ควรทำงานแต่ไม่มีข้อมูลการลงเวลา', detail: 'ตรวจสอบวันเริ่มงาน วันลา วันหยุด และข้อมูลนำเข้า ระบบจะไม่สร้างข้อมูลแทน', count: noAttendance.length, samples: noAttendance.map(label) });

  const incomplete = attendance.filter((r) => r.status === 'MISSING_DATA' && classifyOpenPunch({ ...r, closeMinutes }) !== 'IN_PROGRESS');
  const inProgress = attendance.filter((r) => classifyOpenPunch({ ...r, closeMinutes }) === 'IN_PROGRESS');
  add({ code: 'MISSING_PUNCH', severity: 'WARNING', title: 'วันที่มีข้อมูลเข้า-ออกไม่ครบ', detail: 'ข้อมูลวันที่ผ่านมา หรือหลังเวลาปิดวัน ต้องแก้ไขก่อนคำนวณ', count: incomplete.length, samples: incomplete.map((r) => `${r.employeeCode} — ${formatDateOnly(r.workDate)}`) });
  add({ code: 'IN_PROGRESS_TODAY', severity: 'INFO', title: 'พนักงานกำลังทำงานวันนี้', detail: 'มี check-in แล้วและยังไม่ถึงเวลาปิดวัน จึงไม่ถือเป็นข้อมูลไม่ครบสำหรับการประมาณการ', count: inProgress.length, samples: inProgress.map((r) => `${r.employeeCode} — ${formatDateOnly(r.workDate)}`) });

  const lastSync = await prisma.googleSheetSync.findFirst({ orderBy: { startedAt: 'desc' }, select: { errors: true } });
  const syncErrors = (lastSync?.errors as { message?: string; employeeCode?: string }[] | null) ?? [];
  const unknown = syncErrors.filter((e) => e.message?.includes('Unknown employee_code'));
  add({ code: 'UNKNOWN_EMPLOYEE_SYNC', severity: 'WARNING', title: 'รหัสพนักงานจากการซิงค์ล่าสุดที่ไม่รู้จัก', detail: 'แถวเหล่านี้ไม่ถูกนำเข้า กรุณาตรวจสอบรหัสแล้วซิงค์ใหม่', count: unknown.length, samples: [...new Set(unknown.map((e) => e.employeeCode ?? '-'))] });

  const overlapping = await prisma.payrollPeriod.findMany({ where: { id: { not: period.id }, startDate: { lte: period.endDate }, endDate: { gte: period.startDate } }, select: { name: true, startDate: true, endDate: true } });
  add({ code: 'OVERLAPPING_PERIOD', severity: 'BLOCKING', title: 'ช่วงวันที่ทับซ้อนกับรอบเงินเดือนอื่น', detail: 'การทับซ้อนทำให้ข้อมูลลงเวลาถูกนับซ้ำ', count: overlapping.length, samples: overlapping.map((p) => `${p.name} (${formatDateOnly(p.startDate)} ถึง ${formatDateOnly(p.endDate)})`) });

  const paidFromRate = employees.filter((e) => !(e.attendanceRequired === false && e.leaveTrackingRequired === false));
  const missingMonthly: typeof employees = [];
  const missingHourly: typeof employees = [];
  const unconfiguredDaily: typeof employees = [];
  const missingCoverage: { id: string; text: string; daily: boolean }[] = [];
  for (const e of paidFromRate) {
    const profiles = e.payProfiles;
    if (!profiles.some((p) => validProfile(p, e.employmentType))) {
      if (e.employmentType === 'DAILY') unconfiguredDaily.push(e);
      else if (e.employmentType === 'MONTHLY' || e.employmentType === 'CONTRACT') missingMonthly.push(e);
      else missingHourly.push(e);
      continue;
    }
    const relevantDates = e.employmentType === 'MONTHLY' || e.employmentType === 'CONTRACT'
      ? expectedDates.get(e.id) ?? []
      : attendance.filter((r) => r.employeeId === e.id && r.checkIn && r.checkOut).map((r) => r.workDate);
    const uncovered = relevantDates.filter((d) => !profiles.some((p) => profileCovers(p, d) && validProfile(p, e.employmentType)));
    if (uncovered.length) missingCoverage.push({ id: e.id, daily: e.employmentType === 'DAILY', text: `${label(e)} — ${formatDateOnly(uncovered[0])} ถึง ${formatDateOnly(uncovered.at(-1)!)}` });
  }
  add({ code: 'MISSING_MONTHLY_SALARY', severity: 'WARNING', title: 'ยังไม่ได้กำหนดเงินเดือนรายเดือน', detail: 'กำหนดจำนวนเงินจริงและวันที่เริ่มใช้ ระบบจะไม่เดาจาก baseSalary เดิม', count: missingMonthly.length, samples: missingMonthly.map(label) });
  add({ code: 'MISSING_HOURLY_RATE', severity: 'WARNING', title: 'ยังไม่ได้กำหนดค่าจ้างต่อชั่วโมง', detail: 'พนักงานประเภท HOURLY ต้องมีอัตราจริงและวันที่เริ่มใช้', count: missingHourly.length, samples: missingHourly.map(label) });
  add({ code: 'DAILY_RATE_UNCONFIGURED', severity: 'WARNING', title: 'พนักงานรายวันบางคนยังไม่ได้กำหนดอัตราค่าจ้าง', detail: 'ระบบยังคำนวณเวลาทำงาน แต่จะไม่รวมค่าจ้างของบุคคลเหล่านี้ในยอดประมาณการ', count: unconfiguredDaily.length, samples: unconfiguredDaily.map(label) });
  const blockingCoverage = missingCoverage.filter((x) => !x.daily);
  const dailyCoverage = missingCoverage.filter((x) => x.daily);
  add({ code: 'MISSING_PAY_PROFILE_FOR_DATE_RANGE', severity: 'WARNING', title: 'อัตราค่าจ้างครอบคลุมช่วงวันที่ไม่ครบ', detail: 'อัตราที่เริ่มกลางรอบจะไม่ถูกใช้ย้อนหลัง กรุณาเพิ่มช่วงอัตราที่ถูกต้อง', count: blockingCoverage.length, samples: blockingCoverage.map((x) => x.text) });
  add({ code: 'DAILY_RATE_DATE_RANGE_UNCONFIGURED', severity: 'WARNING', title: 'อัตรารายวันครอบคลุมวันที่ทำงานไม่ครบ', detail: 'เวลาทำงานยังคงแสดง แต่วันที่ไม่มีอัตราจะไม่ถูกสร้างเป็นค่าจ้าง', count: dailyCoverage.length, samples: dailyCoverage.map((x) => x.text) });

  const invalidSalary = employees.filter((e) => dec(e.baseSalary).isNegative());
  add({ code: 'INVALID_SALARY', severity: 'BLOCKING', title: 'ค่าจ้างติดลบ', detail: 'ค่าจ้างติดลบเป็นข้อมูลผิดพลาด', count: invalidSalary.length, samples: invalidSalary.map(label) });
  const requiredSettings = ['STANDARD_WORK_DAYS', 'STANDARD_WORK_HOURS', 'WORK_START_TIME', 'WORK_END_TIME', 'OT_RATE_WEEKDAY'];
  const badSettings = requiredSettings.filter((key) => !settings.string(key) || (['STANDARD_WORK_DAYS', 'STANDARD_WORK_HOURS'].includes(key) && settings.decimal(key).lessThanOrEqualTo(0)));
  add({ code: 'INVALID_SETTINGS', severity: 'BLOCKING', title: 'การตั้งค่าเงินเดือนไม่ถูกต้อง', detail: 'ค่าที่จำเป็นว่างหรือเป็นศูนย์', count: badSettings.length, samples: badSettings });
  const noReason = await prisma.attendanceAdjustment.count({ where: { reason: '', attendanceRecord: { workDate: { gte: period.startDate, lte: period.endDate } } } });
  add({ code: 'ADJUSTMENT_NO_REASON', severity: 'WARNING', title: 'การแก้ไขเวลาที่ไม่มีเหตุผล', detail: 'ควรระบุเหตุผลเพื่อการตรวจสอบย้อนหลัง', count: noReason });
  const corrected = await prisma.attendanceRecord.count({ where: { workDate: { gte: period.startDate, lte: period.endDate }, isCorrected: true } });
  add({ code: 'MANUAL_CORRECTIONS', severity: 'INFO', title: 'รายการลงเวลาที่แก้ไขด้วยมือ', detail: 'ใช้ค่าที่แก้ไขแล้ว โดยข้อมูลต้นฉบับยังคงอยู่', count: corrected });
  const absences = await prisma.attendanceRecord.count({ where: { workDate: { gte: period.startDate, lte: period.endDate }, isAbsent: true } });
  add({ code: 'ABSENCES', severity: 'INFO', title: 'วันที่ขาดงาน', detail: 'จะถูกหักตามกฎที่ตั้งค่าไว้', count: absences });
  const workdays = eachDay(period.startDate, period.endDate).filter((d) => isScheduledWorkday(d, settings)).length;
  add({ code: 'PERIOD_SHAPE', severity: 'INFO', title: 'ช่วงรอบเงินเดือน', detail: `${formatDateOnly(period.startDate)} ถึง ${formatDateOnly(period.endDate)} · วันทำงาน ${workdays} วัน · พนักงาน ${employees.length} คน`, count: 1 });

  // --- per-employee readiness -----------------------------------------------
  // Resolved through the same module and the same inputs the calculator uses,
  // so this screen cannot promise a state the calculation then contradicts.
  const context = await loadPeriodContext(period);
  const inProgressIds = new Set(inProgress.map((r) => r.employeeId));
  const absentByEmployee = new Map<string, number>();
  const presentByEmployee = new Map<string, number>();
  for (const record of context.employees.flatMap((e) => e.attendance)) {
    if (record.isAbsent) {
      absentByEmployee.set(record.employeeId, (absentByEmployee.get(record.employeeId) ?? 0) + 1);
    }
    if (record.workedMinutes > 0) {
      presentByEmployee.set(record.employeeId, (presentByEmployee.get(record.employeeId) ?? 0) + 1);
    }
  }

  const employeeReadiness: EmployeeReadiness[] = context.employees.map((entry) => {
    const e = entry.employee;
    const resolved = resolveReadiness({
      employmentType: e.employmentType,
      excluded: entry.excluded,
      payConfigured: entry.payConfigured,
      attendanceRequired: e.attendanceRequired,
      missingDataDays: entry.incompletePunchDays,
      missingCheckInDays: entry.attendance.filter((r) => r.isMissingCheckIn).length,
      missingCheckOutDays: entry.attendance.filter((r) => r.isMissingCheckOut).length,
      presentDays: presentByEmployee.get(e.id) ?? 0,
      workingDays: expectedDates.get(e.id)?.length ?? 0,
      absentDays: absentByEmployee.get(e.id) ?? 0,
      unratedDays: entry.unratedDays,
      // No money has been computed yet at this point, so a negative net is not
      // something this screen can know about.
      netNegative: false,
      isEstimate: isPreview,
    });
    return {
      employeeId: e.id,
      employeeCode: e.employeeCode,
      employeeName: `${e.firstName} ${e.lastName}`,
      employmentType: e.employmentType,
      status: resolved.status,
      payConfigured: entry.payConfigured,
      reasons: resolved.reasons,
      action: resolved.action,
      inProgressToday: inProgressIds.has(e.id),
    };
  });

  const countOf = (status: PayrollEmployeeStatus) =>
    employeeReadiness.filter((e) => e.status === status).length;

  const blocking = findings.filter((f) => f.severity === 'BLOCKING').length;
  return {
    periodId: period.id, periodCode: period.code, periodName: period.name,
    startDate: formatDateOnly(period.startDate), endDate: formatDateOnly(period.endDate),
    // Only period-wide faults can stop a run now. An employee who is not ready
    // is reported on their own row and simply calculates to what is known.
    canCalculate: blocking === 0, isPreview, periodClosed, blocking,
    warning: findings.filter((f) => f.severity === 'WARNING').length,
    info: findings.filter((f) => f.severity === 'INFO').length,
    readiness: {
      employees: employeeReadiness.length,
      ready: countOf(PayrollEmployeeStatus.READY),
      partial: countOf(PayrollEmployeeStatus.PARTIAL),
      unconfigured: countOf(PayrollEmployeeStatus.UNCONFIGURED),
      incompleteAttendance: countOf(PayrollEmployeeStatus.ATTENDANCE_INCOMPLETE),
      excluded: countOf(PayrollEmployeeStatus.EXCLUDED),
      inProgressToday: inProgressIds.size,
      missingPay: countOf(PayrollEmployeeStatus.UNCONFIGURED),
    },
    employees: employeeReadiness,
    findings,
  };
}
