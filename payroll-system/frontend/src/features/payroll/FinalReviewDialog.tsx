import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock, PencilLine } from 'lucide-react';
import { payrollApi } from '@/services/endpoints';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  Skeleton,
} from '@/components/ui';
import { PayrollEmployeeStatusBadge } from '@/components/StatusBadge';
import { formatMoney, formatNumber } from '@/utils/format';
import { cn } from '@/utils/cn';
import type { PayrollEmployee, PeriodSummary } from '@/types';

/**
 * Final Review — the last screen before approval.
 *
 * Deliberately not a second copy of the payroll table. It answers one question:
 * is this payroll safe to approve? Problems first, then the numbers, then a
 * compact per-employee list. An admin should be able to decide in ~30 seconds.
 */

/** OT beyond this many hours in a period is worth a second look. */
const UNUSUAL_OT_HOURS = 40;

interface Problem {
  key: string;
  severity: 'blocker' | 'warning' | 'info';
  icon: React.ReactNode;
  title: string;
  detail: string;
  employees?: string[];
}

function buildProblems(summary: PeriodSummary, rows: PayrollEmployee[]): Problem[] {
  const problems: Problem[] = [];

  const missing = rows.filter((r) => r.status === 'MISSING_DATA');
  if (missing.length > 0) {
    problems.push({
      key: 'missing',
      severity: 'blocker',
      icon: <AlertTriangle className="h-4 w-4" />,
      title: `ข้อมูลการลงเวลาไม่ครบ ${missing.length} คน`,
      detail: 'ต้องแก้ไขให้ครบก่อน ระบบจะไม่อนุญาตให้อนุมัติ',
      employees: missing.map((r) => `${r.employeeCode} ${r.employeeName}`),
    });
  }

  const needsReview = rows.filter((r) => r.status === 'NEEDS_REVIEW');
  if (needsReview.length > 0) {
    problems.push({
      key: 'review',
      severity: 'warning',
      icon: <AlertTriangle className="h-4 w-4" />,
      title: `ต้องตรวจสอบ ${needsReview.length} คน`,
      detail: 'ส่วนใหญ่เกิดจากการขาดงานหรือเงินสุทธิผิดปกติ อนุมัติได้แต่ควรตรวจก่อน',
      employees: needsReview.map((r) => `${r.employeeCode} ${r.employeeName}`),
    });
  }

  const unusualOt = rows.filter((r) => Number(r.otHours) > UNUSUAL_OT_HOURS);
  if (unusualOt.length > 0) {
    problems.push({
      key: 'ot',
      severity: 'warning',
      icon: <Clock className="h-4 w-4" />,
      title: `ค่าล่วงเวลาสูงผิดปกติ ${unusualOt.length} คน`,
      detail: `มากกว่า ${UNUSUAL_OT_HOURS} ชั่วโมงในรอบนี้`,
      employees: unusualOt.map(
        (r) => `${r.employeeCode} ${r.employeeName} — ${formatNumber(r.otHours, 1)} ชม.`
      ),
    });
  }

  const adjusted = rows.filter((r) => r.hasAdjustment);
  if (adjusted.length > 0) {
    problems.push({
      key: 'adjusted',
      severity: 'info',
      icon: <PencilLine className="h-4 w-4" />,
      title: `มีการปรับปรุงด้วยมือ ${adjusted.length} คน`,
      detail: 'ตรวจสอบเหตุผลได้ในแท็บประวัติของพนักงานแต่ละคน',
      employees: adjusted.map((r) => `${r.employeeCode} ${r.employeeName}`),
    });
  }

  const negative = rows.filter((r) => Number(r.netSalary) < 0);
  if (negative.length > 0) {
    problems.push({
      key: 'negative',
      severity: 'blocker',
      icon: <AlertTriangle className="h-4 w-4" />,
      title: `เงินสุทธิติดลบ ${negative.length} คน`,
      detail: 'ต้องแก้ไขรายการหักก่อนอนุมัติ',
      employees: negative.map((r) => `${r.employeeCode} ${r.employeeName}`),
    });
  }

  void summary;
  return problems;
}

const SEVERITY_STYLE = {
  blocker: 'border-danger/30 bg-danger-soft/60 text-danger-fg',
  warning: 'border-warning/30 bg-warning-soft/60 text-warning-fg',
  info: 'border-info/30 bg-info-soft/60 text-info-fg',
} as const;

