/** Read-only probe: can the existing APIs return August while it is September? */
import { prisma } from '../../src/plugins/prisma.js';
import { employeeAttendanceHistory, employeeSummary } from '../../src/services/employee.service.js';
import { employeeDailyEarnings } from '../../src/services/daily-earnings.service.js';
import { companyClock } from '../../src/utils/datetime.js';

const db = await prisma.$queryRawUnsafe<{ db: string }[]>('SELECT DATABASE() as db');
console.log('DATABASE():', db[0].db, '| Bangkok now:', companyClock().date);
if (db[0].db !== 's2apayroll') process.exit(1);

const employees = await prisma.employee.findMany({
  select: { id: true, employeeCode: true, employmentType: true, status: true },
  orderBy: { employeeCode: 'asc' },
});

for (const e of employees) {
  const counts = await prisma.attendanceRecord.groupBy({
    by: ['workDate'], where: { employeeId: e.id }, _count: { _all: true },
  });
  const byMonth = counts.reduce<Record<string, number>>((acc, r) => {
    const k = r.workDate.toISOString().slice(0, 7);
    acc[k] = (acc[k] ?? 0) + r._count._all;
    return acc;
  }, {});
  if (Object.keys(byMonth).length === 0) continue;
  console.log(`\n${e.employeeCode} (${e.employmentType}, ${e.status}) months:`, byMonth);

  for (const [y, m] of [[2026, 8], [2026, 9]] as const) {
    const hist = await employeeAttendanceHistory(e.id, y, m, 1, 31);
    const de = await employeeDailyEarnings(e.id, y, m);
    console.log(`  ${y}-${String(m).padStart(2,'0')}: history ${hist.total} rows · dailyEarnings ${de.rows.length} rows · payable ${de.summary?.totalPayableMinutes ?? '-'} · ค่าจ้าง ${de.summary?.totalAmount ?? '-'}`);
  }
}

// The 31 Aug boundary: does it land in August or September?
const aug = await employeeAttendanceHistory(employees[0].id, 2026, 8, 1, 31);
const edge = await prisma.attendanceRecord.findFirst({
  where: { workDate: new Date('2026-08-31T00:00:00.000Z') },
  select: { employeeCode: true, workDate: true },
});
console.log('\n31 Aug record exists:', edge ? `${edge.employeeCode} ${edge.workDate.toISOString()}` : 'none');
if (edge) {
  const e2 = employees.find((x) => x.employeeCode === edge.employeeCode)!;
  const inAug = await employeeAttendanceHistory(e2.id, 2026, 8, 1, 31);
  const inSep = await employeeAttendanceHistory(e2.id, 2026, 9, 1, 31);
  const has = (r: { items: { workDate: Date }[] }) =>
    r.items.some((i) => i.workDate.toISOString().slice(0, 10) === '2026-08-31');
  console.log(`  appears in August: ${has(inAug)} · appears in September: ${has(inSep)}`);
}
await prisma.$disconnect();
