/**
 * READ-ONLY preview of the 08:30-17:30 policy against existing attendance.
 *
 * Writes nothing. Recomputes every unlocked attendance row with the current
 * settings and reports what WOULD change, so the historical recalculation can
 * be approved on evidence rather than run blind.
 *
 * Usage: tsx scripts/preview-policy-recalc.ts
 */
import 'dotenv/config';
import { prisma } from '../src/plugins/prisma.js';
import { checkDatabaseUrl } from './db-guard.js';
import { loadSettings } from '../src/services/settings.service.js';
import {
  computeAttendanceMetrics,
  monthlyStartMinutes,
  monthlyEndMinutes,
} from '../src/services/attendance.service.js';
import { lateDeductionHours } from '../src/utils/attendance-math.js';
import { isScheduledWorkday } from '../src/services/schedule-policy.service.js';
import { dayjs } from '../src/utils/datetime.js';

const guard = checkDatabaseUrl(process.env.DATABASE_URL);
if (!guard.ok) {
  console.error(`DATABASE SAFETY CHECK FAILED: ${guard.message}`);
  process.exit(1);
}

const hhmm = (d: Date | null) => (d ? dayjs.utc(d).format('HH:mm') : '-');
const fmtMinutes = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

interface Change {
  employeeCode: string;
  date: string;
  employmentType: string;
  checkIn: string;
  checkOut: string;
  before: { late: number; early: number; worked: number; ot: number; status: string };
  after: { late: number; early: number; worked: number; ot: number; status: string };
}

