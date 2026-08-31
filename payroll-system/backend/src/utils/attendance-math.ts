/**
 * Pure attendance arithmetic shared by the attendance engine and the payroll
 * calculator. Kept free of Prisma and settings so the calculator stays a pure,
 * fully unit-testable module.
 */

/**
 * Lateness charged in whole-hour blocks.
 *
 * Company policy: any positive lateness inside the first hour costs one hour,
 * 61 minutes costs two, 121 costs three. Deliberately separate from the raw
 * lateMinutes - the minutes are the observed fact and remain auditable, the
 * hours are the chargeable quantity that reaches money.
 *
 *   1  -> 1     40 -> 1     60  -> 1
 *   61 -> 2     120 -> 2    121 -> 3
 */
export function lateDeductionHours(lateMinutes: number): number {
  if (!Number.isFinite(lateMinutes) || lateMinutes <= 0) return 0;
  return Math.ceil(lateMinutes / 60);
}
