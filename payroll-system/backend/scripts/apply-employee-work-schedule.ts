/** Guarded preview/apply utility for one effective-dated employee schedule. */
import 'dotenv/config';
import { RoleCode } from '@prisma/client';
import { prisma } from '../src/plugins/prisma.js';
import { checkDatabaseUrl, EXPECTED_DATABASE } from './db-guard.js';
import { computeAttendanceMetrics } from '../src/services/attendance.service.js';
import { createEmployeeWorkSchedule, resolveEmployeeWorkSchedule } from '../src/services/employee-work-schedule.service.js';
import { PayrollSettings } from '../src/services/settings.service.js';
import { recordAudit } from '../src/services/audit.service.js';

const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const apply = process.argv.includes('--apply');
const employeeCode = arg('--employee');
const workStartTime = arg('--start');
const workEndTime = arg('--end');
const effectiveFrom = arg('--effective-from');

async function main() {
  const guard = checkDatabaseUrl(process.env.DATABASE_URL);
  if (!guard.ok || guard.target?.database !== EXPECTED_DATABASE) throw new Error(guard.message);
  const [{ db }] = await prisma.$queryRaw<Array<{ db: string }>>`SELECT DATABASE() AS db`;
  if (db !== EXPECTED_DATABASE) throw new Error(`Refusing database ${db}`);
  if (!employeeCode || !workStartTime || !workEndTime || !effectiveFrom) {
    throw new Error('Usage: --employee CODE --start HH:mm --end HH:mm --effective-from YYYY-MM-DD [--apply]');
  }
  const employee = await prisma.employee.findUnique({
    where: { employeeCode },
    select: { id: true, employeeCode: true, firstName: true, lastName: true, employmentType: true },
  });
  if (!employee) throw new Error(`Employee ${employeeCode} not found`);
  const deploymentUser = await prisma.user.findFirst({
    where: { isActive: true, role: { code: { in: [RoleCode.SUPER_ADMIN, RoleCode.ADMIN] } } },
    include: { role: { select: { code: true } } },
    orderBy: { createdAt: 'asc' },
  });
  if (!deploymentUser) throw new Error('No active administrator is available for schedule audit metadata');
  const actor = { userId: deploymentUser.id, email: deploymentUser.email, role: deploymentUser.role.code,
    ip: null, userAgent: 'apply-employee-work-schedule' };
  const effectiveDate = new Date(`${effectiveFrom}T00:00:00.000Z`);
  const before = await resolveEmployeeWorkSchedule(employee.id, effectiveDate);
  const comparisonEmployee = await prisma.employee.findFirst({
    where: { id: { not: employee.id }, status: { in: ['ACTIVE', 'PROBATION'] } },
    orderBy: { employeeCode: 'asc' }, select: { id: true, employeeCode: true },
  });
  const comparison = comparisonEmployee
    ? await resolveEmployeeWorkSchedule(comparisonEmployee.id, effectiveDate)
    : null;
  const existing = await prisma.employeeWorkSchedule.findMany({ where: { employeeId: employee.id }, orderBy: { effectiveFrom: 'asc' } });
  const protectedPeriods = await prisma.payrollPeriod.count({ where: { status: { in: ['PAID', 'LOCKED'] } } });
  const previewSettings = new PayrollSettings({
    ...before.settings.raw(), MONTHLY_WORK_START_TIME: workStartTime, MONTHLY_WORK_END_TIME: workEndTime,
  });
  const at = (time: string) => new Date(`${effectiveFrom}T${time}:00.000Z`);
  const interpretations = ['07:30|16:30', '07:31|16:30', '08:30|16:30', '07:30|16:00'].map((pair) => {
    const [checkIn, checkOut] = pair.split('|');
    const result = computeAttendanceMetrics({ workDate: effectiveDate, checkIn: at(checkIn), checkOut: at(checkOut),
      isHoliday: false, isWeekend: false, isOnLeave: false, employmentType: employee.employmentType }, previewSettings);
    return { checkIn, checkOut, lateMinutes: result.lateMinutes, earlyLeaveMinutes: result.earlyLeaveMinutes };
  });
  console.log(JSON.stringify({ database: db, mode: apply ? 'APPLY' : 'READ_ONLY_PREVIEW', employee,
    requested: { workStartTime, workEndTime, effectiveFrom },
    currentAtEffectiveDate: { workStartTime: before.workStartTime, workEndTime: before.workEndTime, source: before.source },
    comparisonEmployee: comparisonEmployee && comparison ? { employeeCode: comparisonEmployee.employeeCode,
      workStartTime: comparison.workStartTime, workEndTime: comparison.workEndTime, source: comparison.source } : null,
    existingScheduleCount: existing.length, protectedPaidOrLockedPeriods: protectedPeriods,
    attendanceRowsToWrite: 0, payrollRowsToWrite: 0, interpretations,
  }, null, 2));
  if (!apply) return;
  const duplicate = existing.find((row) => row.isActive && row.effectiveFrom.getTime() === effectiveDate.getTime()
    && row.workStartTime === workStartTime && row.workEndTime === workEndTime);
  if (!duplicate) {
    await createEmployeeWorkSchedule(employee.id, { workStartTime, workEndTime, effectiveFrom }, actor);
  } else {
    const authorExists = duplicate.createdBy
      ? await prisma.user.count({ where: { id: duplicate.createdBy } })
      : 0;
    if (!authorExists) {
      await prisma.employeeWorkSchedule.update({ where: { id: duplicate.id },
        data: { createdBy: actor.userId, updatedBy: actor.userId } });
    }
    const auditExists = await prisma.auditLog.count({
      where: { action: 'EMPLOYEE_WORK_SCHEDULE_CREATE', entity: 'EmployeeWorkSchedule', entityId: duplicate.id },
    });
    if (!auditExists) {
      await recordAudit({ action: 'EMPLOYEE_WORK_SCHEDULE_CREATE', entity: 'EmployeeWorkSchedule', entityId: duplicate.id,
        newValue: { employeeId: employee.id, workStartTime, workEndTime, effectiveFrom, deploymentRepair: true },
        userId: actor.userId, userEmail: actor.email, userAgent: actor.userAgent });
    }
  }
  const after = await resolveEmployeeWorkSchedule(employee.id, effectiveDate);
  const afterCount = await prisma.employeeWorkSchedule.count({ where: { employeeId: employee.id } });
  console.log(JSON.stringify({ applied: !duplicate, duplicateSkipped: Boolean(duplicate), after: {
    workStartTime: after.workStartTime, workEndTime: after.workEndTime, source: after.source,
    effectiveFrom: after.effectiveFrom,
  }, scheduleCount: afterCount }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
