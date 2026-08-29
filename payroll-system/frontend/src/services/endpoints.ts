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
  get: (periodId?: string) =>
    unwrap<Overview>(api.get('/api/overview', { params: periodId ? { periodId } : {} })),
};

// --- employees ---------------------------------------------------------------

export interface EmployeeQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  departmentId?: string;
  status?: string;
  employmentType?: string;
}

export const employeeApi = {
  list: (params: EmployeeQuery) =>
    unwrap<Paginated<Employee>>(api.get('/api/employees', { params })),
  get: (id: string) => unwrap<Employee>(api.get(`/api/employees/${id}`)),
  summary: (id: string, params?: { from?: string; to?: string }) =>
    unwrap<{
      employee: Employee;
      attendance: {
        totalRecords: number;
        workedMinutes: number;
        otMinutes: number;
        lateMinutes: number;
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
  search?: string;
}

export const attendanceApi = {
  list: (params: AttendanceQuery) =>
    unwrap<Paginated<AttendanceRecord>>(api.get('/api/attendance', { params })),
  get: (id: string) => unwrap<AttendanceRecord>(api.get(`/api/attendance/${id}`)),
  summary: (params: { from?: string; to?: string; departmentId?: string }) =>
    unwrap<AttendanceSummary>(api.get('/api/attendance/summary', { params })),
  correct: (
    id: string,
    data: { checkIn?: string | null; checkOut?: string | null; status?: string; note?: string | null; reason: string }
  ) => unwrap<AttendanceRecord>(api.patch(`/api/attendance/${id}`, data)),
  recalculate: (from: string, to: string) =>
    unwrap<{ updated: number }>(api.post('/api/attendance/recalculate', { from, to })),
};

// --- google sheets -----------------------------------------------------------

export const sheetsApi = {
  sync: (data: { sheetId?: string; range?: string; dryRun?: boolean }) =>
    unwrap<SyncResult>(api.post('/api/sheets/sync', data)),
  status: () =>
    unwrap<{
      configured: boolean;
      sheetId: string | null;
      range: string;
      lastSync: SyncHistoryItem | null;
    }>(api.get('/api/sheets/status')),
  history: (params: { page?: number; pageSize?: number }) =>
    unwrap<Paginated<SyncHistoryItem>>(api.get('/api/sheets/history', { params })),
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
  /** Server-rendered A4 PDF. Path only — downloadFile() attaches the auth header. */
  pdfPath: (id: string) => `/api/payslips/${id}/pdf`,
};

// --- reports -----------------------------------------------------------------

export interface ReportQuery {
  periodId?: string;
  from?: string;
  to?: string;
  departmentId?: string;
  employeeId?: string;
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
  createHoliday: (data: { date: string; name: string; isPaid: boolean }) =>
    unwrap<Holiday>(api.post('/api/settings/holidays', data)),
  deleteHoliday: (id: string) =>
    unwrap<{ success: boolean }>(api.delete(`/api/settings/holidays/${id}`)),

  listLeaves: (employeeId?: string) =>
    unwrap<LeaveRecord[]>(api.get('/api/settings/leaves', { params: employeeId ? { employeeId } : {} })),
  createLeave: (data: Record<string, unknown>) =>
    unwrap<LeaveRecord>(api.post('/api/settings/leaves', data)),
};
