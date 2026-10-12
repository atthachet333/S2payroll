import { Prisma, type EmployeeWorkSchedule, type EmployeeWorkScheduleOverride, type WorkScheduleProfile } from '@prisma/client';
import { prisma } from '../plugins/prisma.js';
import { dayjs, timeStringToMinutes } from '../utils/datetime.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import { PayrollSettings, loadSettings } from './settings.service.js';
import { recordAudit } from './audit.service.js';
import type { Actor } from './payroll.service.js';

export type WorkScheduleSource = 'DATE_OVERRIDE' | 'EMPLOYEE' | 'COMPANY_PROFILE' | 'COMPANY_DEFAULT';

export interface ResolvedEmployeeWorkSchedule {
  employeeId: string | null;
  workStartTime: string;
  workEndTime: string;
  source: WorkScheduleSource;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  settings: PayrollSettings;
}

type ScheduleRange = Pick<EmployeeWorkSchedule, 'employeeId' | 'workStartTime' | 'workEndTime' | 'effectiveFrom' | 'effectiveTo' | 'isActive'>;
type DateOverride = Pick<EmployeeWorkScheduleOverride, 'employeeId' | 'workDate' | 'workStartTime' | 'workEndTime'>;
type CompanyRange = Pick<WorkScheduleProfile, 'workStartTime' | 'workEndTime' | 'workingDays' | 'flexArrivalMinutes' | 'effectiveFrom' | 'effectiveTo' | 'isActive'>;

const covers = (from: Date, to: Date | null, date: Date) =>
  from <= date && (to === null || to >= date);

export const rangesOverlap = (
  leftFrom: Date,
  leftTo: Date | null,
  rightFrom: Date,
  rightTo: Date | null
) => leftFrom <= (rightTo ?? new Date('9999-12-31')) && rightFrom <= (leftTo ?? new Date('9999-12-31'));

export function resolveScheduleFromRanges(input: {
  employeeId: string | null;
  date: Date;
  base: PayrollSettings;
  companySchedules: CompanyRange[];
  employeeSchedules: ScheduleRange[];
  dateOverrides?: DateOverride[];
}): ResolvedEmployeeWorkSchedule {
  const date = dayjs.utc(input.date).startOf('day').toDate();
  const company = input.companySchedules
    .filter((row) => row.isActive && covers(row.effectiveFrom, row.effectiveTo, date))
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
  const personal = input.employeeId
    ? input.employeeSchedules
        .filter((row) => row.employeeId === input.employeeId && row.isActive && covers(row.effectiveFrom, row.effectiveTo, date))
        .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0]
    : undefined;
  const dateOverride = input.employeeId
    ? input.dateOverrides?.find((row) => row.employeeId === input.employeeId && row.workDate.getTime() === date.getTime())
    : undefined;

  const baseMap = input.base.raw();
  const defaultStart = baseMap.MONTHLY_WORK_START_TIME || baseMap.WORK_START_TIME || '08:30';
  const defaultEnd = baseMap.MONTHLY_WORK_END_TIME || baseMap.WORK_END_TIME || '17:30';
  const companyMap: Record<string, string> = company ? {
    WORKING_DAYS: company.workingDays,
    LATE_GRACE_MINUTES: String(company.flexArrivalMinutes),
  } : {};
  const workStartTime = dateOverride?.workStartTime ?? personal?.workStartTime ?? company?.workStartTime ?? defaultStart;
  const workEndTime = dateOverride?.workEndTime ?? personal?.workEndTime ?? company?.workEndTime ?? defaultEnd;
  const settings = new PayrollSettings({
    ...baseMap,
    ...companyMap,
    MONTHLY_WORK_START_TIME: workStartTime,
    MONTHLY_WORK_END_TIME: workEndTime,
    WORK_START_TIME: workStartTime,
    WORK_END_TIME: workEndTime,
  });

  return {
    employeeId: input.employeeId,
    workStartTime,
    workEndTime,
    source: dateOverride ? 'DATE_OVERRIDE' : personal ? 'EMPLOYEE' : company ? 'COMPANY_PROFILE' : 'COMPANY_DEFAULT',
    effectiveFrom: dateOverride?.workDate ?? personal?.effectiveFrom ?? company?.effectiveFrom ?? null,
    effectiveTo: dateOverride?.workDate ?? personal?.effectiveTo ?? company?.effectiveTo ?? null,
    settings,
  };
}

export async function createEmployeeWorkScheduleResolver(employeeIds?: string[]) {
  const [base, companySchedules, employeeSchedules, dateOverrides] = await Promise.all([
    loadSettings(),
    prisma.workScheduleProfile.findMany({ where: { isActive: true } }),
    prisma.employeeWorkSchedule.findMany({
      where: { isActive: true, ...(employeeIds?.length ? { employeeId: { in: employeeIds } } : {}) },
    }),
    prisma.employeeWorkScheduleOverride.findMany({
      where: employeeIds?.length ? { employeeId: { in: employeeIds } } : undefined,
    }),
  ]);
  return (employeeId: string | null, date: Date) =>
    resolveScheduleFromRanges({ employeeId, date, base, companySchedules, employeeSchedules, dateOverrides });
}

