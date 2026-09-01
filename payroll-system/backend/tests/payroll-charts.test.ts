import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
const chartModulePath = '../../frontend/src/features/payroll/payrollChartData.js';
const loadCharts = () => import(chartModulePath);

describe('payroll dashboard charts', () => {
  it('maps gross, deductions and net without changing their values', async () => {
    const { buildPayrollChartData } = await loadCharts();
    const data = buildPayrollChartData(
      { grossTotal: '38857.95', deductionTotal: '3353.93', netTotal: '35504.02' },
      []
    );
    expect(data.totals.map((row: { label: string; amount: number }) => [row.label, row.amount])).toEqual([
      ['รายได้รวม', 38857.95],
      ['รายการหักรวม', 3353.93],
      ['รับสุทธิ', 35504.02],
    ]);
  });

  it('excludes unconfigured, excluded and other non-final employee rows', async () => {
    const { buildPayrollChartData } = await loadCharts();
    const employees = [
      { employeeId: '1', employeeCode: 'S2A001', employeeName: 'พร้อม จ่าย', netSalary: '15000', status: 'READY', payConfigured: true },
      { employeeId: '2', employeeCode: 'S2A002', employeeName: 'ไม่ตั้ง ค่า', netSalary: '0', status: 'UNCONFIGURED', payConfigured: false },
      { employeeId: '3', employeeCode: 'S2A003', employeeName: 'ยก เว้น', netSalary: '0', status: 'EXCLUDED', payConfigured: true },
      { employeeId: '4', employeeCode: 'S2A004', employeeName: 'บาง ส่วน', netSalary: '9000', status: 'PARTIAL', payConfigured: true },
    ];
    const data = buildPayrollChartData(
      { grossTotal: 0, deductionTotal: 0, netTotal: 0 },
      employees
    );
    expect(data.employeeNet).toHaveLength(1);
    expect(data.employeeNet[0]).toMatchObject({ employeeCode: 'S2A001', amount: 15000 });
  });

  it('formats tooltips as Thai baht and uses the restrained S2A palette', async () => {
    const { formatThaiCurrency, PAYROLL_CHART_COLORS } = await loadCharts();
    expect(formatThaiCurrency(35504.02)).toContain('35,504.02');
    expect(formatThaiCurrency(35504.02)).toMatch(/฿|THB/);
    expect(PAYROLL_CHART_COLORS).toEqual({
      gross: '#1e3a8a',
      deduction: '#a54b4b',
      net: '#0f766e',
    });
  });

  it('renders the employee chart horizontally and the dashboard responsively', () => {
    const source = readFileSync(
      new URL('../../frontend/src/features/payroll/PayrollCharts.tsx', import.meta.url),
      'utf8'
    );
    expect(source).toContain('layout="vertical"');
    expect(source).toContain('lg:grid-cols-2');
    expect(source).toContain('formatThaiCurrency');
  });
});
