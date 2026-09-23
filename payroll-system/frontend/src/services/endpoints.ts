import { api } from './api';
import type {
  AppUser,
  AttendanceRecord,
  AttendanceSummary,
  AuditLog,
  AuthResponse,
  Company,
  Department,
  Employee,
  EmployeePayProfile,
  EmployeePayrollPolicy,
  EmployeePayrollPolicyInput,
  EmployeePayrollPolicyRow,
  DailyEarnings,
  EmployeePayConfiguration,
  Holiday,
  LeaveRecord,
  Overview,
  Paginated,
  Payslip,
  PayslipSnapshot,
  PayrollEmployee,
  PayrollEmployeeDetail,
  PayrollPeriod,
  PayrollSetting,
  PeriodSummary,
  PrePayrollReport,
  PeriodSuggestion,
  Position,
  ReportData,
  SessionUser,
  SyncHistoryItem,
  SyncResult,
  WorkScheduleProfile,
} from '@/types';

/** Typed wrappers over every REST endpoint the UI consumes. */

const unwrap = <T,>(promise: Promise<{ data: T }>): Promise<T> => promise.then((r) => r.data);

// --- auth --------------------------------------------------------------------

export const authApi = {
  login: (email: string, password: string) =>
    unwrap<AuthResponse>(api.post('/api/auth/login', { email, password })),
  logout: (refreshToken?: string | null) =>
    unwrap<{ success: boolean }>(api.post('/api/auth/logout', { refreshToken })),
  me: () => unwrap<SessionUser>(api.get('/api/auth/me')),
  changePassword: (currentPassword: string, newPassword: string) =>
    unwrap<{ success: boolean; message: string }>(
      api.post('/api/auth/change-password', { currentPassword, newPassword })
    ),
};

// --- overview ----------------------------------------------------------------

export const overviewApi = {
  get: (periodId?: string, months = 6) =>
    unwrap<Overview>(api.get('/api/overview', { params: { ...(periodId ? { periodId } : {}), months } })),
};

// --- employees ---------------------------------------------------------------

export interface EmployeeQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  departmentId?: string;
  status?: string;
  employmentType?: string;
  /** Master-data completeness, evaluated by the backend. */
  completeness?: 'COMPLETE' | 'INCOMPLETE';
}

export interface EmployeeCompletenessSummary {
  total: number;
  complete: number;
  incomplete: number;
  incompleteEmployees: Array<{
    employeeCode: string;
    name: string;
    missingCount: number;
    missingLabels: string[];
  }>;
}

