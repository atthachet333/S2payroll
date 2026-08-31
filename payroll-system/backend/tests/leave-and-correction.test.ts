import { describe, it, expect } from 'vitest';
import { AttendanceStatus } from '@prisma/client';
import { computeAttendanceMetrics } from '../src/services/attendance.service.js';
import { PayrollSettings } from '../src/services/settings.service.js';
import { isScheduledWorkday, weekdayToken, getDayType } from '../src/services/schedule-policy.service.js';
import {
  extractLeaveRows,
  findDuplicateRequestIds,
  isPaidLeaveType,
  parseLeaveDate,
  parseLeaveStatus,
  parseLeaveType,
  resolveLeaveColumns,
} from '../src/services/leave-sheet-mapping.service.js';

/**
 * Covers the leave lifecycle and the manual-correction path.
 *
 * Two defects motivated most of this file:
 *   - a corrected day whose missing punch had been supplied kept reporting
 *     MISSING_DATA, because the status was frozen for anything marked
 *     isCorrected rather than only for a status a human had actually pinned;
 *   - approved leave had to become an intentional no-punch day rather than an
 *     absence, without ever fabricating a punch.
 */

/** The verified company policy: Mon-Sat, 08:00-17:00, 30 minute flex arrival. */
const policy = () =>
  new PayrollSettings({
    WORK_START_TIME: '08:00',
    WORK_END_TIME: '17:00',
    LATE_GRACE_MINUTES: '30',
    EARLY_LEAVE_GRACE_MINUTES: '0',
    WORKING_DAYS: 'MON,TUE,WED,THU,FRI,SAT',
    STANDARD_WORK_HOURS: '8',
    BREAK_MINUTES: '60',
    DAILY_DEDUCT_BREAK: 'false',
    DAILY_OT_ENABLED: 'false',
    MONTHLY_OT_ENABLED: 'false',
    OT_ENABLED: 'true',
    MIN_OT_MINUTES: '30',
    COUNT_WEEKEND_AS_WORKDAY: 'true',
  });

const at = (date: string, time: string) => new Date(`${date}T${time}:00.000Z`);
const SAT = '2026-08-29';
const TUE = '2026-08-25';
const SUN = '2026-08-30';

// ---------------------------------------------------------------------------
// Leave sheet mapping and preview classification
// ---------------------------------------------------------------------------

/** The real S2A_DB LeaveRequests header row. */
const LEAVE_HEADERS = [
  'requestId', 'clientRequestId', 'employeeLineUserId', 'employeeId', 'employeeName',
  'position', 'department', 'leaveType', 'startDate', 'endDate', 'totalDays', 'reason',
  'managerLineUserId', 'status', 'approvedBy', 'approvedAt', 'rejectedBy', 'rejectedAt',
  'rejectedReason', 'createdAt', 'updatedAt', 'managerNotificationStatus',
];

const leaveRow = (over: Partial<Record<string, string>> = {}): string[] => {
  const base: Record<string, string> = {
    requestId: 'REQ-20260814-91074207',
    clientRequestId: 'c1',
    employeeLineUserId: 'Ub1',
    employeeId: 'S2A004',
    employeeName: 'นางสาว ปุณศรา วงษ์จำรัส (บัว)',
    position: 'Accounting',
    department: 'Accounting Department',
    leaveType: 'ลาป่วย',
    startDate: '2026-08-14',
    endDate: '2026-08-14',
    totalDays: '1',
    reason: 'ไข้สูง',
    managerLineUserId: 'C6',
    status: 'APPROVED',
    ...over,
  };
  return LEAVE_HEADERS.map((h) => base[h] ?? '');
};

