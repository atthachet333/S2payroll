/**
 * Read-only verification of the work calendar the Attendance module renders.
 * Calls the same service the HTTP route calls.
 *
 * Usage: tsx scripts/verify-calendar.ts [year] [month]
 */
import 'dotenv/config';
import { prisma } from '../src/plugins/prisma.js';
import { getWorkCalendar } from '../src/services/attendance.service.js';

const year = Number(process.argv[2] ?? 2026);
const month = Number(process.argv[3] ?? 8);

const TH_WEEKDAY = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];

async function main(): Promise<void> {
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT DATABASE() AS db');
  console.log(`SELECT DATABASE() => ${db}\n`);

  const cal = await getWorkCalendar(year, month);

  console.log(`CALENDAR ${year}-${String(month).padStart(2, '0')}`);
  console.log('  SUMMARY');
  console.log(`    วันทำงานตามตาราง   ${cal.summary.scheduledWorkingDays}`);
  console.log(`    วันทำงานที่ผ่านมา   ${cal.summary.elapsedWorkingDays}`);
  console.log(`    วันทำงานคงเหลือ    ${cal.summary.remainingWorkingDays}`);
  console.log(`    วันหยุดประจำสัปดาห์ ${cal.summary.weeklyOffDays}`);
  console.log(`    วันหยุดบริษัท      ${cal.summary.companyHolidays}`);

  const weeklyOff = cal.days.filter((d) => d.dayType === 'WEEKLY_OFF').map((d) => Number(d.date.slice(8)));
  const holidays = cal.days.filter((d) => d.dayType === 'HOLIDAY').map((d) => d.date);
  const leaveDays = cal.days.filter((d) => d.approvedLeaveCount > 0);

  console.log(`\n  weekly-off day numbers : ${weeklyOff.join(', ') || '(none)'}`);
  console.log(`  company holidays       : ${holidays.join(', ') || '(none)'}`);
  console.log(`  days with approved leave: ${leaveDays.map((d) => `${d.date}(${d.approvedLeaveCount})`).join(', ') || '(none)'}`);
  console.log(`  today flagged           : ${cal.days.filter((d) => d.isToday).map((d) => d.date).join(', ') || '(not in this month)'}`);
  const withPeriod = cal.days.filter((d) => d.payrollPeriods.length > 0);
  console.log(`  days inside a payroll period: ${withPeriod.length}`);

  console.log('\n  DAY GRID');
  for (const d of cal.days) {
    const dow = TH_WEEKDAY[new Date(`${d.date}T00:00:00.000Z`).getUTCDay()];
    const marks = [
      d.dayType.padEnd(11),
      d.isToday ? 'TODAY' : '     ',
      d.approvedLeaveCount > 0 ? `LEAVE x${d.approvedLeaveCount}` : '',
      d.holidayName ?? '',
    ].join(' ');
    console.log(`    ${d.date} ${dow.padEnd(4)} ${marks}`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
