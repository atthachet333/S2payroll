import { describe, it, expect } from 'vitest';
import { EmploymentType, PayrollItemKind } from '@prisma/client';
import {
  applyTaxBrackets,
  calculatePayroll,
  calculateSocialSecurity,
  calculateTax,
  dailyRate,
  hourlyRate,
  type AttendanceAggregate,
  type EmployeeInput,
} from '../src/services/payroll-calculator.service.js';
import { PayrollSettings } from '../src/services/settings.service.js';
import { DEFAULT_SETTINGS_MAP } from '../src/config/payroll-defaults.js';
import { Decimal } from '../src/utils/money.js';

const settings = (overrides: Record<string, string> = {}) =>
  new PayrollSettings({ ...DEFAULT_SETTINGS_MAP, ...overrides });

const employee = (overrides: Partial<EmployeeInput> = {}): EmployeeInput => ({
  employeeId: 'e1',
  employeeCode: 'EMP001',
  employeeName: 'Test Employee',
  departmentName: 'OPS',
  positionName: 'Staff',
  employmentType: EmploymentType.MONTHLY,
  baseSalary: '30000',
  ssoEnabled: true,
  taxEnabled: true,
  otEligible: true,
  ...overrides,
});

const attendance = (overrides: Partial<AttendanceAggregate> = {}): AttendanceAggregate => ({
  workingDays: 22,
  presentDays: 22,
  absentDays: 0,
  leaveDays: 0,
  unpaidLeaveDays: 0,
  lateCount: 0,
  lateMinutes: 0,
  workedMinutes: 22 * 8 * 60,
  normalMinutes: 22 * 8 * 60,
  otWeekdayMinutes: 0,
  otWeekendMinutes: 0,
  otHolidayMinutes: 0,
  missingDataDays: 0,
  missingCheckInDays: 0,
  missingCheckOutDays: 0,
  ...overrides,
});

describe('rate derivation', () => {
  it('derives a daily rate from a monthly salary and the standard work days', () => {
    // 30000 / 22 = 1363.6363... -> 1363.64
    expect(dailyRate(employee(), settings()).toFixed(2)).toBe('1363.64');
  });

  it('derives an hourly rate from the daily rate and standard hours', () => {
    // 1363.64 / 8 = 170.455 -> 170.46
    expect(hourlyRate(employee(), settings()).toFixed(2)).toBe('170.46');
  });

  it('treats a DAILY employee base salary as the daily rate itself', () => {
    const e = employee({ employmentType: EmploymentType.DAILY, baseSalary: '600' });
    expect(dailyRate(e, settings()).toFixed(2)).toBe('600.00');
    expect(hourlyRate(e, settings()).toFixed(2)).toBe('75.00');
  });

  it('treats an HOURLY employee base salary as the hourly rate itself', () => {
    const e = employee({ employmentType: EmploymentType.HOURLY, baseSalary: '120' });
    expect(hourlyRate(e, settings()).toFixed(2)).toBe('120.00');
    expect(dailyRate(e, settings()).toFixed(2)).toBe('960.00');
  });

  it('does not divide by zero when STANDARD_WORK_DAYS is misconfigured to 0', () => {
    expect(dailyRate(employee(), settings({ STANDARD_WORK_DAYS: '0' })).toFixed(2)).toBe('0.00');
  });
});

describe('social security', () => {
  it('applies 5 percent within the wage band', () => {
    expect(calculateSocialSecurity(new Decimal(10000), settings()).toFixed(2)).toBe('500.00');
  });

  it('caps the contribution at SSO_MAX_CONTRIBUTION for high earners', () => {
    expect(calculateSocialSecurity(new Decimal(90000), settings()).toFixed(2)).toBe('750.00');
  });

  it('lifts a wage below the minimum base up to the minimum base', () => {
    // 1650 * 5% = 82.50
    expect(calculateSocialSecurity(new Decimal(1000), settings()).toFixed(2)).toBe('82.50');
  });

  it('returns zero when social security is disabled', () => {
    expect(
      calculateSocialSecurity(new Decimal(30000), settings({ SSO_ENABLED: 'false' })).toFixed(2)
    ).toBe('0.00');
  });

  it('returns zero for a zero wage', () => {
    expect(calculateSocialSecurity(new Decimal(0), settings()).toFixed(2)).toBe('0.00');
  });
});

