import {
  EmploymentType,
  type AttendanceRecord,
  type Employee,
  type EmployeePayProfile,
  type EmployeePayrollPolicy,
} from '@prisma/client';
import { prisma } from '../plugins/prisma.js';
import { Decimal, dec, money } from '../utils/money.js';
import { formatDateOnly } from '../utils/datetime.js';
import { eachDay } from '../utils/datetime.js';
import { loadSettingsForDate, type PayrollSettings } from './settings.service.js';
import { rateForDate } from './daily-earnings.service.js';
import { priceAbsenceDeduction, priceLateDeduction } from '../utils/deduction-pricing.js';
import {
  calculateRoundedWorkTime,
  roundDownMinutes,
  roundingIntervalMinutes,
  workTimePolicy,
} from '../utils/time-rounding.js';
import { isUsableProfile } from './payroll-employee-context.service.js';

/**
 * What one attendance day was worth to one employee.
 *
 * The Attendance table shows this as "ได้เงินวันนี้". It is deliberately an
 * *attendance-level* figure, not a slice of a payslip:
 *
 *   - DAILY staff are genuinely paid per day, so this is real money. Summing a
 *     period's days reproduces the DAILY base pay the payroll run computes,
 *     because both go through daily-earnings.service.
 *
 *   - MONTHLY staff are not paid per day. Their figure is the informational
 *     value of that date - salary / divisor, less the deductions that date
 *     caused. It must never be summed to reconstruct a monthly salary: the
 *     divisor is a fixed 30 while a month has a variable number of working
 *     days, so the sum will not equal the salary and is not meant to.
 *
 * Monthly payroll-level amounts - social security and withholding tax - are
 * NEVER spread across days here. They are monthly obligations, not daily ones,
 * and dividing them by a day count would invent a number the company has not
 * agreed to. Only deductions genuinely attributable to the date itself apply.
 */

export type DailyPayStatus = 'CALCULATED' | 'UNCONFIGURED' | 'NOT_APPLICABLE';

export interface DailyPay {
  /** What the day was worth before any deduction the day itself caused. */
  gross: string;
  /** Late + leave + absence attributable to this date. Never SSO or tax. */
  attendanceDeduction: string;
  net: string;
  status: DailyPayStatus;
  /** Rate the day was valued at: hourly for DAILY, daily base for MONTHLY. */
  basis: string | null;
  basisKind: 'HOURLY_RATE' | 'DAILY_BASE' | null;
  lateDeduction: string;
  leaveDeduction: string;
  absenceDeduction: string;
  /** Whole hours charged for lateness, so a tooltip can explain the amount. */
  lateChargedHours: number;
  /**
   * DAILY only. The unpaid break removed and the minutes actually paid for,
   * so the cell can explain why 8h44m was paid as 7h30m. The record's own
   * worked minutes stay the true observed duration.
   */
  breakDeductionMinutes: number;
  minutesBeforeRounding: number;
  roundedAwayMinutes: number;
  payableMinutes: number;
  /** MONTHLY: lateness observed and after the company floor. */
  lateMinutesActual: number;
  lateMinutesRounded: number;
  /** Why the value is not a calculated amount, when it is not. */
  note: string | null;
}

const ZERO: Omit<DailyPay, 'status' | 'note'> = {
  gross: '0.00',
  attendanceDeduction: '0.00',
  net: '0.00',
  basis: null,
  basisKind: null,
  lateDeduction: '0.00',
  leaveDeduction: '0.00',
  absenceDeduction: '0.00',
  lateChargedHours: 0,
  breakDeductionMinutes: 0,
  minutesBeforeRounding: 0,
  roundedAwayMinutes: 0,
  payableMinutes: 0,
  lateMinutesActual: 0,
  lateMinutesRounded: 0,
};

const notApplicable = (note: string | null = null): DailyPay => ({
  ...ZERO,
  status: 'NOT_APPLICABLE',
  note,
});

const unconfigured = (note: string): DailyPay => ({ ...ZERO, status: 'UNCONFIGURED', note });

export interface ValuationEmployee {
  employmentType: EmploymentType;
  attendanceRequired: boolean;
}

