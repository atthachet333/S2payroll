/**
 * Read-only import of the `Employees` Google Sheet tab into `s2apayroll`.
 *
 * The sheet is the source of truth for employee IDENTITY only: code, name,
 * department, position and employment type. It is not the source of truth for
 * anything payroll owns - salary, bank details, tax/SSO flags, hire date - so
 * those are written on creation only (as safe defaults) and never overwritten
 * by a later sync. That keeps a sheet edit from silently rewriting someone's
 * pay.
 *
 * Identity is the employee code and nothing else. Rows are never matched by
 * name: two people can share one, and attaching hours to the wrong person is
 * not a recoverable mistake.
 *
 * Google is touched through spreadsheets.values.get on a readonly-scoped
 * client, so the sheet cannot be modified.
 */
import { google } from 'googleapis';
import type { EmploymentType, EmployeeStatus, Prisma } from '@prisma/client';
import { prisma } from '../plugins/prisma.js';
import { buildSheetRange, env, googlePrivateKey, isGoogleSheetsConfigured } from '../config/env.js';
import { recordAudit } from '../services/audit.service.js';
import { badRequest, serviceUnavailable } from '../utils/errors.js';
import {
  describeMissingEmployeeColumns,
  extractEmployeeRows,
  findDuplicateCodes,
  resolveEmployeeColumns,
  slugCode,
  type EmployeeColumnMap,
  type MappedEmployeeRow,
} from './employee-sheet-mapping.service.js';

/** Default tab name; overridable so a renamed tab needs no code change. */
export const EMPLOYEE_SHEET_TAB = process.env.GOOGLE_EMPLOYEE_SHEET_NAME || 'Employees';

export type EmployeeSyncAction =
  | 'NEW'
  | 'UPDATE'
  | 'UNCHANGED'
  | 'INVALID'
  | 'DUPLICATE_CODE';

export interface EmployeePreviewRow {
  sheetRow: number;
  employeeCode: string;
  name: string;
  department: string | null;
  position: string | null;
  employmentType: string | null;
  /** What the database currently holds for this code. */
  databaseStatus: 'ABSENT' | 'PRESENT';
  action: EmployeeSyncAction;
  /** Field-level differences driving an UPDATE. */
  changes: string[];
  errors: string[];
}

export interface EmployeeSyncPreview {
  tab: string;
  headers: string[];
  unmappedHeaders: string[];
  totalSheetRows: number;
  rows: EmployeePreviewRow[];
  counts: Record<EmployeeSyncAction, number>;
  duplicateCodes: string[];
  /** True when nothing structurally prevents an import. */
  importable: boolean;
  blockers: string[];
}

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

export interface FetchedEmployeeSheet {
  rows: MappedEmployeeRow[];
  map: EmployeeColumnMap;
  tab: string;
}

export async function fetchEmployeeSheet(tab = EMPLOYEE_SHEET_TAB): Promise<FetchedEmployeeSheet> {
  const sheets = sheetsClient();
  // values.get is a read call; the client is scoped spreadsheets.readonly.
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: buildSheetRange(tab),
  });
  const values = (response.data.values ?? []) as unknown[][];
  if (values.length === 0) {
    throw badRequest(`แท็บ ${tab} ในสเปรดชีตว่างเปล่า`);
  }

  const map = resolveEmployeeColumns(values[0]);
  if (map.missing.length > 0) throw badRequest(describeMissingEmployeeColumns(map));

  return { rows: extractEmployeeRows(values, map), map, tab };
}

