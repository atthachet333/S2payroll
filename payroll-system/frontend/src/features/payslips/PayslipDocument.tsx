import { AlertTriangle, Download, Printer } from 'lucide-react';
import { Button, Dialog, DialogContent, Skeleton } from '@/components/ui';
import { formatDateLong, formatMoney, formatNumber } from '@/utils/format';
import { EMPLOYMENT_TYPE_LABELS } from '@/components/StatusBadge';
import { cn } from '@/utils/cn';
import PayslipBoundary from '@/features/payslips/PayslipBoundary';
import PayslipPrintPortal from '@/features/payslips/PayslipPrintPortal';
import {
  hasDerivedBases,
  isDraftSnapshot,
  resolvePayBasis,
} from '@/features/payslips/payslipSnapshot';
import type { PayslipSnapshot } from '@/types';

/**
 * The on-screen payslip.
 *
 * Deliberately built to the same structure as the server-rendered PDF - same
 * header, same pay-basis strip, same two columns, same net band - so what a
 * user approves on screen is what lands in the file. A preview that looks
 * materially different from the document is worse than no preview at all.
 *
 * Printing does not print this dialog. A second copy of the same sheet is
 * mounted on document.body by PayslipPrintPortal and is the only thing visible
 * inside @media print - the dialog panel's fixed positioning and transform make
 * it unprintable. The server PDF remains the canonical download.
 */

const BRAND = 'S2A-PAYROLL';

/** 4715 -> "78 ชม. 35 นาที" */
export const formatDuration = (minutes: number): string => {
  const safe = Math.max(0, Math.round(minutes));
  return `${Math.floor(safe / 60)} ชม. ${safe % 60} นาที`;
};

