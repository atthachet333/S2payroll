import { z } from 'zod';

/** Every request body and query string is validated against one of these. */

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, 'Expected an ISO date (YYYY-MM-DD)');

const decimalString = z
  .union([z.string(), z.number()])
  .refine((v) => v !== '' && !Number.isNaN(Number(v)), 'Expected a numeric value')
  .transform((v) => String(v));

// --- auth --------------------------------------------------------------------

export const loginSchema = z.object({
  email: z.string().email('รูปแบบอีเมลไม่ถูกต้อง'),
  password: z.string().min(1, 'กรุณากรอกรหัสผ่าน'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(8, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร')
    .regex(/[A-Za-z]/, 'รหัสผ่านต้องมีตัวอักษรอย่างน้อย 1 ตัว')
    .regex(/[0-9]/, 'รหัสผ่านต้องมีตัวเลขอย่างน้อย 1 ตัว'),
});

// --- employees ---------------------------------------------------------------

export const employmentTypeSchema = z.enum(['MONTHLY', 'DAILY', 'HOURLY', 'CONTRACT']);
export const employeeStatusSchema = z.enum(['ACTIVE', 'INACTIVE', 'TERMINATED', 'PROBATION']);

export const createEmployeeSchema = z.object({
  employeeCode: z.string().min(1).max(32),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  nickname: z.string().max(64).nullish(),
  nationalId: z.string().max(32).nullish(),
  email: z.string().email().nullish().or(z.literal('')),
  phone: z.string().max(32).nullish(),
  departmentId: z.string().uuid().nullish().or(z.literal('')),
  positionId: z.string().uuid().nullish().or(z.literal('')),
  employmentType: employmentTypeSchema.default('MONTHLY'),
  startDate: dateString,
  endDate: dateString.nullish(),
  baseSalary: decimalString,
  bankName: z.string().max(100).nullish(),
  bankAccount: z.string().max(64).nullish(),
  taxId: z.string().max(32).nullish(),
  socialSecurity: z.string().max(32).nullish(),
  ssoEnabled: z.boolean().optional(),
  taxEnabled: z.boolean().optional(),
  otEligible: z.boolean().optional(),
  attendanceRequired: z.boolean().optional(),
  leaveTrackingRequired: z.boolean().optional(),
  status: employeeStatusSchema.optional(),
  note: z.string().max(500).nullish(),
});

export const updateEmployeeSchema = createEmployeeSchema
  .partial()
  .omit({ employeeCode: true })
  .extend({
    salaryChangeReason: z.string().max(255).optional(),
    salaryEffectiveDate: dateString.optional(),
  });

export const employeeQuerySchema = paginationSchema.extend({
  search: z.string().optional(),
  departmentId: z.string().uuid().optional(),
  status: employeeStatusSchema.optional(),
  employmentType: employmentTypeSchema.optional(),
  /** Master-data completeness, not payroll readiness for a period. */
  completeness: z.enum(['COMPLETE', 'INCOMPLETE']).optional(),
});

export const deactivateSchema = z.object({
  reason: z.string().min(3, 'กรุณาระบุเหตุผล').max(500),
});

// --- attendance --------------------------------------------------------------

export const attendanceStatusSchema = z.enum([
  'NORMAL',
  'LATE',
  'OT',
  'ABSENT',
  'MISSING_DATA',
  'LEAVE',
  'HOLIDAY',
]);

export const attendanceQuerySchema = paginationSchema.extend({
  employeeId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  from: dateString.optional(),
  to: dateString.optional(),
  status: attendanceStatusSchema.optional(),
  employmentType: employmentTypeSchema.optional(),
  includeExempt: z.coerce.boolean().optional().default(false),
  search: z.string().optional(),
});

export const correctAttendanceSchema = z
  .object({
    checkIn: z.string().nullish(),
    checkOut: z.string().nullish(),
    status: attendanceStatusSchema.optional(),
    note: z.string().max(500).nullish(),
    reason: z.string().min(3, 'กรุณาระบุเหตุผลในการแก้ไข').max(500),
  })
  .refine(
    (v) =>
      v.checkIn !== undefined ||
      v.checkOut !== undefined ||
      v.status !== undefined ||
      v.note !== undefined,
    { message: 'ต้องระบุอย่างน้อยหนึ่งฟิลด์ที่ต้องการแก้ไข' }
  );

export const recalculateSchema = z.object({
  from: dateString,
  to: dateString,
  employeeId: z.string().uuid().optional(),
});

// --- sheets sync -------------------------------------------------------------

export const syncSchema = z.object({
  sheetId: z.string().optional(),
  range: z.string().optional(),
  dryRun: z.boolean().optional().default(false),
});

// --- payroll -----------------------------------------------------------------

export const createPeriodSchema = z
  .object({
    year: z.coerce.number().int().min(2000).max(2100),
    month: z.coerce.number().int().min(1).max(12),
    /** Optional custom window. Defaults to the calendar month when omitted. */
    startDate: dateString.nullish(),
    endDate: dateString.nullish(),
    paymentDate: dateString.nullish(),
    note: z.string().max(500).nullish(),
  })
  .refine((v) => !v.startDate || !v.endDate || v.endDate >= v.startDate, {
    message: 'วันสิ้นสุดรอบต้องไม่ก่อนวันเริ่มรอบ',
    path: ['endDate'],
  });

export const periodSuggestQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

export const payrollEmployeeStatusSchema = z.enum([
  'READY',
  'NEEDS_REVIEW',
  'MISSING_DATA',
  'EXCLUDED',
]);

export const periodEmployeeQuerySchema = paginationSchema.extend({
  search: z.string().optional(),
  departmentId: z.string().uuid().optional(),
  status: payrollEmployeeStatusSchema.optional(),
});

export const adjustableFieldSchema = z.enum([
  'allowanceAmount',
  'bonusAmount',
  'commissionAmount',
  'otherIncome',
  'otAmount',
  'loanDeduction',
  'otherDeduction',
  'lateDeduction',
  'leaveDeduction',
  'absenceDeduction',
  'socialSecurity',
  'tax',
]);

export const adjustPayrollSchema = z.object({
  adjustments: z
    .array(
      z.object({
        field: adjustableFieldSchema,
        value: decimalString,
        reason: z.string().min(3, 'กรุณาระบุเหตุผล').max(500),
      })
    )
    .min(1),
  status: payrollEmployeeStatusSchema.optional(),
});

export const markPaidSchema = z.object({
  paymentDate: dateString.optional(),
});

export const unlockSchema = z.object({
  reason: z.string().min(5, 'กรุณาระบุเหตุผลในการปลดล็อก').max(500),
});

// --- payslips ----------------------------------------------------------------

export const payslipQuerySchema = paginationSchema.extend({
  periodId: z.string().uuid().optional(),
  employeeId: z.string().uuid().optional(),
  search: z.string().optional(),
});

// --- reports -----------------------------------------------------------------

export const reportTypeSchema = z.enum([
  'payroll-summary',
  'attendance-summary',
  'ot',
  'late',
  'absence',
  'payroll-by-department',
  'salary-history',
]);

export const reportQuerySchema = z.object({
  periodId: z.string().uuid().optional(),
  from: dateString.optional(),
  to: dateString.optional(),
  departmentId: z.string().uuid().optional(),
  employeeId: z.string().uuid().optional(),
  employmentType: employmentTypeSchema.optional(),
  status: payrollEmployeeStatusSchema.optional(),
  format: z.enum(['json', 'csv', 'excel', 'pdf']).default('json'),
});

// --- settings ----------------------------------------------------------------

export const updateSettingsSchema = z.object({
  settings: z.array(z.object({ key: z.string().min(1), value: z.string() })).min(1),
});

export const companySchema = z.object({
  name: z.string().min(1).max(191),
  nameEn: z.string().max(191).nullish(),
  taxId: z.string().max(32).nullish(),
  address: z.string().max(500).nullish(),
  phone: z.string().max(32).nullish(),
  email: z.string().email().nullish().or(z.literal('')),
  ssoBranchNo: z.string().max(32).nullish(),
});

export const departmentSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(191),
});

