import ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import { prisma } from '../plugins/prisma.js';
import { dec, money } from '../utils/money.js';
import { dayjs } from '../utils/datetime.js';
import { notFound } from '../utils/errors.js';
import { valueAttendanceRecords } from './attendance-valuation.service.js';

export type ReportType =
  | 'payroll-summary'
  | 'attendance-summary'
  | 'ot'
  | 'late'
  | 'absence'
  | 'payroll-by-department'
  | 'salary-history';

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

export interface ReportParams {
  periodId?: string;
  from?: Date;
  to?: Date;
  departmentId?: string;
  employeeId?: string;
  employmentType?: string;
  status?: string;
}

async function requirePeriod(periodId: string) {
  const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw notFound('Payroll period');
  return period;
}

export type DetailedPayrollReportRow = Record<string, string | number> & {
  period: string;
  period_code: string;
  employee_code: string;
  employee_name: string;
  department: string;
  position: string;
  employment_type: string;
  calculation_status: string;
  pay_basis: string;
  pay_rate: string;
  working_days: number;
  present_days: number;
  /** The true observed duration. Never the payable figure. */
  worked_hours: string;
  actual_worked_minutes: number;
  /** DAILY only: the unpaid break removed, and the minutes actually paid for. */
  break_deduction_minutes: number;
  rounded_away_minutes: number;
  payable_minutes: number;
  payable_hours: string;
  /** Lateness and early leave as observed, and after the company floor. */
  actual_late_minutes: number;
  rounded_late_minutes: number;
  actual_early_leave_minutes: number;
  rounded_early_leave_minutes: number;
  /** Approved OT before and after the floor. Nothing here creates OT. */
  approved_ot_actual_minutes: number;
  approved_ot_payable_minutes: number;
  ot_hours: string;
  ot_minutes: number;
  late_count: number;
  late_minutes: number;
  leave_days: string;
  absent_days: number;
  base_earnings: string;
  ot_amount: string;
  bonus: string;
  allowance: string;
  commission: string;
  other_income: string;
  gross_income: string;
  late_deduction: string;
  leave_deduction: string;
  absence_deduction: string;
  social_security: string;
  tax: string;
  other_deduction: string;
  total_deduction: string;
  net_salary: string;
  _pay_configured: number;
};

export function summarizeDetailedPayrollRows(rows: DetailedPayrollReportRow[]) {
  const monetary = rows.filter((row) => row._pay_configured === 1);
  const sum = (key: keyof DetailedPayrollReportRow) =>
    monetary.reduce((total, row) => total.plus(dec(row[key] as string | number)), dec(0));
  const sumAll = (key: keyof DetailedPayrollReportRow) =>
    rows.reduce((total, row) => total.plus(dec(row[key] as string | number)), dec(0));
  return {
    employeeCount: rows.length,
    monetaryEmployeeCount: monetary.length,
    unconfiguredCount: rows.length - monetary.length,
    grossTotal: sum('gross_income').toFixed(2),
    deductionTotal: sum('total_deduction').toFixed(2),
    netTotal: sum('net_salary').toFixed(2),
    workedHoursTotal: sumAll('worked_hours').toFixed(2),
    otHoursTotal: sumAll('ot_hours').toFixed(2),
  };
}

