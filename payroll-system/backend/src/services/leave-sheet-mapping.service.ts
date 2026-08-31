/**
 * Column mapping and value parsing for the `LeaveRequests` Google Sheet tab.
 *
 * Pure and I/O-free, so every header variant and malformed row is unit-testable
 * without touching Google or the database.
 *
 * As with the attendance and employee mappers, columns are resolved by header
 * name against an alias table rather than by position, and the employee is
 * identified by employee code alone - never by name, and never by the LINE user
 * id the sheet also carries.
 *
 * The real S2A_DB tab carries: requestId, clientRequestId, employeeLineUserId,
 * employeeId, employeeName, position, department, leaveType, startDate,
 * endDate, totalDays, reason, managerLineUserId, status, approvedBy,
 * approvedAt, rejectedBy, rejectedAt, rejectedReason, createdAt, updatedAt and
 * a block of notification bookkeeping columns.
 */

export type LeaveSheetField =
  | 'requestId'
  | 'employeeCode'
  | 'leaveType'
  | 'startDate'
  | 'endDate'
  | 'totalDays'
  | 'reason'
  | 'status';

/** requestId is the idempotency key; without it a sync would duplicate rows. */
export const REQUIRED_LEAVE_FIELDS: LeaveSheetField[] = ['requestId', 'employeeCode', 'startDate'];

export const LEAVE_HEADER_ALIASES: Record<LeaveSheetField, string[]> = {
  requestId: ['requestid', 'request_id', 'leaveid', 'leave_id', 'id', 'รหัสคำขอ', 'เลขที่คำขอ'],
  employeeCode: [
    'employeeid', 'employee_id', 'empid', 'emp_id', 'employee_code', 'employeecode',
    'code', 'รหัสพนักงาน', 'รหัสพนง',
  ],
  leaveType: ['leavetype', 'leave_type', 'type', 'ประเภทการลา', 'ประเภทลา', 'ชนิดการลา'],
  startDate: ['startdate', 'start_date', 'from', 'fromdate', 'วันที่เริ่ม', 'วันเริ่มลา', 'ตั้งแต่วันที่'],
  endDate: ['enddate', 'end_date', 'to', 'todate', 'วันที่สิ้นสุด', 'วันสิ้นสุดลา', 'ถึงวันที่'],
  totalDays: ['totaldays', 'total_days', 'days', 'numberofdays', 'จำนวนวัน', 'รวมวัน'],
  reason: ['reason', 'note', 'detail', 'เหตุผล', 'รายละเอียด', 'หมายเหตุ'],
  status: ['status', 'leavestatus', 'leave_status', 'สถานะ', 'สถานะคำขอ'],
};

/** Identifiers that must never be used to resolve an employee. */
export const IGNORED_LEAVE_HEADERS = [
  'employeelineuserid', 'managerlineuserid', 'lineuserid', 'userid',
  'clientrequestid', 'employeename', 'lat', 'lng',
];

export function normaliseHeader(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_.\-()[\]]/g, '');
}

const NORMALISED: Record<LeaveSheetField, Set<string>> = Object.fromEntries(
  (Object.keys(LEAVE_HEADER_ALIASES) as LeaveSheetField[]).map((f) => [
    f,
    new Set(LEAVE_HEADER_ALIASES[f].map(normaliseHeader)),
  ])
) as Record<LeaveSheetField, Set<string>>;

const NORMALISED_IGNORED = new Set(IGNORED_LEAVE_HEADERS.map(normaliseHeader));
const PLACEHOLDER_HEADER = /^(คอลัมน์\d+|column\d+|unnamed\d*)$/;
/** The sheet's notification bookkeeping is irrelevant to payroll. */
const BOOKKEEPING_HEADER = /^(manager|employee)notification|^(approved|rejected)(by|at)$|^rejectedreason$|^(created|updated)at$|^position$|^department$/;

export interface LeaveColumnMap {
  indexes: Record<LeaveSheetField, number>;
  missing: LeaveSheetField[];
  headers: string[];
  unmapped: string[];
  firstDataRow: 2;
}

