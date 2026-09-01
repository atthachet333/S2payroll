import { EmploymentType, PayType, type EmployeePayProfile } from '@prisma/client';
import { prisma } from '../plugins/prisma.js';
import { dayjs } from '../utils/datetime.js';
import { notFound } from '../utils/errors.js';
import { loadSettingsForDate } from './settings.service.js';
import { Decimal, dec, money } from '../utils/money.js';
import { formatDateOnly } from '../utils/datetime.js';
import {
  DEFAULT_WORK_TIME_POLICY,
  calculateRoundedWorkTime,
  workTimePolicy,
  type WorkTimePolicy,
} from '../utils/time-rounding.js';

/**
 * Per-day earnings for staff paid by the hour (employmentType DAILY / HOURLY).
 *
 * Two rules drive this module, and both are deliberate:
 *
 *  1. Pay comes from the *stored* effective worked minutes on the attendance
 *     record. Payroll never re-derives a duration from the raw punches - the
 *     attendance engine owns that, corrections and suppressions included, and a
 *     second implementation would eventually disagree with the first.
 *
 *  2. The rate is the one in force on that work date, not the rate in force
 *     today. A rise on 16 August must not reprice the first fortnight.
 *
 *  3. Money is priced from *payable* minutes, not from worked minutes: a day
 *     over eight hours loses an unpaid break, and what remains is floored to a
 *     15-minute increment. Both rules live in daily-payable-time.ts and are
 *     applied only here, so no caller can price a day a different way. The
 *     worked minutes themselves are reported untouched alongside.
 *
 * A day with no rate in force is reported with its worked minutes and a null
 * rate. It contributes no money and is counted as unrated, so the caller can
 * mark the employee incomplete instead of paying a fabricated amount.
 */

export interface DailyEarningSource {
  workDate: Date;
  checkIn: Date | null;
  checkOut: Date | null;
  workedMinutes: number;
  status: string;
}

export interface DailyEarningRow {
  workDate: string;
  checkIn: Date | null;
  checkOut: Date | null;
  /** The true observed duration. Never replaced by the payable figure. */
  workedMinutes: number;
  /** Unpaid break removed because the day ran past the threshold. */
  breakDeductionMinutes: number;
  /** workedMinutes - break, before the floor. */
  minutesBeforeRounding: number;
  /** What the floor discarded. Shown so the difference is explainable. */
  roundedAwayMinutes: number;
  /** The minutes actually paid for. This, not workedMinutes, drives money. */
  payableMinutes: number;
  /** Rate in force on this work date, or null when none covers the day. */
  hourlyRate: Decimal | null;
  /** payableMinutes / 60 x hourlyRate, or 0 when the day carries no rate. */
  amount: Decimal;
  rateConfigured: boolean;
  status: string;
}

export interface DailyEarningsSummary {
  rows: DailyEarningRow[];
  /** Days with recorded work, whether or not a rate covered them. */
  workedDays: number;
  /** Sum of the true observed durations. */
  totalWorkedMinutes: number;
  /** Sum of the unpaid breaks removed across the period. */
  totalBreakDeductionMinutes: number;
  /** Sum of the minutes actually paid for. */
  totalPayableMinutes: number;
  /** Sum of what the company floor discarded. */
  totalRoundedAwayMinutes: number;
  /** Worked minutes that a rate actually covered. */
  ratedMinutes: number;
  /** Worked minutes with no rate in force. Money for these is not invented. */
  unratedMinutes: number;
  unratedDays: number;
  /** The period total, rounded once from the precise sum. */
  totalAmount: Decimal;
  /**
   * The unrounded sum. Exposed so a caller that aggregates further does not
   * have to re-introduce the drift this class exists to avoid.
   */
  preciseTotal: Decimal;
}

/** The hourly profile covering `date`, most recent effectiveFrom first. */
export function rateForDate(
  profiles: EmployeePayProfile[],
  date: Date
): EmployeePayProfile | null {
  const covering = profiles.filter(
    (p) =>
      p.isActive &&
      p.payType === PayType.HOURLY &&
      p.hourlyRate !== null &&
      dec(p.hourlyRate).greaterThan(0) &&
      p.effectiveFrom <= date &&
      (p.effectiveTo === null || p.effectiveTo >= date)
  );
  if (covering.length === 0) return null;
  return covering.reduce((best, p) => (p.effectiveFrom > best.effectiveFrom ? p : best));
}

