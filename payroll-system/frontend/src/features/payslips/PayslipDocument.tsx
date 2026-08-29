import { Printer } from 'lucide-react';
import { Button, Dialog, DialogContent, Skeleton } from '@/components/ui';
import { formatDateLong, formatMoney, formatNumber } from '@/utils/format';
import type { PayslipSnapshot } from '@/types';

/**
 * A4-friendly payslip. The visible dialog is a faithful preview of what the
 * printed page will look like; window.print() then renders only .print-area
 * (see the @media print rules in index.css), so "Save as PDF" in the browser's
 * print dialog produces the PDF download with no application chrome.
 */
export function PayslipSheet({ snapshot }: { snapshot: PayslipSnapshot }) {
  const { company, employee, period, attendance, incomes, deductions, totals } = snapshot;

  return (
    <div className="print-page mx-auto w-full max-w-[794px] bg-white p-8 text-[13px] leading-relaxed text-slate-900">
      {/* Company header */}
      <div className="flex items-start justify-between gap-6 border-b-2 border-slate-800 pb-4">
        <div>
          <h1 className="text-lg font-bold">{company.name}</h1>
          {company.nameEn && <p className="text-xs text-slate-600">{company.nameEn}</p>}
          {company.address && <p className="mt-1 max-w-md text-xs text-slate-600">{company.address}</p>}
          <div className="mt-1 flex gap-4 text-xs text-slate-600">
            {company.taxId && <span>เลขประจำตัวผู้เสียภาษี: {company.taxId}</span>}
            {company.phone && <span>โทร. {company.phone}</span>}
          </div>
        </div>
        <div className="text-right">
          <h2 className="text-base font-bold">สลิปเงินเดือน</h2>
          <p className="text-xs text-slate-600">PAY SLIP</p>
          <p className="mt-2 text-sm font-semibold">{period.name}</p>
        </div>
      </div>

      {/* Employee block */}
      <div className="mt-4 grid grid-cols-2 gap-x-8 gap-y-1 text-xs">
        <Row label="รหัสพนักงาน" value={employee.employeeCode} />
        <Row label="รอบการจ่าย" value={`${period.startDate} ถึง ${period.endDate}`} />
        <Row
          label="ชื่อ-นามสกุล"
          value={`${employee.name}${employee.nickname ? ` (${employee.nickname})` : ''}`}
        />
        <Row
          label="วันที่จ่าย"
          value={snapshot.paymentDate ? formatDateLong(snapshot.paymentDate) : '-'}
        />
        <Row label="แผนก" value={employee.department ?? '-'} />
        <Row label="ธนาคาร" value={employee.bankName ?? '-'} />
        <Row label="ตำแหน่ง" value={employee.position ?? '-'} />
        <Row label="เลขที่บัญชี" value={employee.bankAccount ?? '-'} />
      </div>

      {/* Attendance */}
      <div className="mt-4 grid grid-cols-4 gap-2 rounded border border-slate-300 p-2.5 text-xs print-border">
        <Metric label="วันทำงาน" value={formatNumber(attendance.presentDays)} />
        <Metric label="ชั่วโมงทำงาน" value={formatNumber(attendance.workingHours, 2)} />
        <Metric label="ชั่วโมง OT" value={formatNumber(attendance.otHours, 2)} />
        <Metric label="มาสาย" value={`${formatNumber(attendance.lateCount)} ครั้ง`} />
        <Metric label="ขาดงาน" value={`${formatNumber(attendance.absentDays)} วัน`} />
        <Metric label="ลา" value={`${formatNumber(attendance.leaveDays, 1)} วัน`} />
        <Metric label="นาทีที่สาย" value={formatNumber(attendance.lateMinutes)} />
        <Metric label="วันทำงานในรอบ" value={formatNumber(attendance.workingDays)} />
      </div>

      {/* Income / deduction columns */}
      <div className="mt-4 grid grid-cols-2 gap-4">
        <LineBlock title="รายได้" lines={incomes} total={totals.grossIncome} totalLabel="รวมรายได้" />
        <LineBlock
          title="รายการหัก"
          lines={deductions}
          total={totals.totalDeduction}
          totalLabel="รวมรายการหัก"
        />
      </div>

      {/* Net */}
      <div className="mt-4 flex items-center justify-between rounded border-2 border-slate-800 px-4 py-3 print-border">
        <span className="text-sm font-bold">เงินเดือนสุทธิที่ได้รับ</span>
        <span className="text-lg font-bold tabular-nums">{formatMoney(totals.netSalary)} บาท</span>
      </div>

      <div className="mt-10 grid grid-cols-2 gap-16 text-xs">
        <Signature label="ผู้จ่ายเงิน" />
        <Signature label="ผู้รับเงิน" />
      </div>

      <p className="mt-6 text-center text-[10px] text-slate-500">
        เอกสารนี้เป็นข้อมูลลับเฉพาะบุคคล กรุณาเก็บรักษาไว้เป็นหลักฐาน
      </p>
    </div>
  );
}

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex gap-2">
    <span className="w-28 shrink-0 text-slate-500">{label}</span>
    <span className="font-medium">{value}</span>
  </div>
);