async function payrollSummaryReport(params: ReportParams): Promise<ReportData> {
  const period = params.periodId ? await requirePeriod(params.periodId) : null;

  const rows = await prisma.payrollEmployee.findMany({
    where: {
      ...(period ? { periodId: period.id } : {}),
      ...(params.departmentId ? { employee: { departmentId: params.departmentId } } : {}),
      ...(params.employmentType ? { employmentType: params.employmentType as any } : {}),
      ...(params.status ? { status: params.status as any } : {}),
    },
    include: { period: { select: { code: true, name: true, year: true, month: true } } },
    orderBy: [{ period: { year: 'desc' } }, { period: { month: 'desc' } }, { employeeCode: 'asc' }],
  });

  const data: DetailedPayrollReportRow[] = rows.map((r) => {
    const hourly = r.employmentType === 'DAILY' || r.employmentType === 'HOURLY';
    return {
      period: r.period.name,
      period_code: r.period.code,
      employee_code: r.employeeCode,
      employee_name: r.employeeName,
      department: r.departmentName ?? '-',
      position: r.positionName ?? '-',
      employment_type: r.employmentType,
      calculation_status: r.status,
      pay_basis: hourly ? 'อัตรารายชั่วโมง' : 'ฐานเงินเดือนรายเดือน',
      pay_rate: money(hourly ? r.hourlyBase : r.baseSalary).toFixed(2),
      working_days: r.workingDays,
      present_days: r.presentDays,
      // Actual and payable time are separate columns on purpose: an export that
      // showed payable time under a "ชั่วโมงทำงาน" heading would misstate what
      // the employee actually worked, and nobody reading the file would know.
      worked_hours: r.workingHours.toString(),
      actual_worked_minutes: Math.round(Number(r.workingHours) * 60),
      break_deduction_minutes: r.breakDeductionMinutes,
      rounded_away_minutes: r.roundedAwayMinutes,
      payable_minutes: r.payableMinutes,
      payable_hours: (r.payableMinutes / 60).toFixed(2),
      actual_late_minutes: r.lateMinutes,
      rounded_late_minutes: r.roundedLateMinutes,
      actual_early_leave_minutes: r.earlyLeaveMinutes,
      rounded_early_leave_minutes: r.roundedEarlyLeaveMinutes,
      approved_ot_actual_minutes: r.actualOtMinutes,
      approved_ot_payable_minutes: Math.round(Number(r.otHours) * 60),
      ot_hours: r.otHours.toString(),
      ot_minutes: Math.round(Number(r.otHours) * 60),
      late_count: r.lateCount,
      late_minutes: r.lateMinutes,
      leave_days: r.leaveDays.toString(),
      absent_days: r.absentDays,
      base_earnings: money(r.baseSalary).toFixed(2),
      ot_amount: money(r.otAmount).toFixed(2),
      bonus: money(r.bonusAmount).toFixed(2),
      allowance: money(r.allowanceAmount).toFixed(2),
      commission: money(r.commissionAmount).toFixed(2),
      other_income: money(r.otherIncome).toFixed(2),
      gross_income: money(r.grossIncome).toFixed(2),
      late_deduction: money(r.lateDeduction).toFixed(2),
      leave_deduction: money(r.leaveDeduction).toFixed(2),
      absence_deduction: money(r.absenceDeduction).toFixed(2),
      social_security: money(r.socialSecurity).toFixed(2),
      tax: money(r.tax).toFixed(2),
      other_deduction: money(dec(r.loanDeduction).plus(r.otherDeduction)).toFixed(2),
      total_deduction: money(r.totalDeduction).toFixed(2),
      net_salary: money(r.netSalary).toFixed(2),
      _pay_configured: r.payConfigured ? 1 : 0,
    };
  });
  const summary = summarizeDetailedPayrollRows(data);

  return {
    kind: 'detailed-payroll',
    title: `รายงานเงินเดือนแบบละเอียด${period ? ` - ${period.name}` : ''}`,
    columns: [
      { key: 'period', header: 'รอบเงินเดือน', width: 18 },
      { key: 'employee_code', header: 'รหัสพนักงาน', width: 14 },
      { key: 'employee_name', header: 'ชื่อ-นามสกุล', width: 26 },
      { key: 'department', header: 'แผนก', width: 18 },
      { key: 'position', header: 'ตำแหน่ง', width: 18 },
      { key: 'employment_type', header: 'ประเภทพนักงาน', width: 15 },
      { key: 'calculation_status', header: 'สถานะการคำนวณ', width: 18 },
      { key: 'pay_basis', header: 'ประเภทฐานค่าจ้าง', width: 18 },
      { key: 'pay_rate', header: 'ฐานเงินเดือน / อัตราค่าจ้าง', width: 20, numeric: true, format: 'currency' },
      { key: 'working_days', header: 'วันทำงานในรอบ', width: 14, numeric: true },
      { key: 'present_days', header: 'วันที่มาทำงาน', width: 14, numeric: true },
      { key: 'worked_hours', header: 'ชั่วโมงทำงานจริง', width: 16, numeric: true },
      { key: 'break_deduction_minutes', header: 'นาทีพักที่หัก', width: 14, numeric: true },
      { key: 'rounded_away_minutes', header: 'นาทีที่ปัดออก', width: 14, numeric: true },
      { key: 'payable_hours', header: 'ชั่วโมงคิดค่าจ้าง', width: 16, numeric: true },
      { key: 'approved_ot_actual_minutes', header: 'นาที OT จริง', width: 13, numeric: true },
      { key: 'approved_ot_payable_minutes', header: 'นาที OT ที่คิดจ่าย', width: 16, numeric: true },
      { key: 'ot_hours', header: 'ชั่วโมง OT ที่คิดจ่าย', width: 18, numeric: true },
      { key: 'late_count', header: 'จำนวนครั้งมาสาย', width: 15, numeric: true },
      { key: 'actual_late_minutes', header: 'นาทีมาสายจริง', width: 14, numeric: true },
      { key: 'rounded_late_minutes', header: 'นาทีมาสายหลังปัด', width: 16, numeric: true },
      { key: 'actual_early_leave_minutes', header: 'นาทีออกก่อนจริง', width: 15, numeric: true },
      { key: 'rounded_early_leave_minutes', header: 'นาทีออกก่อนหลังปัด', width: 17, numeric: true },
      { key: 'leave_days', header: 'วันลา', width: 10, numeric: true },
      { key: 'absent_days', header: 'วันขาด', width: 10, numeric: true },
      { key: 'base_earnings', header: 'รายได้พื้นฐาน', width: 16, numeric: true, format: 'currency' },
      { key: 'ot_amount', header: 'ค่า OT', width: 14, numeric: true, format: 'currency' },
      { key: 'bonus', header: 'โบนัส', width: 14, numeric: true, format: 'currency' },
      { key: 'allowance', header: 'เบี้ยเลี้ยง', width: 14, numeric: true, format: 'currency' },
      { key: 'commission', header: 'ค่าคอมมิชชั่น', width: 15, numeric: true, format: 'currency' },
      { key: 'other_income', header: 'รายได้อื่น', width: 14, numeric: true, format: 'currency' },
      { key: 'gross_income', header: 'รายได้รวม', width: 16, numeric: true, format: 'currency' },
      { key: 'late_deduction', header: 'หักมาสาย', width: 14, numeric: true, format: 'currency' },
      { key: 'leave_deduction', header: 'หักลา', width: 14, numeric: true, format: 'currency' },
      { key: 'absence_deduction', header: 'หักขาด', width: 14, numeric: true, format: 'currency' },
      { key: 'social_security', header: 'ประกันสังคม', width: 14, numeric: true, format: 'currency' },
      { key: 'tax', header: 'ภาษี', width: 14, numeric: true, format: 'currency' },
      { key: 'other_deduction', header: 'รายการหักอื่น', width: 16, numeric: true, format: 'currency' },
      { key: 'total_deduction', header: 'รายการหักรวม', width: 16, numeric: true, format: 'currency' },
      { key: 'net_salary', header: 'เงินสุทธิ', width: 16, numeric: true, format: 'currency' },
    ],
    rows: data,
    totals: {
      employee_name: `รวม ${summary.employeeCount} คน`,
      worked_hours: summary.workedHoursTotal,
      ot_hours: summary.otHoursTotal,
      total_deduction: summary.deductionTotal,
      gross_income: summary.grossTotal,
      net_salary: summary.netTotal,
    },
    summary,
    meta: {
      period: period?.name ?? 'ทุกรอบ',
      generated_at: dayjs().format('YYYY-MM-DD HH:mm'),
    },
  };
}

