import { prisma } from '../plugins/prisma.js';
import { attendanceSummary } from './attendance.service.js';
import { money } from '../utils/money.js';
import { dayjs, monthBounds, thaiMonthLabel, thaiMonthShortLabel } from '../utils/datetime.js';

const TREND_STATUSES = ['CALCULATED', 'REVIEW', 'APPROVED', 'PAID', 'LOCKED'] as const;

type TrendPeriod = {
  code: string;
  name: string;
  year: number;
  month: number;
  status: string;
  payrollEmployees: Array<{
    grossIncome: unknown;
    netSalary: unknown;
    otAmount: unknown;
    totalDeduction: unknown;
    isEstimate: boolean;
  }>;
};

/**
 * Calendar-continuous payroll history. A missing month is explicitly null, not
 * zero: zero would claim that a calculated payroll existed and paid nobody.
 */
export function buildPayrollTrend(periods: TrendPeriod[], monthCount: number, anchor: Date) {
  const count = Math.min(12, Math.max(3, monthCount));
  const byMonth = new Map(periods.map((p) => [`${p.year}-${String(p.month).padStart(2, '0')}`, p]));

  return Array.from({ length: count }, (_, index) => {
    const month = dayjs.utc(anchor).startOf('month').subtract(count - index - 1, 'month');
    const code = month.format('YYYY-MM');
    const period = byMonth.get(code);
    if (!period) {
      return {
        code,
        // Thai names come from the project's own month table. dayjs's Thai
        // locale is not registered here, so .locale('th') silently produced
        // English names on exactly the months that have no payroll.
        name: thaiMonthLabel(month.year(), month.month() + 1),
        label: month.format('MM/YYYY'),
        shortLabel: thaiMonthShortLabel(month.year(), month.month() + 1),
        gross: null,
        net: null,
        ot: null,
        deduction: null,
        status: null,
        isEstimate: false,
      };
    }

    const sum = (key: 'grossIncome' | 'netSalary' | 'otAmount' | 'totalDeduction') =>
      period.payrollEmployees.reduce((total, row) => total.plus(money(row[key] as any ?? 0)), money(0));

    return {
      code,
      name: period.name,
      label: month.format('MM/YYYY'),
      shortLabel: thaiMonthShortLabel(month.year(), month.month() + 1),
      gross: Number(sum('grossIncome').toFixed(2)),
      net: Number(sum('netSalary').toFixed(2)),
      ot: Number(sum('otAmount').toFixed(2)),
      deduction: Number(sum('totalDeduction').toFixed(2)),
      status: period.status,
      isEstimate: period.payrollEmployees.some((row) => row.isEstimate),
    };
  });
}

/**
 * Overview page payload. Deliberately aggregate-only: headline counters, a
 * monthly trend and status breakdowns. No employee rows and no payroll table,
 * so the landing page stays readable.
 */
export async function getOverview(periodId?: string, trendMonths = 6) {
  const period = periodId
    ? await prisma.payrollPeriod.findUnique({ where: { id: periodId } })
    : await prisma.payrollPeriod.findFirst({ orderBy: [{ year: 'desc' }, { month: 'desc' }] });

  const now = dayjs.utc();
  const bounds = period
    ? { startDate: period.startDate, endDate: period.endDate }
    : monthBounds(now.year(), now.month() + 1);

  const [totalEmployees, attendance, payrollTotals, statusGroups, trendPeriods] = await Promise.all([
    prisma.employee.count({ where: { status: { in: ['ACTIVE', 'PROBATION'] } } }),
    attendanceSummary(bounds.startDate, bounds.endDate),
    period
      ? prisma.payrollEmployee.aggregate({
          where: { periodId: period.id },
          _sum: { grossIncome: true, netSalary: true, otAmount: true, otHours: true, workingHours: true },
        })
      : Promise.resolve(null),
    period
      ? prisma.payrollEmployee.groupBy({
          by: ['status'],
          where: { periodId: period.id },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    prisma.payrollPeriod.findMany({
      where: {
        OR: [
          { status: { in: [...TREND_STATUSES] } },
          { payrollEmployees: { some: {} } },
        ],
      },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      take: 12,
      select: {
        code: true,
        name: true,
        year: true,
        month: true,
        status: true,
        payrollEmployees: {
          select: {
            grossIncome: true,
            netSalary: true,
            otAmount: true,
            totalDeduction: true,
            isEstimate: true,
          },
        },
      },
    }),
  ]);

  const payrollStatus: Record<string, number> = {
    READY: 0,
    PARTIAL: 0,
    UNCONFIGURED: 0,
    ATTENDANCE_INCOMPLETE: 0,
    NEEDS_REVIEW: 0,
    MISSING_DATA: 0,
    EXCLUDED: 0,
  };
  for (const row of statusGroups) payrollStatus[row.status] = row._count._all;

  return {
    period: period
      ? {
          id: period.id,
          code: period.code,
          name: period.name,
          status: period.status,
          startDate: dayjs.utc(period.startDate).format('YYYY-MM-DD'),
          endDate: dayjs.utc(period.endDate).format('YYYY-MM-DD'),
        }
      : null,
    totals: {
      employees: totalEmployees,
      payroll: money(payrollTotals?._sum.netSalary ?? 0).toFixed(2),
      grossPayroll: money(payrollTotals?._sum.grossIncome ?? 0).toFixed(2),
      otAmount: money(payrollTotals?._sum.otAmount ?? 0).toFixed(2),
      otHours: (payrollTotals?._sum.otHours ?? 0).toString(),
      workingHours:
        payrollTotals?._sum.workingHours?.toString() ??
        (attendance.totalWorkedMinutes / 60).toFixed(2),
      lateCount: attendance.late,
      absentCount: attendance.absent,
    },
    attendance: {
      present: attendance.present,
      late: attendance.late,
      absent: attendance.absent,
      leave: attendance.leave,
      missingData: attendance.missingData,
    },
    payrollStatus: {
      ready: payrollStatus.READY,
      // NEEDS_REVIEW and MISSING_DATA are legacy statuses carried by rows
      // calculated before readiness became per-employee. Folding them into the
      // counters that replaced them keeps the dashboard total honest instead of
      // quietly dropping older rows out of every count.
      needsReview: payrollStatus.PARTIAL + payrollStatus.NEEDS_REVIEW,
      missingData:
        payrollStatus.ATTENDANCE_INCOMPLETE +
        payrollStatus.UNCONFIGURED +
        payrollStatus.MISSING_DATA,
    },
    trend: buildPayrollTrend(
      trendPeriods,
      trendMonths,
      period
        ? new Date(Date.UTC(period.year, period.month - 1, 1))
        : trendPeriods[0]
          ? new Date(Date.UTC(trendPeriods[0].year, trendPeriods[0].month - 1, 1))
          : now.toDate()
    ),
  };
}
