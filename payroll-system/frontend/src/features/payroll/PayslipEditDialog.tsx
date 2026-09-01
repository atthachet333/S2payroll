import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { payrollApi } from '@/services/endpoints';
import { apiErrorMessage } from '@/services/api';
import { Button, Dialog, DialogContent, Field, Input, Textarea } from '@/components/ui';
import { formatMoney } from '@/utils/format';
import type { PayrollEmployeeDetail } from '@/types';

/**
 * Edit the payroll items behind a payslip.
 *
 * "แก้ไข" never means editing a generated document - the PDF is rendered from a
 * verified snapshot and is not a thing you can type into. It means correcting
 * the payroll inputs, after which the totals are recomputed server-side and the
 * payslip is re-issued from the new figures.
 *
 * Every changed field writes a PayrollAdjustment row carrying the old value, the
 * new value and the reason, so a payslip that differs from the calculation can
 * always be explained. The reason is mandatory for exactly that purpose.
 */

interface EditableField {
  key: string;
  label: string;
  side: 'income' | 'deduction';
}

/** Mirrors the backend allow-list. Base pay is absent on purpose: it is derived
 *  from the pay profile and attendance, and is corrected by fixing those. */
const FIELDS: EditableField[] = [
  { key: 'otAmount', label: 'ค่าล่วงเวลา (OT)', side: 'income' },
  { key: 'bonusAmount', label: 'โบนัส', side: 'income' },
  { key: 'allowanceAmount', label: 'เบี้ยเลี้ยง / ค่าตำแหน่ง', side: 'income' },
  { key: 'commissionAmount', label: 'ค่าคอมมิชชั่น', side: 'income' },
  { key: 'otherIncome', label: 'รายได้อื่น ๆ', side: 'income' },
  { key: 'lateDeduction', label: 'หักมาสาย', side: 'deduction' },
  { key: 'leaveDeduction', label: 'หักลา', side: 'deduction' },
  { key: 'absenceDeduction', label: 'หักขาดงาน', side: 'deduction' },
  { key: 'socialSecurity', label: 'ประกันสังคม', side: 'deduction' },
  { key: 'tax', label: 'ภาษีหัก ณ ที่จ่าย', side: 'deduction' },
  { key: 'loanDeduction', label: 'หักเงินกู้', side: 'deduction' },
  { key: 'otherDeduction', label: 'หักอื่น ๆ', side: 'deduction' },
];

type FormState = Record<string, string>;

const stateFrom = (row: PayrollEmployeeDetail): FormState =>
  Object.fromEntries(
    FIELDS.map((f) => [f.key, Number((row as unknown as Record<string, string>)[f.key] ?? 0).toFixed(2)])
  );

