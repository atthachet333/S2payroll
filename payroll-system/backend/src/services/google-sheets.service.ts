import crypto from 'node:crypto';
import { google } from 'googleapis';
import { AttendanceSource, SyncStatus } from '@prisma/client';
import { prisma } from '../plugins/prisma.js';
import { attendanceRange, env, googlePrivateKey, isGoogleSheetsConfigured } from '../config/env.js';
import { loadSettings } from './settings.service.js';
import { computeAttendanceMetrics } from './attendance.service.js';
import { recordAudit } from './audit.service.js';
import {
  dayjs,
  isWeekend as isWeekendDate,
  parseSheetDate,
  parseSheetTime,
} from '../utils/datetime.js';
import { badRequest, serviceUnavailable } from '../utils/errors.js';
import {
  describeMissingColumns,
  extractEventRows,
  extractRows,
  isEventSheet,
  resolveColumns,
  resolveEventColumns,
  REQUIRED_FIELDS,
  type ColumnMap,
  type EventColumnMap,
} from './sheet-mapping.service.js';
import {
  resolveEventAttendance,
  sourceEventHash,
  type AttendanceSourceEvent,
  type EventResolutionStatus,
} from './event-attendance.service.js';

export interface SheetRow {
  employeeCode: string;
  date: string;
  checkIn: string | null;
  checkOut: string | null;
  sheetRow: number;
  sourceFormat?: 'COLUMN' | 'EVENT';
  sourceEvents?: AttendanceSourceEvent[];
  sheetRows?: number[];
  eventStatus?: EventResolutionStatus;
  eventReason?: string;
  duplicateSourceEvents?: number;
  workHoursWarning?: string | null;
  checkInEvents?: string[];
  checkOutEvents?: string[];
}

export interface SyncError {
  row: number;
  employeeCode: string;
  date: string;
  message: string;
}

/**
 * How a single source row will be treated.
 *
 * NEW / UPDATE       - will be written
 * DUPLICATE          - repeated in this pull, or unchanged since the last sync
 * PROTECTED          - a manual correction exists and is not overwritten
 * LOCKED             - the covering payroll period is locked
 * INVALID            - unparseable date/time or a missing employee code
 * UNKNOWN_EMPLOYEE   - the employee_code does not exist in the system
 *
 * INVALID and UNKNOWN_EMPLOYEE rows are never imported. They are reported so a
 * human resolves them, because guessing which employee a row belongs to would
 * put someone else's hours on someone else's payslip.
 */
export type SyncRowAction =
  | 'NEW'
  | 'UPDATE'
  | 'DUPLICATE'
  | 'PROTECTED'
  | 'LOCKED'
  | 'INVALID'
  | 'UNKNOWN_EMPLOYEE'
  | 'MISSING_CHECKIN'
  | 'MISSING_CHECKOUT'
  | 'MULTIPLE_EVENTS'
  | 'DUPLICATE_SOURCE_EVENT'
  | 'WORK_HOURS_MISMATCH';

export interface SyncPreviewRow {
  row: number;
  employeeCode: string;
  /** Resolved employee name, when the code matched a known employee. */
  employeeName: string | null;
  date: string;
  action: SyncRowAction;
  checkIn: string | null;
  checkOut: string | null;
  previousCheckIn?: string | null;
  previousCheckOut?: string | null;
  /** Why this row was classified the way it was. */
  reason?: string;
  sheetRows?: number[];
  sourceEventCount?: number;
  checkInEvents?: string[];
  checkOutEvents?: string[];
  sourceEvents?: AttendanceSourceEvent[];
}

/** Counts per classification, for the preview summary strip. */
export type SyncCounts = Record<SyncRowAction, number>;

export interface SyncResult {
  syncId: string;
  status: SyncStatus;
  totalRows: number;
  imported: number;
  updated: number;
  skipped: number;
  duplicates: number;
  protected: number;
  /** Rows rejected for a malformed date, time or missing code. Never imported. */
  invalid: number;
  /** Rows whose employee_code is not in the system. Never imported. */
  unknownEmployee: number;
  sourceEvents: number;
  groupedEmployeeDays: number;
  counts: SyncCounts;
  errors: SyncError[];
  durationMs: number;
  /** Populated only on a dry run, capped so a huge sheet cannot bloat the response. */
  preview?: SyncPreviewRow[];
  dryRun: boolean;
}

/** Stable fingerprint of a source row, used to detect unchanged and duplicate rows. */
const rowHash = (row: SheetRow): string =>
  crypto
    .createHash('sha256')
    .update(`${row.employeeCode}|${row.date}|${row.checkIn ?? ''}|${row.checkOut ?? ''}`)
    .digest('hex');