export default function FinalReviewDialog({
  open,
  onOpenChange,
  periodId,
  summary,
  canApprove,
  onApprove,
  approving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  periodId: string;
  summary: PeriodSummary;
  canApprove: boolean;
  onApprove: () => void;
  approving: boolean;
}) {
  // Pull the whole roster once so the checks see every employee, not one page.
  const query = useQuery({
    queryKey: ['final-review', periodId],
    queryFn: () => payrollApi.listEmployees(periodId, { page: 1, pageSize: 200 }),
    enabled: open,
  });

  const rows = query.data?.items ?? [];
  const problems = React.useMemo(() => buildProblems(summary, rows), [summary, rows]);
  const blockers = problems.filter((p) => p.severity === 'blocker');
  const clean = problems.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="ตรวจสอบครั้งสุดท้ายก่อนอนุมัติ"
        description={`${summary.period.name} · พนักงาน ${summary.employees} คน`}
        className="max-h-[92vh] max-w-4xl overflow-y-auto"
      >
        {query.isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : (
          <div className="space-y-5">
            {/* Headline numbers */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <ReviewStat label="พนักงาน" value={formatNumber(summary.employees)} />
              <ReviewStat label="รายได้รวม" value={formatMoney(summary.grossTotal)} />
              <ReviewStat label="ค่าล่วงเวลา" value={formatMoney(summary.otTotal)} />
              <ReviewStat label="รายการหัก" value={formatMoney(summary.deductionTotal)} tone="danger" />
              <ReviewStat label="เงินสุทธิ" value={formatMoney(summary.netTotal)} tone="success" />
            </div>

            {/* Problems, or an explicit all-clear */}
            <div>
              <p className="muted-label mb-2">สิ่งที่ต้องพิจารณา</p>
              {clean ? (
                <div className="flex items-center gap-2.5 rounded-lg border border-success/30 bg-success-soft/60 px-4 py-3 text-sm text-success-fg">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  ไม่พบปัญหา ข้อมูลครบถ้วนและพร้อมอนุมัติ
                </div>
              ) : (
                <div className="space-y-2">
                  {problems.map((p) => (
                    <details
                      key={p.key}
                      className={cn('rounded-lg border px-3.5 py-2.5 text-sm', SEVERITY_STYLE[p.severity])}
                    >
                      <summary className="flex cursor-pointer list-none items-center gap-2">
                        {p.icon}
                        <span className="font-medium">{p.title}</span>
                        {p.severity === 'blocker' && (
                          <Badge variant="danger" className="ml-1">
                            ต้องแก้ไขก่อน
                          </Badge>
                        )}
                        <span className="ml-auto text-xs opacity-70">
                          {p.employees ? `${p.employees.length} รายการ` : ''}
                        </span>
                      </summary>
                      <p className="mt-1.5 opacity-90">{p.detail}</p>
                      {p.employees && (
                        <ul className="mt-2 max-h-32 list-inside list-disc overflow-y-auto text-xs opacity-90">
                          {p.employees.map((e) => (
                            <li key={e}>{e}</li>
                          ))}
                        </ul>
                      )}
                    </details>
                  ))}
                </div>
              )}
            </div>

            {/* Compact per-employee list - decision data only */}
            <div>
              <p className="muted-label mb-2">รายชื่อพนักงาน</p>
              <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
                <table className="data-table">
                  <thead className="sticky top-0">
                    <tr>
                      <th>พนักงาน</th>
                      <th className="text-right">รายได้รวม</th>
                      <th className="text-right">รายการหัก</th>
                      <th className="text-right">เงินสุทธิ</th>
                      <th>สถานะ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <span className="font-medium">{r.employeeCode}</span>{' '}
                          <span className="text-muted-foreground">{r.employeeName}</span>
                        </td>
                        <td className="num">{formatMoney(r.grossIncome)}</td>
                        <td className="num text-danger">{formatMoney(r.totalDeduction)}</td>
                        <td className="num font-semibold">{formatMoney(r.netSalary)}</td>
                        <td>
                          <PayrollEmployeeStatusBadge status={r.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
              <p className="text-xs text-muted-foreground">
                {blockers.length > 0
                  ? 'ต้องแก้ไขรายการที่ระบุว่า “ต้องแก้ไขก่อน” จึงจะอนุมัติได้'
                  : 'การอนุมัติจะบันทึกผู้อนุมัติและเวลาไว้ในบันทึกการตรวจสอบ'}
              </p>
              <div className="flex shrink-0 gap-2">
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  ปิด
                </Button>
                {canApprove && (
                  <Button
                    variant="success"
                    loading={approving}
                    disabled={blockers.length > 0}
                    onClick={onApprove}
                  >
                    อนุมัติรอบเงินเดือน
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReviewStat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'success' | 'danger';
}) {
  const toneClass = {
    default: 'text-foreground',
    success: 'text-success',
    danger: 'text-danger',
  }[tone];
  return (
    <div className="rounded-lg border border-border px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('text-base font-semibold tabular-nums', toneClass)}>{value}</p>
    </div>
  );
}