describe('progressive tax brackets', () => {
  const brackets = settings().taxBrackets();

  it('charges nothing inside the exempt band', () => {
    expect(applyTaxBrackets(new Decimal(150000), brackets).toFixed(2)).toBe('0.00');
  });

  it('charges 5 percent on the slice above 150,000', () => {
    // (200000 - 150000) * 5% = 2500
    expect(applyTaxBrackets(new Decimal(200000), brackets).toFixed(2)).toBe('2500.00');
  });

  it('accumulates across several brackets', () => {
    // 150k @0 + 150k @5% (7500) + 100k @10% (10000) = 17500
    expect(applyTaxBrackets(new Decimal(400000), brackets).toFixed(2)).toBe('17500.00');
  });

  it('applies the open-ended top bracket', () => {
    // full ladder to 5,000,000 = 1,265,000, then 1,000,000 @35% = 350,000
    expect(applyTaxBrackets(new Decimal(6000000), brackets).toFixed(2)).toBe('1615000.00');
  });

  it('never returns a negative tax for a negative taxable income', () => {
    expect(applyTaxBrackets(new Decimal(-50000), brackets).toFixed(2)).toBe('0.00');
  });
});

describe('withholding tax', () => {
  it('is zero for a salary fully covered by allowances', () => {
    const sso = calculateSocialSecurity(new Decimal(20000), settings());
    expect(calculateTax(new Decimal(20000), sso, settings(), true).toFixed(2)).toBe('0.00');
  });

  it('computes a monthly amount by annualising', () => {
    // gross 60000, sso 750 -> monthly 59,250 -> annual 711,000
    // expenses capped at 100,000, personal allowance 60,000 -> taxable 551,000
    // brackets: 150k@0 + 150k@5% (7,500) + 200k@10% (20,000) + 51k@15% (7,650)
    //         = 35,150 annual -> 2,929.17 per month
    const sso = calculateSocialSecurity(new Decimal(60000), settings());
    expect(calculateTax(new Decimal(60000), sso, settings(), true).toFixed(2)).toBe('2929.17');
  });

  it('returns zero when the employee is flagged tax-exempt', () => {
    expect(calculateTax(new Decimal(60000), new Decimal(750), settings(), false).toFixed(2)).toBe(
      '0.00'
    );
  });

  it('returns zero when tax is globally disabled', () => {
    expect(
      calculateTax(new Decimal(60000), new Decimal(750), settings({ TAX_ENABLED: 'false' }), true)
        .toFixed(2)
    ).toBe('0.00');
  });
});

