import { prisma } from '../plugins/prisma.js';
import { attendanceSummary } from './attendance.service.js';
import { money } from '../utils/money.js';
import { dayjs, monthBounds } from '../utils/datetime.js';

/**
 * Overview page payload. Deliberately aggregate-only: headline counters, a
 * monthly trend and status breakdowns. No employee rows and no payroll table,
 * so the landing page stays readable.
 */
export async function getOverview(periodId?: string) {
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
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      take: 12,
      select: {
        code: true,
        name: true,
        year: true,
        month: true,
        grossTotal: true,
        netTotal: true,
        otTotal: true,
        deductionTotal: true,
        status: true,
      },
    }),
  ]);

  const payrollStatus: Record<string, number> = {
    READY: 0,
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
      needsReview: payrollStatus.NEEDS_REVIEW,
      missingData: payrollStatus.MISSING_DATA,
    },
    trend: trendPeriods
      .slice()
      .reverse()
      .map((p) => ({
        code: p.code,
        name: p.name,
        label: `${String(p.month).padStart(2, '0')}/${p.year}`,
        gross: Number(money(p.grossTotal).toFixed(2)),
        net: Number(money(p.netTotal).toFixed(2)),
        ot: Number(money(p.otTotal).toFixed(2)),
        deduction: Number(money(p.deductionTotal).toFixed(2)),
        status: p.status,
      })),
  };
}
