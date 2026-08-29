import { describe, it, expect } from 'vitest';
import { EmploymentType, PayrollItemKind } from '@prisma/client';
import {
  calculatePayroll,
  type AttendanceAggregate,
  type EmployeeInput,
  type ManualItem,
} from '../src/services/payroll-calculator.service.js';
import { PayrollSettings } from '../src/services/settings.service.js';
import { DEFAULT_SETTINGS_MAP } from '../src/config/payroll-defaults.js';
import { adjustPayrollSchema, createPeriodSchema } from '../src/schemas/index.js';
import { Decimal } from '../src/utils/money.js';

const settings = (o: Record<string, string> = {}) =>
  new PayrollSettings({ ...DEFAULT_SETTINGS_MAP, ...o });

const employee = (o: Partial<EmployeeInput> = {}): EmployeeInput => ({
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
  ...o,
});

const attendance = (o: Partial<AttendanceAggregate> = {}): AttendanceAggregate => ({
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
  ...o,
});

describe('commission as a first-class income type', () => {
  it('adds commission into gross income', () => {
    const result = calculatePayroll(
      {
        employee: employee(),
        attendance: attendance(),
        manualIncomes: [
          { kind: PayrollItemKind.COMMISSION, label: 'ค่าคอมมิชชั่น', amount: '7500.50' },
        ],
      },
      settings()
    );
    expect(result.commissionAmount.toFixed(2)).toBe('7500.50');
    expect(result.grossIncome.toFixed(2)).toBe('37500.50');
  });

  it('keeps commission separate from bonus and allowance', () => {
    const result = calculatePayroll(
      {
        employee: employee(),
        attendance: attendance(),
        manualIncomes: [
          { kind: PayrollItemKind.COMMISSION, label: 'คอม', amount: '1000' },
          { kind: PayrollItemKind.BONUS, label: 'โบนัส', amount: '2000' },
          { kind: PayrollItemKind.ALLOWANCE, label: 'เบี้ยเลี้ยง', amount: '3000' },
        ],
      },
      settings()
    );
    expect(result.commissionAmount.toFixed(2)).toBe('1000.00');
    expect(result.bonusAmount.toFixed(2)).toBe('2000.00');
    expect(result.allowanceAmount.toFixed(2)).toBe('3000.00');
    expect(result.grossIncome.toFixed(2)).toBe('36000.00');
  });

  it('raises social security and tax because commission is part of gross', () => {
    const without = calculatePayroll(
      { employee: employee({ baseSalary: '10000' }), attendance: attendance() },
      settings()
    );
    const withCommission = calculatePayroll(
      {
        employee: employee({ baseSalary: '10000' }),
        attendance: attendance(),
        manualIncomes: [{ kind: PayrollItemKind.COMMISSION, label: 'คอม', amount: '5000' }],
      },
      settings()
    );
    // 10000 -> 500 SSO; 15000 -> 750 SSO (at the ceiling)
    expect(without.socialSecurity.toFixed(2)).toBe('500.00');
    expect(withCommission.socialSecurity.toFixed(2)).toBe('750.00');
  });

  it('includes commission in the emitted income lines', () => {
    const result = calculatePayroll(
      {
        employee: employee(),
        attendance: attendance(),
        manualIncomes: [{ kind: PayrollItemKind.COMMISSION, label: 'ค่าคอมมิชชั่น', amount: '900' }],
      },
      settings()
    );
    const line = result.incomes.find((l) => l.kind === PayrollItemKind.COMMISSION);
    expect(line).toBeDefined();
    expect(line?.amount.toFixed(2)).toBe('900.00');
    expect(line?.isManual).toBe(true);

    const sum = result.incomes.reduce((a, l) => a.plus(l.amount), new Decimal(0));
    expect(sum.toFixed(2)).toBe(result.grossIncome.toFixed(2));
  });
});