export interface ValuationInput {
  record: Pick<
    AttendanceRecord,
    'workDate' | 'workedMinutes' | 'lateMinutes' | 'isAbsent' | 'isHoliday' | 'isWeekend'
  > & {
    /** Widened past AttendanceStatus: the list view substitutes the computed
     *  IN_PROGRESS for a day that is still open, and valuation must see it. */
    status: string;
  };
  employee: ValuationEmployee;
  profiles: EmployeePayProfile[];
  policy: EmployeePayrollPolicy | null;
  /** True when this date falls inside an approved leave that is not paid. */
  isUnpaidLeaveDay: boolean;
  settings: PayrollSettings;
}

/**
 * Pure valuation of a single day. No I/O, so it is directly unit-testable and
 * is the one definition of what a day is worth.
 */
export function valueAttendanceDay(input: ValuationInput): DailyPay {
  const { record, employee, policy, settings } = input;

  // Staff whose pay does not depend on attendance have no per-day value to show.
  if (!employee.attendanceRequired) {
    return notApplicable('พนักงานยกเว้นการลงเวลา');
  }

  // A holiday or a non-scheduled day with no work has no day value. Showing 0
  // would read as "earned nothing today" rather than "today is not a work day".
  if (record.isHoliday) return notApplicable('วันหยุด');
  if (record.isWeekend && record.workedMinutes === 0) return notApplicable('วันหยุดประจำสัปดาห์');

  // One punch present and the other missing: the duration is unknown, so any
  // figure would be a guess. The Attendance page already flags the day.
  if (record.status === 'MISSING_DATA' || record.status === 'IN_PROGRESS') {
    return notApplicable('ข้อมูลเวลายังไม่ครบ');
  }

  const usable = input.profiles.filter((p) => isUsableProfile(p, employee.employmentType));

  // A profile that exists but is the wrong kind for this employment type is the
  // confusing case: the operator set a rate and the system still says
  // "unconfigured". It happens when someone's employment type is changed after
  // their pay was configured, which orphans the old profile. Saying so beats
  // leaving them to wonder whether the save failed.
  const mismatched = usable.length === 0 && input.profiles.length > 0;

  if (
    employee.employmentType === EmploymentType.DAILY ||
    employee.employmentType === EmploymentType.HOURLY
  ) {
    return valueHourlyDay(input, usable, mismatched);
  }
  return valueMonthlyDay(input, usable, policy, settings, mismatched);
}

/**
 * DAILY / HOURLY: the day is worth the minutes actually worked at the rate in
 * force on that date.
 *
 * No absence or leave deduction is applied. An hourly employee who did not work
 * simply earned nothing that day - the zero is already the whole story, and
 * deducting a day's pay on top would charge them twice for one absence.
 * Lateness is not charged either: daily staff carry no lateness compliance
 * under current company policy, and their pay already reflects the shorter day.
 */
function valueHourlyDay(
  input: ValuationInput,
  usable: EmployeePayProfile[],
  mismatched: boolean
): DailyPay {
  const profile = rateForDate(usable, input.record.workDate);
  if (!profile) {
    return unconfigured(
      mismatched
        ? 'อัตราค่าจ้างที่บันทึกไว้เป็นแบบรายเดือน ไม่ตรงกับพนักงานรายวัน กรุณากำหนดอัตราต่อชั่วโมงใหม่'
        : 'ยังไม่ได้กำหนดอัตราค่าจ้างสำหรับวันที่นี้'
    );
  }

  const rate = dec(profile.hourlyRate);

  // The same helper the payroll run uses, so this cell and the payslip can
  // never price the same day differently: a day over the threshold loses its
  // unpaid break, and the remainder is floored to the rounding increment.
  const time = calculateRoundedWorkTime(input.record.workedMinutes, workTimePolicy(input.settings));

  // 450 payable minutes at 75 THB/h -> 450/60 x 75 = 562.50, on Decimal.
  const gross = money(dec(time.payableMinutes).dividedBy(60).times(rate));

  return {
    gross: gross.toFixed(2),
    attendanceDeduction: '0.00',
    net: gross.toFixed(2),
    status: 'CALCULATED',
    basis: money(rate).toFixed(2),
    basisKind: 'HOURLY_RATE',
    lateDeduction: '0.00',
    leaveDeduction: '0.00',
    absenceDeduction: '0.00',
    lateChargedHours: 0,
    breakDeductionMinutes: time.breakDeductionMinutes,
    minutesBeforeRounding: time.minutesBeforeRounding,
    roundedAwayMinutes: time.roundedAwayMinutes,
    payableMinutes: time.payableMinutes,
    lateMinutesActual: 0,
    lateMinutesRounded: 0,
    note: null,
  };
}

