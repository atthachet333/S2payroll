import * as React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowLeft,
  BadgeCheck,
  Banknote,
  Calculator,
  ClipboardCheck,
  FileCheck2,
  Lock,
  Unlock,
  Download,
} from 'lucide-react';
import { payrollApi, settingsApi } from '@/services/endpoints';
import { apiErrorMessage, downloadFile } from '@/services/api';
import { useAuth } from '@/features/auth/AuthContext';
import PayrollEmployeeDrawer from '@/features/payroll/PayrollEmployeeDrawer';
import FinalReviewDialog from '@/features/payroll/FinalReviewDialog';
import PrePayrollCheckDialog from '@/features/payroll/PrePayrollCheckDialog';
import {
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
  Skeleton,
  StatCard,
  TableSkeleton,
  Textarea,
} from '@/components/ui';
import { PayrollEmployeeStatusBadge, PeriodStatusBadge } from '@/components/StatusBadge';
import { formatDate, formatMoney, formatNumber } from '@/utils/format';
import { cn } from '@/utils/cn';
import type { PayrollPeriodStatus } from '@/types';

type WorkflowAction =
  | 'attendance-review'
  | 'calculate'
  | 'submit-review'
  | 'approve'
  | 'mark-paid'
  | 'lock'
  | 'unlock'
  | 'payslips';

interface ActionConfig {
  key: WorkflowAction;
  label: string;
  icon: React.ReactNode;
  variant: 'default' | 'outline' | 'success' | 'warning' | 'destructive';
  permission: string;
  confirmTitle: string;
  confirmBody: string;
  /** Spelled-out consequences, shown as a list for irreversible actions. */
  consequences?: string[];
  availableIn: PayrollPeriodStatus[];
}

