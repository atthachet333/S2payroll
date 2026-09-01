import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, Eye, FileSpreadsheet, FileText, Printer } from 'lucide-react';
import dayjs from 'dayjs';
import { payrollApi, reportApi, settingsApi } from '@/services/endpoints';
import { apiErrorMessage, downloadFile } from '@/services/api';
import {
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Select,
  TableSkeleton,
} from '@/components/ui';
import { cn } from '@/utils/cn';

interface ReportDefinition {
  type: string;
  label: string;
  description: string;
  /** Which filter controls this report actually uses. */
  filters: ('period' | 'dateRange' | 'department' | 'employee' | 'employmentType' | 'status')[];
}

const REPORTS: ReportDefinition[] = [
  {
    type: 'payroll-summary',
    label: 'รายงานเงินเดือนแบบละเอียด',
    description: 'รายได้ รายการหัก การลงเวลา และยอดสุทธิรายบุคคล',
    filters: ['period', 'department', 'employmentType', 'status'],
  },
  {
    type: 'attendance-summary',
    label: 'สรุปการลงเวลา',
    description: 'สรุปวันทำงาน มาสาย ขาดงาน และ OT รายบุคคล',
    filters: ['dateRange', 'department'],
  },
  {
    type: 'ot',
    label: 'รายงาน OT',
    description: 'รายการวันที่มีการทำงานล่วงเวลา',
    filters: ['dateRange', 'department'],
  },
  {
    type: 'late',
    label: 'รายงานการมาสาย',
    description: 'รายการวันที่พนักงานมาสาย',
    filters: ['dateRange', 'department'],
  },
  {
    type: 'absence',
    label: 'รายงานการขาดงาน',
    description: 'รายการวันที่พนักงานขาดงาน',
    filters: ['dateRange', 'department'],
  },
  {
    type: 'payroll-by-department',
    label: 'เงินเดือนแยกตามแผนก',
    description: 'ยอดรวมเงินเดือนจำแนกตามแผนก',
    filters: ['period'],
  },
  {
    type: 'salary-history',
    label: 'ประวัติการปรับเงินเดือน',
    description: 'บันทึกการเปลี่ยนแปลงเงินเดือนของพนักงาน',
    filters: ['employee'],
  },
];

