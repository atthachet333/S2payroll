import { AttendanceStatus, Prisma } from '@prisma/client';
import { prisma } from '../plugins/prisma.js';
import { loadSettings, type PayrollSettings } from './settings.service.js';
import { recordAudit } from './audit.service.js';
import {
  dayjs,
  isWeekend as isWeekendDate,
  minutesSinceMidnight,
  toUtcDateOnly,
} from '../utils/datetime.js';
import { badRequest, notFound } from '../utils/errors.js';

export interface AttendanceMetrics {
  workedMinutes: number;
  normalMinutes: number;
  otMinutes: number;
  breakMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  isMissingCheckIn: boolean;
  isMissingCheckOut: boolean;
  isAbsent: boolean;
  status: AttendanceStatus;
}

export interface MetricsInput {
  workDate: Date;
  checkIn: Date | null;
  checkOut: Date | null;
  isHoliday: boolean;
  isWeekend: boolean;
  isOnLeave: boolean;
  otEligible?: boolean;
}

/**
 * Pure, deterministic per-day attendance computation. No database access, so it
 * is fully unit-testable and is the single definition of what "late", "OT" and
 * "absent" mean for this system.
 *
 * Rules, all driven by settings:
 *   - worked = checkOut - checkIn, minus the unpaid break once the day is long
 *     enough to have taken one
 *   - late   = minutes past WORK_START_TIME beyond LATE_GRACE_MINUTES
 *   - OT     = paid minutes beyond STANDARD_WORK_HOURS, ignored below MIN_OT_MINUTES.
 *              On a holiday or weekend the entire worked duration is OT.
 *   - a day with one punch missing is MISSING_DATA, never silently absent
 */
