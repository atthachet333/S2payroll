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
 * Compensation note (current schema): Employee has a single `baseSalary`
 * column and no separate dailyRate / hourlyRate fields. The payroll calculator
 * already reads that one column differently per employment type - for DAILY it
 * IS the daily rate, for HOURLY it IS the hourly rate, for MONTHLY/CONTRACT it
 * is the monthly salary. Completeness follows the same interpretation rather
 * than inventing fields that do not exist. `COMPENSATION_FIELD_BY_TYPE` is the
 * single place to change if those columns are ever added.
 */
import { EmploymentType } from '@prisma/client';

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
 * All four currently resolve to the same `baseSalary` column; the mapping
 * exists so the label is right today and so dedicated columns can be wired in
 * later without touching the rule.
 */
export const COMPENSATION_FIELD_BY_TYPE: Record<EmploymentType, EmployeeProfileField> = {
  [EmploymentType.MONTHLY]: 'monthlySalary',
  [EmploymentType.DAILY]: 'dailyRate',
  [EmploymentType.HOURLY]: 'hourlyRate',
  [EmploymentType.CONTRACT]: 'monthlySalary',
};

/**
 * Pay types whose compensation figure is part of MASTER-DATA completeness.
 *
 * Only the salaried types. A monthly salary is an attribute of the employment
 * itself, so a monthly employee without one has an incomplete record. A daily
 * or hourly rate is a payroll configuration that is legitimately settled later,
 * so its absence does not make the employee's master data incomplete.
 *
 * This is emphatically NOT payroll readiness: the pre-payroll check still
 * raises MISSING_DAILY_RATE / MISSING_HOURLY_RATE and still blocks a
 * calculation. The two questions are deliberately separate.
 *
 * CONTRACT follows MONTHLY: the calculator treats it as a fixed monthly figure.
 */
export const COMPENSATION_REQUIRED_TYPES: ReadonlySet<EmploymentType> = new Set([
  EmploymentType.MONTHLY,
  EmploymentType.CONTRACT,
]);

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
const isPositiveAmount = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  const parsed = Number(
    typeof value === 'object' && value !== null && 'toString' in value
      ? (value as { toString(): string }).toString()
      : value
  );
  return Number.isFinite(parsed) && parsed > 0;
};

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
  employee: CompletenessInput
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

  // Compensation is part of master data only for salaried pay types, and never
  // for an exempt executive. A daily or hourly rate is payroll configuration
  // settled later, so its absence is not a gap in the employee's record.
  const compensationRequired = !exempt && COMPENSATION_REQUIRED_TYPES.has(payType);

  if (compensationRequired) {
    const compensationField = COMPENSATION_FIELD_BY_TYPE[payType] ?? 'monthlySalary';
    if (!isPositiveAmount(employee.baseSalary)) missing.push(compensationField);
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
  employee: T
): T & { profileCompleteness: EmployeeProfileCompleteness } {
  return { ...employee, profileCompleteness: evaluateEmployeeProfileCompleteness(employee) };
}

export type CompletenessFilter = 'COMPLETE' | 'INCOMPLETE';

/**
 * Prisma predicate matching the rule above, so the filter can be applied in the
 * database and stay correct alongside pagination.
 *
 * Kept next to the rule it mirrors: whenever a required field is added above,
 * the corresponding clause belongs here too. A unit test asserts the two agree.
 */
export function completenessWhere(filter: CompletenessFilter) {
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
        { baseSalary: { lte: 0 } },
        { employmentType: { in: [...COMPENSATION_REQUIRED_TYPES] } },
        { NOT: { AND: [{ attendanceRequired: false }, { leaveTrackingRequired: false }] } },
      ],
    },
  ];
  return filter === 'INCOMPLETE'
    ? { OR: incompleteClauses }
    : { NOT: { OR: incompleteClauses } };
}
