import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { AlertOctagon, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { payrollApi } from '@/services/endpoints';
import { apiErrorMessage } from '@/services/api';
import { Badge, Button, Dialog, DialogContent, ErrorState, Skeleton } from '@/components/ui';
import { PAYROLL_STATUS_GROUPS, EMPLOYMENT_TYPE_LABELS } from '@/components/StatusBadge';
import { cn } from '@/utils/cn';
import type { CheckSeverity, EmployeeReadiness } from '@/types';

/**
 * Payroll readiness, shown before Calculate.
 *
 * This dialog used to be a gate: one employee with an unset rate or a missing
 * punch disabled Calculate for the whole period, which left payroll unable to
 * do anything at all until every last person was fixed. It is now a briefing.
 * Employees are grouped by what is actually true of them, calculation runs on
 * everyone, and each row carries its own status afterwards.
 *
 * A BLOCKING finding still stops the run, but only period-wide faults are
 * BLOCKING now - an overlapping period or broken settings would make every row
 * wrong, not one.
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

const TONE_BOX: Record<string, string> = {
  success: 'border-success/30 bg-success-soft/40',
  warning: 'border-warning/30 bg-warning-soft/40',
  danger: 'border-danger/30 bg-danger-soft/40',
  outline: 'border-border bg-secondary/40',
};

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
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['pre-payroll-check', periodId],
    queryFn: () => payrollApi.preCheck(periodId),
    enabled: open,
    // Always re-run when the dialog opens; data may have been fixed since.
    staleTime: 0,
  });

  const report = query.data;
  const findings = report?.findings ?? [];
  const employees = report?.employees ?? [];

  const goto = (path: string) => {
    onOpenChange(false);
    navigate(path);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="ความพร้อมของพนักงานในรอบนี้"
        description={
          report ? `${report.periodName} · ${report.startDate} ถึง ${report.endDate}` : undefined
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
            {/* The headline is no longer "cannot calculate payroll". Some people
                need checking; the rest can be calculated right now. */}
            {report.readiness.employees > report.readiness.ready ? (
              <div className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning-soft/60 px-4 py-3 text-sm text-warning-fg">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium">มีพนักงานบางคนที่ยังต้องตรวจสอบ</p>
                  <p className="mt-0.5">
                    ระบบจะคำนวณให้ทุกคนเท่าที่ข้อมูลมีอยู่จริง คนที่ยังไม่พร้อมจะถูกทำเครื่องหมายไว้
                    และจะไม่มีการสร้างตัวเลขค่าจ้างขึ้นเอง
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2.5 rounded-lg border border-success/30 bg-success-soft/60 px-4 py-3 text-sm text-success-fg">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                พนักงานทุกคนพร้อมคำนวณ
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <CountTile label="พร้อมคำนวณ" value={report.readiness.ready} tone="success" />
              <CountTile label="คำนวณบางส่วน" value={report.readiness.partial} tone="warning" />
              <CountTile label="ยังตั้งค่าไม่ครบ" value={report.readiness.unconfigured} tone="danger" />
              <CountTile label="เวลาไม่ครบ" value={report.readiness.incompleteAttendance} tone="danger" />
              <CountTile label="ถูกยกเว้น" value={report.readiness.excluded} tone="muted" />
            </div>

            {/* Employees, grouped by what is actually true of them. */}
            <div className="space-y-2">
              {PAYROLL_STATUS_GROUPS.map((group) => {
                const members = employees.filter((e) => group.key.includes(e.status));
                if (members.length === 0) return null;
                return (
                  <div
                    key={group.label}
                    className={cn('rounded-lg border px-3.5 py-3', TONE_BOX[group.tone] ?? TONE_BOX.outline)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium">{group.label}</p>
                      <Badge variant={group.tone}>{members.length} คน</Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{group.hint}</p>
                    <ul className="mt-2 space-y-1.5">
                      {members.map((employee) => (
                        <ReadinessRow key={employee.employeeId} employee={employee} onGoto={goto} />
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>

            {/* Period-level findings. Employee-level ones now live on the rows
                above rather than being repeated here as bare counts. */}
            {findings.length > 0 && (
              <details className="rounded-lg border border-border px-3.5 py-3">
                <summary className="cursor-pointer text-sm font-medium">
                  รายละเอียดการตรวจสอบทั้งหมด ({findings.length})
                </summary>
                <div className="mt-3 space-y-2">
                  {ORDER.flatMap((severity) =>
                    findings
                      .filter((f) => f.severity === severity)
                      .map((f) => (
                        <div
                          key={f.code}
                          className={cn(
                            'rounded-lg border px-3.5 py-3 text-sm',
                            SEVERITY[severity].box
                          )}
                        >
                          <div className="flex items-start gap-2">
                            {SEVERITY[severity].icon}
                            <div className="min-w-0 flex-1">
                              <p className="font-medium">
                                {f.title}
                                {f.count > 1 && (
                                  <span className="ml-1.5 opacity-80">({f.count})</span>
                                )}
                              </p>
                              <p className="mt-0.5 opacity-90">{f.detail}</p>
                              {f.samples.length > 0 && (
                                <ul className="mt-1.5 max-h-28 list-inside list-disc overflow-y-auto text-xs opacity-90">
                                  {f.samples.map((sample) => (
                                    <li key={sample}>{sample}</li>
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
              </details>
            )}

            <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
              <p className="text-xs text-muted-foreground">
                {report.canCalculate
                  ? 'ระบบจะคำนวณจากข้อมูลลงเวลาปัจจุบัน รายการที่ปรับด้วยมือไว้จะยังคงอยู่'
                  : 'มีปัญหาระดับรอบที่ต้องแก้ไขก่อน จึงจะคำนวณได้'}
              </p>
              <div className="flex shrink-0 gap-2">
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  ปิด
                </Button>
                {canCalculate && (
                  <Button loading={calculating} disabled={!report.canCalculate} onClick={onCalculate}>
                    คำนวณรายการที่พร้อม
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

/** One employee, with a way out of whatever is holding them up. */
function ReadinessRow({
  employee,
  onGoto,
}: {
  employee: EmployeeReadiness;
  onGoto: (path: string) => void;
}) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 rounded-md bg-card/60 px-2.5 py-1.5 text-sm">
      <div className="min-w-0">
        <span className="font-medium">{employee.employeeCode}</span>
        <span className="ml-1.5">{employee.employeeName}</span>
        <span className="ml-1.5 text-xs text-muted-foreground">
          {EMPLOYMENT_TYPE_LABELS[employee.employmentType]}
        </span>
        {employee.reasons.length > 0 && (
          <p className="mt-0.5 text-xs text-muted-foreground">{employee.reasons.join(' · ')}</p>
        )}
      </div>
      {employee.action === 'SET_PAY' && (
        <Button size="sm" variant="outline" onClick={() => onGoto('/payroll-settings')}>
          ไปกำหนดค่าจ้าง
        </Button>
      )}
      {/* A half-punched day needs correcting; a person with no attendance at
          all needs time recorded. Sending the second case to the missing-punch
          filter would just show them an empty list. */}
      {employee.action === 'FIX_ATTENDANCE' && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => onGoto('/attendance?status=MISSING_DATA')}
        >
          แก้ไขเวลา
        </Button>
      )}
      {employee.action === 'RECORD_ATTENDANCE' && (
        <Button size="sm" variant="outline" onClick={() => onGoto('/attendance')}>
          ไปบันทึกการลงเวลา
        </Button>
      )}
    </li>
  );
}

function CountTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'success' | 'danger' | 'warning' | 'muted';
}) {
  const cls = {
    success: 'border-success/30 bg-success-soft/50 text-success-fg',
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
