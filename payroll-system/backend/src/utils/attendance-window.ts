import { companyClock, formatDateOnly } from './datetime.js';
import type { PayrollSettings } from '../services/settings.service.js';

/**
 * When a work day is considered closed, and what an open punch means before and
 * after that moment.
 *
 * Lives in utils rather than beside the pre-payroll check because the readiness
 * screen, the period context loader and the calculator all need it; putting it
 * in any one of them would make the other two import that one.
 */

/** Minutes past midnight at which today's attendance stops being provisional. */
export function attendanceCloseMinutes(settings: PayrollSettings): number {
  const key = settings.string('MONTHLY_WORK_END_TIME') ? 'MONTHLY_WORK_END_TIME' : 'WORK_END_TIME';
  return settings.timeMinutes(key) + Math.max(0, settings.number('ATTENDANCE_CLOSE_GRACE_MINUTES'));
}

/**
 * A record with a check-in and no check-out is someone still at work if it is
 * today and the day has not closed; on any earlier day it is missing data.
 * The distinction is what lets an open period be previewed without every
 * in-progress day being reported as a fault.
 */
export function classifyOpenPunch(input: {
  workDate: Date;
  checkIn: Date | null;
  checkOut: Date | null;
  now?: Date;
  closeMinutes: number;
}): 'IN_PROGRESS' | 'MISSING_DATA' | null {
  if (!input.checkIn || input.checkOut) return null;
  const clock = companyClock(input.now);
  return formatDateOnly(input.workDate) === clock.date && clock.minutes < input.closeMinutes
    ? 'IN_PROGRESS'
    : 'MISSING_DATA';
}
