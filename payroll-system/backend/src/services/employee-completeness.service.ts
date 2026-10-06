/**
 * Employee master-data completeness.
 *
 * One definition, used by the Employees list, the employee detail view and any
 * future report, so the browser never decides for itself what "complete" means.
 *
 * Scope: this measures whether the employee RECORD is filled in well enough to
 * run payroll for that person. It is deliberately NOT payroll readiness for a
 * particular period - a fully complete employee can still block a payroll run
 * because a day of their attendance is missing a punch. That is a property of
 * the period, not of the employee, and is reported by the pre-payroll check.
 *
 * Compensation is resolved only from the effective EmployeePayProfile. The
 * legacy employees.baseSalary column remains available for historical display,
 * but it is not authoritative for completeness.
 */
import { EmploymentType, PayType, type Prisma } from '@prisma/client';
import {
  resolveEffectivePayProfile,
  type PayProfileLike,
} from './pay-profile-resolution.js';

/** Stable identifiers for a missing field, plus the label an operator reads. */
export type EmployeeProfileField =
  | 'employeeCode'
  | 'firstName'
  | 'lastName'
  | 'employmentType'
  | 'department'
  | 'position'
  | 'startDate'
  | 'status'
  | 'monthlySalary'
  | 'dailyRate'
  | 'hourlyRate';

/**
 * Thai labels shown in the UI. Internal column names are never surfaced -
 * an operator should read "เงินเดือนพื้นฐาน", not "baseSalary".
 */
export const EMPLOYEE_FIELD_LABELS: Record<EmployeeProfileField, string> = {
  employeeCode: 'รหัสพนักงาน',
  firstName: 'ชื่อ',
  lastName: 'นามสกุล',
  employmentType: 'ประเภทพนักงาน',
  department: 'แผนก',
  position: 'ตำแหน่ง',
  startDate: 'วันที่เริ่มงาน',
  status: 'สถานะพนักงาน',
  monthlySalary: 'เงินเดือนพื้นฐาน',
  dailyRate: 'อัตราค่าจ้างรายวัน',
  hourlyRate: 'อัตราค่าจ้างรายชั่วโมง',
};

/**
 * Which compensation field each pay type requires.
 *
 * MONTHLY/CONTRACT require monthlySalary; DAILY/HOURLY require hourlyRate.
 * Both values come from the effective EmployeePayProfile.
 */
export const COMPENSATION_FIELD_BY_TYPE: Record<EmploymentType, EmployeeProfileField> = {
  [EmploymentType.MONTHLY]: 'monthlySalary',
  [EmploymentType.DAILY]: 'hourlyRate',
  [EmploymentType.HOURLY]: 'hourlyRate',
  [EmploymentType.CONTRACT]: 'monthlySalary',
};

/**
 * Pay types whose compensation figure is part of MASTER-DATA completeness.
 *
 * Every non-exempt employee needs the matching effective pay profile. This is
 * the same type/rate rule used by payroll readiness, while readiness continues
 * to add period-specific checks such as coverage and attendance.
 */
export const COMPENSATION_REQUIRED_TYPES: ReadonlySet<EmploymentType> =
  new Set(Object.values(EmploymentType));

/** The minimum an employee record needs, whatever their pay type. */
export const ALWAYS_REQUIRED_FIELDS: EmployeeProfileField[] = [
  'employeeCode',
  'firstName',
  'lastName',
  'employmentType',
  'department',
  'position',
  'startDate',
  'status',
];

/**
 * Fields that are genuinely optional. Listed so the UI can group them under
 * "ข้อมูลเพิ่มเติม" and so nobody later mistakes an empty one for a defect.
 */
export const OPTIONAL_EMPLOYEE_FIELDS = [
  'nickname', 'nationalId', 'email', 'phone', 'bankName', 'bankAccount',
  'taxId', 'socialSecurity', 'note', 'endDate',
] as const;

/** The shape completeness needs. Accepts a Prisma row or any equivalent. */
export interface CompletenessInput {
  employeeCode?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  employmentType?: EmploymentType | null;
  departmentId?: string | null;
  positionId?: string | null;
  startDate?: Date | string | null;
  status?: string | null;
  baseSalary?: unknown;
  payProfiles?: readonly PayProfileLike[];
  attendanceRequired?: boolean | null;
  leaveTrackingRequired?: boolean | null;
}

/**
 * An employee deliberately excused from BOTH attendance and leave tracking.
 *
 * That combination is not a data gap - it is how the system records an
 * executive whose pay does not depend on a timesheet. Derived from the existing
 * policy flags rather than a list of employee codes, so adding another
 * executive is a configuration change and never a code change.
 */
export function isExemptProfile(employee: CompletenessInput): boolean {
  return employee.attendanceRequired === false && employee.leaveTrackingRequired === false;
}

export interface EmployeeProfileCompleteness {
  complete: boolean;
  /** Stable field keys, for filtering and tests. */
  missingFields: EmployeeProfileField[];
  /** Thai labels for the same fields, ready to render. */
  missingLabels: string[];
  missingCount: number;
  /**
   * True when attendance, leave and compensation were not required of this
   * employee. Lets the UI explain the shorter checklist instead of leaving the
   * viewer to wonder why a salary of zero passed.
   */
  exempt: boolean;
  /** Whether a compensation figure was part of the check at all. */
  compensationRequired: boolean;
}

