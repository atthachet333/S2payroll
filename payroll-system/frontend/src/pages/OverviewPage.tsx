import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertTriangle, CheckCircle2, Clock, Users, Wallet } from 'lucide-react';
import { overviewApi, POLL_INTERVAL_MS } from '@/services/endpoints';
import { apiErrorMessage } from '@/services/api';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  PageHeader,
  Skeleton,
  StatCard,
} from '@/components/ui';
import { PeriodStatusBadge } from '@/components/StatusBadge';
import { formatDate, formatHours, formatMoney, formatMoneyCompact, formatNumber } from '@/utils/format';

/**
 * Overview deliberately shows aggregates only - headline counters, the payroll
 * trend and status breakdowns. Employee tables and payroll calculation tables
 * live on their own pages.
 */
export default function OverviewPage() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['overview'],
    queryFn: () => overviewApi.get(),
    refetchInterval: POLL_INTERVAL_MS.overview,
    placeholderData: (previous) => previous,
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="ภาพรวม" description="สรุปข้อมูลเงินเดือนและการลงเวลาของรอบล่าสุด" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] rounded-xl" />
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-[320px] rounded-xl lg:col-span-2" />
          <Skeleton className="h-[320px] rounded-xl" />
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="space-y-6">
        <PageHeader title="ภาพรวม" />
        <Card>
          <ErrorState message={apiErrorMessage(error)} onRetry={() => void refetch()} />
        </Card>
      </div>
    );
  }

  const { totals, attendance, payrollStatus, trend, period } = data;

  const attendanceChart = [
    { name: 'มาทำงาน', value: attendance.present, fill: '#16a34a' },
    { name: 'มาสาย', value: attendance.late, fill: '#ea580c' },
    { name: 'ขาดงาน', value: attendance.absent, fill: '#dc2626' },
    { name: 'ลา', value: attendance.leave, fill: '#64748b' },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="ภาพรวม"
        description={
          period
            ? `รอบเงินเดือน ${period.name} · ${formatDate(period.startDate)} - ${formatDate(period.endDate)}`
            : 'ยังไม่มีรอบเงินเดือนในระบบ'
        }
        actions={period ? <PeriodStatusBadge status={period.status} /> : null}
      />

      {/* With no payroll period the money figures below are genuinely zero, not
          missing. Say so plainly rather than letting a wall of ฿0.00 read as a
          calculation result. */}
      {!period && (
        <Card className="border-dashed bg-muted/30 p-4">
          <p className="text-sm font-medium text-foreground">
            ยังไม่มีข้อมูลเงินเดือนสำหรับรอบนี้
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            กรุณาสร้างรอบเงินเดือนและคำนวณ เพื่อแสดงยอดรวมและแนวโน้ม
            ตัวเลขด้านล่างคำนวณจากข้อมูลจริงในระบบเท่านั้น
          </p>
        </Card>
      )}

      {/* Headline counters */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard
          label="พนักงานทั้งหมด"
          value={formatNumber(totals.employees)}
          sub="ที่ยังทำงานอยู่"
          icon={<Users className="h-5 w-5" />}
        />
        <StatCard
          label="เงินเดือนสุทธิรวม"
          value={formatMoney(totals.payroll)}
          sub={`รายได้รวม ${formatMoney(totals.grossPayroll)} บาท`}
          tone="info"
          icon={<Wallet className="h-5 w-5" />}
        />
        <StatCard
          label="ค่าล่วงเวลารวม"
          value={formatMoney(totals.otAmount)}
          sub={`${formatHours(totals.otHours)} ชั่วโมง`}
          icon={<Clock className="h-5 w-5" />}
        />
        <StatCard
          label="ชั่วโมงทำงานรวม"
          value={formatHours(totals.workingHours)}
          sub="ชั่วโมง"
          icon={<Clock className="h-5 w-5" />}
        />
        <StatCard
          label="มาสาย / ขาดงาน"
          value={`${formatNumber(totals.lateCount)} / ${formatNumber(totals.absentCount)}`}
          sub="ครั้งในรอบนี้"
          tone={totals.absentCount > 0 ? 'warning' : 'default'}
          icon={<AlertTriangle className="h-5 w-5" />}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Monthly payroll trend */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>แนวโน้มเงินเดือนรายเดือน</CardTitle>
          </CardHeader>
          <CardContent>
            {trend.length === 0 ? (
              <p className="py-16 text-center text-sm text-muted-foreground">
                ยังไม่มีข้อมูลรอบเงินเดือนสำหรับแสดงแนวโน้ม
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#64748b' }} tickLine={false} axisLine={false} />
                  <YAxis
                    tick={{ fontSize: 12, fill: '#64748b' }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => formatMoneyCompact(v)}
                    width={60}
                  />
                  <Tooltip
                    formatter={(value: number) => `${formatMoney(value)} บาท`}
                    contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 13 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line
                    type="monotone"
                    dataKey="gross"
                    name="รายได้รวม"
                    stroke="#1e3a8a"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="net"
                    name="เงินสุทธิ"
                    stroke="#16a34a"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="ot"
                    name="ค่า OT"
                    stroke="#ea580c"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Attendance summary */}
        <Card>
          <CardHeader>
            <CardTitle>สรุปการลงเวลา</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={attendanceChart} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip
                  formatter={(value: number) => `${formatNumber(value)} รายการ`}
                  contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 13 }}
                />
                <Bar dataKey="value" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>

            <div className="grid grid-cols-2 gap-2 text-sm">
              <SummaryPill label="มาทำงาน" value={attendance.present} tone="success" />
              <SummaryPill label="มาสาย" value={attendance.late} tone="warning" />
              <SummaryPill label="ขาดงาน" value={attendance.absent} tone="danger" />
              <SummaryPill label="ลา" value={attendance.leave} tone="muted" />
            </div>

            {attendance.missingData > 0 && (
              <Link
                to="/attendance?status=MISSING_DATA"
                className="flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger-fg transition hover:brightness-95"
              >
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>
                  มีข้อมูลลงเวลาไม่ครบ {formatNumber(attendance.missingData)} รายการ - ตรวจสอบ
                </span>
              </Link>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Payroll readiness */}
      <Card>
        <CardHeader>
          <CardTitle>สถานะการคำนวณเงินเดือน</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatusTile
              icon={<CheckCircle2 className="h-5 w-5" />}
              label="พร้อมจ่าย"
              value={payrollStatus.ready}
              tone="success"
            />
            <StatusTile
              icon={<AlertTriangle className="h-5 w-5" />}
              label="ต้องตรวจสอบ"
              value={payrollStatus.needsReview}
              tone="warning"
            />
            <StatusTile
              icon={<AlertTriangle className="h-5 w-5" />}
              label="ข้อมูลไม่ครบ"
              value={payrollStatus.missingData}
              tone="danger"
            />
          </div>
          {period && (
            <div className="mt-4 flex justify-end">
              <Link
                to={`/payroll/${period.id}`}
                className="text-sm font-medium text-primary hover:underline"
              >
                เปิดรอบเงินเดือน {period.name} →
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'success' | 'warning' | 'danger' | 'muted';
}) {
  const classes = {
    success: 'bg-success-soft text-success-fg',
    warning: 'bg-warning-soft text-warning-fg',
    danger: 'bg-danger-soft text-danger-fg',
    muted: 'bg-secondary text-secondary-foreground',
  }[tone];

  return (
    <div className={`flex items-center justify-between rounded-lg px-3 py-2 ${classes}`}>
      <span className="text-xs font-medium">{label}</span>
      <span className="text-sm font-semibold tabular-nums">{formatNumber(value)}</span>
    </div>
  );
}

function StatusTile({
  icon,
  label,
  value,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  tone: 'success' | 'warning' | 'danger';
}) {
  const classes = {
    success: 'border-success/25 bg-success-soft/50 text-success-fg',
    warning: 'border-warning/25 bg-warning-soft/50 text-warning-fg',
    danger: 'border-danger/25 bg-danger-soft/50 text-danger-fg',
  }[tone];

  return (
    <div className={`flex items-center gap-3 rounded-xl border px-4 py-3.5 ${classes}`}>
      {icon}
      <div>
        <p className="text-xs font-medium">{label}</p>
        <p className="text-xl font-semibold tabular-nums">{formatNumber(value)}</p>
      </div>
    </div>
  );
}
