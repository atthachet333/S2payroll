import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarPlus } from 'lucide-react';
import { employeeApi } from '@/services/endpoints';
import { apiErrorMessage, apiErrorDetails, apiErrorCode } from '@/services/api';
import { Button, Dialog, DialogContent, Field, Input, Textarea } from '@/components/ui';
import { formatIsoDate } from '@/utils/format';
import { EMPLOYEE_STATUS_LABELS } from '@/components/StatusBadge';
import type { Employee } from '@/types';

/**
 * Record one worked day by hand.
 *
 * HR enters only what they actually observed - the date and the two punches.
 * Worked minutes, lateness and OT are derived by the backend from the same
 * engine the Google Sheet import uses. Asking a person to type a worked-minutes
 * figure invites a number that disagrees with the times printed beside it.
 *
 * Nothing here is written back to Google Sheets; the sheet stays read-only.
 */
export default function ManualAttendanceDialog({
  employee,
  onClose,
}: {
  employee: Employee | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [workDate, setWorkDate] = React.useState('');
  const [checkIn, setCheckIn] = React.useState('');
  const [checkOut, setCheckOut] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [note, setNote] = React.useState('');
  const [duplicateId, setDuplicateId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmed, setConfirmed] = React.useState(false);

  React.useEffect(() => {
    if (employee) {
      setWorkDate(formatIsoDate(new Date()));
      setCheckIn('');
      setCheckOut('');
      setReason('');
      setNote('');
      setDuplicateId(null);
      setError(null);
      setConfirmed(false);
    }
  }, [employee]);

  const mutation = useMutation({
    mutationFn: () =>
      employeeApi.createAttendance(employee!.id, {
        workDate,
        checkIn: checkIn || null,
        checkOut: checkOut || null,
        reason,
        note: note.trim() || null,
      }),
    onSuccess: () => {
      toast.success('บันทึกวันมาทำงานเรียบร้อยแล้ว');
      void queryClient.invalidateQueries({ queryKey: ['attendance'] });
      void queryClient.invalidateQueries({ queryKey: ['employee-attendance'] });
      void queryClient.invalidateQueries({ queryKey: ['employee-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['employee-daily-earnings'] });
      void queryClient.invalidateQueries({ queryKey: ['attendance-calendar'] });
      void queryClient.invalidateQueries({ queryKey: ['pre-payroll-check'] });
      onClose();
    },
    onError: (err) => {
      // A day that already exists is not a failure to retry - it is a pointer
      // to the record the operator actually wants, so the dialog offers to
      // take them there rather than leaving them to search for it. Branching on
      // the code rather than the message keeps this working if the wording
      // changes.
      const details = apiErrorDetails(err) as { attendanceId?: string } | null;
      const duplicate = apiErrorCode(err) === 'ATTENDANCE_ALREADY_EXISTS';
      setDuplicateId(duplicate ? (details?.attendanceId ?? null) : null);
      setError(apiErrorMessage(err));
    },
  });

  const working = employee ? ['ACTIVE', 'PROBATION'].includes(employee.status) : true;

  // The employment period, not the status today, is what bounds a historical
  // entry. A former employee's days before they left are perfectly valid.
  const startIso = employee ? formatIsoDate(employee.startDate) : '';
  const endIso = employee?.endDate ? formatIsoDate(employee.endDate) : null;
  const todayIso = formatIsoDate(new Date());
  // Never offer a date past the end of employment, or past today.
  const maxIso = endIso && endIso < todayIso ? endIso : todayIso;

  const beforeStart = Boolean(workDate) && Boolean(startIso) && workDate < startIso;
  const afterEnd = Boolean(workDate) && Boolean(endIso) && workDate > endIso!;
  // A former employee with no end date has no reliable boundary to check, so
  // the entry is allowed but must be confirmed explicitly.
  const needsConfirmation = !working && !endIso;

  const dateError = beforeStart
    ? 'วันที่ต้องไม่ก่อนวันเริ่มงานของพนักงาน'
    : afterEnd
      ? 'วันที่เลือกอยู่นอกช่วงการทำงานของพนักงาน'
      : null;

  const canSubmit =
    Boolean(workDate) &&
    !dateError &&
    reason.trim().length >= 3 &&
    Boolean(checkIn || checkOut) &&
    (!needsConfirmation || confirmed);

  return (
    <Dialog open={Boolean(employee)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="เพิ่มวันมาทำงาน"
        description={
          employee
            ? `${employee.employeeCode} · ${employee.firstName} ${employee.lastName}`
            : undefined
        }
        className="max-w-md"
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            setDuplicateId(null);
            mutation.mutate();
          }}
        >
          {!working && employee && (
            <div className="rounded-lg border border-warning/30 bg-warning-soft/60 px-3.5 py-2.5 text-sm text-warning-fg">
              <p>
                สถานะปัจจุบัน:{' '}
                <span className="font-semibold">
                  {EMPLOYEE_STATUS_LABELS[employee.status] ?? employee.status}
                </span>
              </p>
              <p className="mt-1">
                สามารถเพิ่มข้อมูลย้อนหลังได้เฉพาะวันที่อยู่ในช่วงที่พนักงานยังทำงาน
                {endIso ? ` (${startIso} ถึง ${endIso})` : ` (ตั้งแต่ ${startIso})`}
              </p>
            </div>
          )}

          <Field
            label="วันที่"
            required
            error={dateError}
            hint={
              endIso
                ? `ช่วงที่อนุญาต ${startIso} ถึง ${endIso}`
                : `ตั้งแต่ ${startIso} ถึงวันนี้`
            }
          >
            <Input
              type="date"
              value={workDate}
              min={startIso || undefined}
              max={maxIso}
              onChange={(e) => setWorkDate(e.target.value)}
              required
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="เวลาเข้า">
              <Input type="time" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
            </Field>
            <Field label="เวลาออก">
              <Input type="time" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
            </Field>
          </div>

          <p className="rounded-lg border border-border bg-secondary/50 px-3.5 py-2.5 text-xs text-muted-foreground">
            ระบบจะคำนวณเวลาทำงาน เวลามาสาย และ OT ให้เองตามนโยบายของวันที่เลือก
            ไม่ต้องกรอกเอง · ข้อมูลนี้จะไม่ถูกเขียนกลับไปยัง Google Sheets
          </p>

          <Field label="เหตุผล / หมายเหตุ" required hint="อย่างน้อย 3 ตัวอักษร เพื่อการตรวจสอบย้อนหลัง">
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="เช่น ลืมสแกนนิ้ว ยืนยันโดยหัวหน้างาน"
            />
          </Field>

          <Field label="บันทึกเพิ่มเติมในรายการ">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>

          {/* No end date means no boundary to validate against. Rather than
              inventing one, the decision is put to the operator explicitly. */}
          {needsConfirmation && (
            <label className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning-soft/60 px-3.5 py-2.5 text-sm text-warning-fg">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>
                พนักงานคนนี้ไม่มีวันที่สิ้นสุดการทำงานบันทึกไว้
                ข้าพเจ้ายืนยันว่าวันที่เลือกอยู่ในช่วงที่พนักงานยังทำงานจริง
              </span>
            </label>
          )}

          {error && (
            <div className="rounded-lg bg-danger-soft px-3.5 py-2.5 text-sm text-danger-fg">
              <p className="font-semibold">ไม่สามารถบันทึกวันมาทำงานได้</p>
              <p className="mt-0.5">{error}</p>
              {duplicateId && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => {
                    onClose();
                    navigate(`/attendance?recordId=${duplicateId}`);
                  }}
                >
                  ไปแก้ไขข้อมูลเดิม
                </Button>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              ยกเลิก
            </Button>
            <Button type="submit" disabled={!canSubmit} loading={mutation.isPending}>
              <CalendarPlus className="h-4 w-4" />
              บันทึกวันมาทำงาน
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
