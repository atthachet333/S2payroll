/**
 * One-off production fix for S2A008's split personal schedule.
 *
 * A prior workaround (the editor's lack of an update path forced a manual
 * "create a new future-dated row" bypass) left two active rows:
 *   - 2026-10-01 .. 2026-10-07  07:30-16:30  (the row that should carry the fix)
 *   - 2026-10-08 .. open-ended 07:45-16:45  (the bypass row)
 * This consolidates them back into the single logical schedule the task
 * requires: one row, effectiveFrom 2026-10-01, open-ended, 07:45-16:45.
 * Guarded read-only preview by default; pass --apply to write. Idempotent:
 * re-running after a successful apply finds no 2026-10-08 row and the
 * 2026-10-01 row already at the target times, so it is a no-op.
 */
import 'dotenv/config';
import { RoleCode } from '@prisma/client';
import { prisma } from '../src/plugins/prisma.js';
import { checkDatabaseUrl, EXPECTED_DATABASE } from './db-guard.js';
import { recalculateRange } from '../src/services/attendance.service.js';
import { resolveEmployeeWorkSchedule, updateEmployeeWorkSchedule } from '../src/services/employee-work-schedule.service.js';
import { recordAudit } from '../src/services/audit.service.js';

const apply = process.argv.includes('--apply');
const REASON = 'ปรับเวลาทำงานจริงของพนักงาน';

async function main() {
  const guard = checkDatabaseUrl(process.env.DATABASE_URL);
  if (!guard.ok || guard.target?.database !== EXPECTED_DATABASE) throw new Error(guard.message);
  const [{ db }] = await prisma.$queryRaw<Array<{ db: string }>>`SELECT DATABASE() AS db`;
  if (db !== EXPECTED_DATABASE) throw new Error(`Refusing database ${db}`);

  const employee = await prisma.employee.findUnique({ where: { employeeCode: 'S2A008' },
    select: { id: true, employeeCode: true, firstName: true, lastName: true } });
  if (!employee) throw new Error('Employee S2A008 not found');

  const rows = await prisma.employeeWorkSchedule.findMany({ where: { employeeId: employee.id, isActive: true }, orderBy: { effectiveFrom: 'asc' } });
  const rowOct01 = rows.find((r) => r.effectiveFrom.toISOString().slice(0, 10) === '2026-10-01');
  const rowOct08 = rows.find((r) => r.effectiveFrom.toISOString().slice(0, 10) === '2026-10-08');
  if (!rowOct01) throw new Error('Expected row effective 2026-10-01 not found');

  const protectedPeriods = await prisma.payrollPeriod.findMany({
    where: { status: { in: ['APPROVED', 'PAID', 'LOCKED'] } },
    select: { name: true, status: true, startDate: true, endDate: true },
  });

  const alreadyApplied = !rowOct08 && rowOct01.workStartTime === '07:45' && rowOct01.workEndTime === '16:45' && rowOct01.effectiveTo === null;

  console.log(JSON.stringify({ database: db, mode: apply ? 'APPLY' : 'READ_ONLY_PREVIEW',
    employee, rowOct01, rowOct08: rowOct08 ?? null, protectedPeriods, alreadyApplied,
    plan: alreadyApplied ? ['no-op: already consolidated'] : rowOct08
      ? ['deactivate the 2026-10-08 bypass row', 'update the 2026-10-01 row to 07:45-16:45, effectiveTo=null', 'recalculate 2026-10-01..today for S2A008']
      : ['update the 2026-10-01 row to 07:45-16:45', 'recalculate 2026-10-01..today for S2A008'],
  }, null, 2));
  if (!apply || alreadyApplied) return;

  const deploymentUser = await prisma.user.findFirst({
    where: { isActive: true, role: { code: { in: [RoleCode.SUPER_ADMIN, RoleCode.ADMIN] } } },
    include: { role: { select: { code: true } } }, orderBy: { createdAt: 'asc' },
  });
  if (!deploymentUser) throw new Error('No active administrator available for audit metadata');
  const actor = { userId: deploymentUser.id, email: deploymentUser.email, role: deploymentUser.role.code,
    ip: null, userAgent: 'fix-s2a008-schedule' };

  if (rowOct08) {
    await prisma.employeeWorkSchedule.update({ where: { id: rowOct08.id }, data: { isActive: false, updatedBy: actor.userId } });
    await recordAudit({ action: 'EMPLOYEE_WORK_SCHEDULE_DEACTIVATE', entity: 'EmployeeWorkSchedule', entityId: rowOct08.id,
      oldValue: rowOct08, newValue: { isActive: false },
      reason: 'Superseded by extending the 2026-10-01 row to the same open-ended range; was a bypass row created because the editor could not update in place',
      userId: actor.userId, userEmail: actor.email, userAgent: actor.userAgent });
  }

  await updateEmployeeWorkSchedule(employee.id, rowOct01.id, {
    workStartTime: '07:45', workEndTime: '16:45', effectiveFrom: '2026-10-01', effectiveTo: null, reason: REASON,
  }, actor);

  // Only this employee's open window (effectiveFrom..today, bounded by any
  // effectiveTo) is re-derived. recalculateRange protects every APPROVED,
  // PAID and LOCKED period and never writes source punches.
  const recalcTo = rowOct01.effectiveTo ?? new Date();
  const recalculation = await recalculateRange(new Date('2026-10-01T00:00:00.000Z'), recalcTo, employee.id);

  const [afterRows, afterResolved0108, afterResolved1007, afterOverrides] = await Promise.all([
    prisma.employeeWorkSchedule.findMany({ where: { employeeId: employee.id, isActive: true }, orderBy: { effectiveFrom: 'asc' } }),
    resolveEmployeeWorkSchedule(employee.id, new Date('2026-10-08T00:00:00.000Z')),
    resolveEmployeeWorkSchedule(employee.id, new Date('2026-10-07T00:00:00.000Z')),
    prisma.employeeWorkScheduleOverride.findMany({ where: { employeeId: employee.id } }),
  ]);
  console.log(JSON.stringify({ applied: true, recalculation,
    activeScheduleRows: afterRows, activeScheduleRowCount: afterRows.length,
    resolved2026_10_08: { workStartTime: afterResolved0108.workStartTime, workEndTime: afterResolved0108.workEndTime, source: afterResolved0108.source },
    resolved2026_10_07: { workStartTime: afterResolved1007.workStartTime, workEndTime: afterResolved1007.workEndTime, source: afterResolved1007.source },
    dateOverridesUnchanged: afterOverrides,
  }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