export const employeeApi = {
  list: (params: EmployeeQuery) =>
    unwrap<Paginated<Employee>>(api.get('/api/employees', { params })),
  get: (id: string) => unwrap<Employee>(api.get(`/api/employees/${id}`)),
  completenessSummary: () =>
    unwrap<EmployeeCompletenessSummary>(api.get('/api/employees/completeness-summary')),
  summary: (id: string, params?: { from?: string; to?: string }) =>
    unwrap<{
      employee: Employee;
      attendance: {
        totalRecords: number;
        presentDays: number;
        workedMinutes: number;
        otMinutes: number;
        roundedOtMinutes: number;
        lateMinutes: number;
        /** Lateness after the company-wide floor - what money is charged from. */
        roundedLateMinutes: number;
        earlyLeaveMinutes: number;
        roundedEarlyLeaveMinutes: number;
        roundingIntervalMinutes: number;
        statusCounts: Record<string, number>;
      };
      payslips: Payslip[];
      payrollHistory: (PayrollEmployee & { period: { code: string; name: string } })[];
    }>(api.get(`/api/employees/${id}/summary`, { params })),
  create: (data: Record<string, unknown>) =>
    unwrap<Employee>(api.post('/api/employees', data)),
  update: (id: string, data: Record<string, unknown>) =>
    unwrap<Employee>(api.patch(`/api/employees/${id}`, data)),
  deactivate: (id: string, reason: string) =>
    unwrap<Employee>(api.post(`/api/employees/${id}/deactivate`, { reason })),
  payProfiles: (id: string) =>
    unwrap<EmployeePayProfile[]>(api.get(`/api/employees/${id}/pay-profiles`)),
  attendance: (id: string, params: { year: number; month: number; page?: number; pageSize?: number; status?: string }) =>
    unwrap<Paginated<AttendanceRecord>>(api.get(`/api/employees/${id}/attendance`, { params })),
  createPayProfile: (id: string, data: Record<string, unknown>) =>
    unwrap<EmployeePayProfile>(api.post(`/api/employees/${id}/pay-profiles`, data)),
  // Employee Edit and Payroll Settings both read and write this one endpoint,
  // so the two screens can never hold different numbers for the same person.
  payrollPolicy: (id: string) =>
    unwrap<EmployeePayrollPolicy | null>(api.get(`/api/employees/${id}/payroll-policy`)),
  savePayrollPolicy: (id: string, data: EmployeePayrollPolicyInput) =>
    unwrap<EmployeePayrollPolicy>(api.put(`/api/employees/${id}/payroll-policy`, data)),
  dailyEarnings: (id: string, params: { year: number; month: number }) =>
    unwrap<DailyEarnings>(api.get(`/api/employees/${id}/daily-earnings`, { params })),
  /** Bring a deactivated or terminated employee back onto the payroll. */
  reactivate: (id: string, data: { returnDate: string; reason: string | null }) =>
    unwrap<Employee>(api.post(`/api/employees/${id}/reactivate`, data)),
  /** Record one worked day by hand. Derived values are computed server-side. */
  createAttendance: (
    id: string,
    data: {
      workDate: string;
      checkIn: string | null;
      checkOut: string | null;
      reason: string;
      note: string | null;
    }
  ) => unwrap<AttendanceRecord>(api.post(`/api/employees/${id}/attendance`, data)),
};

// --- attendance --------------------------------------------------------------

export interface AttendanceQuery {
  page?: number;
  pageSize?: number;
  employeeId?: string;
  departmentId?: string;
  from?: string;
  to?: string;
  status?: string;
  employmentType?: string;
  search?: string;
}

export const attendanceApi = {
  list: (params: AttendanceQuery) =>
    unwrap<Paginated<AttendanceRecord>>(api.get('/api/attendance', { params })),
  get: (id: string) => unwrap<AttendanceRecord>(api.get(`/api/attendance/${id}`)),
  summary: (params: { from?: string; to?: string; departmentId?: string }) =>
    unwrap<AttendanceSummary>(api.get('/api/attendance/summary', { params })),
  calendar: (year: number, month: number) =>
    unwrap<WorkCalendar>(api.get('/api/attendance/calendar', { params: { year, month } })),
  correct: (
    id: string,
    data: { checkIn?: string | null; checkOut?: string | null; status?: string; note?: string | null; reason: string }
  ) => unwrap<AttendanceRecord>(api.patch(`/api/attendance/${id}`, data)),
  recalculate: (from: string, to: string) =>
    unwrap<{ updated: number; skippedLocked: number }>(api.post('/api/attendance/recalculate', { from, to })),
  /** Removes the day from payroll only. The Google Sheet is never written to. */
  remove: (id: string, reason: string) =>
    unwrap<{ deleted: boolean; suppressed: boolean }>(
      api.delete(`/api/attendance/${id}`, { data: { reason } })
    ),
  dayDetail: (date: string) =>
    unwrap<CalendarDayDetail>(api.get(`/api/attendance/calendar/${date}`)),
  suppressions: () => unwrap<AttendanceSuppression[]>(api.get('/api/attendance/suppressions')),
  restore: (id: string) =>
    unwrap<{ restored: boolean }>(api.delete(`/api/attendance/suppressions/${id}`)),
};

export interface WorkCalendarDay {
  date: string;
  dayType: 'WORKING_DAY' | 'WEEKLY_OFF' | 'HOLIDAY' | 'PUBLIC_HOLIDAY' | 'COMPANY_HOLIDAY';
  holidayName: string | null;
  isToday: boolean;
  summaryCount: number;
  lateCount: number;
  leaveCount: number;
  hasActivity: boolean;
  approvedLeaveCount: number;
  payrollPeriods: Array<{ id: string; name: string; status: string }>;
}

