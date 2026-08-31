/**
 * Read-only consistency audit over the real attendance data in `s2apayroll`.
 *
 * Asserts the verified company policy and reports every violation without
 * repairing anything - a silent repair would hide the defect that caused it.
 *
 * Usage: tsx scripts/consistency-audit.ts
 */
import 'dotenv/config';
import { prisma } from '../src/plugins/prisma.js';
import { checkDatabaseUrl } from './db-guard.js';
import { loadSettings } from '../src/services/settings.service.js';
import { isScheduledWorkday, weekdayToken } from '../src/services/schedule-policy.service.js';
import { dayjs } from '../src/utils/datetime.js';

const guard = checkDatabaseUrl(process.env.DATABASE_URL);
if (!guard.ok) {
  console.error(`DATABASE SAFETY CHECK FAILED: ${guard.message}`);
  process.exit(1);
}

interface Violation {
  rule: string;
  employeeCode: string;
  date: string;
  detail: string;
}

async function main(): Promise<void> {
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT DATABASE() AS db');
  console.log(`SELECT DATABASE() => ${db}\n`);
  if (db !== 's2apayroll') process.exit(1);

  const settings = await loadSettings();
  // The flex-arrival window is stored under LATE_GRACE_MINUTES; there is no
  // separate FLEX_ARRIVAL_MINUTES key.
  const flexMinutes = settings.number('LATE_GRACE_MINUTES');
  const startMinutes = settings.timeMinutes('WORK_START_TIME');
  /** Lateness is measured from the end of the flex window, not from 08:00. */
  const lateThreshold = startMinutes + flexMinutes;

  console.log('POLICY IN FORCE');
  console.log(`  WORK_START_TIME        ${settings.string('WORK_START_TIME')}`);
  console.log(`  WORK_END_TIME          ${settings.string('WORK_END_TIME')}`);
  console.log(`  LATE_GRACE_MINUTES     ${flexMinutes}  -> late after ${String(Math.floor(lateThreshold / 60)).padStart(2, '0')}:${String(lateThreshold % 60).padStart(2, '0')}`);
  console.log(`  WORKING_DAYS           ${settings.string('WORKING_DAYS')}`);
  console.log(`  MONTHLY_OT_ENABLED     ${settings.boolean('MONTHLY_OT_ENABLED')}`);
  console.log(`  DAILY_OT_ENABLED       ${settings.boolean('DAILY_OT_ENABLED')}`);
  console.log(`  DAILY_DEDUCT_BREAK     ${settings.boolean('DAILY_DEDUCT_BREAK')}`);

  const records = await prisma.attendanceRecord.findMany({
    include: {
      employee: {
        select: {
          employeeCode: true, employmentType: true,
          attendanceRequired: true, leaveTrackingRequired: true,
        },
      },
    },
    orderBy: [{ employeeCode: 'asc' }, { workDate: 'asc' }],
  });

  const leaves = await prisma.leaveRecord.findMany({
    where: { status: 'APPROVED' },
    include: { employee: { select: { employeeCode: true } } },
  });
  const onApprovedLeave = (employeeId: string, date: Date) =>
    leaves.some((l) => l.employeeId === employeeId && l.startDate <= date && l.endDate >= date);

  const violations: Violation[] = [];
  const pendingLate: string[] = [];
  const add = (rule: string, employeeCode: string, date: Date, detail: string) =>
    violations.push({ rule, employeeCode, date: dayjs.utc(date).format('YYYY-MM-DD'), detail });

  const minutesOf = (d: Date | null) =>
    d === null ? null : dayjs.utc(d).hour() * 60 + dayjs.utc(d).minute();

  for (const r of records) {
    const emp = r.employee;
    const code = emp.employeeCode;

    // --- exempt executives -------------------------------------------------
    if (!emp.attendanceRequired) {
      add('EXEMPT_HAS_COMPLIANCE_ROW', code, r.workDate,
        `exempt employee carries an attendance row with status ${r.status}`);
      continue;
    }

    // --- DAILY: no lateness, no automatic OT -------------------------------
    if (emp.employmentType === 'DAILY') {
      if (r.lateMinutes !== 0) {
        add('DAILY_LATE_NOT_ZERO', code, r.workDate, `lateMinutes=${r.lateMinutes}`);
      }
      if (r.otMinutes !== 0 && !settings.boolean('DAILY_OT_ENABLED')) {
        add('DAILY_AUTOMATIC_OT', code, r.workDate, `otMinutes=${r.otMinutes}`);
      }
      if (r.earlyLeaveMinutes !== 0) {
        add('DAILY_EARLY_LEAVE_ENFORCED', code, r.workDate, `earlyLeaveMinutes=${r.earlyLeaveMinutes}`);
      }
    }

    // --- MONTHLY: lateness measured from the flex boundary ------------------
    if (emp.employmentType === 'MONTHLY' && r.checkIn && r.status !== 'LEAVE') {
      const inMin = minutesOf(r.checkIn)!;
      const expected = inMin <= lateThreshold ? 0 : inMin - lateThreshold;
      // An incomplete day is not scored yet - it is pending correction - so it
      // is reported separately rather than counted as a policy violation.
      if (r.status === 'MISSING_DATA') {
        if (expected > 0 && r.lateMinutes === 0) {
          pendingLate.push(
            `${code} ${dayjs.utc(r.workDate).format('YYYY-MM-DD')} checkIn=${dayjs.utc(r.checkIn).format('HH:mm')} ` +
            `would be ${expected} min late once the missing punch is supplied`
          );
        }
      } else if (r.lateMinutes !== expected) {
        add('MONTHLY_LATE_MISMATCH', code, r.workDate,
          `checkIn=${dayjs.utc(r.checkIn).format('HH:mm')} expected lateMinutes=${expected} but stored ${r.lateMinutes}`);
      }
      if (!settings.boolean('MONTHLY_OT_ENABLED') && r.otMinutes !== 0) {
        add('MONTHLY_AUTOMATIC_OT', code, r.workDate, `otMinutes=${r.otMinutes}`);
      }
    }

    // --- Sunday / weekly off must not be an absence -------------------------
    if (!isScheduledWorkday(r.workDate, settings) && r.status === 'ABSENT') {
      add('WEEKLY_OFF_MARKED_ABSENT', code, r.workDate,
        `${weekdayToken(r.workDate)} is not a scheduled workday but status=ABSENT`);
    }

    // --- approved leave must not read as absent or incomplete ---------------
    if (onApprovedLeave(r.employeeId, r.workDate)) {
      if (r.status === 'ABSENT' || r.status === 'MISSING_DATA') {
        add('APPROVED_LEAVE_NOT_HONOURED', code, r.workDate, `status=${r.status} on approved leave`);
      }
      if (r.checkIn !== null || r.checkOut !== null) {
        add('LEAVE_HAS_FABRICATED_PUNCH', code, r.workDate,
          `leave day carries checkIn=${r.checkIn ? dayjs.utc(r.checkIn).format('HH:mm') : '-'} checkOut=${r.checkOut ? dayjs.utc(r.checkOut).format('HH:mm') : '-'}`);
      }
    }

    // --- a corrected, complete day must not stay MISSING_DATA ---------------
    if (r.checkIn && r.checkOut && r.status === 'MISSING_DATA' && !r.statusOverride) {
      add('COMPLETE_BUT_MISSING_DATA', code, r.workDate,
        'both punches present yet status is MISSING_DATA without an explicit override');
    }

    // --- MISSING_DATA must really be missing a punch -------------------------
    if (r.status === 'MISSING_DATA' && r.checkIn && r.checkOut) {
      // covered above; kept separate so the counts below stay meaningful
    }
  }

  // --- summary/table agreement ---------------------------------------------
  const statusCounts = records.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const leaveRows = records.filter((r) => r.status === 'LEAVE').length;
  const approvedLeaveWorkdays = leaves.filter((l) =>
    isScheduledWorkday(l.startDate, settings)
  ).length;

  console.log('\nDATA UNDER AUDIT');
  console.log(`  attendance rows        ${records.length}`);
  console.log(`  status counts          ${JSON.stringify(statusCounts)}`);
  console.log(`  approved leave records ${leaves.length} (on scheduled workdays: ${approvedLeaveWorkdays})`);
  console.log(`  attendance rows LEAVE  ${leaveRows}`);

  console.log('\nRULE RESULTS');
  const rules = [
    'EXEMPT_HAS_COMPLIANCE_ROW',
    'DAILY_LATE_NOT_ZERO',
    'DAILY_AUTOMATIC_OT',
    'DAILY_EARLY_LEAVE_ENFORCED',
    'MONTHLY_LATE_MISMATCH',
    'MONTHLY_AUTOMATIC_OT',
    'WEEKLY_OFF_MARKED_ABSENT',
    'APPROVED_LEAVE_NOT_HONOURED',
    'LEAVE_HAS_FABRICATED_PUNCH',
    'COMPLETE_BUT_MISSING_DATA',
  ];
  for (const rule of rules) {
    const hits = violations.filter((v) => v.rule === rule);
    console.log(`  ${hits.length === 0 ? 'PASS' : 'FAIL'}  ${rule.padEnd(30)} ${hits.length}`);
  }

  if (violations.length) {
    console.log('\nVIOLATIONS');
    for (const v of violations) {
      console.log(`  ${v.rule.padEnd(30)} ${v.employeeCode} ${v.date}  ${v.detail}`);
    }
  }

  // --- remaining genuinely incomplete records ------------------------------
  const incomplete = records.filter((r) => r.status === 'MISSING_DATA');
  console.log(`\nREMAINING INCOMPLETE (genuine, awaiting correction): ${incomplete.length}`);
  for (const r of incomplete) {
    console.log(
      `  ${r.employeeCode}  ${dayjs.utc(r.workDate).format('YYYY-MM-DD')} (${weekdayToken(r.workDate)})  ` +
      `${r.employee.employmentType.padEnd(8)} in=${r.checkIn ? dayjs.utc(r.checkIn).format('HH:mm') : '-'} ` +
      `out=${r.checkOut ? dayjs.utc(r.checkOut).format('HH:mm') : '-'}`
    );
  }

  if (pendingLate.length) {
    console.log(`\nNOT YET SCORED (incomplete days - lateness settles once corrected): ${pendingLate.length}`);
    for (const p of pendingLate) console.log(`  ${p}`);
  }

  console.log(`\nTOTAL VIOLATIONS: ${violations.length}`);
  await prisma.$disconnect();
  if (violations.length) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