export function computeDailyEarnings(
  records: DailyEarningSource[],
  profiles: EmployeePayProfile[],
  policy: WorkTimePolicy = DEFAULT_WORK_TIME_POLICY
): DailyEarningsSummary {
  const rows: DailyEarningRow[] = [];
  // Accumulated at full precision and rounded once at the end. Rounding each
  // day and summing the rounded figures drifts: 6 days of 6.4166... hours at
  // 93.75 sums to 3,609.375 precisely, which is 3,609.38 - but adding six
  // already-rounded amounts can land a cent away from it.
  let preciseTotal = new Decimal(0);
  let totalWorkedMinutes = 0;
  let totalBreakDeductionMinutes = 0;
  let totalPayableMinutes = 0;
  let totalRoundedAwayMinutes = 0;
  let ratedMinutes = 0;
  let unratedMinutes = 0;
  let unratedDays = 0;
  let workedDays = 0;

  const ordered = [...records].sort((a, b) => a.workDate.getTime() - b.workDate.getTime());

  for (const record of ordered) {
    const profile = rateForDate(profiles, record.workDate);
    const rate = profile ? dec(profile.hourlyRate) : null;

    // The one place a daily duration becomes payable time. A day over the
    // threshold loses its unpaid break, then the remainder is floored.
    const time = calculateRoundedWorkTime(record.workedMinutes, policy);

    // 450 payable minutes at 75 THB/h -> 450/60 x 75 = 562.50. The division is
    // on Decimal, so 35 minutes at 93 THB/h is 54.25, not 54.249999999999996.
    const precise =
      rate === null ? new Decimal(0) : dec(time.payableMinutes).dividedBy(60).times(rate);
    // The row displays a rounded amount; the total is built from the precise one.
    const amount = money(precise);

    rows.push({
      workDate: formatDateOnly(record.workDate),
      checkIn: record.checkIn,
      checkOut: record.checkOut,
      workedMinutes: time.actualMinutes,
      breakDeductionMinutes: time.breakDeductionMinutes,
      minutesBeforeRounding: time.minutesBeforeRounding,
      roundedAwayMinutes: time.roundedAwayMinutes,
      payableMinutes: time.payableMinutes,
      hourlyRate: rate,
      amount,
      rateConfigured: rate !== null,
      status: record.status,
    });

    totalWorkedMinutes += time.actualMinutes;
    totalBreakDeductionMinutes += time.breakDeductionMinutes;
    if (time.actualMinutes > 0) workedDays += 1;
    if (rate === null) {
      unratedMinutes += time.actualMinutes;
      if (time.actualMinutes > 0) unratedDays += 1;
    } else {
      ratedMinutes += time.actualMinutes;
      totalPayableMinutes += time.payableMinutes;
      totalRoundedAwayMinutes += time.roundedAwayMinutes;
      preciseTotal = preciseTotal.plus(precise);
    }
  }

  return {
    rows,
    workedDays,
    totalWorkedMinutes,
    totalBreakDeductionMinutes,
    totalPayableMinutes,
    totalRoundedAwayMinutes,
    ratedMinutes,
    unratedMinutes,
    unratedDays,
    totalAmount: money(preciseTotal),
    preciseTotal,
  };
}

/**
 * One employee's per-day earnings for a calendar month, ready for display.
 *
 * Used by the employee page to answer "what did this person actually earn on
 * each day, and what does that add up to". Monthly staff get a null summary -
 * their pay does not come from a day count, and showing one would invite the
 * reader to add it up and expect it to match their salary.
 */
export async function employeeDailyEarnings(employeeId: string, year: number, month: number) {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, employeeCode: true, employmentType: true },
  });
  if (!employee) throw notFound('Employee');

  const start = dayjs.utc(`${year}-${String(month).padStart(2, '0')}-01`).startOf('month');
  const end = start.endOf('month').startOf('day');

  const hourly =
    employee.employmentType === EmploymentType.DAILY ||
    employee.employmentType === EmploymentType.HOURLY;

  const [records, profiles] = await Promise.all([
    prisma.attendanceRecord.findMany({
      where: { employeeId, workDate: { gte: start.toDate(), lte: end.toDate() } },
      orderBy: { workDate: 'asc' },
    }),
    prisma.employeePayProfile.findMany({
      where: {
        employeeId,
        isActive: true,
        effectiveFrom: { lte: end.toDate() },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: start.toDate() } }],
      },
      orderBy: { effectiveFrom: 'asc' },
    }),
  ]);

  if (!hourly) {
    return {
      employeeId,
      employmentType: employee.employmentType,
      applicable: false as const,
      year,
      month,
      rows: [],
      summary: null,
    };
  }

  const settings = await loadSettingsForDate(end.toDate());
  const summary = computeDailyEarnings(records, profiles, workTimePolicy(settings));
  return {
    employeeId,
    employmentType: employee.employmentType,
    applicable: true as const,
    year,
    month,
    rows: summary.rows.map((row) => ({
      ...row,
      hourlyRate: row.hourlyRate ? row.hourlyRate.toFixed(2) : null,
      amount: row.amount.toFixed(2),
    })),
    summary: {
      workedDays: summary.workedDays,
      totalWorkedMinutes: summary.totalWorkedMinutes,
      totalBreakDeductionMinutes: summary.totalBreakDeductionMinutes,
      totalPayableMinutes: summary.totalPayableMinutes,
      totalRoundedAwayMinutes: summary.totalRoundedAwayMinutes,
      ratedMinutes: summary.ratedMinutes,
      unratedMinutes: summary.unratedMinutes,
      unratedDays: summary.unratedDays,
      totalAmount: summary.totalAmount.toFixed(2),
    },
  };
}
