/**
 * End-to-end check of delete -> suppression -> restore.
 *
 * Creates its own throwaway employee and attendance day, exercises the real
 * service functions against them, and removes everything it created. No real
 * attendance row is deleted, so this is safe to run unattended.
 *
 * Usage: tsx scripts/verify-delete-suppression.ts
 */
import 'dotenv/config';
import { prisma } from '../src/plugins/prisma.js';
import { checkDatabaseUrl } from './db-guard.js';
import { deleteAttendance, restoreAttendance } from '../src/services/attendance.service.js';

const CODE = 'ZZ-DELETE-CHECK';

const guard = checkDatabaseUrl(process.env.DATABASE_URL);
if (!guard.ok) {
  console.error(`DATABASE SAFETY CHECK FAILED: ${guard.message}`);
  process.exit(1);
}

const ok = (label: string, pass: boolean) => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) process.exitCode = 1;
};

async function cleanup(employeeId?: string): Promise<void> {
  if (!employeeId) return;
  await prisma.attendanceSuppression.deleteMany({ where: { employeeId } });
  await prisma.attendanceRecord.deleteMany({ where: { employeeId } });
  await prisma.employee.deleteMany({ where: { id: employeeId } });
  await prisma.auditLog.deleteMany({
    where: { action: { in: ['ATTENDANCE_DELETE', 'ATTENDANCE_RESTORE'] }, reason: { contains: 'ZZ throwaway' } },
  });
}

async function main(): Promise<void> {
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT DATABASE() AS db');
  console.log(`SELECT DATABASE() => ${db}`);
  if (db !== 's2apayroll') process.exit(1);

  const realBefore = await prisma.attendanceRecord.count();
  const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@payroll.local' } });
  const actor = { userId: admin.id, email: admin.email };

  // Remove any leftovers from an interrupted earlier run.
  const stale = await prisma.employee.findUnique({ where: { employeeCode: CODE } });
  await cleanup(stale?.id);

  const employee = await prisma.employee.create({
    data: {
      employeeCode: CODE,
      firstName: 'ทดสอบ',
      lastName: 'ลบข้อมูล',
      employmentType: 'MONTHLY',
      startDate: new Date('2026-08-01T00:00:00.000Z'),
      baseSalary: 0,
      status: 'ACTIVE',
      note: 'throwaway row created by verify-delete-suppression.ts',
    },
  });

  const workDate = new Date('2026-08-19T00:00:00.000Z');
  const record = await prisma.attendanceRecord.create({
    data: {
      employeeId: employee.id,
      employeeCode: CODE,
      workDate,
      checkIn: new Date('2026-08-19T08:45:00.000Z'),
      checkOut: new Date('2026-08-19T17:30:00.000Z'),
      originalCheckIn: new Date('2026-08-19T08:45:00.000Z'),
      originalCheckOut: new Date('2026-08-19T17:30:00.000Z'),
      workedMinutes: 465,
      lateMinutes: 15,
      status: 'LATE',
      source: 'GOOGLE_SHEET',
    },
  });

  console.log('\nDELETE');
  // An empty reason must be refused before anything is written.
  let refused = false;
  try {
    await deleteAttendance(record.id, { reason: '' }, actor);
  } catch {
    refused = true;
  }
  ok('an empty reason is refused', refused);
  ok('the record still exists after the refusal',
    (await prisma.attendanceRecord.count({ where: { id: record.id } })) === 1);

  const result = await deleteAttendance(
    record.id,
    { reason: 'ZZ throwaway verification of the delete path' },
    actor
  );
  ok('delete reports success', result.deleted && result.suppressed);
  ok('the effective attendance row is gone',
    (await prisma.attendanceRecord.count({ where: { id: record.id } })) === 0);

  const suppression = await prisma.attendanceSuppression.findUnique({
    where: { employee_work_date: { employeeId: employee.id, workDate } },
  });
  ok('a suppression exists for the employee-day', Boolean(suppression));
  ok('the suppression carries the previous punches',
    Boolean(suppression?.previousCheckIn && suppression?.previousCheckOut));

  const deleteAudit = await prisma.auditLog.findFirst({
    where: { action: 'ATTENDANCE_DELETE', entityId: record.id },
  });
  ok('an ATTENDANCE_DELETE audit row was written', Boolean(deleteAudit));
  ok('the audit row keeps the reason', Boolean(deleteAudit?.reason));
  ok('the audit row keeps the previous punches',
    JSON.stringify(deleteAudit?.oldValue ?? {}).includes('checkIn'));

  console.log('\nSUPPRESSION BLOCKS RE-IMPORT');
  // Simulate exactly what the sync does: build the suppressed key set and test it.
  const suppressions = await prisma.attendanceSuppression.findMany({
    select: { employeeId: true, workDate: true },
  });
  const suppressedKeys = new Set(
    suppressions.map((s) => `${s.employeeId}|${s.workDate.toISOString().slice(0, 10)}`)
  );
  ok('the sync would skip this employee-day',
    suppressedKeys.has(`${employee.id}|2026-08-19`));

  console.log('\nRESTORE');
  await restoreAttendance(suppression!.id, actor);
  ok('the suppression is gone',
    (await prisma.attendanceSuppression.count({ where: { employeeId: employee.id } })) === 0);
  ok('an ATTENDANCE_RESTORE audit row was written',
    Boolean(await prisma.auditLog.findFirst({ where: { action: 'ATTENDANCE_RESTORE', entityId: suppression!.id } })));

  await cleanup(employee.id);
  const realAfter = await prisma.attendanceRecord.count();
  console.log('\nCLEANUP');
  ok('the throwaway employee is gone',
    (await prisma.employee.count({ where: { employeeCode: CODE } })) === 0);
  ok(`real attendance untouched (${realBefore} -> ${realAfter})`, realBefore === realAfter);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  const leftover = await prisma.employee.findUnique({ where: { employeeCode: CODE } }).catch(() => null);
  await cleanup(leftover?.id).catch(() => undefined);
  await prisma.$disconnect();
  process.exit(1);
});
