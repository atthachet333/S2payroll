/**
 * Removes the confirmed seed/demo business data from `s2apayroll`.
 *
 * Scope is deliberately narrow and evidence-based, matching the audit produced
 * by scripts/audit-demo-data.ts:
 *
 *   - employees whose code matches EMPnnn (the seed's fake staff)
 *   - everything hanging off them: attendance, adjustments, salary history,
 *     payroll rows, incomes, deductions, payroll adjustments, payslips
 *   - the 2026-07 test payroll period and the empty 2026-09 DRAFT test period
 *   - the disposable payroll.tester@payroll.local account
 *
 * Explicitly NOT touched: admin@payroll.local, roles, permissions, payroll
 * settings, company, departments, positions, holidays, audit log, migrations.
 * Master data is preserved even when it becomes unreferenced - a generic
 * department is reusable configuration, not proven demo data.
 *
 * Refuses to run unless SELECT DATABASE() is s2apayroll and the URL guard
 * passes. Requires --confirm; without it this is a dry run.
 *
 * Usage: tsx scripts/cleanup-demo-data.ts [--confirm]
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { checkDatabaseUrl } from './db-guard.js';

const CONFIRM = process.argv.includes('--confirm');

/** Periods created purely for testing. Both were verified empty of real data. */
const TEST_PERIOD_CODES = ['2026-07', '2026-09'];
const DEMO_CODE = /^EMP\d{3}$/i;
const DEMO_USER_EMAIL = 'payroll.tester@payroll.local';
const PROTECTED_USER_EMAIL = 'admin@payroll.local';

const guard = checkDatabaseUrl(process.env.DATABASE_URL);
if (!guard.ok) {
  console.error(`DATABASE SAFETY CHECK FAILED: ${guard.message}`);
  process.exit(1);
}

const prisma = new PrismaClient();

async function counts(): Promise<Record<string, number>> {
  return {
    employee: await prisma.employee.count(),
    attendanceRecord: await prisma.attendanceRecord.count(),
    attendanceAdjustment: await prisma.attendanceAdjustment.count(),
    attendanceRawData: await prisma.attendanceRawData.count(),
    salaryHistory: await prisma.salaryHistory.count(),
    payrollPeriod: await prisma.payrollPeriod.count(),
    payrollEmployee: await prisma.payrollEmployee.count(),
    payrollIncome: await prisma.payrollIncome.count(),
    payrollDeduction: await prisma.payrollDeduction.count(),
    payrollAdjustment: await prisma.payrollAdjustment.count(),
    payslip: await prisma.payslip.count(),
    user: await prisma.user.count(),
    company: await prisma.company.count(),
    department: await prisma.department.count(),
    position: await prisma.position.count(),
    role: await prisma.role.count(),
    payrollSetting: await prisma.payrollSetting.count(),
    auditLog: await prisma.auditLog.count(),
  };
}