export interface CheckoutSummary {
  employeeCode: string;
  employeeName: string | null;
  checkOutTime: string;
  text: string;
  eventId: string;
  suppressed: boolean;
}

export interface CalendarDayDetail {
  date: string;
  dayType: 'WORKING_DAY' | 'WEEKLY_OFF' | 'HOLIDAY' | 'PUBLIC_HOLIDAY' | 'COMPANY_HOLIDAY';
  holidayName: string | null;
  holidayNote?: string | null;
  summaries: CheckoutSummary[];
  suppressedSummaries: CheckoutSummary[];
  late: Array<{
    employeeCode: string;
    employeeName: string;
    checkIn: string | null;
    lateMinutes: number;
  }>;
  leaves: Array<{
    employeeCode: string;
    employeeName: string;
    leaveType: string;
    startDate: string;
    endDate: string;
    reason: string | null;
  }>;
  counts: { summaryCount: number; lateCount: number; leaveCount: number };
}

export interface AttendanceSuppression {
  id: string;
  employeeCode: string;
  workDate: string;
  reason: string;
  createdAt: string;
  employee?: { employeeCode: string; firstName: string; lastName: string };
}

export interface WorkCalendar {
  year: number;
  month: number;
  days: WorkCalendarDay[];
  summary: {
    scheduledWorkingDays: number;
    elapsedWorkingDays: number;
    remainingWorkingDays: number;
    weeklyOffDays: number;
    publicHolidays: number;
    companyHolidays: number;
  };
}

// --- google sheets -----------------------------------------------------------

export interface AutoSyncSourceStatus {
  status: 'IDLE' | 'RUNNING' | 'SUCCESS' | 'FAILED';
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessfulAt: string | null;
  lastErrorAt: string | null;
  lastErrorSummary: string | null;
  lastCounts: Record<string, number> | null;
}

export interface AutoSyncStatus {
  overall: 'IDLE' | 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'FAILED';
  enabled: boolean;
  running: boolean;
  intervalSeconds: number;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessfulAt: string | null;
  lastErrorAt: string | null;
  lastErrorSummary: string | null;
  skippedBecauseBusy: number;
  cyclesRun: number;
  sources: Record<'employees' | 'attendance' | 'leave', AutoSyncSourceStatus>;
}

/**
 * How often each page re-reads the database. The browser never talks to Google;
 * the backend scheduler keeps the database current and these only poll our own
 * API. Payroll pages are deliberately absent - refreshing stored figures is
 * fine, recalculating them automatically is not.
 */
export const POLL_INTERVAL_MS = {
  attendance: 30_000,
  calendar: 45_000,
  overview: 60_000,
  employees: 60_000,
  leave: 60_000,
  autoSyncStatus: 15_000,
} as const;

export const sheetsApi = {
  sync: (data: { sheetId?: string; range?: string; dryRun?: boolean }) =>
    unwrap<SyncResult>(api.post('/api/sheets/sync', data)),
  autoSyncStatus: () => unwrap<AutoSyncStatus>(api.get('/api/sheets/auto-sync/status')),
  syncAll: () => unwrap<AutoSyncStatus>(api.post('/api/sheets/sync-all')),
  status: () =>
    unwrap<{
      configured: boolean;
      sheetId: string | null;
      range: string;
      lastSync: SyncHistoryItem | null;
    }>(api.get('/api/sheets/status')),
  history: (params: { page?: number; pageSize?: number }) =>
    unwrap<Paginated<SyncHistoryItem>>(api.get('/api/sheets/history', { params })),
  previewLeaves: () => unwrap<{
    tab: string; totalSheetRows: number; counts: Record<string, number>;
    importable: boolean; blockers: string[];
    rows: Array<{ sheetRow: number; requestId: string; employeeCode: string; leaveType: string; startDate: string | null; endDate: string | null; status: string | null; action: string; errors: string[] }>;
  }>(api.get('/api/sheets/leaves/preview')),
  syncLeaves: () => unwrap<{
    created: number; updated: number; unchanged: number;
    attendanceCreated: number; attendanceRecalculated: number; attendanceSkippedLocked: number;
  }>(api.post('/api/sheets/leaves/sync')),
};

