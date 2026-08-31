/**
 * Read-only verification that the Employees API path returns the real roster
 * from `s2apayroll`. Calls the same service the HTTP route calls.
 *
 * Usage: tsx scripts/verify-employees.ts
 */
import 'dotenv/config';
import { prisma } from '../src/plugins/prisma.js';
import { listEmployees } from '../src/services/employee.service.js';

async function main(): Promise<void> {
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT DATABASE() AS db');
  console.log(`SELECT DATABASE() => ${db}\n`);

  const all = await listEmployees({ page: 1, pageSize: 50 });
  console.log(`employees total = ${all.total}`);
  for (const e of all.items) {
    console.log(
      [
        e.employeeCode.padEnd(8),
        `${e.firstName} ${e.lastName}`.padEnd(26),
        (e.nickname ?? '-').padEnd(9),
        (e.department?.name ?? '-').padEnd(23),
        (e.position?.name ?? '-').padEnd(21),
        e.employmentType.padEnd(8),
        e.status,
      ].join(' ')
    );
  }

  const daily = await listEmployees({ page: 1, pageSize: 50, employmentType: 'DAILY' });
  console.log(`\nfilter employmentType=DAILY -> ${daily.total}: ${daily.items.map((i) => i.employeeCode).join(', ')}`);

  const monthly = await listEmployees({ page: 1, pageSize: 50, employmentType: 'MONTHLY' });
  console.log(`filter employmentType=MONTHLY -> ${monthly.total}`);

  const search = await listEmployees({ page: 1, pageSize: 50, search: 'S2A00' });
  console.log(`search "S2A00" -> ${search.total}`);

  const nick = await listEmployees({ page: 1, pageSize: 50, search: 'อาร์ม' });
  console.log(`search nickname "อาร์ม" -> ${nick.total}: ${nick.items.map((i) => i.employeeCode).join(', ')}`);

  const thai = await listEmployees({ page: 1, pageSize: 50, search: 'ธนพร' });
  console.log(`search Thai given name "ธนพร" -> ${thai.total}: ${thai.items.map((i) => i.employeeCode).join(', ')}`);

  const legacy = await prisma.employee.count({ where: { employeeCode: { startsWith: 'EMP' } } });
  console.log(`\nlegacy EMPnnn employees remaining: ${legacy}`);

  const attendance = await prisma.attendanceRecord.groupBy({
    by: ['employeeCode', 'status'],
    _count: { _all: true },
  });
  console.log('\nattendance by employee/status:');
  for (const a of attendance.sort((x, y) => x.employeeCode.localeCompare(y.employeeCode))) {
    console.log(`  ${a.employeeCode}  ${a.status.padEnd(13)} ${a._count._all}`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