export default function PayslipEditDialog({
  open,
  onOpenChange,
  periodId,
  row,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  periodId: string;
  row: PayrollEmployeeDetail | null;
  onSaved?: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = React.useState<FormState>({});
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const initial = React.useMemo(() => (row ? stateFrom(row) : {}), [row]);

  React.useEffect(() => {
    if (open && row) {
      setForm(stateFrom(row));
      setReason('');
      setError(null);
    }
  }, [open, row]);

  // Only fields the operator actually touched are sent, so an untouched field
  // never produces a spurious adjustment row in the audit trail.
  const changed = FIELDS.filter(
    (f) => Number(form[f.key] ?? 0) !== Number(initial[f.key] ?? 0)
  );

  const mutation = useMutation({
    mutationFn: () =>
      payrollApi.adjustEmployee(periodId, row!.employeeId, {
        adjustments: changed.map((f) => ({
          field: f.key,
          value: Number(form[f.key] ?? 0).toFixed(2),
          reason: reason.trim(),
        })),
      }),
    onSuccess: async () => {
      toast.success('บันทึกการแก้ไขรายการเงินเดือนแล้ว');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['payroll-employee', periodId, row!.employeeId] }),
        queryClient.invalidateQueries({ queryKey: ['payroll-employees', periodId] }),
        queryClient.invalidateQueries({ queryKey: ['payroll-period', periodId] }),
        queryClient.invalidateQueries({ queryKey: ['payslip-preview', periodId, row!.employeeId] }),
        queryClient.invalidateQueries({ queryKey: ['payslips'] }),
      ]);
      onOpenChange(false);
      onSaved?.();
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const set = (key: string, value: string) => setForm((prev) => ({ ...prev, [key]: value }));

  // Recomputed live so the operator sees the effect before committing. The
  // server recalculates independently; this is a preview, not the authority.
  const preview = React.useMemo(() => {
    if (!row) return null;
    const sum = (side: 'income' | 'deduction') =>
      FIELDS.filter((f) => f.side === side).reduce((a, f) => a + Number(form[f.key] ?? 0), 0);
    const gross = Number(row.baseSalary) + sum('income');
    const deduction = sum('deduction');
    return { gross, deduction, net: gross - deduction };
  }, [row, form]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="แก้ไขรายการเงินเดือน"
        description={
          row
            ? `${row.employeeCode} · ${row.employeeName} · รอบ ${row.period.name}`
            : undefined
        }
        className="max-h-[92vh] max-w-3xl overflow-y-auto"
      >
        {row && (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-secondary/40 px-3.5 py-3 text-sm">
              <p className="font-medium">
                เงินเดือน/ค่าจ้างพื้นฐาน {formatMoney(row.baseSalary)} บาท
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                ค่าจ้างพื้นฐานคำนวณจากอัตราค่าจ้างและข้อมูลการลงเวลา
                หากไม่ถูกต้องให้แก้ที่อัตราค่าจ้างหรือข้อมูลเวลา แล้วคำนวณรอบใหม่
              </p>
            </div>

            <PolicySummary row={row} />

            <p className="text-xs font-medium text-muted-foreground">
              รายการด้านล่างเป็นการปรับเฉพาะรอบ {row.period.name} และไม่แก้ไขนโยบายประจำตัวพนักงาน
            </p>

            <div className="grid gap-4 md:grid-cols-2">
              <Column
                title="รายได้"
                tone="text-success"
                fields={FIELDS.filter((f) => f.side === 'income')}
                form={form}
                initial={initial}
                onChange={set}
              />
              <Column
                title="รายการหัก"
                tone="text-danger"
                fields={FIELDS.filter((f) => f.side === 'deduction')}
                form={form}
                initial={initial}
                onChange={set}
              />
            </div>

            {preview && (
              <div className="grid grid-cols-3 gap-2 rounded-lg border border-border px-3.5 py-3 text-sm">
                <Total label="รายได้รวม" value={preview.gross} />
                <Total label="รายการหักรวม" value={preview.deduction} tone="text-danger" />
                <Total label="รับสุทธิ" value={preview.net} tone="font-semibold text-primary" />
              </div>
            )}

            <Field
              label="เหตุผลในการแก้ไข"
              required
              hint="บันทึกไว้กับทุกรายการที่เปลี่ยน เพื่อให้ตรวจสอบย้อนหลังได้"
              error={error}
            >
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder="เช่น ปรับโบนัสตามที่ผู้จัดการอนุมัติเมื่อ 28 ส.ค."
              />
            </Field>

            <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
              <p className="text-xs text-muted-foreground">
                {changed.length > 0
                  ? `จะบันทึกการเปลี่ยนแปลง ${changed.length} รายการ`
                  : 'ยังไม่มีการเปลี่ยนแปลง'}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  ยกเลิก
                </Button>
                <Button
                  disabled={changed.length === 0 || reason.trim().length < 3}
                  loading={mutation.isPending}
                  onClick={() => mutation.mutate()}
                >
                  บันทึกและคำนวณยอดใหม่
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Column({
  title,
  tone,
  fields,
  form,
  initial,
  onChange,
}: {
  title: string;
  tone: string;
  fields: EditableField[];
  form: FormState;
  initial: FormState;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div className="rounded-lg border border-border">
      <div className={`border-b border-border bg-secondary/50 px-3.5 py-2 text-sm font-semibold ${tone}`}>
        {title}
      </div>
      <div className="space-y-2.5 p-3.5">
        {fields.map((f) => {
          const dirty = Number(form[f.key] ?? 0) !== Number(initial[f.key] ?? 0);
          return (
            <div key={f.key} className="relative grid grid-cols-[1fr,120px] items-center gap-2">
              <label htmlFor={`pay-${f.key}`} className="text-sm">
                {f.label}
                {dirty && <span className="ml-1.5 text-xs text-warning">แก้ไข</span>}
              </label>
              <Input
                id={`pay-${f.key}`}
                type="number"
                step="0.01"
                min="0"
                className="pr-12 text-right tabular-nums"
                value={form[f.key] ?? ''}
                onChange={(e) => onChange(f.key, e.target.value)}
              />
              <span className="pointer-events-none absolute right-3 text-xs text-muted-foreground">
                บาท
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const Total = ({ label, value, tone }: { label: string; value: number; tone?: string }) => (
  <div>
    <p className="text-xs text-muted-foreground">{label}</p>
    <p className={`tabular-nums ${tone ?? ''}`}>{formatMoney(value)}</p>
  </div>
);

function PolicySummary({ row }: { row: PayrollEmployeeDetail }) {
  const policy = row.employee.payrollPolicy;
  const value = (amount: string | null | undefined) =>
    amount == null ? 'ใช้ค่าบริษัท' : `${formatMoney(amount)} บาท`;

  return (
    <div className="rounded-lg border border-dashed border-border px-3.5 py-3 text-xs">
      <p className="font-semibold text-foreground">นโยบายพนักงาน (อ่านอย่างเดียว)</p>
      <div className="mt-2 grid gap-x-4 gap-y-1 text-muted-foreground sm:grid-cols-2">
        <span>ประกันสังคม: {value(policy?.socialSecurityAmount)}</span>
        <span>ภาษี: {value(policy?.taxAmount)}</span>
        <span>หักมาสาย: {policy?.lateDeductionType ?? 'ใช้ค่าบริษัท'}</span>
        <span>หักลา: {policy?.leaveDeductionType ?? 'ใช้ค่าบริษัท'}</span>
        <span>หักขาดงาน: {policy?.absenceDeductionType ?? 'ใช้ค่าบริษัท'}</span>
      </div>
    </div>
  );
}