export default function ReportsPage() {
  const [selected, setSelected] = React.useState<ReportDefinition>(REPORTS[0]);
  const [periodId, setPeriodId] = React.useState('');
  const [departmentId, setDepartmentId] = React.useState('');
  const [employmentType, setEmploymentType] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [detailRow, setDetailRow] = React.useState<Record<string, string | number> | null>(null);
  const [from, setFrom] = React.useState(dayjs().startOf('month').format('YYYY-MM-DD'));
  const [to, setTo] = React.useState(dayjs().endOf('month').format('YYYY-MM-DD'));
  const [downloading, setDownloading] = React.useState<string | null>(null);

  const { data: periods = [] } = useQuery({
    queryKey: ['payroll-periods'],
    queryFn: payrollApi.listPeriods,
  });
  const { data: departments = [] } = useQuery({
    queryKey: ['departments'],
    queryFn: settingsApi.listDepartments,
  });

  // Default the period selector to the newest period once they load.
  React.useEffect(() => {
    if (!periodId && periods.length > 0) setPeriodId(periods[0].id);
  }, [periods, periodId]);

  const params = React.useMemo(() => {
    const p: Record<string, string> = {};
    if (selected.filters.includes('period') && periodId) p.periodId = periodId;
    if (selected.filters.includes('department') && departmentId) p.departmentId = departmentId;
    if (selected.filters.includes('employmentType') && employmentType) p.employmentType = employmentType;
    if (selected.filters.includes('status') && status) p.status = status;
    if (selected.filters.includes('dateRange')) {
      p.from = from;
      p.to = to;
    }
    return p;
  }, [selected, periodId, departmentId, employmentType, status, from, to]);

  const query = useQuery({
    queryKey: ['report', selected.type, params],
    queryFn: () => reportApi.get(selected.type, params),
  });

  const download = async (format: 'csv' | 'excel' | 'pdf') => {
    setDownloading(format);
    try {
      const search = new URLSearchParams({ ...params, format }).toString();
      const ext = format === 'excel' ? 'xlsx' : format;
      await downloadFile(
        `/api/reports/${selected.type}?${search}`,
        `${selected.type}-${dayjs().format('YYYYMMDD-HHmm')}.${ext}`
      );
      toast.success('ดาวน์โหลดไฟล์เรียบร้อยแล้ว');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      setDownloading(null);
    }
  };

  const report = query.data;
  const previewColumns = report?.kind === 'detailed-payroll'
    ? report.columns.filter((column) => ['employee_code', 'employee_name', 'employment_type', 'present_days', 'worked_hours', 'late_count', 'leave_days', 'absent_days', 'gross_income', 'total_deduction', 'net_salary'].includes(column.key))
    : report?.columns ?? [];
  const displayValue = (key: string, value: string | number | undefined) => {
    if (value === undefined || value === '') return '-';
    const column = report?.columns.find((item) => item.key === key);
    return column?.format === 'currency'
      ? Number(value).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : value;
  };

  return (
    <div>
      <PageHeader
        title="รายงาน"
        description="ดูข้อมูลสรุปและส่งออกเป็นไฟล์ Excel, CSV หรือ PDF"
      />

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        {/* Report picker */}
        <Card className="h-fit p-2">
          <div className="grid gap-1">
            {REPORTS.map((definition) => (
              <button
                key={definition.type}
                type="button"
                onClick={() => setSelected(definition)}
                className={cn(
                  'rounded-lg px-3 py-2.5 text-left text-sm transition-colors',
                  selected.type === definition.type
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-accent'
                )}
              >
                <span className="block font-medium">{definition.label}</span>
                <span
                  className={cn(
                    'mt-0.5 block text-xs',
                    selected.type === definition.type
                      ? 'text-primary-foreground/75'
                      : 'text-muted-foreground'
                  )}
                >
                  {definition.description}
                </span>
              </button>
            ))}
          </div>
        </Card>

        <div className="space-y-4">
          <Card className="p-4">
            <div className="grid gap-3 md:grid-cols-4">
              {selected.filters.includes('period') && (
                <Field label="รอบเงินเดือน">
                  <Select value={periodId} onChange={(e) => setPeriodId(e.target.value)}>
                    <option value="">ทุกรอบ</option>
                    {periods.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              {selected.filters.includes('dateRange') && (
                <>
                  <Field label="ตั้งแต่วันที่">
                    <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                  </Field>
                  <Field label="ถึงวันที่">
                    <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                  </Field>
                </>
              )}
              {selected.filters.includes('department') && (
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
              )}
              {selected.filters.includes('employmentType') && (
                <Field label="ประเภทพนักงาน">
                  <Select value={employmentType} onChange={(e) => setEmploymentType(e.target.value)}>
                    <option value="">ทุกประเภท</option>
                    <option value="MONTHLY">รายเดือน</option><option value="DAILY">รายวัน</option>
                    <option value="HOURLY">รายชั่วโมง</option><option value="CONTRACT">สัญญาจ้าง</option>
                  </Select>
                </Field>
              )}
              {selected.filters.includes('status') && (
                <Field label="สถานะการคำนวณ">
                  <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="">ทุกสถานะ</option>
                    {['PENDING', 'CALCULATED', 'REVIEW', 'APPROVED', 'PAID'].map((item) => <option key={item} value={item}>{item}</option>)}
                  </Select>
                </Field>
              )}

              <div className="flex items-end gap-2 md:col-start-4 md:justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void download('excel')}
                  loading={downloading === 'excel'}
                >
                  <FileSpreadsheet className="h-4 w-4" />
                  Excel
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void download('csv')}
                  loading={downloading === 'csv'}
                >
                  <Download className="h-4 w-4" />
                  CSV
                </Button>
                <Button variant="outline" size="sm" onClick={() => void download('pdf')} loading={downloading === 'pdf'}>
                  <Printer className="h-4 w-4" />
                  PDF
                </Button>
              </div>
            </div>
          </Card>

          <Card className="overflow-hidden">
            {query.isLoading ? (
              <TableSkeleton rows={10} cols={8} />
            ) : query.isError ? (
              <ErrorState
                message={apiErrorMessage(query.error)}
                onRetry={() => void query.refetch()}
              />
            ) : !report || report.rows.length === 0 ? (
              <EmptyState
                icon={<FileText className="h-6 w-6" />}
                title="ไม่มีข้อมูลในรายงานนี้"
                description="ลองปรับตัวกรองหรือเลือกรอบเงินเดือนอื่น"
              />
            ) : (
              <div className="print-area">
                <CardContent className="border-b border-border">
                  <h2 className="text-base font-semibold">{report.title}</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {Object.entries(report.meta)
                      .map(([key, value]) => `${key}: ${value}`)
                      .join('  ·  ')}
                  </p>
                </CardContent>
                {report.summary && (
                  <div className="grid gap-3 border-b border-border p-4 sm:grid-cols-2 xl:grid-cols-4">
                    {[
                      ['พนักงาน', `${report.summary.employeeCount.toLocaleString('th-TH')} คน`],
                      ['รายได้รวม', Number(report.summary.grossTotal).toLocaleString('th-TH', { minimumFractionDigits: 2 })],
                      ['รายการหักรวม', Number(report.summary.deductionTotal).toLocaleString('th-TH', { minimumFractionDigits: 2 })],
                      ['เงินสุทธิ', Number(report.summary.netTotal).toLocaleString('th-TH', { minimumFractionDigits: 2 })],
                    ].map(([label, value]) => <div key={label} className="rounded-lg bg-secondary/60 p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-lg font-semibold tabular-nums">{value}</p></div>)}
                  </div>
                )}
                <div className="overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        {previewColumns.map((col) => (
                          <th key={col.key} className={col.numeric ? 'text-right' : undefined}>
                            {col.header}
                          </th>
                        ))}
                        {report.kind === 'detailed-payroll' && <th className="w-12"><span className="sr-only">รายละเอียด</span></th>}
                      </tr>
                    </thead>
                    <tbody>
                      {report.rows.map((row, i) => (
                        <tr key={i}>
                          {previewColumns.map((col) => (
                            <td key={col.key} className={col.numeric ? 'num' : undefined}>
                              {displayValue(col.key, row[col.key])}
                            </td>
                          ))}
                          {report.kind === 'detailed-payroll' && <td><Button variant="ghost" size="sm" onClick={() => setDetailRow(row)} aria-label="ดูรายละเอียด"><Eye className="h-4 w-4" /></Button></td>}
                        </tr>
                      ))}
                    </tbody>
                    {report.totals && (
                      <tfoot>
                        <tr className="border-t-2 border-border bg-secondary/60 font-semibold">
                          {previewColumns.map((col) => (
                            <td
                              key={col.key}
                              className={cn('px-3 py-2.5', col.numeric && 'num')}
                            >
                              {report.totals?.[col.key] ?? ''}
                            </td>
                          ))}
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
                <div className="border-t border-border px-4 py-3 text-sm text-muted-foreground">
                  ทั้งหมด {report.rows.length.toLocaleString('th-TH')} รายการ
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
      <Dialog open={Boolean(detailRow)} onOpenChange={(open) => !open && setDetailRow(null)}>
        <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto" title="รายละเอียดเงินเดือนรายบุคคล" description={detailRow ? `${detailRow.employee_code} · ${detailRow.employee_name}` : undefined}>
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {report?.columns.map((column) => <div key={column.key} className="border-b border-border pb-2"><p className="text-xs text-muted-foreground">{column.header}</p><p className={cn('mt-1 text-sm', column.numeric && 'text-right tabular-nums')}>{displayValue(column.key, detailRow?.[column.key])}</p></div>)}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
