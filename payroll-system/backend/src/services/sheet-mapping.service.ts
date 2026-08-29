/**
 * Column mapping and row validation for the attendance sheet.
 *
 * Pure and I/O-free, so every header variant and malformed row can be unit
 * tested without touching Google or the database.
 *
 * Column positions are never hardcoded in the import path. Headers are matched
 * by name against a configurable alias table covering Thai and English, and the
 * resolved indexes are carried in a ColumnMap. A sheet may add columns, reorder
 * them, or rename them within the alias set without any code change.
 */

/** The four fields the payroll system needs from the sheet. */
export type SheetField = 'employeeCode' | 'date' | 'checkIn' | 'checkOut';

export type EventSheetField =
  | 'timestamp'
  | 'employeeCode'
  | 'date'
  | 'displayName'
  | 'type'
  | 'time'
  | 'workHours'
  | 'lat'
  | 'lng'
  | 'summary'
  | 'employmentType'
  | 'userId'
  | 'clientRequestId';

export const REQUIRED_FIELDS: SheetField[] = ['employeeCode', 'date'];
export const OPTIONAL_FIELDS: SheetField[] = ['checkIn', 'checkOut'];

/**
 * Accepted header names per field, Thai and English.
 * Matching is case-insensitive and ignores spaces, underscores and dots, so
 * "Employee Code", "employee_code" and "EMPLOYEECODE" all resolve the same.
 */
export const HEADER_ALIASES: Record<SheetField, string[]> = {
  employeeCode: [
    // English
    'employee_code',
    'employeecode',
    'employee_id',
    'employeeid',
    'emp_code',
    'empcode',
    'emp_id',
    'code',
    'staff_code',
    'staff_id',
    // Thai
    'รหัสพนักงาน',
    'รหัสพนง',
    'รหัส',
    'เลขที่พนักงาน',
    'หมายเลขพนักงาน',
  ],
  date: [
    'date',
    'work_date',
    'workdate',
    'attendance_date',
    'day',
    'วันที่',
    'วันทำงาน',
    'วันที่ทำงาน',
    'วัน',
  ],
  checkIn: [
    'check_in',
    'checkin',
    'time_in',
    'timein',
    'clock_in',
    'clockin',
    'in',
    'start_time',
    'เวลาเข้างาน',
    'เวลาเข้า',
    'เข้างาน',
    'เวลาเริ่มงาน',
    'เข้า',
  ],
  checkOut: [
    'check_out',
    'checkout',
    'time_out',
    'timeout',
    'clock_out',
    'clockout',
    'out',
    'end_time',
    'เวลาออกงาน',
    'เวลาออก',
    'ออกงาน',
    'เวลาเลิกงาน',
    'ออก',
  ],
};

/** Field labels for human-readable error messages. */
export const FIELD_LABELS: Record<SheetField, string> = {
  employeeCode: 'รหัสพนักงาน (employee_code)',
  date: 'วันที่ (date)',
  checkIn: 'เวลาเข้างาน (check_in)',
  checkOut: 'เวลาออกงาน (check_out)',
};

/**
 * Normalise a header cell for comparison: lowercase, strip spaces, underscores,
 * dots, hyphens and surrounding punctuation. Thai text is unaffected by
 * lowercasing but still benefits from whitespace removal.
 */
export function normaliseHeader(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_.\-()[\]]/g, '');
}

const NORMALISED_ALIASES: Record<SheetField, Set<string>> = {
  employeeCode: new Set(HEADER_ALIASES.employeeCode.map(normaliseHeader)),
  date: new Set(HEADER_ALIASES.date.map(normaliseHeader)),
  checkIn: new Set(HEADER_ALIASES.checkIn.map(normaliseHeader)),
  checkOut: new Set(HEADER_ALIASES.checkOut.map(normaliseHeader)),
};

