/**
 * Employee sheet sync driver.
 *
 *   tsx scripts/sync-employees.ts                       # dry run (preview)
 *   tsx scripts/sync-employees.ts --confirm             # import
 *   tsx scripts/sync-employees.ts --confirm --start-date=2024-01-01
 *
 * The sheet has no hire-date column, so --start-date lets the operator state
 * one explicitly for newly created employees rather than having the importer
 * invent a value. It defaults to today and is never applied to an employee
 * that already exists.
 */
import 'dotenv/config';
import { prisma } from '../src/plugins/prisma.js';
import { checkDatabaseUrl } from './db-guard.js';
import { importEmployees, previewEmployeeSync } from '../src/services/employee-sync.service.js';

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const tabArg = args.find((a) => a.startsWith('--tab='));
const startArg = args.find((a) => a.startsWith('--start-date='));

const guard = checkDatabaseUrl(process.env.DATABASE_URL);
if (!guard.ok) {
  console.error(`DATABASE SAFETY CHECK FAILED: ${guard.message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT DATABASE() AS db');
  console.log(`SELECT DATABASE() => ${db}`);
  if (db !== 's2apayroll') {
    console.error('Refusing to write to a database other than s2apayroll.');
    process.exit(1);
  }

  const tab = tabArg ? tabArg.split('=')[1] : undefined;
  const preview = await previewEmployeeSync(tab);

  console.log(`\nTab: ${preview.tab}`);
  console.log(`Headers used: ${preview.headers.join(', ')}`);
  if (preview.unmappedHeaders.length) {
    console.log(`Headers not consumed: ${preview.unmappedHeaders.join(', ')}`);
  }
  console.log(`Sheet rows: ${preview.totalSheetRows}\n`);

  console.log(
    'CODE'.padEnd(9) + 'NAME'.padEnd(34) + 'DEPARTMENT'.padEnd(24) +
    'POSITION'.padEnd(22) + 'TYPE'.padEnd(10) + 'DB'.padEnd(9) + 'ACTION'
  );
  console.log('-'.repeat(120));
  for (const r of preview.rows) {
    console.log(
      r.employeeCode.padEnd(9) +
      r.name.slice(0, 32).padEnd(34) +
      (r.department ?? '-').slice(0, 22).padEnd(24) +
      (r.position ?? '-').slice(0, 20).padEnd(22) +
      (r.employmentType ?? '-').slice(0, 8).padEnd(10) +
      r.databaseStatus.padEnd(9) +
      r.action
    );
    for (const c of r.changes) console.log(`  ~ ${c}`);
    for (const e of r.errors) console.log(`  ! ${e}`);
  }

  console.log('\nCOUNTS: ' + Object.entries(preview.counts).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log(`IMPORTABLE: ${preview.importable}`);
  if (preview.blockers.length) {
    console.log('BLOCKERS:');
    for (const b of preview.blockers) console.log(`  - ${b}`);
  }

  if (!CONFIRM) {
    console.log('\nDRY RUN - nothing written. Re-run with --confirm to import.');
    await prisma.$disconnect();
    return;
  }
  if (!preview.importable) {
    console.error('\nRefusing to import while blockers remain.');
    await prisma.$disconnect();
    process.exit(1);
  }

  const defaultStartDate = startArg
    ? new Date(`${startArg.split('=')[1]}T00:00:00.000Z`)
    : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
  if (Number.isNaN(defaultStartDate.getTime())) {
    console.error('--start-date must be YYYY-MM-DD');
    process.exit(1);
  }

  const result = await importEmployees({ tab, defaultStartDate });
  console.log('\nIMPORT RESULT');
  console.log(`  created   : ${result.created}`);
  console.log(`  updated   : ${result.updated}`);
  console.log(`  unchanged : ${result.unchanged}`);
  console.log(`  departments created: ${result.departmentsCreated.join(', ') || '(none)'}`);
  console.log(`  positions created  : ${result.positionsCreated.join(', ') || '(none)'}`);
  if (result.needsPayrollReview.length) {
    console.log(
      `\n  NEEDS PAYROLL REVIEW (no hire date / salary in the sheet): ` +
      result.needsPayrollReview.join(', ')
    );
    console.log(`  startDate applied to new records: ${defaultStartDate.toISOString().slice(0, 10)}`);
    console.log('  baseSalary left at 0 - the pre-payroll check will block until it is set.');
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err?.message ?? err);
  await prisma.$disconnect();
  process.exit(1);
});