export const positionSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(191),
  departmentId: z.string().uuid().nullish().or(z.literal('')),
});

export const roleCodeSchema = z.enum(['SUPER_ADMIN', 'ADMIN', 'HR', 'PAYROLL', 'VIEWER']);

export const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  roleCode: roleCodeSchema,
  employeeId: z.string().uuid().nullish().or(z.literal('')),
});

export const updateUserSchema = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  roleCode: roleCodeSchema.optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(8).optional(),
});

export const auditQuerySchema = paginationSchema.extend({
  entity: z.string().optional(),
  entityId: z.string().optional(),
  userId: z.string().uuid().optional(),
  action: z.string().optional(),
  from: dateString.optional(),
  to: dateString.optional(),
});

// --- leave & holidays --------------------------------------------------------

export const leaveSchema = z.object({
  employeeId: z.string().uuid(),
  leaveType: z.enum(['ANNUAL', 'SICK', 'PERSONAL', 'MATERNITY', 'UNPAID', 'OTHER']),
  startDate: dateString,
  endDate: dateString,
  isPaid: z.boolean().default(true),
  reason: z.string().max(500).nullish(),
});

export const holidaySchema = z.object({
  date: dateString,
  name: z.string().min(1).max(191),
  type: z.enum(['PUBLIC_HOLIDAY', 'COMPANY_HOLIDAY']).default('COMPANY_HOLIDAY'),
  note: z.string().max(500).nullish(),
  isPaid: z.boolean().default(true),
});