/** Fields the sheet owns. Anything else on the Employee record is payroll's. */
interface SheetOwnedFields {
  firstName: string;
  lastName: string;
  nickname: string | null;
  departmentId: string | null;
  positionId: string | null;
  employmentType: EmploymentType | null;
  status: EmployeeStatus | null;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export async function previewEmployeeSync(tab = EMPLOYEE_SHEET_TAB): Promise<EmployeeSyncPreview> {
  const { rows, map } = await fetchEmployeeSheet(tab);
  const duplicateCodes = findDuplicateCodes(rows);

  const existing = await prisma.employee.findMany({
    select: {
      employeeCode: true, firstName: true, lastName: true, nickname: true,
      employmentType: true, status: true,
      department: { select: { name: true } },
      position: { select: { name: true } },
    },
  });
  const byCode = new Map(existing.map((e) => [e.employeeCode.toUpperCase(), e]));

  const preview: EmployeePreviewRow[] = rows.map((row) => {
    const current = byCode.get(row.employeeCode);
    const databaseStatus = current ? 'PRESENT' : 'ABSENT';
    const base = {
      sheetRow: row.sheetRow,
      employeeCode: row.employeeCode,
      name: [row.firstName, row.lastName].filter(Boolean).join(' ') || row.rawName,
      department: row.department,
      position: row.position,
      employmentType: row.employmentType ?? row.rawEmploymentType,
      databaseStatus: databaseStatus as 'ABSENT' | 'PRESENT',
      changes: [] as string[],
      errors: row.errors,
    };

    if (row.errors.length > 0) return { ...base, action: 'INVALID' as const };
    if (duplicateCodes.includes(row.employeeCode)) {
      return { ...base, action: 'DUPLICATE_CODE' as const };
    }
    if (!current) return { ...base, action: 'NEW' as const };

    const changes: string[] = [];
    const diff = (field: string, from: unknown, to: unknown) => {
      // A blank sheet cell never overwrites an existing value.
      if (to === null || to === '') return;
      if (String(from ?? '') !== String(to)) changes.push(`${field}: ${from ?? '-'} → ${to}`);
    };
    diff('firstName', current.firstName, row.firstName);
    diff('lastName', current.lastName, row.lastName);
    diff('nickname', current.nickname, row.nickname);
    diff('department', current.department?.name ?? null, row.department);
    diff('position', current.position?.name ?? null, row.position);
    diff('employmentType', current.employmentType, row.employmentType);
    diff('status', current.status, row.status);

    const action: EmployeeSyncAction = changes.length ? 'UPDATE' : 'UNCHANGED';
    return { ...base, changes, action };
  });

  const counts = preview.reduce(
    (acc, r) => ({ ...acc, [r.action]: (acc[r.action] ?? 0) + 1 }),
    { NEW: 0, UPDATE: 0, UNCHANGED: 0, INVALID: 0, DUPLICATE_CODE: 0 } as Record<EmployeeSyncAction, number>
  );

  const blockers: string[] = [];
  if (duplicateCodes.length) {
    blockers.push(`รหัสพนักงานซ้ำในชีต: ${duplicateCodes.join(', ')}`);
  }
  const invalid = preview.filter((r) => r.action === 'INVALID');
  if (invalid.length) {
    blockers.push(
      `แถวที่ข้อมูลไม่ถูกต้อง ${invalid.length} แถว: ` +
      invalid.map((r) => `แถว ${r.sheetRow} (${r.errors.join('; ')})`).join(', ')
    );
  }

  return {
    tab,
    // Only the headers this mapper actually consumed, so the report does not
    // imply that Google's "คอลัมน์ N" placeholders were read.
    headers: (Object.entries(map.indexes) as Array<[string, number]>)
      .filter(([, i]) => i >= 0)
      .map(([field, i]) => `${map.headers[i]} → ${field}`),
    unmappedHeaders: map.unmapped,
    totalSheetRows: rows.length,
    rows: preview,
    counts,
    duplicateCodes,
    importable: blockers.length === 0,
    blockers,
  };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface EmployeeSyncResult {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  departmentsCreated: string[];
  positionsCreated: string[];
  codes: string[];
  /** Employees created without a hire date or salary the sheet does not carry. */
  needsPayrollReview: string[];
}

export interface EmployeeSyncOptions {
  tab?: string;
  /**
   * Hire date applied to NEWLY created employees only. The sheet has no such
   * column, so this is an explicit operator decision rather than a guess, and
   * it is never applied to an existing record.
   */
  defaultStartDate: Date;
  actorId?: string | null;
}

export async function importEmployees(options: EmployeeSyncOptions): Promise<EmployeeSyncResult> {
  const tab = options.tab ?? EMPLOYEE_SHEET_TAB;
  const preview = await previewEmployeeSync(tab);
  if (!preview.importable) {
    throw badRequest(`ไม่สามารถนำเข้าข้อมูลพนักงานได้:\n${preview.blockers.join('\n')}`);
  }

  const { rows } = await fetchEmployeeSheet(tab);
  const result: EmployeeSyncResult = {
    created: 0, updated: 0, unchanged: 0, skipped: 0,
    departmentsCreated: [], positionsCreated: [], codes: [], needsPayrollReview: [],
  };

  // --- master data ---------------------------------------------------------
  // Departments and positions are created from the sheet's own labels. Existing
  // records are reused when the name matches; nothing is renamed or merged.
  const departmentIds = new Map<string, string>();
  for (const name of [...new Set(rows.map((r) => r.department).filter((d): d is string => Boolean(d)))]) {
    const found = await prisma.department.findFirst({ where: { name } });
    if (found) { departmentIds.set(name, found.id); continue; }
    const created = await prisma.department.create({
      data: { code: slugCode(name, `DEPT_${departmentIds.size + 1}`), name },
    });
    departmentIds.set(name, created.id);
    result.departmentsCreated.push(`${created.code} (${name})`);
  }

  const positionIds = new Map<string, string>();
  for (const row of rows) {
    const name = row.position;
    if (!name || positionIds.has(name)) continue;
    const found = await prisma.position.findFirst({ where: { name } });
    if (found) { positionIds.set(name, found.id); continue; }
    const created = await prisma.position.create({
      data: {
        code: slugCode(name, `POS_${positionIds.size + 1}`),
        name,
        departmentId: row.department ? departmentIds.get(row.department) ?? null : null,
      },
    });
    positionIds.set(name, created.id);
    result.positionsCreated.push(`${created.code} (${name})`);
  }

  // --- employees -----------------------------------------------------------
  for (const row of rows) {
    const sheetOwned: SheetOwnedFields = {
      firstName: row.firstName,
      lastName: row.lastName,
      nickname: row.nickname,
      departmentId: row.department ? departmentIds.get(row.department) ?? null : null,
      positionId: row.position ? positionIds.get(row.position) ?? null : null,
      employmentType: row.employmentType,
      status: row.status,
    };

    const current = await prisma.employee.findUnique({
      where: { employeeCode: row.employeeCode },
      select: {
        id: true, firstName: true, lastName: true, nickname: true,
        departmentId: true, positionId: true, employmentType: true, status: true,
      },
    });

    if (!current) {
      await prisma.employee.create({
        data: {
          employeeCode: row.employeeCode,
          firstName: sheetOwned.firstName,
          lastName: sheetOwned.lastName,
          nickname: sheetOwned.nickname,
          departmentId: sheetOwned.departmentId,
          positionId: sheetOwned.positionId,
          employmentType: sheetOwned.employmentType ?? 'MONTHLY',
          status: sheetOwned.status ?? 'ACTIVE',
          // The sheet carries neither a hire date nor a salary. baseSalary
          // stays 0 so the pre-payroll check refuses to run until Payroll sets
          // it, rather than quietly paying a fabricated amount.
          startDate: options.defaultStartDate,
          baseSalary: 0,
          note: 'นำเข้าจาก Google Sheet (Employees) — ต้องตรวจสอบวันเริ่มงานและเงินเดือนโดยฝ่ายเงินเดือน',
        },
      });
      result.created += 1;
      result.needsPayrollReview.push(row.employeeCode);
    } else {
      // Only write fields the sheet actually supplied and that actually differ.
      const data: Prisma.EmployeeUpdateInput = {};
      if (sheetOwned.firstName && sheetOwned.firstName !== current.firstName) {
        data.firstName = sheetOwned.firstName;
      }
      if (sheetOwned.lastName && sheetOwned.lastName !== current.lastName) {
        data.lastName = sheetOwned.lastName;
      }
      if (sheetOwned.nickname && sheetOwned.nickname !== current.nickname) {
        data.nickname = sheetOwned.nickname;
      }
      if (sheetOwned.departmentId && sheetOwned.departmentId !== current.departmentId) {
        data.department = { connect: { id: sheetOwned.departmentId } };
      }
      if (sheetOwned.positionId && sheetOwned.positionId !== current.positionId) {
        data.position = { connect: { id: sheetOwned.positionId } };
      }
      if (sheetOwned.employmentType && sheetOwned.employmentType !== current.employmentType) {
        data.employmentType = sheetOwned.employmentType;
      }
      if (sheetOwned.status && sheetOwned.status !== current.status) {
        data.status = sheetOwned.status;
      }

      if (Object.keys(data).length === 0) {
        result.unchanged += 1;
      } else {
        await prisma.employee.update({ where: { id: current.id }, data });
        result.updated += 1;
      }
    }
    result.codes.push(row.employeeCode);
  }

  await recordAudit({
    action: 'EMPLOYEE_SHEET_SYNC',
    entity: 'Employee',
    entityId: null,
    userId: options.actorId ?? null,
    reason: `นำเข้าพนักงานจาก Google Sheet แท็บ ${tab}`,
    newValue: {
      tab,
      created: result.created,
      updated: result.updated,
      unchanged: result.unchanged,
      departmentsCreated: result.departmentsCreated,
      positionsCreated: result.positionsCreated,
      codes: result.codes,
    },
  });

  return result;
}
