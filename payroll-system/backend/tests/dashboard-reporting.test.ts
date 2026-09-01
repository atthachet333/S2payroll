import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildPayrollTrend } from '../src/services/dashboard.service.js';
import { summarizeDetailedPayrollRows, toCsv, toExcel, type DetailedPayrollReportRow, type ReportData } from '../src/services/report.service.js';
import { toReportPdf } from '../src/services/report-pdf.service.js';

const row = (overrides: Partial<DetailedPayrollReportRow> = {}): DetailedPayrollReportRow => ({
  period: 'สิงหาคม 2569', period_code: '2026-08', employee_code: 'S2A001', employee_name: 'ทดสอบ, ไทย',
  department: 'บัญชี', position: 'เจ้าหน้าที่', employment_type: 'MONTHLY', calculation_status: 'CALCULATED',
  pay_basis: 'ฐานเงินเดือนรายเดือน', pay_rate: '30000.00', working_days: 22, present_days: 20,
  worked_hours: '160.00', actual_worked_minutes: 9600, break_deduction_minutes: 0,
  rounded_away_minutes: 0, payable_minutes: 0, payable_hours: '0.00',
  actual_late_minutes: 5, rounded_late_minutes: 0,
  actual_early_leave_minutes: 0, rounded_early_leave_minutes: 0,
  approved_ot_actual_minutes: 120, approved_ot_payable_minutes: 120,
  ot_hours: '2.00', ot_minutes: 120, late_count: 1, late_minutes: 5,
  leave_days: '1.00', absent_days: 1, base_earnings: '30000.00', ot_amount: '500.00', bonus: '0.00',
  allowance: '1000.00', commission: '0.00', other_income: '0.00', gross_income: '31500.00',
  late_deduction: '50.00', leave_deduction: '0.00', absence_deduction: '1000.00', social_security: '750.00',
  tax: '200.00', other_deduction: '0.00', total_deduction: '2000.00', net_salary: '29500.00', _pay_configured: 1,
  ...overrides,
});

const report = (rows = [row()]): ReportData => ({
  kind: 'detailed-payroll', title: 'รายงานเงินเดือนแบบละเอียด - สิงหาคม 2569', rows,
  columns: [
    { key: 'employee_code', header: 'รหัสพนักงาน' }, { key: 'employee_name', header: 'ชื่อ-นามสกุล' },
    { key: 'employment_type', header: 'ประเภทพนักงาน' }, { key: 'worked_hours', header: 'ชั่วโมงทำงาน', numeric: true },
    { key: 'late_count', header: 'มาสาย', numeric: true }, { key: 'base_earnings', header: 'รายได้พื้นฐาน', numeric: true, format: 'currency' },
    { key: 'gross_income', header: 'รายได้รวม', numeric: true, format: 'currency' },
    { key: 'total_deduction', header: 'รายการหักรวม', numeric: true, format: 'currency' },
    { key: 'net_salary', header: 'เงินสุทธิ', numeric: true, format: 'currency' },
  ],
  totals: { employee_name: 'รวม 1 คน', gross_income: '31500', total_deduction: '2000', net_salary: '29500' },
  meta: { รอบ: 'สิงหาคม 2569' }, summary: summarizeDetailedPayrollRows(rows),
});

describe('dashboard trend', () => {
  it('returns six calendar slots and preserves missing months as null', () => {
    const result = buildPayrollTrend([{ code: '2026-08', name: 'สิงหาคม 2569', year: 2026, month: 8, status: 'CALCULATED', payrollEmployees: [
      { grossIncome: '31500', netSalary: '29500', otAmount: '500', totalDeduction: '2000', isEstimate: true },
    ] }], 6, new Date('2026-08-15T00:00:00Z'));
    expect(result).toHaveLength(6);
    expect(result.slice(0, 5).every((item) => item.gross === null)).toBe(true);
    expect(result[5]).toMatchObject({ code: '2026-08', gross: 31500, net: 29500, isEstimate: true });
  });
});

describe('shared detailed payroll export DTO', () => {
  it('excludes unconfigured monetary rows but retains their attendance totals', () => {
    const result = summarizeDetailedPayrollRows([row(), row({ _pay_configured: 0, gross_income: '9999', worked_hours: '8' })]);
    expect(result).toMatchObject({ employeeCount: 2, monetaryEmployeeCount: 1, unconfiguredCount: 1, grossTotal: '31500.00', workedHoursTotal: '168.00' });
  });

  it('emits UTF-8 BOM, Thai headers and RFC4180 escaping', () => {
    const csv = toCsv(report());
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('รหัสพนักงาน');
    expect(csv).toContain('"ทดสอบ, ไทย"');
  });

  it('creates the three required Excel sheets with freeze panes, filters and numbers', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(new Uint8Array(await toExcel(report())).buffer);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['สรุปเงินเดือน', 'สรุปแผนก', 'สรุปการลงเวลา']);
    const main = workbook.getWorksheet('สรุปเงินเดือน')!;
    expect(main.views[0]).toMatchObject({ state: 'frozen', ySplit: 4 });
    expect(main.autoFilter).toBeTruthy();
    expect(main.getCell('G5').value).toBe(31500);
  });

  it('renders a non-empty A4 landscape PDF from the same DTO', async () => {
    const pdf = await toReportPdf(report());
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(5000);
    expect(pdf.includes(Buffer.from('/MediaBox [0 0 841.89 595.28]'))).toBe(true);
  });
});
