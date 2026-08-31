import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Eye, Pencil, Plus, Search, UserMinus, Users } from 'lucide-react';
import { employeeApi, settingsApi, POLL_INTERVAL_MS } from '@/services/endpoints';
import { apiErrorMessage } from '@/services/api';
import { useAuth } from '@/features/auth/AuthContext';
import EmployeeFormDialog from '@/features/employees/EmployeeFormDialog';
import EmployeeDetailDrawer from '@/features/employees/EmployeeDetailDrawer';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Pagination,
  Select,
  TableSkeleton,
  Textarea,
} from '@/components/ui';
import { EmployeeStatusBadge, EMPLOYMENT_TYPE_LABELS } from '@/components/StatusBadge';
import type { Employee, EmployeeProfileCompleteness } from '@/types';

/** Debounce the search box so typing does not fire a request per keystroke. */
function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export default function EmployeesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const canWrite = can('employee:write');

  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState('');
  const [departmentId, setDepartmentId] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [employmentType, setEmploymentType] = React.useState('');
  const [completeness, setCompleteness] = React.useState('');
  const debouncedSearch = useDebounced(search);

  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Employee | null>(null);
  const [deactivating, setDeactivating] = React.useState<Employee | null>(null);
  const [viewing, setViewing] = React.useState<Employee | null>(null);
  const [deactivateReason, setDeactivateReason] = React.useState('');

  React.useEffect(() => setPage(1), [debouncedSearch, departmentId, status, employmentType, completeness]);

  const { data: departments = [] } = useQuery({
    queryKey: ['departments'],
    queryFn: settingsApi.listDepartments,
  });

  const query = useQuery({
    queryKey: ['employees', page, debouncedSearch, departmentId, status, employmentType, completeness],
    queryFn: () =>
      employeeApi.list({
        page,
        pageSize: 25,
        search: debouncedSearch || undefined,
        departmentId: departmentId || undefined,
        status: status || undefined,
        employmentType: employmentType || undefined,
        completeness: (completeness || undefined) as 'COMPLETE' | 'INCOMPLETE' | undefined,
      }),
    // Background refresh must not blank the table or lose the current page.
    refetchInterval: POLL_INTERVAL_MS.employees,
    placeholderData: (previous) => previous,
  });

  // Counters come from the same backend rule the row badges use, so the
  // header total can never disagree with the badges below it.
  const summaryQuery = useQuery({
    queryKey: ['employee-completeness-summary'],
    queryFn: employeeApi.completenessSummary,
    refetchInterval: POLL_INTERVAL_MS.employees,
  });

  const deactivateMutation = useMutation({
    mutationFn: () => employeeApi.deactivate(deactivating!.id, deactivateReason),
    onSuccess: () => {
      toast.success('ปิดการใช้งานพนักงานเรียบร้อยแล้ว');
      void queryClient.invalidateQueries({ queryKey: ['employees'] });
      setDeactivating(null);
      setDeactivateReason('');
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  });

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (employee: Employee) => {
    setEditing(employee);
    setFormOpen(true);
  };

  return (
    <div>
      <PageHeader
        title="พนักงาน"
        description="จัดการข้อมูลพนักงาน ตำแหน่ง และการตั้งค่าการจ่ายเงิน"
        actions={
          canWrite ? (
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" />
              เพิ่มพนักงาน
            </Button>
          ) : null
        }
      />

      {summaryQuery.data && (
        <div className="mb-4 grid grid-cols-3 gap-3">
          <CountTile label="พนักงานทั้งหมด" value={summaryQuery.data.total} />
          <CountTile label="ข้อมูลครบ" value={summaryQuery.data.complete} tone="success" />
          <CountTile label="ข้อมูลไม่ครบ" value={summaryQuery.data.incomplete} tone="danger" />
        </div>
      )}

      <Card className="mb-4 p-4">
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          <div className="relative md:col-span-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ค้นหารหัสพนักงาน ชื่อ หรือชื่อเล่น"
              className="pl-9"
            />
          </div>
          <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">ทุกแผนก</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
          <Select value={employmentType} onChange={(e) => setEmploymentType(e.target.value)}>
            <option value="">ทุกประเภทพนักงาน</option>
            <option value="MONTHLY">รายเดือน</option>
            <option value="DAILY">รายวัน</option>
            <option value="HOURLY">รายชั่วโมง</option>
            <option value="CONTRACT">สัญญาจ้าง</option>
          </Select>
          <Select value={completeness} onChange={(e) => setCompleteness(e.target.value)}>
            <option value="">ความครบถ้วน: ทั้งหมด</option>
            <option value="COMPLETE">ข้อมูลครบ</option>
            <option value="INCOMPLETE">ข้อมูลไม่ครบ</option>
          </Select>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">ทุกสถานะ</option>
            <option value="ACTIVE">ทำงานอยู่</option>
            <option value="PROBATION">ทดลองงาน</option>
            <option value="INACTIVE">ไม่ทำงานแล้ว</option>
            <option value="TERMINATED">พ้นสภาพ</option>
          </Select>
        </div>
      </Card>

      <Card className="overflow-hidden">
        {query.isLoading ? (
          <TableSkeleton rows={8} cols={8} />
        ) : query.isError ? (
          <ErrorState message={apiErrorMessage(query.error)} onRetry={() => void query.refetch()} />
        ) : query.data && query.data.items.length === 0 ? (
          <EmptyState
            icon={<Users className="h-6 w-6" />}
            title="ไม่พบข้อมูลพนักงาน"
            description={
              search || departmentId || status
                ? 'ลองปรับเงื่อนไขการค้นหาหรือตัวกรอง'
                : 'เริ่มต้นโดยการเพิ่มพนักงานคนแรกเข้าสู่ระบบ'
            }
            action={canWrite ? <Button onClick={openCreate}>เพิ่มพนักงาน</Button> : undefined}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    {/* Hire date and salary live on the employee detail page:
                        the list stays readable, and neither field is owned by
                        the Google Sheet the roster is imported from. */}
                    <th>รหัสพนักงาน</th>
                    <th>ชื่อ-นามสกุล</th>
                    <th>แผนก</th>
                    <th>ตำแหน่ง</th>
                    <th>ประเภทพนักงาน</th>
                    <th>สถานะ</th>
                    <th>ข้อมูล</th>
                    <th className="w-[90px]" />
                  </tr>
                </thead>
                <tbody>
                  {query.data?.items.map((employee) => (
                    <tr
                      key={employee.id}
                      className="cursor-pointer"
                      onClick={() => navigate(`/employees/${employee.id}`)}
                    >
                      <td className="font-medium">{employee.employeeCode}</td>
                      <td>
                        <div className="font-medium">
                          {employee.firstName} {employee.lastName}
                        </div>
                        {employee.nickname && (
                          <div className="text-xs text-muted-foreground">({employee.nickname})</div>
                        )}
                        {(!employee.attendanceRequired || !employee.leaveTrackingRequired) && (
                          <div className="mt-1 inline-flex rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                            ผู้บริหาร · ยกเว้นลงเวลา/วันลา
                          </div>
                        )}
                      </td>
                      <td className="text-muted-foreground">{employee.department?.name ?? '-'}</td>
                      <td className="text-muted-foreground">{employee.position?.name ?? '-'}</td>
                      <td className="text-muted-foreground">
                        {EMPLOYMENT_TYPE_LABELS[employee.employmentType]}
                      </td>
                      <td>
                        <EmployeeStatusBadge status={employee.status} />
                      </td>
                      <td>
                        <ProfileCompletenessBadge completeness={employee.profileCompleteness} />
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-0.5">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setViewing(employee)}
                            aria-label="ดูข้อมูล"
                            title="ดูข้อมูล"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          {canWrite && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => openEdit(employee)}
                              aria-label="แก้ไข"
                              title="แก้ไข"
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                          )}
                          {canWrite && employee.status === 'ACTIVE' && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-danger hover:bg-danger-soft"
                              onClick={() => setDeactivating(employee)}
                              aria-label="ปิดการใช้งาน"
                              title="ปิดการใช้งาน"
                            >
                              <UserMinus className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
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

      <EmployeeFormDialog open={formOpen} onOpenChange={setFormOpen} employee={editing} />

      <EmployeeDetailDrawer
        employee={viewing}
        onClose={() => setViewing(null)}
        onEdit={canWrite ? openEdit : undefined}
      />

      <ConfirmDialog
        open={Boolean(deactivating)}
        onOpenChange={(open) => {
          if (!open) {
            setDeactivating(null);
            setDeactivateReason('');
          }
        }}
        title="ปิดการใช้งานพนักงาน"
        description={`${deactivating?.firstName ?? ''} ${deactivating?.lastName ?? ''} จะไม่ถูกรวมในการคำนวณเงินเดือนรอบถัดไป ข้อมูลย้อนหลังทั้งหมดจะยังคงอยู่`}
        confirmLabel="ปิดการใช้งาน"
        variant="destructive"
        loading={deactivateMutation.isPending}
        onConfirm={() => {
          if (deactivateReason.trim().length < 3) {
            toast.error('กรุณาระบุเหตุผลอย่างน้อย 3 ตัวอักษร');
            return;
          }
          deactivateMutation.mutate();
        }}
      >
        <Field label="เหตุผล" required>
          <Textarea
            value={deactivateReason}
            onChange={(e) => setDeactivateReason(e.target.value)}
            placeholder="เช่น ลาออกเมื่อวันที่ ..."
            rows={3}
          />
        </Field>
      </ConfirmDialog>
    </div>
  );
}

/**
 * Row-level completeness badge.
 *
 * The verdict and the Thai labels both come from the backend - nothing about
 * the rule is decided here, so the badge cannot drift from the payroll
 * pre-check or a future report.
 */
function ProfileCompletenessBadge({
  completeness,
}: {
  completeness?: EmployeeProfileCompleteness;
}) {
  if (!completeness) return <span className="text-muted-foreground">-</span>;

  // The executive marker explains why the checklist was shorter, so a complete
  // profile with no salary does not look like an oversight.
  const executive = completeness.exempt ? (
    <span className="inline-flex rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
      ผู้บริหาร
    </span>
  ) : null;

  if (completeness.complete) {
    return (
      <div className="flex flex-wrap items-center gap-1">
        {executive}
        <Badge variant="success">ข้อมูลครบ</Badge>
      </div>
    );
  }

  // The table stays compact: a count here, the field list on hover.
  return (
    <span
      className="inline-flex cursor-help"
      title={`ข้อมูลที่ยังขาด:\n${completeness.missingLabels.map((l) => `- ${l}`).join('\n')}`}
    >
      <span className="flex flex-wrap items-center gap-1">
        {executive}
        <Badge variant="danger">ข้อมูลไม่ครบ {completeness.missingCount} รายการ</Badge>
      </span>
    </span>
  );
}

function CountTile({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number;
  tone?: 'default' | 'success' | 'danger';
}) {
  const toneClass = {
    default: 'text-foreground',
    success: 'text-success',
    danger: 'text-danger',
  }[tone];
  return (
    <div className="rounded-xl border border-border bg-card px-3.5 py-2.5">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${toneClass}`}>{value}</p>
    </div>
  );
}
