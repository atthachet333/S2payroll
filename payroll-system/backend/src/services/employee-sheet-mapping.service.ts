/**
 * Column mapping and row validation for the `Employees` Google Sheet tab.
 *
 * Pure and I/O-free, like sheet-mapping.service, so every header variant and
 * malformed row is unit-testable without touching Google or the database.
 *
 * Two rules drive the design:
 *
 *  1. Column positions are never hardcoded. Headers are matched by name
 *     against an alias table, so the sheet may be reordered or extended.
 *  2. The employee code is the only identity. A row without one is INVALID and
 *     is never imported, and names are never used to match an existing record
 *     - two people can share a name, and attaching the wrong hours to the
 *     wrong payslip is not a recoverable mistake.
 *
 * The real S2A_DB `Employees` tab carries: lineUserId, employeeId, name,
 * position, department, EmploymentType. Fields the sheet does not have
 * (hire date, salary, status) are never invented here - they are simply
 * absent from the mapped result and left to Payroll to configure.
 */

/** Fields this mapper can read out of the sheet. */
export type EmployeeSheetField =
  | 'employeeCode'
  | 'name'
  | 'firstName'
  | 'lastName'
  | 'nickname'
  | 'department'
  | 'position'
  | 'employmentType'
  | 'startDate'
  | 'status';

/** Only the code is structurally required; everything else is optional. */
export const REQUIRED_EMPLOYEE_FIELDS: EmployeeSheetField[] = ['employeeCode'];

export const EMPLOYEE_HEADER_ALIASES: Record<EmployeeSheetField, string[]> = {
  employeeCode: [
    'empid', 'emp_id', 'employeeid', 'employee_id', 'employee_code', 'employeecode',
    'emp_code', 'empcode', 'code', 'staff_code', 'staff_id',
    'รหัสพนักงาน', 'รหัสพนง', 'รหัส', 'เลขที่พนักงาน',
  ],
  name: [
    'name', 'fullname', 'full_name', 'displayname', 'display_name', 'employee_name',
    'ชื่อ', 'ชื่อ-นามสกุล', 'ชื่อนามสกุล', 'ชื่อพนักงาน', 'ชื่อ - นามสกุล',
  ],
  firstName: ['firstname', 'first_name', 'givenname', 'ชื่อจริง', 'ชื่อต้น'],
  lastName: ['lastname', 'last_name', 'surname', 'familyname', 'นามสกุล', 'สกุล'],
  nickname: ['nickname', 'nick_name', 'nick', 'ชื่อเล่น'],
  department: ['department', 'dept', 'division', 'แผนก', 'ฝ่าย', 'หน่วยงาน'],
  position: ['position', 'jobtitle', 'job_title', 'title', 'role', 'ตำแหน่ง'],
  employmentType: [
    'employmenttype', 'employment_type', 'emptype', 'emp_type', 'contracttype',
    'ประเภทพนักงาน', 'ประเภทการจ้าง', 'ประเภท',
  ],
  startDate: [
    'startdate', 'start_date', 'hiredate', 'hire_date', 'joindate', 'join_date',
    'วันเริ่มงาน', 'วันที่เริ่มงาน', 'วันเข้างาน',
  ],
  status: ['status', 'employeestatus', 'employee_status', 'สถานะ', 'สถานะพนักงาน'],
};

/** Headers deliberately ignored: identifiers that must never key an employee. */
export const IGNORED_HEADERS = [
  'lineuserid', 'line_user_id', 'userid', 'user_id', 'clientrequestid',
  'client_request_id', 'lat', 'lng', 'latitude', 'longitude',
];

export function normaliseHeader(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_.\-()[\]]/g, '');
}

const NORMALISED: Record<EmployeeSheetField, Set<string>> = Object.fromEntries(
  (Object.keys(EMPLOYEE_HEADER_ALIASES) as EmployeeSheetField[]).map((field) => [
    field,
    new Set(EMPLOYEE_HEADER_ALIASES[field].map(normaliseHeader)),
  ])
) as Record<EmployeeSheetField, Set<string>>;

const NORMALISED_IGNORED = new Set(IGNORED_HEADERS.map(normaliseHeader));

/** Placeholder headers Google adds for untouched columns ("คอลัมน์ 7"). */
const PLACEHOLDER_HEADER = /^(คอลัมน์\d+|column\d+|unnamed\d*)$/;

export interface EmployeeColumnMap {
  indexes: Record<EmployeeSheetField, number>;
  missing: EmployeeSheetField[];
  headers: string[];
  /** Headers present in the sheet that this mapper does not consume. */
  unmapped: string[];
  firstDataRow: 2;
}

