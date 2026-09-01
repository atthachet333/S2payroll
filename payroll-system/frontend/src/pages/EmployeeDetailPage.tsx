import * as React from 'react';
import dayjs from 'dayjs';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Pencil } from 'lucide-react';
import { employeeApi } from '@/services/endpoints';
import { apiErrorMessage } from '@/services/api';
import { useAuth } from '@/features/auth/AuthContext';
import EmployeeFormDialog from '@/features/employees/EmployeeFormDialog';
import MonthSelector, {
  currentBangkokMonth,
  previousMonth,
  type MonthValue,
} from '@/features/employees/MonthSelector';
import { DailyPayCell } from '@/features/attendance/DailyPayCell';
import { monthRange } from '@/utils/bangkok';
import PayslipHistory from '@/features/payslips/PayslipHistory';
import {
  PayrollPolicySummary,
  derivedBases,
} from '@/features/employees/PayrollSettingsFields';
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
  TableSkeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { EmployeeStatusBadge, EMPLOYMENT_TYPE_LABELS } from '@/components/StatusBadge';
import { formatDate, formatDateWithWeekday, formatMinutes, formatMoney, formatNumber, formatTime, thaiMonthName } from '@/utils/format';
import { AttendanceStatusBadge } from '@/components/StatusBadge';
import type { DailyEarnings } from '@/types';

