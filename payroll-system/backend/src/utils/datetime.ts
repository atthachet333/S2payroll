import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(customParseFormat);
dayjs.extend(utc);

export { dayjs };

/** Formats accepted for the `date` column of the attendance sheet. */
const DATE_FORMATS = [
  'YYYY-MM-DD',
  'YYYY/MM/DD',
  'DD/MM/YYYY',
  'D/M/YYYY',
  'DD-MM-YYYY',
  'MM/DD/YYYY',
  'YYYY-M-D',
];

/** Formats accepted for the check_in / check_out columns. */
const TIME_FORMATS = ['HH:mm:ss', 'HH:mm', 'H:mm', 'HH.mm', 'H.mm'];

/**
 * Parse a sheet date cell into a UTC-midnight Date.
 * Two-digit Buddhist-era years are not guessed - the sheet must use CE years.
 * Returns null when the cell cannot be understood, so the row can be reported
 * as an error rather than silently importing a wrong date.
 */
export function parseSheetDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;

  for (const format of DATE_FORMATS) {
    const parsed = dayjs.utc(value, format, true);
    if (parsed.isValid()) {
      // Reject Buddhist-era years that would land centuries in the future.
      if (parsed.year() > 2400) {
        const ce = parsed.subtract(543, 'year');
        return ce.startOf('day').toDate();
      }
      return parsed.startOf('day').toDate();
    }
  }

  const loose = dayjs.utc(value);
  return loose.isValid() ? loose.startOf('day').toDate() : null;
}

/**
 * Parse a sheet time cell and attach it to `workDate`.
 * Returns null for blank cells - a blank check-in is a missing punch, not an error.
 */
export function parseSheetTime(workDate: Date, raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value || value === '-' || value.toLowerCase() === 'null') return null;

  const base = dayjs.utc(workDate).startOf('day');

  for (const format of TIME_FORMATS) {
    const parsed = dayjs.utc(value, format, true);
    if (parsed.isValid()) {
      return base.hour(parsed.hour()).minute(parsed.minute()).second(parsed.second()).toDate();
    }
  }
  return null;
}

/** Parse an "HH:mm" setting value into minutes since midnight. */
export function timeStringToMinutes(value: string): number {
  const [h = '0', m = '0'] = value.split(':');
  return Number(h) * 60 + Number(m);
}

/** Minutes since midnight for a Date, read in UTC to match how punches are stored. */
export function minutesSinceMidnight(date: Date): number {
  const d = dayjs.utc(date);
  return d.hour() * 60 + d.minute();
}

export const toUtcDateOnly = (date: Date | string): Date =>
  dayjs.utc(date).startOf('day').toDate();

export const formatDateOnly = (date: Date | string): string =>
  dayjs.utc(date).format('YYYY-MM-DD');

/** Company-local clock without depending on the server's operating-system timezone. */
export function companyClock(now = new Date(), timeZone = 'Asia/Bangkok') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '0';
  const date = `${value('year')}-${value('month')}-${value('day')}`;
  const minutes = Number(value('hour')) * 60 + Number(value('minute'));
  return { date, minutes, timeZone };
}

export const isWeekend = (date: Date): boolean => {
  const day = dayjs.utc(date).day();
  return day === 0 || day === 6;
};

/** Every calendar day in [start, end] inclusive, as UTC-midnight dates. */
export function eachDay(start: Date, end: Date): Date[] {
  const days: Date[] = [];
  let cursor = dayjs.utc(start).startOf('day');
  const last = dayjs.utc(end).startOf('day');
  while (cursor.isBefore(last) || cursor.isSame(last)) {
    days.push(cursor.toDate());
    cursor = cursor.add(1, 'day');
  }
  return days;
}

/** Inclusive month bounds for a payroll period. */
export function monthBounds(year: number, month: number): { startDate: Date; endDate: Date } {
  const start = dayjs.utc(`${year}-${String(month).padStart(2, '0')}-01`);
  return {
    startDate: start.startOf('month').toDate(),
    endDate: start.endOf('month').startOf('day').toDate(),
  };
}

/**
 * Bounds for a payroll cycle that does not align with the calendar month.
 *
 * With startDay 26 and endDay 25, the September 2026 period runs
 * 2026-08-26 → 2026-09-25: the cycle opens on `startDay` of the PREVIOUS month
 * and closes on `endDay` of the period month.
 *
 * startDay 1 with endDay 31 (or 0) degrades to a plain calendar month, so the
 * same function serves both conventions.
 *
 * A day beyond the length of its month is clamped to that month's last day, so
 * "the 31st" behaves sensibly in February.
 */
export function cycleBounds(
  year: number,
  month: number,
  startDay: number,
  endDay: number
): { startDate: Date; endDate: Date } {
  const periodMonth = dayjs.utc(`${year}-${String(month).padStart(2, '0')}-01`);

  const clampToMonth = (base: dayjs.Dayjs, day: number): dayjs.Dayjs => {
    const last = base.daysInMonth();
    // 0 or anything past the end means "last day of this month".
    const target = day <= 0 || day > last ? last : day;
    return base.date(target);
  };

  // startDay 1 means the cycle opens on the first of the period month itself.
  const startBase = startDay <= 1 ? periodMonth : periodMonth.subtract(1, 'month');
  const startDate = clampToMonth(startBase, startDay <= 1 ? 1 : startDay);
  const endDate = clampToMonth(periodMonth, endDay);

  return { startDate: startDate.startOf('day').toDate(), endDate: endDate.startOf('day').toDate() };
}

const THAI_MONTHS = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
];

/** Human label for a payroll period, e.g. "พฤษภาคม 2027". */
export const thaiMonthLabel = (year: number, month: number): string =>
  `${THAI_MONTHS[month - 1] ?? month} ${year}`;

/** Abbreviated Thai months, for axis ticks where the full name will not fit. */
const THAI_MONTHS_SHORT = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
];

export const thaiMonthShortLabel = (year: number, month: number): string =>
  `${THAI_MONTHS_SHORT[month - 1] ?? month} ${year}`;
