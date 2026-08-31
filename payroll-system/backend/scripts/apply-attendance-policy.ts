/** Preview or apply the approved DAILY/MONTHLY attendance policy to s2apayroll. */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { checkDatabaseUrl } from './db-guard.js';
import { DEFAULT_PAYROLL_SETTINGS, DEFAULT_SETTINGS_MAP } from '../src/config/payroll-defaults.js';
import { PayrollSettings } from '../src/services/settings.service.js';
import { computeAttendanceMetrics } from '../src/services/attendance.service.js';
import { dayjs, eachDay, minutesSinceMidnight } from '../src/utils/datetime.js';
import { getDayType, isScheduledWorkday } from '../src/services/schedule-policy.service.js';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');
const TARGET_SETTINGS: Record<string, string> = {
  WORK_START_TIME: '08:00',
  WORK_END_TIME: '17:00',
  LATE_GRACE_MINUTES: '30',
  DAILY_DEDUCT_BREAK: 'false',
  DAILY_OT_ENABLED: 'false',
  MONTHLY_OT_ENABLED: 'false',
  WORKING_DAYS: 'MON,TUE,WED,THU,FRI,SAT',
};

async function main() {
  const guard = checkDatabaseUrl(process.env.DATABASE_URL);
  if (!guard.ok) throw new Error(guard.message);
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT DATABASE() AS db');
  if (db !== 's2apayroll') throw new Error(`Refusing database ${db}`);
  console.log(`SELECT DATABASE() => ${db}`);

  const current = await prisma.payrollSetting.findMany();
  const map = Object.fromEntries(current.map((setting) => [setting.key, setting.value]));
  const targetSettings = new PayrollSettings({ ...DEFAULT_SETTINGS_MAP, ...map, ...TARGET_SETTINGS });
  const records = await prisma.attendanceRecord.findMany({
    where: { isLocked: false, employee: { attendanceRequired: true } },
    include: { employee: { select: { employmentType: true, otEligible: true } } },
    orderBy: [{ employeeCode: 'asc' }, { workDate: 'asc' }],
  });
  const leaves = await prisma.leaveRecord.findMany({
    where: { status: 'APPROVED', employee: { leaveTrackingRequired: true } },
  });
  const holidays = await prisma.holiday.findMany({ select: { date: true, name: true } });
  const holidayDates = new Set(holidays.map((holiday) => dayjs.utc(holiday.date).format('YYYY-MM-DD')));
  const onLeave = (employeeId: string, date: Date) =>
    leaves.some((leave) => leave.employeeId === employeeId && leave.startDate <= date && leave.endDate >= date);

  const evaluations = records.map((record) => {
    const metrics = computeAttendanceMetrics(
      {
        workDate: record.workDate,
        checkIn: record.checkIn,
        checkOut: record.checkOut,
        isHoliday: record.isHoliday,
        isWeekend: !isScheduledWorkday(record.workDate, targetSettings),
        isOnLeave: onLeave(record.employeeId, record.workDate),
        otEligible: record.employee.otEligible,
        employmentType: record.employee.employmentType,
      },
      targetSettings
    );
    const staleDailyLate = record.employee.employmentType === 'DAILY' && record.status === 'LATE';
    const nextStatus = record.statusOverride && !staleDailyLate ? record.status : metrics.status;
    const changed =
      record.workedMinutes !== metrics.workedMinutes ||
      record.normalMinutes !== metrics.normalMinutes ||
      record.otMinutes !== metrics.otMinutes ||
      record.breakMinutes !== metrics.breakMinutes ||
      record.lateMinutes !== metrics.lateMinutes ||
      record.earlyLeaveMinutes !== metrics.earlyLeaveMinutes ||
      record.isMissingCheckIn !== metrics.isMissingCheckIn ||
      record.isMissingCheckOut !== metrics.isMissingCheckOut ||
      record.isAbsent !== metrics.isAbsent ||
      record.status !== nextStatus;
    return { record, metrics, nextStatus, changed };
  });
  const changes = evaluations.filter((evaluation) => evaluation.changed);

  const dailyChanges = changes.filter(({ record }) => record.employee.employmentType === 'DAILY');
  const monthlyChanges = changes.filter(({ record }) => record.employee.employmentType === 'MONTHLY');
  const statusTransitions = changes.reduce<Record<string, number>>((acc, { record, nextStatus }) => {
    const key = `${record.status} -> ${nextStatus}`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const largeLateChanges = changes.filter(
    ({ record, metrics }) => Math.abs(record.lateMinutes - metrics.lateMinutes) >= 30
  );
  const augustStart = new Date('2026-08-01T00:00:00.000Z');
  const septemberStart = new Date('2026-09-01T00:00:00.000Z');
  const august = evaluations.filter(
    ({ record }) => record.workDate >= augustStart && record.workDate < septemberStart
  );
  const sanityViolations = august.flatMap(({ record, metrics, nextStatus }) => {
    if (record.employee.employmentType === 'DAILY') {
      return metrics.lateMinutes !== 0 || nextStatus === 'LATE' || metrics.otMinutes !== 0 || (dayjs.utc(record.workDate).day() === 0 && metrics.isAbsent)
        ? [{ employeeCode: record.employeeCode, date: record.workDate.toISOString().slice(0, 10), reason: 'DAILY must have late=0, OT=0 and non-LATE status' }]
        : [];
    }
    if (dayjs.utc(record.workDate).day() === 0 && metrics.isAbsent) {
      return [{ employeeCode: record.employeeCode, date: record.workDate.toISOString().slice(0, 10), reason: 'Sunday must never become ABSENT' }];
    }
    // Incomplete punches are MISSING_DATA by priority; lateness is undefined
    // until both effective punches exist and must not be asserted here.
    if (record.employee.employmentType !== 'MONTHLY' || !record.checkIn || !record.checkOut) return [];
    const arrival = minutesSinceMidnight(record.checkIn);
    const expectedLate = Math.max(0, arrival - (8 * 60 + 30));
    if (metrics.otMinutes !== 0) {
      return [{ employeeCode: record.employeeCode, date: record.workDate.toISOString().slice(0, 10), reason: 'MONTHLY OT must be zero without explicit approval policy' }];
    }
    return metrics.lateMinutes !== expectedLate
      ? [{ employeeCode: record.employeeCode, date: record.workDate.toISOString().slice(0, 10), reason: `MONTHLY expected late=${expectedLate}, got ${metrics.lateMinutes}` }]
      : [];
  });
  const requestedKeys = new Set([
    'S2A004|2026-08-26',
    'S2A006|2026-08-24',
    'S2A003|2026-08-27',
    'S2A002|2026-08-23',
    'S2A002|2026-08-22',
    'S2A006|2026-08-26',
    'S2A004|2026-08-27',
    'S2A004|2026-08-25',
  ]);
  const requestedRows = evaluations.filter(({ record }) =>
    requestedKeys.has(`${record.employeeCode}|${record.workDate.toISOString().slice(0, 10)}`)
  );
  const augustDays = eachDay(augustStart, new Date('2026-08-31T00:00:00.000Z'));
  const augustDayTypes = augustDays.map((date) => ({ date, type: getDayType(date, targetSettings, holidayDates) }));
  const augustCalendar = {
    scheduledWorkingDays: augustDayTypes.filter((day) => day.type === 'WORKING_DAY').length,
    weeklyOffSundays: augustDayTypes.filter((day) => day.type === 'WEEKLY_OFF').map((day) => dayjs.utc(day.date).format('YYYY-MM-DD')),
    companyHolidays: holidays
      .filter((holiday) => dayjs.utc(holiday.date).year() === 2026 && dayjs.utc(holiday.date).month() === 7)
      .map((holiday) => ({ date: dayjs.utc(holiday.date).format('YYYY-MM-DD'), name: holiday.name })),
  };
  console.log(JSON.stringify({
    mode: apply ? 'APPLY' : 'PREVIEW',
    unlockedInspected: records.length,
    rowsThatWillChange: changes.length,
    dailyRowsThatWillChange: dailyChanges.length,
    monthlyRowsThatWillChange: monthlyChanges.length,
    statusTransitions,
    otCorrections: changes.filter(({ record, metrics }) => record.otMinutes !== metrics.otMinutes).length,
    workedMinuteCorrections: changes.filter(({ record, metrics }) => record.workedMinutes !== metrics.workedMinutes).length,
    lateCorrections: changes.filter(({ record, metrics }) => record.lateMinutes !== metrics.lateMinutes).length,
    maxLateMinutesAfterRecalculation: Math.max(0, ...evaluations.map(({ metrics }) => metrics.lateMinutes)),
    largeLateChanges: largeLateChanges.map(({ record, metrics, nextStatus }) => ({
      employeeCode: record.employeeCode,
      date: record.workDate.toISOString().slice(0, 10),
      beforeLateMinutes: record.lateMinutes,
      afterLateMinutes: metrics.lateMinutes,
      beforeStatus: record.status,
      afterStatus: nextStatus,
    })),
    sanityViolations,
    augustCalendar,
    lockedRowsUntouched: await prisma.attendanceRecord.count({ where: { isLocked: true } }),
    targetSettings: TARGET_SETTINGS,
    requestedRows: requestedRows.map(({ record, metrics, nextStatus }) => ({
      employeeCode: record.employeeCode,
      date: record.workDate.toISOString().slice(0, 10),
      employmentType: record.employee.employmentType,
      checkIn: record.checkIn?.toISOString().slice(11, 16) ?? null,
      checkOut: record.checkOut?.toISOString().slice(11, 16) ?? null,
      before: { workedMinutes: record.workedMinutes, otMinutes: record.otMinutes, lateMinutes: record.lateMinutes, earlyLeaveMinutes: record.earlyLeaveMinutes, status: record.status },
      after: { workedMinutes: metrics.workedMinutes, otMinutes: metrics.otMinutes, lateMinutes: metrics.lateMinutes, earlyLeaveMinutes: metrics.earlyLeaveMinutes, status: nextStatus },
    })),
    samples: changes.slice(0, 12).map(({ record, metrics, nextStatus }) => ({
      employeeCode: record.employeeCode,
      date: record.workDate.toISOString().slice(0, 10),
      employmentType: record.employee.employmentType,
      before: { workedMinutes: record.workedMinutes, breakMinutes: record.breakMinutes, lateMinutes: record.lateMinutes, earlyLeaveMinutes: record.earlyLeaveMinutes, status: record.status },
      after: { workedMinutes: metrics.workedMinutes, breakMinutes: metrics.breakMinutes, lateMinutes: metrics.lateMinutes, earlyLeaveMinutes: metrics.earlyLeaveMinutes, status: nextStatus },
    })),
  }, null, 2));

  if (!apply) return;
  if (sanityViolations.length > 0) {
    throw new Error(`Refusing apply: ${sanityViolations.length} August policy sanity violations`);
  }
  for (const [key, value] of Object.entries(TARGET_SETTINGS)) {
    const definition = DEFAULT_PAYROLL_SETTINGS.find((setting) => setting.key === key);
    if (!definition) throw new Error(`Missing setting definition ${key}`);
    await prisma.payrollSetting.upsert({
      where: { key },
      create: { ...definition, value },
      update: { value, label: definition.label, description: definition.description },
    });
  }
  for (const { record, metrics, nextStatus } of changes) {
    await prisma.attendanceRecord.update({
      where: { id: record.id },
      data: {
        workedMinutes: metrics.workedMinutes,
        normalMinutes: metrics.normalMinutes,
        otMinutes: metrics.otMinutes,
        breakMinutes: metrics.breakMinutes,
        lateMinutes: metrics.lateMinutes,
        earlyLeaveMinutes: metrics.earlyLeaveMinutes,
        isMissingCheckIn: metrics.isMissingCheckIn,
        isMissingCheckOut: metrics.isMissingCheckOut,
        isAbsent: metrics.isAbsent,
        status: nextStatus,
      },
    });
  }
  await prisma.auditLog.create({
    data: {
      action: 'ATTENDANCE_POLICY_RECALCULATE',
      entity: 'AttendanceRecord',
      reason: 'Apply DAILY actual-duration/no-lateness and MONTHLY 08:00-08:30 flex policy',
      newValue: {
        settings: TARGET_SETTINGS,
        rowsChanged: changes.length,
        dailyRowsChanged: dailyChanges.length,
        lockedRowsUntouched: await prisma.attendanceRecord.count({ where: { isLocked: true } }),
      },
    },
  });
  console.log(`Applied settings and recalculated ${changes.length} changed unlocked rows.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : 'Attendance policy update failed');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
