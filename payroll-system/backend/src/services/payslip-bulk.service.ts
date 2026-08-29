import { ZipArchive } from 'archiver';
import type { Readable } from 'node:stream';
import { prisma } from '../plugins/prisma.js';
import { badRequest, notFound } from '../utils/errors.js';
import {
  loadPayslipForPdf,
  payslipFilename,
  renderPayslipPdf,
} from './payslip-pdf.service.js';

/**
 * Bulk payslip export for a payroll period, delivered as a streamed ZIP.
 *
 * PDFs are rendered one at a time and appended to the archive as they are
 * produced, so memory stays flat regardless of headcount rather than holding
 * every document at once.
 */

/** Periods whose figures are settled enough to hand out as documents. */
const EXPORTABLE_STATUSES = ['APPROVED', 'PAID', 'LOCKED'];

export interface BulkExportPlan {
  periodId: string;
  periodCode: string;
  periodName: string;
  payslipIds: string[];
  zipFilename: string;
}

/**
 * Validate the period and collect the payslips to include.
 * Throws before any streaming begins, so a rejected export returns a clean JSON
 * error instead of a truncated ZIP.
 */
export async function planBulkExport(periodId: string): Promise<BulkExportPlan> {
  const period = await prisma.payrollPeriod.findUnique({
    where: { id: periodId },
    select: { id: true, code: true, name: true, status: true },
  });
  if (!period) throw notFound('Payroll period');

  if (!EXPORTABLE_STATUSES.includes(period.status)) {
    throw badRequest(
      `ต้องอนุมัติรอบเงินเดือนก่อนจึงจะดาวน์โหลดสลิปทั้งหมดได้ (สถานะปัจจุบัน: ${period.status})`
    );
  }

  const payslips = await prisma.payslip.findMany({
    where: { periodId },
    // Deterministic ordering means the same period always produces the same archive.
    orderBy: { payslipNo: 'asc' },
    select: { id: true },
  });

  if (payslips.length === 0) {
    throw badRequest('ยังไม่มีสลิปเงินเดือนในรอบนี้ กรุณากด "ออกสลิปเงินเดือน" ก่อน');
  }

  const safeCode = period.code.replace(/[^A-Za-z0-9_-]/g, '') || 'period';

  return {
    periodId: period.id,
    periodCode: period.code,
    periodName: period.name,
    payslipIds: payslips.map((p) => p.id),
    zipFilename: `payslips-${safeCode}.zip`,
  };
}

export interface BulkExportResult {
  stream: Readable;
  /** Resolves once every entry has been appended and the archive finalised. */
  completed: Promise<{ included: number; failed: { payslipId: string; message: string }[] }>;
}

/**
 * Build the ZIP stream. The caller pipes `stream` straight to the HTTP reply.
 *
 * A payslip that fails verification is skipped and reported rather than
 * aborting the whole export - one bad row should not deny payroll staff the
 * other 200 documents. Skipped entries are listed in a MANIFEST inside the ZIP.
 */
export function streamBulkExport(plan: BulkExportPlan): BulkExportResult {
  const archive = new ZipArchive({ zlib: { level: 9 } });

  const completed = (async () => {
    const failed: { payslipId: string; message: string }[] = [];
    const usedNames = new Set<string>();
    let included = 0;

    for (const payslipId of plan.payslipIds) {
      try {
        const data = await loadPayslipForPdf(payslipId);
        const buffer = await renderPayslipPdf(data);

        // Guarantee uniqueness even if two rows somehow share an employee code.
        let name = payslipFilename(data.employeeCode, data.periodCode);
        if (usedNames.has(name)) {
          let n = 2;
          const base = name.replace(/\.pdf$/, '');
          while (usedNames.has(`${base}-${n}.pdf`)) n += 1;
          name = `${base}-${n}.pdf`;
        }
        usedNames.add(name);

        archive.append(buffer, { name });
        included += 1;
      } catch (err) {
        failed.push({
          payslipId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const manifest = [
      `Payroll period : ${plan.periodName} (${plan.periodCode})`,
      `Generated      : ${new Date().toISOString()}`,
      `Payslips        : ${included} of ${plan.payslipIds.length}`,
      '',
      ...(failed.length > 0
        ? ['Excluded (failed verification):', ...failed.map((f) => `  ${f.payslipId}: ${f.message}`)]
        : ['All payslips exported successfully.']),
      '',
    ].join('\n');
    archive.append(manifest, { name: 'MANIFEST.txt' });

    await archive.finalize();
    return { included, failed };
  })();

  return { stream: archive as unknown as Readable, completed };
}
