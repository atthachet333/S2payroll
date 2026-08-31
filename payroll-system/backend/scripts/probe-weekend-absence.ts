/**
 * Read-only probe: what does a non-working day with no punches evaluate to
 * under the settings currently stored in the database?
 *
 * Usage: tsx scripts/probe-weekend-absence.ts
 */
import 'dotenv/config';
import { prisma } from '../src/plugins/prisma.js';
import { loadSettings } from '../src/services/settings.service.js';
import { computeAttendanceMetrics } from '../src/services/attendance.service.js';
import { isScheduledWorkday, weekdayToken } from '../src/services/schedule-policy.service.js';

const SUNDAY = new Date('2026-08-30T00:00:00.000Z');
const MONDAY = new Date('2026-08-31T00:00:00.000Z');

async function main(): Promise<void> {
  const settings = await loadSettings();
  console.log(`WORKING_DAYS              = ${settings.string('WORKING_DAYS')}`);
  console.log(`COUNT_WEEKEND_AS_WORKDAY  = ${settings.string('COUNT_WEEKEND_AS_WORKDAY')}`);

  for (const [label, date] of [['Sunday', SUNDAY], ['Monday', MONDAY]] as const) {
    const scheduled = isScheduledWorkday(date, settings);
    const m = computeAttendanceMetrics(
      {
        workDate: date,
        checkIn: null,
        checkOut: null,
        isHoliday: false,
        isWeekend: !scheduled,
        isOnLeave: false,
        employmentType: 'MONTHLY',
      },
      settings
    );
    console.log(
      `\n${label} ${date.toISOString().slice(0, 10)} (${weekdayToken(date)})` +
      `\n  scheduled workday : ${scheduled}` +
      `\n  no punches ->      status=${m.status} isAbsent=${m.isAbsent}`
    );
  }

  // Does any such record actually exist today?
  const nonWorkingWithNoPunches = await prisma.attendanceRecord.count({
    where: { checkIn: null, checkOut: null },
  });
  console.log(`\nattendance rows with no punches at all: ${nonWorkingWithNoPunches}`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
