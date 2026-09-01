import type { PayrollSettings } from '../services/settings.service.js';

/**
 * The company's one time-rounding policy, and the only place it is implemented.
 *
 * Every attendance duration that reaches money is floored to the same interval:
 * daily worked time, lateness, early leave and approved overtime alike. Having
 * a second `Math.floor(x / 15)` anywhere else would be a rule nobody agreed to,
 * drifting by a few baht a day until a month closed.
 *
 * Two things this module never does:
 *
 *   - It never rounds up or to nearest. Paying for time not worked, or charging
 *     for lateness that did not happen, are not rounding errors the company
 *     accepted. FLOOR only.
 *
 *   - It never touches a stored punch. 08:37:42 stays 08:37:42 on the record
 *     for ever; rounding produces a *separate* derived figure alongside it, and
 *     every result below reports the actual value back so the two can be shown
 *     together. HR must be able to see what happened and what was paid, and the
 *     difference between them.
 */

/** How a duration was reduced, with the arithmetic left visible. */
export interface RoundedMinutes {
  /** The observed value, unchanged. */
  actualMinutes: number;
  /** The value after flooring to the interval. */
  roundedMinutes: number;
  /** actual - rounded. What the policy discarded. */
  roundedAwayMinutes: number;
}

/** The full daily work-time pipeline, every step retained for display. */
export interface RoundedWorkTime {
  /** The true observed duration. */
  actualMinutes: number;
  /** Unpaid break removed because the day passed the threshold. */
  breakDeductionMinutes: number;
  /** actual - break, before any rounding. */
  minutesBeforeRounding: number;
  /** What the floor discarded from minutesBeforeRounding. */
  roundedAwayMinutes: number;
  /** The minutes money is actually calculated from. */
  payableMinutes: number;
}

export interface WorkTimePolicy {
  /** Company-wide floor interval. TIME_ROUNDING_MINUTES. */
  roundingMinutes: number;
  /** A day longer than this loses a break. Strictly greater than. */
  breakThresholdMinutes: number;
  /** Unpaid break removed once the threshold is passed. */
  breakDeductionMinutes: number;
}

export const DEFAULT_ROUNDING_MINUTES = 15;

export const DEFAULT_WORK_TIME_POLICY: WorkTimePolicy = {
  roundingMinutes: DEFAULT_ROUNDING_MINUTES,
  breakThresholdMinutes: 480,
  breakDeductionMinutes: 60,
};

/** Intervals the settings screen offers. Any positive whole number is accepted. */
export const ROUNDING_INTERVAL_CHOICES = [1, 5, 10, 15, 30, 60];

/**
 * Floor a duration to an interval.
 *
 * A non-positive interval means "no rounding configured" rather than a division
 * by zero, and a nonsensical input yields 0 rather than a negative wage.
 */
export function floorToInterval(minutes: number, interval: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  if (!Number.isFinite(interval) || interval <= 0) return Math.floor(minutes);
  return Math.floor(minutes / interval) * interval;
}

/**
 * Round one duration down, keeping the actual value and the discarded remainder
 * so a screen can explain the difference without recomputing anything.
 */
export function roundDownMinutes(minutes: number, interval: number): RoundedMinutes {
  const actualMinutes = Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 0;
  const roundedMinutes = floorToInterval(actualMinutes, interval);
  return {
    actualMinutes,
    roundedMinutes,
    roundedAwayMinutes: actualMinutes - roundedMinutes,
  };
}

/**
 * The DAILY work-time pipeline: break first, then floor.
 *
 * Order matters and is fixed here. Flooring before deducting the break would
 * give a different answer on many durations, and applying the floor twice - once
 * here and once by a caller - would quietly shave a second interval off every
 * day. This is the only implementation.
 *
 *   628 actual -> 60 break -> 568 before rounding -> 13 away -> 555 payable
 */
export function calculateRoundedWorkTime(
  workedMinutes: number,
  policy: WorkTimePolicy = DEFAULT_WORK_TIME_POLICY
): RoundedWorkTime {
  const actualMinutes =
    Number.isFinite(workedMinutes) && workedMinutes > 0 ? Math.floor(workedMinutes) : 0;

  // Strictly greater than: a day of exactly the threshold keeps every minute.
  const breakDeductionMinutes =
    actualMinutes > policy.breakThresholdMinutes ? Math.max(0, policy.breakDeductionMinutes) : 0;

  const minutesBeforeRounding = Math.max(0, actualMinutes - breakDeductionMinutes);
  const payableMinutes = floorToInterval(minutesBeforeRounding, policy.roundingMinutes);

  return {
    actualMinutes,
    breakDeductionMinutes,
    minutesBeforeRounding,
    roundedAwayMinutes: minutesBeforeRounding - payableMinutes,
    payableMinutes,
  };
}

/**
 * The company-wide interval.
 *
 * TIME_ROUNDING_MINUTES is the single authority. DAILY_PAY_ROUNDING_MINUTES is
 * withdrawn and no longer read - two settings that could disagree about the same
 * rule is exactly the situation this module exists to prevent.
 */
export function roundingIntervalMinutes(settings: PayrollSettings): number {
  const value = settings.number('TIME_ROUNDING_MINUTES');
  // A zero or negative interval is not a policy anyone stated; falling back
  // beats silently paying to the minute.
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_ROUNDING_MINUTES;
}

export function workTimePolicy(settings: PayrollSettings): WorkTimePolicy {
  const read = (key: string, fallback: number) => {
    const value = settings.number(key);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    roundingMinutes: roundingIntervalMinutes(settings),
    breakThresholdMinutes: read(
      'DAILY_BREAK_THRESHOLD_MINUTES',
      DEFAULT_WORK_TIME_POLICY.breakThresholdMinutes
    ),
    breakDeductionMinutes: read(
      'DAILY_BREAK_DEDUCTION_MINUTES',
      DEFAULT_WORK_TIME_POLICY.breakDeductionMinutes
    ),
  };
}

/**
 * Chargeable lateness, in whole hours.
 *
 * The documented ordering, applied in exactly this sequence:
 *
 *   1. floor the observed lateness to the company interval
 *   2. ceil what remains to whole hours
 *
 * Both steps are deliberate and they pull in opposite directions, which is why
 * the order is pinned rather than left to whichever call site runs first:
 *
 *   10 late -> floor 0  -> 0 hours   (under the interval, nothing is charged)
 *   16 late -> floor 15 -> 1 hour
 *   59 late -> floor 45 -> 1 hour
 *   61 late -> floor 60 -> 1 hour
 *   76 late -> floor 75 -> 2 hours
 *
 * Applying the hour ceiling to the raw minutes instead would charge an hour for
 * being ten minutes late, which the interval policy is meant to forgive.
 */
export function chargeableLateHours(lateMinutes: number, interval: number): number {
  const rounded = floorToInterval(lateMinutes, interval);
  if (rounded <= 0) return 0;
  return Math.ceil(rounded / 60);
}

/** "10 ชม. 28 นาที" for a duration in minutes. */
export function formatMinutesThai(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  return `${Math.floor(safe / 60)} ชม. ${safe % 60} นาที`;
}
