import crypto from 'node:crypto';

/** All 13 source fields from the LINE Bot attendance event sheet. */
export interface AttendanceSourceEvent {
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

export type EventResolutionStatus =
  | 'VALID'
  | 'MISSING_CHECKIN'
  | 'MISSING_CHECKOUT'
  | 'MULTIPLE_EVENTS'
  | 'INVALID';

export interface DuplicateSourceEvent {
  row: number;
  duplicateOfRow: number;
  identity: 'clientRequestId' | 'logical';
}

export interface ResolvedAttendanceDay {
  employeeCode: string;
  date: string;
  sheetRows: number[];
  sourceEvents: AttendanceSourceEvent[];
  /** De-duplicated valid events used for attendance resolution. */
  effectiveEvents: AttendanceSourceEvent[];
  duplicateSourceEvents: DuplicateSourceEvent[];
  checkInEvents: AttendanceSourceEvent[];
  checkOutEvents: AttendanceSourceEvent[];
  checkIn: string | null;
  checkOut: string | null;
  status: EventResolutionStatus;
  reason: string;
  workHoursWarning: string | null;
}

const normaliseType = (value: string): 'checkin' | 'checkout' | null => {
  const normalised = value.trim().toLowerCase().replace(/[\s_-]/g, '');
  if (['checkin', 'clockin', 'in', 'เข้างาน', 'เข้า'].includes(normalised)) return 'checkin';
  if (['checkout', 'clockout', 'out', 'ออกงาน', 'ออก'].includes(normalised)) return 'checkout';
  return null;
};

const validDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
const validTime = (value: string): boolean => {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  return Boolean(match && Number(match[1]) <= 23 && Number(match[2]) <= 59);
};

const timeMinutes = (value: string): number | null => {
  if (!validTime(value)) return null;
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
};

/**
 * Parse a source workHours cell into minutes for comparison only.
 * It is never used as payroll time. Supported examples: 8, 8.5, 08:30,
 * "8h 30m", and "8 ชั่วโมง 30 นาที".
 */
export function parseWorkHoursMinutes(value: string): number | null {
  const raw = value.trim().toLowerCase();
  if (!raw) return null;

  if (/^\d{1,2}:\d{2}$/.test(raw)) {
    const [hours, minutes] = raw.split(':').map(Number);
    return minutes <= 59 ? hours * 60 + minutes : null;
  }

  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 60);

  const hours = raw.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours|ชั่วโมง)/)?.[1];
  const minutes = raw.match(/(\d+)\s*(?:m|min|mins|minute|minutes|นาที)/)?.[1];
  if (hours || minutes) return Math.round(Number(hours ?? 0) * 60 + Number(minutes ?? 0));
  return null;
}

/** Stable source identity. Sheet row is deliberately excluded. */
export function sourceEventHash(event: AttendanceSourceEvent): string {
  const identity = event.clientRequestId.trim()
    ? `client:${event.clientRequestId.trim()}`
    : [
        'logical',
        event.timestamp.trim(),
        event.date.trim(),
        event.employeeCode.trim(),
        normaliseType(event.type) ?? event.type.trim().toLowerCase(),
        event.time.trim(),
      ].join('|');
  return crypto.createHash('sha256').update(identity).digest('hex');
}

const eventOrder = (event: AttendanceSourceEvent): number => {
  const timestamp = Date.parse(event.timestamp);
  if (Number.isFinite(timestamp)) return timestamp;
  const minutes = timeMinutes(event.time);
  if (validDate(event.date) && minutes !== null) {
    return Date.parse(`${event.date}T00:00:00Z`) + minutes * 60_000;
  }
  return Number.MAX_SAFE_INTEGER - 10_000 + event.sheetRow;
};

function compareWorkHours(
  events: AttendanceSourceEvent[],
  checkIn: string | null,
  checkOut: string | null,
  materialMinutes: number
): string | null {
  if (!checkIn || !checkOut) return null;
  const start = timeMinutes(checkIn);
  const end = timeMinutes(checkOut);
  if (start === null || end === null || end < start) return null;
  const calculated = end - start;

  const reported = events
    .map((event) => parseWorkHoursMinutes(event.workHours))
    .filter((minutes): minutes is number => minutes !== null);
  if (reported.length === 0) return null;

  // The checkout event normally contains the completed workHours value. Use
  // the last reported value in timestamp order, never an arbitrary sheet row.
  const sourceMinutes = reported.at(-1)!;
  const difference = Math.abs(sourceMinutes - calculated);
  if (difference < materialMinutes) return null;
  return `workHours ในชีต ${sourceMinutes} นาที ต่างจากเวลาที่คำนวณ ${calculated} นาที (${difference} นาที)`;
}

