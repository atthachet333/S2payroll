import * as React from 'react';
import { toast } from 'sonner';
import { Download, FileText } from 'lucide-react';
import { payslipApi } from '@/services/endpoints';
import { apiErrorMessage, downloadFile } from '@/services/api';
import PayslipDocument from '@/features/payslips/PayslipDocument';
import { Badge, Button, EmptyState, Field, Select } from '@/components/ui';
import { PeriodStatusBadge } from '@/components/StatusBadge';
import { formatDate, formatMoney } from '@/utils/format';
import type { Payslip, PayrollPeriodStatus } from '@/types';

/**
 * Payslip history for one employee: a dedicated section rather than more rows
 * on the employee summary, so the main page stays readable.
 *
 * Gross and deductions come from the payslip's frozen snapshot, which is what
 * the employee was actually given - not a recomputation.
 */
export default function PayslipHistory({ payslips }: { payslips: Payslip[] }) {
  const [year, setYear] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [viewing, setViewing] = React.useState<Payslip | null>(null);
  const [downloading, setDownloading] = React.useState<string | null>(null);

  // Year options come from the payslips themselves, so the filter never offers
  // a year with nothing behind it.
  const years = React.useMemo(
    () =>
      [...new Set(payslips.map((p) => p.snapshot?.period?.code?.slice(0, 4)).filter(Boolean))].sort(
        (a, b) => String(b).localeCompare(String(a))
      ) as string[],
    [payslips]
  );

  const statuses = React.useMemo(
    () => [...new Set(payslips.map((p) => p.period?.status).filter(Boolean))] as PayrollPeriodStatus[],
    [payslips]
  );

  const filtered = payslips.filter((p) => {
    if (year && p.snapshot?.period?.code?.slice(0, 4) !== year) return false;
    if (status && p.period?.status !== status) return false;
    return true;
  });

  const download = async (slip: Payslip) => {
    setDownloading(slip.id);
    try {
      await downloadFile(payslipApi.pdfPath(slip.id), `${slip.payslipNo}.pdf`);
      toast.success('ดาวน์โหลดสลิปเงินเดือนเรียบร้อยแล้ว');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      setDownloading(null);
    }
  };

  if (payslips.length === 0) {
    return (
      <EmptyState
        icon={<FileText className="h-6 w-6" />}
        title="ยังไม่มีสลิปเงินเดือน"
        description="สลิปจะปรากฏที่นี่หลังจากรอบเงินเดือนได้รับการอนุมัติและออกสลิปแล้ว"
      />
    );
  }

  return (
    <div className="space-y-3">
      {(years.length > 1 || statuses.length > 1) && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="ปี">
            <Select value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="">ทุกปี</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="สถานะรอบเงินเดือน">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">ทุกสถานะ</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}

      {filtered.length === 0 ? (
        <EmptyState title="ไม่พบสลิปตามเงื่อนไขที่เลือก" />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>รอบเงินเดือน</th>
                <th>เลขที่สลิป</th>
                <th>วันที่จ่าย</th>
                <th className="text-right">รายได้รวม</th>
                <th className="text-right">รายการหัก</th>
                <th className="text-right">เงินสุทธิ</th>
                <th>สถานะ</th>
                <th className="w-[150px]" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((slip) => (
                <tr key={slip.id}>
                  <td className="font-medium">{slip.period?.name ?? slip.snapshot?.period?.name ?? '-'}</td>
                  <td className="text-muted-foreground">{slip.payslipNo}</td>
                  <td className="text-muted-foreground">
                    {formatDate(slip.paymentDate ?? slip.issuedAt)}
                  </td>
                  <td className="num">{formatMoney(slip.snapshot?.totals?.grossIncome)}</td>
                  <td className="num text-danger">
                    {formatMoney(slip.snapshot?.totals?.totalDeduction)}
                  </td>
                  <td className="num font-semibold">{formatMoney(slip.netSalary)}</td>
                  <td>
                    {slip.period?.status ? (
                      <PeriodStatusBadge status={slip.period.status} />
                    ) : (
                      <Badge variant="secondary">ออกแล้ว</Badge>
                    )}
                  </td>
                  <td>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setViewing(slip)}>
                        ดู
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        loading={downloading === slip.id}
                        onClick={() => void download(slip)}
                      >
                        <Download className="h-4 w-4" />
                        PDF
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PayslipDocument
        open={Boolean(viewing)}
        onOpenChange={(open) => !open && setViewing(null)}
        snapshot={viewing?.snapshot ?? null}
      />
    </div>
  );
}
