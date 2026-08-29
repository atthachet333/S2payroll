import { describe, it, expect } from 'vitest';
import { computeAttendanceMetrics } from '../src/services/attendance.service.js';
import { PayrollSettings } from '../src/services/settings.service.js';
import { DEFAULT_SETTINGS_MAP } from '../src/config/payroll-defaults.js';
import { parseSheetDate, parseSheetTime } from '../src/utils/datetime.js';

const settings = (overrides: Record<string, string> = {}) =>
  new PayrollSettings({ ...DEFAULT_SETTINGS_MAP, ...overrides });

// A Wednesday.
const WORK_DATE = new Date(Date.UTC(2027, 4, 12));
const at = (h: number, m: number) => new Date(Date.UTC(2027, 4, 12, h, m));

const base = {
  workDate: WORK_DATE,
  isHoliday: false,
  isWeekend: false,
  isOnLeave: false,
};

describe('computeAttendanceMetrics', () => {
  it('computes a normal 09:00-18:00 day as 8 paid hours', () => {
    const m = computeAttendanceMetrics(
      { ...base, checkIn: at(9, 0), checkOut: at(18, 0) },
      settings()
    );
    // 9 hours elapsed minus a 60 minute break = 480 minutes
    expect(m.workedMinutes).toBe(480);
    expect(m.normalMinutes).toBe(480);
    expect(m.otMinutes).toBe(0);
    expect(m.lateMinutes).toBe(0);
    expect(m.status).toBe('NORMAL');
  });

  it('does not count arrival inside the grace period as late', () => {
    const m = computeAttendanceMetrics(
      { ...base, checkIn: at(9, 14), checkOut: at(18, 0) },
      settings()
    );
    expect(m.lateMinutes).toBe(0);
    expect(m.status).toBe('NORMAL');
  });

  it('counts late minutes from the shift start once grace is exceeded', () => {
    const m = computeAttendanceMetrics(
      { ...base, checkIn: at(9, 30), checkOut: at(18, 0) },
      settings()
    );
    // Past the 15 minute grace, so the full 30 minutes count.
    expect(m.lateMinutes).toBe(30);
    expect(m.status).toBe('LATE');
  });

  it('counts hours beyond the standard day as OT', () => {
    const m = computeAttendanceMetrics(
      { ...base, checkIn: at(9, 0), checkOut: at(20, 0) },
      settings()
    );
    // 11h - 1h break = 600 minutes; 480 normal + 120 OT
    expect(m.normalMinutes).toBe(480);
    expect(m.otMinutes).toBe(120);
    expect(m.status).toBe('OT');
  });

  it('ignores overtime shorter than MIN_OT_MINUTES', () => {
    const m = computeAttendanceMetrics(
      { ...base, checkIn: at(9, 0), checkOut: at(18, 20) },
      settings()
    );
    expect(m.otMinutes).toBe(0);
    expect(m.status).toBe('NORMAL');
  });

  it('records early leave', () => {
    const m = computeAttendanceMetrics(
      { ...base, checkIn: at(9, 0), checkOut: at(16, 0) },
      settings()
    );
    expect(m.earlyLeaveMinutes).toBe(120);
  });

  it('treats a whole holiday shift as overtime', () => {
    const m = computeAttendanceMetrics(
      { ...base, isHoliday: true, checkIn: at(9, 0), checkOut: at(13, 0) },
      settings()
    );
    // 4h - 1h break = 180 minutes, all OT
    expect(m.normalMinutes).toBe(0);
    expect(m.otMinutes).toBe(180);
  });

  it('treats a whole weekend shift as overtime', () => {
    const m = computeAttendanceMetrics(
      { ...base, isWeekend: true, checkIn: at(9, 0), checkOut: at(14, 0) },
      settings()
    );
    expect(m.otMinutes).toBe(240);
    expect(m.normalMinutes).toBe(0);
  });

  it('flags a missing check-out as MISSING_DATA rather than absent', () => {
    const m = computeAttendanceMetrics({ ...base, checkIn: at(9, 0), checkOut: null }, settings());
    expect(m.status).toBe('MISSING_DATA');
    expect(m.isMissingCheckOut).toBe(true);
    expect(m.isAbsent).toBe(false);
    expect(m.workedMinutes).toBe(0);
  });

  it('flags a missing check-in as MISSING_DATA', () => {
    const m = computeAttendanceMetrics({ ...base, checkIn: null, checkOut: at(18, 0) }, settings());
    expect(m.status).toBe('MISSING_DATA');
    expect(m.isMissingCheckIn).toBe(true);
  });

  it('marks a weekday with no punches at all as absent', () => {
    const m = computeAttendanceMetrics({ ...base, checkIn: null, checkOut: null }, settings());
    expect(m.status).toBe('ABSENT');
    expect(m.isAbsent).toBe(true);
  });

  it('does not double-report an absence as missing punch data', () => {
    // An absence is a known state. If it also set the missing-punch flags, the
    // payroll review screen would show every absent day as a data problem.
    const m = computeAttendanceMetrics({ ...base, checkIn: null, checkOut: null }, settings());
    expect(m.isAbsent).toBe(true);
    expect(m.isMissingCheckIn).toBe(false);
    expect(m.isMissingCheckOut).toBe(false);
  });

  it('reports exactly one missing-punch flag for a genuinely incomplete day', () => {
    const noOut = computeAttendanceMetrics({ ...base, checkIn: at(9, 0), checkOut: null }, settings());
    expect(noOut.isMissingCheckIn).toBe(false);
    expect(noOut.isMissingCheckOut).toBe(true);

    const noIn = computeAttendanceMetrics({ ...base, checkIn: null, checkOut: at(18, 0) }, settings());
    expect(noIn.isMissingCheckIn).toBe(true);
    expect(noIn.isMissingCheckOut).toBe(false);
  });

  it('does not mark an empty weekend as absent', () => {
    const m = computeAttendanceMetrics(
      { ...base, isWeekend: true, checkIn: null, checkOut: null },
      settings()
    );
    expect(m.isAbsent).toBe(false);
    expect(m.status).toBe('NORMAL');
  });

  it('does not mark an empty public holiday as absent', () => {
    const m = computeAttendanceMetrics(
      { ...base, isHoliday: true, checkIn: null, checkOut: null },
      settings()
    );
    expect(m.status).toBe('HOLIDAY');
    expect(m.isAbsent).toBe(false);
  });

  it('marks an approved leave day as LEAVE and expects no punches', () => {
    const m = computeAttendanceMetrics(
      { ...base, isOnLeave: true, checkIn: null, checkOut: null },
      settings()
    );
    expect(m.status).toBe('LEAVE');
    expect(m.isAbsent).toBe(false);
    expect(m.isMissingCheckIn).toBe(false);
  });

  it('handles an overnight shift by rolling the check-out to the next day', () => {
    const m = computeAttendanceMetrics(
      { ...base, checkIn: at(22, 0), checkOut: new Date(Date.UTC(2027, 4, 13, 6, 0)) },
      settings()
    );
    // 8h elapsed - 1h break = 420 minutes
    expect(m.workedMinutes).toBe(420);
    expect(m.earlyLeaveMinutes).toBe(0);
  });

  it('does not subtract a break from a shift shorter than the break', () => {
    const m = computeAttendanceMetrics(
      { ...base, checkIn: at(9, 0), checkOut: at(9, 30) },
      settings()
    );
    expect(m.workedMinutes).toBe(30);
    expect(m.breakMinutes).toBe(0);
  });

  it('honours a changed shift start time from settings', () => {
    const m = computeAttendanceMetrics(
      { ...base, checkIn: at(9, 30), checkOut: at(18, 0) },
      settings({ WORK_START_TIME: '10:00' })
    );
    expect(m.lateMinutes).toBe(0);
  });

  it('suppresses OT entirely when OT is disabled in settings', () => {
    const m = computeAttendanceMetrics(
      { ...base, checkIn: at(9, 0), checkOut: at(21, 0) },
      settings({ OT_ENABLED: 'false' })
    );
    expect(m.otMinutes).toBe(0);
  });
});

