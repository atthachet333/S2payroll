/**
 * Read-only import of the `LeaveRequests` Google Sheet tab into `s2apayroll`.
 *
 * Idempotency comes from the sheet's own `requestId`, stored on
 * leave_records.source_request_id under a unique index: a repeated sync
 * updates the matching row rather than appending a second leave for the same
 * request. Leave entered by hand in the app has no source id and is never
 * touched by a sync.
 *
 * An unknown employee code is reported, never guessed - attaching leave to the
 * wrong person would silently remove a day's pay from someone.
 *
 * Google is reached through spreadsheets.values.get on a readonly-scoped
 * client, so the sheet cannot be modified.
 */
import { google } from 'googleapis';
import { prisma } from '../plugins/prisma.js';
import { buildSheetRange, env, googlePrivateKey, isGoogleSheetsConfigured } from '../config/env.js';
import { recordAudit } from './audit.service.js';
import { badRequest, serviceUnavailable } from '../utils/errors.js';
import { dayjs } from '../utils/datetime.js';
import { loadSettings } from './settings.service.js';
import { recalculateRange } from './attendance.service.js';
import { isScheduledWorkday } from './schedule-policy.service.js';
import {
  describeMissingLeaveColumns,
  extractLeaveRows,
  findDuplicateRequestIds,
  isPaidLeaveType,
  resolveLeaveColumns,
  type LeaveColumnMap,
  type MappedLeaveRow,
} from './leave-sheet-mapping.service.js';

export const LEAVE_SHEET_TAB = process.env.GOOGLE_LEAVE_SHEET_NAME || 'LeaveRequests';

export type LeaveSyncAction = 'NEW' | 'UPDATE' | 'UNCHANGED' | 'EXEMPT' | 'INVALID' | 'UNKNOWN_EMPLOYEE' | 'DUPLICATE_REQUEST';

export interface LeavePreviewRow {
  sheetRow: number;
  requestId: string;
  employeeCode: string;
  leaveType: string;
  startDate: string | null;
  endDate: string | null;
  totalDays: number | null;
  status: string | null;
  action: LeaveSyncAction;
  changes: string[];
  errors: string[];
}

export interface LeaveSyncPreview {
  tab: string;
  headers: string[];
  unmappedHeaders: string[];
  totalSheetRows: number;
  rows: LeavePreviewRow[];
  counts: Record<LeaveSyncAction, number>;
  importable: boolean;
  blockers: string[];
}