describe('attendance problem flags reach the payroll row', () => {
  it('separates missing check-in from missing check-out in the review note', () => {
    const result = calculatePayroll(
      {
        employee: employee(),
        attendance: attendance({
          missingDataDays: 3,
          missingCheckInDays: 1,
          missingCheckOutDays: 2,
        }),
      },
      settings()
    );
    expect(result.status).toBe('MISSING_DATA');
    const note = result.reviewNotes.join(' ');
    expect(note).toContain('ไม่มีเวลาเข้า 1 วัน');
    expect(note).toContain('ไม่มีเวลาออก 2 วัน');
  });

  it('reports normal hours separately from total worked hours', () => {
    const result = calculatePayroll(
      {
        employee: employee(),
        attendance: attendance({
          workedMinutes: 22 * 8 * 60 + 600,
          normalMinutes: 22 * 8 * 60,
          otWeekdayMinutes: 600,
        }),
      },
      settings()
    );
    expect(result.normalHours.toFixed(2)).toBe('176.00');
    expect(result.otHours.toFixed(2)).toBe('10.00');
    expect(result.workingHours.toFixed(2)).toBe('186.00');
  });

  it('never silently pays a full salary against zero attendance', () => {
    const result = calculatePayroll(
      {
        employee: employee(),
        attendance: attendance({ presentDays: 0, workedMinutes: 0, normalMinutes: 0 }),
      },
      settings()
    );
    expect(result.status).toBe('MISSING_DATA');
    expect(result.reviewNotes.join(' ')).toContain('ไม่พบข้อมูลการลงเวลา');
  });
});