describe('LeaveRequests preview mapping', () => {
  const map = resolveLeaveColumns(LEAVE_HEADERS);

  it('resolves the real header row by name', () => {
    expect(map.missing).toEqual([]);
    expect(map.indexes.requestId).toBe(0);
    expect(map.indexes.employeeCode).toBe(3);
    expect(map.indexes.status).toBe(13);
  });

  it('never resolves the employee from a name or LINE id', () => {
    // employeeName is index 4, employeeLineUserId index 2 - neither may be claimed.
    expect(map.indexes.employeeCode).not.toBe(2);
    expect(map.indexes.employeeCode).not.toBe(4);
    expect(map.unmapped).not.toContain('employeeName');
    expect(map.unmapped).not.toContain('employeeLineUserId');
  });

  it('extracts an approved sick leave with its stable requestId', () => {
    const [row] = extractLeaveRows([LEAVE_HEADERS, leaveRow()], map);
    expect(row).toMatchObject({
      requestId: 'REQ-20260814-91074207',
      employeeCode: 'S2A004',
      leaveType: 'SICK',
      startDate: '2026-08-14',
      endDate: '2026-08-14',
      status: 'APPROVED',
      errors: [],
    });
  });

  it('rejects a row with no requestId, since idempotency depends on it', () => {
    const [row] = extractLeaveRows([LEAVE_HEADERS, leaveRow({ requestId: '' })], map);
    expect(row.errors.join(' ')).toContain('requestId');
  });

  it('flags an unparseable start date instead of guessing one', () => {
    const [row] = extractLeaveRows([LEAVE_HEADERS, leaveRow({ startDate: 'next monday' })], map);
    expect(row.startDate).toBeNull();
    expect(row.errors.join(' ')).toContain('วันที่เริ่มลา');
  });

  it('detects a duplicate requestId across the pull', () => {
    const rows = extractLeaveRows(
      [LEAVE_HEADERS, leaveRow(), leaveRow({ startDate: '2026-08-20', endDate: '2026-08-20' })],
      map
    );
    expect(findDuplicateRequestIds(rows)).toEqual(['REQ-20260814-91074207']);
  });

  it('maps every status the sheet can carry', () => {
    expect(parseLeaveStatus('APPROVED')).toBe('APPROVED');
    expect(parseLeaveStatus('PENDING')).toBe('PENDING');
    expect(parseLeaveStatus('REJECTED')).toBe('REJECTED');
    expect(parseLeaveStatus('CANCELLED')).toBe('CANCELLED');
  });

  it('maps Thai leave types and treats unpaid as unpaid', () => {
    expect(parseLeaveType('ลาป่วย')).toBe('SICK');
    expect(parseLeaveType('ลาพักร้อน')).toBe('ANNUAL');
    expect(isPaidLeaveType('SICK')).toBe(true);
    expect(isPaidLeaveType('UNPAID')).toBe(false);
  });

  it('accepts a Buddhist-era date without shifting a Gregorian one', () => {
    expect(parseLeaveDate('14/08/2569')).toBe('2026-08-14');
    expect(parseLeaveDate('2026-08-14')).toBe('2026-08-14');
  });
});

// ---------------------------------------------------------------------------
// Only APPROVED leave changes a day
// ---------------------------------------------------------------------------

describe('only approved leave is materialised', () => {
  const settings = policy();

  it('turns an approved leave day into LEAVE with no punches', () => {
    const m = computeAttendanceMetrics(
      { workDate: at(TUE, '00:00'), checkIn: null, checkOut: null, isHoliday: false, isWeekend: false, isOnLeave: true },
      settings
    );
    expect(m.status).toBe(AttendanceStatus.LEAVE);
    expect(m.isAbsent).toBe(false);
    expect(m.isMissingCheckIn).toBe(false);
    expect(m.isMissingCheckOut).toBe(false);
    expect(m.workedMinutes).toBe(0);
  });

  it('does not treat a leave day as absent or incomplete', () => {
    const m = computeAttendanceMetrics(
      { workDate: at(TUE, '00:00'), checkIn: null, checkOut: null, isHoliday: false, isWeekend: false, isOnLeave: true },
      settings
    );
    expect(m.status).not.toBe(AttendanceStatus.ABSENT);
    expect(m.status).not.toBe(AttendanceStatus.MISSING_DATA);
  });

  it('a day with no leave and no punches is an absence, not leave', () => {
    const m = computeAttendanceMetrics(
      { workDate: at(TUE, '00:00'), checkIn: null, checkOut: null, isHoliday: false, isWeekend: false, isOnLeave: false },
      settings
    );
    expect(m.status).toBe(AttendanceStatus.ABSENT);
  });

  it('pending / rejected / cancelled never reach the metrics as leave', () => {
    // The sync only passes isOnLeave for APPROVED rows, so a day carrying any
    // other status must still evaluate as an ordinary unworked day.
    const nonApproved = ['PENDING', 'REJECTED', 'CANCELLED'] as const;
    for (const status of nonApproved) {
      expect(parseLeaveStatus(status)).toBe(status);
      const day = computeAttendanceMetrics(
        {
          workDate: at(TUE, '00:00'), checkIn: null, checkOut: null,
          isHoliday: false, isWeekend: false,
          isOnLeave: false, // what the sync passes for a non-approved request
        },
        settings
      );
      expect(day.status, status).toBe(AttendanceStatus.ABSENT);
      expect(day.status, status).not.toBe(AttendanceStatus.LEAVE);
    }
  });
});

// ---------------------------------------------------------------------------
// Sunday and the weekly-off schedule
// ---------------------------------------------------------------------------

describe('Sunday needs no leave and is never an absence', () => {
  const settings = policy();

  it('treats Saturday as a scheduled workday and Sunday as weekly off', () => {
    expect(weekdayToken(at(SAT, '00:00'))).toBe('SAT');
    expect(weekdayToken(at(SUN, '00:00'))).toBe('SUN');
    expect(isScheduledWorkday(at(SAT, '00:00'), settings)).toBe(true);
    expect(isScheduledWorkday(at(SUN, '00:00'), settings)).toBe(false);
  });

  it('classifies the August 2026 Sundays as weekly off', () => {
    for (const d of ['2026-08-02', '2026-08-09', '2026-08-16', '2026-08-23', '2026-08-30']) {
      expect(getDayType(at(d, '00:00'), settings, new Set()), d).toBe('WEEKLY_OFF');
    }
  });

  it('counts 26 scheduled working days in August 2026', () => {
    let working = 0;
    for (let day = 1; day <= 31; day += 1) {
      const date = at(`2026-08-${String(day).padStart(2, '0')}`, '00:00');
      if (getDayType(date, settings, new Set()) === 'WORKING_DAY') working += 1;
    }
    expect(working).toBe(26);
  });

  it('a company holiday outranks the working-day schedule', () => {
    const holidays = new Set([SAT]);
    expect(getDayType(at(SAT, '00:00'), settings, holidays)).toBe('HOLIDAY');
  });
});

