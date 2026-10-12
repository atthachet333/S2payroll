/** Guarded read-only preview / idempotent apply for one daily schedule override. */
import 'dotenv/config';
import { RoleCode } from '@prisma/client';
import { prisma } from '../src/plugins/prisma.js';
import { checkDatabaseUrl, EXPECTED_DATABASE } from './db-guard.js';
import { computeAttendanceMetrics } from '../src/services/attendance.service.js';
import { PayrollSettings } from '../src/services/settings.service.js';
import {
  createEmployeeWorkScheduleOverride,
  resolveEmployeeWorkSchedule,
} from '../src/services/employee-work-schedule.service.js';
import { recalculateRange } from '../src/services/attendance.service.js';
import { recordAudit } from '../src/services/audit.service.js';

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const apply = process.argv.includes('--apply');

async function main() {
  const employeeCode = argument('--employee');
  const workDateText = argument('--date');
  const workStartTime = argument('--start');
  const workEndTime = argument('--end');
  const reasonBase64 = argument('--reason-base64');
  const reason = reasonBase64 ? Buffer.from(reasonBase64, 'base64').toString('utf8') : argument('--reason');
  if (!employeeCode || !workDateText || !workStartTime || !workEndTime || !reason) {
    throw new Error('Usage: --employee CODE --date YYYY-MM-DD --start HH:mm --end HH:mm --reason TEXT [--apply]');
  }
  const guard = checkDatabaseUrl(process.env.DATABASE_URL);
  if (!guard.ok || guard.target?.database !== EXPECTED_DATABASE) throw new Error(guard.message);
  const [{ db }] = await prisma.$queryRaw<Array<{ db: string }>>`SELECT DATABASE() AS db`;
  if (db !== EXPECTED_DATABASE) throw new Error(`Refusing database ${db}`);

  const workDate = new Date(`${workDateText}T00:00:00.000Z`);
  const employee = await prisma.employee.findUnique({ where: { employeeCode },
    select: { id: true, employeeCode: true, firstName: true, lastName: true, employmentType: true, otEligible: true } });
  if (!employee) throw new Error(`Employee ${employeeCode} not found`);
  const [attendance, leave, existingOverride, protectedPeriod] = await Promise.all([
    prisma.attendanceRecord.findUnique({ where: { employee_work_date: { employeeId: employee.id, workDate } } }),
    prisma.leaveRecord.findFirst({ where: { employeeId: employee.id, status: 'APPROVED', startDate: { lte: workDate }, endDate: { gte: workDate } } }),
    prisma.employeeWorkScheduleOverride.findUnique({ where: { employee_work_schedule_override_date: { employeeId: employee.id, workDate } } }),
    prisma.payrollPeriod.findFirst({ where: { startDate: { lte: workDate }, endDate: { gte: workDate }, status: { in: ['APPROVED', 'PAID', 'LOCKED'] } },
      select: { id: true, name: true, status: true } }),
  ]);
  const current = await resolveEmployeeWorkSchedule(employee.id, workDate);
  const requestedSettings = new PayrollSettings({ ...current.settings.raw(),
    MONTHLY_WORK_START_TIME: workStartTime, MONTHLY_WORK_END_TIME: workEndTime,
    WORK_START_TIME: workStartTime, WORK_END_TIME: workEndTime });
  const evaluate = (settings: PayrollSettings) => attendance ? computeAttendanceMetrics({
    workDate, checkIn: attendance.checkIn, checkOut: attendance.checkOut,
    isHoliday: attendance.isHoliday, isWeekend: attendance.isWeekend, isOnLeave: Boolean(leave),
    otEligible: employee.otEligible, employmentType: employee.employmentType,
  }, settings) : null;
  const snapshot = (row: typeof attendance) => row ? {
    checkIn: row.checkIn, checkOut: row.checkOut, originalCheckIn: row.originalCheckIn, originalCheckOut: row.originalCheckOut,
    lateMinutes: row.lateMinutes, earlyLeaveMinutes: row.earlyLeaveMinutes, status: row.status,
  } : null;

  console.log(JSON.stringify({ database: db, mode: apply ? 'APPLY' : 'READ_ONLY_PREVIEW', employee,
    workDate: workDateText, requested: { workStartTime, workEndTime, reason },
    currentSchedule: { workStartTime: current.workStartTime, workEndTime: current.workEndTime, source: current.source },
    storedAttendance: snapshot(attendance), currentInterpretation: evaluate(current.settings),
    expectedInterpretation: evaluate(requestedSettings), existingOverride,
    protectedPeriod: protectedPeriod ?? null, rawPunchesToWrite: 0, payrollRowsToWrite: 0,
  }, null, 2));
  if (!apply) return;
  if (protectedPeriod) throw new Error(`Refusing override inside finalised period ${protectedPeriod.name} (${protectedPeriod.status})`);

  if (existingOverride && (existingOverride.workStartTime !== workStartTime || existingOverride.workEndTime !== workEndTime)) {
    throw new Error('A different override already exists for this employee/date');
  }
  const deploymentUser = await prisma.user.findFirst({
    where: { isActive: true, role: { code: { in: [RoleCode.SUPER_ADMIN, RoleCode.ADMIN] } } },
    include: { role: { select: { code: true } } }, orderBy: { createdAt: 'asc' },
  });
  if (!deploymentUser) throw new Error('No active administrator available for audit metadata');
  const actor = { userId: deploymentUser.id, email: deploymentUser.email, role: deploymentUser.role.code,
    ip: null, userAgent: 'apply-employee-work-schedule-override' };
  if (!existingOverride) {
    await createEmployeeWorkScheduleOverride(employee.id, { workDate: workDateText, workStartTime, workEndTime, reason }, {
      ...actor,
    });
  } else if (existingOverride.reason !== reason) {
    await prisma.employeeWorkScheduleOverride.update({ where: { id: existingOverride.id }, data: { reason } });
    await recordAudit({ action: 'EMPLOYEE_WORK_SCHEDULE_OVERRIDE_REASON_UPDATE', entity: 'EmployeeWorkScheduleOverride',
      entityId: existingOverride.id, oldValue: { reason: existingOverride.reason }, newValue: { reason },
      reason: 'Normalize production reason to the explicitly approved text', userId: actor.userId,
      userEmail: actor.email, userAgent: actor.userAgent });
  }
  const recalculation = await recalculateRange(workDate, workDate, employee.id);
  const [afterSchedule, afterAttendance, afterOverrides] = await Promise.all([
    resolveEmployeeWorkSchedule(employee.id, workDate),
    prisma.attendanceRecord.findUnique({ where: { employee_work_date: { employeeId: employee.id, workDate } } }),
    prisma.employeeWorkScheduleOverride.findMany({ where: { employeeId: employee.id, workDate } }),
  ]);
  console.log(JSON.stringify({ applied: !existingOverride, duplicateSkipped: Boolean(existingOverride), overrideCount: afterOverrides.length,
    override: afterOverrides[0] ?? null,
    recalculation, schedule: { workStartTime: afterSchedule.workStartTime, workEndTime: afterSchedule.workEndTime, source: afterSchedule.source },
    attendance: snapshot(afterAttendance), rawPunchesUnchanged: attendance?.originalCheckIn?.getTime() === afterAttendance?.originalCheckIn?.getTime()
      && attendance?.originalCheckOut?.getTime() === afterAttendance?.originalCheckOut?.getTime(),
  }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