export function resolveEmployeeColumns(headerRow: unknown[]): EmployeeColumnMap {
  const headers = headerRow.map((h) => String(h ?? '').trim());
  const normalised = headers.map(normaliseHeader);

  const fields = Object.keys(EMPLOYEE_HEADER_ALIASES) as EmployeeSheetField[];
  const indexes = Object.fromEntries(
    fields.map((field) => [
      field,
      normalised.findIndex((h) => h !== '' && NORMALISED[field].has(h)),
    ])
  ) as Record<EmployeeSheetField, number>;

  const claimed = new Set(Object.values(indexes).filter((i) => i >= 0));
  const unmapped = headers.filter(
    (h, i) =>
      h !== '' &&
      !claimed.has(i) &&
      !NORMALISED_IGNORED.has(normalised[i]) &&
      !PLACEHOLDER_HEADER.test(normalised[i])
  );

  return {
    indexes,
    missing: REQUIRED_EMPLOYEE_FIELDS.filter((f) => indexes[f] < 0),
    headers,
    unmapped,
    firstDataRow: 2,
  };
}

export function describeMissingEmployeeColumns(map: EmployeeColumnMap): string {
  const found = map.headers.filter(Boolean).join(', ') || '(ไม่พบหัวตาราง)';
  const accepted = map.missing
    .map((f) => `${f} → ${EMPLOYEE_HEADER_ALIASES[f].slice(0, 6).join(' / ')}`)
    .join('\n  ');
  return (
    `ไม่พบคอลัมน์ที่จำเป็นในแท็บ Employees: ${map.missing.join(', ')}\n` +
    `หัวตารางที่พบในชีต: ${found}\n` +
    `ชื่อคอลัมน์ที่รองรับ:\n  ${accepted}`
  );
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

/** Thai and English honorifics stripped before splitting a full name. */
const TITLES = [
  'นางสาว', 'น.ส.', 'นส.', 'นาง', 'นาย', 'ด.ช.', 'ด.ญ.',
  'ดร.', 'ผศ.', 'รศ.', 'ศ.', 'ว่าที่ร.ต.', 'ว่าที่ ร.ต.',
  'mr.', 'mr', 'mrs.', 'mrs', 'ms.', 'ms', 'miss', 'dr.', 'dr',
];

export interface ParsedName {
  firstName: string;
  lastName: string;
  nickname: string | null;
  title: string | null;
}

/**
 * Split "นางสาว ฐิติรัตน์ ทิพย์สุราษฏร์ (ดรีม)" into its parts.
 *
 * A trailing parenthesised token is the nickname; a leading honorific is
 * recorded but not stored as part of the name. What remains is first name +
 * last name. A single remaining token becomes the first name with an empty
 * last name rather than being guessed at.
 */
export function parseThaiFullName(raw: string): ParsedName {
  let value = String(raw ?? '').trim().replace(/\s+/g, ' ');

  let nickname: string | null = null;
  const nick = value.match(/[（(]\s*([^）)]+?)\s*[）)]\s*$/);
  if (nick) {
    nickname = nick[1].trim() || null;
    value = value.slice(0, nick.index).trim();
  }

  let title: string | null = null;
  for (const candidate of TITLES) {
    const lower = value.toLowerCase();
    if (lower.startsWith(`${candidate} `) || lower === candidate) {
      title = value.slice(0, candidate.length);
      value = value.slice(candidate.length).trim();
      break;
    }
  }

  const parts = value.split(' ').filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '', nickname, title };
  if (parts.length === 1) return { firstName: parts[0], lastName: '', nickname, title };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
    nickname,
    title,
  };
}

export type EmploymentTypeValue = 'MONTHLY' | 'DAILY' | 'HOURLY' | 'CONTRACT';

const EMPLOYMENT_TYPES: Array<[EmploymentTypeValue, string[]]> = [
  ['MONTHLY', ['monthly', 'fulltime', 'full_time', 'permanent', 'พนักงานประจำ', 'ประจำ', 'รายเดือน']],
  ['DAILY', ['daily', 'พนักงานรายวัน', 'รายวัน']],
  ['HOURLY', ['hourly', 'พนักงานรายชั่วโมง', 'รายชั่วโมง']],
  ['CONTRACT', ['contract', 'สัญญาจ้าง', 'พนักงานสัญญาจ้าง', 'จ้างเหมา', 'outsource']],
];

/** Returns null for an unrecognised value rather than defaulting silently. */
export function parseEmploymentType(raw: string): EmploymentTypeValue | null {
  const key = normaliseHeader(raw);
  if (!key) return null;
  for (const [value, aliases] of EMPLOYMENT_TYPES) {
    if (aliases.map(normaliseHeader).includes(key)) return value;
  }
  return null;
}

export type EmployeeStatusValue = 'ACTIVE' | 'INACTIVE' | 'TERMINATED' | 'PROBATION';