export type FetchedSheet =
  | { rows: SheetRow[]; format: 'COLUMN'; map: ColumnMap; sourceEventCount: number }
  | { rows: SheetRow[]; format: 'EVENT'; map: EventColumnMap; sourceEventCount: number };

function sheetsClient() {
  if (!isGoogleSheetsConfigured()) {
    throw serviceUnavailable(
      'ยังไม่ได้ตั้งค่าการเชื่อมต่อ Google Sheets (GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY / GOOGLE_SHEET_ID)'
    );
  }
  const auth = new google.auth.JWT({
    email: env.GOOGLE_CLIENT_EMAIL,
    key: googlePrivateKey,
    // Read-only: this system must never write back to the source sheet.
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

/**
 * Fetch the sheet and resolve its columns.
 *
 * Column positions are resolved by header name through sheet-mapping.service,
 * which accepts Thai and English variants. A sheet missing a required column
 * fails here with a clear message rather than importing blank data.
 */
export async function fetchSheet(
  sheetId?: string,
  range?: string
): Promise<FetchedSheet> {
  const sheets = sheetsClient();
  const spreadsheetId = sheetId || env.GOOGLE_SHEET_ID;
  const targetRange = range || attendanceRange();

  // values.get is a read call; the client is scoped spreadsheets.readonly.
  const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: targetRange });
  const values = (response.data.values ?? []) as unknown[][];
  if (values.length === 0) {
    return {
      rows: [],
      format: 'COLUMN',
      sourceEventCount: 0,
      map: {
        indexes: { employeeCode: -1, date: -1, checkIn: -1, checkOut: -1 },
        hasHeader: false,
        missing: [...REQUIRED_FIELDS],
        headers: [],
        firstDataRow: 1,
      },
    };
  }

  if (isEventSheet(values[0])) {
    const map = resolveEventColumns(values[0]);
    if (map.missing.length > 0) {
      throw badRequest(`Event sheet missing required columns: ${map.missing.join(', ')}`);
    }
    const sourceEvents = extractEventRows(values, map) as AttendanceSourceEvent[];
    const resolved = resolveEventAttendance(sourceEvents);
    return {
      format: 'EVENT',
      map,
      sourceEventCount: sourceEvents.length,
      rows: resolved.map((day) => ({
        employeeCode: day.employeeCode,
        date: day.date,
        checkIn: day.checkIn,
        checkOut: day.checkOut,
        sheetRow: day.sheetRows[0],
        sheetRows: day.sheetRows,
        sourceFormat: 'EVENT',
        sourceEvents: day.sourceEvents,
        eventStatus: day.status,
        eventReason: day.reason,
        duplicateSourceEvents: day.duplicateSourceEvents.length,
        workHoursWarning: day.workHoursWarning,
        checkInEvents: day.checkInEvents.map((event) => event.time),
        checkOutEvents: day.checkOutEvents.map((event) => event.time),
      })),
    };
  }

  const map = resolveColumns(values[0]);
  if (map.missing.length > 0) {
    throw badRequest(describeMissingColumns(map));
  }

  const rows = extractRows(values, map);
  return {
    rows: rows.map((row) => ({ ...row, sourceFormat: 'COLUMN' as const })),
    map,
    format: 'COLUMN',
    sourceEventCount: rows.length,
  };
}

/** Backwards-compatible helper returning just the rows. */
export async function fetchSheetRows(sheetId?: string, range?: string): Promise<SheetRow[]> {
  const { rows } = await fetchSheet(sheetId, range);
  return rows;
}

export interface SyncOptions {
  sheetId?: string;
  range?: string;
  /** Preview the outcome without writing attendance rows. */
  dryRun?: boolean;
  actor: { userId: string; email: string; ip?: string | null; userAgent?: string | null };
  /** Inject rows instead of calling the Sheets API (used by tests). */
  rows?: SheetRow[];
}

/**
 * Import attendance from Google Sheets into the database.
 *
 * Guarantees:
 *   - the source sheet is opened read-only and is never modified
 *   - every fetched row is archived verbatim in attendance_raw_data
 *   - (employee, work_date) is upserted, so re-running is idempotent
 *   - a row whose hash matches the stored raw row is counted as a duplicate and skipped
 *   - a record with is_corrected = true keeps its manual values; the incoming
 *     values are still archived and the row is counted under `protected`
 *   - a record belonging to a locked payroll period is never touched
 */
export async function syncAttendance(options: SyncOptions): Promise<SyncResult> {
  const startedAt = Date.now();
  const settings = await loadSettings();
  const allowOverwriteCorrected = settings.boolean('SHEET_OVERWRITE_CORRECTED');

  const sheetId = options.sheetId || env.GOOGLE_SHEET_ID;
  const range = options.range || attendanceRange();

  // A dry run is a read-only preview: it must not appear in sync history and
  // must not write an audit entry, because nothing was actually imported.
  const sync = options.dryRun
    ? null
    : await prisma.googleSheetSync.create({
        data: {
          sheetId: sheetId || 'injected',
          sheetRange: range,
          status: SyncStatus.RUNNING,
          triggeredBy: options.actor.userId,
        },
      });

  const errors: SyncError[] = [];
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let duplicates = 0;
  let protectedCount = 0;
  let invalid = 0;
  let unknownEmployee = 0;
  let rows: SheetRow[] = [];

  // Preview rows are only collected on a dry run, and capped so a very large
  // sheet cannot produce an unbounded response.
  const PREVIEW_LIMIT = 300;
  const preview: SyncPreviewRow[] = [];
  const addPreview = (entry: SyncPreviewRow) => {
    if (options.dryRun && preview.length < PREVIEW_LIMIT) preview.push(entry);
  };

  try {
    rows = options.rows ?? (await fetchSheetRows(sheetId, range));

    const codes = [...new Set(rows.map((r) => r.employeeCode).filter(Boolean))];
    const employees = await prisma.employee.findMany({
      where: { employeeCode: { in: codes } },
      select: { id: true, employeeCode: true, otEligible: true, firstName: true, lastName: true },
    });
    const byCode = new Map(
      employees.map((e) => [e.employeeCode, { ...e, name: `${e.firstName} ${e.lastName}` }])
    );

    const holidays = await prisma.holiday.findMany();
    const holidaySet = new Set(holidays.map((h) => dayjs.utc(h.date).format('YYYY-MM-DD')));

    const leaves = await prisma.leaveRecord.findMany({ where: { status: 'APPROVED' } });

    // Rows repeated inside a single sheet pull are duplicates of each other.
    const seenInThisPull = new Set<string>();

    for (const row of rows) {
      if (!row.employeeCode) {
        const reason = 'ไม่มีรหัสพนักงานในแถวนี้';
        errors.push({ row: row.sheetRow, employeeCode: '', date: row.date, message: 'Missing employee_code' });
        invalid += 1;
        addPreview({
          row: row.sheetRow,
          employeeCode: '',
          employeeName: null,
          date: row.date,
          action: 'INVALID',
          checkIn: row.checkIn,
          checkOut: row.checkOut,
          reason,
        });
        continue;
      }

      const workDate = parseSheetDate(row.date);
      if (!workDate) {
        errors.push({
          row: row.sheetRow,
          employeeCode: row.employeeCode,
          date: row.date,
          message: `Unrecognised date format: "${row.date}"`,
        });
        invalid += 1;
        addPreview({
          row: row.sheetRow,
          employeeCode: row.employeeCode,
          employeeName: byCode.get(row.employeeCode)?.name ?? null,
          date: row.date,
          action: 'INVALID',
          checkIn: row.checkIn,
          checkOut: row.checkOut,
          reason: `รูปแบบวันที่ไม่ถูกต้อง: "${row.date}"`,
        });
        continue;
      }

      // Matching is by employee_code only. Names are never used to resolve a
      // row - a near-miss on a name would post someone else's hours.
      const employee = byCode.get(row.employeeCode);
      if (!employee) {
        errors.push({
          row: row.sheetRow,
          employeeCode: row.employeeCode,
          date: row.date,
          message: `Unknown employee_code "${row.employeeCode}"`,
        });
        unknownEmployee += 1;
        addPreview({
          row: row.sheetRow,
          employeeCode: row.employeeCode,
          employeeName: null,
          date: dayjs.utc(workDate).format('YYYY-MM-DD'),
          action: 'UNKNOWN_EMPLOYEE',
          checkIn: row.checkIn,
          checkOut: row.checkOut,
          reason: `ไม่พบรหัสพนักงาน "${row.employeeCode}" ในระบบ`,
        });
        continue;
      }

      // A time cell that is present but unparseable is a data error, not a
      // missing punch - importing it as blank would hide the problem.
      const badTime = [
        ['เวลาเข้างาน', row.checkIn] as const,
        ['เวลาออกงาน', row.checkOut] as const,
      ].find(([, value]) => value && parseSheetTime(workDate, value) === null);

      if (badTime) {
        errors.push({
          row: row.sheetRow,
          employeeCode: row.employeeCode,
          date: row.date,
          message: `Unrecognised time format in ${badTime[0]}: "${badTime[1]}"`,
        });
        invalid += 1;
        addPreview({
          row: row.sheetRow,
          employeeCode: row.employeeCode,
          employeeName: employee.name,
          date: dayjs.utc(workDate).format('YYYY-MM-DD'),
          action: 'INVALID',
          checkIn: row.checkIn,
          checkOut: row.checkOut,
          reason: `รูปแบบเวลาไม่ถูกต้องใน${badTime[0]}: "${badTime[1]}"`,
        });
        continue;
      }

      const dayKey = `${employee.id}|${dayjs.utc(workDate).format('YYYY-MM-DD')}`;
      if (seenInThisPull.has(dayKey)) {
        duplicates += 1;
        addPreview({
          row: row.sheetRow,
          employeeCode: row.employeeCode,
          employeeName: employee.name,
          date: dayjs.utc(workDate).format('YYYY-MM-DD'),
          action: 'DUPLICATE',
          checkIn: row.checkIn,
          checkOut: row.checkOut,
          reason: 'มีแถวของพนักงานคนนี้ในวันเดียวกันซ้ำในไฟล์',
        });
        continue;
      }
      seenInThisPull.add(dayKey);

      const hash = rowHash(row);

      // Archive the source row verbatim before doing anything else.
      if (!options.dryRun) {
        await prisma.attendanceRawData.create({
          data: {
            syncId: sync?.id ?? null,
            employeeCode: row.employeeCode,
            rawDate: row.date,
            rawCheckIn: row.checkIn,
            rawCheckOut: row.checkOut,
            rowHash: hash,
            sheetRow: row.sheetRow,
            payload: row as unknown as object,
          },
        });
      }

      const existing = await prisma.attendanceRecord.findUnique({
        where: { employee_work_date: { employeeId: employee.id, workDate } },
      });

      if (existing?.isLocked) {
        skipped += 1;
        addPreview({
          row: row.sheetRow,
          employeeCode: row.employeeCode,
          employeeName: employee.name,
          date: dayjs.utc(workDate).format('YYYY-MM-DD'),
          action: 'LOCKED',
          reason: 'รอบเงินเดือนที่ครอบคลุมวันนี้ถูกล็อกแล้ว',
          checkIn: row.checkIn,
          checkOut: row.checkOut,
        });
        continue;
      }

      if (existing?.isCorrected && !allowOverwriteCorrected) {
        // The manual correction stands. The incoming values are already archived
        // in raw data, so nothing is lost and nothing is silently overwritten.
        protectedCount += 1;
        addPreview({
          row: row.sheetRow,
          employeeCode: row.employeeCode,
          employeeName: employee.name,
          date: dayjs.utc(workDate).format('YYYY-MM-DD'),
          action: 'PROTECTED',
          reason: 'มีการแก้ไขด้วยมือในระบบ จะไม่ถูกเขียนทับ',
          checkIn: row.checkIn,
          checkOut: row.checkOut,
          previousCheckIn: existing.checkIn ? dayjs.utc(existing.checkIn).format('HH:mm') : null,
          previousCheckOut: existing.checkOut ? dayjs.utc(existing.checkOut).format('HH:mm') : null,
        });
        continue;
      }

      const checkIn = parseSheetTime(workDate, row.checkIn);
      const checkOut = parseSheetTime(workDate, row.checkOut);

      // Unchanged since the last sync - skip the write entirely.
      if (
        existing &&
        !existing.isCorrected &&
        existing.originalCheckIn?.getTime() === checkIn?.getTime() &&
        existing.originalCheckOut?.getTime() === checkOut?.getTime()
      ) {
        duplicates += 1;
        addPreview({
          row: row.sheetRow,
          employeeCode: row.employeeCode,
          employeeName: employee.name,
          date: dayjs.utc(workDate).format('YYYY-MM-DD'),
          action: 'DUPLICATE',
          checkIn: row.checkIn,
          checkOut: row.checkOut,
        });
        continue;
      }

      const dateKey = dayjs.utc(workDate).format('YYYY-MM-DD');
      const isHoliday = holidaySet.has(dateKey);
      const weekend = isWeekendDate(workDate);
      const isOnLeave = leaves.some(
        (l) => l.employeeId === employee.id && l.startDate <= workDate && l.endDate >= workDate
      );

      const metrics = computeAttendanceMetrics(
        {
          workDate,
          checkIn,
          checkOut,
          isHoliday,
          isWeekend: weekend,
          isOnLeave,
          otEligible: employee.otEligible,
        },
        settings
      );

      if (options.dryRun) {
        if (existing) updated += 1;
        else imported += 1;
        addPreview({
          row: row.sheetRow,
          employeeCode: row.employeeCode,
          employeeName: employee.name,
          date: dayjs.utc(workDate).format('YYYY-MM-DD'),
          action: existing ? 'UPDATE' : 'NEW',
          checkIn: row.checkIn,
          checkOut: row.checkOut,
          previousCheckIn: existing?.checkIn ? dayjs.utc(existing.checkIn).format('HH:mm') : null,
          previousCheckOut: existing?.checkOut ? dayjs.utc(existing.checkOut).format('HH:mm') : null,
        });
        continue;
      }

      const payload = {
        checkIn,
        checkOut,
        originalCheckIn: checkIn,
        originalCheckOut: checkOut,
        workedMinutes: metrics.workedMinutes,
        normalMinutes: metrics.normalMinutes,
        otMinutes: metrics.otMinutes,
        breakMinutes: metrics.breakMinutes,
        lateMinutes: metrics.lateMinutes,
        earlyLeaveMinutes: metrics.earlyLeaveMinutes,
        isMissingCheckIn: metrics.isMissingCheckIn,
        isMissingCheckOut: metrics.isMissingCheckOut,
        isAbsent: metrics.isAbsent,
        isHoliday,
        isWeekend: weekend,
        status: metrics.status,
        source: AttendanceSource.GOOGLE_SHEET,
        lastSyncId: sync?.id ?? null,
      };

      await prisma.attendanceRecord.upsert({
        where: { employee_work_date: { employeeId: employee.id, workDate } },
        create: {
          employeeId: employee.id,
          employeeCode: employee.employeeCode,
          workDate,
          createdBy: options.actor.userId,
          ...payload,
        },
        update: payload,
      });

      if (existing) updated += 1;
      else imported += 1;
    }

    const status =
      errors.length === 0
        ? SyncStatus.SUCCESS
        : errors.length === rows.length
          ? SyncStatus.FAILED
          : SyncStatus.PARTIAL;

    const durationMs = Date.now() - startedAt;

    // Only a real sync writes history and an audit entry.
    if (sync) {
      await prisma.googleSheetSync.update({
        where: { id: sync.id },
        data: {
          status,
          totalRows: rows.length,
          importedCount: imported,
          updatedCount: updated,
          skippedCount: skipped,
          duplicateCount: duplicates,
          protectedCount,
          errorCount: errors.length,
          errors: errors.slice(0, 200) as unknown as object,
          finishedAt: new Date(),
          durationMs,
        },
      });

      await recordAudit({
        action: 'SHEET_SYNC',
        entity: 'GoogleSheetSync',
        entityId: sync.id,
        newValue: { status, totalRows: rows.length, imported, updated, duplicates, protectedCount },
        userId: options.actor.userId,
        userEmail: options.actor.email,
        ipAddress: options.actor.ip,
        userAgent: options.actor.userAgent,
      });
    }

    return {
      syncId: sync?.id ?? 'dry-run',
      status,
      totalRows: rows.length,
      imported,
      updated,
      skipped,
      duplicates,
      protected: protectedCount,
      errors,
      durationMs,
      invalid,
      unknownEmployee,
      counts: {
        NEW: imported,
        UPDATE: updated,
        DUPLICATE: duplicates,
        PROTECTED: protectedCount,
        LOCKED: skipped,
        INVALID: invalid,
        UNKNOWN_EMPLOYEE: unknownEmployee,
      },
      dryRun: Boolean(options.dryRun),
      ...(options.dryRun ? { preview } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (sync) {
      await prisma.googleSheetSync.update({
        where: { id: sync.id },
        data: {
          status: SyncStatus.FAILED,
          totalRows: rows.length,
          errorCount: errors.length + 1,
          errors: [...errors, { row: 0, employeeCode: '', date: '', message }] as unknown as object,
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt,
        },
      });
    }
    throw err;
  }
}

export async function listSyncHistory(page: number, pageSize: number) {
  const [items, total] = await Promise.all([
    prisma.googleSheetSync.findMany({
      orderBy: { startedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.googleSheetSync.count(),
  ]);
  return { items, total, page, pageSize };
}

export async function getLastSync() {
  return prisma.googleSheetSync.findFirst({ orderBy: { startedAt: 'desc' } });
}

export const sheetsStatus = () => ({
  configured: isGoogleSheetsConfigured(),
  sheetId: env.GOOGLE_SHEET_ID ? `${env.GOOGLE_SHEET_ID.slice(0, 8)}...` : null,
  range: attendanceRange(),
});
