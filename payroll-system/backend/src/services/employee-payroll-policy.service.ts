import {
  AbsenceDeductionType,
  LateDeductionType,
  LeaveDeductionType,
  Prisma,
  type EmployeePayrollPolicy,
} from '@prisma/client';
import { prisma } from '../plugins/prisma.js';
import { notFound } from '../utils/errors.js';
import { recordAudit } from './audit.service.js';
import type { Actor } from './payroll.service.js';

/**
 * Per-employee payroll policy: how lateness, leave and absence are priced for
 * one person, plus the fixed social-security and tax amounts payroll enters by
 * hand.
 *
 * Precedence, applied by the calculator:
 *
 *   employee policy  ->  company PayrollSetting  ->  safe default
 *
 * Every field is optional. A null field is not a value, it is the absence of
 * one, and it makes the calculator fall through to the company setting. That is
 * what lets this table be introduced against live employees without changing a
 * single existing payslip. A stored 0 is the opposite: an explicit decision to
 * deduct nothing, and it wins over the company default.
 */

export interface PayrollPolicyInput {
  lateDeductionType?: LateDeductionType | null;
  lateDeductionAmount?: string | null;
  leaveDeductionType?: LeaveDeductionType | null;
  leaveDeductionAmount?: string | null;
  absenceDeductionType?: AbsenceDeductionType | null;
  absenceDeductionAmount?: string | null;
  socialSecurityAmount?: string | null;
  taxAmount?: string | null;
  note?: string | null;
}

const amount = (value: string | null | undefined): Prisma.Decimal | null =>
  value === null || value === undefined || value === '' ? null : new Prisma.Decimal(value);

/**
 * A type that needs a number is meaningless without one, so an amount-bearing
 * type with no amount is stored as 0 rather than as null - null would silently
 * fall back to the company rule and pay something the operator did not choose.
 */
function normalize(input: PayrollPolicyInput) {
  const lateType = input.lateDeductionType ?? null;
  const leaveType = input.leaveDeductionType ?? null;
  const absenceType = input.absenceDeductionType ?? null;
  const zeroIfFixed = (
    type: string | null,
    value: Prisma.Decimal | null
  ): Prisma.Decimal | null => (type === 'FIXED_AMOUNT' ? value ?? new Prisma.Decimal(0) : value);

  return {
    lateDeductionType: lateType,
    lateDeductionAmount: zeroIfFixed(lateType, amount(input.lateDeductionAmount)),
    leaveDeductionType: leaveType,
    leaveDeductionAmount: zeroIfFixed(leaveType, amount(input.leaveDeductionAmount)),
    absenceDeductionType: absenceType,
    absenceDeductionAmount: zeroIfFixed(absenceType, amount(input.absenceDeductionAmount)),
    socialSecurityAmount: amount(input.socialSecurityAmount),
    taxAmount: amount(input.taxAmount),
    note: input.note ?? null,
  };
}

export const getPayrollPolicy = (employeeId: string) =>
  prisma.employeePayrollPolicy.findUnique({ where: { employeeId } });

/** Policies for many employees at once, keyed by employee id. */
export async function payrollPoliciesByEmployee(
  employeeIds: string[]
): Promise<Map<string, EmployeePayrollPolicy>> {
  if (employeeIds.length === 0) return new Map();
  const rows = await prisma.employeePayrollPolicy.findMany({
    where: { employeeId: { in: employeeIds } },
  });
  return new Map(rows.map((row) => [row.employeeId, row]));
}

export async function upsertPayrollPolicy(
  employeeId: string,
  input: PayrollPolicyInput,
  actor: Actor
) {
  if (!(await prisma.employee.count({ where: { id: employeeId } }))) throw notFound('Employee');
  const existing = await prisma.employeePayrollPolicy.findUnique({ where: { employeeId } });
  const data = normalize(input);

  const policy = await prisma.employeePayrollPolicy.upsert({
    where: { employeeId },
    create: { employeeId, ...data, createdBy: actor.userId, updatedBy: actor.userId },
    update: { ...data, updatedBy: actor.userId },
  });

  await recordAudit({
    action: existing ? 'EMPLOYEE_PAYROLL_POLICY_UPDATE' : 'EMPLOYEE_PAYROLL_POLICY_CREATE',
    entity: 'EmployeePayrollPolicy',
    entityId: policy.id,
    oldValue: existing ? serialize(existing) : undefined,
    newValue: serialize(policy),
    userId: actor.userId,
    userEmail: actor.email,
    ipAddress: actor.ip,
    userAgent: actor.userAgent,
  });

  return policy;
}

const serialize = (policy: EmployeePayrollPolicy) => ({
  lateDeductionType: policy.lateDeductionType,
  lateDeductionAmount: policy.lateDeductionAmount?.toString() ?? null,
  leaveDeductionType: policy.leaveDeductionType,
  leaveDeductionAmount: policy.leaveDeductionAmount?.toString() ?? null,
  absenceDeductionType: policy.absenceDeductionType,
  absenceDeductionAmount: policy.absenceDeductionAmount?.toString() ?? null,
  socialSecurityAmount: policy.socialSecurityAmount?.toString() ?? null,
  taxAmount: policy.taxAmount?.toString() ?? null,
});

/** Employees with their pay profile and payroll policy, for the settings page. */
export async function listEmployeePayrollPolicies() {
  const employees = await prisma.employee.findMany({
    // Deactivated and terminated staff are not payable and must not appear in
    // any pay-settings list.
    where: { status: { in: ['ACTIVE', 'PROBATION'] } },
    orderBy: { employeeCode: 'asc' },
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      employmentType: true,
      attendanceRequired: true,
      leaveTrackingRequired: true,
      payrollPolicy: true,
    },
  });
  return employees.map(({ payrollPolicy, ...employee }) => ({
    ...employee,
    exempt: !employee.attendanceRequired && !employee.leaveTrackingRequired,
    policy: payrollPolicy,
  }));
}
