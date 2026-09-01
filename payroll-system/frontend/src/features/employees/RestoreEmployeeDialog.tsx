import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { RotateCcw } from 'lucide-react';
import { employeeApi } from '@/services/endpoints';
import { apiErrorMessage } from '@/services/api';
import { Button, Dialog, DialogContent, Field, Input, InfoRow, Textarea } from '@/components/ui';
import { EmployeeStatusBadge } from '@/components/StatusBadge';
import { formatDate, formatIsoDate } from '@/utils/format';
import type { Employee } from '@/types';

/**
 * Bring a deactivated or terminated employee back onto the payroll.
 *
 * The return-to-work date is required and deliberately not pre-filled with
 * today. Payroll measures the new spell of employment from this date, so
 * defaulting it silently would put a guess into the calculation - and the
 * operator would have no reason to notice.
 */
export default function RestoreEmployeeDialog({
  employee,
  onClose,
}: {
  employee: Employee | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [returnDate, setReturnDate] = React.useState('');
  const [reason, setReason] = React.useState('');

  React.useEffect(() => {
    if (employee) {
      setReturnDate('');
      setReason('');
    }
  }, [employee]);

  const mutation = useMutation({
    mutationFn: () =>
      employeeApi.reactivate(employee!.id, { returnDate, reason: reason.trim() || null }),
    onSuccess: (updated) => {
      toast.success(`${updated.firstName} ${updated.lastName} กลับมาทำงานแล้ว`);
      void queryClient.invalidateQueries({ queryKey: ['employees'] });
      void queryClient.invalidateQueries({ queryKey: ['employee'] });
      void queryClient.invalidateQueries({ queryKey: ['employee-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['employee-completeness-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['pre-payroll-check'] });
      onClose();
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });

  const tooEarly =
    Boolean(returnDate) && Boolean(employee) && returnDate < formatIsoDate(employee!.startDate);

  return (
    <Dialog open={Boolean(employee)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent title="ให้พนักงานกลับมาทำงาน?" className="max-w-md">
        {employee && (
          <div className="space-y-4">
            <div className="divide-y divide-border/70 rounded-lg border border-border px-3.5">
              <InfoRow label="รหัสพนักงาน" value={employee.employeeCode} />
              <InfoRow
                label="ชื่อ-นามสกุล"
                value={`${employee.firstName} ${employee.lastName}`}
              />
              <InfoRow
                label="สถานะปัจจุบัน"
                value={<EmployeeStatusBadge status={employee.status} />}
              />
              <InfoRow label="วันที่เริ่มงานเดิม" value={formatDate(employee.startDate)} />
              <InfoRow
                label="วันที่สิ้นสุดเดิม"
                value={employee.endDate ? formatDate(employee.endDate) : '-'}
              />
            </div>

            <Field
              label="วันที่กลับมาทำงาน"
              required
              hint="ระบบใช้วันที่นี้เป็นจุดเริ่มของการจ้างงานรอบใหม่ในการคำนวณเงินเดือน"
              error={tooEarly ? 'ต้องไม่ก่อนวันที่เริ่มงานเดิม' : undefined}
            >
              <Input
                type="date"
                value={returnDate}
                onChange={(e) => setReturnDate(e.target.value)}
                required
              />
            </Field>

            <Field label="เหตุผล" hint="ไม่บังคับ แต่จะถูกบันทึกไว้ในประวัติการตรวจสอบ">
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder="เช่น กลับเข้าทำงานหลังลาออกชั่วคราว"
              />
            </Field>

            <p className="rounded-lg border border-border bg-secondary/50 px-3.5 py-2.5 text-xs text-muted-foreground">
              ประวัติการพ้นสภาพเดิมจะไม่ถูกลบ ระบบบันทึกสถานะและวันที่สิ้นสุดก่อนหน้าไว้ใน
              ประวัติการตรวจสอบ และวันที่เริ่มงานเดิมยังคงอยู่ตามเดิม
            </p>

            <div className="flex justify-end gap-2 border-t border-border pt-4">
              <Button variant="outline" onClick={onClose}>
                ยกเลิก
              </Button>
              <Button
                variant="success"
                disabled={!returnDate || tooEarly}
                loading={mutation.isPending}
                onClick={() => mutation.mutate()}
              >
                <RotateCcw className="h-4 w-4" />
                ให้กลับมาทำงาน
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
