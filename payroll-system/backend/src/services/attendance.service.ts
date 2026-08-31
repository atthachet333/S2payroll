import { AttendanceStatus, EmploymentType, Prisma } from '@prisma/client';
import { prisma } from '../plugins/prisma.js';
import { loadSettings, loadSettingsForDate, type PayrollSettings } from './settings.service.js';
import { recordAudit } from './audit.service.js';
import {
  dayjs,
  companyClock,
  eachDay,
  formatDateOnly,
  minutesSinceMidnight,
  toUtcDateOnly,
} from '../utils/datetime.js';
import { badRequest, notFound } from '../utils/errors.js';
import { getDayType, isScheduledWorkday } from './schedule-policy.service.js';

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
  employmentType?: EmploymentType;
}

/**
 * Company working-time policy for monthly staff: a fixed 08:30-17:30 day.
 *
 * MONTHLY_WORK_START_TIME / MONTHLY_WORK_END_TIME are the authority. The legacy
 * WORK_START_TIME / WORK_END_TIME keys remain only as a fallback so an
 * un-migrated installation still resolves to something sane.
 */
export function monthlyStartMinutes(settings: PayrollSettings): number {
  const configured = settings.string('MONTHLY_WORK_START_TIME');
  return configured
    ? settings.timeMinutes('MONTHLY_WORK_START_TIME')
    : settings.timeMinutes('WORK_START_TIME');
}

export function monthlyEndMinutes(settings: PayrollSettings): number {
  const configured = settings.string('MONTHLY_WORK_END_TIME');
  return configured
    ? settings.timeMinutes('MONTHLY_WORK_END_TIME')
    : settings.timeMinutes('WORK_END_TIME');
}

/**
 * Required checkout for a monthly employee.
 *
 * Fixed at the configured end of day. Under the previous policy an arrival
 * inside a flex window pushed this later; that mechanism is gone, so arriving
 * at 08:40 still requires a 17:30 checkout and the employee is still late.
 * Staying later does not cancel the lateness.
 */
export function monthlyRequiredCheckoutMinutes(
  _arrivalMinutes: number,
  settings: PayrollSettings
): number {
  return monthlyEndMinutes(settings);
}

export { lateDeductionHours } from '../utils/attendance-math.js';

export interface MonthlyAttendanceEvaluation {
  latestAllowedCheckIn: number;
  lateMinutes: number;
  requiredCheckout: number;
  earlyLeaveMinutes: number;
}

/** Single source of truth for monthly flex arrival, lateness and required checkout. */
export function evaluateMonthlyAttendance(
  arrivalMinutes: number,
  departureMinutes: number | null,
  settings: PayrollSettings
): MonthlyAttendanceEvaluation {
  const start = monthlyStartMinutes(settings);
  // The flex-arrival mechanism was withdrawn, and only MONTHLY_FLEX_ARRIVAL_MINUTES
  // (default 0) can grant any grace. The legacy LATE_GRACE_MINUTES is
  // deliberately NOT read here: with the start time already moved to 08:30, a
  // stale 30 would stack on top and push lateness out to 09:00 - two policies
  // live at once, which is precisely what this revision removes.
  const grace = Math.max(0, settings.number('MONTHLY_FLEX_ARRIVAL_MINUTES'));
  const earlyGrace = Math.max(0, settings.number('EARLY_LEAVE_GRACE_MINUTES'));
  const latestAllowedCheckIn = start + grace;
  const requiredCheckout = monthlyRequiredCheckoutMinutes(arrivalMinutes, settings);
  return {
    latestAllowedCheckIn,
    lateMinutes: Math.max(0, arrivalMinutes - latestAllowedCheckIn),
    requiredCheckout,
    earlyLeaveMinutes:
      departureMinutes === null
        ? 0
        : Math.max(0, requiredCheckout - earlyGrace - departureMinutes),
  };
}