async function attendanceReport(
  params: ReportParams,
  variant: 'summary' | 'ot' | 'late' | 'absence'
): Promise<ReportData> {
  const where: Prisma.AttendanceRecordWhereInput = {
    ...(params.from || params.to
      ? {
          workDate: {
            ...(params.from ? { gte: params.from } : {}),
            ...(params.to ? { lte: params.to } : {}),
          },
        }
      : {}),
    employee: {
      attendanceRequired: true,
      ...(params.departmentId ? { departmentId: params.departmentId } : {}),
      ...(variant === 'late' ? { employmentType: { not: 'DAILY' } } : {}),
    },
    ...(params.employeeId ? { employeeId: params.employeeId } : {}),
    ...(variant === 'ot' ? { otMinutes: { gt: 0 } } : {}),
    ...(variant === 'late' ? { lateMinutes: { gt: 0 } } : {}),
    ...(variant === 'absence' ? { isAbsent: true } : {}),
  };

  const records = await prisma.attendanceRecord.findMany({
    where,
    include: {
      employee: {
        select: {
          employeeCode: true,
          id: true,
          firstName: true,
          lastName: true,
          employmentType: true,
          attendanceRequired: true,
          department: { select: { name: true } },
        },
      },
    },
    orderBy: [{ employeeCode: 'asc' }, { workDate: 'asc' }],
  });

  const employeesById = new Map(
    records.map((record) => [
      record.employeeId,
      {
        id: record.employee.id,
        employmentType: record.employee.employmentType,
        attendanceRequired: record.employee.attendanceRequired,
      },
    ])
  );
  const dailyPay = await valueAttendanceRecords(records, employeesById);

  if (variant === 'summary') {
    return {
      kind: 'attendance',
      title: 'รายงานการลงเวลาแบบละเอียด',
      columns: [
        { key: 'work_date', header: 'วันที่', width: 14, format: 'date' },
        { key: 'employee_code', header: 'รหัสพนักงาน', width: 14 },
        { key: 'employee_name', header: 'ชื่อ-นามสกุล', width: 26 },
        { key: 'department', header: 'แผนก', width: 18 },
        { key: 'check_in', header: 'เวลาเข้า', width: 12 },
        { key: 'check_out', header: 'เวลาออก', width: 12 },
        { key: 'worked_hours', header: 'ชั่วโมงทำงาน', width: 14, numeric: true },
        { key: 'late_minutes', header: 'นาทีมาสาย', width: 12, numeric: true },
        { key: 'status', header: 'สถานะ', width: 16 },
        { key: 'daily_pay', header: 'ได้เงินวันนี้', width: 16, numeric: true, format: 'currency' },
        { key: 'daily_pay_status', header: 'สถานะค่าจ้างรายวัน', width: 18 },
      ],
      rows: records.map((record) => {
        const pay = dailyPay.get(record.id);
        return {
          work_date: dayjs.utc(record.workDate).format('YYYY-MM-DD'),
          employee_code: record.employeeCode,
          employee_name: `${record.employee.firstName} ${record.employee.lastName}`,
          department: record.employee.department?.name ?? '-',
          check_in: record.checkIn ? dayjs.utc(record.checkIn).format('HH:mm') : '-',
          check_out: record.checkOut ? dayjs.utc(record.checkOut).format('HH:mm') : '-',
          worked_hours: (record.workedMinutes / 60).toFixed(2),
          late_minutes: record.lateMinutes,
          status: record.status,
          daily_pay: pay?.status === 'CALCULATED' ? pay.net : '',
          daily_pay_status: pay?.status ?? 'NOT_APPLICABLE',
        };
      }),
      meta: {
        from: params.from ? dayjs.utc(params.from).format('YYYY-MM-DD') : '-',
        to: params.to ? dayjs.utc(params.to).format('YYYY-MM-DD') : '-',
        generated_at: dayjs().format('YYYY-MM-DD HH:mm'),
      },
    };
  }

  const titles = {
    ot: 'รายงานการทำงานล่วงเวลา (OT)',
    late: 'รายงานการมาสาย',
    absence: 'รายงานการขาดงาน',
  } as const;

  const rows = records.map((r) => ({
    employee_code: r.employeeCode,
    employee_name: `${r.employee.firstName} ${r.employee.lastName}`,
    department: r.employee.department?.name ?? '-',
    work_date: dayjs.utc(r.workDate).format('YYYY-MM-DD'),
    check_in: r.checkIn ? dayjs.utc(r.checkIn).format('HH:mm') : '-',
    check_out: r.checkOut ? dayjs.utc(r.checkOut).format('HH:mm') : '-',
    ot_hours: (r.otMinutes / 60).toFixed(2),
    late_minutes: r.lateMinutes,
    status: r.status,
    worked_hours: (r.workedMinutes / 60).toFixed(2),
    daily_pay: dailyPay.get(r.id)?.status === 'CALCULATED' ? dailyPay.get(r.id)!.net : '',
  }));

  return {
    title: titles[variant],
    columns: [
      { key: 'employee_code', header: 'รหัสพนักงาน', width: 14 },
      { key: 'employee_name', header: 'ชื่อ-นามสกุล', width: 26 },
      { key: 'department', header: 'แผนก', width: 18 },
      { key: 'work_date', header: 'วันที่', width: 14 },
      { key: 'check_in', header: 'เวลาเข้า', width: 12 },
      { key: 'check_out', header: 'เวลาออก', width: 12 },
      { key: 'ot_hours', header: 'ชั่วโมง OT', width: 12, numeric: true },
      { key: 'late_minutes', header: 'นาทีที่สาย', width: 12, numeric: true },
      { key: 'status', header: 'สถานะ', width: 14 },
      { key: 'worked_hours', header: 'ชั่วโมงทำงาน', width: 14, numeric: true },
      { key: 'daily_pay', header: 'ได้เงินวันนี้', width: 16, numeric: true, format: 'currency' },
    ],
    rows,
    meta: {
      from: params.from ? dayjs.utc(params.from).format('YYYY-MM-DD') : '-',
      to: params.to ? dayjs.utc(params.to).format('YYYY-MM-DD') : '-',
      generated_at: dayjs().format('YYYY-MM-DD HH:mm'),
    },
  };
}