// --- payroll -----------------------------------------------------------------

export const payrollApi = {
  listPeriods: () => unwrap<PayrollPeriod[]>(api.get('/api/payroll/periods')),
  createPeriod: (data: {
    year: number;
    month: number;
    startDate?: string | null;
    endDate?: string | null;
    paymentDate?: string | null;
    note?: string | null;
  }) =>
    unwrap<PayrollPeriod>(api.post('/api/payroll/periods', data)),
  preCheck: (id: string) =>
    unwrap<PrePayrollReport>(api.get(`/api/payroll/periods/${id}/pre-check`)),
  suggestPeriod: (year: number, month: number) =>
    unwrap<PeriodSuggestion>(api.get('/api/payroll/periods/suggest', { params: { year, month } })),
  getPeriod: (id: string) => unwrap<PeriodSummary>(api.get(`/api/payroll/periods/${id}`)),

  startAttendanceReview: (id: string) =>
    unwrap<PayrollPeriod>(api.post(`/api/payroll/periods/${id}/attendance-review`)),
  calculate: (id: string) => unwrap<PayrollPeriod>(api.post(`/api/payroll/periods/${id}/calculate`)),
  submitReview: (id: string) =>
    unwrap<PayrollPeriod>(api.post(`/api/payroll/periods/${id}/submit-review`)),
  approve: (id: string) => unwrap<PayrollPeriod>(api.post(`/api/payroll/periods/${id}/approve`)),
  markPaid: (id: string, paymentDate?: string) =>
    unwrap<PayrollPeriod>(api.post(`/api/payroll/periods/${id}/mark-paid`, { paymentDate })),
  lock: (id: string) => unwrap<PayrollPeriod>(api.post(`/api/payroll/periods/${id}/lock`)),
  unlock: (id: string, reason: string) =>
    unwrap<PayrollPeriod>(api.post(`/api/payroll/periods/${id}/unlock`, { reason })),

  listEmployees: (
    id: string,
    params: { page?: number; pageSize?: number; search?: string; departmentId?: string; status?: string }
  ) => unwrap<Paginated<PayrollEmployee>>(api.get(`/api/payroll/periods/${id}/employees`, { params })),
  getEmployee: (id: string, employeeId: string) =>
    unwrap<PayrollEmployeeDetail>(api.get(`/api/payroll/periods/${id}/employees/${employeeId}`)),
  adjustEmployee: (
    id: string,
    employeeId: string,
    data: { adjustments: { field: string; value: string; reason: string }[]; status?: string }
  ) => unwrap<PayrollEmployee>(api.patch(`/api/payroll/periods/${id}/employees/${employeeId}`, data)),

  payslipPreview: (id: string, employeeId: string) =>
    unwrap<PayslipSnapshot>(
      api.get(`/api/payroll/periods/${id}/employees/${employeeId}/payslip-preview`)
    ),
  /** Bulk ZIP of every payslip in the period. Path only — see downloadFile(). */
  bulkPayslipPath: (id: string) => `/api/payroll/periods/${id}/payslips/download`,
  generatePayslips: (id: string) =>
    unwrap<{ created: number; refreshed: number; total: number }>(
      api.post(`/api/payroll/periods/${id}/generate-payslips`)
    ),
};

// --- payslips ----------------------------------------------------------------

export const payslipApi = {
  list: (params: { page?: number; pageSize?: number; periodId?: string; employeeId?: string; search?: string }) =>
    unwrap<Paginated<Payslip>>(api.get('/api/payslips', { params })),
  get: (id: string) => unwrap<Payslip>(api.get(`/api/payslips/${id}`)),
  /** Server-rendered A5 PDF. Path only — downloadFile() attaches the auth header. */
  pdfPath: (id: string) => `/api/payslips/${id}/pdf`,
};

// --- reports -----------------------------------------------------------------