/**
 * Pure, deterministic per-day attendance computation. No database access, so it
 * is fully unit-testable and is the single definition of what "late", "OT" and
 * "absent" mean for this system.
 *
 * Rules, all driven by settings:
 *   - worked = checkOut - checkIn, minus the unpaid break once the day is long
 *     enough to have taken one
 *   - monthly late = minutes past WORK_START_TIME + LATE_GRACE_MINUTES
 *   - DAILY has no scheduled lateness and no OT unless explicitly enabled
 *   - monthly OT = checkout minutes beyond that day's required checkout; it
 *                  never offsets late or early-leave minutes
 *   - other OT   = paid minutes beyond STANDARD_WORK_HOURS, ignored below
 *                  MIN_OT_MINUTES. On a holiday or weekend the entire worked
 *                  duration is OT.
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
    // `isWeekend` means "not a scheduled working day", derived from the
    // WORKING_DAYS setting by schedule-policy.service. Nobody is expected to
    // punch on such a day, so an empty one is simply off - never an absence.
    //
    // This used to be gated on COUNT_WEEKEND_AS_WORKDAY, a leftover from the
    // old fixed Sat/Sun weekend model. With that flag set to true the guard
    // inverted: an empty Sunday evaluated to ABSENT. WORKING_DAYS is now the
    // single authority for which days are worked, so the flag is no longer read.
    if (isWeekend) {
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

  // Attendance is reviewed and corrected at HH:mm precision. Ignore source
  // seconds at both boundaries so 09:15:52 -> 12:23:08 reconciles with the
  // displayed 09:15 -> 12:23 duration of 188 minutes.
  const rawMinutes = Math.max(
    0,
    outMoment.startOf('minute').diff(inMoment.startOf('minute'), 'minute')
  );
  const isDaily = input.employmentType === EmploymentType.DAILY;
  const configuredBreak = settings.number('BREAK_MINUTES');
  const standardMinutes = Math.round(settings.decimal('STANDARD_WORK_HOURS').times(60).toNumber());

  // Only subtract the break from a day long enough to have contained one.
  const deductBreak = !isDaily || settings.boolean('DAILY_DEDUCT_BREAK');
  const breakMinutes = deductBreak && rawMinutes > configuredBreak ? configuredBreak : 0;
  const workedMinutes = Math.max(0, rawMinutes - breakMinutes);

  const typeOtEnabled = isDaily
    ? settings.boolean('DAILY_OT_ENABLED')
    : input.employmentType === EmploymentType.MONTHLY
      ? settings.boolean('MONTHLY_OT_ENABLED')
      : true;
  const otEnabled =
    settings.boolean('OT_ENABLED') &&
    input.otEligible !== false &&
    typeOtEnabled;
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

    if (!isDaily) {
      const arrival = minutesSinceMidnight(checkIn);
      const departure = outMoment.isSame(inMoment, 'day')
        ? minutesSinceMidnight(outMoment.toDate())
        : null;
      const monthly = evaluateMonthlyAttendance(arrival, departure, settings);
      lateMinutes = monthly.lateMinutes;
      earlyLeaveMinutes = monthly.earlyLeaveMinutes;

      // A MONTHLY employee's time categories are deliberately independent.
      // Early arrival cannot compensate for early leave, and staying late
      // cannot erase lateness. Only time after the required checkout can be OT.
      if (input.employmentType === EmploymentType.MONTHLY) {
        otMinutes = otEnabled && departure !== null
          ? Math.max(0, departure - monthly.requiredCheckout)
          : 0;
      }
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
  employmentType?: 'MONTHLY' | 'DAILY' | 'HOURLY' | 'CONTRACT';
  includeExempt?: boolean;
  search?: string;
}

export async function listAttendance(params: AttendanceListParams) {
  const where: Prisma.AttendanceRecordWhereInput = {
    ...(params.employeeId ? { employeeId: params.employeeId } : {}),
    ...(params.status ? { status: params.status } : {}),
    ...(!params.includeExempt || params.departmentId || params.employmentType
      ? { employee: {
          ...(!params.includeExempt ? { attendanceRequired: true } : {}),
          ...(params.departmentId ? { departmentId: params.departmentId } : {}),
          ...(params.employmentType ? { employmentType: params.employmentType } : {}),
        } }
      : {}),
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
            // Daily and hourly staff are paid from these hours directly, so the
            // table has to be able to tell them apart from monthly salaried.
            employmentType: true,
            attendanceRequired: true,
            leaveTrackingRequired: true,
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

  const clock = companyClock();
  const todaySettings = await loadSettingsForDate(new Date(`${clock.date}T00:00:00.000Z`));
  const closeMinutes = monthlyEndMinutes(todaySettings) + Math.max(0, todaySettings.number('ATTENDANCE_CLOSE_GRACE_MINUTES'));
  const effectiveItems = items.map((item) => ({
    ...item,
    status:
      item.status === 'MISSING_DATA' && item.checkIn && !item.checkOut &&
      formatDateOnly(item.workDate) === clock.date && clock.minutes < closeMinutes
        ? 'IN_PROGRESS' as const
        : item.status,
  }));
  return { items: effectiveItems, total, page: params.page, pageSize: params.pageSize };
}

export async function getAttendanceById(id: string) {
  const record = await prisma.attendanceRecord.findUnique({
    where: { id },
    include: {
      employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, employmentType: true } },
      adjustments: { orderBy: { changedAt: 'desc' } },
      rawData: true,
    },
  });
  if (!record) throw notFound('Attendance record');

  // adjustments.changedBy holds a user id; the history panel needs a person.
  // Resolved here rather than joined, because the column is a plain id with no
  // FK relation to users.
  const editorIds = [...new Set(record.adjustments.map((a) => a.changedBy).filter(Boolean))];
  const editors = editorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: editorIds } },
        select: { id: true, firstName: true, lastName: true, email: true },
      })
    : [];
  const editorById = new Map(
    editors.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim() || u.email])
  );

  return {
    ...record,
    adjustments: record.adjustments.map((a) => ({
      ...a,
      changedByName: editorById.get(a.changedBy) ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Delete / restore
// ---------------------------------------------------------------------------

/**
 * Payroll periods whose figures are already finalised. Removing a day beneath
 * one of these would change what has been reviewed, approved or paid without
 * the payroll workflow noticing, so the delete is refused and the operator is
 * told which period is in the way.
 */