function sheetsClient() {
  if (!isGoogleSheetsConfigured()) {
    throw serviceUnavailable('ยังไม่ได้ตั้งค่าการเชื่อมต่อ Google Sheets');
  }
  const auth = new google.auth.JWT({
    email: env.GOOGLE_CLIENT_EMAIL,
    key: googlePrivateKey,
    // Read-only: this system must never write back to the source sheet.
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

export async function fetchLeaveSheet(
  tab = LEAVE_SHEET_TAB
): Promise<{ rows: MappedLeaveRow[]; map: LeaveColumnMap }> {
  const sheets = sheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: buildSheetRange(tab),
  });
  const values = (response.data.values ?? []) as unknown[][];
  if (values.length === 0) throw badRequest(`แท็บ ${tab} ในสเปรดชีตว่างเปล่า`);

  const map = resolveLeaveColumns(values[0]);
  if (map.missing.length > 0) throw badRequest(describeMissingLeaveColumns(map));

  return { rows: extractLeaveRows(values, map), map };
}

const utcDate = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

/** Whole days inclusive of both ends, used when the sheet omits totalDays. */
const inclusiveDays = (start: string, end: string): number =>
  Math.round((utcDate(end).getTime() - utcDate(start).getTime()) / 86_400_000) + 1;

export async function previewLeaveSync(tab = LEAVE_SHEET_TAB): Promise<LeaveSyncPreview> {
  const { rows, map } = await fetchLeaveSheet(tab);
  const duplicates = findDuplicateRequestIds(rows);

  const codes = [...new Set(rows.map((r) => r.employeeCode).filter(Boolean))];
  const employees = await prisma.employee.findMany({
    where: { employeeCode: { in: codes } },
    select: { id: true, employeeCode: true, leaveTrackingRequired: true },
  });
  const employeeByCode = new Map(employees.map((e) => [e.employeeCode.toUpperCase(), e]));

  const existing = await prisma.leaveRecord.findMany({
    where: { sourceRequestId: { in: rows.map((r) => r.requestId).filter(Boolean) } },
  });
  const byRequest = new Map(existing.map((l) => [l.sourceRequestId as string, l]));

  const preview: LeavePreviewRow[] = rows.map((row) => {
    const base = {
      sheetRow: row.sheetRow,
      requestId: row.requestId,
      employeeCode: row.employeeCode,
      leaveType: row.leaveType,
      startDate: row.startDate,
      endDate: row.endDate,
      totalDays: row.totalDays,
      status: row.status ?? row.rawStatus,
      changes: [] as string[],
      errors: row.errors,
    };

    if (row.errors.length > 0) return { ...base, action: 'INVALID' as const };
    if (duplicates.includes(row.requestId)) return { ...base, action: 'DUPLICATE_REQUEST' as const };
    const employee = employeeByCode.get(row.employeeCode);
    if (!employee) {
      return { ...base, action: 'UNKNOWN_EMPLOYEE' as const };
    }
    if (!employee.leaveTrackingRequired) {
      return { ...base, action: 'EXEMPT' as const };
    }

    const current = byRequest.get(row.requestId);
    if (!current) return { ...base, action: 'NEW' as const };

    const changes: string[] = [];
    const diff = (field: string, from: unknown, to: unknown) => {
      if (to === null || to === undefined) return;
      if (String(from ?? '') !== String(to)) changes.push(`${field}: ${from ?? '-'} → ${to}`);
    };
    diff('leaveType', current.leaveType, row.leaveType);
    diff('startDate', current.startDate.toISOString().slice(0, 10), row.startDate);
    diff('endDate', current.endDate.toISOString().slice(0, 10), row.endDate);
    diff('status', current.status, row.status);
    diff('reason', current.reason, row.reason);
    if (row.totalDays !== null && Number(current.totalDays) !== row.totalDays) {
      changes.push(`totalDays: ${current.totalDays} → ${row.totalDays}`);
    }

    return { ...base, changes, action: (changes.length ? 'UPDATE' : 'UNCHANGED') as LeaveSyncAction };
  });

  const counts = preview.reduce(
    (acc, r) => ({ ...acc, [r.action]: (acc[r.action] ?? 0) + 1 }),
    { NEW: 0, UPDATE: 0, UNCHANGED: 0, EXEMPT: 0, INVALID: 0, UNKNOWN_EMPLOYEE: 0, DUPLICATE_REQUEST: 0 } as Record<LeaveSyncAction, number>
  );

  const blockers: string[] = [];
  if (duplicates.length) blockers.push(`requestId ซ้ำในชีต: ${duplicates.join(', ')}`);
  const invalid = preview.filter((r) => r.action === 'INVALID');
  if (invalid.length) {
    blockers.push(
      `แถวที่ข้อมูลไม่ถูกต้อง ${invalid.length} แถว: ` +
      invalid.map((r) => `แถว ${r.sheetRow} (${r.errors.join('; ')})`).join(', ')
    );
  }

  return {
    tab,
    headers: (Object.entries(map.indexes) as Array<[string, number]>)
      .filter(([, i]) => i >= 0)
      .map(([field, i]) => `${map.headers[i]} → ${field}`),
    unmappedHeaders: map.unmapped,
    totalSheetRows: rows.length,
    rows: preview,
    counts,
    // Unknown employees are reported and skipped, not treated as a hard block:
    // one unmatched request must not stop every valid leave from importing.
    importable: blockers.length === 0,
    blockers,
  };
}

export interface LeaveSyncResult {
  created: number;
  updated: number;
  unchanged: number;
  skippedUnknownEmployee: string[];
  skippedExemptEmployee: string[];
  skippedInvalid: number;
  requestIds: string[];
  attendanceCreated: number;
  attendanceSkippedLocked: number;
  attendanceRecalculated: number;
}

/**
 * Create punch-less effective attendance rows for approved full-day leave.
 * These are not fabricated punches: both punch columns remain null and the
 * LeaveRecord remains the source of the LEAVE decision. Existing rows are
 * left for recalculateRange, which applies the same effective-state rules.
 */
export async function materializeApprovedLeaveAttendance(): Promise<{
  created: number;
  skippedLocked: number;
}> {
  const settings = await loadSettings();
  const [leaves, holidays, lockedPeriods] = await Promise.all([
    prisma.leaveRecord.findMany({
      where: { status: 'APPROVED', employee: { leaveTrackingRequired: true } },
      include: { employee: { select: { employeeCode: true, otEligible: true } } },
    }),
    prisma.holiday.findMany({ select: { date: true } }),
    prisma.payrollPeriod.findMany({ where: { status: 'LOCKED' }, select: { startDate: true, endDate: true } }),
  ]);
  const holidaySet = new Set(holidays.map((h) => dayjs.utc(h.date).format('YYYY-MM-DD')));
  let created = 0;
  let skippedLocked = 0;

  for (const leave of leaves) {
    // Fractional leave requires an explicit company policy and reliable source
    // duration; it is intentionally not converted into a full-day record.
    if (!Number.isInteger(Number(leave.totalDays))) continue;
    for (let cursor = dayjs.utc(leave.startDate); !cursor.isAfter(dayjs.utc(leave.endDate), 'day'); cursor = cursor.add(1, 'day')) {
      const workDate = cursor.startOf('day').toDate();
      const key = cursor.format('YYYY-MM-DD');
      if (holidaySet.has(key)) continue;
      if (!isScheduledWorkday(workDate, settings)) continue;
      if (lockedPeriods.some((p) => p.startDate <= workDate && p.endDate >= workDate)) {
        skippedLocked += 1;
        continue;
      }
      const existing = await prisma.attendanceRecord.findUnique({
        where: { employee_work_date: { employeeId: leave.employeeId, workDate } },
      });
      if (existing) continue;
      await prisma.attendanceRecord.create({
        data: {
          employeeId: leave.employeeId,
          employeeCode: leave.employee.employeeCode,
          workDate,
          checkIn: null,
          checkOut: null,
          originalCheckIn: null,
          originalCheckOut: null,
          isMissingCheckIn: false,
          isMissingCheckOut: false,
          isAbsent: false,
          isWeekend: !isScheduledWorkday(workDate, settings),
          status: 'LEAVE',
          source: 'GOOGLE_SHEET',
        },
      });
      created += 1;
    }
  }
  return { created, skippedLocked };
}

export async function importLeaves(options: {
  tab?: string;
  actorId?: string | null;
} = {}): Promise<LeaveSyncResult> {
  const tab = options.tab ?? LEAVE_SHEET_TAB;
  const preview = await previewLeaveSync(tab);
  if (!preview.importable) {
    throw badRequest(`ไม่สามารถนำเข้าข้อมูลการลาได้:\n${preview.blockers.join('\n')}`);
  }

  const { rows } = await fetchLeaveSheet(tab);
  const employees = await prisma.employee.findMany({
    where: { employeeCode: { in: rows.map((r) => r.employeeCode) } },
    select: { id: true, employeeCode: true, leaveTrackingRequired: true },
  });
  const employeeByCode = new Map(employees.map((e) => [e.employeeCode.toUpperCase(), e]));

  const result: LeaveSyncResult = {
    created: 0, updated: 0, unchanged: 0,
    skippedUnknownEmployee: [], skippedExemptEmployee: [], skippedInvalid: 0, requestIds: [],
    attendanceCreated: 0, attendanceSkippedLocked: 0,
    attendanceRecalculated: 0,
  };

  for (const row of rows) {
    if (row.errors.length > 0) { result.skippedInvalid += 1; continue; }
    const employee = employeeByCode.get(row.employeeCode);
    if (!employee) { result.skippedUnknownEmployee.push(`${row.requestId} (${row.employeeCode})`); continue; }
    if (!employee.leaveTrackingRequired) { result.skippedExemptEmployee.push(`${row.requestId} (${row.employeeCode})`); continue; }
    const employeeId = employee.id;

    const startDate = utcDate(row.startDate!);
    const endDate = utcDate(row.endDate ?? row.startDate!);
    const totalDays = row.totalDays ?? inclusiveDays(row.startDate!, row.endDate ?? row.startDate!);

    const payload = {
      employeeId,
      leaveType: row.leaveType,
      startDate,
      endDate,
      totalDays,
      isPaid: isPaidLeaveType(row.leaveType),
      // A sheet with no status column means the request is simply recorded;
      // treat it as pending rather than assuming approval.
      status: row.status ?? 'PENDING',
      reason: row.reason,
    };

    // The unique source_request_id is what makes a repeated sync idempotent.
    const existing = await prisma.leaveRecord.findUnique({
      where: { sourceRequestId: row.requestId },
    });

    if (!existing) {
      await prisma.leaveRecord.create({ data: { ...payload, sourceRequestId: row.requestId } });
      result.created += 1;
    } else {
      const same =
        existing.employeeId === payload.employeeId &&
        existing.leaveType === payload.leaveType &&
        existing.startDate.getTime() === startDate.getTime() &&
        existing.endDate.getTime() === endDate.getTime() &&
        Number(existing.totalDays) === totalDays &&
        existing.status === payload.status &&
        (existing.reason ?? null) === (payload.reason ?? null);
      if (same) {
        result.unchanged += 1;
      } else {
        await prisma.leaveRecord.update({ where: { id: existing.id }, data: payload });
        result.updated += 1;
      }
    }
    result.requestIds.push(row.requestId);
  }

  const attendance = await materializeApprovedLeaveAttendance();
  result.attendanceCreated = attendance.created;
  result.attendanceSkippedLocked = attendance.skippedLocked;
  const validDates = rows.flatMap((row) => [row.startDate, row.endDate]).filter((date): date is string => Boolean(date)).sort();
  if (validDates.length > 0) {
    const recalculated = await recalculateRange(utcDate(validDates[0]), utcDate(validDates.at(-1)!));
    result.attendanceRecalculated = recalculated.updated;
    result.attendanceSkippedLocked += recalculated.skippedLocked;
  }

  await recordAudit({
    action: 'LEAVE_SHEET_SYNC',
    entity: 'LeaveRecord',
    entityId: null,
    userId: options.actorId ?? null,
    reason: `นำเข้าข้อมูลการลาจาก Google Sheet แท็บ ${tab}`,
    newValue: {
      tab,
      created: result.created,
      updated: result.updated,
      unchanged: result.unchanged,
      skippedUnknownEmployee: result.skippedUnknownEmployee,
      skippedExemptEmployee: result.skippedExemptEmployee,
      skippedInvalid: result.skippedInvalid,
      attendanceCreated: result.attendanceCreated,
      attendanceSkippedLocked: result.attendanceSkippedLocked,
      attendanceRecalculated: result.attendanceRecalculated,
      sourceStatuses: rows.map((row) => ({ requestId: row.requestId, rawStatus: row.rawStatus })),
    },
  });

  return result;
}