/**
 * MONTHLY / CONTRACT: an informational day value.
 *
 * gross is the daily base (salary / MONTHLY_SALARY_DAY_DIVISOR, normally 30),
 * and only deductions this date itself caused are subtracted. Social security
 * and tax are monthly payroll-level amounts and are deliberately absent.
 */
function valueMonthlyDay(
  input: ValuationInput,
  usable: EmployeePayProfile[],
  policy: EmployeePayrollPolicy | null,
  settings: PayrollSettings,
  mismatched: boolean
): DailyPay {
  const profile = usable.length
    ? usable.reduce((best, p) => (p.effectiveFrom > best.effectiveFrom ? p : best))
    : null;
  if (!profile) {
    return unconfigured(
      mismatched
        ? 'อัตราค่าจ้างที่บันทึกไว้เป็นแบบรายชั่วโมง ไม่ตรงกับพนักงานรายเดือน กรุณากำหนดเงินเดือนใหม่'
        : 'ยังไม่ได้กำหนดเงินเดือน'
    );
  }

  const divisor = salaryDayDivisor(settings);
  if (divisor.lessThanOrEqualTo(0)) return unconfigured('ตัวหารเงินเดือนต่อวันไม่ถูกต้อง');
  const paidHours = paidHoursPerDay(settings);

  // 18,000 / 30 = 600 a day; 600 / 8 = 75 an hour.
  const dailyBase = money(dec(profile.monthlySalary).dividedBy(divisor));
  const hourlyBase = paidHours.greaterThan(0)
    ? money(dailyBase.dividedBy(paidHours))
    : new Decimal(0);

  // Per-day lateness, floored on the company interval before it reaches money.
  const lateRounding = roundDownMinutes(
    input.record.lateMinutes,
    roundingIntervalMinutes(settings)
  );
  const late = priceLateDeduction(policy, settings, {
    lateMinutes: input.record.lateMinutes,
    roundedLateMinutes: lateRounding.roundedMinutes,
    lateCount: input.record.lateMinutes > 0 ? 1 : 0,
    hourlyBase,
    hourlyRate: hourlyBase,
  });

  const leave = input.isUnpaidLeaveDay
    ? priceAbsenceDeduction(
        policy?.leaveDeductionType
          ? { ...policy, absenceDeductionType: policy.leaveDeductionType, absenceDeductionAmount: policy.leaveDeductionAmount }
          : null,
        settings,
        { days: 1, dailyBase, dailyRate: dailyBase }
      )
    : new Decimal(0);

  const absence = input.record.isAbsent
    ? priceAbsenceDeduction(policy, settings, { days: 1, dailyBase, dailyRate: dailyBase })
    : new Decimal(0);

  const deduction = money(late.amount.plus(leave).plus(absence));
  const net = money(dailyBase.minus(deduction));

  return {
    gross: dailyBase.toFixed(2),
    attendanceDeduction: deduction.toFixed(2),
    net: net.toFixed(2),
    status: 'CALCULATED',
    basis: dailyBase.toFixed(2),
    basisKind: 'DAILY_BASE',
    lateDeduction: money(late.amount).toFixed(2),
    leaveDeduction: money(leave).toFixed(2),
    absenceDeduction: money(absence).toFixed(2),
    lateChargedHours: late.chargedHours,
    // Monthly staff are not paid by the hour; the daily break and the
    // 15-minute floor are DAILY rules and never apply here.
    breakDeductionMinutes: 0,
    minutesBeforeRounding: 0,
    roundedAwayMinutes: 0,
    payableMinutes: 0,
    lateMinutesActual: input.record.lateMinutes,
    lateMinutesRounded: lateRounding.roundedMinutes,
    note: null,
  };
}