const isBlank = (value: unknown): boolean =>
  value === null || value === undefined || String(value).trim() === '';

/** Decimal, string or number - all are accepted and compared numerically. */
/**
 * Evaluate one employee record.
 *
 * Identity and placement are required of everybody. Compensation is required
 * only of employees the company actually pays from a rate or salary; an
 * executive excused from both attendance and leave tracking is not one of
 * those, so a zero salary is a deliberate configuration rather than a gap and
 * must not be reported as missing data.
 *
 * The exemption flags are read only to decide whether the compensation check
 * applies. They are never themselves treated as a missing field - an exemption
 * is a policy decision, not absent data.
 */
export function evaluateEmployeeProfileCompleteness(
  employee: CompletenessInput,
  effectiveDate = new Date()
): EmployeeProfileCompleteness {
  const missing: EmployeeProfileField[] = [];

  if (isBlank(employee.employeeCode)) missing.push('employeeCode');
  if (isBlank(employee.firstName)) missing.push('firstName');
  if (isBlank(employee.lastName)) missing.push('lastName');
  if (isBlank(employee.employmentType)) missing.push('employmentType');
  if (isBlank(employee.departmentId)) missing.push('department');
  if (isBlank(employee.positionId)) missing.push('position');
  if (isBlank(employee.startDate)) missing.push('startDate');
  if (isBlank(employee.status)) missing.push('status');

  const exempt = isExemptProfile(employee);
  const payType = (employee.employmentType ?? EmploymentType.MONTHLY) as EmploymentType;

  // Executives retain the established explicit exemption. Everyone else must
  // have the right profile type and positive amount in force on this date.
  const compensationRequired = !exempt && COMPENSATION_REQUIRED_TYPES.has(payType);

  if (compensationRequired) {
    const compensationField = COMPENSATION_FIELD_BY_TYPE[payType] ?? 'monthlySalary';
    const profile = resolveEffectivePayProfile(employee.payProfiles ?? [], payType, effectiveDate);
    if (!profile) missing.push(compensationField);
  }

  return {
    complete: missing.length === 0,
    missingFields: missing,
    missingLabels: missing.map((field) => EMPLOYEE_FIELD_LABELS[field]),
    missingCount: missing.length,
    exempt,
    compensationRequired,
  };
}

/** Attach completeness to an employee row without altering it. */
export function withProfileCompleteness<T extends CompletenessInput>(
  employee: T,
  effectiveDate = new Date()
): T & { effectivePayProfile: PayProfileLike | null; profileCompleteness: EmployeeProfileCompleteness } {
  const employmentType = (employee.employmentType ?? EmploymentType.MONTHLY) as EmploymentType;
  return {
    ...employee,
    effectivePayProfile: resolveEffectivePayProfile(employee.payProfiles ?? [], employmentType, effectiveDate),
    profileCompleteness: evaluateEmployeeProfileCompleteness(employee, effectiveDate),
  };
}

export type CompletenessFilter = 'COMPLETE' | 'INCOMPLETE';

/**
 * Prisma predicate matching the rule above, so the filter can be applied in the
 * database and stay correct alongside pagination.
 *
 * Kept next to the rule it mirrors: whenever a required field is added above,
 * the corresponding clause belongs here too. A unit test asserts the two agree.
 */
export function completenessWhere(filter: CompletenessFilter, effectiveDate = new Date()): Prisma.EmployeeWhereInput {
  const activeOnDate = {
    isActive: true,
    effectiveFrom: { lte: effectiveDate },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveDate } }],
  };
  const incompleteClauses = [
    { departmentId: null },
    { positionId: null },
    { employeeCode: '' },
    { firstName: '' },
    { lastName: '' },
    // Compensation counts as missing only for employees it is required of:
    // a salaried pay type, and not an exempt executive. Mirrors
    // COMPENSATION_REQUIRED_TYPES and isExemptProfile above - a unit test
    // asserts the two stay in agreement.
    {
      AND: [
        { employmentType: { in: [EmploymentType.MONTHLY, EmploymentType.CONTRACT] } },
        { NOT: { AND: [{ attendanceRequired: false }, { leaveTrackingRequired: false }] } },
        { payProfiles: { none: { ...activeOnDate, payType: PayType.MONTHLY, monthlySalary: { gt: 0 } } } },
      ],
    },
    {
      AND: [
        { employmentType: { in: [EmploymentType.DAILY, EmploymentType.HOURLY] } },
        { NOT: { AND: [{ attendanceRequired: false }, { leaveTrackingRequired: false }] } },
        { payProfiles: { none: { ...activeOnDate, payType: PayType.HOURLY, hourlyRate: { gt: 0 } } } },
      ],
    },
  ];
  return filter === 'INCOMPLETE'
    ? { OR: incompleteClauses }
    : { NOT: { OR: incompleteClauses } };
}
