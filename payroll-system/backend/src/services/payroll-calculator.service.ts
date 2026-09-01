import { EmploymentType, PayrollEmployeeStatus, PayrollItemKind } from '@prisma/client';
import { Decimal, dec, money, minutesToHours, hours } from '../utils/money.js';
import type { PayrollSettings, TaxBracket } from './settings.service.js';
import {
  priceAbsenceDeduction,
  priceLateDeduction,
  priceLeaveDeduction,
} from '../utils/deduction-pricing.js';
import { resolveReadiness } from '../utils/payroll-readiness.js';

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
  /**
   * Per-employee overrides. A null field means "not configured for this
   * employee" and falls through to the company setting; a 0 means "deduct
   * nothing" and wins. Absent entirely, every rule behaves exactly as it did
   * before employee policies existed.
   */
  policy?: EmployeePolicyView | null;
  /**
   * False when no usable wage rate was found for this employee in this period.
   * The result is then worked time with no money attached - never a salary.
   */
  payConfigured?: boolean;
  /** True for staff excluded from payroll by company policy. */
  excluded?: boolean;
}

export type LateDeductionMode = 'NONE' | 'PER_HOUR_FROM_BASE' | 'FIXED_AMOUNT';
export type LeaveDeductionMode = 'NONE' | 'PER_DAY_FROM_BASE' | 'FIXED_AMOUNT';
export type AbsenceDeductionMode = 'NONE' | 'PER_DAY_FROM_BASE' | 'FIXED_AMOUNT';

export interface EmployeePolicyView {
  lateDeductionType?: LateDeductionMode | null;
  lateDeductionAmount?: Decimal | string | number | null;
  leaveDeductionType?: LeaveDeductionMode | null;
  leaveDeductionAmount?: Decimal | string | number | null;
  absenceDeductionType?: AbsenceDeductionMode | null;
  absenceDeductionAmount?: Decimal | string | number | null;
  socialSecurityAmount?: Decimal | string | number | null;
  taxAmount?: Decimal | string | number | null;
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
  /** Observed lateness. Kept so a screen can show what actually happened. */
  lateMinutes: number;
  /**
   * Lateness after the company floor, summed per day. This, not lateMinutes,
   * is what money is charged from - see chargeableLateHours for the ordering.
   */
  roundedLateMinutes: number;
  /** Observed and floored early leave, reported separately for the same reason. */
  earlyLeaveMinutes: number;
  roundedEarlyLeaveMinutes: number;
  /** Approved OT before the floor, so the discarded remainder stays visible. */
  actualOtMinutes: number;
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
  /**
   * Pre-computed per-day pay for hourly staff, priced day by day at the rate in
   * force on each work date. When present it is authoritative for the base pay
   * of a DAILY/HOURLY employee - the calculator does not reprice a whole month
   * at today's rate.
   */
  dailyEarnings?: DailyEarningsInput;
  /** True while the period is still open, so figures are a preview. */
  isEstimate?: boolean;
}

export interface DailyEarningsInput {
  /** Sum of every day priced at the rate in force on that day. */
  amount: Decimal | string | number;
  /** The true observed duration across the period. */
  totalWorkedMinutes: number;
  /** Unpaid breaks removed for days past the eight-hour threshold. */
  totalBreakDeductionMinutes: number;
  /** Minutes actually paid for, after the break and the company floor. */
  totalPayableMinutes: number;
  /** What the floor discarded across the period. */
  totalRoundedAwayMinutes: number;
  ratedMinutes: number;
  unratedMinutes: number;
  unratedDays: number;
  workedDays: number;
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
  /** Display bases for a monthly salary: salary / divisor, and that / hours. */
  dailyBase: Decimal;
  hourlyBase: Decimal;

  baseSalary: Decimal;
  otAmount: Decimal;
  allowanceAmount: Decimal;
  bonusAmount: Decimal;
  commissionAmount: Decimal;
  otherIncome: Decimal;
  grossIncome: Decimal;

  /**
   * DAILY only. Worked time became paid time by losing an unpaid break and
   * being floored to a 15-minute increment; both figures are reported so a
   * payslip can show the derivation. Zero for MONTHLY, whose salary does not
   * come from an hourly count.
   */
  breakDeductionMinutes: number;
  payableMinutes: number;
  /** What the company interval discarded from the daily worked time. */
  roundedAwayMinutes: number;
  /** Lateness after the floor, and early leave observed and floored. */
  roundedLateMinutes: number;
  earlyLeaveMinutes: number;
  roundedEarlyLeaveMinutes: number;
  /** Approved OT before the floor, so the discarded remainder stays visible. */
  actualOtMinutes: number;