/** The workflow, expressed once: which action is offered in which state. */
const ACTIONS: ActionConfig[] = [
  {
    key: 'attendance-review',
    label: 'เริ่มตรวจสอบเวลาทำงาน',
    icon: <ClipboardCheck className="h-4 w-4" />,
    variant: 'outline',
    permission: 'payroll:write',
    confirmTitle: 'เริ่มตรวจสอบเวลาทำงาน',
    confirmBody: 'ย้ายรอบเงินเดือนเข้าสู่ขั้นตอนตรวจสอบข้อมูลการลงเวลา',
    availableIn: ['DRAFT'],
  },
  {
    key: 'calculate',
    label: 'คำนวณเงินเดือน',
    icon: <Calculator className="h-4 w-4" />,
    variant: 'default',
    permission: 'payroll:calculate',
    confirmTitle: 'คำนวณเงินเดือน',
    confirmBody:
      'ระบบจะคำนวณเงินเดือนของพนักงานที่ยังทำงานอยู่ทั้งหมดจากข้อมูลการลงเวลาในรอบนี้ รายการที่ปรับด้วยมือไว้แล้วจะยังคงอยู่',
    availableIn: ['DRAFT', 'ATTENDANCE_REVIEW', 'CALCULATED'],
  },
  {
    key: 'submit-review',
    label: 'ส่งตรวจสอบ',
    icon: <ClipboardCheck className="h-4 w-4" />,
    variant: 'outline',
    permission: 'payroll:write',
    confirmTitle: 'ส่งรอบเงินเดือนเพื่อตรวจสอบ',
    confirmBody: 'ย้ายรอบเงินเดือนเข้าสู่ขั้นตอนการตรวจสอบก่อนอนุมัติ',
    availableIn: ['CALCULATED'],
  },
  {
    key: 'approve',
    label: 'อนุมัติ',
    icon: <BadgeCheck className="h-4 w-4" />,
    variant: 'success',
    permission: 'payroll:approve',
    confirmTitle: 'อนุมัติรอบเงินเดือน',
    confirmBody:
      'หลังอนุมัติแล้วจะสามารถออกสลิปเงินเดือนและบันทึกการจ่ายได้ หากยังมีพนักงานที่ข้อมูลไม่ครบ ระบบจะไม่อนุญาตให้อนุมัติ',
    availableIn: ['REVIEW'],
  },
  {
    key: 'payslips',
    label: 'ออกสลิปเงินเดือน',
    icon: <FileCheck2 className="h-4 w-4" />,
    variant: 'outline',
    permission: 'payslip:issue',
    confirmTitle: 'ออกสลิปเงินเดือน',
    confirmBody: 'สร้างสลิปเงินเดือนสำหรับพนักงานทุกคนในรอบนี้ หากมีสลิปอยู่แล้วจะอัปเดตข้อมูลให้ตรงกับยอดล่าสุด',
    availableIn: ['APPROVED', 'PAID', 'LOCKED'],
  },
  {
    key: 'mark-paid',
    label: 'บันทึกการจ่ายเงิน',
    icon: <Banknote className="h-4 w-4" />,
    variant: 'success',
    permission: 'payroll:pay',
    confirmTitle: 'บันทึกว่าจ่ายเงินแล้ว',
    confirmBody: 'ยืนยันว่าได้โอนเงินเดือนให้พนักงานในรอบนี้เรียบร้อยแล้ว',
    consequences: [
      'รอบเงินเดือนจะเปลี่ยนสถานะเป็น "จ่ายแล้ว"',
      'ยังแก้ไขตัวเลขได้จนกว่าจะล็อกรอบ',
      'การกระทำนี้จะถูกบันทึกพร้อมชื่อผู้ดำเนินการ',
    ],
    availableIn: ['APPROVED'],
  },
  {
    key: 'lock',
    label: 'ล็อกรอบเงินเดือน',
    icon: <Lock className="h-4 w-4" />,
    variant: 'warning',
    permission: 'payroll:lock',
    confirmTitle: 'ล็อกรอบเงินเดือน',
    confirmBody: 'การล็อกเป็นการปิดรอบเงินเดือนอย่างถาวร โปรดอ่านผลที่จะเกิดขึ้นก่อนยืนยัน',
    consequences: [
      'ตัวเลขทางการเงินทั้งหมดจะแก้ไขไม่ได้อีก และคำนวณใหม่ไม่ได้',
      'การแก้ไขข้อมูลลงเวลาจะไม่มีผลต่อรอบเงินเดือนนี้อีกต่อไป',
      'มีเพียง SUPER_ADMIN เท่านั้นที่ปลดล็อกได้ และต้องระบุเหตุผล',
    ],
    availableIn: ['PAID'],
  },
  {
    key: 'unlock',
    label: 'ปลดล็อก',
    icon: <Unlock className="h-4 w-4" />,
    variant: 'destructive',
    permission: 'payroll:unlock',
    confirmTitle: 'ปลดล็อกรอบเงินเดือน',
    confirmBody: 'การปลดล็อกจะเปิดให้แก้ไขตัวเลขที่ปิดรอบไปแล้ว ต้องระบุเหตุผลที่ชัดเจน',
    consequences: [
      'รอบเงินเดือนจะกลับสู่สถานะ "จ่ายแล้ว" และแก้ไขได้อีกครั้ง',
      'ข้อมูลลงเวลาในรอบนี้จะถูกปลดล็อกด้วย',
      'เหตุผลและชื่อผู้ปลดล็อกจะถูกบันทึกถาวรในบันทึกการตรวจสอบ',
    ],
    availableIn: ['LOCKED'],
  },
];

