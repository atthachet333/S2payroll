import { EmploymentType, PayrollEmployeeStatus, PayrollItemKind } from '@prisma/client';
import { Decimal, dec, money, minutesToHours, hours } from '../utils/money.js';
import type { PayrollSettings, TaxBracket } from './settings.service.js';
import { lateDeductionHours } from '../utils/attendance-math.js';

/**
 * Isolated payroll calculation engine.
 *
 * This module is pure: it takes an employee snapshot, an attendance aggregate
 * and a settings view, and returns the full breakdown. It performs no I/O, reads
 * no globals and holds no state, which makes every rule directly unit-testable.
 *
 * All arithmetic uses Decimal. There is no native floating-point maths on any
 * monetary path in this file.
 *
 * Flow: attendance -> working hours -> OT -> late -> absence
 *       -> income -> deductions -> social security -> tax -> net salary
 */

export interface EmployeeInput {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  departmentName: string | null;
  positionName: string | null;
  employmentType: EmploymentType;
  baseSalary: Decimal | string | number;
  payType?: 'MONTHLY' | 'HOURLY';
  monthlySalary?: Decimal | string | number | null;
  hourlyRate?: Decimal | string | number | null;
  ssoEnabled: boolean;
  taxEnabled: boolean;
  otEligible: boolean;
  /** False for executives whose salary does not depend on attendance compliance. */
  attendanceRequired?: boolean;
  /** Days actually employed within the period, used for pro-rating new hires and leavers. */
  employedDays?: number;
}

export interface AttendanceAggregate {
  /** Calendar working days in the period (weekdays that are not public holidays). */
  workingDays: number;
  /** Days the employee actually recorded work on. */
  presentDays: number;
  absentDays: number;
  leaveDays: number;
  unpaidLeaveDays: number;
  lateCount: number;
  lateMinutes: number;
  /** Total paid minutes worked, net of the unpaid break. */
  workedMinutes: number;
  /** Paid minutes up to the standard working day, excluding overtime. */
  normalMinutes: number;
  otWeekdayMinutes: number;
  otWeekendMinutes: number;
  otHolidayMinutes: number;
  /** Days flagged MISSING_DATA - one punch present, the other absent. */
  missingDataDays: number;
  missingCheckInDays: number;
  missingCheckOutDays: number;
}

export interface ManualItem {
  kind: PayrollItemKind;
  label: string;
  amount: Decimal | string | number;
  quantity?: Decimal | string | number | null;
  rate?: Decimal | string | number | null;
  note?: string | null;
}

export interface CalculationInput {
  employee: EmployeeInput;
  attendance: AttendanceAggregate;
  /** Extra income lines entered by payroll staff (allowance, bonus, other). */
  manualIncomes?: ManualItem[];
  /** Extra deduction lines entered by payroll staff (loan, other). */
  manualDeductions?: ManualItem[];
}

export interface CalculatedLine {
  kind: PayrollItemKind;
  label: string;
  quantity: Decimal | null;
  rate: Decimal | null;
  amount: Decimal;
  isManual: boolean;
}

export interface CalculationResult {
  workingHours: Decimal;
  normalHours: Decimal;
  otHours: Decimal;
  otWeekdayHours: Decimal;
  otWeekendHours: Decimal;
  otHolidayHours: Decimal;

  hourlyRate: Decimal;
  dailyRate: Decimal;

  baseSalary: Decimal;
  otAmount: Decimal;
  allowanceAmount: Decimal;
  bonusAmount: Decimal;
  commissionAmount: Decimal;
  otherIncome: Decimal;
  grossIncome: Decimal;

  lateDeduction: Decimal;
  /** Whole-hour blocks charged for lateness: ceil(lateMinutes / 60). */
  lateDeductionHours: number;
  absenceDeduction: Decimal;
  socialSecurity: Decimal;
  tax: Decimal;
  loanDeduction: Decimal;
  otherDeduction: Decimal;
  totalDeduction: Decimal;

  netSalary: Decimal;

  incomes: CalculatedLine[];
  deductions: CalculatedLine[];

  status: PayrollEmployeeStatus;
  reviewNotes: string[];
}

// ---------------------------------------------------------------------------
// Rate derivation
// ---------------------------------------------------------------------------

