import { describe, it, expect } from 'vitest';
import { AttendanceStatus, EmploymentType, PayrollItemKind } from '@prisma/client';
import {
  computeAttendanceMetrics,
  evaluateMonthlyAttendance,
  monthlyRequiredCheckoutMinutes,
  monthlyStartMinutes,
  monthlyEndMinutes,
} from '../src/services/attendance.service.js';
import { lateDeductionHours } from '../src/utils/attendance-math.js';
import { chargeableLateHours } from '../src/utils/time-rounding.js';
import { calculatePayroll, dailyRate, hourlyRate } from '../src/services/payroll-calculator.service.js';
import { PayrollSettings } from '../src/services/settings.service.js';
import { dec } from '../src/utils/money.js';

/**
 * The 2026 company policy revision.
 *
 *   monthly day      08:30 - 17:30, fixed
 *   lateness         max(0, checkIn - 08:30), no flexible-arrival window
 *   required out     always 17:30 - a late arrival does not push it later, and
 *                    staying later does not cancel the lateness
 *   late charging    floor the observed minutes to the company interval, then
 *                    ceil what remains to whole hours. 10 minutes rounds to 0
 *                    and costs nothing; 16 rounds to 15 and costs one hour.
 *   salary to day    salary / 30
 *   day to hour      dayRate / 8
 */

const settings = () =>
  new PayrollSettings({
    MONTHLY_WORK_START_TIME: '08:30',
    MONTHLY_WORK_END_TIME: '17:30',
    MONTHLY_FLEX_ARRIVAL_MINUTES: '0',
    WORK_START_TIME: '08:30',
    WORK_END_TIME: '17:30',
    LATE_GRACE_MINUTES: '0',
    EARLY_LEAVE_GRACE_MINUTES: '0',
    WORKING_DAYS: 'MON,TUE,WED,THU,FRI,SAT',
    BREAK_MINUTES: '60',
    STANDARD_WORK_HOURS: '8',
    STANDARD_WORK_DAYS: '22',
    MONTHLY_SALARY_DAY_DIVISOR: '30',
    STANDARD_PAID_HOURS_PER_DAY: '8',
    LATE_DEDUCTION_ROUND_UP_HOURS: 'true',
    LATE_DEDUCTION_MODE: 'PER_MINUTE',
    LATE_DEDUCTION_USE_HOURLY_RATE: 'true',
    ABSENCE_DEDUCTION_MODE: 'DAILY_RATE',
    DAILY_DEDUCT_BREAK: 'false',
    DAILY_OT_ENABLED: 'false',
    MONTHLY_OT_ENABLED: 'false',
    OT_ENABLED: 'true',
    OT_REQUIRES_APPROVAL: 'true',
    MIN_OT_MINUTES: '30',
    SSO_ENABLED: 'false',
    TAX_ENABLED: 'false',
    COUNT_WEEKEND_AS_WORKDAY: 'true',
  });

const TUE = '2026-08-25';
const at = (time: string) => new Date(`${TUE}T${time}:00.000Z`);

const monthlyDay = (inTime: string, outTime: string) =>
  computeAttendanceMetrics(
    {
      workDate: at('00:00'),
      checkIn: at(inTime),
      checkOut: at(outTime),
      isHoliday: false,
      isWeekend: false,
      isOnLeave: false,
      employmentType: EmploymentType.MONTHLY,
    },
    settings()
  );

// ---------------------------------------------------------------------------
// Section 2 / 26 - monthly lateness from a fixed 08:30
// ---------------------------------------------------------------------------

describe('monthly lateness is measured from 08:30 with no grace', () => {
  it('resolves the policy window from the MONTHLY_* keys', () => {
    expect(monthlyStartMinutes(settings())).toBe(8 * 60 + 30);
    expect(monthlyEndMinutes(settings())).toBe(17 * 60 + 30);
  });

  it.each([
    ['08:00', 0],
    ['08:25', 0],
    ['08:29', 0],
    ['08:30', 0],
    ['08:31', 1],
    ['08:40', 10],
    ['09:00', 30],
    ['09:30', 60],
    ['09:31', 61],
  ])('check-in %s produces %i late minutes', (arrival, expected) => {
    expect(monthlyDay(arrival, '18:00').lateMinutes).toBe(expected);
  });

  it('exposes 08:30 as the latest allowed check-in', () => {
    const evaluated = evaluateMonthlyAttendance(8 * 60 + 30, 17 * 60 + 30, settings());
    expect(evaluated.latestAllowedCheckIn).toBe(8 * 60 + 30);
    expect(evaluated.lateMinutes).toBe(0);
  });
});

