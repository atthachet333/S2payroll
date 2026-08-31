import { EmployeeStatus, type Employee, type PayrollPeriod, type Prisma } from '@prisma/client';

/** One source of truth for whether an employee participates in a payroll period. */
export function isEmployeeEligibleForPayrollPeriod(
  employee: Pick<Employee, 'status' | 'startDate' | 'endDate'>,
  period: Pick<PayrollPeriod, 'startDate' | 'endDate'>
): boolean {
  return (employee.status === EmployeeStatus.ACTIVE || employee.status === EmployeeStatus.PROBATION) &&
    employee.startDate <= period.endDate &&
    (employee.endDate === null || employee.endDate >= period.startDate);
}

export function payrollEligibleEmployeeWhere(
  period: Pick<PayrollPeriod, 'startDate' | 'endDate'>
): Prisma.EmployeeWhereInput {
  return {
    status: { in: [EmployeeStatus.ACTIVE, EmployeeStatus.PROBATION] },
    startDate: { lte: period.endDate },
    OR: [{ endDate: null }, { endDate: { gte: period.startDate } }],
  };
}