/**
 * Daily rate for an employee.
 *   MONTHLY  -> salary / STANDARD_WORK_DAYS
 *   DAILY    -> the stored base salary is already a daily rate
 *   HOURLY   -> hourly rate x STANDARD_WORK_HOURS
 *   CONTRACT -> same as monthly; contract pay is a fixed monthly figure
 */
/**
 * Divisor turning a monthly salary into a day. Company policy fixes this at 30
 * so the same absence costs the same in February as in March - neither the
 * calendar length of the month nor the count of scheduled working days may be
 * used. Falls back to the legacy STANDARD_WORK_DAYS only if unset.
 */
function salaryDayDivisor(settings: PayrollSettings): Decimal {
  const configured = settings.decimal('MONTHLY_SALARY_DAY_DIVISOR');
  return configured.greaterThan(0) ? configured : settings.decimal('STANDARD_WORK_DAYS');
}

/** Paid hours in a standard day, used to turn a day rate into an hour rate. */
function paidHoursPerDay(settings: PayrollSettings): Decimal {
  const configured = settings.decimal('STANDARD_PAID_HOURS_PER_DAY');
  return configured.greaterThan(0) ? configured : settings.decimal('STANDARD_WORK_HOURS');
}

export function dailyRate(employee: EmployeeInput, settings: PayrollSettings): Decimal {
  if (employee.payType === 'HOURLY' && employee.hourlyRate != null) {
    return money(dec(employee.hourlyRate).times(paidHoursPerDay(settings)));
  }
  const base = dec(employee.baseSalary);
  const standardHours = paidHoursPerDay(settings);

  switch (employee.employmentType) {
    case EmploymentType.DAILY:
      return money(base);
    case EmploymentType.HOURLY:
      return money(base.times(standardHours));
    case EmploymentType.MONTHLY:
    case EmploymentType.CONTRACT:
    default: {
      const divisor = salaryDayDivisor(settings);
      // 18,000 / 30 = 600 THB per day.
      return divisor.isZero() ? new Decimal(0) : money(base.dividedBy(divisor));
    }
  }
}

/** Hourly rate, derived from the daily rate and the standard paid day. */
export function hourlyRate(employee: EmployeeInput, settings: PayrollSettings): Decimal {
  if (employee.payType === 'HOURLY' && employee.hourlyRate != null) return money(dec(employee.hourlyRate));
  if (employee.employmentType === EmploymentType.HOURLY) return money(dec(employee.baseSalary));
  const standardHours = paidHoursPerDay(settings);
  if (standardHours.isZero()) return new Decimal(0);
  // 600 / 8 = 75 THB per hour.
  return money(dailyRate(employee, settings).dividedBy(standardHours));
}

// ---------------------------------------------------------------------------
// Statutory deductions
// ---------------------------------------------------------------------------

/**
 * Thai social security contribution.
 * The rate applies to the wage clamped between SSO_MIN_BASE and SSO_MAX_BASE,
 * and the result is additionally capped at SSO_MAX_CONTRIBUTION.
 */
export function calculateSocialSecurity(
  grossWage: Decimal,
  settings: PayrollSettings
): Decimal {
  if (!settings.boolean('SSO_ENABLED')) return new Decimal(0);

  const rate = settings.decimal('SSO_RATE');
  const minBase = settings.decimal('SSO_MIN_BASE');
  const maxBase = settings.decimal('SSO_MAX_BASE');
  const maxContribution = settings.decimal('SSO_MAX_CONTRIBUTION');

  if (grossWage.lessThanOrEqualTo(0)) return new Decimal(0);

  let contributionBase = grossWage;
  if (contributionBase.lessThan(minBase)) contributionBase = minBase;
  if (contributionBase.greaterThan(maxBase)) contributionBase = maxBase;

  const contribution = contributionBase.times(rate);
  return money(contribution.greaterThan(maxContribution) ? maxContribution : contribution);
}

/** Apply a progressive bracket ladder to an annual taxable income. */
export function applyTaxBrackets(annualTaxable: Decimal, brackets: TaxBracket[]): Decimal {
  if (annualTaxable.lessThanOrEqualTo(0)) return new Decimal(0);

  let remaining = annualTaxable;
  let lowerBound = new Decimal(0);
  let tax = new Decimal(0);

  for (const bracket of brackets) {
    if (remaining.lessThanOrEqualTo(0)) break;
    const upper = bracket.upTo === null ? null : dec(bracket.upTo);
    const bandWidth = upper === null ? remaining : upper.minus(lowerBound);
    const taxableInBand = remaining.greaterThan(bandWidth) ? bandWidth : remaining;
    if (taxableInBand.greaterThan(0)) {
      tax = tax.plus(taxableInBand.times(dec(bracket.rate)));
      remaining = remaining.minus(taxableInBand);
    }
    if (upper === null) break;
    lowerBound = upper;
  }

  return money(tax);
}