const EVENT_HEADER_ALIASES: Record<EventSheetField, string[]> = {
  timestamp: ['timestamp', 'event_timestamp', 'created_at', 'เวลาบันทึก'],
  employeeCode: HEADER_ALIASES.employeeCode,
  date: HEADER_ALIASES.date,
  displayName: ['displayName', 'display_name', 'employee_name', 'ชื่อพนักงาน', 'ชื่อ'],
  type: ['type', 'event_type', 'attendance_type', 'ประเภท', 'ประเภทรายการ'],
  time: ['time', 'event_time', 'attendance_time', 'เวลา'],
  workHours: ['workHours', 'work_hours', 'working_hours', 'ชั่วโมงทำงาน'],
  lat: ['lat', 'latitude', 'ละติจูด'],
  lng: ['lng', 'lon', 'longitude', 'ลองจิจูด'],
  summary: ['summary', 'note', 'หมายเหตุ', 'สรุป'],
  employmentType: ['employmentType', 'employment_type', 'ประเภทพนักงาน'],
  userId: ['userId', 'user_id', 'line_user_id'],
  clientRequestId: ['clientRequestId', 'client_request_id', 'request_id'],
};

const NORMALISED_EVENT_ALIASES = Object.fromEntries(
  Object.entries(EVENT_HEADER_ALIASES).map(([field, aliases]) => [
    field,
    new Set(aliases.map(normaliseHeader)),
  ])
) as Record<EventSheetField, Set<string>>;

export interface EventColumnMap {
  indexes: Record<EventSheetField, number>;
  missing: Array<'employeeCode' | 'date' | 'type' | 'time'>;
  headers: string[];
  firstDataRow: 2;
}

/** Resolve the event-based empId/date/type/time sheet format. */
export function resolveEventColumns(headerRow: unknown[]): EventColumnMap {
  const headers = headerRow.map((header) => String(header ?? '').trim());
  const normalised = headers.map(normaliseHeader);
  const fields = Object.keys(EVENT_HEADER_ALIASES) as EventSheetField[];
  const indexes = Object.fromEntries(
    fields.map((field) => [
      field,
      normalised.findIndex(
        (header) => header !== '' && NORMALISED_EVENT_ALIASES[field].has(header)
      ),
    ])
  ) as Record<EventSheetField, number>;
  const required: Array<'employeeCode' | 'date' | 'type' | 'time'> = [
    'employeeCode',
    'date',
    'type',
    'time',
  ];
  return {
    indexes,
    missing: required.filter((field) => indexes[field] < 0),
    headers,
    firstDataRow: 2,
  };
}

/** An event sheet is identified by the presence of both event discriminator columns. */
export function isEventSheet(headerRow: unknown[]): boolean {
  const map = resolveEventColumns(headerRow);
  return map.indexes.type >= 0 && map.indexes.time >= 0;
}

export interface ExtractedEventRow {
  sheetRow: number;
  timestamp: string;
  date: string;
  employeeCode: string;
  displayName: string;
  type: string;
  time: string;
  workHours: string;
  lat: string;
  lng: string;
  summary: string;
  employmentType: string;
  userId: string;
  clientRequestId: string;
}

export function extractEventRows(values: unknown[][], map: EventColumnMap): ExtractedEventRow[] {
  const cell = (row: unknown[], field: EventSheetField): string => {
    const index = map.indexes[field];
    return index >= 0 ? String(row[index] ?? '').trim() : '';
  };
  return values
    .slice(1)
    .map((row, index) => ({
      sheetRow: index + map.firstDataRow,
      timestamp: cell(row, 'timestamp'),
      date: cell(row, 'date'),
      employeeCode: cell(row, 'employeeCode'),
      displayName: cell(row, 'displayName'),
      type: cell(row, 'type'),
      time: cell(row, 'time'),
      workHours: cell(row, 'workHours'),
      lat: cell(row, 'lat'),
      lng: cell(row, 'lng'),
      summary: cell(row, 'summary'),
      employmentType: cell(row, 'employmentType'),
      userId: cell(row, 'userId'),
      clientRequestId: cell(row, 'clientRequestId'),
    }))
    .filter((row) =>
      Boolean(row.employeeCode || row.date || row.type || row.time || row.timestamp)
    );
}