  lateDeduction: Decimal;
  /** Whole-hour blocks charged for lateness: ceil(lateMinutes / 60). */
  lateDeductionHours: number;
  /** Unpaid leave, priced separately from absence by its own employee policy. */
  leaveDeduction: Decimal;
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
  /** False when no wage rate was known - the amounts are not a final salary. */
  payConfigured: boolean;
  /** True when the figures are a preview rather than a settled amount. */
  isEstimate: boolean;
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
  // employee_pay_profiles is the canonical source of compensation. The legacy
  // employees.base_salary column is only a fallback for records that predate
  // pay profiles; reading it in preference would let the two disagree.
  const base =
    employee.payType === 'MONTHLY' && employee.monthlySalary != null
      ? dec(employee.monthlySalary)
      : dec(employee.baseSalary);
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

/**
 * Does this employee have a wage rate at all?
 *
 * The pay profile is canonical; employees.base_salary is only consulted as the
 * legacy fallback for records that predate pay profiles. Zero is not a rate -
 * it is the absence of one, and paying against it would state a salary of 0 as
 * though it were a real figure.
 */
function hasUsableRate(employee: EmployeeInput): boolean {
  if (employee.payType === 'MONTHLY') return dec(employee.monthlySalary ?? 0).greaterThan(0);
  if (employee.payType === 'HOURLY') return dec(employee.hourlyRate ?? 0).greaterThan(0);
  return dec(employee.baseSalary).greaterThan(0);
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
  // Named separately from the rates because they are what the UI shows and what
  // the deduction policies price against: 18,000 / 30 = 600 a day, 600 / 8 = 75
  // an hour. For hourly staff they are the stored rate and its standard day.
  const dailyBase = rateDaily;
  const hourlyBase = rateHourly;

  // --- 2. base salary ---------------------------------------------------------
  let baseSalary: Decimal;
  switch (employee.employmentType) {
    case EmploymentType.DAILY:
    case EmploymentType.HOURLY:
      // Per-day earnings are authoritative when supplied: each day was already
      // priced at the rate in force on that date, so a mid-month rise does not
      // reprice the days before it. Falling back to one flat rate for the whole
      // month is the legacy path, kept for historical snapshots and tests.
      if (input.dailyEarnings) {
        baseSalary = money(dec(input.dailyEarnings.amount));
      } else if (employee.payType === 'HOURLY' || employee.employmentType === EmploymentType.HOURLY) {
        baseSalary = money(rateHourly.times(exactWorkingHours));
      } else {
        baseSalary = money(rateDaily.times(attendance.presentDays));
      }
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
  // Priced by the shared deduction module, which the per-day attendance
  // valuation also calls. One formula, two callers - so the money a user sees
  // on the Attendance page and the deduction on their payslip cannot diverge.
  const policy = employee.policy ?? null;
  const lateCharge = priceLateDeduction(policy, settings, {
    lateMinutes: attendance.lateMinutes,
    roundedLateMinutes: attendance.roundedLateMinutes,
    lateCount: attendance.lateCount,
    hourlyBase,
    hourlyRate: rateHourly,
  });
  const lateDeduction = lateCharge.amount;
  const lateChargedHours = lateCharge.chargedHours;

  // --- 6. leave and absence ---------------------------------------------------
  // Leave and absence are two different facts priced by two different employee
  // policies. Approved paid leave is never an absence, so only leave the record
  // itself marks unpaid can be charged at all.
  const absentDays = dec(attendance.absentDays);
  const chargeableLeaveDays = dec(attendance.unpaidLeaveDays);

  const leaveDeduction = priceLeaveDeduction(policy, settings, {
    days: chargeableLeaveDays,
    dailyBase,
    dailyRate: rateDaily,
  });
  const absenceDeduction = priceAbsenceDeduction(policy, settings, {
    days: absentDays,
    dailyBase,
    dailyRate: rateDaily,
  });

  // --- 7. statutory deductions ------------------------------------------------
  // The company enters social security and withholding tax by hand for now, so
  // a manually entered line is authoritative and no formula is invented. The
  // automatic calculation still runs when it is switched on and no manual line
  // was supplied; a manual entry always wins over it, because a human typing a
  // figure is a decision, not a suggestion.
  const manualDeductions = input.manualDeductions ?? [];
  const manualSocialSecurity = sumByKind(manualDeductions, PayrollItemKind.SOCIAL_SECURITY);
  const manualTax = sumByKind(manualDeductions, PayrollItemKind.TAX);

  // Order of authority: a manual line on this payroll row, then the fixed
  // amount configured on the employee, then the company formula. A configured
  // 0 is a decision to deduct nothing and is honoured as such - only an absent
  // (null) value falls through to the formula.
  const policySso = policy?.socialSecurityAmount;
  const policyTax = policy?.taxAmount;

  const socialSecurity = manualSocialSecurity.greaterThan(0)
    ? money(manualSocialSecurity)
    : policySso !== null && policySso !== undefined
      ? money(dec(policySso))
      : employee.ssoEnabled
        ? calculateSocialSecurity(grossIncome, settings)
        : new Decimal(0);

  const taxableGross = money(
    grossIncome.minus(lateDeduction).minus(leaveDeduction).minus(absenceDeduction)
  );
  const tax = manualTax.greaterThan(0)
    ? money(manualTax)
    : policyTax !== null && policyTax !== undefined
      ? money(dec(policyTax))
      : calculateTax(taxableGross, socialSecurity, settings, employee.taxEnabled);

  // --- 8. manual deduction lines ---------------------------------------------
  const loanDeduction = money(sumByKind(manualDeductions, PayrollItemKind.LOAN));
  const otherDeduction = money(sumByKind(manualDeductions, PayrollItemKind.OTHER_DEDUCTION));

  const totalDeduction = money(
    lateDeduction
      .plus(leaveDeduction)
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
    // The label carries the observed minutes and, when the charge is priced in
    // whole-hour blocks, the number of blocks actually billed - so the payslip
    // explains why 10 minutes late cost an hour.
    const lateLabel =
      lateChargedHours > 0
        ? `หักมาสาย (${attendance.lateMinutes} นาที · คิด ${lateChargedHours} ชั่วโมง)`
        : `หักมาสาย (${attendance.lateMinutes} นาที)`;
    deductions.push({
      kind: PayrollItemKind.LATE,
      label: lateLabel,
      quantity: dec(attendance.lateMinutes),
      rate: lateChargedHours > 0 ? hourlyBase : null,
      amount: lateDeduction,
      isManual: false,
    });
  }
  if (leaveDeduction.greaterThan(0)) {
    deductions.push({
      kind: PayrollItemKind.LEAVE,
      label: `หักลา (${chargeableLeaveDays.toFixed(2)} วัน)`,
      quantity: chargeableLeaveDays,
      rate: dailyBase,
      amount: leaveDeduction,
      isManual: false,
    });
  }
  if (absenceDeduction.greaterThan(0)) {
    deductions.push({
      kind: PayrollItemKind.ABSENCE,
      label: `หักขาดงาน (${absentDays.toFixed(2)} วัน)`,
      quantity: absentDays,
      rate: dailyBase,
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

  // --- 11. readiness status ----------------------------------------------------
  // Resolved by the shared readiness module, on the same inputs the pre-payroll
  // check uses, so the readiness screen and the calculated row always agree.
  const attendanceRequired = employee.attendanceRequired ?? true;
  // The period loader knows whether a rate covers this period and passes the
  // answer in. When the calculator is driven directly it works the answer out
  // from the rate inputs it was given, so a standalone call cannot accidentally
  // report an employee with no wage as ready to be paid.
  const payConfigured = employee.payConfigured ?? hasUsableRate(employee);
  const unratedDays = input.dailyEarnings?.unratedDays ?? 0;
  const readiness = resolveReadiness({
    employmentType: employee.employmentType,
    excluded: Boolean(employee.excluded),
    payConfigured,
    attendanceRequired,
    missingDataDays: attendance.missingDataDays,
    missingCheckInDays: attendance.missingCheckInDays,
    missingCheckOutDays: attendance.missingCheckOutDays,
    presentDays: attendance.presentDays,
    workingDays: attendance.workingDays,
    absentDays: attendance.absentDays,
    unratedDays,
    netNegative: netSalary.lessThan(0),
    isEstimate: Boolean(input.isEstimate),
  });
  const status = readiness.status;
  reviewNotes.push(...readiness.reasons);

  return {
    workingHours,
    normalHours,
    otHours,
    otWeekdayHours,
    otWeekendHours,
    otHolidayHours,
    hourlyRate: rateHourly,
    dailyRate: rateDaily,
    dailyBase,
    hourlyBase,
    breakDeductionMinutes: input.dailyEarnings?.totalBreakDeductionMinutes ?? 0,
    payableMinutes: input.dailyEarnings?.totalPayableMinutes ?? 0,
    roundedAwayMinutes: input.dailyEarnings?.totalRoundedAwayMinutes ?? 0,
    roundedLateMinutes: attendance.roundedLateMinutes,
    earlyLeaveMinutes: attendance.earlyLeaveMinutes,
    roundedEarlyLeaveMinutes: attendance.roundedEarlyLeaveMinutes,
    actualOtMinutes: attendance.actualOtMinutes,
    baseSalary,
    otAmount,
    allowanceAmount,
    bonusAmount,
    commissionAmount,
    otherIncome,
    grossIncome,
    lateDeduction,
    lateDeductionHours: lateChargedHours,
    leaveDeduction,
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
    payConfigured,
    isEstimate: Boolean(input.isEstimate) || unratedDays > 0 || !payConfigured,
  };
}