export function PayslipSheet({ snapshot }: { snapshot: PayslipSnapshot }) {
  const { company, employee, period, attendance, incomes, deductions, totals } = snapshot;
  // Read through the tolerant accessors: an older frozen snapshot must render,
  // not throw. See payslipSnapshot.ts for why.
  const pay = resolvePayBasis(snapshot);
  const isDraft = isDraftSnapshot(snapshot);
  const showDerivedBases = hasDerivedBases(pay);
  // Absent on snapshots frozen before payable time was recorded; those fall
  // back to the older single-figure layout rather than printing a false zero.
  const payableMinutes =
    pay.kind === 'HOURLY' && typeof pay.payableMinutes === 'number' && pay.payableMinutes > 0
      ? pay.payableMinutes
      : null;
  const breakMinutes = pay.breakDeductionMinutes ?? 0;

  return (
    <div className="payslip-sheet print-page relative mx-auto w-full max-w-[794px] overflow-hidden bg-white p-8 text-[13px] leading-relaxed text-slate-900">
      {isDraft && (
        <div
          aria-hidden
          data-payslip-watermark
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <span className="-rotate-[30deg] text-[86px] font-bold text-[#1e3a8a] opacity-[0.08]">
            ฉบับร่าง
          </span>
        </div>
      )}

      <div className="relative">
        {/* Brand + document header */}
        <div className="payslip-header flex items-start justify-between gap-6 border-b-2 border-[#1e3a8a] pb-3">
          <div className="flex items-start gap-3">
            <div className="payslip-logo h-12 w-12 shrink-0 overflow-hidden rounded-full border border-slate-200 bg-white">
              <img
                src="/images/s2a-payroll-icon.png"
                alt=""
                className="h-full w-full object-cover"
              />
            </div>
            <div>
              <h1 className="payslip-brand text-lg font-bold tracking-tight text-[#1e3a8a]">{BRAND}</h1>
              <p className="text-xs text-slate-500">ระบบบริหารเงินเดือน</p>
              <p className="mt-1.5 text-sm font-semibold">{company.name}</p>
              {company.address && (
                <p className="max-w-md text-[11px] text-slate-600">{company.address}</p>
              )}
              <div className="flex gap-3 text-[11px] text-slate-600">
                {company.taxId && <span>เลขประจำตัวผู้เสียภาษี: {company.taxId}</span>}
                {company.phone && <span>โทร. {company.phone}</span>}
              </div>
            </div>
          </div>
          <div className="shrink-0 text-right">
            <h2 className="payslip-title text-base font-bold">ใบสลิปเงินเดือน</h2>
            <p className="text-xs text-slate-500">PAY SLIP</p>
            <p className="mt-2 text-[11px] text-slate-500">รอบ</p>
            <p className="text-sm font-bold text-[#1e3a8a]">{period.name}</p>
          </div>
        </div>

        {/* Employee identity */}
        <div className="payslip-employee mt-3 grid grid-cols-2 gap-x-8 gap-y-1 text-xs">
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
          <Row
            label="ประเภทพนักงาน"
            value={EMPLOYMENT_TYPE_LABELS[employee.employmentType] ?? employee.employmentType ?? '-'}
          />
          <Row label="เลขที่ประกันสังคม" value={employee.socialSecurity ?? '-'} />
        </div>

        {/* How this person is paid, in their own terms */}
        <div className="payslip-basis mt-3 grid grid-cols-3 gap-2 rounded border border-slate-300 bg-[#eef2ff] px-3 py-2.5 print-border">
          {pay.kind === 'HOURLY' ? (
            <>
              <Basis
                label="อัตราค่าจ้าง"
                value={
                  pay.payConfigured ? `${formatMoney(pay.hourlyRate)} บาท/ชม.` : 'ยังไม่กำหนด'
                }
              />
              {/* Actual and paid hours are shown as two figures, never one. A
                  day past eight hours loses an unpaid break and the remainder
                  is floored, so presenting paid hours as the hours worked
                  would misstate what the employee actually did. */}
              <Basis label="ชั่วโมงทำงานจริง" value={formatDuration(pay.workedMinutes)} />
              {payableMinutes !== null ? (
                <Basis label="ชั่วโมงคิดค่าจ้าง" value={formatDuration(payableMinutes)} />
              ) : (
                <Basis
                  label="ค่าจ้างตามเวลาทำงาน"
                  value={pay.payConfigured ? `${formatMoney(totals.grossIncome)} บาท` : '-'}
                />
              )}
            </>
          ) : (
            <>
              <Basis
                label="เงินเดือน"
                value={
                  pay.payConfigured ? `${formatMoney(pay.monthlySalary)} บาท/เดือน` : 'ยังไม่กำหนด'
                }
              />
              {/* Labelled as derived so nobody reads them as a second wage. */}
              {showDerivedBases ? (
                <>
                  <Basis label="ฐานต่อวัน (คำนวณ)" value={`${formatMoney(pay.dailyBase)} บาท`} />
                  <Basis
                    label="ฐานต่อชั่วโมง (คำนวณ)"
                    value={`${formatMoney(pay.hourlyBase)} บาท`}
                  />
                </>
              ) : (
                <Basis label="รอบการจ่าย" value={`${period.startDate} ถึง ${period.endDate}`} />
              )}
            </>
          )}
        </div>

        {/* Attendance */}
        <div className="payslip-attendance mt-3 grid grid-cols-4 gap-2 rounded border border-slate-300 p-2.5 text-xs print-border">
          <Metric label="วันทำงานในรอบ" value={formatNumber(attendance.workingDays)} />
          <Metric label="วันที่มาทำงาน" value={formatNumber(attendance.presentDays)} />
          <Metric label="ชั่วโมงทำงาน" value={formatNumber(attendance.workingHours, 2)} />
          <Metric label="ชั่วโมง OT" value={formatNumber(attendance.otHours, 2)} />
          <Metric label="มาสาย" value={`${formatNumber(attendance.lateCount)} ครั้ง`} />
          <Metric label="นาทีที่สาย" value={formatNumber(attendance.lateMinutes)} />
          <Metric label="ขาดงาน" value={`${formatNumber(attendance.absentDays)} วัน`} />
          <Metric label="ลา" value={`${formatNumber(attendance.leaveDays, 1)} วัน`} />
          {breakMinutes > 0 && (
            <Metric label="หักเวลาพัก" value={formatDuration(breakMinutes)} />
          )}
        </div>

        {/* Earnings / deductions */}
        <div className="payslip-lines mt-3 grid grid-cols-2 gap-4">
          <LineBlock
            title="รายได้"
            lines={incomes}
            total={totals.grossIncome}
            totalLabel="รวมรายได้"
            accent="text-[#0f766e]"
          />
          <LineBlock
            title="รายการหัก"
            lines={deductions}
            total={totals.totalDeduction}
            totalLabel="รวมรายการหัก"
            accent="text-[#b91c1c]"
          />
        </div>

        {/* Net pay - the one figure the reader is looking for */}
        <div className="payslip-net-band mt-4 flex items-center justify-between rounded bg-[#1e3a8a] px-5 py-4 text-white print-navy">
          <div>
            <p className="text-[11px] text-indigo-200">รับสุทธิ</p>
            <p className="text-sm font-bold">เงินเดือนสุทธิที่ได้รับ</p>
          </div>
          <span className="payslip-net text-2xl font-bold tabular-nums">
            {formatMoney(totals.netSalary)} บาท
          </span>
        </div>

        <div className="payslip-signatures mt-10 grid grid-cols-2 gap-16 text-xs">
          <Signature label="ผู้จ่ายเงิน" />
          <Signature label="ผู้รับเงิน" />
        </div>

        <p className="payslip-footer mt-6 text-center text-[10px] text-slate-500">
          เอกสารนี้เป็นข้อมูลลับเฉพาะบุคคล กรุณาเก็บรักษาไว้เป็นหลักฐาน · ออกโดย {BRAND}
        </p>
      </div>
    </div>
  );
}

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex gap-2">
    <span className="w-28 shrink-0 text-slate-500">{label}</span>
    <span className="truncate font-medium">{value}</span>
  </div>
);

