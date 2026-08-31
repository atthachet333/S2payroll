/**
 * Attendance sync driver: reconciliation preview, then optional import.
 *
 *   tsx scripts/sync-attendance.ts            # dry run only
 *   tsx scripts/sync-attendance.ts --confirm  # import, then re-run to prove idempotency
 *
 * Uses the existing syncAttendance service unchanged, so all of its safety
 * rules apply: read-only sheet access, raw-event archival, manual corrections
 * protected, locked periods untouched, hash-based idempotency.
 *
 * Refuses to import while any employee code in the sheet is unknown to the
 * database - an unrecognised code means somebody's hours would go missing.
 */
import 'dotenv/config';
import { prisma } from '../src/plugins/prisma.js';
import { checkDatabaseUrl } from './db-guard.js';
import { syncAttendance } from '../src/services/google-sheets.service.js';

const CONFIRM = process.argv.includes('--confirm');

const guard = checkDatabaseUrl(process.env.DATABASE_URL);
if (!guard.ok) {
  console.error(`DATABASE SAFETY CHECK FAILED: ${guard.message}`);
  process.exit(1);
}

function report(label: string, r: Awaited<ReturnType<typeof syncAttendance>>): void {
  console.log(`\n===== ${label} =====`);
  console.log(`  status            : ${r.status}`);
  console.log(`  source events     : ${r.sourceEvents}`);
  console.log(`  employee-days     : ${r.groupedEmployeeDays}`);
  console.log(`  imported          : ${r.imported}`);
  console.log(`  updated           : ${r.updated}`);
  console.log(`  duplicates/unchanged: ${r.duplicates}`);
  console.log(`  protected (manual): ${r.protected}`);
  console.log(`  skipped           : ${r.skipped}`);
  console.log(`  invalid           : ${r.invalid}`);
  console.log(`  UNKNOWN_EMPLOYEE  : ${r.unknownEmployee}`);
  console.log(`  counts            : ${JSON.stringify(r.counts)}`);
  if (r.errors.length) {
    console.log(`  errors (${r.errors.length}):`);
    for (const e of r.errors.slice(0, 20)) {
      console.log(`    row ${e.row} ${e.employeeCode} ${e.date}: ${e.message}`);
    }
  }
}

async function main(): Promise<void> {
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT DATABASE() AS db');
  console.log(`SELECT DATABASE() => ${db}`);
  if (db !== 's2apayroll') {
    console.error('Refusing to write to a database other than s2apayroll.');
    process.exit(1);
  }

  const admin = await prisma.user.findFirst({
    where: { email: 'admin@payroll.local' },
    select: { id: true, email: true },
  });
  if (!admin) {
    console.error('No admin@payroll.local user to attribute the sync to.');
    process.exit(1);
  }
  const actor = { userId: admin.id, email: admin.email };

  // --- reconciliation preview ---------------------------------------------
  const preview = await syncAttendance({ dryRun: true, actor });
  report('PREVIEW (dry run)', preview);

  // Reconciliation summary keyed on the employee table.
  const codes = [...new Set((preview.preview ?? []).map((p) => p.employeeCode).filter(Boolean))];
  const known = await prisma.employee.findMany({
    where: { employeeCode: { in: codes } },
    select: { employeeCode: true, status: true },
  });
  const byCode = new Map(known.map((e) => [e.employeeCode, e.status]));

  const matched = codes.filter((c) => byCode.has(c) && byCode.get(c) === 'ACTIVE');
  const inactive = codes.filter((c) => byCode.has(c) && byCode.get(c) !== 'ACTIVE');
  const unknown = codes.filter((c) => !byCode.has(c));

  console.log('\n===== EMPLOYEE RECONCILIATION =====');
  console.log(`  MATCHED           (${matched.length}): ${matched.sort().join(', ') || '-'}`);
  console.log(`  INACTIVE_EMPLOYEE (${inactive.length}): ${inactive.sort().join(', ') || '-'}`);
  console.log(`  UNKNOWN_IN_DB     (${unknown.length}): ${unknown.sort().join(', ') || '-'}`);

  // Missing-punch days are still imported - with the absent punch left null and
  // the record flagged MISSING_DATA - so a complete day is never held hostage to
  // an incomplete one. Nothing is fabricated; they are listed here for review.
  const missing = (preview.preview ?? []).filter((p) => !p.checkIn || !p.checkOut);
  console.log('\n===== REVIEW REQUIRED - missing punch (not fabricated) =====');
  console.log(`  employee-days: ${missing.length}`);
  for (const m of missing.slice(0, 40)) {
    const which = !m.checkOut ? 'MISSING_CHECKOUT' : 'MISSING_CHECKIN';
    console.log(
      `    ${m.employeeCode}  ${m.date}  ${which}  in=${m.checkIn ?? '-'} out=${m.checkOut ?? '-'}` +
      `${m.reason ? `  (${m.reason})` : ''}`
    );
  }

  const warned = (preview.preview ?? []).filter((p) => p.checkIn && p.checkOut && p.reason);
  if (warned.length) {
    console.log('\n===== WARNINGS (imported, flagged) =====');
    for (const w of warned.slice(0, 20)) {
      console.log(`    ${w.employeeCode}  ${w.date}  ${w.reason}`);
    }
  }

  if (unknown.length > 0) {
    console.error('\nRefusing to import: unknown employee codes remain.');
    await prisma.$disconnect();
    process.exit(1);
  }

  if (!CONFIRM) {
    console.log('\nDRY RUN - nothing written. Re-run with --confirm to import.');
    await prisma.$disconnect();
    return;
  }

  // --- import, then immediately prove idempotency --------------------------
  const first = await syncAttendance({ dryRun: false, actor });
  report('IMPORT (first run)', first);

  const second = await syncAttendance({ dryRun: false, actor });
  report('IMPORT (second run - idempotency check)', second);

  const idempotent = second.imported === 0 && second.updated === 0;
  console.log(
    `\nIDEMPOTENT: ${idempotent}  ` +
    `(second run imported=${second.imported} updated=${second.updated})`
  );

  const total = await prisma.attendanceRecord.count();
  const raw = await prisma.attendanceRawData.count();
  console.log(`attendance_records=${total}  attendance_raw_data=${raw}`);

  await prisma.$disconnect();
  if (!idempotent) process.exit(1);
}

main().catch(async (err) => {
  console.error(err?.message ?? err);
  await prisma.$disconnect();
  process.exit(1);
});