export default function EmployeeDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [editOpen, setEditOpen] = React.useState(false);
  // One piece of state drives every time-based section on this page, so moving
  // between the history tabs keeps whichever month the user chose. Defaulted
  // from company time rather than the browser's, which on the first of a month
  // would otherwise open on the wrong one.
  const [selectedMonth, setSelectedMonth] = React.useState<MonthValue>(currentBangkokMonth);
  const attendanceYear = selectedMonth.year;
  const attendanceMonth = selectedMonth.month;
  const [attendanceStatus, setAttendanceStatus] = React.useState('');
  const [attendancePage, setAttendancePage] = React.useState(1);

  // Plain date strings, never an instant, so 31 August cannot drift into
  // September on the way to the API.
  const range = monthRange(attendanceYear, attendanceMonth);
  const monthLabel = `${thaiMonthName(attendanceMonth)} ${attendanceYear}`;

  const changeMonth = (next: MonthValue) => {
    setSelectedMonth(next);
    // A different month is a different page of results; keeping the old page
    // number would land the user on an empty page 3 of a two-day month.
    setAttendancePage(1);
  };

  const query = useQuery({
    queryKey: ['employee-summary', id, attendanceYear, attendanceMonth],
    queryFn: () => employeeApi.summary(id, { from: range.from, to: range.to }),
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
  const policyQuery = useQuery({
    queryKey: ['employee-payroll-policy', id],
    queryFn: () => employeeApi.payrollPolicy(id),
    enabled: Boolean(id),
  });
  // Per-day earnings for hourly staff. The API answers applicable:false for
  // monthly employees, whose pay does not come from a day count.
  const dailyEarningsQuery = useQuery({
    queryKey: ['employee-daily-earnings', id, attendanceYear, attendanceMonth],
    queryFn: () => employeeApi.dailyEarnings(id, { year: attendanceYear, month: attendanceMonth }),
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
  const monthlyBases =
    currentPayProfile?.payType === 'MONTHLY' ? derivedBases(currentPayProfile.monthlySalary) : null;
  const dailyEarnings = dailyEarningsQuery.data;

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
                {/* Derived from the salary, not stored against it: the employee
                    is still paid monthly. These are the bases the deduction
                    rules price against. */}
                {monthlyBases && (
                  <>
                    <InfoRow label="ฐานต่อวัน" value={`${formatMoney(monthlyBases.daily)} บาท`} />
                    <InfoRow label="ฐานต่อชั่วโมง" value={`${formatMoney(monthlyBases.hourly)} บาท`} />
                  </>
                )}
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
            <CardHeader>
              <CardTitle>การตั้งค่าเงินเดือน</CardTitle>
            </CardHeader>
            <CardContent>
              <PayrollPolicySummary policy={policyQuery.data ?? null} />
              <p className="mt-3 text-xs text-muted-foreground">
                รายการที่ระบุว่า “ใช้ค่าเริ่มต้นของบริษัท” จะคิดตามกฎกลางในหน้าตั้งค่าเงินเดือน
                แก้ไขเฉพาะบุคคลได้จากปุ่มแก้ไขด้านบน
              </p>
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
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle>สรุปการลงเวลา · {monthLabel}</CardTitle>
                <MonthSelector value={selectedMonth} onChange={changeMonth} />
              </div>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MiniStat label="จำนวนวันที่บันทึก" value={formatNumber(attendance.totalRecords)} />
              <MiniStat label="วันทำงาน" value={`${formatNumber(attendance.presentDays)} วัน`} />
              <MiniStat label="ชั่วโมงทำงาน" value={formatMinutes(attendance.workedMinutes)} />
              <MiniStat label="ชั่วโมง OT" value={formatMinutes(attendance.otMinutes)} />
              {/* Both figures, because they are different numbers and only the
                  second one becomes money. Showing the raw minutes alone made
                  a deduction look wrong against the attendance record. */}
              <MiniStat
                label="นาทีสายจริง"
                value={`${formatNumber(attendance.lateMinutes)} นาที`}
              />
              <MiniStat
                label={`นาทีสายหลังปัด (${attendance.roundingIntervalMinutes} น.)`}
                value={`${formatNumber(attendance.roundedLateMinutes)} นาที`}
                tone={
                  attendance.roundedLateMinutes < attendance.lateMinutes ? 'success' : 'default'
                }
              />
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
              {dailyEarnings?.applicable && (
                <TabsTrigger value="daily-earnings">ค่าจ้างรายวัน</TabsTrigger>
              )}
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
              {/* The month control is repeated beside every section it governs.
                  One control higher up the page was technically enough, but it
                  sat in a different card and nobody found it, which made a
                  September visit look as though August had been lost. */}
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm font-medium">วันที่ทำงานจริง · {monthLabel}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    className="w-44"
                    value={attendanceStatus}
                    onChange={(e) => {
                      setAttendanceStatus(e.target.value);
                      setAttendancePage(1);
                    }}
                  >
                    <option value="">ทุกสถานะ</option>
                    <option value="NORMAL">มาทำงาน</option>
                    <option value="LATE">มาสาย</option>
                    <option value="LEAVE">ลา</option>
                    <option value="MISSING_DATA">ข้อมูลไม่ครบ</option>
                    <option value="ABSENT">ขาดงาน</option>
                  </Select>
                  <MonthSelector value={selectedMonth} onChange={changeMonth} />
                </div>
              </div>
              {attendanceQuery.isLoading ? (
                <TableSkeleton rows={6} cols={10} />
              ) : attendanceQuery.data?.items.length ? (
                <>
                  <div className="overflow-x-auto">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>วันที่</th>
                          <th>เข้า</th>
                          <th>ออก</th>
                          <th className="text-right">เวลาทำงานจริง</th>
                          <th className="text-right">หักพัก</th>
                          <th className="text-right">ปัดเวลาออก</th>
                          <th className="text-right">เวลาที่ใช้คิด</th>
                          <th className="text-right">สาย</th>
                          <th>สถานะ</th>
                          <th className="text-right">ได้เงินวันนี้</th>
                        </tr>
                      </thead>
                      <tbody>
                        {attendanceQuery.data.items.map((row) => (
                          <tr key={row.id}>
                            <td className="whitespace-nowrap">{formatDateWithWeekday(row.workDate)}</td>
                            <td>{formatTime(row.checkIn)}</td>
                            <td>{formatTime(row.checkOut)}</td>
                            <td className="num">{formatMinutes(row.workedMinutes)}</td>
                            <td className="num text-muted-foreground">
                              {row.dailyPay && row.dailyPay.breakDeductionMinutes > 0
                                ? formatMinutes(row.dailyPay.breakDeductionMinutes)
                                : '-'}
                            </td>
                            <td className="num text-muted-foreground">
                              {row.dailyPay && row.dailyPay.roundedAwayMinutes > 0
                                ? `${formatNumber(row.dailyPay.roundedAwayMinutes)} นาที`
                                : '-'}
                            </td>
                            <td className="num">
                              {row.dailyPay && row.dailyPay.payableMinutes > 0
                                ? formatMinutes(row.dailyPay.payableMinutes)
                                : '-'}
                            </td>
                            <td className="num">
                              {employee.employmentType === 'DAILY' || !row.lateMinutes
                                ? '-'
                                : `${row.lateMinutes} นาที`}
                            </td>
                            <td><AttendanceStatusBadge status={row.status} /></td>
                            <td className="num"><DailyPayCell dailyPay={row.dailyPay} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pagination
                    page={attendanceQuery.data.page}
                    pageSize={attendanceQuery.data.pageSize}
                    total={attendanceQuery.data.total}
                    onPageChange={setAttendancePage}
                  />
                </>
              ) : (
                // An empty month is a fact about that month, not a dead end: the
                // selector above stays put and this offers the way back.
                <EmptyState
                  title="ไม่พบข้อมูลการลงเวลาในเดือนนี้"
                  description={`${monthLabel} ยังไม่มีบันทึกการลงเวลา เลือกเดือนอื่นเพื่อดูย้อนหลัง`}
                  action={
                    <Button variant="outline" onClick={() => changeMonth(previousMonth(selectedMonth))}>
                      ดูเดือนก่อนหน้า
                    </Button>
                  }
                />
              )}
            </TabsContent>
            {dailyEarnings?.applicable && (
              <TabsContent value="daily-earnings">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm font-medium">ค่าจ้างรายวัน · {monthLabel}</p>
                  <MonthSelector value={selectedMonth} onChange={changeMonth} />
                </div>
                {dailyEarningsQuery.isLoading ? (
                  <TableSkeleton rows={6} cols={9} />
                ) : (
                  <DailyEarningsPanel
                    data={dailyEarnings}
                    monthLabel={monthLabel}
                    onPreviousMonth={() => changeMonth(previousMonth(selectedMonth))}
                  />
                )}
              </TabsContent>
            )}
          </Tabs>
        </CardContent>
      </Card>

      <EmployeeFormDialog open={editOpen} onOpenChange={setEditOpen} employee={employee} />
    </div>
  );
}

/**
 * What an hourly employee actually earned, day by day.
 *
 * Each row is priced at the rate in force on that work date and the month total
 * is the sum of the rows, so the figure on screen can be checked line by line
 * against the attendance record. A day no rate covers shows its hours and says
 * so - it is never quietly priced at zero.
 */
function DailyEarningsPanel({
  data,
  monthLabel,
  onPreviousMonth,
}: {
  data: DailyEarnings;
  monthLabel: string;
  onPreviousMonth?: () => void;
}) {
  const summary = data.summary;
  if (!summary || data.rows.length === 0) {
    return (
      <EmptyState
        title="ไม่พบข้อมูลการลงเวลาในเดือนนี้"
        description={`${monthLabel} ยังไม่มีวันทำงานที่คิดค่าจ้างได้`}
        action={
          onPreviousMonth && (
            <Button variant="outline" onClick={onPreviousMonth}>
              ดูเดือนก่อนหน้า
            </Button>
          )
        }
      />
    );
  }

  return (
    <div>
      {/* The full trail, so the total can be accounted for without a
          calculator: what was worked, what the break and the rounding took,
          and what remained to be paid. */}
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <MiniStat label="จำนวนวันที่มาทำงาน" value={`${formatNumber(summary.workedDays)} วัน`} />
        <MiniStat label="เวลาทำงานจริงรวม" value={formatMinutes(summary.totalWorkedMinutes)} />
        <MiniStat
          label="เวลาพักที่หักรวม"
          value={formatMinutes(summary.totalBreakDeductionMinutes)}
        />
        <MiniStat
          label="เวลาที่ถูกปัดออก"
          value={`${formatNumber(summary.totalRoundedAwayMinutes)} นาที`}
          tone={summary.totalRoundedAwayMinutes > 0 ? 'warning' : 'default'}
        />
        <MiniStat label="เวลาที่ใช้คิดค่าจ้าง" value={formatMinutes(summary.totalPayableMinutes)} />
      </div>
      <div className="mb-3">
        <MiniStat
          label="ค่าจ้างรวม"
          value={`${formatMoney(summary.totalAmount)} บาท`}
          tone={summary.unratedDays > 0 ? 'warning' : 'default'}
        />
      </div>

      {summary.unratedDays > 0 && (
        <p className="mb-3 rounded-lg border border-warning/30 bg-warning-soft/60 px-3.5 py-2.5 text-sm text-warning-fg">
          มี {summary.unratedDays} วันที่ยังไม่มีอัตราค่าจ้างครอบคลุม
          เวลาทำงานยังแสดงตามจริง แต่ระบบจะไม่คิดเป็นเงินให้เอง
          ยอดรวมข้างต้นจึงยังไม่ใช่ค่าจ้างทั้งเดือน
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>วันที่</th>
              <th>เข้า</th>
              <th>ออก</th>
              <th className="text-right">เวลาจริง</th>
              <th className="text-right">หักพัก</th>
              <th className="text-right">ปัดออก</th>
              <th className="text-right">เวลาคิดเงิน</th>
              <th className="text-right">อัตรา/ชม.</th>
              <th className="text-right">ค่าจ้างวันนี้</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.workDate}>
                <td className="whitespace-nowrap">{formatDateWithWeekday(row.workDate)}</td>
                <td>{formatTime(row.checkIn)}</td>
                <td>{formatTime(row.checkOut)}</td>
                <td className="num">{formatMinutes(row.workedMinutes)}</td>
                <td className="num text-muted-foreground">
                  {row.breakDeductionMinutes > 0 ? formatMinutes(row.breakDeductionMinutes) : '-'}
                </td>
                <td className="num text-muted-foreground">
                  {row.roundedAwayMinutes > 0 ? `${formatNumber(row.roundedAwayMinutes)} น.` : '-'}
                </td>
                <td className="num font-medium">{formatMinutes(row.payableMinutes)}</td>
                <td className="num">
                  {row.rateConfigured ? `${formatMoney(row.hourlyRate)} บาท` : '-'}
                </td>
                <td className={`num font-medium ${row.rateConfigured ? '' : 'text-warning'}`}>
                  {row.rateConfigured ? formatMoney(row.amount) : 'ยังไม่ได้กำหนดอัตรา'}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td colSpan={3}>รวม {formatNumber(summary.workedDays)} วัน</td>
              <td className="num">{formatMinutes(summary.totalWorkedMinutes)}</td>
              <td className="num">{formatMinutes(summary.totalBreakDeductionMinutes)}</td>
              <td className="num">{formatNumber(summary.totalRoundedAwayMinutes)} น.</td>
              <td className="num">{formatMinutes(summary.totalPayableMinutes)}</td>
              <td />
              <td className="num">{formatMoney(summary.totalAmount)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
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
  tone?: 'default' | 'warning' | 'danger' | 'success';
}) {
  const toneClass = {
    default: 'text-foreground',
    warning: 'text-warning',
    danger: 'text-danger',
    success: 'text-success',
  }[tone];

  return (
    <div className="rounded-lg border border-border px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-sm font-semibold tabular-nums ${toneClass}`}>{value}</p>
    </div>
  );
}