const Basis = ({ label, value }: { label: string; value: string }) => (
  <div>
    <p className="text-[10px] text-slate-500">{label}</p>
    <p className="text-sm font-bold tabular-nums text-[#1e3a8a]">{value}</p>
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
  accent,
}: {
  title: string;
  lines: { label: string; quantity: string | null; amount: string }[];
  total: string;
  totalLabel: string;
  accent: string;
}) {
  return (
    <div className="rounded border border-slate-300 print-border">
      <div className="border-b border-slate-300 bg-[#eef2ff] px-3 py-1.5 text-xs font-bold text-[#1e3a8a] print-border">
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
                <td className="px-3 py-1.5">{line.label}</td>
                <td
                  className={cn('whitespace-nowrap px-3 py-1.5 text-right tabular-nums', accent)}
                >
                  {formatMoney(line.amount)}
                </td>
              </tr>
            ))
          )}
        </tbody>
        <tfoot>
          <tr className="border-t border-slate-400 bg-slate-50 font-bold">
            <td className="px-3 py-1.5">{totalLabel}</td>
            <td className={cn('px-3 py-1.5 text-right tabular-nums', accent)}>
              {formatMoney(total)}
            </td>
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

/** Preview dialog with print and server-PDF download controls. */
export default function PayslipDocument({
  open,
  onOpenChange,
  snapshot,
  loading,
  error,
  onRetry,
  onDownloadPdf,
  downloading,
  onEdit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: PayslipSnapshot | null;
  loading?: boolean;
  /** Set when the preview could not be fetched, so the dialog can say why. */
  error?: string | null;
  onRetry?: () => void;
  /** Omitted for a live preview that has no issued payslip to download yet. */
  onDownloadPdf?: () => void;
  downloading?: boolean;
  /** Omitted when the period is settled or the user cannot edit payroll. */
  onEdit?: () => void;
}) {
  // The printable copy lives outside the dialog entirely - see
  // PayslipPrintPortal for why printing the dialog itself cannot work.
  const printable = !loading && !error && snapshot ? snapshot : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <PayslipPrintPortal snapshot={printable} />}
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto p-0">
        <div className="no-print sticky top-0 z-10 flex items-center justify-between border-b border-border bg-white px-5 py-3">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold">ตัวอย่างสลิปเงินเดือน</p>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
              ขนาดสลิป A5
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              ปิด
            </Button>
            {onEdit && (
              <Button variant="outline" size="sm" onClick={onEdit}>
                แก้ไข
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.print()}
              disabled={!snapshot || Boolean(error)}
            >
              <Printer className="h-4 w-4" />
              พิมพ์
            </Button>
            {onDownloadPdf && (
              <Button
                size="sm"
                loading={downloading}
                onClick={onDownloadPdf}
                disabled={!snapshot || Boolean(error)}
              >
                <Download className="h-4 w-4" />
                ดาวน์โหลด PDF
              </Button>
            )}
          </div>
        </div>

        <div className="bg-slate-100 p-4">
          {/* A failed fetch must be visible here, not only in the console -
              silently showing a skeleton forever is what made this look like a
              dead button. */}
          {error ? (
            <div className="mx-auto max-w-[794px] rounded-lg border border-danger/30 bg-danger-soft/60 px-5 py-6 text-sm text-danger-fg">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                <div className="min-w-0">
                  <p className="font-semibold">ไม่สามารถเปิดสลิปเงินเดือนได้</p>
                  <p className="mt-1">{error}</p>
                  {onRetry && (
                    <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
                      ลองอีกครั้ง
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ) : loading ? (
            <Skeleton className="mx-auto h-[800px] w-full max-w-[794px]" />
          ) : !snapshot ? (
            <div className="mx-auto max-w-[794px] rounded-lg border border-warning/30 bg-warning-soft/60 px-5 py-6 text-sm text-warning-fg">
              <p className="font-semibold">ไม่สามารถเปิดสลิปเงินเดือนได้</p>
              <p className="mt-1">ยังไม่มีผลการคำนวณเงินเดือนของพนักงานคนนี้ในรอบนี้</p>
            </div>
          ) : (
            <PayslipBoundary>
              <div className="shadow-pop">
                <PayslipSheet snapshot={snapshot} />
              </div>
            </PayslipBoundary>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
