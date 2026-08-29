import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarClock, History, Pencil } from 'lucide-react';
import dayjs from 'dayjs';
import { attendanceApi, settingsApi } from '@/services/endpoints';
import { apiErrorMessage } from '@/services/api';
import { useAuth } from '@/features/auth/AuthContext';
import SyncPanel from '@/features/attendance/SyncPanel';
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  EmptyState,
  ErrorState,
  Field,
  Input,
  InfoRow,
  PageHeader,
  Pagination,
  Select,
  Separator,
  TableSkeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import { AttendanceStatusBadge } from '@/components/StatusBadge';
import { formatDate, formatDateTime, formatMinutes, formatNumber, formatTime } from '@/utils/format';
import type { AttendanceRecord } from '@/types';

export default function AttendancePage() {
  const { can } = useAuth();
  const [searchParams] = useSearchParams();

  const [page, setPage] = React.useState(1);
  const [from, setFrom] = React.useState(dayjs().startOf('month').format('YYYY-MM-DD'));
  const [to, setTo] = React.useState(dayjs().endOf('month').format('YYYY-MM-DD'));
  const [departmentId, setDepartmentId] = React.useState('');
  const [status, setStatus] = React.useState(searchParams.get('status') ?? '');
  const [search, setSearch] = React.useState('');
  const [editing, setEditing] = React.useState<AttendanceRecord | null>(null);

  React.useEffect(() => setPage(1), [from, to, departmentId, status, search]);

  const { data: departments = [] } = useQuery({
    queryKey: ['departments'],
    queryFn: settingsApi.listDepartments,
  });

  const summaryQuery = useQuery({
    queryKey: ['attendance-summary', from, to, departmentId],
    queryFn: () => attendanceApi.summary({ from, to, departmentId: departmentId || undefined }),
  });

  const query = useQuery({
    queryKey: ['attendance', page, from, to, departmentId, status, search],
    queryFn: () =>
      attendanceApi.list({
        page,
        pageSize: 25,
        from,
        to,
        departmentId: departmentId || undefined,
        status: status || undefined,
        search: search || undefined,
      }),
  });

  const summary = summaryQuery.data;

  return (
    <div>
      <PageHeader
        title="การลงเวลา"
        description="ข้อมูลเข้า-ออกงานที่นำเข้าจาก Google Sheets พร้อมการคำนวณชั่วโมงทำงานและ OT"
      />

      <Tabs defaultValue="records">
        <TabsList>
          <TabsTrigger value="records">บันทึกการลงเวลา</TabsTrigger>
          <TabsTrigger value="sync">นำเข้าข้อมูล (Google Sheets)</TabsTrigger>
        </TabsList>

        <TabsContent value="records" className="space-y-4">
          {summary && (
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <SummaryTile label="มาทำงาน" value={summary.present} tone="success" />
              <SummaryTile label="มาสาย" value={summary.late} tone="warning" />
              <SummaryTile label="ขาดงาน" value={summary.absent} tone="danger" />
              <SummaryTile label="ลา" value={summary.leave} />
              <SummaryTile label="ข้อมูลไม่ครบ" value={summary.missingData} tone="danger" />
              <div className="rounded-xl border border-border bg-card px-3.5 py-2.5">
                <p className="text-xs text-muted-foreground">ชั่วโมงทำงาน / OT</p>
                <p className="text-sm font-semibold tabular-nums">
                  {(summary.totalWorkedMinutes / 60).toFixed(1)} /{' '}
                  <span className="text-info">{(summary.totalOtMinutes / 60).toFixed(1)}</span>
                </p>
              </div>
            </div>
          )}

          <Card className="p-4">
            <div className="grid gap-3 md:grid-cols-5">
              <Field label="ตั้งแต่วันที่">
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label="ถึงวันที่">
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </Field>
              <Field label="แผนก">
                <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                  <option value="">ทุกแผนก</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="สถานะ">
                <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="">ทุกสถานะ</option>
                  <option value="NORMAL">ปกติ</option>
                  <option value="LATE">มาสาย</option>
                  <option value="OT">ทำ OT</option>
                  <option value="ABSENT">ขาดงาน</option>
                  <option value="MISSING_DATA">ข้อมูลไม่ครบ</option>
                  <option value="LEAVE">ลา</option>
                  <option value="HOLIDAY">วันหยุด</option>
                </Select>
              </Field>
              <Field label="ค้นหาพนักงาน">
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="รหัสหรือชื่อ"
                />
              </Field>
            </div>
          </Card>

          <Card className="overflow-hidden">
            {query.isLoading ? (
              <TableSkeleton rows={8} cols={8} />
            ) : query.isError ? (
              <ErrorState
                message={apiErrorMessage(query.error)}
                onRetry={() => void query.refetch()}
              />
            ) : query.data && query.data.items.length === 0 ? (
              <EmptyState
                icon={<CalendarClock className="h-6 w-6" />}
                title="ไม่พบข้อมูลการลงเวลา"
                description="ลองปรับช่วงวันที่ หรือนำเข้าข้อมูลจาก Google Sheets"
              />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>วันที่</th>
                        <th>รหัส</th>
                        <th>ชื่อ-นามสกุล</th>
                        <th>เข้า</th>
                        <th>ออก</th>
                        <th className="text-right">ทำงาน</th>
                        <th className="text-right">OT</th>
                        <th className="text-right">สาย</th>
                        <th>สถานะ</th>
                        <th className="w-[60px]" />
                      </tr>
                    </thead>
                    <tbody>
                      {query.data?.items.map((record) => (
                        <tr key={record.id}>
                          <td className="whitespace-nowrap">{formatDate(record.workDate)}</td>
                          <td className="font-medium">{record.employeeCode}</td>
                          <td>
                            {record.employee
                              ? `${record.employee.firstName} ${record.employee.lastName}`
                              : '-'}
                          </td>
                          <td className={record.isMissingCheckIn ? 'text-danger' : ''}>
                            {formatTime(record.checkIn)}
                          </td>
                          <td className={record.isMissingCheckOut ? 'text-danger' : ''}>
                            {formatTime(record.checkOut)}
                          </td>
                          <td className="num">{formatMinutes(record.workedMinutes)}</td>
                          <td className="num text-info">
                            {record.otMinutes > 0 ? formatMinutes(record.otMinutes) : '-'}
                          </td>
                          <td className="num text-warning">
                            {record.lateMinutes > 0 ? `${record.lateMinutes} น.` : '-'}
                          </td>
                          <td>
                            <div className="flex items-center gap-1.5">
                              <AttendanceStatusBadge status={record.status} />
                              {record.isCorrected && (
                                <Badge variant="outline" title="แก้ไขด้วยมือ">
                                  แก้ไขแล้ว
                                </Badge>
                              )}
                              {record.isLocked && <Badge variant="secondary">ล็อก</Badge>}
                            </div>
                          </td>
                          <td>
                            {can('attendance:write') && !record.isLocked && (
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setEditing(record)}
                                aria-label="แก้ไข"
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {query.data && (
                  <Pagination
                    page={query.data.page}
                    pageSize={query.data.pageSize}
                    total={query.data.total}
                    onPageChange={setPage}
                  />
                )}
              </>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="sync">
          <SyncPanel canSync={can('attendance:sync')} />
        </TabsContent>
      </Tabs>

      <CorrectionDialog record={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function SummaryTile({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}) {
  const toneClass = {
    default: 'text-foreground',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
  }[tone];

  return (
    <div className="rounded-xl border border-border bg-card px-3.5 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${toneClass}`}>{formatNumber(value)}</p>
    </div>
  );
}

/**
 * Manual correction. The original imported punches stay visible next to the
 * editable values, and a reason is mandatory so the audit trail is meaningful.
 */
function CorrectionDialog({
  record,
  onClose,
}: {
  record: AttendanceRecord | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [checkIn, setCheckIn] = React.useState('');
  const [checkOut, setCheckOut] = React.useState('');
  const [note, setNote] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ['attendance-detail', record?.id],
    queryFn: () => attendanceApi.get(record!.id),
    enabled: Boolean(record),
  });

  React.useEffect(() => {
    if (record) {
      setCheckIn(record.checkIn ? formatTime(record.checkIn) : '');
      setCheckOut(record.checkOut ? formatTime(record.checkOut) : '');
      setNote(record.note ?? '');
      setReason('');
      setError(null);
    }
  }, [record]);

  const mutation = useMutation({
    mutationFn: () =>
      attendanceApi.correct(record!.id, {
        checkIn: checkIn || null,
        checkOut: checkOut || null,
        note: note || null,
        reason,
      }),
    onSuccess: () => {
      toast.success('บันทึกการแก้ไขเรียบร้อยแล้ว');
      void queryClient.invalidateQueries({ queryKey: ['attendance'] });
      void queryClient.invalidateQueries({ queryKey: ['attendance-summary'] });
      onClose();
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const adjustments = detailQuery.data?.adjustments ?? [];

  return (
    <Dialog open={Boolean(record)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="แก้ไขข้อมูลการลงเวลา"
        description={
          record
            ? `${record.employeeCode} · ${formatDate(record.workDate)}`
            : undefined
        }
        className="max-h-[90vh] max-w-2xl overflow-y-auto"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (reason.trim().length < 3) {
              setError('กรุณาระบุเหตุผลอย่างน้อย 3 ตัวอักษร');
              return;
            }
            mutation.mutate();
          }}
          className="space-y-4"
        >
          <div className="rounded-lg bg-secondary/60 p-3.5">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              ข้อมูลต้นฉบับจาก Google Sheets (ไม่ถูกแก้ไข)
            </p>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-muted-foreground">เวลาเข้า: </span>
                <span className="font-medium tabular-nums">
                  {formatTime(record?.originalCheckIn)}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">เวลาออก: </span>
                <span className="font-medium tabular-nums">
                  {formatTime(record?.originalCheckOut)}
                </span>
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="เวลาเข้า (แก้ไขได้)" hint="รูปแบบ HH:mm เว้นว่างหากไม่มีการลงเวลา">
              <Input
                type="time"
                value={checkIn}
                onChange={(e) => setCheckIn(e.target.value)}
              />
            </Field>
            <Field label="เวลาออก (แก้ไขได้)" hint="รูปแบบ HH:mm เว้นว่างหากไม่มีการลงเวลา">
              <Input
                type="time"
                value={checkOut}
                onChange={(e) => setCheckOut(e.target.value)}
              />
            </Field>
          </div>

          <Field label="หมายเหตุ">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>

          <Field label="เหตุผลในการแก้ไข" required error={error}>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="เช่น พนักงานลืมสแกนออก ยืนยันโดยหัวหน้างาน"
            />
          </Field>

          {adjustments.length > 0 && (
            <>
              <Separator />
              <div>
                <p className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                  <History className="h-4 w-4" />
                  ประวัติการแก้ไข
                </p>
                <div className="max-h-40 space-y-2 overflow-y-auto">
                  {adjustments.map((adj) => (
                    <div key={adj.id} className="rounded-lg border border-border px-3 py-2 text-xs">
                      <div className="flex justify-between gap-2">
                        <span className="font-medium">{adj.fieldName}</span>
                        <span className="text-muted-foreground">
                          {formatDateTime(adj.changedAt)}
                        </span>
                      </div>
                      <p className="mt-1 text-muted-foreground">
                        {adj.oldValue ?? '(ว่าง)'} → {adj.newValue ?? '(ว่าง)'}
                      </p>
                      <p className="mt-0.5 italic text-muted-foreground">{adj.reason}</p>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          <Separator />
          <div className="divide-y divide-border/70">
            <InfoRow
              label="ชั่วโมงทำงานที่คำนวณได้"
              value={formatMinutes(record?.workedMinutes ?? 0)}
            />
            <InfoRow label="OT" value={formatMinutes(record?.otMinutes ?? 0)} />
            <InfoRow label="มาสาย" value={`${record?.lateMinutes ?? 0} นาที`} />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              ยกเลิก
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              บันทึกการแก้ไข
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