export function resolveLeaveColumns(headerRow: unknown[]): LeaveColumnMap {
  const headers = headerRow.map((h) => String(h ?? '').trim());
  const normalised = headers.map(normaliseHeader);
  const fields = Object.keys(LEAVE_HEADER_ALIASES) as LeaveSheetField[];

  const indexes = Object.fromEntries(
    fields.map((field) => [
      field,
      normalised.findIndex((h) => h !== '' && NORMALISED[field].has(h)),
    ])
  ) as Record<LeaveSheetField, number>;

  const claimed = new Set(Object.values(indexes).filter((i) => i >= 0));
  const unmapped = headers.filter(
    (h, i) =>
      h !== '' &&
      !claimed.has(i) &&
      !NORMALISED_IGNORED.has(normalised[i]) &&
      !PLACEHOLDER_HEADER.test(normalised[i]) &&
      !BOOKKEEPING_HEADER.test(normalised[i])
  );

  return {
    indexes,
    missing: REQUIRED_LEAVE_FIELDS.filter((f) => indexes[f] < 0),
    headers,
    unmapped,
    firstDataRow: 2,
  };
}

export function describeMissingLeaveColumns(map: LeaveColumnMap): string {
  const found = map.headers.filter(Boolean).join(', ') || '(ไม่พบหัวตาราง)';
  const accepted = map.missing
    .map((f) => `${f} → ${LEAVE_HEADER_ALIASES[f].slice(0, 5).join(' / ')}`)
    .join('\n  ');
  return (
    `ไม่พบคอลัมน์ที่จำเป็นในแท็บ LeaveRequests: ${map.missing.join(', ')}\n` +
    `หัวตารางที่พบในชีต: ${found}\n` +
    `ชื่อคอลัมน์ที่รองรับ:\n  ${accepted}`
  );
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

export type LeaveTypeValue = 'ANNUAL' | 'SICK' | 'PERSONAL' | 'MATERNITY' | 'UNPAID' | 'OTHER';

const LEAVE_TYPES: Array<[LeaveTypeValue, string[]]> = [
  ['SICK', ['sick', 'sickleave', 'ลาป่วย', 'ป่วย']],
  ['ANNUAL', ['annual', 'annualleave', 'vacation', 'ลาพักร้อน', 'พักร้อน', 'ลาพักผ่อน']],
  ['PERSONAL', ['personal', 'personalleave', 'business', 'ลากิจ', 'กิจ', 'ลากิจส่วนตัว']],
  ['MATERNITY', ['maternity', 'maternityleave', 'ลาคลอด', 'คลอด', 'ลาคลอดบุตร']],
  ['UNPAID', ['unpaid', 'unpaidleave', 'ลาไม่รับค่าจ้าง', 'ลาไม่ได้รับค่าจ้าง', 'ขาดงาน']],
  ['OTHER', ['other', 'อื่นๆ', 'อื่น ๆ', 'ลาอื่นๆ']],
];

/** Unknown values map to OTHER, which is a real category - not a silent guess. */
export function parseLeaveType(raw: string): LeaveTypeValue {
  const key = normaliseHeader(raw);
  if (!key) return 'OTHER';
  for (const [value, aliases] of LEAVE_TYPES) {
    if (aliases.map(normaliseHeader).includes(key)) return value;
  }
  return 'OTHER';
}

export type LeaveStatusValue = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

const LEAVE_STATUSES: Array<[LeaveStatusValue, string[]]> = [
  ['APPROVED', ['approved', 'approve', 'accepted', 'อนุมัติ', 'อนุมัติแล้ว']],
  ['PENDING', ['pending', 'waiting', 'submitted', 'รออนุมัติ', 'รอดำเนินการ', 'รอ']],
  ['REJECTED', ['rejected', 'reject', 'denied', 'ไม่อนุมัติ', 'ปฏิเสธ']],
  ['CANCELLED', ['cancelled', 'canceled', 'cancel', 'ยกเลิก', 'ยกเลิกแล้ว']],
];

/** Returns null for an unrecognised status so the row can be reported, not guessed. */
export function parseLeaveStatus(raw: string): LeaveStatusValue | null {
  const key = normaliseHeader(raw);
  if (!key) return null;
  for (const [value, aliases] of LEAVE_STATUSES) {
    if (aliases.map(normaliseHeader).includes(key)) return value;
  }
  return null;
}

/** Only SICK and ANNUAL/PERSONAL are paid by default; UNPAID never is. */
export const isPaidLeaveType = (type: LeaveTypeValue): boolean => type !== 'UNPAID';

/**
 * Parse a sheet date into YYYY-MM-DD.
 * Accepts ISO (with or without a time part) and D/M/Y with a Gregorian or
 * Buddhist-era year. Returns null rather than a guess when it cannot tell.
 */
export function parseLeaveDate(raw: string): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;

  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (iso) {
    const [, y, m, d] = iso;
    return isRealDate(+y, +m, +d) ? `${y}-${m}-${d}` : null;
  }

  const dmy = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const [, d, m, rawYear] = dmy;
    // A Buddhist-era year is 543 ahead; anything past 2400 is clearly BE.
    const year = Number(rawYear) > 2400 ? Number(rawYear) - 543 : Number(rawYear);
    return isRealDate(year, +m, +d)
      ? `${String(year).padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
      : null;
  }

  return null;
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

export function normaliseEmployeeCode(raw: string): string {
  return String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

// ---------------------------------------------------------------------------
// Row extraction
// ---------------------------------------------------------------------------

export interface MappedLeaveRow {
  sheetRow: number;
  requestId: string;
  employeeCode: string;
  leaveType: LeaveTypeValue;
  rawLeaveType: string | null;
  startDate: string | null;
  endDate: string | null;
  totalDays: number | null;
  reason: string | null;
  status: LeaveStatusValue | null;
  rawStatus: string | null;
  errors: string[];
}

export function extractLeaveRows(values: unknown[][], map: LeaveColumnMap): MappedLeaveRow[] {
  const cell = (row: unknown[], field: LeaveSheetField): string => {
    const i = map.indexes[field];
    return i >= 0 ? String(row[i] ?? '').trim() : '';
  };
  const orNull = (v: string): string | null => (v === '' ? null : v);

  return values
    .slice(1)
    .map((row, index) => {
      const requestId = cell(row, 'requestId');
      const employeeCode = normaliseEmployeeCode(cell(row, 'employeeCode'));
      const rawLeaveType = orNull(cell(row, 'leaveType'));
      const rawStatus = orNull(cell(row, 'status'));
      const startDate = parseLeaveDate(cell(row, 'startDate'));
      // A single-day leave often leaves endDate blank; fall back to the start.
      const endDate = parseLeaveDate(cell(row, 'endDate')) ?? startDate;
      const rawDays = cell(row, 'totalDays');
      const totalDays = rawDays === '' ? null : Number(rawDays);

      const errors: string[] = [];
      if (!requestId) errors.push('ไม่มีรหัสคำขอ (requestId)');
      if (!employeeCode) errors.push('ไม่มีรหัสพนักงาน');
      if (!startDate) errors.push(`วันที่เริ่มลาไม่ถูกต้อง: ${cell(row, 'startDate') || '(ว่าง)'}`);
      if (endDate && startDate && endDate < startDate) errors.push('วันสิ้นสุดก่อนวันเริ่มลา');
      if (totalDays !== null && (!Number.isFinite(totalDays) || totalDays < 0)) {
        errors.push(`จำนวนวันไม่ถูกต้อง: ${rawDays}`);
      }
      if (rawStatus && !parseLeaveStatus(rawStatus)) {
        errors.push(`สถานะไม่รู้จัก: ${rawStatus}`);
      }

      return {
        sheetRow: index + map.firstDataRow,
        requestId,
        employeeCode,
        leaveType: parseLeaveType(rawLeaveType ?? ''),
        rawLeaveType,
        startDate,
        endDate,
        totalDays: totalDays !== null && Number.isFinite(totalDays) ? totalDays : null,
        reason: orNull(cell(row, 'reason')),
        status: rawStatus ? parseLeaveStatus(rawStatus) : null,
        rawStatus,
        errors,
      };
    })
    .filter((r) => r.requestId !== '' || r.employeeCode !== '' || r.startDate !== null);
}

/** requestIds appearing more than once in a single pull. */
export function findDuplicateRequestIds(rows: MappedLeaveRow[]): string[] {
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (!r.requestId) continue;
    seen.set(r.requestId, (seen.get(r.requestId) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id).sort();
}
