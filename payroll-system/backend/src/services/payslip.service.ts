import { EmploymentType, Prisma, type PayrollPeriodStatus } from '@prisma/client';
import { prisma } from '../plugins/prisma.js';
import { loadSettings } from './settings.service.js';
import { recordAudit } from './audit.service.js';
import { money } from '../utils/money.js';
import { dayjs } from '../utils/datetime.js';
import { badRequest, notFound, unprocessable } from '../utils/errors.js';
import type { Actor } from './payroll.service.js';

export interface PayslipLine {
  label: string;
  quantity: string | null;
  rate: string | null;
  amount: string;
}

/** Everything the printable payslip needs, frozen at issue time. */
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
   * How this employee's pay was arrived at, so the document can be honest about
   * it: an hourly employee has a rate and worked minutes and no monthly salary,
   * a salaried one has a salary whose per-day and per-hour bases are derived
   * figures rather than a second kind of wage.
   */
  pay: {
    kind: 'HOURLY' | 'MONTHLY';
    /** Hourly rate for hourly staff, else null. */
    hourlyRate: string | null;
    /** Monthly salary for salaried staff, else null. */
    monthlySalary: string | null;
    dailyBase: string;
    hourlyBase: string;
    /** The true observed duration across the period. */
    workedMinutes: number;
    /**
     * DAILY only. The unpaid break removed and the minutes actually paid for.
     * Kept distinct from workedMinutes so the document never presents paid
     * hours as though they were the hours the employee stood at work.
     */
    breakDeductionMinutes: number;
    payableMinutes: number;
    /** What the company rounding interval discarded. */
    roundedAwayMinutes: number;
    /** MONTHLY: lateness as observed and after the floor, plus hours charged. */
    lateMinutes: number;
    roundedLateMinutes: number;
    lateChargedHours: number;
    payConfigured: boolean;
  };
  period: {
    code: string;
    name: string;
    startDate: string;
    endDate: string;
    /** Payroll workflow status at snapshot time, so a draft can be marked. */
    status: PayrollPeriodStatus;
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

const fmtQty = (value: Prisma.Decimal | null): string | null =>
  value === null ? null : value.toString();

async function buildSnapshot(payrollEmployeeId: string): Promise<{
  snapshot: PayslipSnapshot;
  row: Awaited<ReturnType<typeof loadPayrollEmployee>>;
}> {
  const row = await loadPayrollEmployee(payrollEmployeeId);
  const company = await prisma.company.findFirst();
  const hourly =
    row.employmentType === EmploymentType.DAILY || row.employmentType === EmploymentType.HOURLY;

  const snapshot: PayslipSnapshot = {
    company: {
      name: company?.name ?? 'บริษัท',
      nameEn: company?.nameEn ?? null,
      address: company?.address ?? null,
      taxId: company?.taxId ?? null,
      phone: company?.phone ?? null,
    },
    employee: {
      employeeCode: row.employeeCode,
      name: row.employeeName,
      nickname: row.employee.nickname,
      department: row.departmentName,
      position: row.positionName,
      employmentType: row.employmentType,
      bankName: row.employee.bankName,
      bankAccount: row.employee.bankAccount,
      taxId: row.employee.taxId,
      socialSecurity: row.employee.socialSecurity,
    },
    pay: {
      kind: hourly ? 'HOURLY' : 'MONTHLY',
      // The hourly rate is the derived hourly base, which for hourly staff IS
      // their stored rate - the payroll run writes it there when it calculates.
      hourlyRate: hourly ? money(row.hourlyBase).toFixed(2) : null,
      monthlySalary: hourly ? null : money(row.baseSalary).toFixed(2),
      dailyBase: money(row.dailyBase).toFixed(2),
      hourlyBase: money(row.hourlyBase).toFixed(2),
      workedMinutes: Math.round(Number(row.workingHours) * 60),
      breakDeductionMinutes: row.breakDeductionMinutes,
      payableMinutes: row.payableMinutes,
      roundedAwayMinutes: row.roundedAwayMinutes,
      lateMinutes: row.lateMinutes,
      roundedLateMinutes: row.roundedLateMinutes,
      lateChargedHours: row.lateDeductionHours,
      payConfigured: row.payConfigured,
    },
    period: {
      code: row.period.code,
      name: row.period.name,
      startDate: dayjs.utc(row.period.startDate).format('YYYY-MM-DD'),
      endDate: dayjs.utc(row.period.endDate).format('YYYY-MM-DD'),
      status: row.period.status,
    },
    paymentDate: row.period.paymentDate
      ? dayjs.utc(row.period.paymentDate).format('YYYY-MM-DD')
      : null,
    attendance: {
      workingDays: row.workingDays,
      presentDays: row.presentDays,
      absentDays: row.absentDays,
      leaveDays: row.leaveDays.toString(),
      lateCount: row.lateCount,
      lateMinutes: row.lateMinutes,
      workingHours: row.workingHours.toString(),
      otHours: row.otHours.toString(),
    },
    incomes: row.incomes.map((i) => ({
      label: i.label,
      quantity: fmtQty(i.quantity),
      rate: fmtQty(i.rate),
      amount: money(i.amount).toFixed(2),
    })),
    deductions: row.deductions.map((d) => ({
      label: d.label,
      quantity: fmtQty(d.quantity),
      rate: fmtQty(d.rate),
      amount: money(d.amount).toFixed(2),
    })),
    totals: {
      grossIncome: money(row.grossIncome).toFixed(2),
      totalDeduction: money(row.totalDeduction).toFixed(2),
      netSalary: money(row.netSalary).toFixed(2),
    },
  };

  return { snapshot, row };
}

async function loadPayrollEmployee(id: string) {
  const row = await prisma.payrollEmployee.findUnique({
    where: { id },
    include: {
      incomes: { orderBy: { createdAt: 'asc' } },
      deductions: { orderBy: { createdAt: 'asc' } },
      period: true,
      employee: true,
    },
  });
  if (!row) throw notFound('Payroll employee');
  return row;
}

/**
 * Issue payslips for a period. Only APPROVED, PAID or LOCKED periods can be
 * issued, so a payslip never reflects numbers that are still being reviewed.
 * Re-issuing refreshes the snapshot of an existing payslip rather than creating
 * a second document for the same employee and period.
 */
export async function generatePayslips(periodId: string, actor: Actor) {
  const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw notFound('Payroll period');
  if (!['APPROVED', 'PAID', 'LOCKED'].includes(period.status)) {
    throw badRequest('ต้องอนุมัติรอบเงินเดือนก่อนจึงจะออกสลิปเงินเดือนได้');
  }

  const settings = await loadSettings();
  const prefix = settings.string('PAYSLIP_PREFIX') || 'PS';

  const rows = await prisma.payrollEmployee.findMany({
    where: { periodId, status: { not: 'EXCLUDED' } },
    orderBy: { employeeCode: 'asc' },
    select: { id: true, employeeId: true, employeeCode: true },
  });

  let created = 0;
  let refreshed = 0;

  for (const row of rows) {
    const { snapshot, row: full } = await buildSnapshot(row.id);
    const existing = await prisma.payslip.findUnique({
      where: { payrollEmployeeId: row.id },
    });

    if (existing) {
      await prisma.payslip.update({
        where: { id: existing.id },
        data: {
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
          netSalary: full.netSalary,
          paymentDate: period.paymentDate,
        },
      });
      refreshed += 1;
    } else {
      await prisma.payslip.create({
        data: {
          payslipNo: `${prefix}-${period.code}-${row.employeeCode}`,
          periodId,
          employeeId: row.employeeId,
          payrollEmployeeId: row.id,
          paymentDate: period.paymentDate,
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
          netSalary: full.netSalary,
          createdBy: actor.userId,
        },
      });
      created += 1;
    }
  }

  await recordAudit({
    action: 'PAYSLIP_GENERATE',
    entity: 'PayrollPeriod',
    entityId: periodId,
    newValue: { created, refreshed },
    userId: actor.userId,
    userEmail: actor.email,
    ipAddress: actor.ip,
    userAgent: actor.userAgent,
  });

  return { created, refreshed, total: rows.length };
}

export async function listPayslips(params: {
  page: number;
  pageSize: number;
  periodId?: string;
  employeeId?: string;
  search?: string;
}) {
  const where: Prisma.PayslipWhereInput = {
    ...(params.periodId ? { periodId: params.periodId } : {}),
    ...(params.employeeId ? { employeeId: params.employeeId } : {}),
    ...(params.search
      ? {
          OR: [
            { payslipNo: { contains: params.search } },
            { employee: { employeeCode: { contains: params.search } } },
            { employee: { firstName: { contains: params.search } } },
            { employee: { lastName: { contains: params.search } } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.payslip.findMany({
      where,
      include: {
        employee: { select: { employeeCode: true, firstName: true, lastName: true } },
        period: { select: { code: true, name: true } },
      },
      orderBy: [{ issuedAt: 'desc' }, { payslipNo: 'asc' }],
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.payslip.count({ where }),
  ]);

  return { items, total, page: params.page, pageSize: params.pageSize };
}

export async function getPayslip(id: string) {
  const payslip = await prisma.payslip.findUnique({
    where: { id },
    include: {
      employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
      period: { select: { id: true, code: true, name: true } },
    },
  });
  if (!payslip) throw notFound('Payslip');
  return payslip;
}

/**
 * Live preview built from the calculated payroll row.
 *
 * Deliberately not gated on the payroll workflow: a preview is available in
 * DRAFT, ATTENDANCE_REVIEW, CALCULATED, REVIEW, APPROVED, PAID and LOCKED
 * alike, and needs no persisted Payslip row. Issuing a payslip is a separate,
 * approval-gated act that produces the final document; being unable to look at
 * the figures until then helps nobody.
 *
 * The failures a user can actually hit are told apart, in Thai, so the dialog
 * can explain itself rather than showing a bare "not found".
 */
export async function previewPayslip(periodId: string, employeeId: string) {
  const period = await prisma.payrollPeriod.findUnique({
    where: { id: periodId },
    select: { id: true },
  });
  if (!period) throw notFound('Payroll period');

  const row = await prisma.payrollEmployee.findUnique({
    where: { period_employee: { periodId, employeeId } },
    select: { id: true, calculatedAt: true },
  });
  if (!row) {
    throw unprocessable(
      'ไม่พบรายการเงินเดือนของพนักงานคนนี้ในรอบนี้ กรุณากดคำนวณเงินเดือนก่อน'
    );
  }
  if (!row.calculatedAt) {
    throw unprocessable('ยังไม่มีผลการคำนวณเงินเดือนของพนักงานคนนี้ในรอบนี้');
  }

  const { snapshot } = await buildSnapshot(row.id);
  return snapshot;
}