export function computeAttendanceMetrics(
  input: MetricsInput,
  settings: PayrollSettings
): AttendanceMetrics {
  const { checkIn, checkOut, isHoliday, isWeekend, isOnLeave } = input;

  const base: AttendanceMetrics = {
    workedMinutes: 0,
    normalMinutes: 0,
    otMinutes: 0,
    breakMinutes: 0,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    isMissingCheckIn: !checkIn,
    isMissingCheckOut: !checkOut,
    isAbsent: false,
    status: AttendanceStatus.NORMAL,
  };

  // Approved leave wins over everything: no punches expected, nothing deducted.
  if (isOnLeave) {
    return { ...base, isMissingCheckIn: false, isMissingCheckOut: false, status: AttendanceStatus.LEAVE };
  }

  if (!checkIn && !checkOut) {
    if (isHoliday) return { ...base, isMissingCheckIn: false, isMissingCheckOut: false, status: AttendanceStatus.HOLIDAY };
    if (isWeekend && !settings.boolean('COUNT_WEEKEND_AS_WORKDAY')) {
      return { ...base, isMissingCheckIn: false, isMissingCheckOut: false, status: AttendanceStatus.NORMAL };
    }
    // A day with no punches at all is an absence, which is a known state - not a
    // data problem. Leaving the missing-punch flags set here would double-report
    // every absence as "missing check-in" and "missing check-out" on the payroll
    // review screen, obscuring the days that genuinely need a human decision.
    return {
      ...base,
      isMissingCheckIn: false,
      isMissingCheckOut: false,
      isAbsent: true,
      status: AttendanceStatus.ABSENT,
    };
  }

  // Exactly one punch present - we cannot compute a duration, so flag it for review.
  if (!checkIn || !checkOut) {
    return { ...base, status: AttendanceStatus.MISSING_DATA };
  }

  // A check-out before the check-in means an overnight shift; roll it forward a day.
  let outMoment = dayjs.utc(checkOut);
  const inMoment = dayjs.utc(checkIn);
  if (outMoment.isBefore(inMoment)) outMoment = outMoment.add(1, 'day');

  const rawMinutes = Math.max(0, outMoment.diff(inMoment, 'minute'));
  const configuredBreak = settings.number('BREAK_MINUTES');
  const standardMinutes = Math.round(settings.decimal('STANDARD_WORK_HOURS').times(60).toNumber());

  // Only subtract the break from a day long enough to have contained one.
  const breakMinutes = rawMinutes > configuredBreak ? configuredBreak : 0;
  const workedMinutes = Math.max(0, rawMinutes - breakMinutes);

  const otEnabled = settings.boolean('OT_ENABLED') && input.otEligible !== false;
  const minOt = settings.number('MIN_OT_MINUTES');

  let normalMinutes = workedMinutes;
  let otMinutes = 0;
  let lateMinutes = 0;
  let earlyLeaveMinutes = 0;

  if (isHoliday || isWeekend) {
    // Any attendance on a non-working day is entirely overtime.
    normalMinutes = 0;
    otMinutes = otEnabled ? workedMinutes : 0;
  } else {
    normalMinutes = Math.min(workedMinutes, standardMinutes);
    const overflow = Math.max(0, workedMinutes - standardMinutes);
    otMinutes = otEnabled ? overflow : 0;

    const startMinutes = settings.timeMinutes('WORK_START_TIME');
    const endMinutes = settings.timeMinutes('WORK_END_TIME');
    const grace = settings.number('LATE_GRACE_MINUTES');
    const earlyGrace = settings.number('EARLY_LEAVE_GRACE_MINUTES');

    const arrival = minutesSinceMidnight(checkIn);
    if (arrival > startMinutes + grace) lateMinutes = arrival - startMinutes;

    // Only count early leave for a same-day departure, not an overnight shift.
    if (outMoment.isSame(inMoment, 'day')) {
      const departure = minutesSinceMidnight(outMoment.toDate());
      if (departure < endMinutes - earlyGrace) earlyLeaveMinutes = endMinutes - departure;
    }
  }

  if (otMinutes < minOt) otMinutes = 0;

  let status: AttendanceStatus = AttendanceStatus.NORMAL;
  if (isHoliday) status = AttendanceStatus.HOLIDAY;
  if (otMinutes > 0) status = AttendanceStatus.OT;
  if (lateMinutes > 0) status = AttendanceStatus.LATE;

  return {
    workedMinutes,
    normalMinutes,
    otMinutes,
    breakMinutes,
    lateMinutes,
    earlyLeaveMinutes,
    isMissingCheckIn: false,
    isMissingCheckOut: false,
    isAbsent: false,
    status,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface AttendanceListParams {
  page: number;
  pageSize: number;
  employeeId?: string;
  departmentId?: string;
  from?: Date;
  to?: Date;
  status?: AttendanceStatus;
  search?: string;
}

export async function listAttendance(params: AttendanceListParams) {
  const where: Prisma.AttendanceRecordWhereInput = {
    ...(params.employeeId ? { employeeId: params.employeeId } : {}),
    ...(params.status ? { status: params.status } : {}),
    ...(params.departmentId ? { employee: { departmentId: params.departmentId } } : {}),
    ...(params.from || params.to
      ? {
          workDate: {
            ...(params.from ? { gte: params.from } : {}),
            ...(params.to ? { lte: params.to } : {}),
          },
        }
      : {}),
    ...(params.search
      ? {
          OR: [
            { employeeCode: { contains: params.search } },
            { employee: { firstName: { contains: params.search } } },
            { employee: { lastName: { contains: params.search } } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.attendanceRecord.findMany({
      where,
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            nickname: true,
            department: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ workDate: 'desc' }, { employeeCode: 'asc' }],
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.attendanceRecord.count({ where }),
  ]);

  return { items, total, page: params.page, pageSize: params.pageSize };
}

export async function getAttendanceById(id: string) {
  const record = await prisma.attendanceRecord.findUnique({
    where: { id },
    include: {
      employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
      adjustments: { orderBy: { changedAt: 'desc' } },
      rawData: true,
    },
  });
  if (!record) throw notFound('Attendance record');
  return record;
}

export interface AttendanceCorrection {
  checkIn?: string | null;
  checkOut?: string | null;
  status?: AttendanceStatus;
  note?: string | null;
  reason: string;
}

/**
 * Apply a manual correction. The imported values in original_check_in /
 * original_check_out are left untouched, every changed field produces an
 * AttendanceAdjustment row, and derived metrics are recomputed from the
 * corrected punches.
 */
export async function correctAttendance(
  id: string,
  input: AttendanceCorrection,
  actor: { userId: string; email: string; ip?: string | null; userAgent?: string | null }
) {
  const record = await prisma.attendanceRecord.findUnique({
    where: { id },
    include: { employee: { select: { otEligible: true } } },
  });
  if (!record) throw notFound('Attendance record');
  if (record.isLocked) {
    throw badRequest('ไม่สามารถแก้ไขได้ เนื่องจากรอบเงินเดือนถูกล็อกแล้ว');
  }

  const workDate = record.workDate;
  const parsePunch = (value: string | null | undefined, current: Date | null): Date | null => {
    if (value === undefined) return current;
    if (value === null || value === '') return null;
    // Accept "HH:mm" (attached to the work date) or a full ISO timestamp.
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(value)) {
      const [h = '0', m = '0', s = '0'] = value.split(':');
      return dayjs
        .utc(workDate)
        .startOf('day')
        .hour(Number(h))
        .minute(Number(m))
        .second(Number(s))
        .toDate();
    }
    const parsed = dayjs.utc(value);
    if (!parsed.isValid()) throw badRequest(`Invalid time value: ${value}`);
    return parsed.toDate();
  };

  const nextCheckIn = parsePunch(input.checkIn, record.checkIn);
  const nextCheckOut = parsePunch(input.checkOut, record.checkOut);

  const settings = await loadSettings();
  const [leave] = await prisma.leaveRecord.findMany({
    where: {
      employeeId: record.employeeId,
      status: 'APPROVED',
      startDate: { lte: workDate },
      endDate: { gte: workDate },
    },
    take: 1,
  });

  const metrics = computeAttendanceMetrics(
    {
      workDate,
      checkIn: nextCheckIn,
      checkOut: nextCheckOut,
      isHoliday: record.isHoliday,
      isWeekend: record.isWeekend,
      isOnLeave: Boolean(leave),
      otEligible: record.employee.otEligible,
    },
    settings
  );

  const fmt = (d: Date | null) => (d ? dayjs.utc(d).format('YYYY-MM-DD HH:mm') : null);
  const changes: { fieldName: string; oldValue: string | null; newValue: string | null }[] = [];
  if (fmt(record.checkIn) !== fmt(nextCheckIn)) {
    changes.push({ fieldName: 'checkIn', oldValue: fmt(record.checkIn), newValue: fmt(nextCheckIn) });
  }
  if (fmt(record.checkOut) !== fmt(nextCheckOut)) {
    changes.push({ fieldName: 'checkOut', oldValue: fmt(record.checkOut), newValue: fmt(nextCheckOut) });
  }
  const finalStatus = input.status ?? metrics.status;
  if (record.status !== finalStatus) {
    changes.push({ fieldName: 'status', oldValue: record.status, newValue: finalStatus });
  }
  if (input.note !== undefined && (record.note ?? null) !== (input.note ?? null)) {
    changes.push({ fieldName: 'note', oldValue: record.note, newValue: input.note ?? null });
  }

  if (changes.length === 0) return record;

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.attendanceRecord.update({
      where: { id },
      data: {
        checkIn: nextCheckIn,
        checkOut: nextCheckOut,
        workedMinutes: metrics.workedMinutes,
        normalMinutes: metrics.normalMinutes,
        otMinutes: metrics.otMinutes,
        breakMinutes: metrics.breakMinutes,
        lateMinutes: metrics.lateMinutes,
        earlyLeaveMinutes: metrics.earlyLeaveMinutes,
        isMissingCheckIn: metrics.isMissingCheckIn,
        isMissingCheckOut: metrics.isMissingCheckOut,
        isAbsent: metrics.isAbsent,
        status: finalStatus,
        note: input.note ?? record.note,
        isCorrected: true,
        source: 'MANUAL',
      },
    });

    await tx.attendanceAdjustment.createMany({
      data: changes.map((c) => ({
        attendanceRecordId: id,
        fieldName: c.fieldName,
        oldValue: c.oldValue,
        newValue: c.newValue,
        reason: input.reason,
        changedBy: actor.userId,
      })),
    });

    return result;
  });

  await recordAudit({
    action: 'ATTENDANCE_CORRECT',
    entity: 'AttendanceRecord',
    entityId: id,
    oldValue: { checkIn: fmt(record.checkIn), checkOut: fmt(record.checkOut), status: record.status },
    newValue: { checkIn: fmt(nextCheckIn), checkOut: fmt(nextCheckOut), status: finalStatus },
    reason: input.reason,
    userId: actor.userId,
    userEmail: actor.email,
    ipAddress: actor.ip,
    userAgent: actor.userAgent,
  });

  return updated;
}

/** Aggregate counts used by the Overview page and the attendance summary cards. */
export async function attendanceSummary(from: Date, to: Date, departmentId?: string) {
  const where: Prisma.AttendanceRecordWhereInput = {
    workDate: { gte: from, lte: to },
    ...(departmentId ? { employee: { departmentId } } : {}),
  };

  const grouped = await prisma.attendanceRecord.groupBy({
    by: ['status'],
    where,
    _count: { _all: true },
  });

  const counts: Record<string, number> = {
    NORMAL: 0,
    LATE: 0,
    OT: 0,
    ABSENT: 0,
    MISSING_DATA: 0,
    LEAVE: 0,
    HOLIDAY: 0,
  };
  for (const row of grouped) counts[row.status] = row._count._all;

  const totals = await prisma.attendanceRecord.aggregate({
    where,
    _sum: { workedMinutes: true, otMinutes: true, lateMinutes: true },
  });

  return {
    counts,
    present: counts.NORMAL + counts.LATE + counts.OT,
    late: counts.LATE,
    absent: counts.ABSENT,
    leave: counts.LEAVE,
    missingData: counts.MISSING_DATA,
    totalWorkedMinutes: totals._sum.workedMinutes ?? 0,
    totalOtMinutes: totals._sum.otMinutes ?? 0,
    totalLateMinutes: totals._sum.lateMinutes ?? 0,
  };
}

/**
 * Recompute every attendance row in a range against the current settings.
 * Used after an attendance-rule change so an already-imported month reflects
 * the new rules without re-syncing the sheet.
 */
export async function recalculateRange(from: Date, to: Date): Promise<number> {
  const settings = await loadSettings();
  const records = await prisma.attendanceRecord.findMany({
    where: { workDate: { gte: toUtcDateOnly(from), lte: toUtcDateOnly(to) }, isLocked: false },
    include: { employee: { select: { otEligible: true } } },
  });

  const leaves = await prisma.leaveRecord.findMany({
    where: { status: 'APPROVED', startDate: { lte: to }, endDate: { gte: from } },
  });

  const onLeave = (employeeId: string, date: Date): boolean =>
    leaves.some(
      (l) => l.employeeId === employeeId && l.startDate <= date && l.endDate >= date
    );

  let updated = 0;
  for (const record of records) {
    const metrics = computeAttendanceMetrics(
      {
        workDate: record.workDate,
        checkIn: record.checkIn,
        checkOut: record.checkOut,
        isHoliday: record.isHoliday,
        isWeekend: isWeekendDate(record.workDate),
        isOnLeave: onLeave(record.employeeId, record.workDate),
        otEligible: record.employee.otEligible,
      },
      settings
    );
    await prisma.attendanceRecord.update({
      where: { id: record.id },
      data: {
        workedMinutes: metrics.workedMinutes,
        normalMinutes: metrics.normalMinutes,
        otMinutes: metrics.otMinutes,
        breakMinutes: metrics.breakMinutes,
        lateMinutes: metrics.lateMinutes,
        earlyLeaveMinutes: metrics.earlyLeaveMinutes,
        isMissingCheckIn: metrics.isMissingCheckIn,
        isMissingCheckOut: metrics.isMissingCheckOut,
        isAbsent: metrics.isAbsent,
        // A manually set status is preserved; only derived statuses are refreshed.
        status: record.isCorrected ? record.status : metrics.status,
      },
    });
    updated += 1;
  }
  return updated;
}
