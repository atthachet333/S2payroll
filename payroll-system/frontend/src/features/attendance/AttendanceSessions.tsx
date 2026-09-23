import * as React from 'react';
import { Info } from 'lucide-react';
import { Badge, Button, Dialog, DialogContent } from '@/components/ui';
import { formatMinutes, formatTime } from '@/utils/format';
import type { AttendanceRecord } from '@/types';

export default function AttendanceSessions({ record }: { record: AttendanceRecord }) {
  const [open, setOpen] = React.useState(false);
  const sessions = record.sessions ?? [];
  if (sessions.length <= 1 && !record.hasOpenSession && !record.malformedSequence) return null;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-1.5 text-xs"
        onClick={() => setOpen(true)}
        title="ดูรอบการทำงาน"
      >
        <Badge variant={record.hasOpenSession ? 'secondary' : 'outline'}>
          {record.sessionCount ?? sessions.length} รอบ
        </Badge>
        <Info className="h-3.5 w-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="รายละเอียดรอบการทำงาน" className="max-w-md">
          <div className="space-y-3">
            {sessions.map((session, index) => (
              <div key={`${session.checkInRawId ?? 'in'}-${session.checkOutRawId ?? index}`} className="rounded-lg border border-border p-3 text-sm">
                <p className="font-medium">รอบที่ {index + 1}</p>
                <p className="mt-1 tabular-nums">
                  {formatTime(session.checkIn)} → {session.checkOut ? formatTime(session.checkOut) : 'กำลังทำงาน'}
                </p>
                {session.checkIn && session.checkOut && (
                  <p className="mt-1 text-xs text-muted-foreground">{formatMinutes(session.workedMinutes)}</p>
                )}
              </div>
            ))}
            <div className="border-t border-border pt-3 text-sm">
              <div className="flex justify-between gap-4">
                <span>{record.hasOpenSession ? 'เวลาที่เสร็จแล้วรวม' : 'เวลาทำงานจริงรวม'}</span>
                <strong>{formatMinutes(record.completedWorkedMinutes ?? record.workedMinutes)}</strong>
              </div>
              {record.hasOpenSession && <p className="mt-2 text-info">ยังมีรอบที่กำลังทำงาน</p>}
              {record.attendanceIssues?.map((issue) => <p key={issue} className="mt-2 text-danger">ต้องตรวจสอบ: {issue}</p>)}
              {!record.hasOpenSession && record.dailyPay && record.dailyPay.status === 'CALCULATED' && (
                <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                  <p>หักพัก {formatMinutes(record.dailyPay.breakDeductionMinutes)}</p>
                  <p>ปัดออก {formatMinutes(record.dailyPay.roundedAwayMinutes)}</p>
                  <p>เวลาคิดเงิน {formatMinutes(record.dailyPay.payableMinutes)}</p>
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
