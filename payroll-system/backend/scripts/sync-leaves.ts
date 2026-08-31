/**
 * LeaveRequests sheet sync driver.
 *
 *   tsx scripts/sync-leaves.ts            # dry run (preview)
 *   tsx scripts/sync-leaves.ts --confirm  # import, then re-run to prove idempotency
 *
 * Google access is read-only throughout.
 */
import 'dotenv/config';
import { prisma } from '../src/plugins/prisma.js';
import { checkDatabaseUrl } from './db-guard.js';
import { importLeaves, previewLeaveSync } from '../src/services/leave-sync.service.js';
import { recalculateRange } from '../src/services/attendance.service.js';

const CONFIRM = process.argv.includes('--confirm');
const tabArg = process.argv.find((a) => a.startsWith('--tab='));

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
  const preview = await previewLeaveSync(tab);

  console.log(`\nTab: ${preview.tab}`);
  console.log(`Headers mapped: ${preview.headers.join(', ')}`);
  if (preview.unmappedHeaders.length) {
    console.log(`Headers not consumed: ${preview.unmappedHeaders.join(', ')}`);
  }
  console.log(`Sheet rows: ${preview.totalSheetRows}\n`);

  console.log(
    'REQUEST ID'.padEnd(26) + 'EMP'.padEnd(9) + 'TYPE'.padEnd(11) +
    'FROM'.padEnd(12) + 'TO'.padEnd(12) + 'DAYS'.padEnd(6) + 'STATUS'.padEnd(11) + 'ACTION'
  );
  console.log('-'.repeat(104));
  for (const r of preview.rows) {
    console.log(
      r.requestId.padEnd(26) + r.employeeCode.padEnd(9) + String(r.leaveType).padEnd(11) +
      String(r.startDate ?? '-').padEnd(12) + String(r.endDate ?? '-').padEnd(12) +
      String(r.totalDays ?? '-').padEnd(6) + String(r.status ?? '-').padEnd(11) + r.action
    );
    for (const c of r.changes) console.log(`  ~ ${c}`);
    for (const e of r.errors) console.log(`  ! ${e}`);
  }

  console.log('\nCOUNTS: ' + Object.entries(preview.counts).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log(`IMPORTABLE: ${preview.importable}`);
  for (const b of preview.blockers) console.log(`  BLOCKER: ${b}`);

  if (!CONFIRM) {
    console.log('\nDRY RUN - nothing written. Re-run with --confirm to import.');
    await prisma.$disconnect();
    return;
  }

  const first = await importLeaves({ tab });
  console.log(`\nIMPORT  created=${first.created} updated=${first.updated} unchanged=${first.unchanged}` +
    `  skippedInvalid=${first.skippedInvalid}  skippedUnknownEmployee=${first.skippedUnknownEmployee.length}`);
  if (first.skippedUnknownEmployee.length) {
    console.log(`  unknown employees: ${first.skippedUnknownEmployee.join(', ')}`);
  }

  const second = await importLeaves({ tab });
  console.log(`RE-RUN  created=${second.created} updated=${second.updated} unchanged=${second.unchanged}`);
  const idempotent = second.created === 0 && second.updated === 0;
  console.log(`IDEMPOTENT: ${idempotent}`);

  const total = await prisma.leaveRecord.count();
  console.log(`leave_records total = ${total}`);

  // Approved leave changes how a work day is interpreted, so refresh the
  // affected attendance rows against the newly known leave.
  const range = await prisma.leaveRecord.aggregate({ _min: { startDate: true }, _max: { endDate: true } });
  if (range._min.startDate && range._max.endDate) {
    const updated = await recalculateRange(range._min.startDate, range._max.endDate);
    console.log(`attendance rows recalculated over leave range: ${updated.updated} (locked, skipped: ${updated.skippedLocked})`);
  }

  const leaveDays = await prisma.attendanceRecord.count({ where: { status: 'LEAVE' } });
  console.log(`attendance rows now marked LEAVE = ${leaveDays}`);

  await prisma.$disconnect();
  if (!idempotent) process.exit(1);
}

main().catch(async (err) => {
  console.error(err?.message ?? err);
  await prisma.$disconnect();
  process.exit(1);
});