export const payProfileSchema = z.object({
  payType: z.enum(['MONTHLY', 'HOURLY']),
  monthlySalary: decimalString.nullish(),
  hourlyRate: decimalString.nullish(),
  effectiveFrom: dateString,
  effectiveTo: dateString.nullish(),
  isActive: z.boolean().default(true),
}).superRefine((value, context) => {
  const required = value.payType === 'MONTHLY' ? value.monthlySalary : value.hourlyRate;
  if (required === null || required === undefined || Number(required) <= 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [value.payType === 'MONTHLY' ? 'monthlySalary' : 'hourlyRate'],
      message: value.payType === 'MONTHLY' ? 'กรุณาระบุเงินเดือนที่มากกว่า 0' : 'กรุณาระบุอัตราค่าจ้างต่อชั่วโมงที่มากกว่า 0',
    });
  }
});

/**
 * Per-employee payroll policy. Every field is optional and nullable: omitting
 * one leaves it untouched, and sending null clears it back to "use the company
 * default". A 0 is a real value meaning "deduct nothing" and is preserved.
 */
export const employeePayrollPolicySchema = z.object({
  lateDeductionType: z.enum(['NONE', 'PER_HOUR_FROM_BASE', 'FIXED_AMOUNT']).nullish(),
  lateDeductionAmount: decimalString.nullish(),
  leaveDeductionType: z.enum(['NONE', 'PER_DAY_FROM_BASE', 'FIXED_AMOUNT']).nullish(),
  leaveDeductionAmount: decimalString.nullish(),
  absenceDeductionType: z.enum(['NONE', 'PER_DAY_FROM_BASE', 'FIXED_AMOUNT']).nullish(),
  absenceDeductionAmount: decimalString.nullish(),
  socialSecurityAmount: decimalString.nullish(),
  taxAmount: decimalString.nullish(),
  note: z.string().trim().max(500).nullish(),
});

/** Bringing a deactivated employee back. The return date is never defaulted. */
export const reactivateEmployeeSchema = z.object({
  returnDate: dateString,
  reason: z.string().trim().max(500).nullish(),
});

/**
 * A hand-authored attendance day. HR supplies only observed facts - the date and
 * the punches. Worked, late and OT minutes are derived by the backend and are
 * deliberately absent from this schema.
 */
export const manualAttendanceSchema = z.object({
  workDate: dateString,
  checkIn: z.string().trim().max(32).nullish(),
  checkOut: z.string().trim().max(32).nullish(),
  reason: z.string().trim().min(3, 'กรุณาระบุเหตุผลอย่างน้อย 3 ตัวอักษร').max(500),
  note: z.string().trim().max(500).nullish(),
});

export const workScheduleProfileSchema = z.object({
  name: z.string().trim().min(1).max(191),
  effectiveFrom: dateString,
  effectiveTo: dateString.nullish(),
  workingDays: z.array(z.enum(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'])).min(1),
  workStartTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  workEndTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  flexArrivalMinutes: z.number().int().min(0).max(240),
  isActive: z.boolean().default(true),
});

/** A deletion must carry a real reason - it removes a day from payroll. */
export const deleteAttendanceSchema = z.object({
  reason: z.string().trim().min(3, 'กรุณาระบุเหตุผลในการลบ').max(500),
});
