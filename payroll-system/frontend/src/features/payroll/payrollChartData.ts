export interface PayrollChartSummary {
  grossTotal: string | number;
  deductionTotal: string | number;
  netTotal: string | number;
}

export interface PayrollChartEmployee {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  netSalary: string | number;
  status: string;
  payConfigured: boolean;
}

export const PAYROLL_CHART_COLORS = {
  gross: '#1e3a8a',
  deduction: '#a54b4b',
  net: '#0f766e',
} as const;

export function buildPayrollChartData(
  summary: PayrollChartSummary,
  employees: PayrollChartEmployee[]
) {
  const totals = [
    { key: 'gross', label: 'รายได้รวม', amount: Number(summary.grossTotal) || 0 },
    { key: 'deduction', label: 'รายการหักรวม', amount: Number(summary.deductionTotal) || 0 },
    { key: 'net', label: 'รับสุทธิ', amount: Number(summary.netTotal) || 0 },
  ];

  // The comparison is intentionally a final-pay chart. Incomplete and
  // unconfigured rows are useful in the table, but their zero/partial amount
  // must not be presented as the employee's valid salary.
  const employeeNet = employees
    .filter((row) => row.payConfigured && row.status === 'READY')
    .map((row) => ({
      employeeId: row.employeeId,
      employeeCode: row.employeeCode,
      employee: `${row.employeeCode} · ${row.employeeName}`,
      amount: Number(row.netSalary) || 0,
    }))
    .sort((a, b) => b.amount - a.amount || a.employeeCode.localeCompare(b.employeeCode));

  return { totals, employeeNet };
}

export function formatThaiCurrency(value: number): string {
  return new Intl.NumberFormat('th-TH', {
    style: 'currency',
    currency: 'THB',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
