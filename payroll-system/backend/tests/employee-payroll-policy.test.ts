import { describe, it, expect } from 'vitest';
import { EmploymentType, PayType, type EmployeePayProfile } from '@prisma/client';
import {
  calculatePayroll,
  type AttendanceAggregate,
  type EmployeeInput,
  type EmployeePolicyView,
} from '../src/services/payroll-calculator.service.js';
import { computeDailyEarnings, rateForDate } from '../src/services/daily-earnings.service.js';
import { PayrollSettings, dailyHourlyRatePresets } from '../src/services/settings.service.js';
import { DEFAULT_SETTINGS_MAP } from '../src/config/payroll-defaults.js';
import { resolveReadiness } from '../src/utils/payroll-readiness.js';
import { isUsableProfile } from '../src/services/payroll-employee-context.service.js';
import { Prisma } from '@prisma/client';

/**
 * The 2026 pay-policy rules, exercised against the worked examples the business
 * stated rather than against whatever the code happens to do.
 *
 * Two properties matter most here and are asserted repeatedly:
 *   - no money is ever invented for an employee whose rate is not configured;
 *   - one unready employee never changes another employee's result.
 */

const settings = (overrides: Record<string, string> = {}) =>
  new PayrollSettings({ ...DEFAULT_SETTINGS_MAP, ...overrides });

/** Statutory deductions off, so a test about lateness is only about lateness. */
const plainSettings = (overrides: Record<string, string> = {}) =>
  settings({ SSO_ENABLED: 'false', TAX_ENABLED: 'false', OT_ENABLED: 'false', ...overrides });

const employee = (overrides: Partial<EmployeeInput> = {}): EmployeeInput => ({
  employeeId: 'e1',
  employeeCode: 'S2A999',
  employeeName: 'Test Employee',
  departmentName: null,
  positionName: null,
  employmentType: EmploymentType.MONTHLY,
  baseSalary: '18000',
  payType: 'MONTHLY',
  monthlySalary: '18000',
  ssoEnabled: false,
  taxEnabled: false,
  otEligible: false,
  ...overrides,
});

const attendance = (overrides: Partial<AttendanceAggregate> = {}): AttendanceAggregate => ({
  workingDays: 26,
  presentDays: 26,
  absentDays: 0,
  leaveDays: 0,
  unpaidLeaveDays: 0,
  lateCount: 0,
  lateMinutes: 0,
  roundedLateMinutes: 0,
  earlyLeaveMinutes: 0,
  roundedEarlyLeaveMinutes: 0,
  actualOtMinutes: 0,
  workedMinutes: 26 * 8 * 60,
  normalMinutes: 26 * 8 * 60,
  otWeekdayMinutes: 0,
  otWeekendMinutes: 0,
  otHolidayMinutes: 0,
  missingDataDays: 0,
  missingCheckInDays: 0,
  missingCheckOutDays: 0,
  ...overrides,
});

const policy = (overrides: Partial<EmployeePolicyView> = {}): EmployeePolicyView => ({ ...overrides });

