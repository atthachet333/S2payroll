import type { Employee, PayrollPeriod, Prisma } from '@prisma/client';

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
 * period. Current status is intentionally irrelevant; the employee workflow
 * requires an effective end date whenever somebody leaves.
 */
export function isEmployeeEligibleForPayrollPeriod(
  employee: Pick<Employee, 'startDate' | 'endDate'> & { reactivatedAt?: Date | null },
  period: Pick<PayrollPeriod, 'startDate' | 'endDate'>
): boolean {
  // Hired (or returned) after the period closed: nothing to pay.
  if (effectiveEmploymentStart(employee) > period.endDate) return false;

  // Left before the period opened: nothing to pay.
  if (employee.endDate !== null && employee.endDate < period.startDate) return false;

  return true;
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
    ],
  };
}

/**
 * Editable periods are live calculations and must follow current employment
 * dates. Finalised periods are immutable snapshots: later employee master-data
 * edits must never make an approved or paid row disappear from history.
 */
export function shouldApplyEmploymentOverlapToPayrollRows(
  period: Pick<PayrollPeriod, 'status'>
): boolean {
  return ['DRAFT', 'ATTENDANCE_REVIEW', 'CALCULATED', 'REVIEW'].includes(period.status);
}

const HIDDEN_CURRENT_EMPLOYEE_STATUSES = ['INACTIVE', 'TERMINATED'] as const;

/** Employee-side scope used by the current payroll page and its aggregates. */
export function payrollVisibleEmployeeWhere(
  period: Pick<PayrollPeriod, 'status' | 'startDate' | 'endDate'>,
  options: { includeInactive?: boolean } = {}
): Prisma.EmployeeWhereInput {
  if (!shouldApplyEmploymentOverlapToPayrollRows(period)) return {};
  return {
    AND: [
      payrollEligibleEmployeeWhere(period),
      ...(options.includeInactive
        ? []
        : [{ status: { notIn: [...HIDDEN_CURRENT_EMPLOYEE_STATUSES] } } as Prisma.EmployeeWhereInput]),
    ],
  };
}

/** Shared relation filter for payroll row lists, counts, totals and reports. */
export function payrollEmployeeVisibilityWhere(
  period: Pick<PayrollPeriod, 'status' | 'startDate' | 'endDate'>,
  extraEmployeeWhere?: Prisma.EmployeeWhereInput,
  options: { includeInactive?: boolean } = {}
): Prisma.PayrollEmployeeWhereInput {
  const employeeConditions: Prisma.EmployeeWhereInput[] = [];
  if (shouldApplyEmploymentOverlapToPayrollRows(period)) {
    employeeConditions.push(payrollVisibleEmployeeWhere(period, options));
  }
  if (extraEmployeeWhere) employeeConditions.push(extraEmployeeWhere);
  if (employeeConditions.length === 0) return {};
  return {
    employee: employeeConditions.length === 1
      ? employeeConditions[0]
      : { AND: employeeConditions },
  };
}

/** In-memory counterpart used when several periods are loaded in one query. */
export function visiblePayrollRowsForPeriod<T extends {
  employee: Pick<Employee, 'startDate' | 'endDate'> & { reactivatedAt?: Date | null; status?: string };
}>(
  rows: T[],
  period: Pick<PayrollPeriod, 'status' | 'startDate' | 'endDate'>,
  options: { includeInactive?: boolean } = {}
): T[] {
  if (!shouldApplyEmploymentOverlapToPayrollRows(period)) return rows;
  return rows.filter((row) =>
    isEmployeeEligibleForPayrollPeriod(row.employee, period) &&
    (options.includeInactive || !HIDDEN_CURRENT_EMPLOYEE_STATUSES.includes(
      row.employee.status as typeof HIDDEN_CURRENT_EMPLOYEE_STATUSES[number]
    ))
  );
}