/**
 * Monthly withholding tax, computed by annualising the month's taxable income.
 *
 *   annual income  = (gross - social security) x 12
 *   expenses       = min(annual x TAX_EXPENSE_RATE, TAX_EXPENSE_CAP)
 *   taxable        = annual - expenses - TAX_PERSONAL_ALLOWANCE
 *   monthly tax    = brackets(taxable) / 12
 */
export function calculateTax(
  monthlyGross: Decimal,
  monthlySso: Decimal,
  settings: PayrollSettings,
  taxEnabled: boolean
): Decimal {
  if (!taxEnabled || !settings.boolean('TAX_ENABLED')) return new Decimal(0);

  const monthlyNetOfSso = monthlyGross.minus(monthlySso);
  if (monthlyNetOfSso.lessThanOrEqualTo(0)) return new Decimal(0);

  const annualIncome = monthlyNetOfSso.times(12);

  const expenseRate = settings.decimal('TAX_EXPENSE_RATE');
  const expenseCap = settings.decimal('TAX_EXPENSE_CAP');
  let expenses = annualIncome.times(expenseRate);
  if (expenses.greaterThan(expenseCap)) expenses = expenseCap;

  const personalAllowance = settings.decimal('TAX_PERSONAL_ALLOWANCE');

  const annualTaxable = annualIncome.minus(expenses).minus(personalAllowance);
  const annualTax = applyTaxBrackets(annualTaxable, settings.taxBrackets());

  return money(annualTax.dividedBy(12));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function calculatePayroll(
  input: CalculationInput,
  settings: PayrollSettings
): CalculationResult {
  const { employee, attendance } = input;
  const reviewNotes: string[] = [];

  // --- 1. attendance -> hours -------------------------------------------------
  const workingHours = minutesToHours(attendance.workedMinutes);
  const exactWorkingHours = dec(attendance.workedMinutes).dividedBy(60);
  const normalHours = minutesToHours(attendance.normalMinutes);
  const otWeekdayHours = minutesToHours(attendance.otWeekdayMinutes);
  const otWeekendHours = minutesToHours(attendance.otWeekendMinutes);
  const otHolidayHours = minutesToHours(attendance.otHolidayMinutes);
  const otHours = hours(otWeekdayHours.plus(otWeekendHours).plus(otHolidayHours));

  const rateDaily = dailyRate(employee, settings);
  const rateHourly = hourlyRate(employee, settings);

  // --- 2. base salary ---------------------------------------------------------
  let baseSalary: Decimal;
  switch (employee.employmentType) {
    case EmploymentType.DAILY:
      // New pay profiles define DAILY staff as minute-precise hourly pay. The
      // legacy daily-rate fallback remains only for historical snapshots/tests.
      baseSalary = employee.payType === 'HOURLY'
        ? money(rateHourly.times(exactWorkingHours))
        : money(rateDaily.times(attendance.presentDays));
      break;
    case EmploymentType.HOURLY:
      baseSalary = money(rateHourly.times(exactWorkingHours));
      break;
    default: {
      baseSalary = money(employee.payType === 'MONTHLY' && employee.monthlySalary != null
        ? dec(employee.monthlySalary)
        : dec(employee.baseSalary));
      // Pro-rate a partial month for a new hire or a leaver.
      const standardDays = settings.decimal('STANDARD_WORK_DAYS');
      if (
        settings.boolean('PRORATE_NEW_HIRES') &&
        employee.employedDays !== undefined &&
        attendance.workingDays > 0 &&
        employee.employedDays < attendance.workingDays &&
        !standardDays.isZero()
      ) {
        const ratio = dec(employee.employedDays).dividedBy(attendance.workingDays);
        baseSalary = money(baseSalary.times(ratio));
        reviewNotes.push(
          `คำนวณเงินเดือนตามสัดส่วน ${employee.employedDays}/${attendance.workingDays} วัน`
        );
      }
      break;
    }
  }

  // --- 3. OT ------------------------------------------------------------------
  const otEnabled = settings.boolean('OT_ENABLED') && employee.otEligible;
  const otWeekdayAmount = otEnabled
    ? money(rateHourly.times(settings.decimal('OT_RATE_WEEKDAY')).times(otWeekdayHours))
    : new Decimal(0);
  const otWeekendAmount = otEnabled
    ? money(rateHourly.times(settings.decimal('OT_RATE_WEEKEND')).times(otWeekendHours))
    : new Decimal(0);
  const otHolidayAmount = otEnabled
    ? money(rateHourly.times(settings.decimal('OT_RATE_HOLIDAY')).times(otHolidayHours))
    : new Decimal(0);
  const otAmount = money(otWeekdayAmount.plus(otWeekendAmount).plus(otHolidayAmount));

  // --- 4. manual income lines -------------------------------------------------
  const manualIncomes = input.manualIncomes ?? [];
  const sumByKind = (items: ManualItem[], kind: PayrollItemKind): Decimal =>
    items
      .filter((i) => i.kind === kind)
      .reduce<Decimal>((acc, i) => acc.plus(dec(i.amount)), new Decimal(0));

  const allowanceAmount = money(sumByKind(manualIncomes, PayrollItemKind.ALLOWANCE));
  const bonusAmount = money(sumByKind(manualIncomes, PayrollItemKind.BONUS));
  const commissionAmount = money(sumByKind(manualIncomes, PayrollItemKind.COMMISSION));
  const otherIncome = money(sumByKind(manualIncomes, PayrollItemKind.OTHER_INCOME));

  const grossIncome = money(
    baseSalary
      .plus(otAmount)
      .plus(allowanceAmount)
      .plus(bonusAmount)
      .plus(commissionAmount)
      .plus(otherIncome)
  );

  // --- 5. late deduction ------------------------------------------------------
  // Company policy charges lateness in whole-hour blocks: any positive lateness
  // inside the first hour costs one hour, 61 minutes costs two. The chargeable
  // hours are kept alongside the raw minutes so a payslip can be audited
  // against the attendance record.
  let lateDeduction = new Decimal(0);
  const lateMode = settings.string('LATE_DEDUCTION_MODE').toUpperCase();
  // Rounding up to whole hours refines how time-based lateness is priced, so it
  // applies to the PER_MINUTE path only. An installation that deliberately
  // chose PER_OCCURRENCE is charging per incident, not per elapsed minute, and
  // must keep doing so.
  const roundUpHours =
    settings.boolean('LATE_DEDUCTION_ROUND_UP_HOURS') && lateMode !== 'PER_OCCURRENCE';
  const chargeableLateHours = roundUpHours ? lateDeductionHours(attendance.lateMinutes) : 0;

  if (roundUpHours && chargeableLateHours > 0) {
    lateDeduction = money(rateHourly.times(chargeableLateHours));
  } else if (lateMode === 'PER_MINUTE' && attendance.lateMinutes > 0) {
    if (settings.boolean('LATE_DEDUCTION_USE_HOURLY_RATE')) {
      lateDeduction = money(rateHourly.dividedBy(60).times(attendance.lateMinutes));
    } else {
      lateDeduction = money(settings.decimal('LATE_DEDUCTION_AMOUNT').times(attendance.lateMinutes));
    }
  } else if (lateMode === 'PER_OCCURRENCE' && attendance.lateCount > 0) {
    lateDeduction = money(settings.decimal('LATE_DEDUCTION_AMOUNT').times(attendance.lateCount));
  }

  // --- 6. absence deduction ---------------------------------------------------
  // Unpaid leave is deducted on the same basis as an unexcused absence.
  const deductibleDays = dec(attendance.absentDays).plus(dec(attendance.unpaidLeaveDays));
  let absenceDeduction = new Decimal(0);
  const absenceMode = settings.string('ABSENCE_DEDUCTION_MODE').toUpperCase();
  if (deductibleDays.greaterThan(0)) {
    if (absenceMode === 'DAILY_RATE') {
      absenceDeduction = money(rateDaily.times(deductibleDays));
    } else if (absenceMode === 'FIXED') {
      absenceDeduction = money(settings.decimal('ABSENCE_DEDUCTION_AMOUNT').times(deductibleDays));
    }
  }

  // --- 7. statutory deductions ------------------------------------------------
  // The company enters social security and withholding tax by hand for now, so
  // a manually entered line is authoritative and no formula is invented. The
  // automatic calculation still runs when it is switched on and no manual line
  // was supplied; a manual entry always wins over it, because a human typing a
  // figure is a decision, not a suggestion.
  const manualDeductions = input.manualDeductions ?? [];
  const manualSocialSecurity = sumByKind(manualDeductions, PayrollItemKind.SOCIAL_SECURITY);
  const manualTax = sumByKind(manualDeductions, PayrollItemKind.TAX);

  const socialSecurity = manualSocialSecurity.greaterThan(0)
    ? money(manualSocialSecurity)
    : employee.ssoEnabled
      ? calculateSocialSecurity(grossIncome, settings)
      : new Decimal(0);

  const taxableGross = money(grossIncome.minus(lateDeduction).minus(absenceDeduction));
  const tax = manualTax.greaterThan(0)
    ? money(manualTax)
    : calculateTax(taxableGross, socialSecurity, settings, employee.taxEnabled);

  // --- 8. manual deduction lines ---------------------------------------------
  const loanDeduction = money(sumByKind(manualDeductions, PayrollItemKind.LOAN));
  const otherDeduction = money(sumByKind(manualDeductions, PayrollItemKind.OTHER_DEDUCTION));

  const totalDeduction = money(
    lateDeduction
      .plus(absenceDeduction)
      .plus(socialSecurity)
      .plus(tax)
      .plus(loanDeduction)
      .plus(otherDeduction)
  );

  // --- 9. net -----------------------------------------------------------------
  const netSalary = money(grossIncome.minus(totalDeduction));

  // --- 10. line items ---------------------------------------------------------
  const incomes: CalculatedLine[] = [
    {
      kind: PayrollItemKind.BASE_SALARY,
      label: 'เงินเดือนพื้นฐาน',
      quantity: null,
      rate: null,
      amount: baseSalary,
      isManual: false,
    },
  ];

  if (otWeekdayHours.greaterThan(0)) {
    incomes.push({
      kind: PayrollItemKind.OT,
      label: 'ค่าล่วงเวลา (วันธรรมดา)',
      quantity: otWeekdayHours,
      rate: money(rateHourly.times(settings.decimal('OT_RATE_WEEKDAY'))),
      amount: otWeekdayAmount,
      isManual: false,
    });
  }
  if (otWeekendHours.greaterThan(0)) {
    incomes.push({
      kind: PayrollItemKind.OT,
      label: 'ค่าล่วงเวลา (วันหยุดสุดสัปดาห์)',
      quantity: otWeekendHours,
      rate: money(rateHourly.times(settings.decimal('OT_RATE_WEEKEND'))),
      amount: otWeekendAmount,
      isManual: false,
    });
  }
  if (otHolidayHours.greaterThan(0)) {
    incomes.push({
      kind: PayrollItemKind.OT,
      label: 'ค่าล่วงเวลา (วันหยุดนักขัตฤกษ์)',
      quantity: otHolidayHours,
      rate: money(rateHourly.times(settings.decimal('OT_RATE_HOLIDAY'))),
      amount: otHolidayAmount,
      isManual: false,
    });
  }

  for (const item of manualIncomes) {
    incomes.push({
      kind: item.kind,
      label: item.label,
      quantity: item.quantity != null ? dec(item.quantity) : null,
      rate: item.rate != null ? dec(item.rate) : null,
      amount: money(item.amount),
      isManual: true,
    });
  }

  const deductions: CalculatedLine[] = [];
  if (lateDeduction.greaterThan(0)) {
    deductions.push({
      kind: PayrollItemKind.LATE,
      label: `หักมาสาย (${attendance.lateMinutes} นาที)`,
      quantity: dec(attendance.lateMinutes),
      rate: null,
      amount: lateDeduction,
      isManual: false,
    });
  }
  if (absenceDeduction.greaterThan(0)) {
    deductions.push({
      kind: PayrollItemKind.ABSENCE,
      label: `หักขาดงาน (${deductibleDays.toFixed(2)} วัน)`,
      quantity: deductibleDays,
      rate: rateDaily,
      amount: absenceDeduction,
      isManual: false,
    });
  }
  if (socialSecurity.greaterThan(0)) {
    deductions.push({
      kind: PayrollItemKind.SOCIAL_SECURITY,
      label: 'ประกันสังคม',
      quantity: null,
      rate: settings.decimal('SSO_RATE'),
      amount: socialSecurity,
      isManual: false,
    });
  }
  if (tax.greaterThan(0)) {
    deductions.push({
      kind: PayrollItemKind.TAX,
      label: 'ภาษีหัก ณ ที่จ่าย',
      quantity: null,
      rate: null,
      amount: tax,
      isManual: false,
    });
  }
  for (const item of manualDeductions) {
    deductions.push({
      kind: item.kind,
      label: item.label,
      quantity: item.quantity != null ? dec(item.quantity) : null,
      rate: item.rate != null ? dec(item.rate) : null,
      amount: money(item.amount),
      isManual: true,
    });
  }

  // --- 11. review status ------------------------------------------------------
  let status: PayrollEmployeeStatus = PayrollEmployeeStatus.READY;

  // Incomplete attendance is never silently treated as a normal day - it is
  // surfaced so a human decides, because guessing would misstate someone's pay.
  if ((employee.attendanceRequired ?? true) && attendance.missingDataDays > 0) {
    status = PayrollEmployeeStatus.MISSING_DATA;
    const parts: string[] = [];
    if (attendance.missingCheckInDays > 0) parts.push(`ไม่มีเวลาเข้า ${attendance.missingCheckInDays} วัน`);
    if (attendance.missingCheckOutDays > 0) parts.push(`ไม่มีเวลาออก ${attendance.missingCheckOutDays} วัน`);
    reviewNotes.push(
      `มีข้อมูลเข้า-ออกไม่ครบ ${attendance.missingDataDays} วัน` +
        (parts.length > 0 ? ` (${parts.join(', ')})` : '')
    );
  } else if ((employee.attendanceRequired ?? true) && attendance.presentDays === 0 && attendance.workingDays > 0) {
    status = PayrollEmployeeStatus.MISSING_DATA;
    reviewNotes.push('ไม่พบข้อมูลการลงเวลาในรอบนี้');
  }

  if (status === PayrollEmployeeStatus.READY) {
    if (netSalary.lessThan(0)) {
      status = PayrollEmployeeStatus.NEEDS_REVIEW;
      reviewNotes.push('เงินสุทธิติดลบ กรุณาตรวจสอบรายการหัก');
    } else if (attendance.absentDays > 0) {
      status = PayrollEmployeeStatus.NEEDS_REVIEW;
      reviewNotes.push(`ขาดงาน ${attendance.absentDays} วัน`);
    } else if (employee.employmentType === EmploymentType.DAILY &&
      (!employee.payType || dec(employee.hourlyRate ?? 0).lessThanOrEqualTo(0)) &&
      dec(employee.baseSalary).lessThanOrEqualTo(0)) {
      status = PayrollEmployeeStatus.NEEDS_REVIEW;
      reviewNotes.push('ยังไม่ได้กำหนดค่าจ้างพนักงานรายวัน — ยังไม่รวมค่าจ้างในยอดเงิน');
    } else if ((employee.payType === 'MONTHLY' && dec(employee.monthlySalary ?? 0).lessThanOrEqualTo(0)) ||
      (employee.payType === 'HOURLY' && dec(employee.hourlyRate ?? 0).lessThanOrEqualTo(0)) ||
      (!employee.payType && dec(employee.baseSalary).lessThanOrEqualTo(0))) {
      status = PayrollEmployeeStatus.NEEDS_REVIEW;
      reviewNotes.push('ยังไม่ได้กำหนดเงินเดือนพื้นฐาน');
    }
  }

  return {
    workingHours,
    normalHours,
    otHours,
    otWeekdayHours,
    otWeekendHours,
    otHolidayHours,
    hourlyRate: rateHourly,
    dailyRate: rateDaily,
    baseSalary,
    otAmount,
    allowanceAmount,
    bonusAmount,
    commissionAmount,
    otherIncome,
    grossIncome,
    lateDeduction,
    lateDeductionHours: chargeableLateHours,
    absenceDeduction,
    socialSecurity,
    tax,
    loanDeduction,
    otherDeduction,
    totalDeduction,
    netSalary,
    incomes,
    deductions,
    status,
    reviewNotes,
  };
}
