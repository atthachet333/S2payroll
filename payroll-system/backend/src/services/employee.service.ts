import { AttendanceStatus, EmployeeStatus, Prisma } from '@prisma/client';
import { prisma } from '../plugins/prisma.js';
import { recordAudit } from './audit.service.js';
import { dec, toPrismaDecimal } from '../utils/money.js';
import { dayjs } from '../utils/datetime.js';
import { conflict, notFound } from '../utils/errors.js';
import {
  completenessWhere,
  evaluateEmployeeProfileCompleteness,
  withProfileCompleteness,
  type CompletenessFilter,
} from './employee-completeness.service.js';
import type { Actor } from './payroll.service.js';

export interface EmployeeListParams {
  /** Master-data completeness, evaluated by employee-completeness.service. */
  completeness?: CompletenessFilter;
  page: number;
  pageSize: number;
  search?: string;
  departmentId?: string;
  status?: EmployeeStatus;
  employmentType?: string;
}

const employeeInclude = {
  department: { select: { id: true, code: true, name: true } },
  position: { select: { id: true, code: true, name: true } },
} satisfies Prisma.EmployeeInclude;

export async function listEmployees(params: EmployeeListParams) {
  const where: Prisma.EmployeeWhereInput = {
    ...(params.status ? { status: params.status } : {}),
    ...(params.departmentId ? { departmentId: params.departmentId } : {}),
    ...(params.employmentType
      ? { employmentType: params.employmentType as Prisma.EnumEmploymentTypeFilter['equals'] }
      : {}),
    ...(params.search
      ? {
          OR: [
            { employeeCode: { contains: params.search } },
            { firstName: { contains: params.search } },
            { lastName: { contains: params.search } },
            { nickname: { contains: params.search } },
          ],
        }
      : {}),
    // Applied in the database so it composes with pagination and the other
    // filters rather than trimming an already-paged slice.
    ...(params.completeness ? completenessWhere(params.completeness) : {}),
  };

  const [items, total] = await Promise.all([
    prisma.employee.findMany({
      where,
      include: employeeInclude,
      orderBy: { employeeCode: 'asc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.employee.count({ where }),
  ]);

  return {
    items: items.map(withProfileCompleteness),
    total,
    page: params.page,
    pageSize: params.pageSize,
  };
}

export async function getEmployee(id: string) {
  const employee = await prisma.employee.findUnique({
    where: { id },
    include: {
      ...employeeInclude,
      salaryHistory: { orderBy: { effectiveDate: 'desc' } },
    },
  });
  if (!employee) throw notFound('Employee');
  return withProfileCompleteness(employee);
}

export interface EmployeeInput {
  employeeCode: string;
  firstName: string;
  lastName: string;
  nickname?: string | null;
  nationalId?: string | null;
  email?: string | null;
  phone?: string | null;
  departmentId?: string | null;
  positionId?: string | null;
  employmentType: 'MONTHLY' | 'DAILY' | 'HOURLY' | 'CONTRACT';
  startDate: string;
  endDate?: string | null;
  baseSalary: string | number;
  bankName?: string | null;
  bankAccount?: string | null;
  taxId?: string | null;
  socialSecurity?: string | null;
  ssoEnabled?: boolean;
  taxEnabled?: boolean;
  otEligible?: boolean;
  attendanceRequired?: boolean;
  leaveTrackingRequired?: boolean;
  status?: EmployeeStatus;
  note?: string | null;
}

export async function createEmployee(input: EmployeeInput, actor: Actor) {
  const existing = await prisma.employee.findUnique({
    where: { employeeCode: input.employeeCode },
  });
  if (existing) throw conflict(`รหัสพนักงาน ${input.employeeCode} ถูกใช้แล้ว`);

  const employee = await prisma.employee.create({
    data: {
      employeeCode: input.employeeCode,
      firstName: input.firstName,
      lastName: input.lastName,
      nickname: input.nickname ?? null,
      nationalId: input.nationalId ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      departmentId: input.departmentId || null,
      positionId: input.positionId || null,
      employmentType: input.employmentType,
      startDate: dayjs.utc(input.startDate).startOf('day').toDate(),
      endDate: input.endDate ? dayjs.utc(input.endDate).startOf('day').toDate() : null,
      baseSalary: toPrismaDecimal(input.baseSalary),
      bankName: input.bankName ?? null,
      bankAccount: input.bankAccount ?? null,
      taxId: input.taxId ?? null,
      socialSecurity: input.socialSecurity ?? null,
      ssoEnabled: input.ssoEnabled ?? true,
      taxEnabled: input.taxEnabled ?? true,
      otEligible: input.otEligible ?? true,
      attendanceRequired: input.attendanceRequired ?? true,
      leaveTrackingRequired: input.leaveTrackingRequired ?? true,
      status: input.status ?? EmployeeStatus.ACTIVE,
      note: input.note ?? null,
      createdBy: actor.userId,
    },
    include: employeeInclude,
  });

  await recordAudit({
    action: 'EMPLOYEE_CREATE',
    entity: 'Employee',
    entityId: employee.id,
    newValue: { employeeCode: employee.employeeCode, name: `${employee.firstName} ${employee.lastName}` },
    userId: actor.userId,
    userEmail: actor.email,
    ipAddress: actor.ip,
    userAgent: actor.userAgent,
  });

  return employee;
}

export async function updateEmployee(
  id: string,
  input: Partial<EmployeeInput> & { salaryChangeReason?: string; salaryEffectiveDate?: string },
  actor: Actor
) {
  const current = await prisma.employee.findUnique({ where: { id } });
  if (!current) throw notFound('Employee');

  const data: Prisma.EmployeeUpdateInput = {};
  if (input.firstName !== undefined) data.firstName = input.firstName;
  if (input.lastName !== undefined) data.lastName = input.lastName;
  if (input.nickname !== undefined) data.nickname = input.nickname;
  if (input.nationalId !== undefined) data.nationalId = input.nationalId;
  if (input.email !== undefined) data.email = input.email;
  if (input.phone !== undefined) data.phone = input.phone;
  if (input.employmentType !== undefined) data.employmentType = input.employmentType;
  if (input.startDate !== undefined) data.startDate = dayjs.utc(input.startDate).startOf('day').toDate();
  if (input.endDate !== undefined) {
    data.endDate = input.endDate ? dayjs.utc(input.endDate).startOf('day').toDate() : null;
  }
  if (input.bankName !== undefined) data.bankName = input.bankName;
  if (input.bankAccount !== undefined) data.bankAccount = input.bankAccount;
  if (input.taxId !== undefined) data.taxId = input.taxId;
  if (input.socialSecurity !== undefined) data.socialSecurity = input.socialSecurity;
  if (input.ssoEnabled !== undefined) data.ssoEnabled = input.ssoEnabled;
  if (input.taxEnabled !== undefined) data.taxEnabled = input.taxEnabled;
  if (input.otEligible !== undefined) data.otEligible = input.otEligible;
  if (input.attendanceRequired !== undefined) data.attendanceRequired = input.attendanceRequired;
  if (input.leaveTrackingRequired !== undefined) data.leaveTrackingRequired = input.leaveTrackingRequired;
  if (input.status !== undefined) data.status = input.status;
  if (input.note !== undefined) data.note = input.note;
  if (input.departmentId !== undefined) {
    data.department = input.departmentId
      ? { connect: { id: input.departmentId } }
      : { disconnect: true };
  }
  if (input.positionId !== undefined) {
    data.position = input.positionId ? { connect: { id: input.positionId } } : { disconnect: true };
  }

  const salaryChanged =
    input.baseSalary !== undefined && !dec(input.baseSalary).equals(dec(current.baseSalary));
  if (input.baseSalary !== undefined) data.baseSalary = toPrismaDecimal(input.baseSalary);

  const employee = await prisma.$transaction(async (tx) => {
    const updated = await tx.employee.update({ where: { id }, data, include: employeeInclude });

    // A salary change is history, not just a field edit.
    if (salaryChanged) {
      await tx.salaryHistory.create({
        data: {
          employeeId: id,
          previousSalary: current.baseSalary,
          newSalary: toPrismaDecimal(input.baseSalary!),
          effectiveDate: input.salaryEffectiveDate
            ? dayjs.utc(input.salaryEffectiveDate).startOf('day').toDate()
            : dayjs.utc().startOf('day').toDate(),
          reason: input.salaryChangeReason ?? null,
          createdBy: actor.userId,
        },
      });
    }

    return updated;
  });

  await recordAudit({
    action: 'EMPLOYEE_UPDATE',
    entity: 'Employee',
    entityId: id,
    oldValue: { baseSalary: current.baseSalary.toString(), status: current.status },
    newValue: { baseSalary: employee.baseSalary.toString(), status: employee.status },
    reason: input.salaryChangeReason ?? null,
    userId: actor.userId,
    userEmail: actor.email,
    ipAddress: actor.ip,
    userAgent: actor.userAgent,
  });

  return employee;
}

/** Employees are never hard-deleted; deactivation preserves payroll history. */
export async function deactivateEmployee(id: string, reason: string, actor: Actor) {
  const current = await prisma.employee.findUnique({ where: { id } });
  if (!current) throw notFound('Employee');

  const employee = await prisma.employee.update({
    where: { id },
    data: {
      status: EmployeeStatus.INACTIVE,
      endDate: current.endDate ?? dayjs.utc().startOf('day').toDate(),
    },
    include: employeeInclude,
  });

  await recordAudit({
    action: 'EMPLOYEE_DEACTIVATE',
    entity: 'Employee',
    entityId: id,
    oldValue: { status: current.status },
    newValue: { status: EmployeeStatus.INACTIVE },
    reason,
    userId: actor.userId,
    userEmail: actor.email,
    ipAddress: actor.ip,
    userAgent: actor.userAgent,
  });

  return employee;
}

/** Attendance totals and payslip history shown on the employee detail page. */
export async function employeeSummary(id: string, from?: Date, to?: Date) {
  const employee = await getEmployee(id);

  const where: Prisma.AttendanceRecordWhereInput = {
    employeeId: id,
    ...(from || to
      ? { workDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : {}),
  };

  const [aggregate, grouped, payslips, payrollRows] = await Promise.all([
    prisma.attendanceRecord.aggregate({
      where,
      _sum: { workedMinutes: true, otMinutes: true, lateMinutes: true },
      _count: { _all: true },
    }),
    prisma.attendanceRecord.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.payslip.findMany({
      where: { employeeId: id },
      include: { period: { select: { code: true, name: true } } },
      orderBy: { issuedAt: 'desc' },
      take: 24,
    }),
    prisma.payrollEmployee.findMany({
      where: { employeeId: id },
      include: { period: { select: { code: true, name: true, year: true, month: true } } },
      orderBy: { createdAt: 'desc' },
      take: 24,
    }),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const row of grouped) statusCounts[row.status] = row._count._all;

  return {
    employee,
    attendance: {
      totalRecords: aggregate._count._all,
      workedMinutes: aggregate._sum.workedMinutes ?? 0,
      otMinutes: aggregate._sum.otMinutes ?? 0,
      lateMinutes: aggregate._sum.lateMinutes ?? 0,
      statusCounts,
    },
    payslips,
    payrollHistory: payrollRows,
  };
}

export async function employeeAttendanceHistory(
  id: string,
  year: number,
  month: number,
  page: number,
  pageSize: number,
  status?: string
) {
  await getEmployee(id);
  const start = dayjs.utc(`${year}-${String(month).padStart(2, '0')}-01`).startOf('month');
  const end = start.endOf('month').startOf('day');
  const where: Prisma.AttendanceRecordWhereInput = {
    employeeId: id,
    workDate: { gte: start.toDate(), lte: end.toDate() },
    ...(status ? { status: status as AttendanceStatus } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.attendanceRecord.findMany({
      where, orderBy: { workDate: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
      include: { employee: { select: { firstName: true, lastName: true, employmentType: true } } },
    }),
    prisma.attendanceRecord.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

// --- departments & positions -------------------------------------------------

export const listDepartments = () =>
  prisma.department.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { employees: true } } } });

export const createDepartment = (data: { code: string; name: string }, actor: Actor) =>
  prisma.department.create({ data: { ...data, createdBy: actor.userId } });

export const updateDepartment = (id: string, data: { name?: string; isActive?: boolean }) =>
  prisma.department.update({ where: { id }, data });

export const listPositions = () =>
  prisma.position.findMany({ orderBy: { name: 'asc' }, include: { department: true } });

export const createPosition = (
  data: { code: string; name: string; departmentId?: string | null },
  actor: Actor
) =>
  prisma.position.create({
    data: { ...data, departmentId: data.departmentId || null, createdBy: actor.userId },
  });

export const updatePosition = (
  id: string,
  data: { name?: string; departmentId?: string | null; isActive?: boolean }
) => prisma.position.update({ where: { id }, data });

/**
 * Counters for the Employees page header.
 *
 * Evaluated with the same helper the rows use, so the badge on a row can never
 * disagree with the count above the table.
 */
export async function employeeCompletenessSummary() {
  const employees = await prisma.employee.findMany({
    select: {
      employeeCode: true, firstName: true, lastName: true, employmentType: true,
      departmentId: true, positionId: true, startDate: true, status: true, baseSalary: true,
      attendanceRequired: true, leaveTrackingRequired: true,
    },
    orderBy: { employeeCode: 'asc' },
  });

  const evaluated = employees.map((employee) => ({
    employeeCode: employee.employeeCode,
    name: `${employee.firstName} ${employee.lastName}`.trim(),
    ...evaluateEmployeeProfileCompleteness(employee),
  }));

  return {
    total: evaluated.length,
    complete: evaluated.filter((e) => e.complete).length,
    incomplete: evaluated.filter((e) => !e.complete).length,
    incompleteEmployees: evaluated
      .filter((e) => !e.complete)
      .map((e) => ({
        employeeCode: e.employeeCode,
        name: e.name,
        missingCount: e.missingCount,
        missingLabels: e.missingLabels,
      })),
  };
}