export interface ColumnMap {
  /** Column index per field; -1 when the column is absent. */
  indexes: Record<SheetField, number>;
  /** True when the first row was recognised as a header. */
  hasHeader: boolean;
  /** Required fields that could not be located. */
  missing: SheetField[];
  /** Raw header cells, for reporting back to the user. */
  headers: string[];
  /** 1-based sheet row number of the first data row. */
  firstDataRow: number;
}

/**
 * Resolve the header row into column indexes.
 *
 * When no header is recognised the sheet is assumed to be positional
 * (A=code, B=date, C=in, D=out), which keeps the simplest sheets working — but
 * that assumption is reported via `hasHeader: false` so the UI can say so.
 */
export function resolveColumns(headerRow: unknown[]): ColumnMap {
  const headers = headerRow.map((h) => String(h ?? '').trim());
  const normalised = headers.map(normaliseHeader);

  const indexes: Record<SheetField, number> = {
    employeeCode: -1,
    date: -1,
    checkIn: -1,
    checkOut: -1,
  };

  for (const field of Object.keys(NORMALISED_ALIASES) as SheetField[]) {
    indexes[field] = normalised.findIndex((h) => h !== '' && NORMALISED_ALIASES[field].has(h));
  }

  // A header row is only assumed when at least one required field matched.
  const hasHeader = indexes.employeeCode >= 0 || indexes.date >= 0;

  if (!hasHeader) {
    return {
      indexes: { employeeCode: 0, date: 1, checkIn: 2, checkOut: 3 },
      hasHeader: false,
      missing: [],
      headers,
      firstDataRow: 1,
    };
  }

  const missing = REQUIRED_FIELDS.filter((f) => indexes[f] < 0);

  return { indexes, hasHeader: true, missing, headers, firstDataRow: 2 };
}

/** Human-readable explanation of a failed header resolution. */
export function describeMissingColumns(map: ColumnMap): string {
  const missingLabels = map.missing.map((f) => FIELD_LABELS[f]).join(', ');
  const found = map.headers.filter(Boolean).join(', ') || '(ไม่พบหัวตาราง)';
  const accepted = map.missing
    .map((f) => `${FIELD_LABELS[f]} → ${HEADER_ALIASES[f].slice(0, 6).join(' / ')}`)
    .join('\n  ');
  return (
    `ไม่พบคอลัมน์ที่จำเป็น: ${missingLabels}\n` +
    `หัวตารางที่พบในชีต: ${found}\n` +
    `ชื่อคอลัมน์ที่รองรับ:\n  ${accepted}`
  );
}

/** A raw row extracted from the sheet using the resolved column map. */
export interface ExtractedRow {
  employeeCode: string;
  date: string;
  checkIn: string | null;
  checkOut: string | null;
  sheetRow: number;
}

/** Pull the data rows out of a values grid using a resolved column map. */
export function extractRows(values: unknown[][], map: ColumnMap): ExtractedRow[] {
  const dataRows = map.hasHeader ? values.slice(1) : values;
  const cell = (row: unknown[], index: number): string =>
    index >= 0 ? String(row[index] ?? '').trim() : '';

  return dataRows
    .map((row, i) => ({
      employeeCode: cell(row, map.indexes.employeeCode),
      date: cell(row, map.indexes.date),
      checkIn: cell(row, map.indexes.checkIn) || null,
      checkOut: cell(row, map.indexes.checkOut) || null,
      sheetRow: i + map.firstDataRow,
    }))
    // Drop rows that are entirely blank; a trailing empty row is not an error.
    .filter((r) => r.employeeCode !== '' || r.date !== '' || r.checkIn || r.checkOut);
}