describe('calculatePayroll', () => {
  it('produces a clean full-attendance payroll', () => {
    const result = calculatePayroll({ employee: employee(), attendance: attendance() }, settings());

    expect(result.baseSalary.toFixed(2)).toBe('30000.00');
    expect(result.otAmount.toFixed(2)).toBe('0.00');
    expect(result.grossIncome.toFixed(2)).toBe('30000.00');
    expect(result.socialSecurity.toFixed(2)).toBe('750.00');
    expect(result.status).toBe('READY');
    // gross - (sso + tax) must equal net exactly
    expect(
      result.grossIncome.minus(result.totalDeduction).toFixed(2)
    ).toBe(result.netSalary.toFixed(2));
  });

  it('pays weekday OT at 1.5x the hourly rate', () => {
    const result = calculatePayroll(
      { employee: employee(), attendance: attendance({ otWeekdayMinutes: 600 }) },
      settings()
    );
    // 10 hours * (170.46 * 1.5 = 255.69) = 2556.90
    expect(result.otHours.toFixed(2)).toBe('10.00');
    expect(result.otAmount.toFixed(2)).toBe('2556.90');
  });

  it('pays weekend and holiday OT at their own multipliers', () => {
    const result = calculatePayroll(
      {
        employee: employee(),
        attendance: attendance({ otWeekendMinutes: 60, otHolidayMinutes: 60 }),
      },
      settings()
    );
    // weekend 170.46*2 = 340.92, holiday 170.46*3 = 511.38 -> 852.30
    expect(result.otAmount.toFixed(2)).toBe('852.30');
  });

  it('pays no OT to an employee who is not OT eligible', () => {
    const result = calculatePayroll(
      {
        employee: employee({ otEligible: false }),
        attendance: attendance({ otWeekdayMinutes: 600 }),
      },
      settings()
    );
    expect(result.otAmount.toFixed(2)).toBe('0.00');
  });

  it('deducts late minutes at the pro-rated hourly rate', () => {
    const result = calculatePayroll(
      { employee: employee(), attendance: attendance({ lateCount: 2, lateMinutes: 60 }) },
      settings()
    );
    // 170.46 / 60 * 60 = 170.46
    expect(result.lateDeduction.toFixed(2)).toBe('170.46');
  });

  it('deducts late occurrences at a flat rate when configured that way', () => {
    const result = calculatePayroll(
      { employee: employee(), attendance: attendance({ lateCount: 3, lateMinutes: 90 }) },
      settings({ LATE_DEDUCTION_MODE: 'PER_OCCURRENCE', LATE_DEDUCTION_AMOUNT: '100' })
    );
    expect(result.lateDeduction.toFixed(2)).toBe('300.00');
  });

  it('deducts absences at the daily rate', () => {
    const result = calculatePayroll(
      { employee: employee(), attendance: attendance({ absentDays: 2, presentDays: 20 }) },
      settings()
    );
    expect(result.absenceDeduction.toFixed(2)).toBe('2727.28');
    expect(result.status).toBe('NEEDS_REVIEW');
  });

  it('treats unpaid leave the same as an absence for deduction purposes', () => {
    const result = calculatePayroll(
      { employee: employee(), attendance: attendance({ unpaidLeaveDays: 1 }) },
      settings()
    );
    expect(result.absenceDeduction.toFixed(2)).toBe('1363.64');
  });

  it('does not deduct anything for paid leave', () => {
    const result = calculatePayroll(
      { employee: employee(), attendance: attendance({ leaveDays: 3, unpaidLeaveDays: 0 }) },
      settings()
    );
    expect(result.absenceDeduction.toFixed(2)).toBe('0.00');
  });

  it('adds manual allowance, bonus and other income into gross', () => {
    const result = calculatePayroll(
      {
        employee: employee(),
        attendance: attendance(),
        manualIncomes: [
          { kind: PayrollItemKind.ALLOWANCE, label: 'ค่าเดินทาง', amount: '1500' },
          { kind: PayrollItemKind.BONUS, label: 'โบนัส', amount: '5000' },
          { kind: PayrollItemKind.OTHER_INCOME, label: 'อื่น ๆ', amount: '250.55' },
        ],
      },
      settings()
    );
    expect(result.allowanceAmount.toFixed(2)).toBe('1500.00');
    expect(result.bonusAmount.toFixed(2)).toBe('5000.00');
    expect(result.otherIncome.toFixed(2)).toBe('250.55');
    expect(result.grossIncome.toFixed(2)).toBe('36750.55');
  });

  it('subtracts manual loan and other deductions from net', () => {
    const result = calculatePayroll(
      {
        employee: employee(),
        attendance: attendance(),
        manualDeductions: [
          { kind: PayrollItemKind.LOAN, label: 'เงินกู้', amount: '2000' },
          { kind: PayrollItemKind.OTHER_DEDUCTION, label: 'อื่น ๆ', amount: '150' },
        ],
      },
      settings()
    );
    expect(result.loanDeduction.toFixed(2)).toBe('2000.00');
    expect(result.otherDeduction.toFixed(2)).toBe('150.00');
    expect(
      result.grossIncome.minus(result.totalDeduction).toFixed(2)
    ).toBe(result.netSalary.toFixed(2));
  });

  it('pays a DAILY employee only for the days actually present', () => {
    const result = calculatePayroll(
      {
        employee: employee({ employmentType: EmploymentType.DAILY, baseSalary: '600' }),
        attendance: attendance({ presentDays: 18 }),
      },
      settings()
    );
    expect(result.baseSalary.toFixed(2)).toBe('10800.00');
  });

  it('pays an HOURLY employee for the hours actually worked', () => {
    const result = calculatePayroll(
      {
        employee: employee({ employmentType: EmploymentType.HOURLY, baseSalary: '120' }),
        attendance: attendance({ workedMinutes: 100 * 60 }),
      },
      settings()
    );
    expect(result.workingHours.toFixed(2)).toBe('100.00');
    expect(result.baseSalary.toFixed(2)).toBe('12000.00');
  });

  it('pro-rates a mid-month new hire', () => {
    const result = calculatePayroll(
      { employee: employee({ employedDays: 11 }), attendance: attendance() },
      settings()
    );
    // 30000 * 11/22 = 15000
    expect(result.baseSalary.toFixed(2)).toBe('15000.00');
    expect(result.reviewNotes.join(' ')).toContain('11/22');
  });

  it('flags missing attendance data instead of silently underpaying', () => {
    const result = calculatePayroll(
      { employee: employee(), attendance: attendance({ missingDataDays: 3 }) },
      settings()
    );
    expect(result.status).toBe('MISSING_DATA');
    expect(result.reviewNotes.join(' ')).toContain('3');
  });

  it('flags an employee with no attendance at all', () => {
    const result = calculatePayroll(
      { employee: employee(), attendance: attendance({ presentDays: 0, workedMinutes: 0 }) },
      settings()
    );
    expect(result.status).toBe('MISSING_DATA');
  });

  it('flags a negative net salary for review', () => {
    const result = calculatePayroll(
      {
        employee: employee(),
        attendance: attendance(),
        manualDeductions: [{ kind: PayrollItemKind.LOAN, label: 'เงินกู้', amount: '99000' }],
      },
      settings()
    );
    expect(result.netSalary.isNegative()).toBe(true);
    expect(result.status).toBe('NEEDS_REVIEW');
  });

  it('emits line items that sum exactly to the header totals', () => {
    const result = calculatePayroll(
      {
        employee: employee(),
        attendance: attendance({ otWeekdayMinutes: 300, lateMinutes: 25, lateCount: 1 }),
        manualIncomes: [{ kind: PayrollItemKind.ALLOWANCE, label: 'ค่าเดินทาง', amount: '1000' }],
        manualDeductions: [{ kind: PayrollItemKind.LOAN, label: 'เงินกู้', amount: '500' }],
      },
      settings()
    );

    const incomeSum = result.incomes.reduce((a, l) => a.plus(l.amount), new Decimal(0));
    const deductionSum = result.deductions.reduce((a, l) => a.plus(l.amount), new Decimal(0));

    expect(incomeSum.toFixed(2)).toBe(result.grossIncome.toFixed(2));
    expect(deductionSum.toFixed(2)).toBe(result.totalDeduction.toFixed(2));
  });

  it('avoids binary floating point error on repeated cent-level amounts', () => {
    // 0.1 + 0.2 would be 0.30000000000000004 with native numbers.
    const result = calculatePayroll(
      {
        employee: employee({ baseSalary: '0' }),
        attendance: attendance({ presentDays: 0, workedMinutes: 0 }),
        manualIncomes: [
          { kind: PayrollItemKind.OTHER_INCOME, label: 'a', amount: '0.1' },
          { kind: PayrollItemKind.OTHER_INCOME, label: 'b', amount: '0.2' },
        ],
      },
      settings({ SSO_ENABLED: 'false', TAX_ENABLED: 'false' })
    );
    expect(result.otherIncome.toFixed(2)).toBe('0.30');
    expect(result.grossIncome.toFixed(2)).toBe('0.30');
  });
});