export interface ReportQuery {
  periodId?: string;
  from?: string;
  to?: string;
  departmentId?: string;
  employeeId?: string;
  employmentType?: string;
  status?: string;
}

export const reportApi = {
  get: (type: string, params: ReportQuery) =>
    unwrap<ReportData>(api.get(`/api/reports/${type}`, { params: { ...params, format: 'json' } })),
};

// --- settings ----------------------------------------------------------------

export const settingsApi = {
  list: (group?: string) =>
    unwrap<PayrollSetting[]>(api.get('/api/settings', { params: group ? { group } : {} })),
  update: (settings: { key: string; value: string }[]) =>
    unwrap<PayrollSetting[]>(api.patch('/api/settings', { settings })),
  /** Quick-pick daily rates. Suggestions only; any positive amount is valid. */
  dailyRatePresets: () =>
    unwrap<{ presets: number[] }>(api.get('/api/settings/daily-rate-presets')),
  payrollPolicies: () =>
    unwrap<EmployeePayrollPolicyRow[]>(api.get('/api/settings/payroll-policies')),
  payConfigurations: () =>
    unwrap<EmployeePayConfiguration[]>(api.get('/api/settings/pay-configurations')),

  getCompany: () => unwrap<Company | null>(api.get('/api/settings/company')),
  saveCompany: (data: Record<string, unknown>) =>
    unwrap<Company>(api.put('/api/settings/company', data)),

  listDepartments: () => unwrap<Department[]>(api.get('/api/settings/departments')),
  createDepartment: (data: { code: string; name: string }) =>
    unwrap<Department>(api.post('/api/settings/departments', data)),
  updateDepartment: (id: string, data: { name?: string; isActive?: boolean }) =>
    unwrap<Department>(api.patch(`/api/settings/departments/${id}`, data)),

  listPositions: () => unwrap<Position[]>(api.get('/api/settings/positions')),
  createPosition: (data: { code: string; name: string; departmentId?: string | null }) =>
    unwrap<Position>(api.post('/api/settings/positions', data)),
  updatePosition: (id: string, data: { name?: string; departmentId?: string | null }) =>
    unwrap<Position>(api.patch(`/api/settings/positions/${id}`, data)),

  listRoles: () =>
    unwrap<{ id: string; code: string; name: string; label: string; permissions: string[] }[]>(
      api.get('/api/settings/roles')
    ),

  listUsers: () => unwrap<AppUser[]>(api.get('/api/settings/users')),
  createUser: (data: Record<string, unknown>) => unwrap<AppUser>(api.post('/api/settings/users', data)),
  updateUser: (id: string, data: Record<string, unknown>) =>
    unwrap<AppUser>(api.patch(`/api/settings/users/${id}`, data)),

  auditLogs: (params: Record<string, unknown>) =>
    unwrap<Paginated<AuditLog>>(api.get('/api/settings/audit-logs', { params })),

  listHolidays: () => unwrap<Holiday[]>(api.get('/api/settings/holidays')),
  createHoliday: (data: { date: string; name: string; type: Holiday['type']; note?: string | null; isPaid: boolean }) =>
    unwrap<Holiday>(api.post('/api/settings/holidays', data)),
  updateHoliday: (id: string, data: Partial<{ date: string; name: string; type: Holiday['type']; note: string | null; isPaid: boolean }>) =>
    unwrap<Holiday>(api.patch(`/api/settings/holidays/${id}`, data)),
  deleteHoliday: (id: string) =>
    unwrap<{ success: boolean }>(api.delete(`/api/settings/holidays/${id}`)),

  listLeaves: (employeeId?: string) =>
    unwrap<LeaveRecord[]>(api.get('/api/settings/leaves', { params: employeeId ? { employeeId } : {} })),
  createLeave: (data: Record<string, unknown>) =>
    unwrap<LeaveRecord>(api.post('/api/settings/leaves', data)),
  listWorkSchedules: () => unwrap<WorkScheduleProfile[]>(api.get('/api/settings/work-schedules')),
  createWorkSchedule: (data: Record<string, unknown>) =>
    unwrap<WorkScheduleProfile>(api.post('/api/settings/work-schedules', data)),
};
