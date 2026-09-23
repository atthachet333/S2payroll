import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarClock, ChevronLeft, ChevronRight, History, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import dayjs from 'dayjs';
import { attendanceApi, settingsApi, POLL_INTERVAL_MS } from '@/services/endpoints';
import { apiErrorMessage } from '@/services/api';
import { useAuth } from '@/features/auth/AuthContext';
import SyncPanel from '@/features/attendance/SyncPanel';
import AutoSyncStatus from '@/features/attendance/AutoSyncStatus';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
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
import DailyPayCell from '@/features/attendance/DailyPayCell';
import AttendanceSessions from '@/features/attendance/AttendanceSessions';
import { AttendanceStatusBadge } from '@/components/StatusBadge';
import { formatDate, formatDateTime, formatDateWithWeekday, formatMinutes, formatNumber, formatTime, thaiMonthName } from '@/utils/format';
import type { AttendanceRecord, AttendanceSummary } from '@/types';

/**
 * Shortcuts onto the status filter. Counts come from the same summary the
 * cards use, so a chip can never disagree with the card above it.
 */
const QUICK_STATUS_FILTERS: Array<{
  label: string;
  value: string;
  count?: (s: AttendanceSummary) => number;
}> = [
  { label: 'ทั้งหมด', value: '' },
  { label: 'ข้อมูลไม่ครบ', value: 'MISSING_DATA', count: (s) => s.missingData },
  { label: 'มาสาย', value: 'LATE', count: (s) => s.late },
  { label: 'ลา', value: 'LEAVE', count: (s) => s.leave },
  { label: 'ปกติ', value: 'NORMAL' },
];

