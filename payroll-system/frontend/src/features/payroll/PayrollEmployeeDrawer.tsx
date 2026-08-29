import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileText, History } from 'lucide-react';
import { payrollApi } from '@/services/endpoints';
import { apiErrorMessage } from '@/services/api';
import { useAuth } from '@/features/auth/AuthContext';
import PayslipDocument from '@/features/payslips/PayslipDocument';
import {
  Badge,
  Button,
  Dialog,
  DrawerContent,
  Field,
  Input,
  InfoRow,
  Select,
  Separator,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import { PayrollEmployeeStatusBadge, EMPLOYMENT_TYPE_LABELS } from '@/components/StatusBadge';
import { formatDateTime, formatMoney, formatNumber } from '@/utils/format';

/** Money fields payroll staff may override by hand, mirroring the backend allow-list. */
const ADJUSTABLE_FIELDS: { value: string; label: string; kind: 'income' | 'deduction' }[] = [
  { value: 'allowanceAmount', label: 'เบี้ยเลี้ยง / ค่าตำแหน่ง', kind: 'income' },
  { value: 'bonusAmount', label: 'โบนัส', kind: 'income' },
  { value: 'commissionAmount', label: 'ค่าคอมมิชชั่น', kind: 'income' },
  { value: 'otherIncome', label: 'รายได้อื่น ๆ', kind: 'income' },
  { value: 'otAmount', label: 'ค่าล่วงเวลา', kind: 'income' },
  { value: 'loanDeduction', label: 'หักเงินกู้', kind: 'deduction' },
  { value: 'otherDeduction', label: 'หักอื่น ๆ', kind: 'deduction' },
  { value: 'lateDeduction', label: 'หักมาสาย', kind: 'deduction' },
  { value: 'absenceDeduction', label: 'หักขาดงาน', kind: 'deduction' },
  { value: 'socialSecurity', label: 'ประกันสังคม', kind: 'deduction' },
  { value: 'tax', label: 'ภาษีหัก ณ ที่จ่าย', kind: 'deduction' },
];

export default function PayrollEmployeeDrawer({
  periodId,
  employeeId,
  locked,
  onClose,
}: {
  periodId: string;
  employeeId: string | null;
  locked: boolean;
  onClose: () => void;
}) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const canEdit = can('payroll:write') && !locked;

  const [field, setField] = React.useState(ADJUSTABLE_FIELDS[0].value);
  const [value, setValue] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [printOpen, setPrintOpen] = React.useState(false);

  const query = useQuery({
    queryKey: ['payroll-employee', periodId, employeeId],
    queryFn: () => payrollApi.getEmployee(periodId, employeeId!),
    enabled: Boolean(employeeId),
  });

  const previewQuery = useQuery({
    queryKey: ['payslip-preview', periodId, employeeId],
    queryFn: () => payrollApi.payslipPreview(periodId, employeeId!),
    enabled: Boolean(employeeId) && printOpen,
  });

  const row = query.data;

  // Prefill the amount box with the value currently stored for the chosen field.
  React.useEffect(() => {
    if (row) setValue(String(row[field as keyof typeof row] ?? ''));
  }, [field, row]);

  const adjustMutation = useMutation({
    mutationFn: () =>
      payrollApi.adjustEmployee(periodId, employeeId!, {
        adjustments: [{ field, value, reason }],
      }),
    onSuccess: () => {
      toast.success('บันทึกการปรับปรุงเรียบร้อยแล้ว');
      setReason('');
      void queryClient.invalidateQueries({ queryKey: ['payroll-employee'] });
      void queryClient.invalidateQueries({ queryKey: ['payroll-employees'] });
      void queryClient.invalidateQueries({ queryKey: ['payroll-period'] });
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const markReady = useMutation({
    mutationFn: () =>
      payrollApi.adjustEmployee(periodId, employeeId!, {
        adjustments: [
          {
            field: 'otherIncome',
            value: String(row?.otherIncome ?? '0'),
            reason: 'ยืนยันการตรวจสอบข้อมูล',
          },
        ],
        status: 'READY',
      }),
    onSuccess: () => {
      toast.success('ทำเครื่องหมายว่าตรวจสอบแล้ว');
      void queryClient.invalidateQueries({ queryKey: ['payroll-employee'] });
      void queryClient.invalidateQueries({ queryKey: ['payroll-employees'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  });

  return (
    <>
      <Dialog open={Boolean(employeeId)} onOpenChange={(open) => !open && onClose()}>
        <DrawerContent
          title={row ? row.employeeName : 'รายละเอียดเงินเดือน'}
          description={
            row
              ? `${row.employeeCode} · ${row.departmentName ?? 'ไม่ระบุแผนก'} · ${EMPLOYMENT_TYPE_LABELS[row.employmentType]}`
              : undefined
          }
        >
          {query.isLoading || !row ? (
            <div className="space-y-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-2">
                <PayrollEmployeeStatusBadge status={row.status} />
                {row.hasAdjustment && <Badge variant="info">มีการปรับปรุงด้วยมือ</Badge>}
                <div className="ml-auto flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setPrintOpen(true)}>
                    <FileText className="h-4 w-4" />
                    ดูสลิป
                  </Button>
                  {canEdit && row.status !== 'READY' && (
                    <Button
                      variant="success"
                      size="sm"
                      loading={markReady.isPending}
                      onClick={() => markReady.mutate()}
                    >
                      ยืนยันว่าตรวจสอบแล้ว
                    </Button>
                  )}
                </div>
              </div>

              {Array.isArray(row.reviewNotes) && row.reviewNotes.length > 0 && (
                <div className="rounded-lg bg-warning-soft px-3.5 py-3 text-sm text-warning-fg">
                  <p className="mb-1 font-medium">สิ่งที่ต้องตรวจสอบ</p>
                  <ul className="list-inside list-disc space-y-0.5">
                    {row.reviewNotes.map((note, i) => (
                      <li key={i}>{note}</li>
                    ))}
                  </ul>
                </div>
              )}

              <Tabs defaultValue="summary">
                <TabsList>
                  <TabsTrigger value="summary">สรุป</TabsTrigger>
                  <TabsTrigger value="lines">รายการ</TabsTrigger>
                  {canEdit && <TabsTrigger value="adjust">ปรับปรุง</TabsTrigger>}
                  <TabsTrigger value="history">ประวัติ</TabsTrigger>
                </TabsList>

                <TabsContent value="summary" className="space-y-5">
                  <Section title="สรุปการลงเวลา">
                    <div className="grid grid-cols-2 gap-x-8">
                      <div className="divide-y divide-border/70">
                        <InfoRow label="วันทำงานในรอบ" value={formatNumber(row.workingDays)} />
                        <InfoRow label="วันที่มาทำงาน" value={formatNumber(row.presentDays)} />
                        <InfoRow label="ชั่วโมงทำงาน" value={formatNumber(row.workingHours, 2)} />
                        <InfoRow label="ชั่วโมงงานปกติ" value={formatNumber(row.normalHours, 2)} />
                        <InfoRow label="ชั่วโมง OT" value={formatNumber(row.otHours, 2)} />
                      </div>
                      <div className="divide-y divide-border/70">
                        <InfoRow label="จำนวนครั้งที่มาสาย" value={formatNumber(row.lateCount)} />
                        <InfoRow label="นาทีที่มาสาย" value={formatNumber(row.lateMinutes)} />
                        <InfoRow
                          label="ขาดงาน"
                          value={
                            <span className={row.absentDays > 0 ? 'text-danger' : undefined}>
                              {formatNumber(row.absentDays)} วัน
                            </span>
                          }
                        />
                        <InfoRow label="ลา" value={`${formatNumber(row.leaveDays, 2)} วัน`} />
                      </div>
                    </div>

                    {/* Incomplete attendance is surfaced explicitly rather than
                        being absorbed silently into the calculation. */}
                    {row.missingDataDays > 0 && (
                      <div className="mt-3 rounded-lg bg-danger-soft px-3.5 py-2.5 text-sm text-danger-fg">
                        <p className="font-medium">ข้อมูลลงเวลาไม่ครบ {formatNumber(row.missingDataDays)} วัน</p>
                        <p className="mt-0.5">
                          ไม่มีเวลาเข้า {formatNumber(row.missingCheckInDays)} วัน · ไม่มีเวลาออก{' '}
                          {formatNumber(row.missingCheckOutDays)} วัน
                        </p>
                      </div>
                    )}
                  </Section>

                  <Section title="รายได้">
                    <div className="divide-y divide-border/70">
                      <InfoRow label="เงินเดือนพื้นฐาน" value={formatMoney(row.baseSalary)} />
                      <InfoRow label="ค่าล่วงเวลา" value={formatMoney(row.otAmount)} />
                      <InfoRow label="เบี้ยเลี้ยง" value={formatMoney(row.allowanceAmount)} />
                      <InfoRow label="โบนัส" value={formatMoney(row.bonusAmount)} />
                      <InfoRow label="ค่าคอมมิชชั่น" value={formatMoney(row.commissionAmount)} />
                      <InfoRow label="รายได้อื่น ๆ" value={formatMoney(row.otherIncome)} />
                      <InfoRow
                        label="รวมรายได้"
                        value={<span className="text-success">{formatMoney(row.grossIncome)}</span>}
                        className="font-semibold"
                      />
                    </div>
                  </Section>

                  <Section title="รายการหัก">
                    <div className="divide-y divide-border/70">
                      <InfoRow label="หักมาสาย" value={formatMoney(row.lateDeduction)} />
                      <InfoRow label="หักขาดงาน" value={formatMoney(row.absenceDeduction)} />
                      <InfoRow label="ประกันสังคม" value={formatMoney(row.socialSecurity)} />
                      <InfoRow label="ภาษีหัก ณ ที่จ่าย" value={formatMoney(row.tax)} />
                      <InfoRow label="หักเงินกู้" value={formatMoney(row.loanDeduction)} />
                      <InfoRow label="หักอื่น ๆ" value={formatMoney(row.otherDeduction)} />
                      <InfoRow
                        label="รวมรายการหัก"
                        value={<span className="text-danger">{formatMoney(row.totalDeduction)}</span>}
                        className="font-semibold"
                      />
                    </div>
                  </Section>

                  <div className="flex items-center justify-between rounded-xl bg-primary px-5 py-4 text-primary-foreground">
                    <span className="text-sm font-medium">เงินเดือนสุทธิ</span>
                    <span className="text-2xl font-semibold tabular-nums">
                      {formatMoney(row.netSalary)} <span className="text-sm font-normal">บาท</span>
                    </span>
                  </div>
                </TabsContent>

                <TabsContent value="lines" className="space-y-5">
                  <Section title="รายการรายได้">
                    <LineTable lines={row.incomes} />
                  </Section>
                  <Section title="รายการหัก">
                    <LineTable lines={row.deductions} />
                  </Section>
                </TabsContent>

                {canEdit && (
                  <TabsContent value="adjust" className="space-y-4">
                    <p className="rounded-lg bg-info-soft px-3.5 py-3 text-sm text-info-fg">
                      การปรับปรุงทุกครั้งจะบันทึกผู้แก้ไข เวลา ค่าเดิม ค่าใหม่ และเหตุผล
                      และยอดรวมจะถูกคำนวณใหม่ทันที
                    </p>

                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        setError(null);
                        if (reason.trim().length < 3) {
                          setError('กรุณาระบุเหตุผลอย่างน้อย 3 ตัวอักษร');
                          return;
                        }
                        adjustMutation.mutate();
                      }}
                      className="space-y-4"
                    >
                      <Field label="รายการที่ต้องการปรับ" required>
                        <Select value={field} onChange={(e) => setField(e.target.value)}>
                          <optgroup label="รายได้">
                            {ADJUSTABLE_FIELDS.filter((f) => f.kind === 'income').map((f) => (
                              <option key={f.value} value={f.value}>
                                {f.label}
                              </option>
                            ))}
                          </optgroup>
                          <optgroup label="รายการหัก">
                            {ADJUSTABLE_FIELDS.filter((f) => f.kind === 'deduction').map((f) => (
                              <option key={f.value} value={f.value}>
                                {f.label}
                              </option>
                            ))}
                          </optgroup>
                        </Select>
                      </Field>

                      <Field label="จำนวนเงินใหม่ (บาท)" required>
                        <Input
                          type="number"
                          step="0.01"
                          value={value}
                          onChange={(e) => setValue(e.target.value)}
                          required
                        />
                      </Field>

                      <Field label="เหตุผล" required error={error}>
                        <Textarea
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          rows={2}
                          placeholder="เช่น เพิ่มเบี้ยขยันตามที่หัวหน้าอนุมัติ"
                        />
                      </Field>

                      <Button type="submit" loading={adjustMutation.isPending}>
                        บันทึกการปรับปรุง
                      </Button>
                    </form>
                  </TabsContent>
                )}

                <TabsContent value="history">
                  {row.adjustments.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      ยังไม่มีประวัติการปรับปรุง
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {row.adjustments.map((adj) => (
                        <div key={adj.id} className="rounded-lg border border-border px-3.5 py-3">
                          <div className="flex items-start justify-between gap-3">
                            <span className="flex items-center gap-1.5 text-sm font-medium">
                              <History className="h-3.5 w-3.5" />
                              {ADJUSTABLE_FIELDS.find((f) => f.value === adj.fieldName)?.label ??
                                adj.fieldName}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {formatDateTime(adj.changedAt)}
                            </span>
                          </div>
                          <p className="mt-1.5 text-sm tabular-nums">
                            <span className="text-muted-foreground line-through">
                              {formatMoney(adj.oldValue)}
                            </span>
                            {' → '}
                            <span className="font-medium">{formatMoney(adj.newValue)}</span>
                          </p>
                          <p className="mt-1 text-xs italic text-muted-foreground">{adj.reason}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          )}
        </DrawerContent>
      </Dialog>

      <PayslipDocument
        open={printOpen}
        onOpenChange={setPrintOpen}
        snapshot={previewQuery.data ?? null}
        loading={previewQuery.isLoading}
      />
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="muted-label mb-1.5">{title}</p>
      <Separator className="mb-2" />
      {children}
    </div>
  );
}

function LineTable({
  lines,
}: {
  lines: { id: string; label: string; quantity: string | null; rate: string | null; amount: string; isManual: boolean }[];
}) {
  if (lines.length === 0) {
    return <p className="py-4 text-center text-sm text-muted-foreground">ไม่มีรายการ</p>;
  }
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>รายการ</th>
          <th className="text-right">จำนวน</th>
          <th className="text-right">อัตรา</th>
          <th className="text-right">จำนวนเงิน</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <tr key={line.id}>
            <td>
              {line.label}
              {line.isManual && (
                <Badge variant="info" className="ml-2">
                  ปรับด้วยมือ
                </Badge>
              )}
            </td>
            <td className="num text-muted-foreground">
              {line.quantity ? formatNumber(line.quantity, 2) : '-'}
            </td>
            <td className="num text-muted-foreground">
              {line.rate ? formatMoney(line.rate) : '-'}
            </td>
            <td className="num font-medium">{formatMoney(line.amount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
