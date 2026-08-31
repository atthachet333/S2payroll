/**
 * Read-only verification of the calendar counts and day-detail payloads
 * against the real database. Prints shapes and counts, not employee prose.
 *
 * Usage: tsx scripts/verify-calendar-detail.ts [year] [month]
 */
import 'dotenv/config';
import { prisma } from '../src/plugins/prisma.js';
import { getWorkCalendar, getCalendarDayDetail } from '../src/services/attendance.service.js';

const year = Number(process.argv[2] ?? 2026);
const month = Number(process.argv[3] ?? 8);

async function main(): Promise<void> {
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT DATABASE() AS db');
  console.log(`SELECT DATABASE() => ${db}  (read only)\n`);

  const cal = await getWorkCalendar(year, month);
  const active = cal.days.filter((d) => d.hasActivity);

  console.log(`MONTH ${year}-${String(month).padStart(2, '0')}`);
  console.log(`  days with activity: ${active.length}`);
  console.log('  date        type         📝  🟡  🔴');
  for (const d of active) {
    console.log(
      `  ${d.date}  ${d.dayType.padEnd(11)} ${String(d.summaryCount).padStart(2)}  ` +
      `${String(d.lateCount).padStart(2)}  ${String(d.leaveCount).padStart(2)}`
    );
  }

  const totals = cal.days.reduce(
    (a, d) => ({
      s: a.s + d.summaryCount,
      l: a.l + d.lateCount,
      v: a.v + d.leaveCount,
    }),
    { s: 0, l: 0, v: 0 }
  );
  console.log(`\n  month totals: summaries=${totals.s} late=${totals.l} leave=${totals.v}`);

  console.log('\nDAY DETAIL (content length only - text is employee-authored)');
  for (const d of active.slice(0, 6)) {
    const detail = await getCalendarDayDetail(d.date);
    console.log(`\n  ${detail.date}  (${detail.dayType})`);
    console.log(`    counts: ${JSON.stringify(detail.counts)}`);
    for (const s of detail.summaries) {
      console.log(
        `    SUMMARY  ${s.employeeCode} ${(s.employeeName ?? '').padEnd(24)} out=${s.checkOutTime}  ` +
        `chars=${s.text.length} lines=${s.text.split('\n').length} id=${s.eventId.slice(0, 8)}`
      );
    }
    for (const l of detail.late) {
      console.log(`    LATE     ${l.employeeCode} ${(l.employeeName ?? '').padEnd(24)} in=${l.checkIn} late=${l.lateMinutes}m`);
    }
    for (const v of detail.leaves) {
      console.log(`    LEAVE    ${v.employeeCode} ${(v.employeeName ?? '').padEnd(24)} ${v.leaveType} ${v.startDate}..${v.endDate}`);
    }
    if (detail.suppressedSummaries.length) {
      console.log(`    (suppressed summaries retained for audit: ${detail.suppressedSummaries.length})`);
    }
  }

  const suppressions = await prisma.attendanceSuppression.count();
  console.log(`\nactive suppressions: ${suppressions}`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
