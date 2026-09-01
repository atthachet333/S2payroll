import {
  PayrollEmployeeStatus,
  PayrollPeriodStatus,
  PayrollItemKind,
  Prisma,
  type RoleCode,
} from '@prisma/client';
import { prisma } from '../plugins/prisma.js';
import { loadSettings, loadSettingsForDate, settingsFromSnapshot, type SettingsMap } from './settings.service.js';
import { calculatePayroll, type AttendanceAggregate, type ManualItem } from './payroll-calculator.service.js';
import { recordAudit } from './audit.service.js';
import { runPrePayrollChecks } from './pre-payroll-check.service.js';
import { dec, toPrismaDecimal, toPrismaHours, money, Decimal } from '../utils/money.js';
import { companyClock, cycleBounds, dayjs, eachDay, formatDateOnly, thaiMonthLabel } from '../utils/datetime.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { isScheduledWorkday } from './schedule-policy.service.js';
import { payrollEligibleEmployeeWhere } from './employee-payroll-eligibility.service.js';
import { latestProfile, loadPeriodContext } from './payroll-employee-context.service.js';
import { NON_FINAL_STATUSES } from '../utils/payroll-readiness.js';
import { attendanceCloseMinutes, classifyOpenPunch } from '../utils/attendance-window.js';
import { floorToInterval, roundingIntervalMinutes } from '../utils/time-rounding.js';

export interface Actor {
  userId: string;
  email: string;
  role: RoleCode;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Allowed transitions in the payroll workflow.
 * DRAFT -> ATTENDANCE_REVIEW -> CALCULATED -> REVIEW -> APPROVED -> PAID -> LOCKED
 * Recalculating pulls a period back to CALCULATED, which is why CALCULATED is
 * reachable from several earlier states.
 */
const ALLOWED_TRANSITIONS: Record<PayrollPeriodStatus, PayrollPeriodStatus[]> = {
  DRAFT: ['ATTENDANCE_REVIEW', 'CALCULATED'],
  ATTENDANCE_REVIEW: ['CALCULATED', 'DRAFT'],
  CALCULATED: ['REVIEW', 'ATTENDANCE_REVIEW', 'CALCULATED'],
  REVIEW: ['APPROVED', 'CALCULATED'],
  APPROVED: ['PAID', 'REVIEW'],
  PAID: ['LOCKED', 'APPROVED'],
  LOCKED: [],
};

const FINANCIALLY_FROZEN: PayrollPeriodStatus[] = ['LOCKED'];

export function assertTransition(from: PayrollPeriodStatus, to: PayrollPeriodStatus): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw badRequest(`ไม่สามารถเปลี่ยนสถานะจาก ${from} ไป ${to} ได้`);
  }
}

/** Every write that changes money must pass this guard. */
export function assertNotLocked(status: PayrollPeriodStatus): void {
  if (FINANCIALLY_FROZEN.includes(status)) {
    throw forbidden('รอบเงินเดือนถูกล็อกแล้ว ไม่สามารถแก้ไขข้อมูลทางการเงินได้');
  }
}

/**
 * Periods whose figures have been handed over as real money and must not be
 * edited in place. PAID means the transfer has happened; changing the numbers
 * afterwards would leave the payroll record disagreeing with the bank. Getting
 * back in requires the existing status/unlock workflow, which is audited.
 */
const FINANCIALLY_EDITABLE: PayrollPeriodStatus[] = [
  PayrollPeriodStatus.DRAFT,
  PayrollPeriodStatus.ATTENDANCE_REVIEW,
  PayrollPeriodStatus.CALCULATED,
  PayrollPeriodStatus.REVIEW,
];