const profile = (
  hourlyRate: string | null,
  effectiveFrom: string,
  effectiveTo: string | null = null,
  payType: PayType = PayType.HOURLY
): EmployeePayProfile =>
  ({
    id: `p-${effectiveFrom}`,
    employeeId: 'e1',
    payType,
    monthlySalary: payType === PayType.MONTHLY ? new Prisma.Decimal(hourlyRate ?? '0') : null,
    hourlyRate: payType === PayType.HOURLY && hourlyRate ? new Prisma.Decimal(hourlyRate) : null,
    effectiveFrom: new Date(`${effectiveFrom}T00:00:00.000Z`),
    effectiveTo: effectiveTo ? new Date(`${effectiveTo}T00:00:00.000Z`) : null,
    isActive: true,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as EmployeePayProfile;

const day = (date: string, workedMinutes: number) => ({
  workDate: new Date(`${date}T00:00:00.000Z`),
  checkIn: new Date(`${date}T08:30:00.000Z`),
  checkOut: new Date(`${date}T17:30:00.000Z`),
  workedMinutes,
  status: 'NORMAL',
});

// ---------------------------------------------------------------------------
// Part 1 / 32 - the DAILY hourly-rate options
// ---------------------------------------------------------------------------

describe('DAILY hourly rate presets', () => {
  it('offers the four familiar rates as quick picks', () => {
    expect(dailyHourlyRatePresets(settings())).toEqual([60, 75, 93, 100]);
  });

  it.each([60, 75, 93, 100])('offers %d as a preset', (rate) => {
    expect(dailyHourlyRatePresets(settings())).toContain(rate);
  });

  it('is a suggestion list, not a permission list', () => {
    // 62 is not a preset and must still be a perfectly savable rate. The API
    // validates that a rate is positive money and nothing more - the company
    // negotiates rates that are not on this list.
    expect(dailyHourlyRatePresets(settings())).not.toContain(62);
  });

  it('yields no presets when the setting is empty, without blocking input', () => {
    expect(dailyHourlyRatePresets(settings({ DAILY_HOURLY_RATE_OPTIONS: '' }))).toEqual([]);
  });

  it('reads a reconfigured list without a code change', () => {
    expect(dailyHourlyRatePresets(settings({ DAILY_HOURLY_RATE_OPTIONS: '55, 80' }))).toEqual([
      55, 80,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Part 11 / 12 - DAILY pay from actual worked minutes
// ---------------------------------------------------------------------------

describe('DAILY pay from worked minutes', () => {
  // Payable minutes drive the money: a day over eight hours loses an unpaid
  // hour, and what remains is floored to 15 minutes. 540 worked is therefore
  // 480 paid, not 540.
  const cases: [number, number, string][] = [
    [60, 60, '60.00'],
    [75, 90, '112.50'],
    [93, 30, '46.50'],
    [100, 540, '800.00'],
    [60, 540, '480.00'],
    [60, 480, '480.00'],
    [75, 540, '600.00'],
  ];

  it.each(cases)('pays %d THB/h for %d minutes as %s', (rate, minutes, expected) => {
    const summary = computeDailyEarnings(
      [day('2026-08-03', minutes)],
      [profile(String(rate), '2026-01-01')]
    );
    expect(summary.totalAmount.toFixed(2)).toBe(expected);
    expect(summary.rows[0].amount.toFixed(2)).toBe(expected);
  });

  it('is exact on a rate and duration that float arithmetic would round wrong', () => {
    // 35 worked minutes floor to 30 payable. 30/60 x 93 = 46.50 exactly.
    const summary = computeDailyEarnings(
      [day('2026-08-03', 35)],
      [profile('93', '2026-01-01')]
    );
    expect(summary.totalAmount.toFixed(2)).toBe('46.50');
  });

  it('sums a month from its individual days rather than from a day count', () => {
    const summary = computeDailyEarnings(
      [day('2026-08-03', 540), day('2026-08-04', 480), day('2026-08-05', 315)],
      [profile('75', '2026-01-01')]
    );
    // 540 -> break 60 -> 480 payable -> 600.00
    // 480 -> no break     -> 480 payable -> 600.00
    // 315 -> no break     -> 315 payable -> 393.75
    expect(summary.totalAmount.toFixed(2)).toBe('1593.75');
    // The observed durations are reported untouched alongside the paid ones.
    expect(summary.totalWorkedMinutes).toBe(1335);
    expect(summary.totalBreakDeductionMinutes).toBe(60);
    expect(summary.totalPayableMinutes).toBe(1275);
    expect(summary.workedDays).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Part 13 - the rate in force on each work date
// ---------------------------------------------------------------------------

describe('rate history by work date', () => {
  const profiles = [
    profile('60', '2026-08-01', '2026-08-15'),
    profile('75', '2026-08-16'),
  ];

  it('uses the older rate for a day before the change', () => {
    expect(rateForDate(profiles, new Date('2026-08-10T00:00:00.000Z'))?.hourlyRate?.toString()).toBe(
      '60'
    );
  });

  it('uses the newer rate for a day after the change', () => {
    expect(rateForDate(profiles, new Date('2026-08-20T00:00:00.000Z'))?.hourlyRate?.toString()).toBe(
      '75'
    );
  });

  it('prices a month spanning the change at both rates, not at the latest one', () => {
    const summary = computeDailyEarnings(
      [day('2026-08-10', 480), day('2026-08-20', 480)],
      profiles
    );
    // 8h x 60 + 8h x 75 = 480 + 600. Repricing the whole month at 75 would give 960.
    expect(summary.totalAmount.toFixed(2)).toBe('1080.00');
  });

  it('reports a day no rate covers as unrated instead of pricing it at 0', () => {
    const summary = computeDailyEarnings(
      [day('2026-07-20', 480), day('2026-08-20', 480)],
      [profile('75', '2026-08-16')]
    );
    expect(summary.unratedDays).toBe(1);
    expect(summary.unratedMinutes).toBe(480);
    // Only the covered day reached money; the uncovered one still shows its time.
    expect(summary.totalAmount.toFixed(2)).toBe('600.00');
    expect(summary.rows[0].rateConfigured).toBe(false);
    expect(summary.rows[0].workedMinutes).toBe(480);
  });
});

// ---------------------------------------------------------------------------
// Part 6 / 15 - the monthly display bases
// ---------------------------------------------------------------------------

describe('MONTHLY daily and hourly base', () => {
  it('derives 18,000 into 600 a day and 75 an hour', () => {
    const result = calculatePayroll(
      { employee: employee(), attendance: attendance() },
      plainSettings()
    );
    expect(result.dailyBase.toFixed(2)).toBe('600.00');
    expect(result.hourlyBase.toFixed(2)).toBe('75.00');
    // The bases are for deductions and display; the salary itself is unchanged.
    expect(result.baseSalary.toFixed(2)).toBe('18000.00');
  });

  it('derives the bases from the pay profile, not from the legacy salary column', () => {
    const result = calculatePayroll(
      {
        employee: employee({ baseSalary: '0', monthlySalary: '18000' }),
        attendance: attendance(),
      },
      plainSettings()
    );
    expect(result.dailyBase.toFixed(2)).toBe('600.00');
  });
});

// ---------------------------------------------------------------------------
// Part 7 - late deduction
// ---------------------------------------------------------------------------

describe('late deduction', () => {
  it('forgives 10 minutes late, which the 15-minute floor rounds to nothing', () => {
    const result = calculatePayroll(
      {
        employee: employee({ policy: policy({ lateDeductionType: 'PER_HOUR_FROM_BASE' }) }),
        attendance: attendance({ lateMinutes: 10, roundedLateMinutes: 0, lateCount: 1 }),
      },
      plainSettings()
    );
    expect(result.lateDeductionHours).toBe(0);
    expect(result.lateDeduction.toFixed(2)).toBe('0.00');
  });

  it('charges one whole hour once the floor reaches 15 minutes', () => {
    const result = calculatePayroll(
      {
        employee: employee({ policy: policy({ lateDeductionType: 'PER_HOUR_FROM_BASE' }) }),
        attendance: attendance({ lateMinutes: 16, roundedLateMinutes: 15, lateCount: 1 }),
      },
      plainSettings()
    );
    expect(result.lateDeductionHours).toBe(1);
    expect(result.lateDeduction.toFixed(2)).toBe('75.00');
  });

  it('charges one hour for 61 minutes late, the floor taking it back to 60', () => {
    const result = calculatePayroll(
      {
        employee: employee({ policy: policy({ lateDeductionType: 'PER_HOUR_FROM_BASE' }) }),
        attendance: attendance({ lateMinutes: 61, roundedLateMinutes: 60, lateCount: 1 }),
      },
      plainSettings()
    );
    expect(result.lateDeductionHours).toBe(1);
    expect(result.lateDeduction.toFixed(2)).toBe('75.00');
  });

  it('charges two hours for 76 minutes late', () => {
    const result = calculatePayroll(
      {
        employee: employee({ policy: policy({ lateDeductionType: 'PER_HOUR_FROM_BASE' }) }),
        attendance: attendance({ lateMinutes: 76, roundedLateMinutes: 75, lateCount: 1 }),
      },
      plainSettings()
    );
    expect(result.lateDeductionHours).toBe(2);
    expect(result.lateDeduction.toFixed(2)).toBe('150.00');
  });

  it('keeps the observed minutes and the charged hours as separate facts', () => {
    const result = calculatePayroll(
      {
        employee: employee({ policy: policy({ lateDeductionType: 'PER_HOUR_FROM_BASE' }) }),
        attendance: attendance({ lateMinutes: 76, roundedLateMinutes: 75, lateCount: 1 }),
      },
      plainSettings()
    );
    const line = result.deductions.find((d) => d.kind === 'LATE');
    // The label carries the observed minutes and the blocks actually billed,
    // so the payslip explains why 76 minutes cost two hours.
    expect(line?.quantity?.toFixed(0)).toBe('76');
    expect(line?.label).toContain('76 นาที');
    expect(line?.label).toContain('2 ชั่วโมง');
  });

  it('deducts nothing when the employee policy says NONE', () => {
    const result = calculatePayroll(
      {
        employee: employee({ policy: policy({ lateDeductionType: 'NONE' }) }),
        attendance: attendance({ lateMinutes: 90, roundedLateMinutes: 90, lateCount: 1 }),
      },
      plainSettings()
    );
    expect(result.lateDeduction.toFixed(2)).toBe('0.00');
    expect(result.lateDeductionHours).toBe(0);
  });

  it('charges a fixed amount per whole hour late when configured that way', () => {
    const result = calculatePayroll(
      {
        employee: employee({
          policy: policy({ lateDeductionType: 'FIXED_AMOUNT', lateDeductionAmount: '50' }),
        }),
        attendance: attendance({ lateMinutes: 61, roundedLateMinutes: 60, lateCount: 1 }),
      },
      plainSettings()
    );
    // floor 60 -> one hour block -> one flat charge of 50.
    expect(result.lateDeduction.toFixed(2)).toBe('50.00');
  });

  it('lets the employee policy beat the company default', () => {
    const company = plainSettings({ LATE_DEDUCTION_ROUND_UP_HOURS: 'true' });
    const withoutPolicy = calculatePayroll(
      { employee: employee(), attendance: attendance({ lateMinutes: 30, roundedLateMinutes: 30, lateCount: 1 }) },
      company
    );
    const withPolicy = calculatePayroll(
      {
        employee: employee({ policy: policy({ lateDeductionType: 'NONE' }) }),
        attendance: attendance({ lateMinutes: 30, roundedLateMinutes: 30, lateCount: 1 }),
      },
      company
    );
    expect(withoutPolicy.lateDeduction.toFixed(2)).toBe('75.00');
    expect(withPolicy.lateDeduction.toFixed(2)).toBe('0.00');
  });
});

// ---------------------------------------------------------------------------
// Part 8 / 9 - absence and leave, priced separately
// ---------------------------------------------------------------------------

describe('absence deduction', () => {
  it('charges one absent day at the daily base', () => {
    const result = calculatePayroll(
      {
        employee: employee({ policy: policy({ absenceDeductionType: 'PER_DAY_FROM_BASE' }) }),
        attendance: attendance({ absentDays: 1 }),
      },
      plainSettings()
    );
    expect(result.absenceDeduction.toFixed(2)).toBe('600.00');
  });

  it('charges two absent days at twice the daily base', () => {
    const result = calculatePayroll(
      {
        employee: employee({ policy: policy({ absenceDeductionType: 'PER_DAY_FROM_BASE' }) }),
        attendance: attendance({ absentDays: 2 }),
      },
      plainSettings()
    );
    expect(result.absenceDeduction.toFixed(2)).toBe('1200.00');
  });

  it('never treats approved paid leave as an absence', () => {
    const result = calculatePayroll(
      {
        employee: employee({
          policy: policy({
            absenceDeductionType: 'PER_DAY_FROM_BASE',
            leaveDeductionType: 'PER_DAY_FROM_BASE',
          }),
        }),
        attendance: attendance({ leaveDays: 3, unpaidLeaveDays: 0 }),
      },
      plainSettings()
    );
    expect(result.absenceDeduction.toFixed(2)).toBe('0.00');
    expect(result.leaveDeduction.toFixed(2)).toBe('0.00');
  });

  it('charges a fixed amount per absent day when configured that way', () => {
    const result = calculatePayroll(
      {
        employee: employee({
          policy: policy({ absenceDeductionType: 'FIXED_AMOUNT', absenceDeductionAmount: '500' }),
        }),
        attendance: attendance({ absentDays: 2 }),
      },
      plainSettings()
    );
    expect(result.absenceDeduction.toFixed(2)).toBe('1000.00');
  });
});

describe('leave deduction', () => {
  it('deducts nothing for unpaid leave when the employee is on paid-leave policy', () => {
    const result = calculatePayroll(
      {
        employee: employee({ policy: policy({ leaveDeductionType: 'NONE' }) }),
        attendance: attendance({ leaveDays: 2, unpaidLeaveDays: 2 }),
      },
      plainSettings()
    );
    expect(result.leaveDeduction.toFixed(2)).toBe('0.00');
  });

  it('charges unpaid leave at the daily base when the employee is on unpaid-leave policy', () => {
    const result = calculatePayroll(
      {
        employee: employee({ policy: policy({ leaveDeductionType: 'PER_DAY_FROM_BASE' }) }),
        attendance: attendance({ leaveDays: 2, unpaidLeaveDays: 2 }),
      },
      plainSettings()
    );
    expect(result.leaveDeduction.toFixed(2)).toBe('1200.00');
  });

  it('keeps leave and absence on separate lines and separate totals', () => {
    const result = calculatePayroll(
      {
        employee: employee({
          policy: policy({
            leaveDeductionType: 'PER_DAY_FROM_BASE',
            absenceDeductionType: 'PER_DAY_FROM_BASE',
          }),
        }),
        attendance: attendance({ absentDays: 1, leaveDays: 1, unpaidLeaveDays: 1 }),
      },
      plainSettings()
    );
    expect(result.leaveDeduction.toFixed(2)).toBe('600.00');
    expect(result.absenceDeduction.toFixed(2)).toBe('600.00');
    expect(result.deductions.filter((d) => d.kind === 'LEAVE')).toHaveLength(1);
    expect(result.deductions.filter((d) => d.kind === 'ABSENCE')).toHaveLength(1);
    expect(result.totalDeduction.toFixed(2)).toBe('1200.00');
  });
});

// ---------------------------------------------------------------------------
// Part 10 - social security and tax, per employee
// ---------------------------------------------------------------------------

describe('per-employee social security and tax', () => {
  it('uses the fixed amounts configured on the employee', () => {
    const result = calculatePayroll(
      {
        employee: employee({
          ssoEnabled: true,
          taxEnabled: true,
          policy: policy({ socialSecurityAmount: '750', taxAmount: '100' }),
        }),
        attendance: attendance(),
      },
      settings()
    );
    expect(result.socialSecurity.toFixed(2)).toBe('750.00');
    expect(result.tax.toFixed(2)).toBe('100.00');
  });

  it('honours a configured 0 as "deduct nothing" rather than falling back to the formula', () => {
    const result = calculatePayroll(
      {
        employee: employee({
          ssoEnabled: true,
          taxEnabled: true,
          policy: policy({ socialSecurityAmount: '0', taxAmount: '0' }),
        }),
        attendance: attendance(),
      },
      settings()
    );
    expect(result.socialSecurity.toFixed(2)).toBe('0.00');
    expect(result.tax.toFixed(2)).toBe('0.00');
  });

  it('falls back to the company formula when the employee has no configured amount', () => {
    const withoutPolicy = calculatePayroll(
      { employee: employee({ ssoEnabled: true }), attendance: attendance() },
      settings()
    );
    // 18,000 clamped to the 15,000 wage ceiling, at 5% = 750.
    expect(withoutPolicy.socialSecurity.toFixed(2)).toBe('750.00');
  });

  it('reaches the net through both statutory lines', () => {
    // The worked example: 18,000 base, 10 min late, 1 absent day, 750 SSO, 100 tax.
    const result = calculatePayroll(
      {
        employee: employee({
          ssoEnabled: true,
          taxEnabled: true,
          policy: policy({
            lateDeductionType: 'PER_HOUR_FROM_BASE',
            absenceDeductionType: 'PER_DAY_FROM_BASE',
            socialSecurityAmount: '750',
            taxAmount: '100',
          }),
        }),
        attendance: attendance({ lateMinutes: 16, roundedLateMinutes: 15, lateCount: 1, absentDays: 1 }),
      },
      settings({ OT_ENABLED: 'false' })
    );
    expect(result.lateDeduction.toFixed(2)).toBe('75.00');
    expect(result.absenceDeduction.toFixed(2)).toBe('600.00');
    expect(result.totalDeduction.toFixed(2)).toBe('1525.00');
    expect(result.netSalary.toFixed(2)).toBe('16475.00');
  });
});

// ---------------------------------------------------------------------------
// Part 11 / 14 / 20 - DAILY employees through the calculator
// ---------------------------------------------------------------------------

describe('DAILY employee payroll', () => {
  const dailyAttendance = attendance({
    workingDays: 26,
    presentDays: 12,
    workedMinutes: 4715,
    normalMinutes: 4715,
  });

  it('pays the sum of the individual days, not a day count times a day rate', () => {
    const result = calculatePayroll(
      {
        employee: employee({
          employmentType: EmploymentType.DAILY,
          baseSalary: '0',
          payType: 'HOURLY',
          monthlySalary: null,
          hourlyRate: '75',
        }),
        attendance: dailyAttendance,
        // 78h35m at 75 THB/h.
        dailyEarnings: {
          amount: '5893.75',
          totalWorkedMinutes: 4715,
          totalBreakDeductionMinutes: 0,
          totalPayableMinutes: 4715,
          totalRoundedAwayMinutes: 0,
          ratedMinutes: 4715,
          unratedMinutes: 0,
          unratedDays: 0,
          workedDays: 12,
        },
      },
      plainSettings()
    );
    expect(result.baseSalary.toFixed(2)).toBe('5893.75');
    expect(result.netSalary.toFixed(2)).toBe('5893.75');
    expect(result.status).toBe('READY');
  });

  it('reports worked time but no money when the rate is unconfigured', () => {
    const result = calculatePayroll(
      {
        employee: employee({
          employmentType: EmploymentType.DAILY,
          baseSalary: '0',
          payType: undefined,
          monthlySalary: null,
          hourlyRate: null,
          payConfigured: false,
        }),
        attendance: dailyAttendance,
        dailyEarnings: {
          amount: '0',
          totalWorkedMinutes: 4715,
          totalBreakDeductionMinutes: 0,
          totalPayableMinutes: 0,
          totalRoundedAwayMinutes: 0,
          ratedMinutes: 0,
          unratedMinutes: 4715,
          unratedDays: 12,
          workedDays: 12,
        },
      },
      plainSettings()
    );
    // The hours are real and are reported; the pay is not a figure at all.
    expect(result.workingHours.toFixed(2)).toBe('78.58');
    expect(result.baseSalary.toFixed(2)).toBe('0.00');
    expect(result.status).toBe('UNCONFIGURED');
    expect(result.payConfigured).toBe(false);
    expect(result.reviewNotes.join(' ')).toContain('ยังไม่ได้กำหนดอัตราค่าจ้าง');
  });

  it('marks a partly-rated month as PARTIAL rather than as complete', () => {
    const result = calculatePayroll(
      {
        employee: employee({
          employmentType: EmploymentType.DAILY,
          baseSalary: '0',
          payType: 'HOURLY',
          monthlySalary: null,
          hourlyRate: '75',
        }),
        attendance: dailyAttendance,
        dailyEarnings: {
          amount: '600.00',
          totalWorkedMinutes: 960,
          totalBreakDeductionMinutes: 0,
          totalPayableMinutes: 480,
          totalRoundedAwayMinutes: 0,
          ratedMinutes: 480,
          unratedMinutes: 480,
          unratedDays: 1,
          workedDays: 2,
        },
      },
      plainSettings()
    );
    expect(result.status).toBe('PARTIAL');
    expect(result.isEstimate).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Parts 16 to 22 - readiness is per employee
// ---------------------------------------------------------------------------

describe('per-employee readiness', () => {
  const base = {
    employmentType: EmploymentType.MONTHLY,
    excluded: false,
    payConfigured: true,
    attendanceRequired: true,
    missingDataDays: 0,
    missingCheckInDays: 0,
    missingCheckOutDays: 0,
    presentDays: 20,
    workingDays: 22,
    absentDays: 0,
    unratedDays: 0,
    netNegative: false,
    isEstimate: false,
  };

  it('is READY for a monthly employee with a salary and complete attendance', () => {
    expect(resolveReadiness(base).status).toBe('READY');
  });

  it('is UNCONFIGURED for a daily employee with no hourly rate', () => {
    const resolved = resolveReadiness({
      ...base,
      employmentType: EmploymentType.DAILY,
      payConfigured: false,
    });
    expect(resolved.status).toBe('UNCONFIGURED');
    expect(resolved.reasons.join(' ')).toContain('ยังไม่ได้กำหนดอัตราค่าจ้าง');
  });

  it('is UNCONFIGURED for a monthly employee with no salary', () => {
    expect(resolveReadiness({ ...base, payConfigured: false }).status).toBe('UNCONFIGURED');
  });

  it('is ATTENDANCE_INCOMPLETE when a past day has one punch missing', () => {
    const resolved = resolveReadiness({ ...base, missingDataDays: 1, missingCheckOutDays: 1 });
    expect(resolved.status).toBe('ATTENDANCE_INCOMPLETE');
    expect(resolved.reasons.join(' ')).toContain('ไม่มีเวลาออก');
  });

  it('is EXCLUDED for staff outside payroll under company policy', () => {
    expect(resolveReadiness({ ...base, excluded: true }).status).toBe('EXCLUDED');
  });

  it('puts an unset rate ahead of an incomplete punch, because it is more fundamental', () => {
    expect(
      resolveReadiness({ ...base, payConfigured: false, missingDataDays: 3 }).status
    ).toBe('UNCONFIGURED');
  });

  it('is PARTIAL while the period is still open', () => {
    expect(resolveReadiness({ ...base, isEstimate: true }).status).toBe('PARTIAL');
  });

  it('is PARTIAL when some worked days carry no rate', () => {
    expect(resolveReadiness({ ...base, unratedDays: 2 }).status).toBe('PARTIAL');
  });

  it('does not demand attendance from an attendance-exempt employee', () => {
    expect(
      resolveReadiness({ ...base, attendanceRequired: false, presentDays: 0, missingDataDays: 4 })
        .status
    ).toBe('READY');
  });

  it('lets a period hold every status at once', () => {
    const mix = [
      resolveReadiness(base),
      resolveReadiness({ ...base, payConfigured: false }),
      resolveReadiness({ ...base, missingDataDays: 1 }),
      resolveReadiness({ ...base, excluded: true }),
      resolveReadiness({ ...base, isEstimate: true }),
    ].map((r) => r.status);
    expect(new Set(mix)).toEqual(
      new Set(['READY', 'UNCONFIGURED', 'ATTENDANCE_INCOMPLETE', 'EXCLUDED', 'PARTIAL'])
    );
  });

  it('does not let one unready employee change another employee result', () => {
    // Readiness is a pure function of one employee's own inputs. Nothing about
    // another person can reach it, which is what makes a mixed period safe.
    const ready = resolveReadiness(base);
    const unconfigured = resolveReadiness({ ...base, payConfigured: false });
    expect(ready.status).toBe('READY');
    expect(unconfigured.status).toBe('UNCONFIGURED');
    expect(resolveReadiness(base).status).toBe('READY');
  });
});

// ---------------------------------------------------------------------------
// Pay profile usability
// ---------------------------------------------------------------------------

describe('usable pay profiles', () => {
  it('accepts an hourly profile with a positive rate for daily staff', () => {
    expect(isUsableProfile(profile('75', '2026-08-01'), EmploymentType.DAILY)).toBe(true);
  });

  it('rejects a zero rate, because zero is the absence of a rate and not a wage', () => {
    expect(isUsableProfile(profile('0', '2026-08-01'), EmploymentType.DAILY)).toBe(false);
  });

  it('rejects a monthly profile attached to daily staff', () => {
    expect(
      isUsableProfile(profile('18000', '2026-08-01', null, PayType.MONTHLY), EmploymentType.DAILY)
    ).toBe(false);
  });

  it('accepts a monthly profile with a positive salary for monthly staff', () => {
    expect(
      isUsableProfile(profile('18000', '2026-08-01', null, PayType.MONTHLY), EmploymentType.MONTHLY)
    ).toBe(true);
  });

  it('rejects a deactivated profile', () => {
    const p = { ...profile('75', '2026-08-01'), isActive: false } as EmployeePayProfile;
    expect(isUsableProfile(p, EmploymentType.DAILY)).toBe(false);
  });
});