async function main(): Promise<void> {
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT DATABASE() AS db');
  console.log(`SELECT DATABASE() => ${db}`);
  if (db !== 's2apayroll') {
    console.error('Refusing to delete from a database other than s2apayroll.');
    process.exit(1);
  }

  const before = await counts();

  // --- resolve the exact targets ------------------------------------------
  const demoEmployees = (
    await prisma.employee.findMany({ select: { id: true, employeeCode: true } })
  ).filter((e) => DEMO_CODE.test(e.employeeCode));
  const demoEmployeeIds = demoEmployees.map((e) => e.id);

  const testPeriods = await prisma.payrollPeriod.findMany({
    where: { code: { in: TEST_PERIOD_CODES } },
    select: { id: true, code: true, status: true },
  });

  // A test period must not be carrying rows for employees we are keeping.
  for (const period of testPeriods) {
    const foreign = await prisma.payrollEmployee.count({
      where: { periodId: period.id, employeeId: { notIn: demoEmployeeIds.length ? demoEmployeeIds : ['-'] } },
    });
    if (foreign > 0) {
      console.error(
        `ABORT: period ${period.code} holds ${foreign} payroll row(s) for non-demo employees. ` +
        `Refusing to delete real payroll data.`
      );
      process.exit(1);
    }
  }

  const periodIds = testPeriods.map((p) => p.id);
  const payrollEmployeeIds = (
    await prisma.payrollEmployee.findMany({
      where: { OR: [{ periodId: { in: periodIds } }, { employeeId: { in: demoEmployeeIds } }] },
      select: { id: true },
    })
  ).map((r) => r.id);

  const attendanceIds = (
    await prisma.attendanceRecord.findMany({
      where: { employeeId: { in: demoEmployeeIds } },
      select: { id: true },
    })
  ).map((r) => r.id);

  console.log('\nTARGETS');
  console.log(`  demo employees      : ${demoEmployees.map((e) => e.employeeCode).join(', ') || '(none)'}`);
  console.log(`  test periods        : ${testPeriods.map((p) => `${p.code}[${p.status}]`).join(', ') || '(none)'}`);
  console.log(`  payrollEmployee rows: ${payrollEmployeeIds.length}`);
  console.log(`  attendance rows     : ${attendanceIds.length}`);
  console.log(`  demo user           : ${DEMO_USER_EMAIL}`);

  if (!CONFIRM) {
    console.log('\nDRY RUN - nothing deleted. Re-run with --confirm to apply.');
    await prisma.$disconnect();
    return;
  }

  // --- delete, innermost dependants first ----------------------------------
  const inPE = { payrollEmployeeId: { in: payrollEmployeeIds } };
  const removed = await prisma.$transaction(async (tx) => {
    const r: Record<string, number> = {};

    r.payslip = payrollEmployeeIds.length
      ? (await tx.payslip.deleteMany({ where: { payrollEmployeeId: { in: payrollEmployeeIds } } })).count
      : 0;
    r.payrollIncome = payrollEmployeeIds.length ? (await tx.payrollIncome.deleteMany({ where: inPE })).count : 0;
    r.payrollDeduction = payrollEmployeeIds.length ? (await tx.payrollDeduction.deleteMany({ where: inPE })).count : 0;
    r.payrollAdjustment = payrollEmployeeIds.length ? (await tx.payrollAdjustment.deleteMany({ where: inPE })).count : 0;
    r.payrollEmployee = payrollEmployeeIds.length
      ? (await tx.payrollEmployee.deleteMany({ where: { id: { in: payrollEmployeeIds } } })).count
      : 0;
    r.payrollPeriod = periodIds.length
      ? (await tx.payrollPeriod.deleteMany({ where: { id: { in: periodIds } } })).count
      : 0;

    r.attendanceAdjustment = attendanceIds.length
      ? (await tx.attendanceAdjustment.deleteMany({ where: { attendanceRecordId: { in: attendanceIds } } })).count
      : 0;
    r.attendanceRecord = attendanceIds.length
      ? (await tx.attendanceRecord.deleteMany({ where: { id: { in: attendanceIds } } })).count
      : 0;
    r.attendanceRawData = demoEmployees.length
      ? (await tx.attendanceRawData.deleteMany({
          where: { employeeCode: { in: demoEmployees.map((e) => e.employeeCode) } },
        })).count
      : 0;

    r.salaryHistory = demoEmployeeIds.length
      ? (await tx.salaryHistory.deleteMany({ where: { employeeId: { in: demoEmployeeIds } } })).count
      : 0;
    r.leaveRecord = demoEmployeeIds.length
      ? (await tx.leaveRecord.deleteMany({ where: { employeeId: { in: demoEmployeeIds } } })).count
      : 0;

    // The disposable test account, and any user linked to a demo employee -
    // but never the bootstrap admin.
    const demoUsers = await tx.user.findMany({
      where: {
        email: { not: PROTECTED_USER_EMAIL },
        OR: [{ email: DEMO_USER_EMAIL }, { employeeId: { in: demoEmployeeIds.length ? demoEmployeeIds : ['-'] } }],
      },
      select: { id: true, email: true },
    });
    r.refreshToken = demoUsers.length
      ? (await tx.refreshToken.deleteMany({ where: { userId: { in: demoUsers.map((u) => u.id) } } })).count
      : 0;
    // Audit rows carry the actor; detach rather than delete, so the trail survives.
    r.auditLogDetached = demoUsers.length
      ? (await tx.auditLog.updateMany({
          where: { userId: { in: demoUsers.map((u) => u.id) } },
          data: { userId: null },
        })).count
      : 0;
    r.user = demoUsers.length
      ? (await tx.user.deleteMany({ where: { id: { in: demoUsers.map((u) => u.id) } } })).count
      : 0;

    r.employee = demoEmployeeIds.length
      ? (await tx.employee.deleteMany({ where: { id: { in: demoEmployeeIds } } })).count
      : 0;

    return r;
  });

  console.log('\nDELETED');
  for (const [k, v] of Object.entries(removed)) console.log(`  ${k.padEnd(22)} ${v}`);

  const after = await counts();
  console.log('\nROW COUNTS  (before -> after)');
  for (const k of Object.keys(before)) {
    const mark = before[k] !== after[k] ? '  <-- changed' : '';
    console.log(`  ${k.padEnd(22)} ${String(before[k]).padStart(5)} -> ${String(after[k]).padStart(5)}${mark}`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