export function assertFinanciallyEditable(status: PayrollPeriodStatus): void {
  if (!FINANCIALLY_EDITABLE.includes(status)) {
    throw forbidden(
      'รอบเงินเดือนนี้อนุมัติหรือจ่ายเงินแล้ว ไม่สามารถแก้ไขรายการได้ กรุณาใช้ขั้นตอนย้อนสถานะหรือปลดล็อกที่มีการบันทึกผู้ดำเนินการ'
    );
  }
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

/**
 * Suggested window for a payroll month, derived from the configured cycle.
 * Exported so the UI can show the same dates the backend would default to.
 */
export function suggestPeriodBounds(
  year: number,
  month: number,
  startDay: number,
  endDay: number
): { startDate: Date; endDate: Date } {
  return cycleBounds(year, month, startDay, endDay);
}

/**
 * Default pay date for a cycle: `paymentDay` of the month the cycle CLOSES in.
 * Derived from the end of the period so a 26 -> 25 cycle never produces a pay
 * date that falls before the period has finished.
 */
export function defaultPaymentDate(endDate: Date, paymentDay: number): Date {
  const end = dayjs.utc(endDate);
  const day = Math.min(Math.max(paymentDay, 1), end.daysInMonth());
  return end.date(day).startOf('day').toDate();
}

/** The configured cycle plus the window it implies for a given month. */
export async function getPeriodSuggestion(year: number, month: number) {
  const settings = await loadSettings();
  const startDay = settings.number('PAYROLL_CYCLE_START_DAY');
  const endDay = settings.number('PAYROLL_CYCLE_END_DAY');
  const bounds = suggestPeriodBounds(year, month, startDay, endDay);

  const paymentDate = dayjs.utc(
    defaultPaymentDate(bounds.endDate, settings.number('PAYROLL_PAYMENT_DAY'))
  );

  return {
    year,
    month,
    name: thaiMonthLabel(year, month),
    cycleStartDay: startDay,
    cycleEndDay: endDay,
    startDate: dayjs.utc(bounds.startDate).format('YYYY-MM-DD'),
    endDate: dayjs.utc(bounds.endDate).format('YYYY-MM-DD'),
    paymentDate: paymentDate.format('YYYY-MM-DD'),
  };
}

export async function listPeriods() {
  return prisma.payrollPeriod.findMany({ orderBy: [{ year: 'desc' }, { month: 'desc' }] });
}

export async function getPeriod(id: string) {
  const period = await prisma.payrollPeriod.findUnique({ where: { id } });
  if (!period) throw notFound('Payroll period');
  return period;
}

export async function createPeriod(
  input: {
    year: number;
    month: number;
    startDate?: string | null;
    endDate?: string | null;
    paymentDate?: string | null;
    note?: string | null;
  },
  actor: Actor
) {
  const existing = await prisma.payrollPeriod.findUnique({
    where: { year_month: { year: input.year, month: input.month } },
  });
  if (existing) throw conflict('มีรอบเงินเดือนของเดือนนี้อยู่แล้ว');

  const settings = await loadSettings();

  // The default window comes from the configured cycle (26 -> 25 by default),
  // never from a hardcoded rule. An explicit start/end always wins.
  const bounds = suggestPeriodBounds(
    input.year,
    input.month,
    settings.number('PAYROLL_CYCLE_START_DAY'),
    settings.number('PAYROLL_CYCLE_END_DAY')
  );
  const startDate = input.startDate
    ? dayjs.utc(input.startDate).startOf('day').toDate()
    : bounds.startDate;
  const endDate = input.endDate ? dayjs.utc(input.endDate).startOf('day').toDate() : bounds.endDate;

  if (endDate < startDate) throw badRequest('วันสิ้นสุดรอบต้องไม่ก่อนวันเริ่มรอบ');

  // Overlapping windows would double-count attendance across two payrolls.
  const overlapping = await prisma.payrollPeriod.findFirst({
    where: { startDate: { lte: endDate }, endDate: { gte: startDate } },
    select: { code: true, name: true, startDate: true, endDate: true },
  });
  if (overlapping) {
    throw conflict(
      `ช่วงวันที่ทับซ้อนกับรอบ ${overlapping.name} (${dayjs.utc(overlapping.startDate).format('YYYY-MM-DD')} ถึง ${dayjs.utc(overlapping.endDate).format('YYYY-MM-DD')})`
    );
  }
  // The payment date is derived from the END of the cycle, not the start.
  // Deriving it from the start produced a pay date before the period had even
  // finished on a 26 -> 25 cycle (e.g. a September period paying on 25 August).
  const paymentDate = input.paymentDate
    ? dayjs.utc(input.paymentDate).startOf('day').toDate()
    : defaultPaymentDate(endDate, settings.number('PAYROLL_PAYMENT_DAY'));

  const period = await prisma.payrollPeriod.create({
    data: {
      code: `${input.year}-${String(input.month).padStart(2, '0')}`,
      name: thaiMonthLabel(input.year, input.month),
      year: input.year,
      month: input.month,
      startDate,
      endDate,
      paymentDate,
      note: input.note ?? null,
      status: PayrollPeriodStatus.DRAFT,
      createdBy: actor.userId,
    },
  });

  await recordAudit({
    action: 'PAYROLL_PERIOD_CREATE',
    entity: 'PayrollPeriod',
    entityId: period.id,
    newValue: { code: period.code },
    userId: actor.userId,
    userEmail: actor.email,
    ipAddress: actor.ip,
    userAgent: actor.userAgent,
  });

  return period;
}

// ---------------------------------------------------------------------------
// Attendance aggregation
// ---------------------------------------------------------------------------

/**
 * Roll the daily attendance rows for one period into the per-employee totals the
 * calculator consumes. OT minutes are bucketed by day type so each bucket can be
 * paid at its own configured multiplier.
 */
export async function aggregateAttendance(
  periodId: string
): Promise<{ aggregates: Map<string, AttendanceAggregate>; workingDays: number }> {
  const period = await getPeriod(periodId);
  const scheduleSettings = await loadSettings();
  // Someone who has checked in today and not yet left is at work, not missing
  // data. Counting today's open punch as a fault would push every currently
  // working employee into ATTENDANCE_INCOMPLETE and make an open-period preview
  // useless - and it would disagree with the readiness screen, which has always
  // drawn this distinction.
  const closeMinutes = attendanceCloseMinutes(scheduleSettings);
  const interval = roundingIntervalMinutes(scheduleSettings);

  const [records, leaves, holidays] = await Promise.all([
    prisma.attendanceRecord.findMany({
      where: {
        workDate: { gte: period.startDate, lte: period.endDate },
        employee: { attendanceRequired: true },
      },
    }),
    prisma.leaveRecord.findMany({
      where: {
        status: 'APPROVED',
        startDate: { lte: period.endDate },
        endDate: { gte: period.startDate },
        employee: { leaveTrackingRequired: true },
      },
    }),
    prisma.holiday.findMany({
      where: { date: { gte: period.startDate, lte: period.endDate } },
    }),
  ]);

  const holidayKeys = new Set(holidays.map((h) => dayjs.utc(h.date).format('YYYY-MM-DD')));

  // Calendar working days in the period: weekdays that are not public holidays.
  const workingDays = eachDay(period.startDate, period.endDate).filter(
    (d) => isScheduledWorkday(d, scheduleSettings) && !holidayKeys.has(dayjs.utc(d).format('YYYY-MM-DD'))
  ).length;

  const result = new Map<string, AttendanceAggregate>();

  const blank = (): AttendanceAggregate => ({
    workingDays,
    presentDays: 0,
    absentDays: 0,
    leaveDays: 0,
    unpaidLeaveDays: 0,
    lateCount: 0,
    lateMinutes: 0,
    roundedLateMinutes: 0,
    earlyLeaveMinutes: 0,
    roundedEarlyLeaveMinutes: 0,
    actualOtMinutes: 0,
    workedMinutes: 0,
    normalMinutes: 0,
    otWeekdayMinutes: 0,
    otWeekendMinutes: 0,
    otHolidayMinutes: 0,
    missingDataDays: 0,
    missingCheckInDays: 0,
    missingCheckOutDays: 0,
  });

  for (const record of records) {
    const agg = result.get(record.employeeId) ?? blank();

    // These read the *effective* punches, so a manual correction is what counts
    // here while the imported originals stay untouched on the record.
    agg.workedMinutes += record.workedMinutes;
    agg.normalMinutes += record.normalMinutes;
    // Observed and floored figures are accumulated side by side. The floor is
    // applied per day, so the period total is the sum of the values the
    // Attendance page shows - summing raw minutes and flooring once at the end
    // would give a total that does not match any row on screen.
    agg.lateMinutes += record.lateMinutes;
    agg.roundedLateMinutes += floorToInterval(record.lateMinutes, interval);
    if (record.lateMinutes > 0) agg.lateCount += 1;
    agg.earlyLeaveMinutes += record.earlyLeaveMinutes;
    agg.roundedEarlyLeaveMinutes += floorToInterval(record.earlyLeaveMinutes, interval);
    if (record.isAbsent) agg.absentDays += 1;

    const inProgress =
      classifyOpenPunch({
        workDate: record.workDate,
        checkIn: record.checkIn,
        checkOut: record.checkOut,
        closeMinutes,
      }) === 'IN_PROGRESS';
    if (!inProgress) {
      if (record.status === 'MISSING_DATA') agg.missingDataDays += 1;
      if (record.isMissingCheckIn) agg.missingCheckInDays += 1;
      if (record.isMissingCheckOut) agg.missingCheckOutDays += 1;
    }
    if (record.workedMinutes > 0) agg.presentDays += 1;

    if (record.otMinutes > 0) {
      // Approved OT is floored on the same interval. Nothing here creates OT -
      // the attendance engine has already decided what counts as approved
      // overtime; this only rounds what it produced.
      agg.actualOtMinutes += record.otMinutes;
      const otMinutes = floorToInterval(record.otMinutes, interval);
      if (record.isHoliday) agg.otHolidayMinutes += otMinutes;
      else if (record.isWeekend) agg.otWeekendMinutes += otMinutes;
      else agg.otWeekdayMinutes += otMinutes;
    }

    result.set(record.employeeId, agg);
  }

  // Leave days are counted from the leave records, clipped to the period window,
  // counting working days only.
  for (const leave of leaves) {
    const agg = result.get(leave.employeeId) ?? blank();
    const from = leave.startDate < period.startDate ? period.startDate : leave.startDate;
    const to = leave.endDate > period.endDate ? period.endDate : leave.endDate;
    const days = eachDay(from, to).filter(
      (d) => isScheduledWorkday(d, scheduleSettings) && !holidayKeys.has(dayjs.utc(d).format('YYYY-MM-DD'))
    ).length;
    agg.leaveDays += days;
    if (!leave.isPaid) agg.unpaidLeaveDays += days;
    result.set(leave.employeeId, agg);
  }

  return { aggregates: result, workingDays };
}

// ---------------------------------------------------------------------------
// Calculation
// ---------------------------------------------------------------------------

/**
 * Calculate (or recalculate) a payroll period, employee by employee.
 *
 * The period is never refused because one employee is incomplete. Each person
 * is calculated from whatever is actually known about them and carries their own
 * readiness status, so a missing hourly rate on one row stops that row alone:
 *
 *   READY                 complete and final
 *   PARTIAL               calculated, but not a settled figure yet
 *   UNCONFIGURED          no wage rate - worked time is reported, money is not
 *   ATTENDANCE_INCOMPLETE a past day has one punch missing
 *   EXCLUDED              not payable under company policy
 *
 * Nothing is invented for an UNCONFIGURED employee. Their hours are real and
 * their pay is zero, flagged pay_configured = false so no screen and no payslip
 * can mistake that zero for a salary.
 *
 * Only findings that would corrupt *every* row - an overlapping period, broken
 * settings, a negative wage - still block, because those are properties of the
 * period rather than of a person.
 *
 * Manual income/deduction lines and manual field adjustments already recorded
 * against a payroll employee are preserved across recalculations; only the
 * derived values are recomputed.
 */
export async function calculatePeriod(
  periodId: string,
  actor: Actor,
  options: { skipChecks?: boolean } = {}
) {
  const period = await getPeriod(periodId);
  assertNotLocked(period.status);
  assertTransition(period.status, PayrollPeriodStatus.CALCULATED);

  // Period-scoped problems still stop the run: they would make every row wrong,
  // not one. Employee-scoped problems are carried on the rows instead.
  // `skipChecks` exists for tests and deliberate overrides only.
  if (!options.skipChecks) {
    const report = await runPrePayrollChecks(periodId);
    const blockers = report.findings.filter((f) => f.severity === 'BLOCKING');
    if (blockers.length > 0) {
      throw badRequest(
        'ไม่สามารถคำนวณเงินเดือนได้ เนื่องจากยังมีปัญหาระดับรอบที่ต้องแก้ไขก่อน: ' +
          blockers.map((f) => `${f.title} (${f.count})`).join(', ')
      );
    }
  }

  const context = await loadPeriodContext(period);
  const settings = context.settings;
  const { aggregates, workingDays: periodWorkingDays } = await aggregateAttendance(periodId);

  // Manual lines and adjustments survive a recalculation.
  const existingRows = await prisma.payrollEmployee.findMany({
    where: { periodId },
    include: {
      incomes: { where: { isManual: true } },
      deductions: { where: { isManual: true } },
    },
  });
  const existingByEmployee = new Map(existingRows.map((r) => [r.employeeId, r]));

  let grossTotal = new Decimal(0);
  let otTotal = new Decimal(0);
  let deductionTotal = new Decimal(0);
  let netTotal = new Decimal(0);

  const statusCounts: Record<PayrollEmployeeStatus, number> = {
    READY: 0,
    PARTIAL: 0,
    UNCONFIGURED: 0,
    ATTENDANCE_INCOMPLETE: 0,
    NEEDS_REVIEW: 0,
    MISSING_DATA: 0,
    EXCLUDED: 0,
  };
  const skipped: { employeeCode: string; employeeName: string; status: PayrollEmployeeStatus; reasons: string[] }[] = [];

  for (const entry of context.employees) {
    const employee = entry.employee;

    // An employee with no attendance rows at all still carries the period's
    // working days, so readiness flags them incomplete rather than quietly
    // paying a full salary against zero recorded attendance.
    const attendance: AttendanceAggregate = aggregates.get(employee.id) ?? {
      workingDays: periodWorkingDays,
      presentDays: 0,
      absentDays: 0,
      leaveDays: 0,
      unpaidLeaveDays: 0,
      lateCount: 0,
      lateMinutes: 0,
      roundedLateMinutes: 0,
      earlyLeaveMinutes: 0,
      roundedEarlyLeaveMinutes: 0,
      actualOtMinutes: 0,
      workedMinutes: 0,
      normalMinutes: 0,
      otWeekdayMinutes: 0,
      otWeekendMinutes: 0,
      otHolidayMinutes: 0,
      missingDataDays: 0,
      missingCheckInDays: 0,
      missingCheckOutDays: 0,
    };

    const prior = existingByEmployee.get(employee.id);
    const manualIncomes: ManualItem[] = (prior?.incomes ?? []).map((i) => ({
      kind: i.kind,
      label: i.label,
      amount: i.amount,
      quantity: i.quantity,
      rate: i.rate,
      note: i.note,
    }));
    const manualDeductions: ManualItem[] = (prior?.deductions ?? []).map((d) => ({
      kind: d.kind,
      label: d.label,
      amount: d.amount,
      quantity: d.quantity,
      rate: d.rate,
      note: d.note,
    }));

    // employee_pay_profiles is the single source of compensation. The monthly
    // headline comes from the profile in force at the end of the period; hourly
    // staff are never priced from a single profile at all - every one of their
    // days was already valued at the rate in force on that date.
    const profile = latestProfile(entry);
    const earnings = entry.dailyEarnings;

    const result = calculatePayroll(
      {
        employee: {
          employeeId: employee.id,
          employeeCode: employee.employeeCode,
          employeeName: `${employee.firstName} ${employee.lastName}`,
          departmentName: employee.department?.name ?? null,
          positionName: employee.position?.name ?? null,
          employmentType: employee.employmentType,
          baseSalary: employee.baseSalary,
          payType: profile?.payType,
          monthlySalary: profile?.monthlySalary,
          hourlyRate: profile?.hourlyRate,
          ssoEnabled: employee.ssoEnabled,
          taxEnabled: employee.taxEnabled,
          otEligible: employee.otEligible,
          attendanceRequired: employee.attendanceRequired,
          employedDays: entry.employedDays,
          policy: entry.policy,
          payConfigured: entry.payConfigured,
          excluded: entry.excluded,
        },
        attendance,
        manualIncomes,
        manualDeductions,
        dailyEarnings: earnings
          ? {
              amount: earnings.totalAmount,
              totalWorkedMinutes: earnings.totalWorkedMinutes,
              totalBreakDeductionMinutes: earnings.totalBreakDeductionMinutes,
              totalPayableMinutes: earnings.totalPayableMinutes,
              totalRoundedAwayMinutes: earnings.totalRoundedAwayMinutes,
              ratedMinutes: earnings.ratedMinutes,
              unratedMinutes: earnings.unratedMinutes,
              unratedDays: earnings.unratedDays,
              workedDays: earnings.workedDays,
            }
          : undefined,
        isEstimate: context.isPreview,
      },
      settings
    );

    statusCounts[result.status] += 1;
    if (result.status !== PayrollEmployeeStatus.READY) {
      skipped.push({
        employeeCode: employee.employeeCode,
        employeeName: `${employee.firstName} ${employee.lastName}`,
        status: result.status,
        reasons: result.reviewNotes,
      });
    }

    const data = {
      employeeCode: employee.employeeCode,
      employeeName: `${employee.firstName} ${employee.lastName}`,
      departmentName: employee.department?.name ?? null,
      positionName: employee.position?.name ?? null,
      employmentType: employee.employmentType,

      workingDays: attendance.workingDays,
      presentDays: attendance.presentDays,
      absentDays: attendance.absentDays,
      leaveDays: toPrismaHours(attendance.leaveDays),
      unpaidLeaveDays: toPrismaHours(attendance.unpaidLeaveDays),
      lateCount: attendance.lateCount,
      lateMinutes: attendance.lateMinutes,
      workingHours: toPrismaHours(result.workingHours),
      normalHours: toPrismaHours(result.normalHours),
      otHours: toPrismaHours(result.otHours),
      otWeekdayHours: toPrismaHours(result.otWeekdayHours),
      otWeekendHours: toPrismaHours(result.otWeekendHours),
      otHolidayHours: toPrismaHours(result.otHolidayHours),
      missingDataDays: attendance.missingDataDays,
      missingCheckInDays: attendance.missingCheckInDays,
      missingCheckOutDays: attendance.missingCheckOutDays,

      dailyBase: toPrismaDecimal(result.dailyBase),
      hourlyBase: toPrismaDecimal(result.hourlyBase),
      // Derived for money only. workingHours above stays the true observed
      // duration, so the row records both what happened and what was paid.
      breakDeductionMinutes: result.breakDeductionMinutes,
      payableMinutes: result.payableMinutes,
      roundedAwayMinutes: result.roundedAwayMinutes,
      roundedLateMinutes: result.roundedLateMinutes,
      earlyLeaveMinutes: result.earlyLeaveMinutes,
      roundedEarlyLeaveMinutes: result.roundedEarlyLeaveMinutes,
      actualOtMinutes: result.actualOtMinutes,

      baseSalary: toPrismaDecimal(result.baseSalary),
      otAmount: toPrismaDecimal(result.otAmount),
      allowanceAmount: toPrismaDecimal(result.allowanceAmount),
      bonusAmount: toPrismaDecimal(result.bonusAmount),
      commissionAmount: toPrismaDecimal(result.commissionAmount),
      otherIncome: toPrismaDecimal(result.otherIncome),
      grossIncome: toPrismaDecimal(result.grossIncome),

      lateDeduction: toPrismaDecimal(result.lateDeduction),
      lateDeductionHours: result.lateDeductionHours,
      leaveDeduction: toPrismaDecimal(result.leaveDeduction),
      absenceDeduction: toPrismaDecimal(result.absenceDeduction),
      socialSecurity: toPrismaDecimal(result.socialSecurity),
      tax: toPrismaDecimal(result.tax),
      loanDeduction: toPrismaDecimal(result.loanDeduction),
      otherDeduction: toPrismaDecimal(result.otherDeduction),
      totalDeduction: toPrismaDecimal(result.totalDeduction),

      netSalary: toPrismaDecimal(result.netSalary),
      status: result.status,
      payConfigured: result.payConfigured,
      isEstimate: result.isEstimate,
      reviewNotes: result.reviewNotes as unknown as Prisma.InputJsonValue,
      calculatedAt: new Date(),
    };

    await prisma.$transaction(async (tx) => {
      const row = await tx.payrollEmployee.upsert({
        where: { period_employee: { periodId, employeeId: employee.id } },
        create: { periodId, employeeId: employee.id, createdBy: actor.userId, ...data },
        update: data,
      });

      // Replace only the system-generated lines; manual lines are left in place.
      await tx.payrollIncome.deleteMany({
        where: { payrollEmployeeId: row.id, isManual: false },
      });
      await tx.payrollDeduction.deleteMany({
        where: { payrollEmployeeId: row.id, isManual: false },
      });

      await tx.payrollIncome.createMany({
        data: result.incomes
          .filter((line) => !line.isManual)
          .map((line) => ({
            payrollEmployeeId: row.id,
            kind: line.kind,
            label: line.label,
            quantity: line.quantity ? toPrismaHours(line.quantity) : null,
            rate: line.rate ? new Prisma.Decimal(line.rate.toFixed(4)) : null,
            amount: toPrismaDecimal(line.amount),
            isManual: false,
            createdBy: actor.userId,
          })),
      });

      await tx.payrollDeduction.createMany({
        data: result.deductions
          .filter((line) => !line.isManual)
          .map((line) => ({
            payrollEmployeeId: row.id,
            kind: line.kind,
            label: line.label,
            quantity: line.quantity ? toPrismaHours(line.quantity) : null,
            rate: line.rate ? new Prisma.Decimal(line.rate.toFixed(4)) : null,
            amount: toPrismaDecimal(line.amount),
            isManual: false,
            createdBy: actor.userId,
          })),
      });
    });

    grossTotal = grossTotal.plus(result.grossIncome);
    otTotal = otTotal.plus(result.otAmount);
    deductionTotal = deductionTotal.plus(result.totalDeduction);
    netTotal = netTotal.plus(result.netSalary);
  }

  // Drop rows for employees that no longer belong in this period - deactivated
  // staff among them, which is how a deactivation reaches an already-calculated
  // period.
  const validIds = new Set(context.employees.map((e) => e.employee.id));
  await prisma.payrollEmployee.deleteMany({
    where: { periodId, employeeId: { notIn: [...validIds] } },
  });

  const updated = await prisma.payrollPeriod.update({
    where: { id: periodId },
    data: {
      status: PayrollPeriodStatus.CALCULATED,
      totalEmployees: context.employees.length,
      grossTotal: toPrismaDecimal(grossTotal),
      otTotal: toPrismaDecimal(otTotal),
      deductionTotal: toPrismaDecimal(deductionTotal),
      netTotal: toPrismaDecimal(netTotal),
      calculatedAt: new Date(),
      // Freeze the rules used, so the period can always be re-explained later.
      settingsSnapshot: settings.raw() as unknown as Prisma.InputJsonValue,
    },
  });

  await recordAudit({
    action: 'PAYROLL_CALCULATE',
    entity: 'PayrollPeriod',
    entityId: periodId,
    newValue: {
      employees: context.employees.length,
      gross: grossTotal.toFixed(2),
      net: netTotal.toFixed(2),
      statusCounts,
    },
    userId: actor.userId,
    userEmail: actor.email,
    ipAddress: actor.ip,
    userAgent: actor.userAgent,
  });

  return { ...updated, statusCounts, skipped };
}

// ---------------------------------------------------------------------------
// Workflow transitions
// ---------------------------------------------------------------------------

async function transition(
  periodId: string,
  to: PayrollPeriodStatus,
  actor: Actor,
  extra: Prisma.PayrollPeriodUpdateInput = {},
  action = 'PAYROLL_TRANSITION'
) {
  const period = await getPeriod(periodId);
  assertNotLocked(period.status);
  assertTransition(period.status, to);

  const updated = await prisma.payrollPeriod.update({
    where: { id: periodId },
    data: { status: to, ...extra },
  });

  await recordAudit({
    action,
    entity: 'PayrollPeriod',
    entityId: periodId,
    oldValue: { status: period.status },
    newValue: { status: to },
    userId: actor.userId,
    userEmail: actor.email,
    ipAddress: actor.ip,
    userAgent: actor.userAgent,
  });

  return updated;
}

export const submitForReview = (periodId: string, actor: Actor) =>
  transition(periodId, PayrollPeriodStatus.REVIEW, actor, {}, 'PAYROLL_SUBMIT_REVIEW');

export const startAttendanceReview = (periodId: string, actor: Actor) =>
  transition(
    periodId,
    PayrollPeriodStatus.ATTENDANCE_REVIEW,
    actor,
    {},
    'PAYROLL_ATTENDANCE_REVIEW'
  );

export async function approvePeriod(periodId: string, actor: Actor) {
  await assertPeriodFinalizable(periodId);
  const settings = await loadSettings();
  if (settings.boolean('BLOCK_APPROVE_ON_MISSING_DATA')) {
    // Approval is the point at which the figures become real, so every row
    // whose amount is not final has to be resolved first - an unset wage rate
    // just as much as a missing punch. Calculation stays open to all of them;
    // only approval is gated.
    const blocking = await prisma.payrollEmployee.count({
      where: { periodId, status: { in: NON_FINAL_STATUSES } },
    });
    if (blocking > 0) {
      throw badRequest(
        `ยังมีพนักงาน ${blocking} คนที่ข้อมูลยังไม่ครบหรือยังไม่ได้กำหนดค่าจ้าง กรุณาตรวจสอบก่อนอนุมัติ`
      );
    }
  }

  return transition(
    periodId,
    PayrollPeriodStatus.APPROVED,
    actor,
    { approvedAt: new Date(), approvedBy: actor.userId },
    'PAYROLL_APPROVE'
  );
}

export async function markPaid(periodId: string, actor: Actor, paymentDate?: string) {
  await assertPeriodFinalizable(periodId);
  return transition(
    periodId,
    PayrollPeriodStatus.PAID,
    actor,
    {
      paidAt: new Date(),
      paidBy: actor.userId,
      ...(paymentDate ? { paymentDate: dayjs.utc(paymentDate).startOf('day').toDate() } : {}),
    },
    'PAYROLL_MARK_PAID'
  );
}

/**
 * Lock a period. After this, financial values are immutable and every
 * attendance row inside the period is frozen too, so the numbers stay
 * reproducible.
 */
export async function lockPeriod(periodId: string, actor: Actor) {
  await assertPeriodFinalizable(periodId);
  const period = await getPeriod(periodId);
  assertTransition(period.status, PayrollPeriodStatus.LOCKED);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.attendanceRecord.updateMany({
      where: { workDate: { gte: period.startDate, lte: period.endDate } },
      data: { isLocked: true },
    });
    return tx.payrollPeriod.update({
      where: { id: periodId },
      data: { status: PayrollPeriodStatus.LOCKED, lockedAt: new Date(), lockedBy: actor.userId },
    });
  });

  await recordAudit({
    action: 'PAYROLL_LOCK',
    entity: 'PayrollPeriod',
    entityId: periodId,
    oldValue: { status: period.status },
    newValue: { status: PayrollPeriodStatus.LOCKED },
    userId: actor.userId,
    userEmail: actor.email,
    ipAddress: actor.ip,
    userAgent: actor.userAgent,
  });

  return updated;
}