async function payrollByDepartmentReport(params: ReportParams): Promise<ReportData> {
  const period = params.periodId ? await requirePeriod(params.periodId) : null;

  const rows = await prisma.payrollEmployee.findMany({
    where: period ? { periodId: period.id } : {},
  });

  const byDept = new Map<string, { employees: number; gross: Prisma.Decimal; net: Prisma.Decimal }>();
  for (const r of rows) {
    const key = r.departmentName ?? 'ไม่ระบุแผนก';
    const entry = byDept.get(key) ?? {
      employees: 0,
      gross: new Prisma.Decimal(0),
      net: new Prisma.Decimal(0),
    };
    entry.employees += 1;
    entry.gross = entry.gross.plus(r.grossIncome);
    entry.net = entry.net.plus(r.netSalary);
    byDept.set(key, entry);
  }

  return {
    title: `เงินเดือนแยกตามแผนก${period ? ` - ${period.name}` : ''}`,
    columns: [
      { key: 'department', header: 'แผนก', width: 24 },
      { key: 'employees', header: 'จำนวนพนักงาน', width: 16, numeric: true },
      { key: 'gross', header: 'รายได้รวม', width: 18, numeric: true },
      { key: 'net', header: 'เงินสุทธิ', width: 18, numeric: true },
    ],
    rows: [...byDept.entries()].map(([department, v]) => ({
      department,
      employees: v.employees,
      gross: money(v.gross).toFixed(2),
      net: money(v.net).toFixed(2),
    })),
    meta: {
      period: period?.name ?? 'ทุกรอบ',
      generated_at: dayjs().format('YYYY-MM-DD HH:mm'),
    },
  };
}

