import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Wallet } from 'lucide-react';
import dayjs from 'dayjs';
import { payrollApi } from '@/services/endpoints';
import { apiErrorMessage } from '@/services/api';
import { useAuth } from '@/features/auth/AuthContext';
import {
  Button,
  Card,
  Dialog,
  DialogContent,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Select,
  Switch,
  TableSkeleton,
} from '@/components/ui';
import { PeriodStatusBadge } from '@/components/StatusBadge';
import { formatDate, formatMoney, formatNumber, thaiMonthName } from '@/utils/format';

export default function PayrollPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [createOpen, setCreateOpen] = React.useState(false);

  const query = useQuery({ queryKey: ['payroll-periods'], queryFn: payrollApi.listPeriods });

  return (
    <div>
      <PageHeader
        title="เงินเดือน"
        description="จัดการรอบเงินเดือน ตั้งแต่ฉบับร่างจนถึงการล็อกรอบ"
        actions={
          can('payroll:write') ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              สร้างรอบเงินเดือน
            </Button>
          ) : null
        }
      />

      <Card className="overflow-hidden">
        {query.isLoading ? (
          <TableSkeleton rows={6} cols={7} />
        ) : query.isError ? (
          <ErrorState message={apiErrorMessage(query.error)} onRetry={() => void query.refetch()} />
        ) : query.data && query.data.length === 0 ? (
          <EmptyState
            icon={<Wallet className="h-6 w-6" />}
            title="ยังไม่มีรอบเงินเดือน"
            description="สร้างรอบเงินเดือนแรกเพื่อเริ่มคำนวณจากข้อมูลการลงเวลา"
            action={
              can('payroll:write') ? (
                <Button onClick={() => setCreateOpen(true)}>สร้างรอบเงินเดือน</Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>รอบเงินเดือน</th>
                  <th>ช่วงวันที่</th>
                  <th>วันจ่าย</th>
                  <th className="text-right">พนักงาน</th>
                  <th className="text-right">รายได้รวม</th>
                  <th className="text-right">รายการหัก</th>
                  <th className="text-right">เงินสุทธิ</th>
                  <th>สถานะ</th>
                </tr>
              </thead>
              <tbody>
                {query.data?.map((period) => (
                  <tr
                    key={period.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/payroll/${period.id}`)}
                  >
                    <td className="font-medium">{period.name}</td>
                    <td className="whitespace-nowrap text-muted-foreground">
                      {formatDate(period.startDate)} - {formatDate(period.endDate)}
                    </td>
                    <td className="text-muted-foreground">{formatDate(period.paymentDate)}</td>
                    <td className="num">{formatNumber(period.totalEmployees)}</td>
                    <td className="num">{formatMoney(period.grossTotal)}</td>
                    <td className="num text-danger">{formatMoney(period.deductionTotal)}</td>
                    <td className="num font-semibold">{formatMoney(period.netTotal)}</td>
                    <td>
                      <PeriodStatusBadge status={period.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <CreatePeriodDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function CreatePeriodDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const now = dayjs();

  const [year, setYear] = React.useState(String(now.year()));
  const [month, setMonth] = React.useState(String(now.month() + 1));
  const [paymentDate, setPaymentDate] = React.useState('');
  const [customWindow, setCustomWindow] = React.useState(false);
  const [startDate, setStartDate] = React.useState('');
  const [endDate, setEndDate] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  // Default the custom window to the calendar month the user picked, so opening
  // the toggle shows a sensible starting point rather than empty boxes.
  React.useEffect(() => {
    const base = dayjs(`${year}-${String(month).padStart(2, '0')}-01`);
    setStartDate(base.startOf('month').format('YYYY-MM-DD'));
    setEndDate(base.endOf('month').format('YYYY-MM-DD'));
  }, [year, month]);

  const mutation = useMutation({
    mutationFn: () =>
      payrollApi.createPeriod({
        year: Number(year),
        month: Number(month),
        startDate: customWindow ? startDate : null,
        endDate: customWindow ? endDate : null,
        paymentDate: paymentDate || null,
      }),
    onSuccess: (period) => {
      toast.success(`สร้างรอบเงินเดือน ${period.name} เรียบร้อยแล้ว`);
      void queryClient.invalidateQueries({ queryKey: ['payroll-periods'] });
      onOpenChange(false);
      navigate(`/payroll/${period.id}`);
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const years = Array.from({ length: 7 }, (_, i) => now.year() - 3 + i);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="สร้างรอบเงินเดือน"
        description="แต่ละเดือนสร้างได้เพียงรอบเดียว"
        className="max-w-md"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            mutation.mutate();
          }}
          className="space-y-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="เดือน" required>
              <Select value={month} onChange={(e) => setMonth(e.target.value)}>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={m}>
                    {thaiMonthName(m)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="ปี (ค.ศ.)" required>
              <Select value={year} onChange={(e) => setYear(e.target.value)}>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border px-3.5 py-2.5">
            <div>
              <p className="text-sm font-medium">กำหนดช่วงวันที่เอง</p>
              <p className="text-xs text-muted-foreground">
                สำหรับรอบที่ไม่ตรงกับเดือนปฏิทิน เช่น 26 ถึง 25
              </p>
            </div>
            <Switch checked={customWindow} onCheckedChange={setCustomWindow} />
          </div>

          {customWindow && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="วันเริ่มรอบ" required>
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  required
                />
              </Field>
              <Field label="วันสิ้นสุดรอบ" required>
                <Input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  required
                />
              </Field>
            </div>
          )}

          <Field
            label="วันที่จ่ายเงิน"
            hint="เว้นว่างเพื่อใช้ค่าเริ่มต้นจากการตั้งค่าเงินเดือน"
            error={error}
          >
            <Input
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
            />
          </Field>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              ยกเลิก
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              สร้างรอบ
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