describe('required checkout is fixed at 17:30', () => {
  it('does not move with the arrival time', () => {
    for (const arrival of ['08:00', '08:30', '08:40', '09:31', '11:00']) {
      const [h, m] = arrival.split(':').map(Number);
      expect(monthlyRequiredCheckoutMinutes(h * 60 + m, settings()), arrival).toBe(17 * 60 + 30);
    }
  });

  it('a late arrival is still late even when the employee stays past 17:30', () => {
    const day = monthlyDay('08:40', '19:00');
    expect(day.lateMinutes).toBe(10);
    expect(day.earlyLeaveMinutes).toBe(0);
  });

  it('an early arrival does not permit an early checkout', () => {
    // Arriving 08:00 no longer buys a 17:00 finish.
    const day = monthlyDay('08:00', '17:00');
    expect(day.lateMinutes).toBe(0);
    expect(day.earlyLeaveMinutes).toBe(30);
  });

  it('leaving exactly at 17:30 is neither late nor early', () => {
    const day = monthlyDay('08:30', '17:30');
    expect(day.lateMinutes).toBe(0);
    expect(day.earlyLeaveMinutes).toBe(0);
  });

  it('produces no automatic OT while MONTHLY_OT_ENABLED is false', () => {
    expect(monthlyDay('08:30', '21:00').otMinutes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 7 - lateness charged in whole-hour blocks
// ---------------------------------------------------------------------------

describe('late deduction hours are whole-hour blocks', () => {
  it.each([
    [0, 0],
    [1, 1],
    [10, 1],
    [40, 1],
    [60, 1],
    [61, 2],
    [120, 2],
    [121, 3],
  ])('%i late minutes charge %i hour(s)', (minutes, expectedHours) => {
    expect(lateDeductionHours(minutes)).toBe(expectedHours);
  });

  it('never charges for zero or negative lateness', () => {
    expect(lateDeductionHours(0)).toBe(0);
    expect(lateDeductionHours(-5)).toBe(0);
  });

  it('keeps observed minutes, rounded minutes and charged hours separate', () => {
    // The record stores 10 observed minutes for ever. The company interval
    // floors that to 0, so no hour block is charged - all three facts stay
    // visible rather than collapsing into one.
    const day = monthlyDay('08:40', '17:30');
    expect(day.lateMinutes).toBe(10);
    expect(chargeableLateHours(day.lateMinutes, 15)).toBe(0);
    // The second stage on its own is unchanged; it is the input that is floored.
    expect(lateDeductionHours(15)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Section 3 - DAILY employees stay schedule-independent
// ---------------------------------------------------------------------------

describe('DAILY employees are not held to the monthly schedule', () => {
  const daily = (inTime: string, outTime: string) =>
    computeAttendanceMetrics(
      {
        workDate: at('00:00'),
        checkIn: at(inTime),
        checkOut: at(outTime),
        isHoliday: false,
        isWeekend: false,
        isOnLeave: false,
        employmentType: EmploymentType.DAILY,
      },
      settings()
    );

  it('is never late, whatever the arrival', () => {
    expect(daily('11:00', '18:00').lateMinutes).toBe(0);
    expect(daily('09:31', '17:00').lateMinutes).toBe(0);
  });

  it('has no early-leave evaluation', () => {
    expect(daily('08:00', '12:00').earlyLeaveMinutes).toBe(0);
  });

  it('counts the actual clocked duration with no break cut', () => {
    expect(daily('08:00', '17:00').workedMinutes).toBe(540);
    expect(daily('09:15', '15:45').workedMinutes).toBe(390);
  });

  it('produces no automatic OT', () => {
    expect(daily('08:00', '21:00').otMinutes).toBe(0);
  });

  it('still reports an incomplete punch as MISSING_DATA', () => {
    const day = computeAttendanceMetrics(
      {
        workDate: at('00:00'), checkIn: at('07:28'), checkOut: null,
        isHoliday: false, isWeekend: false, isOnLeave: false,
        employmentType: EmploymentType.DAILY,
      },
      settings()
    );
    expect(day.status).toBe(AttendanceStatus.MISSING_DATA);
  });
});

// ---------------------------------------------------------------------------
// Sections 8 / 9 - salary divisors
// ---------------------------------------------------------------------------

const monthlyEmployee = (baseSalary: number) => ({
  employeeId: 'e1',
  employeeCode: 'S2A004',
  employeeName: 'ทดสอบ ระบบ',
  departmentName: null,
  positionName: null,
  employmentType: EmploymentType.MONTHLY,
  baseSalary,
  ssoEnabled: false,
  taxEnabled: false,
  otEligible: true,
  attendanceRequired: true,
});

describe('monthly salary converts to a day and an hour by fixed divisors', () => {
  it('18,000 / 30 = 600 per day', () => {
    expect(dailyRate(monthlyEmployee(18000), settings()).toString()).toBe('600');
  });

  it('600 / 8 = 75 per hour', () => {
    expect(hourlyRate(monthlyEmployee(18000), settings()).toString()).toBe('75');
  });

  it('does not use the number of scheduled working days', () => {
    // STANDARD_WORK_DAYS is 22 in the settings above; 18000/22 would be 818.18.
    expect(dailyRate(monthlyEmployee(18000), settings()).toString()).not.toBe('818.18');
  });
});

// ---------------------------------------------------------------------------
// Section 28 - the worked payroll example
// ---------------------------------------------------------------------------

const emptyAttendance = {
  workingDays: 26,
  presentDays: 25,
  absentDays: 0,
  leaveDays: 0,
  unpaidLeaveDays: 0,
  lateCount: 0,
  lateMinutes: 0,
  roundedLateMinutes: 0,
  earlyLeaveMinutes: 0,
  roundedEarlyLeaveMinutes: 0,
  actualOtMinutes: 0,
  workedMinutes: 0,
  normalMinutes: 0,
  otWeekdayMinutes: 0,
  otWeekendMinutes: 0,
  otHolidayMinutes: 0,
  missingDataDays: 0,
  missingCheckInDays: 0,
  missingCheckOutDays: 0,
};

describe('payroll example: 18,000 with one absence and 10 minutes late', () => {
  const result = calculatePayroll(
    {
      employee: monthlyEmployee(18000),
      attendance: { ...emptyAttendance, absentDays: 1, lateCount: 1, lateMinutes: 10, roundedLateMinutes: 0 },
      manualIncomes: [
        { kind: PayrollItemKind.BONUS, label: 'โบนัส', amount: 1000 },
      ],
      manualDeductions: [
        { kind: PayrollItemKind.SOCIAL_SECURITY, label: 'ประกันสังคม', amount: 750 },
        { kind: PayrollItemKind.TAX, label: 'ภาษีหัก ณ ที่จ่าย', amount: 100 },
      ],
    },
    settings()
  );

  it('deducts 600 for the absent day', () => {
    expect(result.absenceDeduction.toString()).toBe('600');
  });

  it('charges nothing for 10 minutes of lateness', () => {
    // The company-wide 15-minute floor forgives anything under one interval:
    // 10 observed minutes round down to 0, so no hour block is charged. This
    // supersedes the earlier rule, which billed a full hour here.
    expect(result.lateDeductionHours).toBe(0);
    expect(result.lateDeduction.toString()).toBe('0');
  });

  it('grosses 19,000 with the bonus itemised separately from base salary', () => {
    expect(result.baseSalary.toString()).toBe('18000');
    expect(result.bonusAmount.toString()).toBe('1000');
    expect(result.grossIncome.toString()).toBe('19000');
  });

  it('totals 1,450 of deductions', () => {
    // 600 absence + 0 late + 750 SSO + 100 tax.
    expect(result.totalDeduction.toString()).toBe('1450');
  });

  it('nets 17,550', () => {
    expect(result.netSalary.toString()).toBe('17550');
  });

  it('keeps every deduction itemised rather than merged', () => {
    const labels = result.deductions.map((d) => d.label);
    expect(labels).toContain('ประกันสังคม');
    expect(labels).toContain('ภาษีหัก ณ ที่จ่าย');
    expect(result.deductions.length).toBeGreaterThanOrEqual(4);
  });
});

describe('late deduction scales by whole-hour block, not by minute', () => {
  // The company floors lateness to the rounding interval before charging it,
  // so the aggregate carries both the observed and the floored value.
  const run = (lateMinutes: number) =>
    calculatePayroll(
      {
        employee: monthlyEmployee(18000),
        attendance: {
          ...emptyAttendance,
          lateCount: 1,
          lateMinutes,
          roundedLateMinutes: Math.floor(lateMinutes / 15) * 15,
        },
      },
      settings()
    );

  it('10 minutes late is forgiven by the 15-minute floor', () => {
    const r = run(10);
    expect(r.lateDeductionHours).toBe(0);
    expect(r.lateDeduction.toString()).toBe('0');
  });

  it('16 minutes late reaches the first hour block', () => {
    // floor 15 -> ceil to 1 hour.
    const r = run(16);
    expect(r.lateDeductionHours).toBe(1);
    expect(r.lateDeduction.toString()).toBe('75');
  });

  it('59 minutes late is still one hour', () => {
    expect(run(59).lateDeduction.toString()).toBe('75');
  });

  it('60 minutes late still deducts one hour', () => {
    expect(run(60).lateDeduction.toString()).toBe('75');
  });

  it('61 minutes late is one hour, because the floor takes it back to 60', () => {
    const r = run(61);
    expect(r.lateDeductionHours).toBe(1);
    expect(r.lateDeduction.toString()).toBe('75');
  });

  it('76 minutes late reaches the second hour block', () => {
    // floor 75 -> ceil to 2 hours.
    const r = run(76);
    expect(r.lateDeductionHours).toBe(2);
    expect(r.lateDeduction.toString()).toBe('150');
  });

  it('does not deduct raw minutes', () => {
    // 10/60 * 75 = 12.50 would be the per-minute answer; policy charges 75.
    expect(run(10).lateDeduction.toString()).not.toBe('12.5');
  });
});

describe('absence deduction scales by whole days at salary/30', () => {
  const run = (absentDays: number) =>
    calculatePayroll(
      { employee: monthlyEmployee(18000), attendance: { ...emptyAttendance, absentDays } },
      settings()
    );

  it.each([
    [1, '600'],
    [2, '1200'],
    [3, '1800'],
  ])('%i absent day(s) deducts %s', (days, expected) => {
    expect(run(days).absenceDeduction.toString()).toBe(expected);
  });

  it('approved paid leave is not an absence', () => {
    const r = calculatePayroll(
      {
        employee: monthlyEmployee(18000),
        attendance: { ...emptyAttendance, leaveDays: 2, unpaidLeaveDays: 0 },
      },
      settings()
    );
    expect(r.absenceDeduction.toString()).toBe('0');
  });

  it('does not recompute the monthly base from worked hours', () => {
    const r = calculatePayroll(
      { employee: monthlyEmployee(18000), attendance: { ...emptyAttendance, workedMinutes: 60 } },
      settings()
    );
    expect(r.baseSalary.toString()).toBe('18000');
  });
});

describe('money arithmetic stays decimal-safe', () => {
  it('produces an exact 0.1 + 0.2 style total without float drift', () => {
    const r = calculatePayroll(
      {
        employee: monthlyEmployee(18000),
        attendance: { ...emptyAttendance },
        manualIncomes: [
          { kind: PayrollItemKind.ALLOWANCE, label: 'เบี้ยเลี้ยง', amount: '0.1' },
          { kind: PayrollItemKind.OTHER_INCOME, label: 'อื่น ๆ', amount: '0.2' },
        ],
      },
      settings()
    );
    expect(r.grossIncome.minus(dec(18000)).toString()).toBe('0.3');
  });
});
