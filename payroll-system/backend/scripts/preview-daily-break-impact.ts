/**
 * READ-ONLY production impact preview for the DAILY four-hour break rule.
 *
 * This script never writes or recalculates a payroll period. It compares the
 * retired no-gap-credit rule with the proposed per-workday gap-credit rule for
 * the most recent editable period and prints the evidence needed for approval.
 */
import 'dotenv/config';
import { EmploymentType, PayrollPeriodStatus } from '@prisma/client';
import { prisma } from '../src/plugins/prisma.js';
import { attachAttendanceSessions } from '../src/services/attendance-sessions.service.js';
import { rateForDate } from '../src/services/daily-earnings.service.js';
import { dec, money } from '../src/utils/money.js';
import {
  calculateDailyPayableTime,
  calculateRoundedWorkTime,
  roundingIntervalMinutes,
} from '../src/utils/time-rounding.js';
import { loadSettingsForDate } from '../src/services/settings.service.js';
import { checkDatabaseUrl, EXPECTED_DATABASE } from './db-guard.js';

const EDITABLE = [
  PayrollPeriodStatus.DRAFT,
  PayrollPeriodStatus.ATTENDANCE_REVIEW,
  PayrollPeriodStatus.CALCULATED,
  PayrollPeriodStatus.REVIEW,
];
const RETIRED_THRESHOLD_MINUTES = 8 * 60;
const REQUIRED_BREAK_MINUTES = 60;
const NEW_THRESHOLD_MINUTES = 4 * 60;

const bangkokTimestamp = (value: Date | null): string => value
  ? new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(value)
  : 'OPEN';