describe('sheet value parsing', () => {
  it('accepts the common date formats', () => {
    for (const value of ['2027-05-12', '2027/05/12', '12/05/2027', '12-05-2027']) {
      expect(parseSheetDate(value)?.toISOString().slice(0, 10)).toBe('2027-05-12');
    }
  });

  it('converts a Buddhist-era year to CE', () => {
    expect(parseSheetDate('2570-05-12')?.toISOString().slice(0, 10)).toBe('2027-05-12');
  });

  it('returns null for an unparseable date so the row is reported as an error', () => {
    expect(parseSheetDate('not a date')).toBeNull();
    expect(parseSheetDate('')).toBeNull();
    expect(parseSheetDate(null)).toBeNull();
  });

  it('attaches a time cell to the work date', () => {
    const parsed = parseSheetTime(WORK_DATE, '08:45');
    expect(parsed?.toISOString()).toBe('2027-05-12T08:45:00.000Z');
  });

  it('accepts seconds and dot-separated times', () => {
    expect(parseSheetTime(WORK_DATE, '08:45:30')?.toISOString()).toBe('2027-05-12T08:45:30.000Z');
    expect(parseSheetTime(WORK_DATE, '8.45')?.toISOString()).toBe('2027-05-12T08:45:00.000Z');
  });

  it('treats blank and placeholder time cells as a missing punch', () => {
    expect(parseSheetTime(WORK_DATE, '')).toBeNull();
    expect(parseSheetTime(WORK_DATE, '-')).toBeNull();
    expect(parseSheetTime(WORK_DATE, null)).toBeNull();
  });
});
