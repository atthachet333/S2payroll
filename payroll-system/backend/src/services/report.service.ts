import ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import { prisma } from '../plugins/prisma.js';
import { dec, money } from '../utils/money.js';
import { dayjs } from '../utils/datetime.js';
import { notFound } from '../utils/errors.js';

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
}

export interface ReportData {
  title: string;
  columns: ReportColumn[];
  rows: Record<string, string | number>[];
  totals?: Record<string, string | number>;
  meta: Record<string, string>;
}

export interface ReportParams {
  periodId?: string;
  from?: Date;
  to?: Date;
  departmentId?: string;
  employeeId?: string;
}

async function requirePeriod(periodId: string) {
  const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw notFound('Payroll period');
  return period;
}

async function payrollSummaryReport(params: ReportParams): Promise<ReportData> {
  const period = params.periodId ? await requirePeriod(params.periodId) : null;

  const rows = await prisma.payrollEmployee.findMany({
    where: {
      ...(period ? { periodId: period.id } : {}),
      ...(params.departmentId ? { employee: { departmentId: params.departmentId } } : {}),
    },
    orderBy: [{ employeeCode: 'asc' }],
  });

  let gross = dec(0);
  let net = dec(0);
  let deduction = dec(0);
  let ot = dec(0);

  const data = rows.map((r) => {
    gross = gross.plus(dec(r.grossIncome));
    net = net.plus(dec(r.netSalary));
    deduction = deduction.plus(dec(r.totalDeduction));
    ot = ot.plus(dec(r.otAmount));
    return {
      employee_code: r.employeeCode,
      employee_name: r.employeeName,
      department: r.departmentName ?? '-',
      working_hours: r.workingHours.toString(),
      ot_hours: r.otHours.toString(),
      base_salary: money(r.baseSalary).toFixed(2),
      ot_amount: money(r.otAmount).toFixed(2),
      allowance: money(r.allowanceAmount).toFixed(2),
      bonus: money(r.bonusAmount).toFixed(2),
      social_security: money(r.socialSecurity).toFixed(2),
      tax: money(r.tax).toFixed(2),
      total_deduction: money(r.totalDeduction).toFixed(2),
      gross_income: money(r.grossIncome).toFixed(2),
      net_salary: money(r.netSalary).toFixed(2),
      status: r.status,
    };
  });

  return {
    title: `สรุปเงินเดือน${period ? ` - ${period.name}` : ''}`,
    columns: [
      { key: 'employee_code', header: 'รหัสพนักงาน', width: 14 },
      { key: 'employee_name', header: 'ชื่อ-นามสกุล', width: 26 },
      { key: 'department', header: 'แผนก', width: 18 },
      { key: 'working_hours', header: 'ชั่วโมงทำงาน', width: 14, numeric: true },
      { key: 'ot_hours', header: 'ชั่วโมง OT', width: 12, numeric: true },
      { key: 'base_salary', header: 'เงินเดือนพื้นฐาน', width: 16, numeric: true },
      { key: 'ot_amount', header: 'ค่า OT', width: 14, numeric: true },
      { key: 'allowance', header: 'เบี้ยเลี้ยง', width: 14, numeric: true },
      { key: 'bonus', header: 'โบนัส', width: 14, numeric: true },
      { key: 'social_security', header: 'ประกันสังคม', width: 14, numeric: true },
      { key: 'tax', header: 'ภาษี', width: 14, numeric: true },
      { key: 'total_deduction', header: 'รวมรายการหัก', width: 16, numeric: true },
      { key: 'gross_income', header: 'รายได้รวม', width: 16, numeric: true },
      { key: 'net_salary', header: 'เงินสุทธิ', width: 16, numeric: true },
      { key: 'status', header: 'สถานะ', width: 14 },
    ],
    rows: data,
    totals: {
      employee_name: `รวม ${data.length} คน`,
      ot_amount: ot.toFixed(2),
      total_deduction: deduction.toFixed(2),
      gross_income: gross.toFixed(2),
      net_salary: net.toFixed(2),
    },
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
          firstName: true,
          lastName: true,
          department: { select: { name: true } },
        },
      },
    },
    orderBy: [{ employeeCode: 'asc' }, { workDate: 'asc' }],
  });

  if (variant === 'summary') {
    // One row per employee with the period totals.
    const byEmployee = new Map<
      string,
      {
        employee_code: string;
        employee_name: string;
        department: string;
        present: number;
        late: number;
        absent: number;
        leave: number;
        missing: number;
        worked_hours: number;
        ot_hours: number;
        late_minutes: number;
      }
    >();

    for (const r of records) {
      const key = r.employeeCode;
      const entry =
        byEmployee.get(key) ??
        {
          employee_code: r.employeeCode,
          employee_name: `${r.employee.firstName} ${r.employee.lastName}`,
          department: r.employee.department?.name ?? '-',
          present: 0,
          late: 0,
          absent: 0,
          leave: 0,
          missing: 0,
          worked_hours: 0,
          ot_hours: 0,
          late_minutes: 0,
        };
      if (r.workedMinutes > 0) entry.present += 1;
      if (r.lateMinutes > 0) entry.late += 1;
      if (r.isAbsent) entry.absent += 1;
      if (r.status === 'LEAVE') entry.leave += 1;
      if (r.status === 'MISSING_DATA') entry.missing += 1;
      entry.worked_hours += r.workedMinutes / 60;
      entry.ot_hours += r.otMinutes / 60;
      entry.late_minutes += r.lateMinutes;
      byEmployee.set(key, entry);
    }

    const rows = [...byEmployee.values()].map((e) => ({
      ...e,
      worked_hours: e.worked_hours.toFixed(2),
      ot_hours: e.ot_hours.toFixed(2),
    }));

    return {
      title: 'สรุปการลงเวลาทำงาน',
      columns: [
        { key: 'employee_code', header: 'รหัสพนักงาน', width: 14 },
        { key: 'employee_name', header: 'ชื่อ-นามสกุล', width: 26 },
        { key: 'department', header: 'แผนก', width: 18 },
        { key: 'present', header: 'มาทำงาน', width: 12, numeric: true },
        { key: 'late', header: 'มาสาย', width: 10, numeric: true },
        { key: 'absent', header: 'ขาดงาน', width: 10, numeric: true },
        { key: 'leave', header: 'ลา', width: 10, numeric: true },
        { key: 'missing', header: 'ข้อมูลไม่ครบ', width: 14, numeric: true },
        { key: 'worked_hours', header: 'ชั่วโมงทำงาน', width: 14, numeric: true },
        { key: 'ot_hours', header: 'ชั่วโมง OT', width: 12, numeric: true },
        { key: 'late_minutes', header: 'นาทีที่สาย', width: 12, numeric: true },
      ],
      rows,
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
  const sheet = workbook.addWorksheet(report.title.slice(0, 30) || 'Report');

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

  report.rows.forEach((row, r) => {
    const excelRow = sheet.getRow(5 + r);
    report.columns.forEach((col, c) => {
      const raw = row[col.key];
      const cell = excelRow.getCell(c + 1);
      if (col.numeric && raw !== undefined && raw !== '' && !Number.isNaN(Number(raw))) {
        cell.value = Number(raw);
        cell.numFmt = '#,##0.00';
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

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
