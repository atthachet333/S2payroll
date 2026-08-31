/**
 * Diagnostic: exercise the real manual-correction path on one MISSING_DATA
 * record, report what the service actually writes, then restore the record to
 * its exact prior state and remove the adjustment rows it created.
 *
 * Read-write against s2apayroll only, and self-reverting.
 *
 * Usage: tsx scripts/diagnose-correction.ts
 */
import 'dotenv/config';
import { prisma } from '../src/plugins/prisma.js';
import { checkDatabaseUrl } from './db-guard.js';
import { correctAttendance, attendanceSummary } from '../src/services/attendance.service.js';

const guard = checkDatabaseUrl(process.env.DATABASE_URL);
if (!guard.ok) {
  console.error(`DATABASE SAFETY CHECK FAILED: ${guard.message}`);
  process.exit(1);
}

const show = (r: Record<string, unknown> | null) =>
  r &&
  [
    `status=${r.status}`,
    `isCorrected=${r.isCorrected}`,
    `missIn=${r.isMissingCheckIn}`,
    `missOut=${r.isMissingCheckOut}`,
    `worked=${r.workedMinutes}`,
    `checkOut=${r.checkOut ? new Date(r.checkOut as Date).toISOString().slice(11, 16) : '-'}`,
    `source=${r.source}`,
  ].join('  ');

async function main(): Promise<void> {
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT DATABASE() AS db');
  console.log(`SELECT DATABASE() => ${db}`);
  if (db !== 's2apayroll') process.exit(1);

  const target = await prisma.attendanceRecord.findFirst({
    where: { status: 'MISSING_DATA' },
    orderBy: [{ employeeCode: 'asc' }, { workDate: 'asc' }],
  });
  if (!target) {
    console.log('No MISSING_DATA record to diagnose.');
    await prisma.$disconnect();
    return;
  }

  const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@payroll.local' } });
  const from = new Date('2026-08-01T00:00:00.000Z');
  const to = new Date('2026-08-31T00:00:00.000Z');

  console.log(`\nTARGET ${target.employeeCode} ${target.workDate.toISOString().slice(0, 10)}`);
  console.log(`  BEFORE  ${show(target as unknown as Record<string, unknown>)}`);
  const summaryBefore = await attendanceSummary(from, to);
  console.log(`  summary.missingData BEFORE = ${summaryBefore.missingData}`);

  // Snapshot every field the correction touches, so it can be put back exactly.
  const snapshot = {
    checkIn: target.checkIn,
    checkOut: target.checkOut,
    workedMinutes: target.workedMinutes,
    normalMinutes: target.normalMinutes,
    otMinutes: target.otMinutes,
    breakMinutes: target.breakMinutes,
    lateMinutes: target.lateMinutes,
    earlyLeaveMinutes: target.earlyLeaveMinutes,
    isMissingCheckIn: target.isMissingCheckIn,
    isMissingCheckOut: target.isMissingCheckOut,
    isAbsent: target.isAbsent,
    status: target.status,
    note: target.note,
    isCorrected: target.isCorrected,
    source: target.source,
  };

  try {
    await correctAttendance(
      target.id,
      { checkOut: '17:30', reason: 'diagnostic: verifying correction clears MISSING_DATA' },
      { userId: admin.id, email: admin.email }
    );
  } catch (err) {
    console.error(`\n  correctAttendance THREW: ${(err as Error).message}`);
  }

  const after = await prisma.attendanceRecord.findUnique({ where: { id: target.id } });
  console.log(`  AFTER   ${show(after as unknown as Record<string, unknown>)}`);
  const summaryAfter = await attendanceSummary(from, to);
  console.log(`  summary.missingData AFTER  = ${summaryAfter.missingData}`);
  console.log(`  adjustment rows created    = ${await prisma.attendanceAdjustment.count({ where: { attendanceRecordId: target.id } })}`);

  // --- restore -------------------------------------------------------------
  await prisma.attendanceAdjustment.deleteMany({ where: { attendanceRecordId: target.id } });
  await prisma.attendanceRecord.update({ where: { id: target.id }, data: snapshot });
  const restored = await prisma.attendanceRecord.findUnique({ where: { id: target.id } });
  console.log(`  RESTORED ${show(restored as unknown as Record<string, unknown>)}`);
  console.log(`  adjustments remaining      = ${await prisma.attendanceAdjustment.count()}`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