const STATUSES: Array<[EmployeeStatusValue, string[]]> = [
  ['ACTIVE', ['active', 'working', 'ทำงาน', 'ปกติ', 'ทำงานอยู่']],
  ['INACTIVE', ['inactive', 'suspended', 'พักงาน', 'ไม่ทำงาน']],
  ['TERMINATED', ['terminated', 'resigned', 'ลาออก', 'พ้นสภาพ', 'เลิกจ้าง']],
  ['PROBATION', ['probation', 'ทดลองงาน']],
];

export function parseEmployeeStatus(raw: string): EmployeeStatusValue | null {
  const key = normaliseHeader(raw);
  if (!key) return null;
  for (const [value, aliases] of STATUSES) {
    if (aliases.map(normaliseHeader).includes(key)) return value;
  }
  return null;
}

/** A code must be non-empty and safely short; casing is normalised upward. */
export function normaliseEmployeeCode(raw: string): string {
  return String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

// ---------------------------------------------------------------------------
// Row extraction
// ---------------------------------------------------------------------------

/**
 * One sheet row mapped to payroll fields.
 *
 * Every optional field is `null` when the sheet does not carry it, so an
 * importer can tell "the sheet says blank" apart from "the sheet has no such
 * column" and avoid overwriting a value it does not own.
 */
export interface MappedEmployeeRow {
  sheetRow: number;
  employeeCode: string;
  rawName: string;
  firstName: string;
  lastName: string;
  nickname: string | null;
  department: string | null;
  position: string | null;
  employmentType: EmploymentTypeValue | null;
  rawEmploymentType: string | null;
  startDate: string | null;
  status: EmployeeStatusValue | null;
  /** Reasons this row cannot be imported. Empty means structurally valid. */
  errors: string[];
}

export function extractEmployeeRows(
  values: unknown[][],
  map: EmployeeColumnMap
): MappedEmployeeRow[] {
  const cell = (row: unknown[], field: EmployeeSheetField): string => {
    const index = map.indexes[field];
    return index >= 0 ? String(row[index] ?? '').trim() : '';
  };
  const orNull = (value: string): string | null => (value === '' ? null : value);

  return values
    .slice(1)
    .map((row, index) => {
      const employeeCode = normaliseEmployeeCode(cell(row, 'employeeCode'));
      const rawName = cell(row, 'name');

      // Explicit first/last columns win; otherwise parse the combined name.
      const explicitFirst = cell(row, 'firstName');
      const explicitLast = cell(row, 'lastName');
      const explicitNick = cell(row, 'nickname');
      const parsed = parseThaiFullName(rawName);

      const firstName = explicitFirst || parsed.firstName;
      const lastName = explicitLast || parsed.lastName;
      const nickname = orNull(explicitNick) ?? parsed.nickname;

      const rawEmploymentType = orNull(cell(row, 'employmentType'));
      const rawStatus = orNull(cell(row, 'status'));

      const errors: string[] = [];
      if (!employeeCode) errors.push('ไม่มีรหัสพนักงาน');
      else if (employeeCode.length > 32) errors.push('รหัสพนักงานยาวเกิน 32 ตัวอักษร');
      if (!firstName) errors.push('ไม่มีชื่อพนักงาน');
      if (rawEmploymentType && !parseEmploymentType(rawEmploymentType)) {
        errors.push(`ประเภทพนักงานไม่รู้จัก: ${rawEmploymentType}`);
      }
      if (rawStatus && !parseEmployeeStatus(rawStatus)) {
        errors.push(`สถานะไม่รู้จัก: ${rawStatus}`);
      }

      return {
        sheetRow: index + map.firstDataRow,
        employeeCode,
        rawName,
        firstName,
        lastName,
        nickname,
        department: orNull(cell(row, 'department')),
        position: orNull(cell(row, 'position')),
        employmentType: rawEmploymentType ? parseEmploymentType(rawEmploymentType) : null,
        rawEmploymentType,
        startDate: orNull(cell(row, 'startDate')),
        status: rawStatus ? parseEmployeeStatus(rawStatus) : null,
        errors,
      };
    })
    // A wholly blank row is a trailing artefact, not an error.
    .filter((r) => r.employeeCode !== '' || r.rawName !== '' || r.department || r.position);
}

/** Codes appearing more than once in a single pull. */
export function findDuplicateCodes(rows: MappedEmployeeRow[]): string[] {
  const seen = new Map<string, number>();
  for (const row of rows) {
    if (!row.employeeCode) continue;
    seen.set(row.employeeCode, (seen.get(row.employeeCode) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([code]) => code).sort();
}

/** Derives a stable master-data code from a free-text department/position. */
export function slugCode(name: string, fallback: string): string {
  const ascii = String(name ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (ascii || fallback).slice(0, 32);
}
