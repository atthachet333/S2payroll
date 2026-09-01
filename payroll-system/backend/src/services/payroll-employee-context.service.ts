import {
  EmploymentType,
  PayType,
  type AttendanceRecord,
  type Department,
  type Employee,
  type EmployeePayProfile,
  type EmployeePayrollPolicy,
  type PayrollPeriod,
  type Position,
} from '@prisma/client';
import { prisma } from '../plugins/prisma.js';
import { dec } from '../utils/money.js';
import { companyClock, eachDay, formatDateOnly } from '../utils/datetime.js';
import { isScheduledWorkday } from './schedule-policy.service.js';
import { loadSettingsForDate, type PayrollSettings } from './settings.service.js';
import { effectiveEmploymentStart, payrollEligibleEmployeeWhere } from './employee-payroll-eligibility.service.js';
import { payrollPoliciesByEmployee } from './employee-payroll-policy.service.js';
import { computeDailyEarnings, type DailyEarningsSummary } from './daily-earnings.service.js';
import { attendanceCloseMinutes, classifyOpenPunch } from '../utils/attendance-window.js';
import { workTimePolicy } from '../utils/time-rounding.js';

/**
 * Everything one payroll period needs to know about one employee, gathered once
 * and shared by the readiness screen and the calculator.
 *
 * The point of this module is that both of those answer the same question -
 * can this person be paid, and out of what - and they must never answer it
 * differently. Loading the inputs in one place, from one set of queries, makes
 * that structural rather than a matter of keeping two files in step.
 */

export interface PeriodEmployeeContext {
  employee: Employee & { department: Department | null; position: Position | null };
  /** Every pay profile overlapping the period, oldest effectiveFrom first. */
  profiles: EmployeePayProfile[];
  policy: EmployeePayrollPolicy | null;
  attendance: AttendanceRecord[];
  /** Per-day earnings for hourly staff, priced at the rate in force each day. */
  dailyEarnings: DailyEarningsSummary | null;
  /** Excluded from payroll by company policy. */
  excluded: boolean;
  /** A usable wage rate exists for this employee in this period. */
  payConfigured: boolean;
  /** Days worked with no rate range covering them. */
  unratedDays: number;
  /** Past days with exactly one punch. A day still in progress is not counted. */
  incompletePunchDays: number;
  /** Scheduled working days the employee was actually on the payroll for. */
  employedDays: number;
}

export interface PeriodContext {
  period: PayrollPeriod;
  settings: PayrollSettings;
  /** Calendar working days in the period, excluding public holidays. */
  workingDays: number;
  /** The period has not finished yet, so every figure is a preview. */
  isPreview: boolean;
  periodClosed: boolean;
  employees: PeriodEmployeeContext[];
}

/** Is this profile a usable wage definition for this kind of employee? */
export function isUsableProfile(
  profile: EmployeePayProfile,
  employmentType: EmploymentType
): boolean {
  if (!profile.isActive) return false;
  if (employmentType === EmploymentType.MONTHLY || employmentType === EmploymentType.CONTRACT) {
    return profile.payType === PayType.MONTHLY && dec(profile.monthlySalary ?? 0).greaterThan(0);
  }
  return profile.payType === PayType.HOURLY && dec(profile.hourlyRate ?? 0).greaterThan(0);
}