const FINALISED_PERIOD_STATUSES = ['APPROVED', 'PAID', 'LOCKED'] as const;

export interface AttendanceDeleteInput {
  reason: string;
}

/**
 * Remove one effective attendance day from the payroll system.
 *
 * What is removed: the AttendanceRecord and its adjustment rows.
 * What is kept:    every raw source event in attendance_raw_data, including any
 *                  checkout summary the employee wrote, plus a full audit entry.
 *
 * The Google Sheet is read-only and remains the source of truth, so deleting
 * alone would let the next sync re-import the day. A suppression row is written
 * for (employee, workDate); the sync consults it and skips the day until an
 * operator explicitly restores it.
 */
export async function deleteAttendance(
  id: string,
  input: AttendanceDeleteInput,
  actor: { userId: string; email: string; ip?: string | null; userAgent?: string | null }
) {
  const reason = (input.reason ?? '').trim();
  if (reason.length < 3) {
    throw badRequest('กรุณาระบุเหตุผลในการลบอย่างน้อย 3 ตัวอักษร');
  }

  const record = await prisma.attendanceRecord.findUnique({
    where: { id },
    include: { employee: { select: { employeeCode: true, firstName: true, lastName: true } } },
  });
  if (!record) throw notFound('Attendance record');

  if (record.isLocked) {
    throw badRequest('ไม่สามารถลบได้ เนื่องจากรอบเงินเดือนถูกล็อกแล้ว');
  }

  // A locked row is the usual guard, but a period can be APPROVED or PAID
  // before it is locked. Refuse there too rather than silently invalidating
  // payroll that has already been signed off.
  const finalised = await prisma.payrollPeriod.findFirst({
    where: {
      startDate: { lte: record.workDate },
      endDate: { gte: record.workDate },
      status: { in: [...FINALISED_PERIOD_STATUSES] },
    },
    select: { code: true, name: true, status: true },
  });
  if (finalised) {
    throw badRequest(
      `ไม่สามารถลบได้ เนื่องจากวันที่นี้อยู่ในรอบเงินเดือน ${finalised.name} ` +
      `ซึ่งมีสถานะ ${finalised.status} แล้ว`
    );
  }

  const snapshot = {
    attendanceId: record.id,
    employeeId: record.employeeId,
    employeeCode: record.employeeCode,
    employeeName: `${record.employee.firstName} ${record.employee.lastName}`.trim(),
    workDate: dayjs.utc(record.workDate).format('YYYY-MM-DD'),
    checkIn: record.checkIn ? dayjs.utc(record.checkIn).format('HH:mm') : null,
    checkOut: record.checkOut ? dayjs.utc(record.checkOut).format('HH:mm') : null,
    originalCheckIn: record.originalCheckIn ? dayjs.utc(record.originalCheckIn).format('HH:mm') : null,
    originalCheckOut: record.originalCheckOut ? dayjs.utc(record.originalCheckOut).format('HH:mm') : null,
    status: record.status,
    workedMinutes: record.workedMinutes,
    lateMinutes: record.lateMinutes,
    wasCorrected: record.isCorrected,
  };

  await prisma.$transaction(async (tx) => {
    await tx.attendanceSuppression.upsert({
      where: { employee_work_date: { employeeId: record.employeeId, workDate: record.workDate } },
      create: {
        employeeId: record.employeeId,
        employeeCode: record.employeeCode,
        workDate: record.workDate,
        reason,
        previousCheckIn: record.checkIn,
        previousCheckOut: record.checkOut,
        createdBy: actor.userId,
      },
      update: { reason, previousCheckIn: record.checkIn, previousCheckOut: record.checkOut, createdBy: actor.userId },
    });
    // Adjustments cascade on the record, but delete them explicitly so the
    // intent is visible rather than relying on the FK rule.
    await tx.attendanceAdjustment.deleteMany({ where: { attendanceRecordId: id } });
    await tx.attendanceRecord.delete({ where: { id } });
  });

  await recordAudit({
    action: 'ATTENDANCE_DELETE',
    entity: 'AttendanceRecord',
    entityId: id,
    oldValue: snapshot,
    newValue: null,
    reason,
    userId: actor.userId,
    userEmail: actor.email,
    ipAddress: actor.ip,
    userAgent: actor.userAgent,
  });

  return { deleted: true, suppressed: true, ...snapshot };
}