async function main(): Promise<void> {
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT DATABASE() AS db');
  console.log(`SELECT DATABASE() => ${db}   (READ ONLY - this script writes nothing)\n`);
  if (db !== 's2apayroll') process.exit(1);

  const settings = await loadSettings();
  const start = monthlyStartMinutes(settings);
  const end = monthlyEndMinutes(settings);

  console.log('POLICY BEING PREVIEWED');
  console.log(`  monthly start      ${fmtMinutes(start)}`);
  console.log(`  monthly end        ${fmtMinutes(end)}  (fixed - never shifts with arrival)`);
  console.log(`  grace / flex       ${Math.max(settings.number('LATE_GRACE_MINUTES'), settings.number('MONTHLY_FLEX_ARRIVAL_MINUTES'))} minutes`);
  console.log(`  working days       ${settings.string('WORKING_DAYS')}`);

  const records = await prisma.attendanceRecord.findMany({
    where: { isLocked: false, employee: { attendanceRequired: true } },
    include: { employee: { select: { employeeCode: true, employmentType: true, otEligible: true } } },
    orderBy: [{ employeeCode: 'asc' }, { workDate: 'asc' }],
  });

  const leaves = await prisma.leaveRecord.findMany({
    where: { status: 'APPROVED', employee: { leaveTrackingRequired: true } },
  });
  const onLeave = (employeeId: string, date: Date) =>
    leaves.some((l) => l.employeeId === employeeId && l.startDate <= date && l.endDate >= date);

  const holidays = await prisma.holiday.findMany({ select: { date: true } });
  const holidaySet = new Set(holidays.map((h) => dayjs.utc(h.date).format('YYYY-MM-DD')));

  const changes: Change[] = [];
  let lockedSkipped = 0;

  for (const r of records) {
    const key = dayjs.utc(r.workDate).format('YYYY-MM-DD');
    const next = computeAttendanceMetrics(
      {
        workDate: r.workDate,
        checkIn: r.checkIn,
        checkOut: r.checkOut,
        isHoliday: holidaySet.has(key),
        isWeekend: !isScheduledWorkday(r.workDate, settings),
        isOnLeave: onLeave(r.employeeId, r.workDate),
        otEligible: r.employee.otEligible,
        employmentType: r.employee.employmentType,
      },
      settings
    );

    const nextStatus = r.statusOverride ? r.status : next.status;
    const differs =
      r.lateMinutes !== next.lateMinutes ||
      r.earlyLeaveMinutes !== next.earlyLeaveMinutes ||
      r.workedMinutes !== next.workedMinutes ||
      r.otMinutes !== next.otMinutes ||
      r.status !== nextStatus;

    if (differs) {
      changes.push({
        employeeCode: r.employeeCode,
        date: key,
        employmentType: r.employee.employmentType,
        checkIn: hhmm(r.checkIn),
        checkOut: hhmm(r.checkOut),
        before: { late: r.lateMinutes, early: r.earlyLeaveMinutes, worked: r.workedMinutes, ot: r.otMinutes, status: r.status },
        after: { late: next.lateMinutes, early: next.earlyLeaveMinutes, worked: next.workedMinutes, ot: next.otMinutes, status: nextStatus },
      });
    }
  }

  lockedSkipped = await prisma.attendanceRecord.count({ where: { isLocked: true } });

  console.log('\nSCOPE');
  console.log(`  rows inspected (unlocked, attendance-required)  ${records.length}`);
  console.log(`  rows locked and therefore excluded              ${lockedSkipped}`);
  console.log(`  rows that WOULD change                          ${changes.length}`);

  const lateChanges = changes.filter((c) => c.before.late !== c.after.late);
  const earlyChanges = changes.filter((c) => c.before.early !== c.after.early);
  const workedChanges = changes.filter((c) => c.before.worked !== c.after.worked);
  const otChanges = changes.filter((c) => c.before.ot !== c.after.ot);
  const statusChanges = changes.filter((c) => c.before.status !== c.after.status);

  console.log('\nCHANGE BREAKDOWN');
  console.log(`  late-minute changes        ${lateChanges.length}`);
  console.log(`  early-leave changes        ${earlyChanges.length}`);
  console.log(`  worked-minute changes      ${workedChanges.length}`);
  console.log(`  OT-minute changes          ${otChanges.length}`);
  console.log(`  status changes             ${statusChanges.length}`);

  const totalLateBefore = changes.reduce((a, c) => a + c.before.late, 0);
  const totalLateAfter = changes.reduce((a, c) => a + c.after.late, 0);
  const hoursBefore = changes.reduce((a, c) => a + lateDeductionHours(c.before.late), 0);
  const hoursAfter = changes.reduce((a, c) => a + lateDeductionHours(c.after.late), 0);
  console.log('\nCHARGEABLE LATENESS ACROSS CHANGED ROWS');
  console.log(`  late minutes  ${totalLateBefore} -> ${totalLateAfter}`);
  console.log(`  charged hours ${hoursBefore} -> ${hoursAfter}   (ceil(minutes / 60) per day)`);

  // Buckets the policy specifically asks to see.
  const bucket = (label: string, pick: (c: Change) => boolean) => {
    const rows = changes.filter(pick);
    console.log(`\n  ${label}  (${rows.length})`);
    for (const c of rows.slice(0, 8)) {
      console.log(
        `    ${c.employeeCode} ${c.date} ${c.employmentType.padEnd(8)} in=${c.checkIn} out=${c.checkOut}  ` +
        `late ${c.before.late}->${c.after.late}  early ${c.before.early}->${c.after.early}  ` +
        `worked ${c.before.worked}->${c.after.worked}  ${c.before.status}->${c.after.status}`
      );
    }
    if (rows.length > 8) console.log(`    ... and ${rows.length - 8} more`);
  };

  const inMinutes = (c: Change) => {
    if (c.checkIn === '-') return -1;
    const [h, m] = c.checkIn.split(':').map(Number);
    return h * 60 + m;
  };

  console.log('\nEXAMPLES BY ARRIVAL BUCKET');
  bucket('check-in before 08:30', (c) => inMinutes(c) >= 0 && inMinutes(c) < start);
  bucket('check-in exactly 08:30', (c) => inMinutes(c) === start);
  bucket('check-in 08:31 - 09:00', (c) => inMinutes(c) > start && inMinutes(c) <= start + 30);
  bucket('check-in after 09:00', (c) => inMinutes(c) > start + 30);

  console.log('\nNOTHING WAS WRITTEN. Historical recalculation awaits explicit approval.');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
