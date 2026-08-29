/**
 * Development-only cleanup for a single payroll period and its dependent rows.
 *
 * Deliberately narrow. It removes payroll *output* for one explicitly named
 * period and nothing else - employees, attendance, users, settings and company
 * master data are never touched, so a mistake here cannot destroy source data.
 *
 * Safety layers, all of which must pass:
 *   1. NODE_ENV must not be production
 *   2. DATABASE_URL must point at s2apayroll (the shared database guard)
 *   3. a period id or code must be named explicitly - there is no "all"
 *   4. the plan is printed and requires --confirm to execute
 *
 * Usage:
 *   npm run cleanup:test-payroll -- --period 2026-07            # dry run
 *   npm run cleanup:test-payroll -- --period 2026-07 --confirm  # execute
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { checkDatabaseUrl, EXPECTED_DATABASE } from './db-guard.js';

const prisma = new PrismaClient();

interface Args {
  period?: string;
  confirm: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { confirm: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--period' || a === '-p') args.period = argv[i + 1];
    else if (a.startsWith('--period=')) args.period = a.slice('--period='.length);
    else if (a === '--confirm') args.confirm = true;
  }
  return args;
}

function fail(message: string, hint?: string): never {
  console.error(`\n  CLEANUP REFUSED\n`);
  console.error(`  ${message}`);
  if (hint) console.error(`  ${hint}`);
  console.error('');
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // --- Layer 1: never in production ----------------------------------------
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (nodeEnv === 'production') {
    fail(
      'NODE_ENV is "production". This script deletes payroll data and will not run in production.',
      'Use a database restore or a reviewed manual migration instead.'
    );
  }

  // --- Layer 2: the shared database guard ----------------------------------
  const guard = checkDatabaseUrl(process.env.DATABASE_URL);
  if (!guard.ok) {
    fail(guard.message ?? 'DATABASE_URL failed the safety check.', guard.detail);
  }
  const target = guard.target!;
  console.log(
    `\n  Target: ${target.user}@${target.host}:${target.port}/${target.database}  (expected ${EXPECTED_DATABASE})`
  );
  console.log(`  NODE_ENV: ${nodeEnv}\n`);

  // --- Layer 3: an explicit period is mandatory ----------------------------
  if (!args.period) {
    fail(
      'No payroll period specified.',
      'Pass --period <id|code>, for example: npm run cleanup:test-payroll -- --period 2026-07'
    );
  }

  const period = await prisma.payrollPeriod.findFirst({
    where: { OR: [{ id: args.period }, { code: args.period }] },
  });
  if (!period) fail(`No payroll period matches "${args.period}".`);

  // --- Count exactly what would go ------------------------------------------
  const payrollEmployees = await prisma.payrollEmployee.findMany({
    where: { periodId: period.id },
    select: { id: true },
  });
  const peIds = payrollEmployees.map((p) => p.id);

  const [payslips, incomes, deductions, adjustments] = await Promise.all([
    prisma.payslip.count({ where: { periodId: period.id } }),
    peIds.length ? prisma.payrollIncome.count({ where: { payrollEmployeeId: { in: peIds } } }) : 0,
    peIds.length ? prisma.payrollDeduction.count({ where: { payrollEmployeeId: { in: peIds } } }) : 0,
    peIds.length ? prisma.payrollAdjustment.count({ where: { payrollEmployeeId: { in: peIds } } }) : 0,
  ]);

  console.log(`  Payroll period : ${period.name} (${period.code})`);
  console.log(`  Status         : ${period.status}`);
  console.log(`  Period id      : ${period.id}\n`);
  console.log('  WILL DELETE');
  console.log(`    payslips             ${payslips}`);
  console.log(`    payroll adjustments  ${adjustments}`);
  console.log(`    payroll incomes      ${incomes}`);
  console.log(`    payroll deductions   ${deductions}`);
  console.log(`    payroll employees    ${payrollEmployees.length}`);
  console.log(`    payroll period       1`);
  console.log('\n  WILL NOT TOUCH');
  console.log('    employees · attendance records · attendance adjustments · raw sheet data');
  console.log('    users · roles · settings · company · departments · positions · audit logs\n');

  if (period.status === 'LOCKED') {
    fail(
      'This period is LOCKED. Unlock it deliberately before deleting it.',
      'Locking exists to make payroll immutable; bypassing it from a script would defeat that.'
    );
  }

  if (!args.confirm) {
    console.log('  Dry run only. Nothing was deleted.');
    console.log(`  Re-run with --confirm to execute:\n`);
    console.log(`    npm run cleanup:test-payroll -- --period ${args.period} --confirm\n`);
    return;
  }

  // --- Execute, innermost dependents first -----------------------------------
  const result = await prisma.$transaction(async (tx) => {
    const deletedPayslips = await tx.payslip.deleteMany({ where: { periodId: period.id } });

    let deletedAdjustments = { count: 0 };
    let deletedIncomes = { count: 0 };
    let deletedDeductions = { count: 0 };
    if (peIds.length > 0) {
      deletedAdjustments = await tx.payrollAdjustment.deleteMany({
        where: { payrollEmployeeId: { in: peIds } },
      });
      deletedIncomes = await tx.payrollIncome.deleteMany({
        where: { payrollEmployeeId: { in: peIds } },
      });
      deletedDeductions = await tx.payrollDeduction.deleteMany({
        where: { payrollEmployeeId: { in: peIds } },
      });
    }

    const deletedEmployees = await tx.payrollEmployee.deleteMany({
      where: { periodId: period.id },
    });
    await tx.payrollPeriod.delete({ where: { id: period.id } });

    // Release the attendance rows this period had frozen. The rows themselves
    // are kept - only the lock flag is cleared.
    const unlockedAttendance = await tx.attendanceRecord.updateMany({
      where: { workDate: { gte: period.startDate, lte: period.endDate }, isLocked: true },
      data: { isLocked: false },
    });

    return {
      payslips: deletedPayslips.count,
      adjustments: deletedAdjustments.count,
      incomes: deletedIncomes.count,
      deductions: deletedDeductions.count,
      employees: deletedEmployees.count,
      unlockedAttendance: unlockedAttendance.count,
    };
  });

  // Deleting payroll data is itself an auditable event.
  await prisma.auditLog.create({
    data: {
      action: 'PAYROLL_PERIOD_CLEANUP',
      entity: 'PayrollPeriod',
      entityId: period.id,
      oldValue: { code: period.code, name: period.name, status: period.status },
      newValue: result,
      reason: `Development cleanup via cleanup:test-payroll (NODE_ENV=${nodeEnv})`,
    },
  });

  console.log('  DELETED');
  console.log(`    payslips             ${result.payslips}`);
  console.log(`    payroll adjustments  ${result.adjustments}`);
  console.log(`    payroll incomes      ${result.incomes}`);
  console.log(`    payroll deductions   ${result.deductions}`);
  console.log(`    payroll employees    ${result.employees}`);
  console.log(`    payroll period       1`);
  console.log(`  Attendance rows unlocked: ${result.unlockedAttendance} (rows themselves kept)`);
  console.log('\n  An audit log entry was recorded.\n');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
