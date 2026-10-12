/** Guarded read-only preview / idempotent apply for correcting an existing employee-dated schedule row in place. */
import 'dotenv/config';
import { RoleCode } from '@prisma/client';
import { prisma } from '../src/plugins/prisma.js';
import { checkDatabaseUrl, EXPECTED_DATABASE } from './db-guard.js';
import { computeAttendanceMetrics, recalculateRange } from '../src/services/attendance.service.js';
import { PayrollSettings } from '../src/services/settings.service.js';
import { resolveEmployeeWorkSchedule, updateEmployeeWorkSchedule } from '../src/services/employee-work-schedule.service.js';

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const apply = process.argv.includes('--apply');

async function main() {
  const employeeCode = argument('--employee');
  const effectiveFromText = argument('--effective-from');
  const workStartTime = argument('--start');
  const workEndTime = argument('--end');
  const reasonBase64 = argument('--reason-base64');
  const reason = reasonBase64 ? Buffer.from(reasonBase64, 'base64').toString('utf8') : argument('--reason');
  if (!employeeCode || !effectiveFromText || !workStartTime || !workEndTime || !reason) {
    throw new Error('Usage: --employee CODE --effective-from YYYY-MM-DD --start HH:mm --end HH:mm --reason TEXT [--apply]');
  }
  const guard = checkDatabaseUrl(process.env.DATABASE_URL);
  if (!guard.ok || guard.target?.database !== EXPECTED_DATABASE) throw new Error(guard.message);
  const [{ db }] = await prisma.$queryRaw<Array<{ db: string }>>`SELECT DATABASE() AS db`;
  if (db !== EXPECTED_DATABASE) throw new Error(`Refusing database ${db}`);

  const effectiveFrom = new Date(`${effectiveFromText}T00:00:00.000Z`);
  const employee = await prisma.employee.findUnique({ where: { employeeCode },
    select: { id: true, employeeCode: true, firstName: true, lastName: true, employmentType: true, otEligible: true } });
  if (!employee) throw new Error(`Employee ${employeeCode} not found`);

  const existing = await prisma.employeeWorkSchedule.findFirst({
    where: { employeeId: employee.id, effectiveFrom, isActive: true },
  });
  if (!existing) throw new Error(`No active schedule row found for ${employeeCode} effective ${effectiveFromText}`);

  const scheduleCountBefore = await prisma.employeeWorkSchedule.count({ where: { employeeId: employee.id, effectiveFrom } });
  const otherOverrides = await prisma.employeeWorkScheduleOverride.findMany({ where: { employeeId: employee.id } });
  const protectedPeriods = await prisma.payrollPeriod.findMany({
    where: { status: { in: ['APPROVED', 'PAID', 'LOCKED'] } },
    select: { id: true, name: true, status: true, startDate: true, endDate: true },
  });

  const current = await resolveEmployeeWorkSchedule(employee.id, effectiveFrom);
  const requestedSettings = new PayrollSettings({ ...current.settings.raw(),
    MONTHLY_WORK_START_TIME: workStartTime, MONTHLY_WORK_END_TIME: workEndTime,
    WORK_START_TIME: workStartTime, WORK_END_TIME: workEndTime });
  const at = (time: string) => new Date(`${effectiveFromText}T${time}:00.000Z`);
  const interpretations = ['07:45|16:45', '07:46|16:45', '07:45|16:30'].map((pair) => {
    const [checkIn, checkOut] = pair.split('|');
    const result = computeAttendanceMetrics({ workDate: effectiveFrom, checkIn: at(checkIn), checkOut: at(checkOut),
      isHoliday: false, isWeekend: false, isOnLeave: false, otEligible: employee.otEligible, employmentType: employee.employmentType },
      requestedSettings);
    return { checkIn, checkOut, lateMinutes: result.lateMinutes, earlyLeaveMinutes: result.earlyLeaveMinutes };
  });

  console.log(JSON.stringify({ database: db, mode: apply ? 'APPLY' : 'READ_ONLY_PREVIEW', employee,
    existingSchedule: { id: existing.id, workStartTime: existing.workStartTime, workEndTime: existing.workEndTime,
      effectiveFrom: effectiveFromText, effectiveTo: existing.effectiveTo },
    requested: { workStartTime, workEndTime, effectiveFrom: effectiveFromText, reason },
    scheduleCountForEffectiveFrom: scheduleCountBefore,
    dateOverridesUnaffected: otherOverrides.map((o) => ({ workDate: o.workDate, workStartTime: o.workStartTime, workEndTime: o.workEndTime })),
    protectedPayrollPeriods: protectedPeriods, interpretations, rawPunchesToWrite: 0, googleSheetsWrites: 0,
  }, null, 2));
  if (!apply) return;

  if (existing.workStartTime === workStartTime && existing.workEndTime === workEndTime) {
    console.log(JSON.stringify({ applied: false, reason: 'Already at requested times; no-op' }, null, 2));
    return;
  }

  const deploymentUser = await prisma.user.findFirst({
    where: { isActive: true, role: { code: { in: [RoleCode.SUPER_ADMIN, RoleCode.ADMIN] } } },
    include: { role: { select: { code: true } } }, orderBy: { createdAt: 'asc' },
  });
  if (!deploymentUser) throw new Error('No active administrator available for audit metadata');
  const actor = { userId: deploymentUser.id, email: deploymentUser.email, role: deploymentUser.role.code,
    ip: null, userAgent: 'apply-employee-work-schedule-update' };

  await updateEmployeeWorkSchedule(employee.id, existing.id, {
    workStartTime, workEndTime, effectiveFrom: effectiveFromText, effectiveTo: existing.effectiveTo?.toISOString().slice(0, 10) ?? null, reason,
  }, actor);

  // Only this employee's open window (effectiveFrom..today, bounded by any
  // effectiveTo) is re-derived. recalculateRange protects every APPROVED,
  // PAID and LOCKED period and never writes source punches.
  const recalcTo = existing.effectiveTo ?? new Date();
  const recalculation = await recalculateRange(effectiveFrom, recalcTo, employee.id);

  const [afterSchedule, scheduleCountAfter, afterOverrides] = await Promise.all([
    resolveEmployeeWorkSchedule(employee.id, effectiveFrom),
    prisma.employeeWorkSchedule.count({ where: { employeeId: employee.id, effectiveFrom } }),
    prisma.employeeWorkScheduleOverride.findMany({ where: { employeeId: employee.id } }),
  ]);
  console.log(JSON.stringify({ applied: true, recalculation,
    after: { workStartTime: afterSchedule.workStartTime, workEndTime: afterSchedule.workEndTime, source: afterSchedule.source },
    scheduleCountForEffectiveFrom: scheduleCountAfter,
    dateOverridesUnchanged: afterOverrides.length === otherOverrides.length,
  }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