export default function AttendancePage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();

  const [page, setPage] = React.useState(1);
  const [from, setFrom] = React.useState(dayjs().startOf('month').format('YYYY-MM-DD'));
  const [to, setTo] = React.useState(dayjs().endOf('month').format('YYYY-MM-DD'));
  const [departmentId, setDepartmentId] = React.useState('');
  const [status, setStatus] = React.useState(searchParams.get('status') ?? '');
  const [employmentType, setEmploymentType] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [editing, setEditing] = React.useState<AttendanceRecord | null>(null);
  const [deleting, setDeleting] = React.useState<AttendanceRecord | null>(null);
  const [recalcOpen, setRecalcOpen] = React.useState(false);
  const [calendarMonth, setCalendarMonth] = React.useState(dayjs().startOf('month'));

  React.useEffect(() => setPage(1), [from, to, departmentId, status, employmentType, search]);

  const { data: departments = [] } = useQuery({
    queryKey: ['departments'],
    queryFn: settingsApi.listDepartments,
  });

  const summaryQuery = useQuery({
    queryKey: ['attendance-summary', from, to, departmentId],
    queryFn: () => attendanceApi.summary({ from, to, departmentId: departmentId || undefined }),
    refetchInterval: POLL_INTERVAL_MS.attendance,
  });

  const query = useQuery({
    queryKey: ['attendance', page, from, to, departmentId, status, employmentType, search],
    queryFn: () =>
      attendanceApi.list({
        page,
        pageSize: 25,
        from,
        to,
        departmentId: departmentId || undefined,
        status: status || undefined,
        employmentType: employmentType || undefined,
        search: search || undefined,
      }),
    // Background refresh keeps the current page and filters; placeholderData
    // stops the table blanking between polls.
    refetchInterval: POLL_INTERVAL_MS.attendance,
    placeholderData: (previous) => previous,
  });

  const summary = summaryQuery.data;

  const recalcMutation = useMutation({
    mutationFn: () => attendanceApi.recalculate(from, to),
    onSuccess: (result) => {
      setRecalcOpen(false);
      toast.success(`คำนวณใหม่ ${result.updated} รายการ${result.skippedLocked ? ` · ข้ามรายการล็อก ${result.skippedLocked}` : ''}`);
      void queryClient.invalidateQueries({ queryKey: ['attendance'] });
      void queryClient.invalidateQueries({ queryKey: ['attendance-summary'] });
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });

  return (
    <div>
      <PageHeader
        title="การลงเวลา"
        description="ข้อมูลเข้า-ออกงานที่นำเข้าจาก Google Sheets พร้อมการคำนวณชั่วโมงทำงานและ OT"
        actions={<AutoSyncStatus canSync={can('attendance:sync')} />}
      />

      <Tabs defaultValue="records">
        <TabsList>
          <TabsTrigger value="calendar">ปฏิทินการทำงาน</TabsTrigger>
          <TabsTrigger value="records">บันทึกการลงเวลา</TabsTrigger>
          <TabsTrigger value="sync">นำเข้าข้อมูล (Google Sheets)</TabsTrigger>
        </TabsList>

        <TabsContent value="calendar">
          <WorkCalendar month={calendarMonth} onMonthChange={setCalendarMonth} />
        </TabsContent>

        <TabsContent value="records" className="space-y-4">
          {/* One uniform tile shape across the row, so the strip reads as a
              single block instead of five chips plus an odd panel. */}
          {summary && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">สรุปนี้ไม่นับรวมพนักงานที่ได้รับการยกเว้นการลงเวลา</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
              <SummaryTile label="มาทำงาน" value={summary.present} tone="success" />
              <SummaryTile label="มาสาย" value={summary.late} tone="warning" />
              <SummaryTile label="ขาดงาน" value={summary.absent} tone="danger" />
              <SummaryTile label="ลา" value={summary.leave} />
              <SummaryTile label="ข้อมูลไม่ครบ" value={summary.missingData} tone="danger" />
              <SummaryTile
                label="ชั่วโมงทำงาน / OT"
                value={`${(summary.totalWorkedMinutes / 60).toFixed(1)} / ${(summary.totalOtMinutes / 60).toFixed(1)}`}
                tone="info"
              />
              </div>
            </div>
          )}

          <Card className="p-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
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
              <Field label="ประเภทพนักงาน">
                <Select
                  value={employmentType}
                  onChange={(e) => setEmploymentType(e.target.value)}
                >
                  <option value="">ทุกประเภท</option>
                  <option value="MONTHLY">รายเดือน</option>
                  <option value="DAILY">รายวัน</option>
                  <option value="HOURLY">รายชั่วโมง</option>
                  <option value="CONTRACT">สัญญาจ้าง</option>
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

            {/* Attendance rows store values derived at import time. A settings
                change therefore does nothing to an already-imported month until
                the range is recomputed - which previously had no trigger in the
                UI at all, so saved settings looked like they never applied. */}
            {can('attendance:write') && (
              <>
                <Separator className="my-4" />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    หากเพิ่งแก้ไขกฎการคำนวณในหน้าตั้งค่า
                    กดคำนวณใหม่เพื่อปรับสถานะและชั่วโมงของช่วงวันที่นี้ให้ตรงกับการตั้งค่าปัจจุบัน
                    (ข้อมูลที่แก้ไขด้วยมือและรอบที่ล็อกแล้วจะไม่ถูกเปลี่ยน)
                  </p>
                  <div className="ml-auto flex flex-wrap gap-2">
                    <Button variant="ghost" size="sm" onClick={() => { void query.refetch(); void summaryQuery.refetch(); }}>
                      <RefreshCw className="h-4 w-4" /> รีเฟรช
                    </Button>
                    <Button variant="outline" size="sm" loading={recalcMutation.isPending} onClick={() => setRecalcOpen(true)}>
                      <RefreshCw className="h-4 w-4" /> คำนวณใหม่ตามการตั้งค่า
                    </Button>
                  </div>
                </div>
              </>
            )}
          </Card>

          {/* Quick chips are a shortcut onto the existing status filter, not a
              second source of truth - they set the same state the Select uses,
              so the two can never disagree. */}
          <div className="flex flex-wrap items-center gap-2">
            {QUICK_STATUS_FILTERS.map((quick) => {
              const active = status === quick.value;
              return (
                <button
                  key={quick.label}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setStatus(quick.value)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    active
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground'
                  }`}
                >
                  {quick.label}
                  {quick.count !== undefined && summary ? ` (${quick.count(summary)})` : ''}
                </button>
              );
            })}
          </div>

          <Card className="overflow-hidden">
            {query.isLoading ? (
              <TableSkeleton rows={8} cols={12} />
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
                <div className="max-w-full overflow-x-auto overscroll-x-contain">
                  <table className="data-table attendance-table min-w-[1236px] xl:min-w-full">
                    <colgroup>
                      <col className="w-[150px]" />
                      <col className="w-[90px]" />
                      <col />
                      <col className="w-[120px]" />
                      <col className="w-[75px]" />
                      <col className="w-[75px]" />
                      <col className="w-[130px]" />
                      <col className="w-[110px]" />
                      <col className="w-[100px]" />
                      <col className="w-[110px]" />
                      <col className="w-[110px]" />
                      <col className="w-[56px]" />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>วันที่</th>
                        <th>รหัส</th>
                        <th>ชื่อ-นามสกุล</th>
                        <th>ประเภทพนักงาน</th>
                        <th>เข้า</th>
                        <th>ออก</th>
                        <th className="text-right">ทำงาน</th>
                        <th className="text-right">OT</th>
                        <th className="text-right">สาย</th>
                        <th>สถานะ</th>
                        <th className="text-right">ได้เงินวันนี้</th>
                        <th className="text-center"><span className="sr-only">จัดการ</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {query.data?.items.map((record) => (
                        <tr key={record.id}>
                          <td className="whitespace-nowrap">{formatDateWithWeekday(record.workDate)}</td>
                          <td className="whitespace-nowrap font-medium">{record.employeeCode}</td>
                          <td className="min-w-[220px] xl:min-w-0">
                            <span className="block truncate">
                              {record.employee
                                ? `${record.employee.firstName} ${record.employee.lastName}`
                                : '-'}
                            </span>
                          </td>
                          <td className="whitespace-nowrap"><EmploymentTypeBadge type={record.employee?.employmentType} /></td>
                          <td className={`whitespace-nowrap tabular-nums ${record.isMissingCheckIn ? 'text-danger' : ''}`}>
                            <div className="flex items-center gap-1">
                              {formatTime(record.checkIn)}
                              <AttendanceSessions record={record} />
                            </div>
                          </td>
                          <td className={`whitespace-nowrap tabular-nums ${record.isMissingCheckOut ? 'text-danger' : ''}`}>
                            {formatTime(record.checkOut)}
                          </td>
                          <td className="num">
                            {formatMinutes(record.completedWorkedMinutes ?? record.workedMinutes)}
                            {record.hasOpenSession && <span className="ml-1 text-info">+ กำลังทำงาน</span>}
                          </td>
                          <td className="num text-info">
                            {record.otMinutes > 0 ? formatMinutes(record.otMinutes) : '-'}
                          </td>
                          <td className="num text-warning">
                            {record.employee?.employmentType !== 'DAILY' && record.lateMinutes > 0
                              ? `${record.lateMinutes} นาที`
                              : '-'}
                          </td>
                          <td className="whitespace-nowrap">
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
                          <td className="num">
                            <DailyPayCell dailyPay={record.dailyPay} />
                          </td>
                          <td className="text-center">
                            {can('attendance:write') && !record.isLocked && (
                              <div className="flex items-center justify-center gap-0.5">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => setEditing(record)}
                                  aria-label="แก้ไข"
                                  title="แก้ไข"
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="text-danger hover:bg-danger-soft"
                                  onClick={() => setDeleting(record)}
                                  aria-label="ลบ"
                                  title="ลบ"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
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
      <DeleteAttendanceDialog record={deleting} onClose={() => setDeleting(null)} />
      <ConfirmDialog
        open={recalcOpen}
        onOpenChange={setRecalcOpen}
        title="คำนวณข้อมูลการลงเวลาใหม่"
        description={`ระบบจะคำนวณชั่วโมงทำงาน OT เวลาสาย และสถานะใหม่สำหรับ ${from} ถึง ${to} โดยใช้ค่าตั้งค่าปัจจุบัน ข้อมูลต้นฉบับและเวลาที่แก้ไขด้วยมือจะไม่ถูกเปลี่ยน และรายการในรอบที่ล็อกจะถูกข้าม`}
        confirmLabel="คำนวณใหม่"
        loading={recalcMutation.isPending}
        onConfirm={() => recalcMutation.mutate()}
      />
    </div>
  );
}

function WorkCalendar({ month, onMonthChange }: { month: dayjs.Dayjs; onMonthChange: (month: dayjs.Dayjs) => void }) {
  const query = useQuery({
    queryKey: ['work-calendar', month.year(), month.month() + 1],
    queryFn: () => attendanceApi.calendar(month.year(), month.month() + 1),
    refetchInterval: POLL_INTERVAL_MS.calendar,
    placeholderData: (previous) => previous,
  });
  const data = query.data;
  const leading = data?.days.length ? (dayjs(data.days[0].date).day() + 6) % 7 : 0;
  const [selectedDate, setSelectedDate] = React.useState<string | null>(null);
  const onSelectDate = setSelectedDate;

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex items-center justify-between gap-3">
          <Button variant="outline" size="icon" onClick={() => onMonthChange(month.subtract(1, 'month'))} aria-label="เดือนก่อนหน้า">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="text-center">
            <div className="text-lg font-semibold">{thaiMonthName(month.month() + 1)} {month.year()}</div>
            <div className="text-xs text-muted-foreground">วันทำงาน จันทร์–เสาร์ · วันอาทิตย์เป็นวันหยุดประจำสัปดาห์</div>
          </div>
          <Button variant="outline" size="icon" onClick={() => onMonthChange(month.add(1, 'month'))} aria-label="เดือนถัดไป">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </Card>

      {query.isLoading ? <TableSkeleton rows={5} cols={7} /> : query.isError ? (
        <ErrorState message={apiErrorMessage(query.error)} onRetry={() => void query.refetch()} />
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <SummaryTile label="วันทำงานตามตาราง" value={data.summary.scheduledWorkingDays} tone="info" />
            <SummaryTile label="ทำงานผ่านมาแล้ว" value={data.summary.elapsedWorkingDays} />
            <SummaryTile label="วันทำงานคงเหลือ" value={data.summary.remainingWorkingDays} tone="success" />
            <SummaryTile label="วันหยุดประจำสัปดาห์" value={data.summary.weeklyOffDays} />
            <SummaryTile label="วันหยุดราชการ" value={data.summary.publicHolidays} tone="danger" />
            <SummaryTile label="วันหยุดบริษัท" value={data.summary.companyHolidays} tone="warning" />
          </div>
          <Card className="overflow-hidden p-3">
            <div className="grid grid-cols-7 text-center text-xs font-medium text-muted-foreground">
              {['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.'].map((label) => <div key={label} className="py-2">{label}</div>)}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {Array.from({ length: leading }).map((_, index) => <div key={`blank-${index}`} className="min-h-24" />)}
              {/* The base day type carries the cell colour; activity is shown as
                  small counters rather than by flooding the cell, so a busy day
                  stays as readable as a quiet one. */}
              {data.days.map((day) => (
                <button
                  key={day.date}
                  type="button"
                  onClick={() => onSelectDate(day.date)}
                  aria-label={`ดูรายละเอียดวันที่ ${day.date}`}
                  className={`min-h-24 rounded-lg border p-2 text-left transition-colors ${day.dayType === 'WEEKLY_OFF' ? 'border-transparent bg-muted/60 text-muted-foreground' : day.dayType === 'PUBLIC_HOLIDAY' || day.dayType === 'HOLIDAY' ? 'border-rose-200 bg-rose-50' : day.dayType === 'COMPANY_HOLIDAY' ? 'border-indigo-200 bg-indigo-50' : 'border-border bg-background'} ${day.isToday ? 'ring-2 ring-info ring-offset-1' : ''} hover:border-primary/50 hover:bg-primary/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
                >
                  <div className="flex items-start justify-between gap-1">
                    <span className="font-semibold">{dayjs(day.date).date()}</span>
                    {day.isToday && <span className="text-[10px] font-medium text-info">วันนี้</span>}
                  </div>
                  <div className="mt-2 space-y-1 text-[10px] leading-tight">
                    {day.dayType === 'WEEKLY_OFF' && <div>วันหยุด</div>}
                    {day.holidayName && <div className={day.dayType === 'PUBLIC_HOLIDAY' ? 'text-rose-700' : 'text-indigo-700'}>{day.holidayName}</div>}
                    {day.summaryCount > 0 && (
                      <div className="text-foreground/80">📝 {day.summaryCount} รายงาน</div>
                    )}
                    {day.lateCount > 0 && (
                      <div className="font-medium text-warning-fg">🟡 สาย {day.lateCount}</div>
                    )}
                    {day.leaveCount > 0 && (
                      <div className="font-medium text-danger">🔴 ลา {day.leaveCount}</div>
                    )}
                    {day.payrollPeriods.length > 0 && (
                      <div className="text-muted-foreground">• อยู่ในรอบเงินเดือน</div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </Card>
        </>
      ) : null}

      <CalendarDayDialog date={selectedDate} onClose={() => setSelectedDate(null)} />
    </div>
  );
}

/**
 * Per-day detail. Fetched only when a day is opened, so the polled month view
 * never carries every employee's checkout prose.
 */
function CalendarDayDialog({ date, onClose }: { date: string | null; onClose: () => void }) {
  const query = useQuery({
    queryKey: ['calendar-day', date],
    queryFn: () => attendanceApi.dayDetail(date!),
    enabled: Boolean(date),
  });
  const detail = query.data;

  return (
    <Dialog open={Boolean(date)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={date ? `รายละเอียดวันที่ ${formatDateWithWeekday(date)}` : undefined}
        className="max-h-[85vh] max-w-2xl overflow-y-auto"
      >
        {query.isLoading ? (
          <TableSkeleton rows={4} cols={1} />
        ) : query.isError ? (
          <ErrorState message={apiErrorMessage(query.error)} onRetry={() => void query.refetch()} />
        ) : detail ? (
          <div className="space-y-5">
            <section className="rounded-lg border border-border bg-secondary/40 px-3.5 py-3">
              <p className="text-xs text-muted-foreground">ประเภทวัน</p>
              <p className="mt-0.5 text-sm font-semibold">
                {detail.dayType === 'PUBLIC_HOLIDAY' ? 'วันหยุดราชการ' : detail.dayType === 'COMPANY_HOLIDAY' || detail.dayType === 'HOLIDAY' ? 'วันหยุดบริษัท' : detail.dayType === 'WEEKLY_OFF' ? 'วันหยุดประจำสัปดาห์' : 'วันทำงาน'}
              </p>
              {detail.holidayName && <p className="mt-1 text-sm text-muted-foreground">{detail.holidayName}</p>}
              {detail.holidayNote && <p className="mt-1 text-xs text-muted-foreground">{detail.holidayNote}</p>}
            </section>
            {/* --- A: employee work summaries --- */}
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">
                สรุปงานพนักงาน
                {detail.counts.summaryCount > 0 && (
                  <span className="ml-2 font-normal text-muted-foreground">
                    พนักงานส่งสรุปงาน {detail.counts.summaryCount} คน
                  </span>
                )}
              </h3>
              {detail.summaries.length === 0 ? (
                <p className="text-sm text-muted-foreground">ไม่มีสรุปงาน</p>
              ) : (
                detail.summaries.map((s) => (
                  <div key={s.eventId} className="rounded-lg border border-border px-3.5 py-2.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm font-medium">
                        {s.employeeCode} — {s.employeeName ?? '-'}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        เวลาออก: {s.checkOutTime || '-'}
                      </span>
                    </div>
                    {/* Employee prose, shown exactly as typed. */}
                    <p className="mt-1.5 whitespace-pre-wrap text-sm text-muted-foreground">
                      {s.text}
                    </p>
                  </div>
                ))
              )}
            </section>

            {/* --- B: late employees --- */}
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">พนักงานมาสาย</h3>
              {detail.late.length === 0 ? (
                <p className="text-sm text-muted-foreground">ไม่มีพนักงานมาสาย</p>
              ) : (
                detail.late.map((l) => (
                  <div
                    key={l.employeeCode}
                    className="rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-2.5"
                  >
                    <div className="text-sm font-medium text-warning-fg">
                      {l.employeeCode} — {l.employeeName}
                    </div>
                    <div className="mt-0.5 text-xs text-warning-fg/90">
                      เข้า {l.checkIn ?? '-'} · สาย {l.lateMinutes} นาที
                    </div>
                  </div>
                ))
              )}
            </section>

            {/* --- C: approved leave --- */}
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">พนักงานลา</h3>
              {detail.leaves.length === 0 ? (
                <p className="text-sm text-muted-foreground">ไม่มีพนักงานลา</p>
              ) : (
                detail.leaves.map((v) => (
                  <div
                    key={`${v.employeeCode}-${v.startDate}`}
                    className="rounded-lg border border-danger/30 bg-danger-soft px-3.5 py-2.5"
                  >
                    <div className="text-sm font-medium text-danger">
                      {v.employeeCode} — {v.employeeName} · {LEAVE_TYPE_LABELS[v.leaveType] ?? v.leaveType}
                    </div>
                    {v.startDate !== v.endDate && (
                      <div className="mt-0.5 text-xs text-danger/90">
                        {v.startDate} ถึง {v.endDate}
                      </div>
                    )}
                    {v.reason && (
                      <div className="mt-0.5 text-xs text-danger/90">เหตุผล: {v.reason}</div>
                    )}
                  </div>
                ))
              )}
            </section>

            {detail.suppressedSummaries.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-muted-foreground">
                  สรุปงานของวันที่ถูกลบออกจากระบบ ({detail.suppressedSummaries.length})
                </h3>
                <p className="text-xs text-muted-foreground">
                  เก็บไว้เป็นหลักฐานต้นทางเท่านั้น ไม่นับรวมในสถิติการลงเวลา
                </p>
                {detail.suppressedSummaries.map((s) => (
                  <div key={s.eventId} className="rounded-lg border border-dashed border-border px-3.5 py-2.5 opacity-70">
                    <div className="text-sm font-medium">
                      {s.employeeCode} — {s.employeeName ?? '-'} · {s.checkOutTime || '-'}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{s.text}</p>
                  </div>
                ))}
              </section>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const LEAVE_TYPE_LABELS: Record<string, string> = {
  ANNUAL: 'ลาพักร้อน',
  SICK: 'ลาป่วย',
  PERSONAL: 'ลากิจ',
  MATERNITY: 'ลาคลอด',
  UNPAID: 'ลาไม่รับค่าจ้าง',
  OTHER: 'ลาอื่น ๆ',
};

function EmploymentTypeBadge({ type }: { type?: string }) {
  const labels: Record<string, string> = {
    MONTHLY: 'รายเดือน', DAILY: 'รายวัน', HOURLY: 'รายชั่วโมง', CONTRACT: 'สัญญาจ้าง',
  };
  return <Badge variant="outline">{type ? labels[type] ?? type : '-'}</Badge>;
}

function SummaryTile({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  /** A pre-formatted string is allowed so the hours tile matches the others. */
  value: number | string;
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'info';
}) {
  const toneClass = {
    default: 'text-foreground',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
    info: 'text-info',
  }[tone];

  return (
    <div className="rounded-xl border border-border bg-card px-3.5 py-2.5">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${toneClass}`}>
        {typeof value === 'number' ? formatNumber(value) : value}
      </p>
    </div>
  );
}

/**
 * Manual correction. The original imported punches stay visible next to the
 * editable values, and a reason is mandatory so the audit trail is meaningful.
 */
/**
 * Deleting a day removes it from the payroll system only. The Google Sheet is
 * the source of truth and is read-only, so the dialog says plainly that the
 * source row survives, and the deletion is recorded as a suppression to stop
 * the next sync quietly putting the day back.
 */
function DeleteAttendanceDialog({
  record,
  onClose,
}: {
  record: AttendanceRecord | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setReason('');
    setError(null);
  }, [record]);

  const mutation = useMutation({
    mutationFn: () => attendanceApi.remove(record!.id, reason.trim()),
    onSuccess: () => {
      toast.success('ลบบันทึกการลงเวลาแล้ว และจะไม่ถูกนำเข้าซ้ำจากการซิงก์');
      void queryClient.invalidateQueries({ queryKey: ['attendance'] });
      void queryClient.invalidateQueries({ queryKey: ['attendance-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['work-calendar'] });
      onClose();
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const employeeName = record?.employee
    ? `${record.employee.firstName} ${record.employee.lastName}`.trim()
    : '-';

  return (
    <Dialog open={Boolean(record)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent title="ลบบันทึกการลงเวลา?" className="max-w-lg">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (reason.trim().length < 3) {
              setError('กรุณาระบุเหตุผลในการลบอย่างน้อย 3 ตัวอักษร');
              return;
            }
            mutation.mutate();
          }}
          className="space-y-4"
        >
          <div className="divide-y divide-border/70 rounded-lg border border-border">
            <InfoRow label="พนักงาน" value={`${record?.employeeCode ?? '-'} · ${employeeName}`} />
            <InfoRow label="วันที่" value={record ? formatDate(record.workDate) : '-'} />
            <InfoRow label="เวลาเข้า" value={formatTime(record?.checkIn)} />
            <InfoRow label="เวลาออก" value={formatTime(record?.checkOut)} />
          </div>

          <p className="rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-sm text-warning-fg">
            การลบนี้จะลบข้อมูลการลงเวลาที่ใช้ในระบบ Payroll เท่านั้น
            และจะไม่ลบข้อมูลต้นทางใน Google Sheet
          </p>

          <Field label="เหตุผลในการลบ" required error={error}>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="เช่น เป็นข้อมูลทดสอบ หรือพนักงานสแกนผิดวัน"
            />
          </Field>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={onClose}>
              ยกเลิก
            </Button>
            <Button
              type="submit"
              className="bg-danger text-white hover:bg-danger/90"
              loading={mutation.isPending}
            >
              <Trash2 className="h-4 w-4" />
              ลบบันทึก
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

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
                        <span className="text-foreground/70">ข้อมูลเดิม</span>{' '}
                        {adj.oldValue ?? '(ว่าง)'} →{' '}
                        <span className="text-foreground/70">ข้อมูลหลังแก้</span>{' '}
                        {adj.newValue ?? '(ว่าง)'}
                      </p>
                      <p className="mt-0.5 italic text-muted-foreground">{adj.reason}</p>
                      <p className="mt-0.5 text-muted-foreground">
                        ผู้แก้ไข: {adj.changedByName ?? 'ไม่ทราบผู้ใช้'}
                      </p>
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
            <InfoRow
              label="มาสาย"
              value={record?.employee?.employmentType === 'DAILY' ? '-' : `${record?.lateMinutes ?? 0} นาที`}
            />
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
