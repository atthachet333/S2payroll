export type RoleCode = 'SUPER_ADMIN' | 'ADMIN' | 'HR' | 'PAYROLL' | 'VIEWER';

export type EmploymentType = 'MONTHLY' | 'DAILY' | 'HOURLY' | 'CONTRACT';
export type EmployeeStatus = 'ACTIVE' | 'INACTIVE' | 'TERMINATED' | 'PROBATION';

export type AttendanceStatus =
  | 'NORMAL'
  | 'LATE'
  | 'OT'
  | 'ABSENT'
  | 'MISSING_DATA'
  | 'IN_PROGRESS'
  | 'LEAVE'
  | 'HOLIDAY';

export type PayrollPeriodStatus =
  | 'DRAFT'
  | 'ATTENDANCE_REVIEW'
  | 'CALCULATED'
  | 'REVIEW'
  | 'APPROVED'
  | 'PAID'
  | 'LOCKED';

/**
 * Per-employee payroll readiness. NEEDS_REVIEW and MISSING_DATA are legacy
 * values still carried by rows calculated before readiness became per-employee;
 * new calculations produce PARTIAL and ATTENDANCE_INCOMPLETE instead.
 */
export type PayrollEmployeeStatus =
  | 'READY'
  | 'PARTIAL'
  | 'UNCONFIGURED'
  | 'ATTENDANCE_INCOMPLETE'
  | 'NEEDS_REVIEW'
  | 'MISSING_DATA'
  | 'EXCLUDED';

export type LateDeductionType = 'NONE' | 'PER_HOUR_FROM_BASE' | 'FIXED_AMOUNT';
export type LeaveDeductionType = 'NONE' | 'PER_DAY_FROM_BASE' | 'FIXED_AMOUNT';
export type AbsenceDeductionType = 'NONE' | 'PER_DAY_FROM_BASE' | 'FIXED_AMOUNT';

/**
 * Per-employee payroll policy. A null field means "not configured for this
 * employee" and the company default applies; a 0 amount is a real decision to
 * deduct nothing.
 */
export interface EmployeePayrollPolicy {
  id: string;
  employeeId: string;
  lateDeductionType: LateDeductionType | null;
  lateDeductionAmount: string | null;
  leaveDeductionType: LeaveDeductionType | null;
  leaveDeductionAmount: string | null;
  absenceDeductionType: AbsenceDeductionType | null;
  absenceDeductionAmount: string | null;
  socialSecurityAmount: string | null;
  taxAmount: string | null;
  note: string | null;
  updatedAt: string;
}

