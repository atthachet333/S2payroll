import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Banknote, Eye, Printer } from 'lucide-react';
import { payrollApi, payslipApi } from '@/services/endpoints';
import { apiErrorMessage } from '@/services/api';
import PayslipDocument from '@/features/payslips/PayslipDocument';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Pagination,
  Select,
  TableSkeleton,
} from '@/components/ui';
import { formatDate, formatMoney } from '@/utils/format';
import type { Payslip } from '@/types';

export default function PayslipsPage() {
  const [searchParams] = useSearchParams();
  const [page, setPage] = React.useState(1);
  const [periodId, setPeriodId] = React.useState('');
  const [search, setSearch] = React.useState(searchParams.get('search') ?? '');
  const [viewing, setViewing] = React.useState<Payslip | null>(null);

  React.useEffect(() => setPage(1), [periodId, search]);

  const { data: periods = [] } = useQuery({
    queryKey: ['payroll-periods'],
    queryFn: payrollApi.listPeriods,
  });

  const query = useQuery({
    queryKey: ['payslips', page, periodId, search],
    queryFn: () =>
      payslipApi.list({
        page,
        pageSize: 25,
        periodId: periodId || undefined,
        search: search || undefined,
      }),
  });

  return (
    <div>
      <PageHeader
        title="สลิปเงินเดือน"
        description="ดูตัวอย่าง พิมพ์ และบันทึกสลิปเงินเดือนเป็นไฟล์ PDF"
      />

      <Card className="mb-4 p-4">
        <div className="grid gap-3 md:grid-cols-3">
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
          <Field label="ค้นหา" className="md:col-span-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="เลขที่สลิป รหัสพนักงาน หรือชื่อ"
            />
          </Field>
        </div>
      </Card>

      <Card className="overflow-hidden">
        {query.isLoading ? (
          <TableSkeleton rows={8} cols={6} />
        ) : query.isError ? (
          <ErrorState message={apiErrorMessage(query.error)} onRetry={() => void query.refetch()} />
        ) : query.data && query.data.items.length === 0 ? (
          <EmptyState
            icon={<Banknote className="h-6 w-6" />}
            title="ยังไม่มีสลิปเงินเดือน"
            description="สลิปเงินเดือนจะถูกสร้างหลังจากอนุมัติรอบเงินเดือนและกด “ออกสลิปเงินเดือน”"
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>เลขที่สลิป</th>
                    <th>รหัสพนักงาน</th>
                    <th>ชื่อ-นามสกุล</th>
                    <th>รอบเงินเดือน</th>
                    <th>วันที่จ่าย</th>
                    <th className="text-right">เงินสุทธิ</th>
                    <th className="w-[130px]" />
                  </tr>
                </thead>
                <tbody>
                  {query.data?.items.map((slip) => (
                    <tr key={slip.id}>
                      <td className="font-medium">{slip.payslipNo}</td>
                      <td>{slip.employee?.employeeCode ?? '-'}</td>
                      <td>
                        {slip.employee
                          ? `${slip.employee.firstName} ${slip.employee.lastName}`
                          : '-'}
                      </td>
                      <td className="text-muted-foreground">{slip.period?.name ?? '-'}</td>
                      <td className="text-muted-foreground">{formatDate(slip.paymentDate)}</td>
                      <td className="num font-semibold">{formatMoney(slip.netSalary)}</td>
                      <td>
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => setViewing(slip)}>
                            <Eye className="h-4 w-4" />
                            ดู
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="พิมพ์"
                            onClick={() => {
                              setViewing(slip);
                              // Let the dialog paint before opening the print sheet.
                              setTimeout(() => window.print(), 400);
                            }}
                          >
                            <Printer className="h-4 w-4" />
                          </Button>
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

      <PayslipDocument
        open={Boolean(viewing)}
        onOpenChange={(open) => !open && setViewing(null)}
        snapshot={viewing?.snapshot ?? null}
      />
    </div>
  );
}