/** Fixed company divisor, so an absence costs the same in February as in March. */
function salaryDayDivisor(settings: PayrollSettings): Decimal {
  const configured = settings.decimal('MONTHLY_SALARY_DAY_DIVISOR');
  return configured.greaterThan(0) ? configured : settings.decimal('STANDARD_WORK_DAYS');
}

function paidHoursPerDay(settings: PayrollSettings): Decimal {
  const configured = settings.decimal('STANDARD_PAID_HOURS_PER_DAY');
  return configured.greaterThan(0) ? configured : settings.decimal('STANDARD_WORK_HOURS');
}

// ---------------------------------------------------------------------------
// Batch valuation for a list of attendance rows
// ---------------------------------------------------------------------------

type ValuableRecord = ValuationInput['record'] & { id: string; employeeId: string };

/**
 * Value many attendance rows at once, for the Attendance table.
 *
 * Pay profiles, payroll policies and unpaid-leave days are fetched once for the
 * whole page rather than per row - the table is polled, and a per-row query
 * would turn one page view into a few hundred round trips.
 */
export async function valueAttendanceRecords(
  records: ValuableRecord[],
  employeesById: Map<string, Pick<Employee, 'id' | 'employmentType' | 'attendanceRequired'>>
): Promise<Map<string, DailyPay>> {
  const result = new Map<string, DailyPay>();
  if (records.length === 0) return result;

  const employeeIds = [...new Set(records.map((r) => r.employeeId))];
  const dates = records.map((r) => r.workDate.getTime());
  const from = new Date(Math.min(...dates));
  const to = new Date(Math.max(...dates));

  const [profiles, policies, leaves] = await Promise.all([
    prisma.employeePayProfile.findMany({
      where: {
        employeeId: { in: employeeIds },
        isActive: true,
        effectiveFrom: { lte: to },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
      },
      orderBy: { effectiveFrom: 'asc' },
    }),
    prisma.employeePayrollPolicy.findMany({ where: { employeeId: { in: employeeIds } } }),
    prisma.leaveRecord.findMany({
      where: {
        employeeId: { in: employeeIds },
        status: 'APPROVED',
        isPaid: false,
        startDate: { lte: to },
        endDate: { gte: from },
      },
      select: { employeeId: true, startDate: true, endDate: true },
    }),
  ]);

  const profilesByEmployee = new Map<string, EmployeePayProfile[]>();
  for (const profile of profiles) {
    const list = profilesByEmployee.get(profile.employeeId) ?? [];
    list.push(profile);
    profilesByEmployee.set(profile.employeeId, list);
  }
  const policyByEmployee = new Map(policies.map((p) => [p.employeeId, p]));

  const unpaidLeaveDays = new Set<string>();
  for (const leave of leaves) {
    for (const day of eachDay(leave.startDate, leave.endDate)) {
      unpaidLeaveDays.add(`${leave.employeeId}|${formatDateOnly(day)}`);
    }
  }

  // Settings are resolved per work date because the work-schedule profile that
  // applies can differ across a range that spans a policy change.
  const settingsByDate = new Map<string, PayrollSettings>();
  for (const key of new Set(records.map((r) => formatDateOnly(r.workDate)))) {
    settingsByDate.set(key, await loadSettingsForDate(new Date(`${key}T00:00:00.000Z`)));
  }

  for (const record of records) {
    const employee = employeesById.get(record.employeeId);
    if (!employee) {
      result.set(record.id, notApplicable(null));
      continue;
    }
    const dateKey = formatDateOnly(record.workDate);
    result.set(
      record.id,
      valueAttendanceDay({
        record,
        employee: {
          employmentType: employee.employmentType,
          attendanceRequired: employee.attendanceRequired,
        },
        profiles: profilesByEmployee.get(record.employeeId) ?? [],
        policy: policyByEmployee.get(record.employeeId) ?? null,
        isUnpaidLeaveDay: unpaidLeaveDays.has(`${record.employeeId}|${dateKey}`),
        settings: settingsByDate.get(dateKey)!,
      })
    );
  }

  return result;
}
