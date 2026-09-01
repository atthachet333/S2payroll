import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui';
import type { PayrollEmployee, PeriodSummary } from '@/types';
import {
  buildPayrollChartData,
  formatThaiCurrency,
  PAYROLL_CHART_COLORS,
} from './payrollChartData';

export default function PayrollCharts({
  summary,
  employees,
  rosterComplete,
}: {
  summary: PeriodSummary;
  employees: PayrollEmployee[];
  rosterComplete: boolean;
}) {
  const data = buildPayrollChartData(summary, employees);
  const employeeHeight = Math.max(240, Math.min(620, data.employeeNet.length * 34 + 70));

  return (
    <section className="mb-5 grid gap-4 lg:grid-cols-2" aria-label="กราฟสรุปเงินเดือน">
      <Card className="p-4">
        <ChartHeader
          title="สรุปเงินเดือนรอบนี้"
          description="เปรียบเทียบรายได้ รายการหัก และยอดรับสุทธิ"
        />
        <div className="h-72" data-testid="payroll-summary-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.totals} margin={{ top: 12, right: 8, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#475569' }} axisLine={false} />
              <YAxis
                tick={{ fontSize: 11, fill: '#64748b' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(value) => `${Math.round(Number(value) / 1000)}k`}
              />
              <Tooltip formatter={(value) => formatThaiCurrency(Number(value))} />
              <Bar dataKey="amount" radius={[5, 5, 0, 0]} maxBarSize={72}>
                {data.totals.map((item) => (
                  <Cell
                    key={item.key}
                    fill={PAYROLL_CHART_COLORS[item.key as keyof typeof PAYROLL_CHART_COLORS]}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card className="p-4">
        <ChartHeader
          title="เงินสุทธิรายพนักงาน"
          description="แสดงเฉพาะพนักงานสถานะพร้อมจ่ายและมีอัตราค่าจ้างครบ"
        />
        {!rosterComplete ? (
          <ChartNotice>รายการพนักงานมากกว่า 200 คน กรุณาใช้ตารางด้านล่างเพื่อดูข้อมูลทั้งหมด</ChartNotice>
        ) : data.employeeNet.length === 0 ? (
          <ChartNotice>ยังไม่มีพนักงานที่มียอดพร้อมจ่ายสำหรับกราฟนี้</ChartNotice>
        ) : (
          <div
            className="max-h-[620px] overflow-y-auto"
            style={{ height: employeeHeight }}
            data-testid="employee-net-chart"
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data.employeeNet}
                layout="vertical"
                margin={{ top: 8, right: 16, left: 8, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
                <XAxis
                  type="number"
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(value) => `${Math.round(Number(value) / 1000)}k`}
                />
                <YAxis
                  type="category"
                  dataKey="employee"
                  width={150}
                  tick={{ fontSize: 11, fill: '#475569' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip formatter={(value) => formatThaiCurrency(Number(value))} />
                <Bar dataKey="amount" fill={PAYROLL_CHART_COLORS.net} radius={[0, 5, 5, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
    </section>
  );
}

function ChartHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-2">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

function ChartNotice({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-72 items-center justify-center rounded-lg border border-dashed border-border px-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