export async function loadPeriodContext(
  periodOrId: string | PayrollPeriod
): Promise<PeriodContext> {
  const period =
    typeof periodOrId === 'string'
      ? await prisma.payrollPeriod.findUniqueOrThrow({ where: { id: periodOrId } })
      : periodOrId;
  const settings = await loadSettingsForDate(period.endDate);

  const employees = await prisma.employee.findMany({
    // Deactivated, terminated and not-yet-hired staff never reach payroll.
    where: payrollEligibleEmployeeWhere(period),
    include: { department: true, position: true },
    orderBy: { employeeCode: 'asc' },
  });
  const employeeIds = employees.map((e) => e.id);

  const [profiles, policies, attendance, holidays] = await Promise.all([
    prisma.employeePayProfile.findMany({
      where: {
        employeeId: { in: employeeIds },
        isActive: true,
        effectiveFrom: { lte: period.endDate },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: period.startDate } }],
      },
      orderBy: { effectiveFrom: 'asc' },
    }),
    payrollPoliciesByEmployee(employeeIds),
    prisma.attendanceRecord.findMany({
      where: {
        employeeId: { in: employeeIds },
        workDate: { gte: period.startDate, lte: period.endDate },
      },
      orderBy: { workDate: 'asc' },
    }),
    prisma.holiday.findMany({ where: { date: { gte: period.startDate, lte: period.endDate } } }),
  ]);

  const holidayKeys = new Set(holidays.map((h) => formatDateOnly(h.date)));
  const workingDays = eachDay(period.startDate, period.endDate).filter(
    (d) => isScheduledWorkday(d, settings) && !holidayKeys.has(formatDateOnly(d))
  ).length;

  const clock = companyClock();
  const closeMinutes = attendanceCloseMinutes(settings);
  const payableTimePolicy = workTimePolicy(settings);
  const end = formatDateOnly(period.endDate);
  const periodClosed = end < clock.date || (end === clock.date && clock.minutes >= closeMinutes);

  const profilesByEmployee = new Map<string, EmployeePayProfile[]>();
  for (const profile of profiles) {
    const list = profilesByEmployee.get(profile.employeeId) ?? [];
    list.push(profile);
    profilesByEmployee.set(profile.employeeId, list);
  }
  const attendanceByEmployee = new Map<string, AttendanceRecord[]>();
  for (const record of attendance) {
    const list = attendanceByEmployee.get(record.employeeId) ?? [];
    list.push(record);
    attendanceByEmployee.set(record.employeeId, list);
  }

  const contexts: PeriodEmployeeContext[] = employees.map((employee) => {
    const employeeProfiles = profilesByEmployee.get(employee.id) ?? [];
    const records = attendanceByEmployee.get(employee.id) ?? [];
    const hourly =
      employee.employmentType === EmploymentType.DAILY ||
      employee.employmentType === EmploymentType.HOURLY;

    const usableProfiles = employeeProfiles.filter((p) =>
      isUsableProfile(p, employee.employmentType)
    );
    // DAILY money is priced from payable minutes, so the period's policy has to
    // travel with it. MONTHLY staff never reach this branch.
    const dailyEarnings = hourly
      ? computeDailyEarnings(records, usableProfiles, payableTimePolicy)
      : null;

    // Staff exempt from both attendance and leave tracking are executives whose
    // pay does not run through this engine. They count as excluded only while no
    // rate is configured for them - the moment payroll gives them one they are
    // calculated like anybody else, rather than silently skipped.
    const payConfigured = usableProfiles.length > 0;
    const excluded =
      !employee.attendanceRequired && !employee.leaveTrackingRequired && !payConfigured;

    const incompletePunchDays = records.filter(
      (r) =>
        r.status === 'MISSING_DATA' &&
        classifyOpenPunch({
          workDate: r.workDate,
          checkIn: r.checkIn,
          checkOut: r.checkOut,
          closeMinutes,
        }) !== 'IN_PROGRESS'
    ).length;

    const hired = effectiveEmploymentStart(employee);
    const employedFrom = hired > period.startDate ? hired : period.startDate;
    const employedTo =
      employee.endDate && employee.endDate < period.endDate ? employee.endDate : period.endDate;
    const employedDays =
      employedFrom > employedTo
        ? 0
        : eachDay(employedFrom, employedTo).filter((d) => isScheduledWorkday(d, settings)).length;

    return {
      employee,
      profiles: employeeProfiles,
      policy: policies.get(employee.id) ?? null,
      attendance: records,
      dailyEarnings,
      excluded,
      payConfigured,
      unratedDays: dailyEarnings?.unratedDays ?? 0,
      incompletePunchDays,
      employedDays,
    };
  });

  return {
    period,
    settings,
    workingDays,
    isPreview: !periodClosed,
    periodClosed,
    employees: contexts,
  };
}

/**
 * The pay profile in force at the end of the period, used for the headline rate
 * of a monthly employee. Hourly staff are priced day by day instead, so this is
 * only their most recent rate for display.
 */
export function latestProfile(context: PeriodEmployeeContext): EmployeePayProfile | null {
  const usable = context.profiles.filter((p) => isUsableProfile(p, context.employee.employmentType));
  if (usable.length === 0) return null;
  return usable.reduce((best, p) => (p.effectiveFrom > best.effectiveFrom ? p : best));
}