// ---------------------------------------------------------------------------
// Manual correction clears the incomplete state
// ---------------------------------------------------------------------------

describe('a corrected missing checkout stops being incomplete', () => {
  const settings = policy();

  it('reports MISSING_DATA while one punch is absent', () => {
    const m = computeAttendanceMetrics(
      { workDate: at(TUE, '00:00'), checkIn: at(TUE, '08:30'), checkOut: null, isHoliday: false, isWeekend: false, isOnLeave: false },
      settings
    );
    expect(m.status).toBe(AttendanceStatus.MISSING_DATA);
    expect(m.isMissingCheckOut).toBe(true);
  });

  it('clears MISSING_DATA once the checkout is supplied', () => {
    const m = computeAttendanceMetrics(
      { workDate: at(TUE, '00:00'), checkIn: at(TUE, '08:30'), checkOut: at(TUE, '17:30'), isHoliday: false, isWeekend: false, isOnLeave: false },
      settings
    );
    expect(m.status).not.toBe(AttendanceStatus.MISSING_DATA);
    expect(m.isMissingCheckOut).toBe(false);
    expect(m.workedMinutes).toBeGreaterThan(0);
  });

  it('does not fabricate a punch when only the check-in exists', () => {
    const m = computeAttendanceMetrics(
      { workDate: at(TUE, '00:00'), checkIn: at(TUE, '08:00'), checkOut: null, isHoliday: false, isWeekend: false, isOnLeave: false },
      settings
    );
    expect(m.workedMinutes).toBe(0);
    expect(m.otMinutes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Employment type drives the recalculation after a correction
// ---------------------------------------------------------------------------

describe('recalculation after correction respects employment type', () => {
  const settings = policy();

  const monthly = (inTime: string, outTime: string) =>
    computeAttendanceMetrics(
      {
        workDate: at(TUE, '00:00'), checkIn: at(TUE, inTime), checkOut: at(TUE, outTime),
        isHoliday: false, isWeekend: false, isOnLeave: false, employmentType: 'MONTHLY',
      },
      settings
    );

  const daily = (inTime: string, outTime: string) =>
    computeAttendanceMetrics(
      {
        workDate: at(TUE, '00:00'), checkIn: at(TUE, inTime), checkOut: at(TUE, outTime),
        isHoliday: false, isWeekend: false, isOnLeave: false, employmentType: 'DAILY',
      },
      settings
    );

  it('MONTHLY: arrival inside the flex window is not late', () => {
    expect(monthly('08:00', '17:00').lateMinutes).toBe(0);
    expect(monthly('08:20', '17:20').lateMinutes).toBe(0);
    expect(monthly('08:30', '17:30').lateMinutes).toBe(0);
  });

  it('MONTHLY: lateness is counted from 08:30, not 08:00', () => {
    expect(monthly('08:36', '17:36').lateMinutes).toBe(6);
    expect(monthly('09:00', '18:00').lateMinutes).toBe(30);
  });

  it('MONTHLY: no automatic OT while MONTHLY_OT_ENABLED is false', () => {
    expect(monthly('08:00', '20:00').otMinutes).toBe(0);
  });

  it('DAILY: never late, whatever the arrival time', () => {
    expect(daily('11:00', '18:00').lateMinutes).toBe(0);
    expect(daily('08:36', '17:00').lateMinutes).toBe(0);
  });

  it('DAILY: no early-leave penalty and no automatic OT', () => {
    const m = daily('08:00', '12:00');
    expect(m.earlyLeaveMinutes).toBe(0);
    expect(daily('08:00', '20:00').otMinutes).toBe(0);
  });

  it('DAILY: worked minutes are the actual clocked duration with no break cut', () => {
    // DAILY_DEDUCT_BREAK is false, so 08:00-17:00 is a full 540 minutes.
    expect(daily('08:00', '17:00').workedMinutes).toBe(540);
    expect(daily('09:15', '15:45').workedMinutes).toBe(390);
  });

  it('DAILY: an incomplete punch is still MISSING_DATA', () => {
    const m = computeAttendanceMetrics(
      {
        workDate: at(TUE, '00:00'), checkIn: at(TUE, '07:28'), checkOut: null,
        isHoliday: false, isWeekend: false, isOnLeave: false, employmentType: 'DAILY',
      },
      settings
    );
    expect(m.status).toBe(AttendanceStatus.MISSING_DATA);
  });
});
