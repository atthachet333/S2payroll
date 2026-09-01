import { Decimal, dec, money } from './money.js';
import { lateDeductionHours } from './attendance-math.js';
import type { PayrollSettings } from '../services/settings.service.js';

/**
 * How lateness, leave and absence turn into money.
 *
 * This is the only place those three formulas exist. The monthly payroll
 * calculator and the per-day attendance valuation both price through it, so the
 * "ได้เงินวันนี้" a user reads on the Attendance page and the deduction that
 * later lands on their payslip cannot be computed two different ways. Duplicating
 * a formula here would be a bug that only shows up as a few baht of drift at the
 * end of a month, which is the hardest kind to notice and the worst kind to have.
 *
 * Precedence, applied by every function below:
 *
 *   employee policy  ->  company PayrollSetting  ->  safe default
 *
 * A policy field that is null is not a value, it is the absence of one, and it
 * falls through to the company rule. A stored 0 is an explicit decision to
 * deduct nothing and wins outright.
 */

export type LateDeductionMode = 'NONE' | 'PER_HOUR_FROM_BASE' | 'FIXED_AMOUNT';
export type LeaveDeductionMode = 'NONE' | 'PER_DAY_FROM_BASE' | 'FIXED_AMOUNT';
export type AbsenceDeductionMode = 'NONE' | 'PER_DAY_FROM_BASE' | 'FIXED_AMOUNT';

export interface DeductionPolicyView {
  lateDeductionType?: LateDeductionMode | null;
  lateDeductionAmount?: Decimal | string | number | null;
  leaveDeductionType?: LeaveDeductionMode | null;
  leaveDeductionAmount?: Decimal | string | number | null;
  absenceDeductionType?: AbsenceDeductionMode | null;
  absenceDeductionAmount?: Decimal | string | number | null;
  socialSecurityAmount?: Decimal | string | number | null;
  taxAmount?: Decimal | string | number | null;
}

export interface LateChargeInput {
  /** Observed lateness, for display and for the per-occurrence company path. */
  lateMinutes: number;
  /**
   * Lateness after the company-wide floor. This is what money is charged from:
   * the interval policy is meant to forgive a few minutes, and charging the raw
   * value would defeat it.
   */
  roundedLateMinutes: number;
  lateCount: number;
  /** Hourly base the employee policy prices against (salary / 30 / 8). */
  hourlyBase: Decimal;
  /** Legacy company-path rate, kept so an unset policy behaves exactly as before. */
  hourlyRate: Decimal;
}

export interface LateCharge {
  amount: Decimal;
  /** Whole-hour blocks actually billed: ceil(lateMinutes / 60). */
  chargedHours: number;
}

/**
 * Company policy charges lateness in whole-hour blocks: any positive lateness
 * inside the first hour costs one hour, 61 minutes costs two. The chargeable
 * hours are returned alongside the amount so a payslip can be audited against
 * the raw minutes on the attendance record.
 */
