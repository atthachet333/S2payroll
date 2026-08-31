/**
 * Read-only inventory of demo/test data in `s2apayroll`.
 *
 * Writes nothing. Classifies every business record as DEMO_CONFIRMED,
 * REAL_DATA, SYSTEM_REQUIRED or UNCERTAIN so a cleanup can be reviewed before
 * it runs. Anything the evidence does not settle is reported UNCERTAIN and is
 * never a deletion candidate.
 *
 * Usage: tsx scripts/audit-demo-data.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { checkDatabaseUrl } from './db-guard.js';

const guard = checkDatabaseUrl(process.env.DATABASE_URL);
if (!guard.ok) {
  console.error(`DATABASE SAFETY CHECK FAILED: ${guard.message}`);
  process.exit(1);
}

const prisma = new PrismaClient();

/** Seeded demo employees use the EMPnnn pattern; real staff use S2Annn. */
const DEMO_CODE = /^EMP\d{3}$/i;
const REAL_CODE = /^S2A\d+$/i;

async function main(): Promise<void> {
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT DATABASE() AS db');
  console.log(`\nSELECT DATABASE() => ${db}`);
  if (db !== 's2apayroll') {
    console.error('Refusing to audit a database other than s2apayroll.');
    process.exit(1);
  }

  const line = (s: string) => console.log(`\n${'='.repeat(64)}\n${s}\n${'='.repeat(64)}`);

  // --- employees -----------------------------------------------------------
  line('EMPLOYEES');
  const employees = await prisma.employee.findMany({
    select: {
      id: true, employeeCode: true, firstName: true, lastName: true,
      status: true, createdAt: true,
      department: { select: { code: true, name: true } },
      position: { select: { code: true, name: true } },
    },
    orderBy: { employeeCode: 'asc' },
  });
  for (const e of employees) {
    const klass = DEMO_CODE.test(e.employeeCode)
      ? 'DEMO_CONFIRMED'
      : REAL_CODE.test(e.employeeCode)
        ? 'REAL_DATA'
        : 'UNCERTAIN';
    console.log(
      `  ${klass.padEnd(15)} ${e.employeeCode.padEnd(9)} ${`${e.firstName} ${e.lastName}`.padEnd(28)} ` +
      `${(e.department?.code ?? '-').padEnd(8)} ${(e.position?.code ?? '-').padEnd(10)} ${e.status}`
    );
  }
  console.log(`  total: ${employees.length}`);

  const demoEmployeeIds = employees.filter((e) => DEMO_CODE.test(e.employeeCode)).map((e) => e.id);

  // --- payroll periods -----------------------------------------------------
  line('PAYROLL PERIODS');
  const periods = await prisma.payrollPeriod.findMany({
    orderBy: { startDate: 'asc' },
    include: { _count: { select: { payrollEmployees: true } } },
  });
  for (const p of periods) {
    console.log(
      `  ${p.status.padEnd(10)} ${p.code.padEnd(14)} ` +
      `${p.startDate.toISOString().slice(0, 10)} -> ${p.endDate.toISOString().slice(0, 10)} ` +
      `rows=${p._count.payrollEmployees}  created=${p.createdAt.toISOString().slice(0, 10)}`
    );
  }

  // --- per-period dependants ----------------------------------------------
  line('PAYROLL DEPENDANTS PER PERIOD');
  for (const p of periods) {
    const empRows = await prisma.payrollEmployee.findMany({
      where: { periodId: p.id },
      select: { id: true, employeeId: true },
    });
    const ids = empRows.map((r) => r.id);
    const realLinked = empRows.filter((r) => !demoEmployeeIds.includes(r.employeeId)).length;
    const [incomes, deductions, adjustments, payslips] = await Promise.all([
      ids.length ? prisma.payrollIncome.count({ where: { payrollEmployeeId: { in: ids } } }) : 0,
      ids.length ? prisma.payrollDeduction.count({ where: { payrollEmployeeId: { in: ids } } }) : 0,
      ids.length ? prisma.payrollAdjustment.count({ where: { payrollEmployeeId: { in: ids } } }) : 0,
      prisma.payslip.count({ where: { periodId: p.id } }),
    ]);
    console.log(
      `  ${p.code.padEnd(14)} payrollEmployee=${String(empRows.length).padStart(3)} ` +
      `(linked to non-demo employees: ${realLinked})  income=${incomes} deduction=${deductions} ` +
      `adjustment=${adjustments} payslip=${payslips}`
    );
  }

  // --- attendance ----------------------------------------------------------
  line('ATTENDANCE');
  const attTotal = await prisma.attendanceRecord.count();
  const attDemo = demoEmployeeIds.length
    ? await prisma.attendanceRecord.count({ where: { employeeId: { in: demoEmployeeIds } } })
    : 0;
  console.log(`  attendance rows total: ${attTotal}`);
  console.log(`  attached to demo EMPnnn employees: ${attDemo}   (DEMO_CONFIRMED)`);
  console.log(`  attached to other employees: ${attTotal - attDemo}`);

  const attRange = await prisma.attendanceRecord.aggregate({ _min: { workDate: true }, _max: { workDate: true } });
  console.log(
    `  date range: ${attRange._min.workDate?.toISOString().slice(0, 10) ?? '-'} .. ` +
    `${attRange._max.workDate?.toISOString().slice(0, 10) ?? '-'}`
  );

  // --- other tables --------------------------------------------------------
  line('OTHER TABLES');
  const counts: Record<string, number> = {
    company: await prisma.company.count(),
    department: await prisma.department.count(),
    position: await prisma.position.count(),
    role: await prisma.role.count(),
    user: await prisma.user.count(),
    payrollSetting: await prisma.payrollSetting.count(),
    holiday: await prisma.holiday.count(),
    leaveRecord: await prisma.leaveRecord.count(),
    salaryHistory: await prisma.salaryHistory.count(),
    auditLog: await prisma.auditLog.count(),
    refreshToken: await prisma.refreshToken.count(),
  };
  for (const [table, n] of Object.entries(counts)) console.log(`  ${table.padEnd(18)} ${n}`);

  // --- users ---------------------------------------------------------------
  line('USERS');
  const users = await prisma.user.findMany({
    select: { email: true, isActive: true, employeeId: true, createdAt: true, role: { select: { code: true } } },
  });
  for (const u of users) {
    const klass = u.email === 'admin@payroll.local'
      ? 'SYSTEM_REQUIRED'
      : u.email === 'payroll.tester@payroll.local'
        ? 'DEMO_CONFIRMED'
        : 'UNCERTAIN';
    console.log(`  ${klass.padEnd(15)} ${u.email.padEnd(32)} role=${u.role.code.padEnd(12)} active=${u.isActive}`);
  }

  // --- master data referenced by whom -------------------------------------
  line('MASTER DATA REFERENCES');
  for (const d of await prisma.department.findMany({ select: { id: true, code: true, name: true } })) {
    const total = await prisma.employee.count({ where: { departmentId: d.id } });
    const demo = demoEmployeeIds.length
      ? await prisma.employee.count({ where: { departmentId: d.id, id: { in: demoEmployeeIds } } })
      : 0;
    console.log(`  department ${d.code.padEnd(10)} ${d.name.padEnd(24)} employees=${total} (demo ${demo})`);
  }
  for (const p of await prisma.position.findMany({ select: { id: true, code: true, name: true } })) {
    const total = await prisma.employee.count({ where: { positionId: p.id } });
    const demo = demoEmployeeIds.length
      ? await prisma.employee.count({ where: { positionId: p.id, id: { in: demoEmployeeIds } } })
      : 0;
    console.log(`  position   ${p.code.padEnd(10)} ${p.name.padEnd(24)} employees=${total} (demo ${demo})`);
  }

  // --- salary history ------------------------------------------------------
  line('SALARY HISTORY');
  const sh = await prisma.salaryHistory.groupBy({ by: ['employeeId'], _count: { _all: true } });
  const shDemo = sh.filter((r) => demoEmployeeIds.includes(r.employeeId));
  console.log(`  rows for demo employees: ${shDemo.reduce((a, r) => a + r._count._all, 0)} (DEMO_CONFIRMED)`);
  console.log(`  rows for other employees: ${sh.filter((r) => !demoEmployeeIds.includes(r.employeeId)).reduce((a, r) => a + r._count._all, 0)}`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