describe('manual adjustment validation', () => {
  const valid = (over: Record<string, unknown> = {}) => ({
    adjustments: [{ field: 'bonusAmount', value: '5000', reason: 'โบนัสประจำไตรมาส', ...over }],
  });

  it('accepts a well-formed adjustment', () => {
    expect(adjustPayrollSchema.safeParse(valid()).success).toBe(true);
  });

  it('requires a reason', () => {
    const r = adjustPayrollSchema.safeParse({
      adjustments: [{ field: 'bonusAmount', value: '5000' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a reason shorter than 3 characters', () => {
    expect(adjustPayrollSchema.safeParse(valid({ reason: 'ok' })).success).toBe(false);
  });

  it('rejects a field outside the allow-list', () => {
    for (const field of ['baseSalary', 'netSalary', 'grossIncome', 'employeeCode', 'status']) {
      expect(adjustPayrollSchema.safeParse(valid({ field })).success, field).toBe(false);
    }
  });

  it('accepts commissionAmount now that commission is adjustable', () => {
    expect(adjustPayrollSchema.safeParse(valid({ field: 'commissionAmount' })).success).toBe(true);
  });

  it('rejects a non-numeric amount', () => {
    expect(adjustPayrollSchema.safeParse(valid({ value: 'abc' })).success).toBe(false);
    expect(adjustPayrollSchema.safeParse(valid({ value: '' })).success).toBe(false);
  });

  it('accepts a negative amount, which a correction may legitimately need', () => {
    expect(adjustPayrollSchema.safeParse(valid({ value: '-250.50' })).success).toBe(true);
  });

  it('requires at least one adjustment', () => {
    expect(adjustPayrollSchema.safeParse({ adjustments: [] }).success).toBe(false);
  });
});

describe('payroll period creation validation', () => {
  it('accepts a plain month with no custom window', () => {
    expect(createPeriodSchema.safeParse({ year: 2026, month: 7 }).success).toBe(true);
  });

  it('accepts an explicit custom start and end', () => {
    const r = createPeriodSchema.safeParse({
      year: 2026,
      month: 7,
      startDate: '2026-06-26',
      endDate: '2026-07-25',
    });
    expect(r.success).toBe(true);
  });

  it('rejects an end date before the start date', () => {
    const r = createPeriodSchema.safeParse({
      year: 2026,
      month: 7,
      startDate: '2026-07-31',
      endDate: '2026-07-01',
    });
    expect(r.success).toBe(false);
  });

  it('rejects an out-of-range month', () => {
    expect(createPeriodSchema.safeParse({ year: 2026, month: 0 }).success).toBe(false);
    expect(createPeriodSchema.safeParse({ year: 2026, month: 13 }).success).toBe(false);
  });

  it('supports any payroll month, not just the seeded test month', () => {
    for (let month = 1; month <= 12; month += 1) {
      expect(createPeriodSchema.safeParse({ year: 2027, month }).success, `month ${month}`).toBe(true);
    }
    expect(createPeriodSchema.safeParse({ year: 2030, month: 12 }).success).toBe(true);
  });
});

describe('line items always reconcile with header totals', () => {
  // A payslip that states a gross its own line items do not add up to is the
  // first thing an employee notices. Every income/deduction combination must
  // keep the two in agreement.
  const cases: { name: string; incomes?: ManualItem[]; deductions?: ManualItem[] }[] = [
    { name: 'no manual items' },
    {
      name: 'commission only',
      incomes: [{ kind: PayrollItemKind.COMMISSION, label: 'คอม', amount: '3500' }],
    },
    {
      name: 'every income type at once',
      incomes: [
        { kind: PayrollItemKind.ALLOWANCE, label: 'เบี้ยเลี้ยง', amount: '1500' },
        { kind: PayrollItemKind.BONUS, label: 'โบนัส', amount: '2000' },
        { kind: PayrollItemKind.COMMISSION, label: 'คอม', amount: '3500' },
        { kind: PayrollItemKind.OTHER_INCOME, label: 'อื่น ๆ', amount: '250.25' },
      ],
    },
    {
      name: 'every deduction type at once',
      deductions: [
        { kind: PayrollItemKind.LOAN, label: 'เงินกู้', amount: '1200' },
        { kind: PayrollItemKind.OTHER_DEDUCTION, label: 'อื่น ๆ', amount: '99.99' },
      ],
    },
    {
      name: 'income and deductions together',
      incomes: [{ kind: PayrollItemKind.COMMISSION, label: 'คอม', amount: '1234.56' }],
      deductions: [{ kind: PayrollItemKind.LOAN, label: 'เงินกู้', amount: '765.44' }],
    },
  ];

  for (const c of cases) {
    it(`reconciles with ${c.name}`, () => {
      const result = calculatePayroll(
        {
          employee: employee(),
          attendance: attendance({ otWeekdayMinutes: 300, lateMinutes: 30, lateCount: 1, absentDays: 1 }),
          manualIncomes: c.incomes,
          manualDeductions: c.deductions,
        },
        settings()
      );

      const incomeSum = result.incomes.reduce((a, l) => a.plus(l.amount), new Decimal(0));
      const deductionSum = result.deductions.reduce((a, l) => a.plus(l.amount), new Decimal(0));

      expect(incomeSum.toFixed(2)).toBe(result.grossIncome.toFixed(2));
      expect(deductionSum.toFixed(2)).toBe(result.totalDeduction.toFixed(2));
      expect(result.grossIncome.minus(result.totalDeduction).toFixed(2)).toBe(
        result.netSalary.toFixed(2)
      );
    });
  }
});

describe('manual income lines survive alongside derived values', () => {
  it('recalculating with the same manual lines reproduces the same totals', () => {
    const manualIncomes: ManualItem[] = [
      { kind: PayrollItemKind.ALLOWANCE, label: 'ค่าเดินทาง', amount: '1500' },
      { kind: PayrollItemKind.COMMISSION, label: 'คอม', amount: '2500' },
    ];
    const manualDeductions: ManualItem[] = [
      { kind: PayrollItemKind.LOAN, label: 'เงินกู้', amount: '1000' },
    ];

    const first = calculatePayroll(
      { employee: employee(), attendance: attendance(), manualIncomes, manualDeductions },
      settings()
    );
    const second = calculatePayroll(
      { employee: employee(), attendance: attendance(), manualIncomes, manualDeductions },
      settings()
    );

    expect(second.grossIncome.toFixed(2)).toBe(first.grossIncome.toFixed(2));
    expect(second.netSalary.toFixed(2)).toBe(first.netSalary.toFixed(2));
    expect(second.commissionAmount.toFixed(2)).toBe('2500.00');
  });
});