export interface EmployeePayrollPolicyInput {
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

export interface EmployeePayrollPolicyRow {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  employmentType: EmploymentType;
  exempt: boolean;
  policy: EmployeePayrollPolicy | null;
}

/** One day of an hourly employee's month, priced at that day's rate. */
export interface DailyEarningRow {
  workDate: string;
  checkIn: string | null;
  checkOut: string | null;
  /** The true observed duration. Never replaced by the payable figure. */
  workedMinutes: number;
  /** Unpaid break removed because the day ran past eight hours. */
  breakDeductionMinutes: number;
  minutesBeforeRounding: number;
  /** What the company floor discarded. */
  roundedAwayMinutes: number;
  /** The minutes actually paid for, after the floor. */
  payableMinutes: number;
  hourlyRate: string | null;
  amount: string;
  rateConfigured: boolean;
  status: AttendanceStatus;
}

/**
 * What one attendance day was worth, valued by the backend.
 *
 * DAILY staff: real money for that day. MONTHLY staff: the informational value
 * of the date. Monthly payroll-level amounts (social security, tax) are never
 * spread across days, so this is an attendance figure, not a slice of a payslip.
 */
export interface DailyPay {
  gross: string;
  attendanceDeduction: string;
  net: string;
  status: 'CALCULATED' | 'UNCONFIGURED' | 'NOT_APPLICABLE';
  basis: string | null;
  basisKind: 'HOURLY_RATE' | 'DAILY_BASE' | null;
  lateDeduction: string;
  leaveDeduction: string;
  absenceDeduction: string;
  lateChargedHours: number;
  /**
   * DAILY only. The unpaid break removed for a day past eight hours, and the
   * minutes actually paid for after the 15-minute floor. The attendance row
   * keeps showing the true observed duration alongside these.
   */
  breakDeductionMinutes: number;
  minutesBeforeRounding: number;
  roundedAwayMinutes: number;
  payableMinutes: number;
  /** MONTHLY: lateness observed and after the company floor. */
  lateMinutesActual: number;
  lateMinutesRounded: number;
  note: string | null;
}

export interface DailyEarnings {
  employeeId: string;
  employmentType: EmploymentType;
  /** False for monthly staff, whose pay does not come from a day count. */
  applicable: boolean;
  year: number;
  month: number;
  rows: DailyEarningRow[];
  summary: {
    workedDays: number;
    totalWorkedMinutes: number;
    totalBreakDeductionMinutes: number;
    totalPayableMinutes: number;
    totalRoundedAwayMinutes: number;
    ratedMinutes: number;
    unratedMinutes: number;
    unratedDays: number;
    totalAmount: string;
  } | null;
}

export interface SessionUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: RoleCode;
  permissions: string[];
  employeeId: string | null;
  /**
   * Set while the account still carries a bootstrap or admin-reset password.
   * The API already enforces this - every route except /auth/me,
   * /auth/change-password and /auth/logout answers PASSWORD_CHANGE_REQUIRED -
   * so the UI mirrors it by routing the user straight to the change form.
   */
  mustChangePassword: boolean;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Department {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  _count?: { employees: number };
}

export interface Position {
  id: string;
  code: string;
  name: string;
  departmentId: string | null;
  isActive: boolean;
  department?: Department | null;
}

export interface EmployeeProfileCompleteness {
  complete: boolean;
  /** Stable field keys, for filtering and tests. */
  missingFields: string[];
  /** Thai labels, ready to render. */
  missingLabels: string[];
  missingCount: number;
  /** Excused from attendance, leave and therefore compensation. */
  exempt: boolean;
  compensationRequired: boolean;
}

export interface Employee {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  nickname: string | null;
  nationalId: string | null;
  email: string | null;
  phone: string | null;
  departmentId: string | null;
  positionId: string | null;
  employmentType: EmploymentType;
  startDate: string;
  endDate: string | null;
  baseSalary: string;
  bankName: string | null;
  bankAccount: string | null;
  taxId: string | null;
  socialSecurity: string | null;
  ssoEnabled: boolean;
  taxEnabled: boolean;
  otEligible: boolean;
  attendanceRequired: boolean;
  leaveTrackingRequired: boolean;
  status: EmployeeStatus;
  note: string | null;
  department?: Department | null;
  position?: Position | null;
  salaryHistory?: SalaryHistory[];
  /** Read-only context on payroll detail; period adjustments never write it. */
  payrollPolicy?: EmployeePayrollPolicy | null;
  /** Master-data completeness, decided by the backend - never recomputed here. */
  profileCompleteness?: EmployeeProfileCompleteness;
  lineUserId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface SalaryHistory {
  id: string;
  previousSalary: string;
  newSalary: string;
  effectiveDate: string;
  reason: string | null;
  createdAt: string;
}

export interface AttendanceRecord {
  id: string;
  employeeId: string;
  employeeCode: string;
  workDate: string;
  checkIn: string | null;
  checkOut: string | null;
  originalCheckIn: string | null;
  originalCheckOut: string | null;
  workedMinutes: number;
  normalMinutes: number;
  otMinutes: number;
  breakMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  isMissingCheckIn: boolean;
  isMissingCheckOut: boolean;
  isAbsent: boolean;
  isHoliday: boolean;
  isWeekend: boolean;
  status: AttendanceStatus;
  source: string;
  isCorrected: boolean;
  /** True only when a human pinned the status, not merely edited the punches. */
  statusOverride?: boolean;
  isLocked: boolean;
  note: string | null;
  sessions?: AttendanceSession[];
  sessionCount?: number;
  completedWorkedMinutes?: number;
  hasOpenSession?: boolean;
  malformedSequence?: boolean;
  attendanceIssues?: string[];
  /** Server-valued day earning. Absent on endpoints that do not value rows. */
  dailyPay?: DailyPay | null;
  employee?: {
    id: string;
    employeeCode: string;
    firstName: string;
    lastName: string;
    nickname: string | null;
    employmentType?: EmploymentType;
    attendanceRequired?: boolean;
    leaveTrackingRequired?: boolean;
    department?: { id: string; name: string } | null;
  };
  adjustments?: AttendanceAdjustment[];
}

export interface AttendanceSession {
  checkIn: string | null;
  checkOut: string | null;
  workedMinutes: number;
  checkInRawId: string | null;
  checkOutRawId: string | null;
  checkInClientRequestId: string | null;
  checkOutClientRequestId: string | null;
}

export interface AttendanceAdjustment {
  id: string;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string;
  changedBy: string;
  /** Resolved display name for changedBy; null when the user no longer exists. */
  changedByName?: string | null;
  changedAt: string;
}

export interface AttendanceSummary {
  counts: Record<string, number>;
  present: number;
  late: number;
  absent: number;
  leave: number;
  missingData: number;
  totalWorkedMinutes: number;
  totalOtMinutes: number;
  totalLateMinutes: number;
}

export interface PayrollPeriod {
  id: string;
  code: string;
  name: string;
  year: number;
  month: number;
  startDate: string;
  endDate: string;
  paymentDate: string | null;
  status: PayrollPeriodStatus;
  totalEmployees: number;
  grossTotal: string;
  otTotal: string;
  deductionTotal: string;
  netTotal: string;
  calculatedAt: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  lockedAt: string | null;
  note: string | null;
}

export interface PeriodSummary {
  period: PayrollPeriod;
  employees: number;
  grossTotal: string;
  otTotal: string;
  deductionTotal: string;
  netTotal: string;
  workingHours: string;
  otHours: string;
  ready: number;
  partial: number;
  unconfigured: number;
  attendanceIncomplete: number;
  excluded: number;
  /** Legacy aliases, folded so older rows still count somewhere. */
  needsReview: number;
  missingData: number;
  statusCounts: Record<string, number>;
}

export interface PayrollEmployee {
  id: string;
  periodId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  departmentName: string | null;
  positionName: string | null;
  employmentType: EmploymentType;
  workingDays: number;
  presentDays: number;
  absentDays: number;
  leaveDays: string;
  lateCount: number;
  lateMinutes: number;
  workingHours: string;
  normalHours: string;
  otHours: string;
  otWeekdayHours: string;
  otWeekendHours: string;
  otHolidayHours: string;
  missingDataDays: number;
  missingCheckInDays: number;
  missingCheckOutDays: number;
  baseSalary: string;
  otAmount: string;
  allowanceAmount: string;
  bonusAmount: string;
  commissionAmount: string;
  otherIncome: string;
  grossIncome: string;
  unpaidLeaveDays: string;
  dailyBase: string;
  hourlyBase: string;
  /** DAILY only: unpaid break removed, and minutes actually paid for. */
  breakDeductionMinutes: number;
  payableMinutes: number;
  roundedAwayMinutes: number;
  /** MONTHLY: lateness observed and after the company floor. */
  roundedLateMinutes: number;
  earlyLeaveMinutes: number;
  roundedEarlyLeaveMinutes: number;
  actualOtMinutes: number;
  lateDeduction: string;
  lateDeductionHours: number;
  leaveDeduction: string;
  absenceDeduction: string;
  socialSecurity: string;
  tax: string;
  loanDeduction: string;
  otherDeduction: string;
  totalDeduction: string;
  netSalary: string;
  status: PayrollEmployeeStatus;
  /** False when no wage rate was known - the amounts are not a final salary. */
  payConfigured: boolean;
  /** True when the figures are a preview rather than a settled amount. */
  isEstimate: boolean;
  reviewNotes: string[] | null;
  hasAdjustment: boolean;
}

export interface PayrollLine {
  id: string;
  kind: string;
  label: string;
  quantity: string | null;
  rate: string | null;
  amount: string;
  isManual: boolean;
  note: string | null;
}

export interface PayrollAdjustment {
  id: string;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string;
  changedBy: string;
  changedAt: string;
}

export interface PayrollEmployeeDetail extends PayrollEmployee {
  incomes: PayrollLine[];
  deductions: PayrollLine[];
  adjustments: PayrollAdjustment[];
  employee: Employee;
  period: PayrollPeriod;
  payslip: { id: string; payslipNo: string } | null;
}

export interface PayslipLine {
  label: string;
  quantity: string | null;
  rate: string | null;
  amount: string;
}

/** How an employee's pay was arrived at, as printed on the payslip. */
export interface PayslipPayBasis {
  kind: 'HOURLY' | 'MONTHLY';
  hourlyRate: string | null;
  monthlySalary: string | null;
  dailyBase: string;
  hourlyBase: string;
  /** The true observed duration across the period. */
  workedMinutes: number;
  /**
   * DAILY only, and optional because snapshots frozen before these existed
   * will never carry them. Break removed, and minutes actually paid for.
   */
  breakDeductionMinutes?: number;
  payableMinutes?: number;
  payConfigured: boolean;
}

export interface PayslipSnapshot {
  company: {
    name: string;
    nameEn: string | null;
    address: string | null;
    taxId: string | null;
    phone: string | null;
  };
  employee: {
    employeeCode: string;
    name: string;
    nickname: string | null;
    department: string | null;
    position: string | null;
    employmentType: EmploymentType;
    bankName: string | null;
    bankAccount: string | null;
    taxId: string | null;
    socialSecurity: string | null;
  };
  /**
   * How this employee is paid, so the document can be honest about it: hourly
   * staff have a rate and worked minutes and no monthly salary; salaried staff
   * have a salary whose per-day and per-hour figures are derived, not a second
   * kind of wage.
   */
  /**
   * Optional on purpose. A snapshot is frozen when the payslip is issued, so a
   * document issued before this field existed will never have it, and the
   * viewer has to cope rather than crash.
   */
  pay?: PayslipPayBasis;
  period: {
    code: string;
    name: string;
    startDate: string;
    endDate: string;
    /** Absent on snapshots issued before the status was captured. */
    status?: PayrollPeriodStatus;
  };
  paymentDate: string | null;
  attendance: {
    workingDays: number;
    presentDays: number;
    absentDays: number;
    leaveDays: string;
    lateCount: number;
    lateMinutes: number;
    workingHours: string;
    otHours: string;
  };
  incomes: PayslipLine[];
  deductions: PayslipLine[];
  totals: { grossIncome: string; totalDeduction: string; netSalary: string };
}

export interface Payslip {
  id: string;
  payslipNo: string;
  periodId: string;
  employeeId: string;
  paymentDate: string | null;
  snapshot: PayslipSnapshot;
  netSalary: string;
  issuedAt: string;
  employee?: { employeeCode: string; firstName: string; lastName: string };
  period?: { code: string; name: string; status?: PayrollPeriodStatus };
}

export type CheckSeverity = 'BLOCKING' | 'WARNING' | 'INFO';

export interface CheckFinding {
  code: string;
  severity: CheckSeverity;
  title: string;
  detail: string;
  count: number;
  samples: string[];
}

export interface PrePayrollReport {
  periodId: string;
  periodCode: string;
  periodName: string;
  startDate: string;
  endDate: string;
  canCalculate: boolean;
  isPreview: boolean;
  periodClosed: boolean;
  blocking: number;
  warning: number;
  info: number;
  readiness: {
    employees: number;
    ready: number;
    partial: number;
    unconfigured: number;
    incompleteAttendance: number;
    excluded: number;
    inProgressToday: number;
    /** Retained alias for `unconfigured`. */
    missingPay: number;
  };
  employees: EmployeeReadiness[];
  findings: CheckFinding[];
}

/** One employee's readiness, resolved before any money is computed. */
export interface EmployeeReadiness {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  employmentType: EmploymentType;
  status: PayrollEmployeeStatus;
  payConfigured: boolean;
  reasons: string[];
  action: 'SET_PAY' | 'FIX_ATTENDANCE' | 'RECORD_ATTENDANCE' | null;
  inProgressToday: boolean;
}

export interface PeriodSuggestion {
  year: number;
  month: number;
  name: string;
  cycleStartDay: number;
  cycleEndDay: number;
  startDate: string;
  endDate: string;
  paymentDate: string;
}

export interface Overview {
  period: {
    id: string;
    code: string;
    name: string;
    status: PayrollPeriodStatus;
    startDate: string;
    endDate: string;
  } | null;
  totals: {
    employees: number;
    payroll: string;
    grossPayroll: string;
    otAmount: string;
    otHours: string;
    workingHours: string;
    lateCount: number;
    absentCount: number;
  };
  attendance: {
    present: number;
    late: number;
    absent: number;
    leave: number;
    missingData: number;
  };
  payrollStatus: { ready: number; needsReview: number; missingData: number };
  trend: OverviewTrendPoint[];
}

/**
 * One month of the payroll trend. A month with no calculated payroll carries
 * nulls, never zeros - zero would assert that payroll ran and paid nobody.
 */
export interface OverviewTrendPoint {
  code: string;
  /** Full Thai month, e.g. "สิงหาคม 2026". Used for tooltips. */
  name: string;
  /** Numeric MM/YYYY, kept for compatibility. */
  label: string;
  /** Abbreviated Thai month, e.g. "ส.ค. 2026". Used for axis ticks. */
  shortLabel?: string;
  gross: number | null;
  net: number | null;
  ot: number | null;
  deduction: number | null;
  status: PayrollPeriodStatus | null;
  isEstimate: boolean;
}

export type SyncRowAction =
  | 'NEW'
  | 'UPDATE'
  | 'DUPLICATE'
  | 'PROTECTED'
  | 'LOCKED'
  | 'INVALID'
  | 'UNKNOWN_EMPLOYEE'
  | 'MISSING_CHECKIN'
  | 'MISSING_CHECKOUT'
  | 'MULTIPLE_EVENTS'
  | 'DUPLICATE_SOURCE_EVENT'
  | 'WORK_HOURS_MISMATCH';

export interface SyncPreviewRow {
  row: number;
  employeeCode: string;
  date: string;
  action: SyncRowAction;
  employeeName: string | null;
  reason?: string;
  checkIn: string | null;
  checkOut: string | null;
  previousCheckIn?: string | null;
  previousCheckOut?: string | null;
  sheetRows?: number[];
  sourceEventCount?: number;
  checkInEvents?: string[];
  checkOutEvents?: string[];
}

export interface SyncResult {
  syncId: string;
  status: 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'FAILED';
  totalRows: number;
  imported: number;
  updated: number;
  skipped: number;
  duplicates: number;
  protected: number;
  errors: { row: number; employeeCode: string; date: string; message: string }[];
  durationMs: number;
  preview?: SyncPreviewRow[];
  dryRun: boolean;
  invalid: number;
  unknownEmployee: number;
  sourceEvents: number;
  groupedEmployeeDays: number;
  counts: Record<SyncRowAction, number>;
}

export interface SyncHistoryItem {
  id: string;
  sheetId: string;
  sheetRange: string;
  status: 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'FAILED';
  totalRows: number;
  importedCount: number;
  updatedCount: number;
  skippedCount: number;
  duplicateCount: number;
  protectedCount: number;
  errorCount: number;
  errors: { row: number; employeeCode: string; date: string; message: string }[] | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface PayrollSetting {
  id: string;
  key: string;
  value: string;
  valueType: 'STRING' | 'NUMBER' | 'DECIMAL' | 'BOOLEAN' | 'TIME' | 'JSON';
  group: string;
  label: string;
  description: string | null;
  updatedAt: string;
}

export interface Company {
  id: string;
  name: string;
  nameEn: string | null;
  taxId: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  ssoBranchNo: string | null;
}

export interface AppUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
  lastLoginAt: string | null;
  role: { id: string; code: RoleCode; name: string };
  roleLabel?: string;
  employee?: { employeeCode: string } | null;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  userId: string | null;
  userEmail: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
  ipAddress: string | null;
  createdAt: string;
}

export interface ReportColumn {
  key: string;
  header: string;
  width?: number;
  numeric?: boolean;
  format?: 'currency' | 'number' | 'date';
}

export interface ReportData {
  kind?: 'detailed-payroll' | 'attendance' | 'generic';
  title: string;
  columns: ReportColumn[];
  rows: Record<string, string | number>[];
  totals?: Record<string, string | number>;
  meta: Record<string, string>;
  summary?: {
    employeeCount: number;
    monetaryEmployeeCount: number;
    unconfiguredCount: number;
    grossTotal: string;
    deductionTotal: string;
    netTotal: string;
    workedHoursTotal: string;
    otHoursTotal: string;
  };
}

export interface Holiday {
  id: string;
  date: string;
  name: string;
  type: 'PUBLIC_HOLIDAY' | 'COMPANY_HOLIDAY';
  note: string | null;
  isPaid: boolean;
}

export interface EmployeePayProfile {
  id: string;
  employeeId: string;
  payType: 'MONTHLY' | 'HOURLY';
  monthlySalary: string | null;
  hourlyRate: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
}

export interface EmployeePayConfiguration {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  employmentType: EmploymentType;
  exempt: boolean;
  profile: EmployeePayProfile | null;
  paySource: 'PAY_PROFILE' | 'LEGACY_BASE_SALARY' | 'UNCONFIGURED';
  legacyBaseSalary: string;
}

export interface WorkScheduleProfile {
  id: string;
  name: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  workingDays: string;
  workStartTime: string;
  workEndTime: string;
  flexArrivalMinutes: number;
  isActive: boolean;
}

export interface LeaveRecord {
  id: string;
  employeeId: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  totalDays: string;
  isPaid: boolean;
  status: string;
  reason: string | null;
  employee?: { employeeCode: string; firstName: string; lastName: string };
}
