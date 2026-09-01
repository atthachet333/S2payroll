import { describe, it, expect } from 'vitest';
import { EmploymentType, PayType, Prisma, type EmployeePayProfile, type EmployeePayrollPolicy } from '@prisma/client';
import { valueAttendanceDay } from '../src/services/attendance-valuation.service.js';
import { PayrollSettings } from '../src/services/settings.service.js';
import { DEFAULT_SETTINGS_MAP } from '../src/config/payroll-defaults.js';

/**
 * The money shown in the Attendance table's "ได้เงินวันนี้" column.
 *
 * Two properties are asserted throughout, because getting either wrong would be
 * invisible on screen and wrong on a payslip:
 *
 *  - monthly payroll-level amounts (social security, withholding tax) are never
 *    spread across days;
 *  - an employee with no configured rate produces UNCONFIGURED, never a 0.00
 *    that reads like a settled amount of nothing earned.
 */

const settings = (overrides: Record<string, string> = {}) =>
  new PayrollSettings({ ...DEFAULT_SETTINGS_MAP, ...overrides });

const profile = (
  amount: string,
  effectiveFrom: string,
  effectiveTo: string | null = null,
  payType: PayType = PayType.HOURLY
): EmployeePayProfile =>
  ({
    id: `p-${effectiveFrom}-${amount}`,
    employeeId: 'e1',
    payType,
    monthlySalary: payType === PayType.MONTHLY ? new Prisma.Decimal(amount) : null,
    hourlyRate: payType === PayType.HOURLY ? new Prisma.Decimal(amount) : null,
    effectiveFrom: new Date(`${effectiveFrom}T00:00:00.000Z`),
    effectiveTo: effectiveTo ? new Date(`${effectiveTo}T00:00:00.000Z`) : null,
    isActive: true,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as EmployeePayProfile;

const policy = (over: Partial<EmployeePayrollPolicy> = {}): EmployeePayrollPolicy =>
  ({
    id: 'pol1',
    employeeId: 'e1',
    lateDeductionType: null,
    lateDeductionAmount: null,
    leaveDeductionType: null,
    leaveDeductionAmount: null,
    absenceDeductionType: null,
    absenceDeductionAmount: null,
    socialSecurityAmount: null,
    taxAmount: null,
    note: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as EmployeePayrollPolicy;

const day = (over: Record<string, unknown> = {}) => ({
  workDate: new Date('2026-08-10T00:00:00.000Z'),
  workedMinutes: 480,
  lateMinutes: 0,
  isAbsent: false,
  isHoliday: false,
  isWeekend: false,
  status: 'NORMAL',
  ...over,
});

const value = (over: Record<string, unknown> = {}) =>
  valueAttendanceDay({
    record: day(over.record as Record<string, unknown>) as never,
    employee: {
      employmentType: EmploymentType.DAILY,
      attendanceRequired: true,
      ...((over.employee as object) ?? {}),
    },
    profiles: (over.profiles as EmployeePayProfile[]) ?? [profile('75', '2026-01-01')],
    policy: (over.policy as EmployeePayrollPolicy | null) ?? null,
    isUnpaidLeaveDay: Boolean(over.isUnpaidLeaveDay),
    settings: (over.settings as PayrollSettings) ?? settings(),
  });

// ---------------------------------------------------------------------------
// DAILY
// ---------------------------------------------------------------------------

describe('DAILY daily earning', () => {
  // Payable minutes drive the money: over eight hours loses an unpaid hour,
  // and the remainder is floored to 15 minutes.
  const cases: [number, number, string][] = [
    [60, 60, '60.00'],
    [75, 90, '112.50'],
    [93, 30, '46.50'],
    [100, 540, '800.00'],
    [75, 540, '600.00'],
    [60, 480, '480.00'],
  ];

  it.each(cases)('pays %d THB/h for %d minutes as %s', (rate, minutes, expected) => {
    const result = value({
      record: { workedMinutes: minutes },
      profiles: [profile(String(rate), '2026-01-01')],
    });
    expect(result.status).toBe('CALCULATED');
    expect(result.gross).toBe(expected);
    expect(result.net).toBe(expected);
  });

  it('reports the hourly rate as the basis so the tooltip can explain the figure', () => {
    const result = value({ profiles: [profile('93', '2026-01-01')] });
    expect(result.basisKind).toBe('HOURLY_RATE');
    expect(result.basis).toBe('93.00');
  });

  it('is UNCONFIGURED, not 0.00, when no rate is configured', () => {
    const result = value({ profiles: [] });
    expect(result.status).toBe('UNCONFIGURED');
    expect(result.note).toContain('ยังไม่ได้กำหนดอัตราค่าจ้าง');
  });

  it('is UNCONFIGURED when the rate range does not cover this particular day', () => {
    // A rate starting 16 Aug does not retroactively price a 10 Aug shift.
    const result = value({ profiles: [profile('75', '2026-08-16')] });
    expect(result.status).toBe('UNCONFIGURED');
  });

  it('uses the rate in force on the day, not the latest rate', () => {
    const profiles = [profile('60', '2026-08-01', '2026-08-15'), profile('75', '2026-08-16')];
    expect(value({ profiles, record: { workDate: new Date('2026-08-10T00:00:00.000Z') } }).gross)
      .toBe('480.00');
    expect(value({ profiles, record: { workDate: new Date('2026-08-20T00:00:00.000Z') } }).gross)
      .toBe('600.00');
  });

  it('never charges lateness to a daily employee', () => {
    // Daily staff carry no lateness compliance, and a short day already pays less.
    const result = value({
      record: { lateMinutes: 45, status: 'LATE' },
      policy: policy({ lateDeductionType: 'PER_HOUR_FROM_BASE' }),
    });
    expect(result.lateDeduction).toBe('0.00');
    expect(result.attendanceDeduction).toBe('0.00');
  });

  it('does not deduct a day of pay on top of an unworked day', () => {
    // Zero minutes already earns zero; deducting again would charge twice.
    const result = value({
      record: { workedMinutes: 0, isAbsent: true, status: 'ABSENT' },
      policy: policy({ absenceDeductionType: 'PER_DAY_FROM_BASE' }),
    });
    expect(result.gross).toBe('0.00');
    expect(result.absenceDeduction).toBe('0.00');
    expect(result.net).toBe('0.00');
  });
});

// ---------------------------------------------------------------------------
// MONTHLY
// ---------------------------------------------------------------------------

const monthly = (over: Record<string, unknown> = {}) =>
  value({
    employee: { employmentType: EmploymentType.MONTHLY, attendanceRequired: true },
    profiles: [profile('18000', '2026-01-01', null, PayType.MONTHLY)],
    ...over,
  });

describe('MONTHLY daily value', () => {
  it('derives 18,000 into a 600.00 day base', () => {
    const result = monthly();
    expect(result.status).toBe('CALCULATED');
    expect(result.gross).toBe('600.00');
    expect(result.basisKind).toBe('DAILY_BASE');
    expect(result.net).toBe('600.00');
  });

  it('forgives a 10-minute lateness, which the 15-minute floor rounds away', () => {
    const result = monthly({
      record: { lateMinutes: 10, status: 'LATE' },
      policy: policy({ lateDeductionType: 'PER_HOUR_FROM_BASE' }),
    });
    expect(result.lateDeduction).toBe('0.00');
    expect(result.lateChargedHours).toBe(0);
    expect(result.net).toBe('600.00');
  });

  it('shows 525.00 once the lateness reaches the interval', () => {
    // 16 observed minutes floor to 15, which ceils to one hour: 600 - 75.
    const result = monthly({
      record: { lateMinutes: 16, status: 'LATE' },
      policy: policy({ lateDeductionType: 'PER_HOUR_FROM_BASE' }),
    });
    expect(result.lateDeduction).toBe('75.00');
    expect(result.lateChargedHours).toBe(1);
    expect(result.net).toBe('525.00');
  });

  it('shows 0.00 for an absent day, the day base having been fully deducted', () => {
    const result = monthly({
      record: { workedMinutes: 0, isAbsent: true, status: 'ABSENT' },
      policy: policy({ absenceDeductionType: 'PER_DAY_FROM_BASE' }),
    });
    expect(result.gross).toBe('600.00');
    expect(result.absenceDeduction).toBe('600.00');
    expect(result.net).toBe('0.00');
  });

  it('deducts an unpaid leave day when the employee policy charges leave', () => {
    const result = monthly({
      record: { workedMinutes: 0, status: 'LEAVE' },
      isUnpaidLeaveDay: true,
      policy: policy({ leaveDeductionType: 'PER_DAY_FROM_BASE' }),
    });
    expect(result.leaveDeduction).toBe('600.00');
    expect(result.net).toBe('0.00');
  });

  it('does not deduct leave when the employee is on a paid-leave policy', () => {
    const result = monthly({
      record: { workedMinutes: 0, status: 'LEAVE' },
      isUnpaidLeaveDay: true,
      policy: policy({ leaveDeductionType: 'NONE' }),
    });
    expect(result.leaveDeduction).toBe('0.00');
    expect(result.net).toBe('600.00');
  });

  it('never spreads social security across days', () => {
    // 750/month must not appear as 25/day. The employee has an SSO amount set
    // and it must be entirely absent from the day figure.
    const result = monthly({ policy: policy({ socialSecurityAmount: new Prisma.Decimal('750') }) });
    expect(result.attendanceDeduction).toBe('0.00');
    expect(result.net).toBe('600.00');
  });

  it('never spreads withholding tax across days', () => {
    const result = monthly({ policy: policy({ taxAmount: new Prisma.Decimal('100') }) });
    expect(result.attendanceDeduction).toBe('0.00');
    expect(result.net).toBe('600.00');
  });

  it('honours a reconfigured salary divisor rather than assuming 30', () => {
    const result = monthly({ settings: settings({ MONTHLY_SALARY_DAY_DIVISOR: '25' }) });
    expect(result.gross).toBe('720.00');
  });

  it('is UNCONFIGURED when no salary is configured', () => {
    const result = monthly({ profiles: [] });
    expect(result.status).toBe('UNCONFIGURED');
  });
});

// ---------------------------------------------------------------------------
// Days that have no value to show
// ---------------------------------------------------------------------------

describe('days with no day value', () => {
  it('is NOT_APPLICABLE on a public holiday', () => {
    expect(value({ record: { isHoliday: true, status: 'HOLIDAY' } }).status).toBe('NOT_APPLICABLE');
  });

  it('is NOT_APPLICABLE on an unworked non-scheduled day', () => {
    expect(value({ record: { isWeekend: true, workedMinutes: 0 } }).status).toBe('NOT_APPLICABLE');
  });

  it('still values a non-scheduled day that was actually worked', () => {
    expect(value({ record: { isWeekend: true, workedMinutes: 480 } }).status).toBe('CALCULATED');
  });

  it('is NOT_APPLICABLE while a punch is missing, rather than guessing a duration', () => {
    expect(value({ record: { status: 'MISSING_DATA' } }).status).toBe('NOT_APPLICABLE');
  });

  it('is NOT_APPLICABLE for a day still in progress', () => {
    expect(value({ record: { status: 'IN_PROGRESS' } }).status).toBe('NOT_APPLICABLE');
  });

  it('is NOT_APPLICABLE for an attendance-exempt employee', () => {
    expect(
      value({ employee: { employmentType: EmploymentType.MONTHLY, attendanceRequired: false } })
        .status
    ).toBe('NOT_APPLICABLE');
  });
});

// ---------------------------------------------------------------------------
// Consistency with payroll
// ---------------------------------------------------------------------------

describe('attendance and payroll agree', () => {
  it('sums a DAILY month to the same figure the payroll run computes', () => {
    // Both the column and the payroll base pay go through the same per-day
    // pricing helper, so the sum of the days is the month.
    const profiles = [profile('75', '2026-01-01')];
    const days = [540, 480, 315];
    const total = days
      .map((minutes) => Number(value({ record: { workedMinutes: minutes }, profiles }).net))
      .reduce((a, b) => a + b, 0);
    expect(total.toFixed(2)).toBe('1593.75');
  });

  it('does not invite summing a MONTHLY month back into the salary', () => {
    // 600/day x 26 working days is 15,600, not the 18,000 salary. The divisor is
    // a fixed 30 while months have a variable number of working days, so this
    // value is informational only - the test pins that it is NOT the salary.
    const perDay = Number(monthly().net);
    expect(perDay * 26).not.toBe(18000);
    expect(perDay).toBe(600);
  });
});
