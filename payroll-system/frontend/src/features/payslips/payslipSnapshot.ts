import type { PayslipPayBasis, PayslipSnapshot } from '@/types';

/**
 * Reading a payslip snapshot that may predate the current shape.
 *
 * A snapshot is frozen when the payslip is issued, so a document issued before
 * a field existed will never gain it. During a deploy the running API can also
 * be a version behind the bundle asking it for data. Both produced the same
 * outage: the sheet read `snapshot.pay.kind`, threw a TypeError mid-render, and
 * React unmounted the subtree - so "ดูสลิปเงินเดือน" opened a blank dialog with
 * the reason visible only in the browser console.
 *
 * Kept as plain TypeScript, separate from the component, so the fallback can be
 * tested directly on the exact shapes that caused the failure.
 */

/** Payroll workflow states whose figures are not settled yet. */
export const DRAFT_STATUSES = ['DRAFT', 'ATTENDANCE_REVIEW', 'CALCULATED', 'REVIEW'];

/**
 * Recover the pay basis, falling back to what an older snapshot did carry.
 * A payslip that renders with a derived basis beats one that does not render.
 */
export function resolvePayBasis(snapshot: PayslipSnapshot): PayslipPayBasis {
  if (snapshot.pay) return snapshot.pay;

  const hourly =
    snapshot.employee?.employmentType === 'DAILY' ||
    snapshot.employee?.employmentType === 'HOURLY';
  const base = snapshot.incomes?.[0]?.amount ?? '0.00';
  const hours = Number(snapshot.attendance?.workingHours ?? 0);

  return {
    kind: hourly ? 'HOURLY' : 'MONTHLY',
    // Older snapshots stored no rate. Recovering it from pay ÷ hours is exact
    // for the hourly case, which is the only case that displays it.
    hourlyRate: hourly && hours > 0 ? (Number(base) / hours).toFixed(2) : null,
    monthlySalary: hourly ? null : base,
    // Not recoverable from an older snapshot. Zero is the signal to hide the
    // row rather than print a confident figure that was never computed.
    dailyBase: '0.00',
    hourlyBase: '0.00',
    workedMinutes: Math.round(hours * 60),
    // Not recoverable from an older snapshot: the break and the floor were not
    // recorded then. Left undefined so the sheet falls back to the single
    // figure rather than printing a fabricated zero as though it were paid time.
    breakDeductionMinutes: undefined,
    payableMinutes: undefined,
    payConfigured: Number(base) > 0,
  };
}

/**
 * Whether the document should be marked a draft.
 *
 * A snapshot from before period.status was captured is treated as settled:
 * stamping "ฉบับร่าง" across a real payslip is the more damaging of the two
 * possible mistakes.
 */
export function isDraftSnapshot(snapshot: PayslipSnapshot): boolean {
  const status = snapshot.period?.status;
  return status ? DRAFT_STATUSES.includes(status) : false;
}

/** True once the derived per-day and per-hour bases are worth showing. */
export function hasDerivedBases(pay: PayslipPayBasis): boolean {
  return Number(pay.dailyBase) > 0 || Number(pay.hourlyBase) > 0;
}
