import { EmployeeStatus, type Employee, type PayrollPeriod, type Prisma } from '@prisma/client';

/**
 * The date an employee's *current* spell of employment began.
 *
 * start_date is the original hire date and never changes - it is the person's
 * history, and the employee page shows it. When somebody is deactivated and
 * later restored, reactivated_at records the return-to-work date, and payroll
 * measures from there. Without this, clearing end_date on a restore would make
 * the returning employee eligible for every period they were away for, and a
 * recalculation of one of those months would quietly pay them for it.
 */
export function effectiveEmploymentStart(
  employee: Pick<Employee, 'startDate'> & { reactivatedAt?: Date | null }
): Date {
  const reactivated = employee.reactivatedAt ?? null;
  if (reactivated && reactivated > employee.startDate) return reactivated;
  return employee.startDate;
}

/** Statuses that mean the person is on the payroll right now. */
const WORKING_STATUSES: EmployeeStatus[] = [EmployeeStatus.ACTIVE, EmployeeStatus.PROBATION];

/**
 * Whether an employee participates in a payroll period.
 *
 * Eligibility is a question about *dates*, not about status today. Somebody who
 * resigned on 25 August worked for most of the August period and must still be
 * paid for it; excluding them because they are INACTIVE now would silently drop
 * real worked days from the run - and would do so on the next recalculation,
 * long after anyone was watching.
 *
 * So the rule is an overlap between the employment period and the payroll
 * period, with one guard: a departed employee is only included when an end date
 * actually records when they left. A former employee with no end date has no
 * boundary at all, and including them would put someone who left years ago into
 * every period forever. That case is excluded and surfaces in the readiness
 * screen as missing data, which is the honest outcome - the fix is to record
 * the end date, not to guess it.
 */
export function isEmployeeEligibleForPayrollPeriod(
  employee: Pick<Employee, 'status' | 'startDate' | 'endDate'> & { reactivatedAt?: Date | null },
  period: Pick<PayrollPeriod, 'startDate' | 'endDate'>
): boolean {
  // Hired (or returned) after the period closed: nothing to pay.
  if (effectiveEmploymentStart(employee) > period.endDate) return false;

  // Left before the period opened: nothing to pay.
  if (employee.endDate !== null && employee.endDate < period.startDate) return false;

  if (WORKING_STATUSES.includes(employee.status)) return true;

  // Departed. Payable for this period only if their leaving date says they were
  // still employed during part of it.
  return employee.endDate !== null;
}

export function payrollEligibleEmployeeWhere(
  period: Pick<PayrollPeriod, 'startDate' | 'endDate'>
): Prisma.EmployeeWhereInput {
  return {
    AND: [
      // Employment (current spell) began on or before the period closed. The
      // database cannot take max(start_date, reactivated_at) in a where clause,
      // so the same rule is expressed as a branch.
      {
        OR: [
          { reactivatedAt: null, startDate: { lte: period.endDate } },
          { reactivatedAt: { lte: period.endDate } },
        ],
      },
      // Employment had not already ended before the period opened.
      { OR: [{ endDate: null }, { endDate: { gte: period.startDate } }] },
      // Either still working, or departed with a recorded leaving date.
      {
        OR: [
          { status: { in: WORKING_STATUSES } },
          { endDate: { not: null } },
        ],
      },
    ],
  };
}
