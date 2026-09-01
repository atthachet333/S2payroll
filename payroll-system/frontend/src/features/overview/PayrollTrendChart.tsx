import { TrendingUp } from 'lucide-react';
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
import { formatMoney, formatMoneyCompact } from '@/utils/format';
import type { OverviewTrendPoint } from '@/types';

/**
 * Monthly payroll trend.
 *
 * A line chart needs at least two points to be a trend. With a single payroll
 * period the previous implementation drew three lone dots pinned to the right
 * edge of an otherwise empty grid, which read as a broken chart rather than as
 * "there is one month of history so far".
 *
 * The visualisation is therefore chosen from how many months actually carry
 * calculated payroll, and it changes back on its own as history accumulates:
 *
 *   0 periods  -> empty state
 *   1 period   -> grouped bars for that month
 *   2+ periods -> the line trend
 *
 * A month with no payroll stays null throughout. It is never coerced to zero:
 * zero would assert that payroll ran and paid nobody, and it would drag a trend
 * line down to the axis on the strength of a month that simply does not exist.
 */

const SERIES = [
  { key: 'gross', name: 'รายได้รวม', color: '#1e3a8a' },
  { key: 'net', name: 'เงินสุทธิ', color: '#0f766e' },
  { key: 'ot', name: 'ค่า OT', color: '#a16207' },
] as const;

const AXIS = { fontSize: 12, fill: '#64748b' } as const;
const TOOLTIP_STYLE = { borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 13 } as const;

const money = (value: unknown) =>
  value == null ? 'ไม่มีข้อมูล' : `${formatMoney(Number(value))} บาท`;

export default function PayrollTrendChart({ trend }: { trend: OverviewTrendPoint[] }) {
  // A month counts only when payroll was actually calculated for it.
  const meaningful = trend.filter((point) => point.gross !== null);

  if (meaningful.length === 0) return <EmptyTrend />;
  if (meaningful.length === 1) return <SinglePeriodTrend point={meaningful[0]} />;
  return <MultiPeriodTrend trend={trend} />;
}

/** Nothing has been calculated yet. Say so, rather than drawing bare axes. */
function EmptyTrend() {
  return (
    <div className="flex h-[280px] flex-col items-center justify-center gap-2 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-secondary text-muted-foreground">
        <TrendingUp className="h-5 w-5" />
      </div>
      <p className="text-sm font-medium">ยังไม่มีข้อมูลเงินเดือนย้อนหลัง</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        เมื่อมีการคำนวณเงินเดือน กราฟแนวโน้มจะแสดงที่นี่
      </p>
    </div>
  );
}

/**
 * One month of history. Grouped bars read as a deliberate comparison of that
 * month's figures, where a line chart of a single point reads as a fault.
 */
function SinglePeriodTrend({ point }: { point: OverviewTrendPoint }) {
  // One category holding the three series as grouped bars.
  //
  // Colouring a single Bar per-row with <Cell> was tried and abandoned: this
  // Recharts version emits the rectangle groups but renders no shape inside
  // them, so the chart came out empty. Three Bar elements, each with its own
  // fill, is the form that actually draws.
  const data = [
    {
      label: point.shortLabel ?? point.label,
      gross: point.gross ?? 0,
      net: point.net ?? 0,
      ot: point.ot ?? 0,
    },
  ];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{point.name}</span>
        {point.isEstimate && (
          <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs text-warning-fg">
            ประมาณการ
          </span>
        )}
        <span className="text-xs text-muted-foreground">มีข้อมูลเพียง 1 รอบเงินเดือน</span>
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={12}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} />
          <YAxis
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => formatMoneyCompact(v)}
            width={60}
          />
          <Tooltip
            cursor={{ fill: '#f1f5f9' }}
            labelFormatter={() => point.name}
            formatter={money}
            contentStyle={TOOLTIP_STYLE}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {SERIES.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.name}
              fill={s.color}
              radius={[6, 6, 0, 0]}
              maxBarSize={80}
              // The grow-from-zero animation was leaving the bars stuck at zero
              // height, so the chart came out blank. The dashboard also polls,
              // and re-animating on every refetch is noise rather than feedback.
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>

      {/* The same figures the dashboard cards show, read from the same payload
          so the two can never disagree. A zero OT is stated here explicitly,
          since a zero-height bar has nothing to show. */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Figure label="รายได้รวม" value={point.gross} />
        <Figure label="รายการหัก" value={point.deduction} tone="text-danger" />
        <Figure label="เงินสุทธิ" value={point.net} tone="font-semibold text-primary" />
        <Figure label="ค่า OT" value={point.ot} />
      </div>
    </div>
  );
}

/** Two or more months: the trend the chart was always meant to be. */
function MultiPeriodTrend({ trend }: { trend: OverviewTrendPoint[] }) {
  const estimates = trend.filter((row) => row.isEstimate);

  return (
    <>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis
            dataKey="shortLabel"
            tick={AXIS}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            domain={['auto', 'auto']}
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => formatMoneyCompact(v)}
            width={60}
          />
          <Tooltip
            labelFormatter={(_label, payload) => payload?.[0]?.payload?.name ?? ''}
            formatter={money}
            contentStyle={TOOLTIP_STYLE}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {SERIES.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              strokeWidth={2}
              dot={{ r: 4 }}
              activeDot={{ r: 6 }}
              // A month without payroll is a gap, not a dip to zero. Bridging it
              // would draw a slope through a month that never ran.
              connectNulls={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>

      {estimates.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
          {estimates.map((row) => (
            <span
              key={row.code}
              className="rounded-full bg-warning-soft px-2 py-0.5 text-warning-fg"
            >
              {row.shortLabel ?? row.label} · ประมาณการ
            </span>
          ))}
        </div>
      )}
    </>
  );
}

const Figure = ({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | null;
  tone?: string;
}) => (
  <div className="rounded-lg border border-border px-3 py-2">
    <p className="text-xs text-muted-foreground">{label}</p>
    <p className={`mt-0.5 text-sm tabular-nums ${tone ?? ''}`}>
      {value == null ? '-' : `${formatMoney(value)} บาท`}
    </p>
  </div>
);