async function salaryHistoryReport(params: ReportParams): Promise<ReportData> {
  const history = await prisma.salaryHistory.findMany({
    where: params.employeeId ? { employeeId: params.employeeId } : {},
    include: {
      employee: {
        select: {
          employeeCode: true,
          firstName: true,
          lastName: true,
          department: { select: { name: true } },
        },
      },
    },
    orderBy: [{ effectiveDate: 'desc' }],
    take: 2000,
  });

  return {
    title: 'ประวัติการปรับเงินเดือน',
    columns: [
      { key: 'employee_code', header: 'รหัสพนักงาน', width: 14 },
      { key: 'employee_name', header: 'ชื่อ-นามสกุล', width: 26 },
      { key: 'department', header: 'แผนก', width: 18 },
      { key: 'effective_date', header: 'มีผลวันที่', width: 14 },
      { key: 'previous_salary', header: 'เงินเดือนเดิม', width: 16, numeric: true },
      { key: 'new_salary', header: 'เงินเดือนใหม่', width: 16, numeric: true },
      { key: 'reason', header: 'เหตุผล', width: 30 },
    ],
    rows: history.map((h) => ({
      employee_code: h.employee.employeeCode,
      employee_name: `${h.employee.firstName} ${h.employee.lastName}`,
      department: h.employee.department?.name ?? '-',
      effective_date: dayjs.utc(h.effectiveDate).format('YYYY-MM-DD'),
      previous_salary: money(h.previousSalary).toFixed(2),
      new_salary: money(h.newSalary).toFixed(2),
      reason: h.reason ?? '-',
    })),
    meta: { generated_at: dayjs().format('YYYY-MM-DD HH:mm') },
  };
}