/** Lift a suppression so the next sync may re-import the day normally. */
export async function restoreAttendance(
  suppressionId: string,
  actor: { userId: string; email: string; ip?: string | null; userAgent?: string | null }
) {
  const suppression = await prisma.attendanceSuppression.findUnique({ where: { id: suppressionId } });
  if (!suppression) throw notFound('Attendance suppression');

  await prisma.attendanceSuppression.delete({ where: { id: suppressionId } });

  await recordAudit({
    action: 'ATTENDANCE_RESTORE',
    entity: 'AttendanceSuppression',
    entityId: suppressionId,
    oldValue: {
      employeeCode: suppression.employeeCode,
      workDate: dayjs.utc(suppression.workDate).format('YYYY-MM-DD'),
      reason: suppression.reason,
    },
    reason: 'ยกเลิกการระงับ อนุญาตให้ซิงก์นำเข้าข้อมูลวันนี้ได้อีกครั้ง',
    userId: actor.userId,
    userEmail: actor.email,
    ipAddress: actor.ip,
    userAgent: actor.userAgent,
  });

  return { restored: true, employeeCode: suppression.employeeCode };
}

/** Suppressed days, newest first, so an operator can review and undo them. */
export async function listSuppressions(params: { from?: Date; to?: Date } = {}) {
  return prisma.attendanceSuppression.findMany({
    where:
      params.from || params.to
        ? { workDate: { ...(params.from ? { gte: params.from } : {}), ...(params.to ? { lte: params.to } : {}) } }
        : undefined,
    include: { employee: { select: { employeeCode: true, firstName: true, lastName: true } } },
    orderBy: [{ workDate: 'desc' }, { employeeCode: 'asc' }],
  });
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
    include: { employee: { select: { otEligible: true, employmentType: true } } },
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
      employmentType: record.employee.employmentType,
    },
    settings
  );
  if (record.employee.employmentType === EmploymentType.DAILY && input.status === AttendanceStatus.LATE) {
    throw badRequest('พนักงานรายวันไม่ใช้สถานะมาสาย');
  }

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
        // Sticky: once a human has pinned a status, later recalculations keep
        // it. Editing only the punches leaves this false so the status stays
        // derived from the corrected times.
        statusOverride: record.statusOverride || input.status !== undefined,
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
    employee: { attendanceRequired: true, ...(departmentId ? { departmentId } : {}) },
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

  const [totals, lateCount, lateTotals] = await Promise.all([
    prisma.attendanceRecord.aggregate({
      where,
      _sum: { workedMinutes: true, otMinutes: true },
    }),
    prisma.attendanceRecord.count({
      where: {
        workDate: { gte: from, lte: to },
        status: AttendanceStatus.LATE,
        employee: {
          attendanceRequired: true,
          employmentType: { not: EmploymentType.DAILY },
          ...(departmentId ? { departmentId } : {}),
        },
      },
    }),
    prisma.attendanceRecord.aggregate({
      where: {
        workDate: { gte: from, lte: to },
        employee: {
          attendanceRequired: true,
          employmentType: { not: EmploymentType.DAILY },
          ...(departmentId ? { departmentId } : {}),
        },
      },
      _sum: { lateMinutes: true },
    }),
  ]);

  return {
    counts,
    present: counts.NORMAL + counts.LATE + counts.OT,
    late: lateCount,
    absent: counts.ABSENT,
    leave: counts.LEAVE,
    missingData: counts.MISSING_DATA,
    totalWorkedMinutes: totals._sum.workedMinutes ?? 0,
    totalOtMinutes: totals._sum.otMinutes ?? 0,
    totalLateMinutes: lateTotals._sum.lateMinutes ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Calendar: checkout summaries, lateness and leave
// ---------------------------------------------------------------------------

/**
 * One checkout summary written by an employee.
 *
 * The text is source evidence from the Google Sheet and is never rewritten -
 * line breaks and wording are preserved exactly as typed.
 */
export interface CheckoutSummary {
  employeeCode: string;
  employeeName: string | null;
  /** Checkout time as recorded on the source event. */
  checkOutTime: string;
  text: string;
  /** Stable source identity, so a re-sync cannot duplicate the entry. */
  eventId: string;
  /** True when the day was deliberately removed from payroll. */
  suppressed: boolean;
}

const isCheckoutEvent = (payload: unknown): boolean =>
  String((payload as { type?: unknown } | null)?.type ?? '')
    .toLowerCase()
    .replace(/[\s_-]/g, '')
    .includes('out');

const summaryText = (payload: unknown): string =>
  String((payload as { summary?: unknown } | null)?.summary ?? '').trim();

/**
 * Checkout summaries for a date range, derived from the archived raw events.
 *
 * No separate calendar store exists: the sync already archives every source
 * event verbatim under a unique row hash, so summaries appear automatically
 * whenever a sync imports them and cannot be duplicated by a re-sync.
 *
 * Deduplication follows the source event identity (clientRequestId, falling
 * back to the archive hash). Where an employee genuinely wrote two different
 * summaries on one day, both are kept with their own checkout times - the
 * system does not guess which one supersedes the other.
 */
async function loadCheckoutSummaries(
  fromIso: string,
  toIso: string
): Promise<Map<string, CheckoutSummary[]>> {
  const raw = await prisma.attendanceRawData.findMany({
    where: { rawDate: { gte: fromIso, lte: toIso } },
    select: { employeeCode: true, rawDate: true, rowHash: true, payload: true },
  });

  const codes = [...new Set(raw.map((r) => r.employeeCode))];
  const employees = codes.length
    ? await prisma.employee.findMany({
        where: { employeeCode: { in: codes } },
        select: { id: true, employeeCode: true, firstName: true, lastName: true },
      })
    : [];
  const nameByCode = new Map(
    employees.map((e) => [e.employeeCode, `${e.firstName} ${e.lastName}`.trim()])
  );
  const idByCode = new Map(employees.map((e) => [e.employeeCode, e.id]));

  const suppressions = await prisma.attendanceSuppression.findMany({
    select: { employeeId: true, workDate: true },
  });
  const suppressedKeys = new Set(
    suppressions.map((s) => `${s.employeeId}|${dayjs.utc(s.workDate).format('YYYY-MM-DD')}`)
  );

  const byDate = new Map<string, CheckoutSummary[]>();
  // identity -> already emitted, so a repeated source event is never listed twice
  const seenIdentity = new Set<string>();

  for (const row of raw) {
    if (!isCheckoutEvent(row.payload)) continue;
    const text = summaryText(row.payload);
    if (!text) continue;

    const payload = row.payload as { clientRequestId?: unknown; time?: unknown };
    const identity = String(payload.clientRequestId ?? '').trim() || row.rowHash;
    if (seenIdentity.has(identity)) continue;
    seenIdentity.add(identity);

    const employeeId = idByCode.get(row.employeeCode);
    const entries = byDate.get(row.rawDate) ?? [];

    // Two archived events carrying identical text for the same employee-day are
    // the same report reaching us twice; keep the first rather than repeating it.
    if (entries.some((e) => e.employeeCode === row.employeeCode && e.text === text)) continue;

    entries.push({
      employeeCode: row.employeeCode,
      employeeName: nameByCode.get(row.employeeCode) ?? null,
      checkOutTime: String(payload.time ?? '').trim(),
      text,
      eventId: identity,
      suppressed: employeeId
        ? suppressedKeys.has(`${employeeId}|${row.rawDate}`)
        : false,
    });
    byDate.set(row.rawDate, entries);
  }

  for (const entries of byDate.values()) {
    entries.sort((a, b) => a.checkOutTime.localeCompare(b.checkOutTime));
  }
  return byDate;
}

/**
 * Everything a single calendar day can show.
 *
 * A suppressed day contributes nothing to the counts - its attendance record is
 * gone - but its checkout summary stays visible, flagged, because the employee
 * really did write it and the raw event is retained as evidence.
 */
export async function getCalendarDayDetail(date: string) {
  const day = dayjs.utc(date).startOf('day');
  if (!day.isValid()) throw badRequest('Invalid date');
  const iso = day.format('YYYY-MM-DD');
  const dayDate = day.toDate();

  const settings = await loadSettings();
  const [records, leaves, holiday, summariesByDate] = await Promise.all([
    prisma.attendanceRecord.findMany({
      where: { workDate: dayDate, employee: { attendanceRequired: true } },
      include: {
        employee: {
          select: { employeeCode: true, firstName: true, lastName: true, employmentType: true },
        },
      },
      orderBy: { employeeCode: 'asc' },
    }),
    prisma.leaveRecord.findMany({
      where: {
        status: 'APPROVED',
        startDate: { lte: dayDate },
        endDate: { gte: dayDate },
        employee: { leaveTrackingRequired: true },
      },
      include: { employee: { select: { employeeCode: true, firstName: true, lastName: true } } },
      orderBy: { employeeId: 'asc' },
    }),
    prisma.holiday.findFirst({ where: { date: dayDate }, select: { name: true, type: true, note: true } }),
    loadCheckoutSummaries(iso, iso),
  ]);

  const holidayDates = new Set(holiday ? [iso] : []);
  const summaries = summariesByDate.get(iso) ?? [];

  // DAILY staff have no schedule to be late against, and exempt executives are
  // already excluded by the attendanceRequired filter above.
  const late = records
    .filter((r) => r.employee.employmentType === 'MONTHLY' && r.lateMinutes > 0)
    .map((r) => ({
      employeeCode: r.employeeCode,
      employeeName: `${r.employee.firstName} ${r.employee.lastName}`.trim(),
      checkIn: r.checkIn ? dayjs.utc(r.checkIn).format('HH:mm') : null,
      lateMinutes: r.lateMinutes,
    }));

  return {
    date: iso,
    dayType: holiday?.type ?? getDayType(dayDate, settings, holidayDates),
    holidayName: holiday?.name ?? null,
    holidayNote: holiday?.note ?? null,
    summaries: summaries.filter((s) => !s.suppressed),
    suppressedSummaries: summaries.filter((s) => s.suppressed),
    late,
    leaves: leaves.map((l) => ({
      employeeCode: l.employee.employeeCode,
      employeeName: `${l.employee.firstName} ${l.employee.lastName}`.trim(),
      leaveType: l.leaveType,
      startDate: dayjs.utc(l.startDate).format('YYYY-MM-DD'),
      endDate: dayjs.utc(l.endDate).format('YYYY-MM-DD'),
      reason: l.reason,
    })),
    counts: {
      summaryCount: summaries.filter((s) => !s.suppressed).length,
      lateCount: late.length,
      leaveCount: leaves.length,
    },
  };
}

export async function getWorkCalendar(year: number, month: number) {
  const start = dayjs.utc(`${year}-${String(month).padStart(2, '0')}-01`).startOf('month');
  if (!start.isValid()) throw badRequest('Invalid calendar month');
  const end = start.endOf('month').startOf('day');
  const settings = await loadSettings();
  const [holidays, leaves, periods] = await Promise.all([
    prisma.holiday.findMany({
      where: { date: { gte: start.toDate(), lte: end.toDate() } },
      select: { date: true, name: true, type: true },
    }),
    prisma.leaveRecord.findMany({
      where: {
        status: 'APPROVED',
        startDate: { lte: end.toDate() },
        endDate: { gte: start.toDate() },
        employee: { leaveTrackingRequired: true },
      },
      select: { startDate: true, endDate: true },
    }),
    prisma.payrollPeriod.findMany({
      where: { startDate: { lte: end.toDate() }, endDate: { gte: start.toDate() } },
      select: { id: true, name: true, startDate: true, endDate: true, status: true },
    }),
  ]);
  const holidayByDate = new Map(holidays.map((holiday) => [dayjs.utc(holiday.date).format('YYYY-MM-DD'), holiday]));
  const holidayDates = new Set(holidayByDate.keys());
  const today = dayjs().format('YYYY-MM-DD');

  // Counts only. The long summary text lives behind the per-day endpoint, so a
  // month view that is polled stays small.
  const summariesByDate = await loadCheckoutSummaries(
    start.format('YYYY-MM-DD'),
    end.format('YYYY-MM-DD')
  );
  const lateRows = await prisma.attendanceRecord.groupBy({
    by: ['workDate'],
    where: {
      workDate: { gte: start.toDate(), lte: end.toDate() },
      lateMinutes: { gt: 0 },
      employee: { attendanceRequired: true, employmentType: 'MONTHLY' },
    },
    _count: { _all: true },
  });
  const lateByDate = new Map(
    lateRows.map((r) => [dayjs.utc(r.workDate).format('YYYY-MM-DD'), r._count._all])
  );

  const days = eachDay(start.toDate(), end.toDate()).map((date) => {
    const key = dayjs.utc(date).format('YYYY-MM-DD');
    const holiday = holidayByDate.get(key);
    const dayType = holiday?.type ?? getDayType(date, settings, holidayDates);
    const leaveCount = leaves.filter((leave) => leave.startDate <= date && leave.endDate >= date).length;
    const summaryCount = (summariesByDate.get(key) ?? []).filter((s) => !s.suppressed).length;
    const lateCount = lateByDate.get(key) ?? 0;
    return {
      date: key,
      dayType,
      holidayName: holiday?.name ?? null,
      isToday: key === today,
      summaryCount,
      lateCount,
      leaveCount,
      /** True when the day has anything worth opening the detail panel for. */
      hasActivity: summaryCount > 0 || lateCount > 0 || leaveCount > 0,
      approvedLeaveCount: leaveCount,
      payrollPeriods: periods
        .filter((period) => period.startDate <= date && period.endDate >= date)
        .map((period) => ({ id: period.id, name: period.name, status: period.status })),
    };
  });
  const workingDays = days.filter((day) => day.dayType === 'WORKING_DAY');
  return {
    year,
    month,
    days,
    summary: {
      scheduledWorkingDays: workingDays.length,
      elapsedWorkingDays: workingDays.filter((day) => day.date < today).length,
      remainingWorkingDays: workingDays.filter((day) => day.date >= today).length,
      weeklyOffDays: days.filter((day) => day.dayType === 'WEEKLY_OFF').length,
      publicHolidays: days.filter((day) => day.dayType === 'PUBLIC_HOLIDAY').length,
      companyHolidays: days.filter((day) => day.dayType === 'COMPANY_HOLIDAY').length,
    },
  };
}

/**
 * Recompute every attendance row in a range against the current settings.
 * Used after an attendance-rule change so an already-imported month reflects
 * the new rules without re-syncing the sheet.
 */
export async function recalculateRange(from: Date, to: Date, employeeId?: string) {
  const locked = await prisma.attendanceRecord.count({
    where: { workDate: { gte: toUtcDateOnly(from), lte: toUtcDateOnly(to) }, isLocked: true, employee: { attendanceRequired: true }, ...(employeeId ? { employeeId } : {}) },
  });
  const records = await prisma.attendanceRecord.findMany({
    where: { workDate: { gte: toUtcDateOnly(from), lte: toUtcDateOnly(to) }, isLocked: false, employee: { attendanceRequired: true }, ...(employeeId ? { employeeId } : {}) },
    include: { employee: { select: { otEligible: true, employmentType: true } } },
  });

  const leaves = await prisma.leaveRecord.findMany({
    where: { status: 'APPROVED', startDate: { lte: to }, endDate: { gte: from }, employee: { leaveTrackingRequired: true } },
  });

  const onLeave = (employeeId: string, date: Date): boolean =>
    leaves.some(
      (l) => l.employeeId === employeeId && l.startDate <= date && l.endDate >= date
    );

  let updated = 0;
  for (const record of records) {
    const settings = await loadSettingsForDate(record.workDate);
    const metrics = computeAttendanceMetrics(
      {
        workDate: record.workDate,
        checkIn: record.checkIn,
        checkOut: record.checkOut,
        isHoliday: record.isHoliday,
        isWeekend: !isScheduledWorkday(record.workDate, settings),
        isOnLeave: onLeave(record.employeeId, record.workDate),
        otEligible: record.employee.otEligible,
        employmentType: record.employee.employmentType,
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
        // Only a status a human explicitly chose is preserved. Keying this off
        // isCorrected instead froze the status of every corrected day, so a day
        // whose missing punch had just been supplied kept reporting
        // MISSING_DATA. The punches themselves are always the corrected ones.
        status: record.statusOverride ? record.status : metrics.status,
      },
    });
    updated += 1;
  }
  return { updated, skippedLocked: locked };
}
