import * as React from 'react';
import dayjs from 'dayjs';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Pencil } from 'lucide-react';
import { employeeApi } from '@/services/endpoints';
import { apiErrorMessage } from '@/services/api';
import { useAuth } from '@/features/auth/AuthContext';
import EmployeeFormDialog from '@/features/employees/EmployeeFormDialog';
import PayslipHistory from '@/features/payslips/PayslipHistory';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  InfoRow,
  PageHeader,
  Pagination,
  Select,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { EmployeeStatusBadge, EMPLOYMENT_TYPE_LABELS } from '@/components/StatusBadge';
import { formatDate, formatDateWithWeekday, formatMinutes, formatMoney, formatNumber, formatTime, thaiMonthName } from '@/utils/format';
import { AttendanceStatusBadge } from '@/components/StatusBadge';

export default function EmployeeDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [editOpen, setEditOpen] = React.useState(false);
  const [attendanceMonth, setAttendanceMonth] = React.useState(dayjs().month() + 1);
  const [attendanceYear, setAttendanceYear] = React.useState(dayjs().year());
  const [attendanceStatus, setAttendanceStatus] = React.useState('');
  const [attendancePage, setAttendancePage] = React.useState(1);

  const monthStart = dayjs(`${attendanceYear}-${String(attendanceMonth).padStart(2, '0')}-01`);

  const query = useQuery({
    queryKey: ['employee-summary', id, attendanceYear, attendanceMonth],
    queryFn: () => employeeApi.summary(id, { from: monthStart.format('YYYY-MM-DD'), to: monthStart.endOf('month').format('YYYY-MM-DD') }),
    enabled: Boolean(id),
  });
  const attendanceQuery = useQuery({
    queryKey: ['employee-attendance', id, attendanceYear, attendanceMonth, attendancePage, attendanceStatus],
    queryFn: () => employeeApi.attendance(id, { year: attendanceYear, month: attendanceMonth, page: attendancePage, pageSize: 31, status: attendanceStatus || undefined }),
    enabled: Boolean(id),
  });
  const payProfilesQuery = useQuery({
    queryKey: ['employee-pay-profiles', id],
    queryFn: () => employeeApi.payProfiles(id),
    enabled: Boolean(id),
  });

  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-[400px] rounded-xl" />
          <Skeleton className="h-[400px] rounded-xl lg:col-span-2" />
        </div>
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <Card>
        <ErrorState message={apiErrorMessage(query.error)} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  const { employee, attendance, payslips, payrollHistory } = query.data;
  const currentPayProfile = payProfilesQuery.data?.find((profile) => {
    const today = dayjs().startOf('day');
    return profile.isActive && !today.isBefore(dayjs(profile.effectiveFrom), 'day') &&
      (!profile.effectiveTo || !today.isAfter(dayjs(profile.effectiveTo), 'day'));
  });
  const paySource = currentPayProfile ? 'PAY_PROFILE' : Number(employee.baseSalary) > 0 ? 'LEGACY_BASE_SALARY' : 'UNCONFIGURED';

  return (
    <div>
      <button
        type="button"
        onClick={() => navigate('/employees')}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-primary"
      >
        <ArrowLeft className="h-4 w-4" />
        กลับไปยังรายชื่อพนักงาน
      </button>

      <PageHeader
        title={`${employee.firstName} ${employee.lastName}`}
        description={`${employee.employeeCode}${employee.nickname ? ` · ${employee.nickname}` : ''} · ${employee.department?.name ?? 'ไม่ระบุแผนก'}`}
        actions={
          <div className="flex items-center gap-2">
            <EmployeeStatusBadge status={employee.status} />
            {can('employee:write') && (
              <Button variant="outline" onClick={() => setEditOpen(true)}>
                <Pencil className="h-4 w-4" />
                แก้ไข
              </Button>
            )}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Personal information */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>ข้อมูลส่วนตัว</CardTitle>
          </CardHeader>
          <CardContent className="divide-y divide-border/70">
            <InfoRow label="รหัสพนักงาน" value={employee.employeeCode} />
            <InfoRow label="ชื่อเล่น" value={employee.nickname ?? '-'} />
            <InfoRow label="เลขบัตรประชาชน" value={employee.nationalId ?? '-'} />
            <InfoRow label="อีเมล" value={employee.email ?? '-'} />
            <InfoRow label="เบอร์โทรศัพท์" value={employee.phone ?? '-'} />
            <InfoRow label="แผนก" value={employee.department?.name ?? '-'} />
            <InfoRow label="ตำแหน่ง" value={employee.position?.name ?? '-'} />
            <InfoRow label="วันที่เริ่มงาน" value={formatDate(employee.startDate)} />
            <InfoRow
              label="วันที่สิ้นสุด"
              value={employee.endDate ? formatDate(employee.endDate) : '-'}
            />
          </CardContent>
        </Card>

        <div className="space-y-4 lg:col-span-2">
          {/* Payroll settings */}
          <Card>
            <CardHeader>
              <CardTitle>การตั้งค่าการจ่ายเงิน</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-x-8 sm:grid-cols-2">
              <div className="divide-y divide-border/70">
                <InfoRow
                  label="ประเภทการจ้าง"
                  value={EMPLOYMENT_TYPE_LABELS[employee.employmentType]}
                />
                <InfoRow label="สถานะค่าจ้าง" value={paySource === 'PAY_PROFILE' ? 'พร้อมใช้งาน' : paySource === 'LEGACY_BASE_SALARY' ? 'ข้อมูลเดิม — รอกำหนดวันที่เริ่มใช้' : 'ยังไม่ได้กำหนด'} />
                <InfoRow label={currentPayProfile?.payType === 'MONTHLY' || (!currentPayProfile && ['MONTHLY', 'CONTRACT'].includes(employee.employmentType)) ? 'เงินเดือนปัจจุบัน' : 'ค่าจ้างต่อชั่วโมงปัจจุบัน'} value={currentPayProfile ? `${formatMoney(currentPayProfile.payType === 'MONTHLY' ? currentPayProfile.monthlySalary : currentPayProfile.hourlyRate)} บาท${currentPayProfile.payType === 'MONTHLY' ? ' / เดือน' : ' / ชั่วโมง'}` : paySource === 'LEGACY_BASE_SALARY' ? `${formatMoney(employee.baseSalary)} บาท (ข้อมูลเดิม)` : '-'} />
                <InfoRow label="เริ่มใช้วันที่" value={currentPayProfile ? formatDate(currentPayProfile.effectiveFrom) : '-'} />
                <InfoRow label="ธนาคาร" value={employee.bankName ?? '-'} />
                <InfoRow label="เลขที่บัญชี" value={employee.bankAccount ?? '-'} />
              </div>
              <div className="divide-y divide-border/70">
                <InfoRow label="เลขประจำตัวผู้เสียภาษี" value={employee.taxId ?? '-'} />
                <InfoRow label="เลขที่ประกันสังคม" value={employee.socialSecurity ?? '-'} />
                <InfoRow label="หักประกันสังคม" value={employee.ssoEnabled ? 'ใช่' : 'ไม่'} />
                <InfoRow label="หักภาษี" value={employee.taxEnabled ? 'ใช่' : 'ไม่'} />
                <InfoRow label="มีสิทธิ์ OT" value={employee.otEligible ? 'ใช่' : 'ไม่'} />
                <InfoRow label="ต้องลงเวลา" value={employee.attendanceRequired ? 'ใช่' : 'ยกเว้น'} />
                <InfoRow label="ติดตามวันลา" value={employee.leaveTrackingRequired ? 'ใช่' : 'ยกเว้น'} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>ประวัติอัตราค่าจ้าง</CardTitle></CardHeader>
            <CardContent>
              {payProfilesQuery.data?.length ? <div className="overflow-x-auto"><table className="data-table"><thead><tr><th>รูปแบบ</th><th className="text-right">อัตรา</th><th>เริ่มใช้</th><th>สิ้นสุด</th><th>สถานะ</th></tr></thead><tbody>{payProfilesQuery.data.map((profile) => <tr key={profile.id}><td>{profile.payType === 'MONTHLY' ? 'รายเดือน' : 'คิดตามชั่วโมง'}</td><td className="num">{formatMoney(profile.payType === 'MONTHLY' ? profile.monthlySalary : profile.hourlyRate)}</td><td>{formatDate(profile.effectiveFrom)}</td><td>{profile.effectiveTo ? formatDate(profile.effectiveTo) : '-'}</td><td>{profile.isActive ? 'ใช้งาน' : 'ยกเลิก'}</td></tr>)}</tbody></table></div> : <EmptyState title="ยังไม่มีประวัติอัตราค่าจ้าง" description="กำหนดอัตราจริงได้จากหน้า ตั้งค่าเงินเดือน" />}
            </CardContent>
          </Card>

          {/* Attendance summary */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3"><CardTitle>สรุปการลงเวลา · {thaiMonthName(attendanceMonth)} {attendanceYear}</CardTitle><div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => { const prev=monthStart.subtract(1,'month'); setAttendanceYear(prev.year()); setAttendanceMonth(prev.month()+1); setAttendancePage(1); }}>ก่อนหน้า</Button><Button variant="outline" size="sm" onClick={() => { const next=monthStart.add(1,'month'); setAttendanceYear(next.year()); setAttendanceMonth(next.month()+1); setAttendancePage(1); }}>ถัดไป</Button></div></div>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MiniStat label="จำนวนวันที่บันทึก" value={formatNumber(attendance.totalRecords)} />
              <MiniStat label="ชั่วโมงทำงาน" value={formatMinutes(attendance.workedMinutes)} />
              <MiniStat label="ชั่วโมง OT" value={formatMinutes(attendance.otMinutes)} />
              <MiniStat label="เวลาที่มาสาย" value={formatMinutes(attendance.lateMinutes)} />
              <MiniStat
                label="มาสาย"
                value={`${formatNumber(attendance.statusCounts.LATE ?? 0)} ครั้ง`}
                tone="warning"
              />
              <MiniStat
                label="ขาดงาน"
                value={`${formatNumber(attendance.statusCounts.ABSENT ?? 0)} วัน`}
                tone="danger"
              />
              <MiniStat label="ลา" value={`${formatNumber(attendance.statusCounts.LEAVE ?? 0)} วัน`} />
              <MiniStat
                label="ข้อมูลไม่ครบ"
                value={`${formatNumber(attendance.statusCounts.MISSING_DATA ?? 0)} วัน`}
                tone="danger"
              />
            </CardContent>
          </Card>
        </div>
      </div>

      {/* History tabs */}
      <Card className="mt-4">
        <CardContent>
          <Tabs defaultValue="salary">
            <TabsList>
              <TabsTrigger value="salary">ประวัติเงินเดือน</TabsTrigger>
              <TabsTrigger value="payroll">ประวัติการคำนวณ</TabsTrigger>
              <TabsTrigger value="payslips">สลิปเงินเดือน</TabsTrigger>
              <TabsTrigger value="attendance">ประวัติลงเวลา</TabsTrigger>
            </TabsList>

            <TabsContent value="salary">
              {!employee.salaryHistory || employee.salaryHistory.length === 0 ? (
                <EmptyState title="ยังไม่มีประวัติการปรับเงินเดือน" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>มีผลวันที่</th>
                        <th className="text-right">เงินเดือนเดิม</th>
                        <th className="text-right">เงินเดือนใหม่</th>
                        <th className="text-right">เปลี่ยนแปลง</th>
                        <th>เหตุผล</th>
                      </tr>
                    </thead>
                    <tbody>
                      {employee.salaryHistory.map((h) => {
                        const diff = Number(h.newSalary) - Number(h.previousSalary);
                        return (
                          <tr key={h.id}>
                            <td>{formatDate(h.effectiveDate)}</td>
                            <td className="num">{formatMoney(h.previousSalary)}</td>
                            <td className="num font-medium">{formatMoney(h.newSalary)}</td>
                            <td
                              className={`num font-medium ${diff >= 0 ? 'text-success' : 'text-danger'}`}
                            >
                              {diff >= 0 ? '+' : ''}
                              {formatMoney(diff)}
                            </td>
                            <td className="text-muted-foreground">{h.reason ?? '-'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </TabsContent>

            <TabsContent value="payroll">
              {payrollHistory.length === 0 ? (
                <EmptyState title="ยังไม่มีประวัติการคำนวณเงินเดือน" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>รอบเงินเดือน</th>
                        <th className="text-right">ชั่วโมงทำงาน</th>
                        <th className="text-right">OT</th>
                        <th className="text-right">รายได้รวม</th>
                        <th className="text-right">รายการหัก</th>
                        <th className="text-right">เงินสุทธิ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payrollHistory.map((row) => (
                        <tr key={row.id}>
                          <td className="font-medium">{row.period.name}</td>
                          <td className="num">{formatNumber(row.workingHours, 2)}</td>
                          <td className="num">{formatNumber(row.otHours, 2)}</td>
                          <td className="num">{formatMoney(row.grossIncome)}</td>
                          <td className="num text-danger">{formatMoney(row.totalDeduction)}</td>
                          <td className="num font-semibold">{formatMoney(row.netSalary)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </TabsContent>

            <TabsContent value="payslips">
              <PayslipHistory payslips={payslips} />
            </TabsContent>
            <TabsContent value="attendance">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><p className="text-sm font-medium">วันที่ทำงานจริง · {thaiMonthName(attendanceMonth)} {attendanceYear}</p><Select className="w-44" value={attendanceStatus} onChange={(e) => { setAttendanceStatus(e.target.value); setAttendancePage(1); }}><option value="">ทุกสถานะ</option><option value="NORMAL">มาทำงาน</option><option value="LATE">มาสาย</option><option value="LEAVE">ลา</option><option value="MISSING_DATA">ข้อมูลไม่ครบ</option><option value="ABSENT">ขาดงาน</option></Select></div>
              {attendanceQuery.data?.items.length ? <><div className="overflow-x-auto"><table className="data-table"><thead><tr><th>วันที่</th><th>เข้า</th><th>ออก</th><th className="text-right">ชั่วโมงทำงาน</th><th className="text-right">สาย</th><th>สถานะ</th></tr></thead><tbody>{attendanceQuery.data.items.map((row) => <tr key={row.id}><td className="whitespace-nowrap">{formatDateWithWeekday(row.workDate)}</td><td>{formatTime(row.checkIn)}</td><td>{formatTime(row.checkOut)}</td><td className="num">{formatMinutes(row.workedMinutes)}</td><td className="num">{employee.employmentType === 'DAILY' || !row.lateMinutes ? '-' : `${row.lateMinutes} นาที`}</td><td><AttendanceStatusBadge status={row.status} /></td></tr>)}</tbody></table></div><Pagination page={attendanceQuery.data.page} pageSize={attendanceQuery.data.pageSize} total={attendanceQuery.data.total} onPageChange={setAttendancePage}/></> : <EmptyState title="ไม่พบประวัติการลงเวลาในเดือนนี้" />}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <EmployeeFormDialog open={editOpen} onOpenChange={setEditOpen} employee={employee} />
    </div>
  );
}

function MiniStat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'warning' | 'danger';
}) {
  const toneClass = {
    default: 'text-foreground',
    warning: 'text-warning',
    danger: 'text-danger',
  }[tone];

  return (
    <div className="rounded-lg border border-border px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-sm font-semibold tabular-nums ${toneClass}`}>{value}</p>
    </div>
  );
}