export async function buildReport(type: ReportType, params: ReportParams): Promise<ReportData> {
  switch (type) {
    case 'payroll-summary':
      return payrollSummaryReport(params);
    case 'attendance-summary':
      return attendanceReport(params, 'summary');
    case 'ot':
      return attendanceReport(params, 'ot');
    case 'late':
      return attendanceReport(params, 'late');
    case 'absence':
      return attendanceReport(params, 'absence');
    case 'payroll-by-department':
      return payrollByDepartmentReport(params);
    case 'salary-history':
      return salaryHistoryReport(params);
    default:
      throw notFound(`Report ${type}`);
  }
}

/** RFC 4180 CSV. A UTF-8 BOM is prepended so Excel opens Thai text correctly. */
export function toCsv(report: ReportData): string {
  const escape = (value: unknown): string => {
    const str = String(value ?? '');
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const lines = [report.columns.map((c) => escape(c.header)).join(',')];
  for (const row of report.rows) {
    lines.push(report.columns.map((c) => escape(row[c.key])).join(','));
  }
  if (report.totals) {
    lines.push(report.columns.map((c) => escape(report.totals?.[c.key] ?? '')).join(','));
  }
  return `﻿${lines.join('\r\n')}`;
}

export async function toExcel(report: ReportData): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(
    report.kind === 'detailed-payroll' ? 'สรุปเงินเดือน' : report.title.slice(0, 30) || 'Report'
  );

  sheet.mergeCells(1, 1, 1, report.columns.length);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = report.title;
  titleCell.font = { size: 14, bold: true };

  const metaText = Object.entries(report.meta)
    .map(([k, v]) => `${k}: ${v}`)
    .join('   ');
  sheet.mergeCells(2, 1, 2, report.columns.length);
  sheet.getCell(2, 1).value = metaText;
  sheet.getCell(2, 1).font = { size: 10, color: { argb: 'FF6B7280' } };

  const headerRow = sheet.getRow(4);
  report.columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    sheet.getColumn(i + 1).width = col.width ?? 16;
  });
  headerRow.commit();
  sheet.views = [{ state: 'frozen', ySplit: 4 }];
  sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: report.columns.length } };

  report.rows.forEach((row, r) => {
    const excelRow = sheet.getRow(5 + r);
    report.columns.forEach((col, c) => {
      const raw = row[col.key];
      const cell = excelRow.getCell(c + 1);
      if (col.numeric && raw !== undefined && raw !== '' && !Number.isNaN(Number(raw))) {
        cell.value = Number(raw);
        cell.numFmt = col.format === 'currency' ? '#,##0.00' : '#,##0.00';
      } else {
        cell.value = raw ?? '';
      }
    });
    excelRow.commit();
  });

  if (report.totals) {
    const totalRow = sheet.getRow(5 + report.rows.length);
    report.columns.forEach((col, c) => {
      const raw = report.totals?.[col.key];
      const cell = totalRow.getCell(c + 1);
      cell.font = { bold: true };
      if (col.numeric && raw !== undefined && !Number.isNaN(Number(raw))) {
        cell.value = Number(raw);
        cell.numFmt = '#,##0.00';
      } else {
        cell.value = raw ?? '';
      }
    });
    totalRow.commit();
  }

  if (report.kind === 'detailed-payroll') {
    const rows = report.rows as DetailedPayrollReportRow[];
    const byDepartment = new Map<
      string,
      { employees: number; gross: Prisma.Decimal; deductions: Prisma.Decimal; net: Prisma.Decimal; worked: Prisma.Decimal }
    >();
    for (const row of rows) {
      const entry = byDepartment.get(row.department) ?? {
        employees: 0,
        gross: dec(0),
        deductions: dec(0),
        net: dec(0),
        worked: dec(0),
      };
      entry.employees += 1;
      entry.worked = entry.worked.plus(row.worked_hours);
      if (row._pay_configured === 1) {
        entry.gross = entry.gross.plus(row.gross_income);
        entry.deductions = entry.deductions.plus(row.total_deduction);
        entry.net = entry.net.plus(row.net_salary);
      }
      byDepartment.set(row.department, entry);
    }

    const departmentSheet = workbook.addWorksheet('สรุปแผนก', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    departmentSheet.columns = [
      { header: 'แผนก', key: 'department', width: 24 },
      { header: 'จำนวนพนักงาน', key: 'employees', width: 16 },
      { header: 'รายได้รวม', key: 'gross', width: 18 },
      { header: 'รายการหักรวม', key: 'deductions', width: 18 },
      { header: 'เงินสุทธิ', key: 'net', width: 18 },
      { header: 'ชั่วโมงทำงาน', key: 'worked', width: 16 },
    ];
    for (const [department, value] of byDepartment) {
      departmentSheet.addRow({
        department,
        employees: value.employees,
        gross: Number(value.gross.toFixed(2)),
        deductions: Number(value.deductions.toFixed(2)),
        net: Number(value.net.toFixed(2)),
        worked: Number(value.worked.toFixed(2)),
      });
    }
    styleSimpleSheet(departmentSheet, 6, [3, 4, 5, 6]);

    const attendanceSheet = workbook.addWorksheet('สรุปการลงเวลา', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    attendanceSheet.columns = [
      { header: 'รหัสพนักงาน', key: 'employee_code', width: 14 },
      { header: 'ชื่อ-นามสกุล', key: 'employee_name', width: 26 },
      { header: 'วันที่มาทำงาน', key: 'present_days', width: 16 },
      { header: 'ชั่วโมงทำงาน', key: 'worked_hours', width: 16 },
      { header: 'จำนวนครั้งมาสาย', key: 'late_count', width: 17 },
      { header: 'นาทีมาสาย', key: 'late_minutes', width: 14 },
      { header: 'วันลา', key: 'leave_days', width: 12 },
      { header: 'วันขาด', key: 'absent_days', width: 12 },
      { header: 'ข้อมูลเวลาไม่ครบ', key: 'missing', width: 18 },
    ];
    rows.forEach((row) => attendanceSheet.addRow({
      employee_code: row.employee_code,
      employee_name: row.employee_name,
      present_days: row.present_days,
      worked_hours: Number(row.worked_hours),
      late_count: row.late_count,
      late_minutes: row.late_minutes,
      leave_days: Number(row.leave_days),
      absent_days: row.absent_days,
      missing: row.calculation_status === 'ATTENDANCE_INCOMPLETE' ? 'ต้องตรวจสอบ' : '-',
    }));
    styleSimpleSheet(attendanceSheet, 9, [3, 4, 5, 6, 7, 8]);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function styleSimpleSheet(
  sheet: ExcelJS.Worksheet,
  columnCount: number,
  numericColumns: number[]
): void {
  const header = sheet.getRow(1);
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  for (const column of numericColumns) sheet.getColumn(column).numFmt = '#,##0.00';
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columnCount } };
}
