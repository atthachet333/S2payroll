import { describe, it, expect } from 'vitest';
import { EmploymentType } from '@prisma/client';
import { computeAttendanceMetrics, evaluateMonthlyAttendance, monthlyRequiredCheckoutMinutes } from '../src/services/attendance.service.js';
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
  it('re-derives a formerly incomplete day as complete after a corrected checkout', () => {
    const before = computeAttendanceMetrics({ ...base, checkIn: at(8, 0), checkOut: null }, settings());
    const after = computeAttendanceMetrics({ ...base, checkIn: at(8, 0), checkOut: at(17, 0) }, settings());
    expect(before.status).toBe('MISSING_DATA');
    expect(after).toMatchObject({ status: 'NORMAL', isMissingCheckIn: false, isMissingCheckOut: false, workedMinutes: 480 });
  });

  it('uses current settings when recalculating an existing pair of effective punches', () => {
    const punches = { ...base, checkIn: at(8, 0), checkOut: at(17, 0) };
    expect(computeAttendanceMetrics(punches, settings({ BREAK_MINUTES: '60' })).workedMinutes).toBe(480);
    expect(computeAttendanceMetrics(punches, settings({ BREAK_MINUTES: '30' })).workedMinutes).toBe(510);
  });

  it('approved leave is neither absent nor missing data when no punch is expected', () => {
    const result = computeAttendanceMetrics({ ...base, isOnLeave: true, checkIn: null, checkOut: null }, settings());
    expect(result).toMatchObject({ status: 'LEAVE', isAbsent: false, isMissingCheckIn: false, isMissingCheckOut: false });
  });
  it('computes a normal 08:00-17:00 day as 8 paid hours', () => {
    const m = computeAttendanceMetrics(
      { ...base, checkIn: at(8, 0), checkOut: at(17, 0) },
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
      { ...base, checkIn: at(8, 29), checkOut: at(17, 29) },
      settings()
    );
    expect(m.lateMinutes).toBe(0);
    expect(m.status).toBe('NORMAL');
  });

  it('counts late minutes from the end of the flex window', () => {
    const m = computeAttendanceMetrics(
      { ...base, checkIn: at(8, 45), checkOut: at(17, 45) },
      settings()
    );
    expect(m.lateMinutes).toBe(15);
    expect(m.status).toBe('LATE');
  });

  it('counts hours beyond the standard day as OT', () => {
    const m = computeAttendanceMetrics(
      { ...base, checkIn: at(8, 0), checkOut: at(19, 0) },
      settings()
    );
    // 11h - 1h break = 600 minutes; 480 normal + 120 OT
    expect(m.normalMinutes).toBe(480);
    expect(m.otMinutes).toBe(120);
    expect(m.status).toBe('OT');
  });

  it('ignores overtime shorter than MIN_OT_MINUTES', () => {
    const m = computeAttendanceMetrics(
      { ...base, checkIn: at(8, 0), checkOut: at(17, 20) },
      settings()
    );
    expect(m.otMinutes).toBe(0);
    expect(m.status).toBe('NORMAL');
  });

  it('records early leave', () => {
    const m = computeAttendanceMetrics(
      { ...base, checkIn: at(8, 20), checkOut: at(17, 0) },
      settings()
    );
    // Required checkout is a fixed 17:30, so leaving at 17:00 is 30 minutes early.
    expect(m.earlyLeaveMinutes).toBe(30);
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
      settings({ MONTHLY_WORK_START_TIME: '10:00' })
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

describe('DAILY attendance policy', () => {
  const daily = (checkIn: Date | null, checkOut: Date | null, overrides: Record<string, string> = {}) =>
    computeAttendanceMetrics(
      { ...base, checkIn, checkOut, employmentType: EmploymentType.DAILY },
      settings(overrides)
    );

  it.each([
    [9, 15, 12, 23, 188],
    [15, 42, 17, 35, 113],
    [8, 30, 14, 36, 366],
  ])('counts %i:%i to %i:%i exactly with no lateness', (ih, im, oh, om, expected) => {
    const result = daily(at(ih, im), at(oh, om));
    expect(result.workedMinutes).toBe(expected);
    expect(result.breakMinutes).toBe(0);
    expect(result.lateMinutes).toBe(0);
    expect(result.earlyLeaveMinutes).toBe(0);
    expect(result.otMinutes).toBe(0);
    expect(result.status).not.toBe('LATE');
  });

  it('never deducts a break from a DAILY attendance record', () => {
    // The record must keep the true observed duration. The daily break is
    // applied once, at payroll time, by the shared payable-time helper -
    // deducting it here as well would remove it twice and would destroy the
    // only place the real worked time is stored. DAILY_DEDUCT_BREAK is
    // withdrawn and no longer read, at either value.
    expect(daily(at(8, 30), at(14, 36), { DAILY_DEDUCT_BREAK: 'false' }).workedMinutes).toBe(366);
    expect(daily(at(8, 30), at(14, 36), { DAILY_DEDUCT_BREAK: 'true' }).workedMinutes).toBe(366);
  });

  it('keeps the full duration even on a shift past eight hours', () => {
    // 08:30 to 17:14 is 524 minutes. Payroll will pay 450 of them; the record
    // still says 524, because that is what happened.
    expect(daily(at(8, 30), at(17, 14)).workedMinutes).toBe(524);
  });

  it('calculates from displayed whole-minute punches even when source events contain seconds', () => {
    const checkIn = new Date(Date.UTC(2027, 4, 12, 9, 15, 52));
    const checkOut = new Date(Date.UTC(2027, 4, 12, 12, 23, 8));
    expect(daily(checkIn, checkOut).workedMinutes).toBe(188);
  });

  it('still requires both punches', () => {
    expect(daily(at(9, 15), null).status).toBe('MISSING_DATA');
    expect(daily(null, at(12, 23)).status).toBe('MISSING_DATA');
  });

  it('does not turn a long DAILY shift or weekend work into OT without an explicit rule', () => {
    expect(daily(at(8, 0), at(19, 0)).otMinutes).toBe(0);
    const weekend = computeAttendanceMetrics(
      { ...base, isWeekend: true, checkIn: at(8, 0), checkOut: at(19, 0), employmentType: EmploymentType.DAILY },
      settings()
    );
    expect(weekend.otMinutes).toBe(0);
    expect(weekend.status).toBe('NORMAL');
  });
});

// The flexible-arrival window was withdrawn in the 2026 policy revision. The
// monthly day is a fixed 08:30-17:30: lateness counts from 08:30 and the
// required checkout no longer shifts with the arrival time.
describe('MONTHLY fixed 08:30-17:30 policy', () => {
  const monthly = (ih: number, im: number, oh: number, om: number) =>
    computeAttendanceMetrics(
      { ...base, checkIn: at(ih, im), checkOut: at(oh, om), employmentType: EmploymentType.MONTHLY },
      settings()
    );

  it.each([
    // arriving early no longer buys an early finish - 17:30 is required
    [7, 45, 17, 30, 0, 0],
    [8, 0, 17, 30, 0, 0],
    [8, 10, 17, 30, 0, 0],
    [8, 20, 17, 30, 0, 0],
    [8, 30, 17, 30, 0, 0],
    [8, 31, 17, 30, 1, 0],
    [8, 46, 17, 30, 16, 0],
    [8, 45, 17, 30, 15, 0],
    [9, 0, 17, 30, 30, 0],
    [9, 55, 17, 30, 85, 0],
    // leaving before 17:30 is early leave regardless of when the day started
    [8, 20, 17, 0, 0, 30],
    [8, 30, 17, 10, 0, 20],
  ])(
    '%i:%i to %i:%i => late %i, early %i',
    (ih, im, oh, om, late, early) => {
      const result = monthly(ih, im, oh, om);
      expect(result.lateMinutes).toBe(late);
      expect(result.earlyLeaveMinutes).toBe(early);
    }
  );

  it('fixes the required checkout at 17:30 whatever time the employee arrived', () => {
    const current = settings();
    expect(monthlyRequiredCheckoutMinutes(7 * 60 + 45, current)).toBe(17 * 60 + 30);
    expect(monthlyRequiredCheckoutMinutes(8 * 60 + 10, current)).toBe(17 * 60 + 30);
    expect(monthlyRequiredCheckoutMinutes(8 * 60 + 30, current)).toBe(17 * 60 + 30);
    expect(monthlyRequiredCheckoutMinutes(9 * 60 + 30, current)).toBe(17 * 60 + 30);
  });

  it('uses one shared monthly evaluator for lateness from 08:30', () => {
    const current = settings();
    expect(evaluateMonthlyAttendance(8 * 60, null, current).lateMinutes).toBe(0);
    expect(evaluateMonthlyAttendance(8 * 60 + 30, null, current).lateMinutes).toBe(0);
    expect(evaluateMonthlyAttendance(8 * 60 + 31, null, current).lateMinutes).toBe(1);
    expect(evaluateMonthlyAttendance(8 * 60 + 46, null, current).lateMinutes).toBe(16);
    expect(evaluateMonthlyAttendance(9 * 60 + 55, null, current).lateMinutes).toBe(85);
  });

  it('does not fabricate MONTHLY OT from normal or extra unapproved time', () => {
    expect(monthly(8, 0, 17, 0).otMinutes).toBe(0);
    expect(monthly(8, 20, 17, 20).otMinutes).toBe(0);
    expect(monthly(8, 30, 18, 0).otMinutes).toBe(0);
    expect(monthly(7, 58, 17, 49).otMinutes).toBe(0);
  });

  it('keeps MONTHLY late, early leave, and OT categories independent', () => {
    const monthlyWithOt = (ih: number, im: number, oh: number, om: number) =>
      computeAttendanceMetrics(
        {
          ...base,
          checkIn: at(ih, im),
          checkOut: at(oh, om),
          employmentType: EmploymentType.MONTHLY,
        },
        settings({ MONTHLY_OT_ENABLED: 'true', MIN_OT_MINUTES: '0' })
      );

    const lateNormal = monthly(8, 46, 17, 46);
    expect(lateNormal.lateMinutes).toBe(16);
    expect(lateNormal.earlyLeaveMinutes).toBe(0);
    expect(lateNormal.otMinutes).toBe(0);

    const lateWithQualifiedOt = monthlyWithOt(8, 46, 18, 30);
    expect(lateWithQualifiedOt.lateMinutes).toBe(16);
    expect(lateWithQualifiedOt.earlyLeaveMinutes).toBe(0);
    expect(lateWithQualifiedOt.otMinutes).toBe(60);

    const earlyArrivalAndLeave = monthlyWithOt(7, 30, 16, 30);
    expect(earlyArrivalAndLeave.lateMinutes).toBe(0);
    // 16:30 against the fixed 17:30 checkout is a full hour early.
    expect(earlyArrivalAndLeave.earlyLeaveMinutes).toBe(60);
    expect(earlyArrivalAndLeave.otMinutes).toBe(0);

    // Arriving before 08:30 is not late, but it no longer shortens the day.
    const earlyArrival = monthly(8, 20, 17, 20);
    expect(earlyArrival.lateMinutes).toBe(0);
    expect(earlyArrival.earlyLeaveMinutes).toBe(10);
    expect(earlyArrival.otMinutes).toBe(0);

    const earlyArrivalEarlyLeave = monthly(8, 20, 17, 0);
    expect(earlyArrivalEarlyLeave.lateMinutes).toBe(0);
    expect(earlyArrivalEarlyLeave.earlyLeaveMinutes).toBe(30);
    expect(earlyArrivalEarlyLeave.otMinutes).toBe(0);
  });

  it('uses changed settings during recalculation', () => {
    const result = computeAttendanceMetrics(
      { ...base, checkIn: at(9, 15), checkOut: at(18, 15), employmentType: EmploymentType.MONTHLY },
      settings({
        MONTHLY_WORK_START_TIME: '09:00',
        MONTHLY_WORK_END_TIME: '18:00',
        MONTHLY_FLEX_ARRIVAL_MINUTES: '20',
      })
    );
    expect(result.lateMinutes).toBe(0);
    expect(result.earlyLeaveMinutes).toBe(0);
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