export async function resolveEmployeeWorkSchedule(employeeId: string, date = new Date()) {
  const resolve = await createEmployeeWorkScheduleResolver([employeeId]);
  return resolve(employeeId, date);
}

export const listEmployeeWorkSchedules = (employeeId: string) =>
  prisma.employeeWorkSchedule.findMany({ where: { employeeId }, orderBy: { effectiveFrom: 'desc' } });

export const listEmployeeWorkScheduleOverrides = (employeeId: string) =>
  prisma.employeeWorkScheduleOverride.findMany({
    where: { employeeId }, orderBy: { workDate: 'desc' },
    include: { createdByUser: { select: { id: true, firstName: true, lastName: true, email: true } } },
  });

export interface EmployeeWorkScheduleInput {
  workStartTime: string;
  workEndTime: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
}

function assertTimes(start: string, end: string) {
  if (timeStringToMinutes(end) <= timeStringToMinutes(start)) {
    throw badRequest('เวลาเลิกงานต้องอยู่หลังเวลาเข้างาน');
  }
}

export function assertNoDuplicateDateOverride(existing: DateOverride | null | undefined): void {
  if (existing) throw conflict('มีตารางเวลาทำงานเฉพาะวันสำหรับพนักงานและวันที่นี้แล้ว');
}