async function assertPeriodFinalizable(periodId: string): Promise<void> {
  const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId }, select: { endDate: true } });
  if (!period) throw notFound('Payroll period');
  const settings = await loadSettingsForDate(period.endDate);
  const clock = companyClock();
  const end = formatDateOnly(period.endDate);
  const endKey = settings.string('MONTHLY_WORK_END_TIME') ? 'MONTHLY_WORK_END_TIME' : 'WORK_END_TIME';
  const close = settings.timeMinutes(endKey) + Math.max(0, settings.number('ATTENDANCE_CLOSE_GRACE_MINUTES'));
  if (end > clock.date || (end === clock.date && clock.minutes < close)) {
    throw badRequest('รอบเงินเดือนยังไม่สิ้นสุดวันนี้ สามารถดูประมาณการได้ แต่ยังไม่สามารถอนุมัติ จ่าย หรือล็อก');
  }
}

/**
 * Unlock a locked period. SUPER_ADMIN only, a reason is mandatory, and the
 * action always produces an audit log entry.
 */
export async function unlockPeriod(periodId: string, reason: string, actor: Actor) {
  if (actor.role !== 'SUPER_ADMIN') {
    throw forbidden('เฉพาะ SUPER_ADMIN เท่านั้นที่สามารถปลดล็อกรอบเงินเดือนได้');
  }
  const period = await getPeriod(periodId);
  if (period.status !== PayrollPeriodStatus.LOCKED) {
    throw badRequest('รอบเงินเดือนนี้ไม่ได้ถูกล็อกอยู่');
  }
  if (!reason || reason.trim().length < 5) {
    throw badRequest('กรุณาระบุเหตุผลในการปลดล็อก (อย่างน้อย 5 ตัวอักษร)');
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.attendanceRecord.updateMany({
      where: { workDate: { gte: period.startDate, lte: period.endDate } },
      data: { isLocked: false },
    });
    return tx.payrollPeriod.update({
      where: { id: periodId },
      data: { status: PayrollPeriodStatus.PAID, lockedAt: null, lockedBy: null },
    });
  });

  await recordAudit({
    action: 'PAYROLL_UNLOCK',
    entity: 'PayrollPeriod',
    entityId: periodId,
    oldValue: { status: PayrollPeriodStatus.LOCKED },
    newValue: { status: PayrollPeriodStatus.PAID },
    reason,
    userId: actor.userId,
    userEmail: actor.email,
    ipAddress: actor.ip,
    userAgent: actor.userAgent,
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Payroll employees
// ---------------------------------------------------------------------------

export async function listPeriodEmployees(
  periodId: string,
  params: { page: number; pageSize: number; search?: string; departmentId?: string; status?: PayrollEmployeeStatus }
) {
  const where: Prisma.PayrollEmployeeWhereInput = {
    periodId,
    ...(params.status ? { status: params.status } : {}),
    ...(params.departmentId ? { employee: { departmentId: params.departmentId } } : {}),
    ...(params.search
      ? {
          OR: [
            { employeeCode: { contains: params.search } },
            { employeeName: { contains: params.search } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.payrollEmployee.findMany({
      where,
      orderBy: { employeeCode: 'asc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.payrollEmployee.count({ where }),
  ]);

  return { items, total, page: params.page, pageSize: params.pageSize };
}

export async function getPeriodEmployee(periodId: string, employeeId: string) {
  const row = await prisma.payrollEmployee.findUnique({
    where: { period_employee: { periodId, employeeId } },
    include: {
      incomes: { orderBy: { createdAt: 'asc' } },
      deductions: { orderBy: { createdAt: 'asc' } },
      adjustments: { orderBy: { changedAt: 'desc' } },
      employee: {
        include: { department: true, position: true, payrollPolicy: true },
      },
      period: true,
      payslip: { select: { id: true, payslipNo: true } },
    },
  });
  if (!row) throw notFound('Payroll employee');
  return row;
}

/** Summary cards for the payroll page. */
export async function periodSummary(periodId: string) {
  const period = await getPeriod(periodId);
  const grouped = await prisma.payrollEmployee.groupBy({
    by: ['status'],
    where: { periodId },
    _count: { _all: true },
  });

  const statusCounts: Record<string, number> = {
    READY: 0,
    PARTIAL: 0,
    UNCONFIGURED: 0,
    ATTENDANCE_INCOMPLETE: 0,
    NEEDS_REVIEW: 0,
    MISSING_DATA: 0,
    EXCLUDED: 0,
  };
  for (const row of grouped) statusCounts[row.status] = row._count._all;

  const totals = await prisma.payrollEmployee.aggregate({
    where: { periodId },
    _sum: {
      grossIncome: true,
      otAmount: true,
      totalDeduction: true,
      netSalary: true,
      workingHours: true,
      otHours: true,
    },
    _count: { _all: true },
  });

  return {
    period,
    employees: totals._count._all,
    grossTotal: money(totals._sum.grossIncome ?? 0).toFixed(2),
    otTotal: money(totals._sum.otAmount ?? 0).toFixed(2),
    deductionTotal: money(totals._sum.totalDeduction ?? 0).toFixed(2),
    netTotal: money(totals._sum.netSalary ?? 0).toFixed(2),
    workingHours: dec(totals._sum.workingHours ?? 0).toFixed(2),
    otHours: dec(totals._sum.otHours ?? 0).toFixed(2),
    ready: statusCounts.READY,
    // MISSING_DATA and NEEDS_REVIEW are legacy statuses; rows written before
    // per-employee readiness existed still carry them, so they are folded into
    // the counters their successors replaced rather than disappearing.
    partial: statusCounts.PARTIAL + statusCounts.NEEDS_REVIEW,
    unconfigured: statusCounts.UNCONFIGURED,
    attendanceIncomplete: statusCounts.ATTENDANCE_INCOMPLETE + statusCounts.MISSING_DATA,
    excluded: statusCounts.EXCLUDED,
    needsReview: statusCounts.NEEDS_REVIEW + statusCounts.PARTIAL,
    missingData: statusCounts.MISSING_DATA + statusCounts.ATTENDANCE_INCOMPLETE,
    statusCounts,
  };
}

/** Money fields that a payroll user may adjust by hand. */
const ADJUSTABLE_FIELDS = [
  'allowanceAmount',
  'bonusAmount',
  'commissionAmount',
  'otherIncome',
  'otAmount',
  'loanDeduction',
  'otherDeduction',
  'lateDeduction',
  'leaveDeduction',
  'absenceDeduction',
  'socialSecurity',
  'tax',
] as const;

export type AdjustableField = (typeof ADJUSTABLE_FIELDS)[number];

/**
 * How each adjustable header field maps onto an itemised payslip line, so an
 * override rewrites the corresponding line rather than leaving the lines and
 * the totals disagreeing.
 */
const ADJUSTABLE_FIELD_LINES: Record<
  AdjustableField,
  { kind: PayrollItemKind; label: string; side: 'income' | 'deduction' }
> = {
  allowanceAmount: { kind: PayrollItemKind.ALLOWANCE, label: 'เบี้ยเลี้ยง / ค่าตำแหน่ง', side: 'income' },
  bonusAmount: { kind: PayrollItemKind.BONUS, label: 'โบนัส', side: 'income' },
  commissionAmount: { kind: PayrollItemKind.COMMISSION, label: 'ค่าคอมมิชชั่น', side: 'income' },
  otherIncome: { kind: PayrollItemKind.OTHER_INCOME, label: 'รายได้อื่น ๆ', side: 'income' },
  otAmount: { kind: PayrollItemKind.OT, label: 'ค่าล่วงเวลา (ปรับปรุง)', side: 'income' },
  loanDeduction: { kind: PayrollItemKind.LOAN, label: 'หักเงินกู้', side: 'deduction' },
  otherDeduction: { kind: PayrollItemKind.OTHER_DEDUCTION, label: 'หักอื่น ๆ', side: 'deduction' },
  lateDeduction: { kind: PayrollItemKind.LATE, label: 'หักมาสาย (ปรับปรุง)', side: 'deduction' },
  leaveDeduction: { kind: PayrollItemKind.LEAVE, label: 'หักลา (ปรับปรุง)', side: 'deduction' },
  absenceDeduction: { kind: PayrollItemKind.ABSENCE, label: 'หักขาดงาน (ปรับปรุง)', side: 'deduction' },
  socialSecurity: { kind: PayrollItemKind.SOCIAL_SECURITY, label: 'ประกันสังคม', side: 'deduction' },
  tax: { kind: PayrollItemKind.TAX, label: 'ภาษีหัก ณ ที่จ่าย', side: 'deduction' },
};

export interface AdjustmentInput {
  field: AdjustableField;
  value: string;
  reason: string;
}

/**
 * Apply manual adjustments to a payroll employee.
 * Totals are recomputed from the adjusted parts, and every field change writes a
 * PayrollAdjustment row carrying changed_by / changed_at / old_value / new_value / reason.
 */
export async function adjustPayrollEmployee(
  periodId: string,
  employeeId: string,
  adjustments: AdjustmentInput[],
  actor: Actor
) {
  const period = await getPeriod(periodId);
  assertNotLocked(period.status);
  assertFinanciallyEditable(period.status);

  const row = await prisma.payrollEmployee.findUnique({
    where: { period_employee: { periodId, employeeId } },
  });
  if (!row) throw notFound('Payroll employee');

  const next: Record<AdjustableField, Decimal> = {
    allowanceAmount: dec(row.allowanceAmount),
    bonusAmount: dec(row.bonusAmount),
    commissionAmount: dec(row.commissionAmount),
    otherIncome: dec(row.otherIncome),
    otAmount: dec(row.otAmount),
    loanDeduction: dec(row.loanDeduction),
    otherDeduction: dec(row.otherDeduction),
    lateDeduction: dec(row.lateDeduction),
    leaveDeduction: dec(row.leaveDeduction),
    absenceDeduction: dec(row.absenceDeduction),
    socialSecurity: dec(row.socialSecurity),
    tax: dec(row.tax),
  };

  const changes: { fieldName: string; oldValue: string; newValue: string; reason: string }[] = [];

  for (const adj of adjustments) {
    if (!ADJUSTABLE_FIELDS.includes(adj.field)) {
      throw badRequest(`ไม่สามารถแก้ไขฟิลด์ ${adj.field} ได้`);
    }
    const oldValue = next[adj.field];
    const newValue = money(adj.value);
    if (oldValue.equals(newValue)) continue;
    next[adj.field] = newValue;
    changes.push({
      fieldName: adj.field,
      oldValue: oldValue.toFixed(2),
      newValue: newValue.toFixed(2),
      reason: adj.reason,
    });
  }

  if (changes.length === 0) return row;

  const grossIncome = money(
    dec(row.baseSalary)
      .plus(next.otAmount)
      .plus(next.allowanceAmount)
      .plus(next.bonusAmount)
      .plus(next.commissionAmount)
      .plus(next.otherIncome)
  );
  const totalDeduction = money(
    next.lateDeduction
      .plus(next.leaveDeduction)
      .plus(next.absenceDeduction)
      .plus(next.socialSecurity)
      .plus(next.tax)
      .plus(next.loanDeduction)
      .plus(next.otherDeduction)
  );
  const netSalary = money(grossIncome.minus(totalDeduction));

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.payrollEmployee.update({
      where: { id: row.id },
      data: {
        allowanceAmount: toPrismaDecimal(next.allowanceAmount),
        bonusAmount: toPrismaDecimal(next.bonusAmount),
        commissionAmount: toPrismaDecimal(next.commissionAmount),
        otherIncome: toPrismaDecimal(next.otherIncome),
        otAmount: toPrismaDecimal(next.otAmount),
        loanDeduction: toPrismaDecimal(next.loanDeduction),
        otherDeduction: toPrismaDecimal(next.otherDeduction),
        lateDeduction: toPrismaDecimal(next.lateDeduction),
        leaveDeduction: toPrismaDecimal(next.leaveDeduction),
        absenceDeduction: toPrismaDecimal(next.absenceDeduction),
        socialSecurity: toPrismaDecimal(next.socialSecurity),
        tax: toPrismaDecimal(next.tax),
        grossIncome: toPrismaDecimal(grossIncome),
        totalDeduction: toPrismaDecimal(totalDeduction),
        netSalary: toPrismaDecimal(netSalary),
        hasAdjustment: true,
        // A human has now put a figure on this row, so it is no longer raw
        // incomplete data - but it is still not a settled amount.
        status: NON_FINAL_STATUSES.includes(row.status)
          ? PayrollEmployeeStatus.PARTIAL
          : row.status,
      },
    });

    await tx.payrollAdjustment.createMany({
      data: changes.map((c) => ({
        payrollEmployeeId: row.id,
        fieldName: c.fieldName,
        oldValue: c.oldValue,
        newValue: c.newValue,
        reason: c.reason,
        changedBy: actor.userId,
      })),
    });

    // Keep the itemised lines reconciled with the adjusted header totals.
    // Without this the payslip would print income lines that do not sum to the
    // gross it states, which is exactly the kind of discrepancy an employee
    // notices first.
    for (const change of changes) {
      const spec = ADJUSTABLE_FIELD_LINES[change.fieldName as AdjustableField];
      if (!spec) continue;

      const amount = next[change.fieldName as AdjustableField];
      const where = { payrollEmployeeId: row.id, kind: spec.kind };
      const data = {
        payrollEmployeeId: row.id,
        kind: spec.kind,
        label: spec.label,
        amount: toPrismaDecimal(amount),
        isManual: true,
        note: change.reason,
        createdBy: actor.userId,
      };

      // Replace every line of this kind (system-generated or previously
      // adjusted) with a single manual line carrying the new amount.
      if (spec.side === 'income') {
        await tx.payrollIncome.deleteMany({ where });
        if (amount.greaterThan(0)) await tx.payrollIncome.create({ data });
      } else {
        await tx.payrollDeduction.deleteMany({ where });
        if (amount.greaterThan(0)) await tx.payrollDeduction.create({ data });
      }
    }

    return result;
  });

  await refreshPeriodTotals(periodId);

  await recordAudit({
    action: 'PAYROLL_EMPLOYEE_ADJUSTMENT',
    entity: 'PayrollEmployee',
    entityId: row.id,
    oldValue: Object.fromEntries(changes.map((c) => [c.fieldName, c.oldValue])),
    newValue: Object.fromEntries(changes.map((c) => [c.fieldName, c.newValue])),
    reason: changes.map((c) => c.reason).join(' | '),
    userId: actor.userId,
    userEmail: actor.email,
    ipAddress: actor.ip,
    userAgent: actor.userAgent,
  });

  return updated;
}

/** Mark an individual payroll row as reviewed and ready to pay. */
export async function setPayrollEmployeeStatus(
  periodId: string,
  employeeId: string,
  status: PayrollEmployeeStatus,
  actor: Actor
) {
  const period = await getPeriod(periodId);
  assertNotLocked(period.status);

  const row = await prisma.payrollEmployee.findUnique({
    where: { period_employee: { periodId, employeeId } },
  });
  if (!row) throw notFound('Payroll employee');

  const updated = await prisma.payrollEmployee.update({
    where: { id: row.id },
    data: { status },
  });

  await recordAudit({
    action: 'PAYROLL_EMPLOYEE_STATUS',
    entity: 'PayrollEmployee',
    entityId: row.id,
    oldValue: { status: row.status },
    newValue: { status },
    userId: actor.userId,
    userEmail: actor.email,
    ipAddress: actor.ip,
    userAgent: actor.userAgent,
  });

  return updated;
}

/** Recompute the period-level totals from the employee rows. */
export async function refreshPeriodTotals(periodId: string) {
  const totals = await prisma.payrollEmployee.aggregate({
    where: { periodId },
    _sum: { grossIncome: true, otAmount: true, totalDeduction: true, netSalary: true },
    _count: { _all: true },
  });

  return prisma.payrollPeriod.update({
    where: { id: periodId },
    data: {
      totalEmployees: totals._count._all,
      grossTotal: toPrismaDecimal(totals._sum.grossIncome ?? 0),
      otTotal: toPrismaDecimal(totals._sum.otAmount ?? 0),
      deductionTotal: toPrismaDecimal(totals._sum.totalDeduction ?? 0),
      netTotal: toPrismaDecimal(totals._sum.netSalary ?? 0),
    },
  });
}

/** Settings actually used for a period: the frozen snapshot when present. */
export async function periodSettings(periodId: string) {
  const period = await getPeriod(periodId);
  return period.settingsSnapshot
    ? settingsFromSnapshot(period.settingsSnapshot as SettingsMap)
    : loadSettings();
}

export const PAYROLL_ITEM_KINDS = PayrollItemKind;