export function priceLateDeduction(
  policy: DeductionPolicyView | null | undefined,
  settings: PayrollSettings,
  input: LateChargeInput
): LateCharge {
  // The documented ordering: floor to the company interval first, then ceil
  // what remains to whole hours. Applying the hour ceiling to raw minutes would
  // charge a full hour for being ten minutes late.
  const chargeableHours = lateDeductionHours(input.roundedLateMinutes);

  if (policy?.lateDeductionType) {
    switch (policy.lateDeductionType) {
      case 'PER_HOUR_FROM_BASE':
        // 18,000 / 30 / 8 = 75 an hour; 10 minutes late costs one block.
        return { amount: money(input.hourlyBase.times(chargeableHours)), chargedHours: chargeableHours };
      case 'FIXED_AMOUNT':
        // The chargeable unit for lateness is the whole-hour block, so a fixed
        // amount is charged per block. Under an hour that is one flat charge,
        // which is what the Settings screen states.
        return {
          amount: money(dec(policy.lateDeductionAmount ?? 0).times(chargeableHours)),
          chargedHours: chargeableHours,
        };
      case 'NONE':
      default:
        return { amount: new Decimal(0), chargedHours: 0 };
    }
  }

  // No employee policy: reproduce the company path exactly as it behaved before
  // employee policies existed, so adding this table changes nobody's pay.
  const mode = settings.string('LATE_DEDUCTION_MODE').toUpperCase();
  // Rounding to whole hours refines how time-based lateness is priced, so it
  // applies to the PER_MINUTE path only. An installation that deliberately chose
  // PER_OCCURRENCE is charging per incident, not per elapsed minute.
  const roundUpHours = settings.boolean('LATE_DEDUCTION_ROUND_UP_HOURS') && mode !== 'PER_OCCURRENCE';

  if (roundUpHours && chargeableHours > 0) {
    return { amount: money(input.hourlyRate.times(chargeableHours)), chargedHours: chargeableHours };
  }
  if (mode === 'PER_MINUTE' && input.roundedLateMinutes > 0) {
    // Priced from the rounded minutes as well - one interval policy, applied
    // to every path that turns lateness into money.
    const amount = settings.boolean('LATE_DEDUCTION_USE_HOURLY_RATE')
      ? money(input.hourlyRate.dividedBy(60).times(input.roundedLateMinutes))
      : money(settings.decimal('LATE_DEDUCTION_AMOUNT').times(input.roundedLateMinutes));
    return { amount, chargedHours: 0 };
  }
  if (mode === 'PER_OCCURRENCE' && input.lateCount > 0) {
    return {
      amount: money(settings.decimal('LATE_DEDUCTION_AMOUNT').times(input.lateCount)),
      chargedHours: 0,
    };
  }
  return { amount: new Decimal(0), chargedHours: 0 };
}

export interface DayChargeInput {
  /** Number of days being charged. Fractional days are supported. */
  days: Decimal | string | number;
  /** Daily base the employee policy prices against (salary / 30). */
  dailyBase: Decimal;
  /** Legacy company-path rate, kept so an unset policy behaves exactly as before. */
  dailyRate: Decimal;
}

/**
 * Unpaid leave.
 *
 * Only leave the record itself marks unpaid can ever reach this function -
 * approved paid leave is not an absence and is never charged. The policy then
 * decides whether even unpaid leave is charged, and on what basis.
 */
export function priceLeaveDeduction(
  policy: DeductionPolicyView | null | undefined,
  settings: PayrollSettings,
  input: DayChargeInput
): Decimal {
  const days = dec(input.days);
  if (days.lessThanOrEqualTo(0)) return new Decimal(0);

  if (policy?.leaveDeductionType) {
    if (policy.leaveDeductionType === 'PER_DAY_FROM_BASE') return money(input.dailyBase.times(days));
    if (policy.leaveDeductionType === 'FIXED_AMOUNT') {
      return money(dec(policy.leaveDeductionAmount ?? 0).times(days));
    }
    return new Decimal(0);
  }

  // No employee policy: the previous company rule charged unpaid leave on
  // exactly the same basis as an unexcused absence.
  return companyDayCharge(settings, days, input.dailyRate);
}

/** Unexcused absence. Approved paid leave never routes here. */
export function priceAbsenceDeduction(
  policy: DeductionPolicyView | null | undefined,
  settings: PayrollSettings,
  input: DayChargeInput
): Decimal {
  const days = dec(input.days);
  if (days.lessThanOrEqualTo(0)) return new Decimal(0);

  if (policy?.absenceDeductionType) {
    // 18,000 / 30 = 600 a day; two absent days cost 1,200.
    if (policy.absenceDeductionType === 'PER_DAY_FROM_BASE') return money(input.dailyBase.times(days));
    if (policy.absenceDeductionType === 'FIXED_AMOUNT') {
      return money(dec(policy.absenceDeductionAmount ?? 0).times(days));
    }
    return new Decimal(0);
  }

  return companyDayCharge(settings, days, input.dailyRate);
}

function companyDayCharge(settings: PayrollSettings, days: Decimal, dailyRate: Decimal): Decimal {
  const mode = settings.string('ABSENCE_DEDUCTION_MODE').toUpperCase();
  if (mode === 'DAILY_RATE') return money(dailyRate.times(days));
  if (mode === 'FIXED') return money(settings.decimal('ABSENCE_DEDUCTION_AMOUNT').times(days));
  return new Decimal(0);
}
