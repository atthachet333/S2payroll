import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { payrollApi } from '@/services/endpoints';
import { apiErrorMessage } from '@/services/api';
import { Button, Dialog, DialogContent, ErrorState, Skeleton } from '@/components/ui';
import { cn } from '@/utils/cn';
import type { CheckSeverity } from '@/types';

/**
 * Pre-payroll validation, shown before Calculate.
 *
 * A BLOCKING finding disables the Calculate button here, and the backend
 * refuses the request independently — the UI is a courtesy, not the control.
 */

const SEVERITY = {
  BLOCKING: {
    label: 'ต้องแก้ไขก่อน',
    icon: <AlertOctagon className="h-4 w-4" />,
    box: 'border-danger/30 bg-danger-soft/60 text-danger-fg',
  },
  WARNING: {
    label: 'ควรตรวจสอบ',
    icon: <AlertTriangle className="h-4 w-4" />,
    box: 'border-warning/30 bg-warning-soft/60 text-warning-fg',
  },
  INFO: {
    label: 'ข้อมูล',
    icon: <Info className="h-4 w-4" />,
    box: 'border-border bg-secondary/50 text-foreground',
  },
} satisfies Record<CheckSeverity, { label: string; icon: React.ReactNode; box: string }>;

const ORDER: CheckSeverity[] = ['BLOCKING', 'WARNING', 'INFO'];

export default function PrePayrollCheckDialog({
  open,
  onOpenChange,
  periodId,
  onCalculate,
  calculating,
  canCalculate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  periodId: string;
  onCalculate: () => void;
  calculating: boolean;
  canCalculate: boolean;
}) {
  const query = useQuery({
    queryKey: ['pre-payroll-check', periodId],
    queryFn: () => payrollApi.preCheck(periodId),
    enabled: open,
    // Always re-run when the dialog opens; data may have been fixed since.
    staleTime: 0,
  });

  const report = query.data;
  const findings = report?.findings ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="ตรวจสอบความพร้อมก่อนคำนวณเงินเดือน"
        description={
          report
            ? `${report.periodName} · ${report.startDate} ถึง ${report.endDate}`
            : undefined
        }
        className="max-h-[92vh] max-w-3xl overflow-y-auto"
      >
        {query.isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : query.isError || !report ? (
          <ErrorState message={apiErrorMessage(query.error)} onRetry={() => void query.refetch()} />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              <CountTile label="ต้องแก้ไขก่อน" value={report.blocking} tone="danger" />
              <CountTile label="ควรตรวจสอบ" value={report.warning} tone="warning" />
              <CountTile label="ข้อมูล" value={report.info} tone="muted" />
            </div>

            {report.canCalculate && report.blocking === 0 && (
              <div className="flex items-center gap-2.5 rounded-lg border border-success/30 bg-success-soft/60 px-4 py-3 text-sm text-success-fg">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                ไม่พบปัญหาที่ขัดขวางการคำนวณ พร้อมคำนวณเงินเดือน
              </div>
            )}

            <div className="space-y-2">
              {ORDER.flatMap((severity) =>
                findings
                  .filter((f) => f.severity === severity)
                  .map((f) => (
                    <div
                      key={f.code}
                      className={cn('rounded-lg border px-3.5 py-3 text-sm', SEVERITY[severity].box)}
                    >
                      <div className="flex items-start gap-2">
                        {SEVERITY[severity].icon}
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">
                            {f.title}
                            {f.count > 1 && <span className="ml-1.5 opacity-80">({f.count})</span>}
                          </p>
                          <p className="mt-0.5 opacity-90">{f.detail}</p>
                          {f.samples.length > 0 && (
                            <ul className="mt-1.5 max-h-28 list-inside list-disc overflow-y-auto text-xs opacity-90">
                              {f.samples.map((s) => (
                                <li key={s}>{s}</li>
                              ))}
                              {f.count > f.samples.length && (
                                <li className="list-none italic">
                                  และอีก {f.count - f.samples.length} รายการ
                                </li>
                              )}
                            </ul>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
              )}
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
              <p className="text-xs text-muted-foreground">
                {report.canCalculate
                  ? 'ระบบจะคำนวณจากข้อมูลลงเวลาปัจจุบัน รายการที่ปรับด้วยมือไว้จะยังคงอยู่'
                  : 'ต้องแก้ไขรายการที่ระบุว่า “ต้องแก้ไขก่อน” จึงจะคำนวณได้'}
              </p>
              <div className="flex shrink-0 gap-2">
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  ปิด
                </Button>
                {canCalculate && (
                  <Button
                    loading={calculating}
                    disabled={!report.canCalculate}
                    onClick={onCalculate}
                  >
                    คำนวณเงินเดือน
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

function CountTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'danger' | 'warning' | 'muted';
}) {
  const cls = {
    danger: 'border-danger/30 bg-danger-soft/50 text-danger-fg',
    warning: 'border-warning/30 bg-warning-soft/50 text-warning-fg',
    muted: 'border-border bg-secondary/50 text-foreground',
  }[tone];
  return (
    <div className={cn('rounded-lg border px-3 py-2.5 text-center', cls)}>
      <p className="text-xs">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