const Metric = ({ label, value }: { label: string; value: string }) => (
  <div>
    <p className="text-[10px] text-slate-500">{label}</p>
    <p className="font-semibold tabular-nums">{value}</p>
  </div>
);

function LineBlock({
  title,
  lines,
  total,
  totalLabel,
}: {
  title: string;
  lines: { label: string; quantity: string | null; amount: string }[];
  total: string;
  totalLabel: string;
}) {
  return (
    <div className="rounded border border-slate-300 print-border">
      <div className="border-b border-slate-300 bg-slate-100 px-3 py-1.5 text-xs font-bold print-border">
        {title}
      </div>
      <table className="w-full text-xs">
        <tbody>
          {lines.length === 0 ? (
            <tr>
              <td className="px-3 py-2 text-slate-500" colSpan={2}>
                ไม่มีรายการ
              </td>
            </tr>
          ) : (
            lines.map((line, i) => (
              <tr key={i} className="border-b border-slate-200 last:border-0">
                <td className="px-3 py-1.5">
                  {line.label}
                  {line.quantity && (
                    <span className="ml-1 text-slate-500">
                      ({formatNumber(line.quantity, 2)})
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">
                  {formatMoney(line.amount)}
                </td>
              </tr>
            ))
          )}
        </tbody>
        <tfoot>
          <tr className="border-t border-slate-400 bg-slate-50 font-bold">
            <td className="px-3 py-1.5">{totalLabel}</td>
            <td className="px-3 py-1.5 text-right tabular-nums">{formatMoney(total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

const Signature = ({ label }: { label: string }) => (
  <div className="text-center">
    <div className="mb-1 border-b border-dotted border-slate-400 pb-8" />
    <p className="text-slate-600">({label})</p>
    <p className="mt-1 text-slate-500">วันที่ ......... / ......... / .........</p>
  </div>
);

/** Preview dialog with print / save-as-PDF controls. */
export default function PayslipDocument({
  open,
  onOpenChange,
  snapshot,
  loading,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: PayslipSnapshot | null;
  loading?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto p-0">
        <div className="no-print sticky top-0 z-10 flex items-center justify-between border-b border-border bg-white px-5 py-3">
          <p className="text-sm font-semibold">ตัวอย่างสลิปเงินเดือน</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              ปิด
            </Button>
            <Button size="sm" onClick={() => window.print()} disabled={!snapshot}>
              <Printer className="h-4 w-4" />
              พิมพ์ / บันทึกเป็น PDF
            </Button>
          </div>
        </div>

        <div className="bg-slate-100 p-4">
          {loading || !snapshot ? (
            <Skeleton className="mx-auto h-[800px] w-full max-w-[794px]" />
          ) : (
            <div className="print-area shadow-pop">
              <PayslipSheet snapshot={snapshot} />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