export function resolveEventAttendance(
  sourceEvents: AttendanceSourceEvent[],
  workHoursMismatchMinutes = 15
): ResolvedAttendanceDay[] {
  const groups = new Map<string, AttendanceSourceEvent[]>();

  for (const event of sourceEvents) {
    const code = event.employeeCode.trim();
    const date = event.date.trim();
    // Missing codes must remain separate unresolved rows, not collapse into
    // one fabricated employee-day.
    const key = code && date ? `${code}|${date}` : `invalid-row:${event.sheetRow}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }

  return [...groups.values()]
    .map((events): ResolvedAttendanceDay => {
      const ordered = [...events].sort((a, b) => eventOrder(a) - eventOrder(b));
      const first = ordered[0];
      const duplicateSourceEvents: DuplicateSourceEvent[] = [];
      const seen = new Map<string, AttendanceSourceEvent>();
      const effectiveEvents: AttendanceSourceEvent[] = [];

      for (const event of ordered) {
        const hash = sourceEventHash(event);
        const previous = seen.get(hash);
        if (previous) {
          duplicateSourceEvents.push({
            row: event.sheetRow,
            duplicateOfRow: previous.sheetRow,
            identity: event.clientRequestId.trim() ? 'clientRequestId' : 'logical',
          });
          continue;
        }
        seen.set(hash, event);
        effectiveEvents.push(event);
      }

      const base = {
        employeeCode: first.employeeCode.trim(),
        date: first.date.trim(),
        sheetRows: ordered.map((event) => event.sheetRow),
        sourceEvents: ordered,
        effectiveEvents,
        duplicateSourceEvents,
      };

      if (!base.employeeCode) {
        return {
          ...base,
          checkInEvents: [],
          checkOutEvents: [],
          checkIn: null,
          checkOut: null,
          status: 'INVALID',
          reason: 'ไม่มี empId / employee_code',
          workHoursWarning: null,
        };
      }
      if (!validDate(base.date)) {
        return {
          ...base,
          checkInEvents: [],
          checkOutEvents: [],
          checkIn: null,
          checkOut: null,
          status: 'INVALID',
          reason: `รูปแบบวันที่ไม่ถูกต้อง: "${base.date}"`,
          workHoursWarning: null,
        };
      }

      const invalidEvents = effectiveEvents.filter(
        (event) => !normaliseType(event.type) || !validTime(event.time)
      );
      const checkInEvents = effectiveEvents.filter(
        (event) => normaliseType(event.type) === 'checkin' && validTime(event.time)
      );
      const checkOutEvents = effectiveEvents.filter(
        (event) => normaliseType(event.type) === 'checkout' && validTime(event.time)
      );
      const checkIn = checkInEvents.length === 1 ? checkInEvents[0].time : null;
      const checkOut = checkOutEvents.length === 1 ? checkOutEvents[0].time : null;

      if (invalidEvents.length > 0) {
        const rows = invalidEvents.map((event) => event.sheetRow).join(', ');
        return {
          ...base,
          checkInEvents,
          checkOutEvents,
          checkIn,
          checkOut,
          status: 'INVALID',
          reason: `type หรือ time ไม่ถูกต้องที่แถว ${rows}`,
          workHoursWarning: null,
        };
      }

      if (checkInEvents.length > 1 || checkOutEvents.length > 1) {
        return {
          ...base,
          checkInEvents,
          checkOutEvents,
          checkIn,
          checkOut,
          status: 'MULTIPLE_EVENTS',
          reason: `พบ checkin ${checkInEvents.length} รายการ และ checkout ${checkOutEvents.length} รายการ`,
          workHoursWarning: null,
        };
      }

      let status: EventResolutionStatus = 'VALID';
      let reason = 'พบ checkin และ checkout อย่างละ 1 รายการ';
      if (checkInEvents.length === 0 && checkOutEvents.length === 1) {
        status = 'MISSING_CHECKIN';
        reason = 'พบ checkout แต่ไม่พบ checkin';
      } else if (checkInEvents.length === 1 && checkOutEvents.length === 0) {
        status = 'MISSING_CHECKOUT';
        reason = 'พบ checkin แต่ไม่พบ checkout';
      } else if (checkInEvents.length === 0 && checkOutEvents.length === 0) {
        status = 'INVALID';
        reason = 'ไม่พบ event checkin หรือ checkout ที่ใช้ได้';
      }

      return {
        ...base,
        checkInEvents,
        checkOutEvents,
        checkIn,
        checkOut,
        status,
        reason,
        workHoursWarning:
          status === 'VALID'
            ? compareWorkHours(ordered, checkIn, checkOut, workHoursMismatchMinutes)
            : null,
      };
    })
    .sort((a, b) =>
      a.date === b.date
        ? a.employeeCode.localeCompare(b.employeeCode)
        : a.date.localeCompare(b.date)
    );
}