export default function PayrollDetailPage() {
  const { periodId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { can } = useAuth();

  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState('');
  const [departmentId, setDepartmentId] = React.useState('');
  const [status, setStatus] = React.useState('');
  /** Employee-code filter from the dropdown; takes precedence over free-text search. */
  const [employeeFilter, setEmployeeFilter] = React.useState('');
  const [selectedEmployee, setSelectedEmployee] = React.useState<string | null>(null);
  const [pendingAction, setPendingAction] = React.useState<ActionConfig | null>(null);
  const [unlockReason, setUnlockReason] = React.useState('');
  const [reviewOpen, setReviewOpen] = React.useState(false);
  const [preCheckOpen, setPreCheckOpen] = React.useState(false);
  const [downloadingZip, setDownloadingZip] = React.useState(false);

  const downloadAll = React.useCallback(async () => {
    setDownloadingZip(true);
    try {
      await downloadFile(payrollApi.bulkPayslipPath(periodId), `payslips-${periodId}.zip`);
      toast.success('ดาวน์โหลดสลิปเงินเดือนทั้งหมดเรียบร้อยแล้ว');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      setDownloadingZip(false);
    }
  }, [periodId]);

  React.useEffect(() => setPage(1), [search, departmentId, status, employeeFilter]);

  const { data: departments = [] } = useQuery({
    queryKey: ['departments'],
    queryFn: settingsApi.listDepartments,
  });

  const periodQuery = useQuery({
    queryKey: ['payroll-period', periodId],
    queryFn: () => payrollApi.getPeriod(periodId),
    enabled: Boolean(periodId),
  });

  // Unfiltered roster for the employee dropdown, so picking a person does not
  // depend on the filters currently narrowing the table. 200 is the API's
  // maximum page size; beyond that the dropdown is hidden and the free-text
  // search box is used instead, rather than silently offering a partial list.
  const ROSTER_LIMIT = 200;
  const rosterQuery = useQuery({
    queryKey: ['payroll-roster', periodId],
    queryFn: () => payrollApi.listEmployees(periodId, { page: 1, pageSize: ROSTER_LIMIT }),
    enabled: Boolean(periodId),
  });
  const periodEmployees = rosterQuery.data?.items ?? [];
  const rosterComplete = (rosterQuery.data?.total ?? 0) <= ROSTER_LIMIT;

  // A specific employee selection wins over the free-text box.
  const effectiveSearch = employeeFilter || search || undefined;

  const employeesQuery = useQuery({
    queryKey: ['payroll-employees', periodId, page, effectiveSearch, departmentId, status],
    queryFn: () =>
      payrollApi.listEmployees(periodId, {
        page,
        pageSize: 25,
        search: effectiveSearch,
        departmentId: departmentId || undefined,
        status: status || undefined,
      }),
    enabled: Boolean(periodId),
  });

  const actionMutation = useMutation({
    mutationFn: async (action: WorkflowAction) => {
      switch (action) {
        case 'attendance-review':
          return payrollApi.startAttendanceReview(periodId);
        case 'calculate':
          return payrollApi.calculate(periodId);
        case 'submit-review':
          return payrollApi.submitReview(periodId);
        case 'approve':
          return payrollApi.approve(periodId);
        case 'mark-paid':
          return payrollApi.markPaid(periodId);
        case 'lock':
          return payrollApi.lock(periodId);
        case 'unlock':
          return payrollApi.unlock(periodId, unlockReason);
        case 'payslips':
          return payrollApi.generatePayslips(periodId);
      }
    },
    onSuccess: (_result, action) => {
      const messages: Record<WorkflowAction, string> = {
        'attendance-review': 'เข้าสู่ขั้นตอนตรวจสอบเวลาทำงานแล้ว',
        calculate: 'คำนวณเงินเดือนเรียบร้อยแล้ว',
        'submit-review': 'ส่งตรวจสอบเรียบร้อยแล้ว',
        approve: 'อนุมัติรอบเงินเดือนเรียบร้อยแล้ว',
        'mark-paid': 'บันทึกการจ่ายเงินเรียบร้อยแล้ว',
        lock: 'ล็อกรอบเงินเดือนเรียบร้อยแล้ว',
        unlock: 'ปลดล็อกรอบเงินเดือนเรียบร้อยแล้ว',
        payslips: 'ออกสลิปเงินเดือนเรียบร้อยแล้ว',
      };
      toast.success(messages[action]);
      setPendingAction(null);
      setUnlockReason('');
      void queryClient.invalidateQueries({ queryKey: ['payroll-period'] });
      void queryClient.invalidateQueries({ queryKey: ['payroll-employees'] });
      void queryClient.invalidateQueries({ queryKey: ['payroll-periods'] });
      void queryClient.invalidateQueries({ queryKey: ['payslips'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (err) => {
      toast.error(apiErrorMessage(err));
      setPendingAction(null);
    },
  });

  if (periodQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-72" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  if (periodQuery.isError || !periodQuery.data) {
    return (
      <Card>
        <ErrorState
          message={apiErrorMessage(periodQuery.error)}
          onRetry={() => void periodQuery.refetch()}
        />
      </Card>
    );
  }

  const summary = periodQuery.data;
  const period = summary.period;
  const locked = period.status === 'LOCKED';

  const availableActions = ACTIONS.filter(
    (action) => action.availableIn.includes(period.status) && can(action.permission)
  );

  return (
    <div>
      <button
        type="button"
        onClick={() => navigate('/payroll')}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-primary"
      >
        <ArrowLeft className="h-4 w-4" />
        กลับไปยังรอบเงินเดือน
      </button>

      <PageHeader
        title={`รอบเงินเดือน ${period.name}`}
        description={`${formatDate(period.startDate)} - ${formatDate(period.endDate)} · วันจ่าย ${formatDate(period.paymentDate)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <PeriodStatusBadge status={period.status} />

            {/* Final Review replaces a bare "approve" button while in REVIEW. */}
            {period.status === 'REVIEW' && can('payroll:read') && (
              <Button variant="default" onClick={() => setReviewOpen(true)}>
                <ClipboardCheck className="h-4 w-4" />
                ตรวจสอบครั้งสุดท้าย
              </Button>
            )}

            {['APPROVED', 'PAID', 'LOCKED'].includes(period.status) && can('payslip:read') && (
              <Button variant="outline" loading={downloadingZip} onClick={() => void downloadAll()}>
                <Download className="h-4 w-4" />
                ดาวน์โหลดสลิปทั้งหมด (ZIP)
              </Button>
            )}

            {availableActions.map((action) => (
              <Button
                key={action.key}
                variant={action.variant}
                onClick={() =>
                  action.key === 'calculate' ? setPreCheckOpen(true) : setPendingAction(action)
                }
                loading={actionMutation.isPending && pendingAction?.key === action.key}
              >
                {action.icon}
                {action.label}
              </Button>
            ))}
          </div>
        }
      />

      {locked && (
        <div className="mb-4 flex items-center gap-2.5 rounded-lg bg-secondary px-4 py-3 text-sm">
          <Lock className="h-4 w-4 shrink-0" />
          <span>
            รอบเงินเดือนนี้ถูกล็อกแล้วเมื่อ {formatDate(period.lockedAt)} —
            ข้อมูลทางการเงินและการลงเวลาในรอบนี้ไม่สามารถแก้ไขได้
          </span>
        </div>
      )}

      {/* Summary cards */}
      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="พนักงานในรอบ" value={formatNumber(summary.employees)} />
        <StatCard label="รายได้รวม" value={formatMoney(summary.grossTotal)} tone="info" />
        <StatCard
          label="ค่าล่วงเวลา"
          value={formatMoney(summary.otTotal)}
          sub={`${formatNumber(summary.otHours, 2)} ชั่วโมง`}
        />
        <StatCard label="รายการหักรวม" value={formatMoney(summary.deductionTotal)} tone="danger" />
        <StatCard label="เงินเดือนสุทธิรวม" value={formatMoney(summary.netTotal)} tone="success" />
        <StatCard label="พร้อมจ่าย" value={formatNumber(summary.ready)} tone="success" />
        <StatCard label="ต้องตรวจสอบ" value={formatNumber(summary.needsReview)} tone="warning" />
        <StatCard label="ข้อมูลไม่ครบ" value={formatNumber(summary.missingData)} tone="danger" />
      </div>

      {/* Filters */}
      <Card className="mb-4 p-4">
        <div className={cn('grid gap-3', rosterComplete ? 'md:grid-cols-4' : 'md:grid-cols-3')}>
          <Field label="ค้นหาพนักงาน">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="รหัสหรือชื่อพนักงาน"
            />
          </Field>
          {rosterComplete && (
            <Field label="พนักงาน">
              <Select value={employeeFilter} onChange={(e) => setEmployeeFilter(e.target.value)}>
                <option value="">ทุกคน</option>
                {periodEmployees.map((e) => (
                  <option key={e.employeeId} value={e.employeeCode}>
                    {e.employeeCode} · {e.employeeName}
                  </option>
                ))}
              </Select>
            </Field>
          )}
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
              <option value="READY">พร้อมจ่าย</option>
              <option value="NEEDS_REVIEW">ต้องตรวจสอบ</option>
              <option value="MISSING_DATA">ข้อมูลไม่ครบ</option>
              <option value="EXCLUDED">ไม่รวมในรอบนี้</option>
            </Select>
          </Field>
        </div>
      </Card>

      {/* Employee payroll table */}
      <Card className="overflow-hidden">
        {employeesQuery.isLoading ? (
          <TableSkeleton rows={8} cols={10} />
        ) : employeesQuery.isError ? (
          <ErrorState
            message={apiErrorMessage(employeesQuery.error)}
            onRetry={() => void employeesQuery.refetch()}
          />
        ) : employeesQuery.data && employeesQuery.data.items.length === 0 ? (
          <EmptyState
            icon={<Calculator className="h-6 w-6" />}
            title="ยังไม่มีข้อมูลการคำนวณ"
            description="กด “คำนวณเงินเดือน” เพื่อสร้างรายการจากข้อมูลการลงเวลาในรอบนี้"
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>รหัส</th>
                    <th>ชื่อ-นามสกุล</th>
                    <th>แผนก</th>
                    <th className="text-right">ชม.ทำงาน</th>
                    <th className="text-right">ชม. OT</th>
                    <th className="text-right">เงินเดือน</th>
                    <th className="text-right">ค่า OT</th>
                    <th className="text-right">เบี้ยเลี้ยง</th>
                    <th className="text-right">โบนัส</th>
                    <th className="text-right">ปกส.</th>
                    <th className="text-right">ภาษี</th>
                    <th className="text-right">รวมหัก</th>
                    <th className="text-right">รายได้รวม</th>
                    <th className="text-right">เงินสุทธิ</th>
                    <th>สถานะ</th>
                  </tr>
                </thead>
                <tbody>
                  {employeesQuery.data?.items.map((row) => (
                    <tr
                      key={row.id}
                      className="cursor-pointer"
                      onClick={() => setSelectedEmployee(row.employeeId)}
                    >
                      <td className="font-medium">{row.employeeCode}</td>
                      <td>{row.employeeName}</td>
                      <td className="text-muted-foreground">{row.departmentName ?? '-'}</td>
                      <td className="num">{formatNumber(row.workingHours, 1)}</td>
                      <td className="num text-info">{formatNumber(row.otHours, 1)}</td>
                      <td className="num">{formatMoney(row.baseSalary)}</td>
                      <td className="num">{formatMoney(row.otAmount)}</td>
                      <td className="num">{formatMoney(row.allowanceAmount)}</td>
                      <td className="num">{formatMoney(row.bonusAmount)}</td>
                      <td className="num text-danger">{formatMoney(row.socialSecurity)}</td>
                      <td className="num text-danger">{formatMoney(row.tax)}</td>
                      <td className="num text-danger">{formatMoney(row.totalDeduction)}</td>
                      <td className="num">{formatMoney(row.grossIncome)}</td>
                      <td className="num font-semibold">{formatMoney(row.netSalary)}</td>
                      <td>
                        <PayrollEmployeeStatusBadge status={row.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {employeesQuery.data && (
              <Pagination
                page={employeesQuery.data.page}
                pageSize={employeesQuery.data.pageSize}
                total={employeesQuery.data.total}
                onPageChange={setPage}
              />
            )}
          </>
        )}
      </Card>

      <PayrollEmployeeDrawer
        periodId={periodId}
        employeeId={selectedEmployee}
        locked={locked}
        onClose={() => setSelectedEmployee(null)}
      />

      <PrePayrollCheckDialog
        open={preCheckOpen}
        onOpenChange={setPreCheckOpen}
        periodId={periodId}
        calculating={actionMutation.isPending}
        canCalculate={can('payroll:calculate')}
        onCalculate={() => {
          setPreCheckOpen(false);
          actionMutation.mutate('calculate');
        }}
      />

      <FinalReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        periodId={periodId}
        summary={summary}
        canApprove={can('payroll:approve')}
        approving={actionMutation.isPending}
        onApprove={() => {
          setReviewOpen(false);
          actionMutation.mutate('approve');
        }}
      />

      <ConfirmDialog
        open={Boolean(pendingAction)}
        onOpenChange={(open) => {
          if (!open) {
            setPendingAction(null);
            setUnlockReason('');
          }
        }}
        title={pendingAction?.confirmTitle ?? ''}
        description={pendingAction?.confirmBody}
        confirmLabel={pendingAction?.label ?? 'ยืนยัน'}
        variant={pendingAction?.variant === 'outline' ? 'default' : pendingAction?.variant}
        loading={actionMutation.isPending}
        onConfirm={() => {
          if (!pendingAction) return;
          if (pendingAction.key === 'unlock' && unlockReason.trim().length < 5) {
            toast.error('กรุณาระบุเหตุผลอย่างน้อย 5 ตัวอักษร');
            return;
          }
          actionMutation.mutate(pendingAction.key);
        }}
      >
        {/* Spell out the consequences of an irreversible action before it happens. */}
        {pendingAction?.consequences && (
          <ul
            className={cn(
              'space-y-1.5 rounded-lg border px-3.5 py-3 text-sm',
              pendingAction.key === 'unlock'
                ? 'border-danger/30 bg-danger-soft/60 text-danger-fg'
                : 'border-warning/30 bg-warning-soft/60 text-warning-fg'
            )}
          >
            {pendingAction.consequences.map((c) => (
              <li key={c} className="flex gap-2">
                <span aria-hidden>•</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        )}

        {pendingAction?.key === 'unlock' && (
          <Field label="เหตุผลในการปลดล็อก" required>
            <Textarea
              value={unlockReason}
              onChange={(e) => setUnlockReason(e.target.value)}
              rows={3}
              placeholder="เช่น พบข้อผิดพลาดในการคำนวณ OT ของพนักงาน EMP005"
            />
          </Field>
        )}
      </ConfirmDialog>
    </div>
  );
}