export async function createEmployeeWorkScheduleOverride(employeeId: string, input: {
  workDate: string; workStartTime: string; workEndTime: string; reason: string;
}, actor: Actor) {
  assertTimes(input.workStartTime, input.workEndTime);
  const workDate = dayjs.utc(input.workDate).startOf('day').toDate();
  if (!await prisma.employee.count({ where: { id: employeeId } })) throw notFound('Employee');
  const protectedHistory = await prisma.payrollPeriod.findFirst({
    where: { startDate: { lte: workDate }, endDate: { gte: workDate }, status: { in: ['APPROVED', 'PAID', 'LOCKED'] } },
    select: { name: true, status: true },
  });
  const lockedAttendance = await prisma.attendanceRecord.count({ where: { employeeId, workDate, isLocked: true } });
  if (protectedHistory || lockedAttendance) {
    throw badRequest(`วันที่นี้อยู่ในรอบเงินเดือนที่สรุปแล้ว${protectedHistory ? ` ${protectedHistory.name} (${protectedHistory.status})` : ''}`);
  }
  const existing = await prisma.employeeWorkScheduleOverride.findUnique({
    where: { employee_work_schedule_override_date: { employeeId, workDate } },
  });
  assertNoDuplicateDateOverride(existing);
  let override: EmployeeWorkScheduleOverride;
  try {
    override = await prisma.employeeWorkScheduleOverride.create({
      data: { employeeId, workDate, workStartTime: input.workStartTime,
        workEndTime: input.workEndTime, reason: input.reason.trim(), createdBy: actor.userId },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw conflict('มีตารางเวลาทำงานเฉพาะวันสำหรับพนักงานและวันที่นี้แล้ว');
    }
    throw error;
  }
  await recordAudit({ action: 'EMPLOYEE_WORK_SCHEDULE_OVERRIDE_CREATE', entity: 'EmployeeWorkScheduleOverride', entityId: override.id,
    newValue: override, reason: override.reason, userId: actor.userId, userEmail: actor.email,
    ipAddress: actor.ip, userAgent: actor.userAgent });
  return override;
}

/**
 * Shrinks the sibling schedule that currently covers `effectiveFrom` and
 * rejects a conflicting window, scoped to one employee's OTHER active rows.
 * Shared by create (no excludeId) and update (excludeId = the row being
 * edited, so editing in place never conflicts with itself).
 */
async function reserveScheduleWindow(
  tx: Prisma.TransactionClient,
  employeeId: string,
  effectiveFrom: Date,
  effectiveTo: Date | null,
  actorId: string,
  excludeId?: string
): Promise<void> {
  const schedules = await tx.employeeWorkSchedule.findMany({
    where: { employeeId, isActive: true, ...(excludeId ? { id: { not: excludeId } } : {}) },
  });
  const sameStart = schedules.find((row) => row.effectiveFrom.getTime() === effectiveFrom.getTime());
  if (sameStart) throw badRequest('มีตารางทำงานที่เริ่มใช้ในวันที่นี้แล้ว');

  const covering = schedules.find((row) => row.effectiveFrom < effectiveFrom && covers(row.effectiveFrom, row.effectiveTo, effectiveFrom));
  if (covering) {
    await tx.employeeWorkSchedule.update({
      where: { id: covering.id },
      data: { effectiveTo: dayjs.utc(effectiveFrom).subtract(1, 'day').toDate(), updatedBy: actorId },
    });
  }
  const remaining = schedules.filter((row) => row.id !== covering?.id);
  if (remaining.some((row) => rangesOverlap(row.effectiveFrom, row.effectiveTo, effectiveFrom, effectiveTo))) {
    throw badRequest('ช่วงวันที่ของตารางทำงานทับซ้อนกับรายการที่มีอยู่');
  }
}

export async function createEmployeeWorkSchedule(employeeId: string, input: EmployeeWorkScheduleInput, actor: Actor) {
  assertTimes(input.workStartTime, input.workEndTime);
  const effectiveFrom = dayjs.utc(input.effectiveFrom).startOf('day').toDate();
  const effectiveTo = input.effectiveTo ? dayjs.utc(input.effectiveTo).startOf('day').toDate() : null;
  if (effectiveTo && effectiveTo < effectiveFrom) throw badRequest('วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มใช้');
  if (!await prisma.employee.count({ where: { id: employeeId } })) throw notFound('Employee');

  const result = await prisma.$transaction(async (tx) => {
    await reserveScheduleWindow(tx, employeeId, effectiveFrom, effectiveTo, actor.userId);
    return tx.employeeWorkSchedule.create({
      data: { employeeId, workStartTime: input.workStartTime, workEndTime: input.workEndTime,
        effectiveFrom, effectiveTo, createdBy: actor.userId, updatedBy: actor.userId },
    });
  });
  await recordAudit({ action: 'EMPLOYEE_WORK_SCHEDULE_CREATE', entity: 'EmployeeWorkSchedule', entityId: result.id,
    newValue: result, userId: actor.userId, userEmail: actor.email, ipAddress: actor.ip, userAgent: actor.userAgent });
  return result;
}

export interface EmployeeWorkScheduleUpdateInput extends EmployeeWorkScheduleInput {
  reason?: string | null;
}

/**
 * Updates the SAME schedule row in place (e.g. correcting the times on an
 * already-effective personal schedule). Unlike create, the row being edited
 * is excluded from the duplicate/overlap check, so keeping effectiveFrom
 * unchanged while changing the times is not treated as a conflict.
 */
export async function updateEmployeeWorkSchedule(
  employeeId: string,
  scheduleId: string,
  input: EmployeeWorkScheduleUpdateInput,
  actor: Actor
) {
  assertTimes(input.workStartTime, input.workEndTime);
  const effectiveFrom = dayjs.utc(input.effectiveFrom).startOf('day').toDate();
  const effectiveTo = input.effectiveTo ? dayjs.utc(input.effectiveTo).startOf('day').toDate() : null;
  if (effectiveTo && effectiveTo < effectiveFrom) throw badRequest('วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มใช้');

  const existing = await prisma.employeeWorkSchedule.findFirst({ where: { id: scheduleId, employeeId } });
  if (!existing) throw notFound('EmployeeWorkSchedule');

  const result = await prisma.$transaction(async (tx) => {
    await reserveScheduleWindow(tx, employeeId, effectiveFrom, effectiveTo, actor.userId, scheduleId);
    return tx.employeeWorkSchedule.update({
      where: { id: scheduleId },
      data: { workStartTime: input.workStartTime, workEndTime: input.workEndTime,
        effectiveFrom, effectiveTo, updatedBy: actor.userId },
    });
  });
  await recordAudit({ action: 'EMPLOYEE_WORK_SCHEDULE_UPDATE', entity: 'EmployeeWorkSchedule', entityId: result.id,
    oldValue: existing, newValue: result, reason: input.reason?.trim() || null,
    userId: actor.userId, userEmail: actor.email, ipAddress: actor.ip, userAgent: actor.userAgent });
  return result;
}

export async function useCompanyWorkSchedule(employeeId: string, effectiveFromText: string, actor: Actor) {
  const effectiveFrom = dayjs.utc(effectiveFromText).startOf('day').toDate();
  const changed = await prisma.$transaction(async (tx) => {
    const schedules = await tx.employeeWorkSchedule.findMany({ where: { employeeId, isActive: true } });
    const covering = schedules.find((row) => covers(row.effectiveFrom, row.effectiveTo, effectiveFrom));
    if (!covering) return null;
    return tx.employeeWorkSchedule.update({
      where: { id: covering.id },
      data: covering.effectiveFrom.getTime() === effectiveFrom.getTime()
        ? { isActive: false, updatedBy: actor.userId }
        : { effectiveTo: dayjs.utc(effectiveFrom).subtract(1, 'day').toDate(), updatedBy: actor.userId },
    });
  });
  await recordAudit({ action: 'EMPLOYEE_WORK_SCHEDULE_USE_COMPANY', entity: 'Employee', entityId: employeeId,
    oldValue: changed, newValue: { effectiveFrom: effectiveFromText, source: 'COMPANY' },
    userId: actor.userId, userEmail: actor.email, ipAddress: actor.ip, userAgent: actor.userAgent });
  return resolveEmployeeWorkSchedule(employeeId, effectiveFrom);
}