async function main(): Promise<void> {
  const guard = checkDatabaseUrl(process.env.DATABASE_URL);
  if (!guard.ok || guard.target?.database !== EXPECTED_DATABASE) {
    throw new Error(guard.message ?? 'Database safety check failed');
  }
  const [{ db }] = await prisma.$queryRaw<Array<{ db: string }>>`SELECT DATABASE() AS db`;
  if (db !== EXPECTED_DATABASE) throw new Error(`Refusing preview against ${db}`);

  const period = await prisma.payrollPeriod.findFirst({
    where: { status: { in: EDITABLE } },
    orderBy: [{ endDate: 'desc' }, { createdAt: 'desc' }],
  });
  if (!period) {
    const [recentPeriods, rawCount] = await Promise.all([
      prisma.payrollPeriod.findMany({
        orderBy: [{ endDate: 'desc' }, { createdAt: 'desc' }],
        take: 6,
        select: { code: true, status: true, startDate: true, endDate: true },
      }),
      prisma.attendanceRawData.count(),
    ]);
    console.log(JSON.stringify({
      database: db,
      readOnly: true,
      editablePeriod: null,
      reason: 'No DRAFT, ATTENDANCE_REVIEW, CALCULATED, or REVIEW period exists; nothing can be previewed or recalculated.',
      attendanceRawDataCount: rawCount,
      recentPeriods,
      summary: {
        affectedEmployees: 0,
        affectedWorkdays: 0,
        oldTotalDailyGross: null,
        newTotalDailyGross: null,
        difference: null,
      },
    }, null, 2));
    return;
  }

  const employees = await prisma.employee.findMany({
    where: {
      employmentType: EmploymentType.DAILY,
      startDate: { lte: period.endDate },
      OR: [{ endDate: null }, { endDate: { gte: period.startDate } }],
    },
    select: { id: true, employeeCode: true, firstName: true, lastName: true },
    orderBy: { employeeCode: 'asc' },
  });
  const ids = employees.map((employee) => employee.id);
  const [attendance, profiles, settings, rawCount] = await Promise.all([
    prisma.attendanceRecord.findMany({
      where: {
        employeeId: { in: ids },
        workDate: { gte: period.startDate, lte: period.endDate },
      },
      orderBy: [{ employeeCode: 'asc' }, { workDate: 'asc' }],
    }),
    prisma.employeePayProfile.findMany({
      where: {
        employeeId: { in: ids },
        isActive: true,
        effectiveFrom: { lte: period.endDate },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: period.startDate } }],
      },
      orderBy: { effectiveFrom: 'asc' },
    }),
    loadSettingsForDate(period.endDate),
    prisma.attendanceRawData.count(),
  ]);
  const records = await attachAttendanceSessions(attendance);
  const byEmployee = new Map(employees.map((employee) => [employee.id, employee]));
  const profilesByEmployee = new Map<string, typeof profiles>();
  for (const profile of profiles) {
    profilesByEmployee.set(profile.employeeId, [
      ...(profilesByEmployee.get(profile.employeeId) ?? []),
      profile,
    ]);
  }

  let oldTotal = dec(0);
  let newTotal = dec(0);
  const affectedEmployees = new Set<string>();
  let affectedWorkdays = 0;
  const rows = records.map((record) => {
    const employee = byEmployee.get(record.employeeId)!;
    const rateProfile = rateForDate(profilesByEmployee.get(record.employeeId) ?? [], record.workDate);
    const rate = rateProfile?.hourlyRate ? dec(rateProfile.hourlyRate) : null;
    const newTime = calculateDailyPayableTime({
      sessions: record.sessions,
      actualWorkedMinutes: record.workedMinutes,
      roundingIntervalMinutes: roundingIntervalMinutes(settings),
      thresholdMinutes: NEW_THRESHOLD_MINUTES,
      requiredBreakMinutes: REQUIRED_BREAK_MINUTES,
      allowGapCredit: !record.malformedSequence,
    });
    const oldTime = calculateRoundedWorkTime(newTime.actualWorkedMinutes, {
      roundingMinutes: roundingIntervalMinutes(settings),
      breakThresholdMinutes: RETIRED_THRESHOLD_MINUTES,
      breakDeductionMinutes: REQUIRED_BREAK_MINUTES,
    });
    const finalized = !record.hasOpenSession
      && !record.malformedSequence
      && !['IN_PROGRESS', 'MISSING_DATA', 'MULTIPLE_EVENTS', 'INVALID'].includes(record.status);
    const oldWage = finalized && rate
      ? money(dec(oldTime.payableMinutes).dividedBy(60).times(rate))
      : null;
    const newWage = finalized && rate
      ? money(dec(newTime.payableMinutes).dividedBy(60).times(rate))
      : null;
    const difference = oldWage && newWage ? money(newWage.minus(oldWage)) : null;
    if (oldWage) oldTotal = oldTotal.plus(oldWage);
    if (newWage) newTotal = newTotal.plus(newWage);
    if (difference && !difference.isZero()) {
      affectedEmployees.add(employee.employeeCode);
      affectedWorkdays += 1;
    }

    return {
      employee: `${employee.employeeCode} ${employee.firstName} ${employee.lastName}`,
      date: record.workDate.toISOString().slice(0, 10),
      sessions: record.sessions.map((item) =>
        `${bangkokTimestamp(item.checkIn)} -> ${bangkokTimestamp(item.checkOut)} (${item.workedMinutes}m)`
      ).join(' | '),
      actualWorkedMinutes: newTime.actualWorkedMinutes,
      realGapMinutes: newTime.interSessionGapMinutes,
      oldBreakDeductionMinutes: oldTime.breakDeductionMinutes,
      newAdditionalBreakDeductionMinutes: newTime.additionalBreakDeductionMinutes,
      oldPayableMinutes: finalized ? oldTime.payableMinutes : null,
      newPayableMinutes: finalized ? newTime.payableMinutes : null,
      hourlyRate: rate?.toFixed(2) ?? null,
      oldWage: oldWage?.toFixed(2) ?? null,
      newWage: newWage?.toFixed(2) ?? null,
      difference: difference?.toFixed(2) ?? null,
      finalized,
      issues: record.attendanceIssues,
    };
  });

  console.log(JSON.stringify({
    database: db,
    readOnly: true,
    period: { code: period.code, status: period.status, startDate: period.startDate, endDate: period.endDate },
    policy: {
      retiredThresholdMinutes: RETIRED_THRESHOLD_MINUTES,
      newThresholdMinutes: NEW_THRESHOLD_MINUTES,
      requiredBreakMinutes: REQUIRED_BREAK_MINUTES,
      roundingMinutes: roundingIntervalMinutes(settings),
    },
    attendanceRawDataCount: rawCount,
    rows,
    summary: {
      affectedEmployees: affectedEmployees.size,
      affectedEmployeeCodes: [...affectedEmployees],
      affectedWorkdays,
      oldTotalDailyGross: money(oldTotal).toFixed(2),
      newTotalDailyGross: money(newTotal).toFixed(2),
      difference: money(newTotal.minus(oldTotal)).toFixed(2),
    },
  }, null, 2));
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
