import * as React from 'react';
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
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { EmployeeStatusBadge, EMPLOYMENT_TYPE_LABELS } from '@/components/StatusBadge';
import { formatDate, formatMinutes, formatMoney, formatNumber } from '@/utils/format';

export default function EmployeeDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [editOpen, setEditOpen] = React.useState(false);

  const query = useQuery({
    queryKey: ['employee-summary', id],
    queryFn: () => employeeApi.summary(id),
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
                <InfoRow
                  label={
                    employee.employmentType === 'DAILY'
                      ? 'ค่าจ้างต่อวัน'
                      : employee.employmentType === 'HOURLY'
                        ? 'ค่าจ้างต่อชั่วโมง'
                        : 'เงินเดือน'
                  }
                  value={`${formatMoney(employee.baseSalary)} บาท`}
                />
                <InfoRow label="ธนาคาร" value={employee.bankName ?? '-'} />
                <InfoRow label="เลขที่บัญชี" value={employee.bankAccount ?? '-'} />
              </div>
              <div className="divide-y divide-border/70">
                <InfoRow label="เลขประจำตัวผู้เสียภาษี" value={employee.taxId ?? '-'} />
                <InfoRow label="เลขที่ประกันสังคม" value={employee.socialSecurity ?? '-'} />
                <InfoRow label="หักประกันสังคม" value={employee.ssoEnabled ? 'ใช่' : 'ไม่'} />
                <InfoRow label="หักภาษี" value={employee.taxEnabled ? 'ใช่' : 'ไม่'} />
                <InfoRow label="มีสิทธิ์ OT" value={employee.otEligible ? 'ใช่' : 'ไม่'} />
              </div>
            </CardContent>
          </Card>

          {/* Attendance summary */}
          <Card>
            <CardHeader>
              <CardTitle>สรุปการลงเวลา (ทั้งหมด)</CardTitle>
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
