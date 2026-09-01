import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import {
  formatDuration,
  payslipFilename,
  renderPayslipPdf,
  resolveLogoPath,
} from '../src/services/payslip-pdf.service.js';
import type { PayslipSnapshot } from '../src/services/payslip.service.js';

const source = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/**
 * The payslip document: what it says, what it looks like and who may change it.
 *
 * The PDF is rendered here for real rather than asserted about in the abstract,
 * because the failure mode that matters - a font that will not load, a logo path
 * that does not resolve on the server, a layout that throws on an empty
 * deduction list - only appears when bytes are actually produced.
 */

const snapshot = (over: Partial<PayslipSnapshot> = {}): PayslipSnapshot => ({
  company: {
    name: 'บริษัท เอสทูเอ จำกัด',
    nameEn: 'S2A Co., Ltd.',
    address: '123 ถนนสุขุมวิท กรุงเทพฯ',
    taxId: '0105558000000',
    phone: '02-000-0000',
  },
  employee: {
    employeeCode: 'S2A004',
    name: 'ปุณศรา วงษ์จำรัส',
    nickname: null,
    department: 'ปฏิบัติการ',
    position: 'เจ้าหน้าที่',
    employmentType: 'MONTHLY',
    bankName: 'กสิกรไทย',
    bankAccount: '123-4-56789-0',
    taxId: null,
    socialSecurity: '1234567890123',
  },
  pay: {
    kind: 'MONTHLY',
    hourlyRate: null,
    monthlySalary: '18000.00',
    dailyBase: '600.00',
    hourlyBase: '75.00',
    workedMinutes: 10560,
    breakDeductionMinutes: 0,
    payableMinutes: 0,
    roundedAwayMinutes: 0,
    lateMinutes: 10,
    roundedLateMinutes: 0,
    lateChargedHours: 0,
    payConfigured: true,
  },
  period: {
    code: '2026-08',
    name: 'สิงหาคม 2026',
    startDate: '2026-08-01',
    endDate: '2026-08-31',
    status: 'APPROVED',
  },
  paymentDate: '2026-08-28',
  attendance: {
    workingDays: 26,
    presentDays: 25,
    absentDays: 1,
    leaveDays: '0',
    lateCount: 1,
    lateMinutes: 10,
    workingHours: '176.00',
    otHours: '0',
  },
  incomes: [{ label: 'เงินเดือนพื้นฐาน', quantity: null, rate: null, amount: '18000.00' }],
  deductions: [
    { label: 'หักมาสาย (10 นาที · คิด 1 ชั่วโมง)', quantity: '10', rate: '75', amount: '75.00' },
    { label: 'หักขาดงาน (1.00 วัน)', quantity: '1', rate: '600', amount: '600.00' },
    { label: 'ประกันสังคม', quantity: null, rate: null, amount: '750.00' },
    { label: 'ภาษีหัก ณ ที่จ่าย', quantity: null, rate: null, amount: '100.00' },
  ],
  totals: { grossIncome: '18000.00', totalDeduction: '1525.00', netSalary: '16475.00' },
  ...over,
});

const dailySnapshot = () =>
  snapshot({
    employee: { ...snapshot().employee, employeeCode: 'S2A002', employmentType: 'DAILY' },
    pay: {
      kind: 'HOURLY',
      hourlyRate: '75.00',
      monthlySalary: null,
      dailyBase: '600.00',
      hourlyBase: '75.00',
      workedMinutes: 4715,
      // 12 days over eight hours would each lose an hour; this fixture keeps
      // the arithmetic simple and states the paid figure explicitly.
      breakDeductionMinutes: 0,
      payableMinutes: 4710,
      roundedAwayMinutes: 5,
      lateMinutes: 0,
      roundedLateMinutes: 0,
      lateChargedHours: 0,
      payConfigured: true,
    },
    attendance: {
      workingDays: 26,
      presentDays: 12,
      absentDays: 0,
      leaveDays: '0',
      lateCount: 0,
      lateMinutes: 0,
      // 78.58 hours is what the 4,715 worked minutes actually come to; the
      // monthly figure inherited from the base fixture made the recovered
      // hourly rate nonsense.
      workingHours: '78.58',
      otHours: '0',
    },
    incomes: [{ label: 'ค่าจ้างตามเวลาทำงาน', quantity: '78.58', rate: '75', amount: '5893.75' }],
    deductions: [],
    totals: { grossIncome: '5893.75', totalDeduction: '0.00', netSalary: '5893.75' },
  });

const render = (s: PayslipSnapshot) =>
  renderPayslipPdf({
    snapshot: s,
    payslipNo: `PS-2026-08-${s.employee.employeeCode}`,
    employeeCode: s.employee.employeeCode,
    periodCode: '2026-08',
  });

// ---------------------------------------------------------------------------
// Filename
// ---------------------------------------------------------------------------

describe('payslip filename', () => {
  it('uses the brand, the employee code and the period', () => {
    expect(payslipFilename('S2A004', '2026-08')).toBe('S2A-PAYROLL_S2A004_2026-08.pdf');
  });

  it('sanitises anything unsafe in a path or a ZIP entry', () => {
    const name = payslipFilename('../../etc/passwd', '2026/08');
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
    expect(/^[\x20-\x7E]+$/.test(name)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------

describe('brand mark', () => {
  it('resolves an existing frontend asset rather than a duplicated copy', () => {
    const resolved = resolveLogoPath();
    expect(resolved).not.toBeNull();
    expect(existsSync(resolved!)).toBe(true);
    // It must come from the frontend's own public assets - a second copy inside
    // the backend would be a second thing to keep in step.
    expect(resolved!.replace(/\\/g, '/')).toContain('frontend/public/images/');
  });

  it('does not introduce a competing logo file in the backend', () => {
    expect(existsSync(new URL('../assets', import.meta.url))).toBe(false);
  });

  it('degrades to a text header instead of failing when no mark resolves', () => {
    const pdf = source('src/services/payslip-pdf.service.ts');
    // The image call is guarded, and a failure falls back rather than throwing.
    expect(pdf).toContain('if (LOGO_PATH)');
    expect(pdf).toContain('} catch {');
  });

  it('clips the PDF mark to a real circle', () => {
    const pdf = source('src/services/payslip-pdf.service.ts');
    expect(pdf).toContain('.circle(');
    expect(pdf).toContain('.clip()');
    expect(pdf).toContain("'s2a-payroll-icon.png'");
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('PDF generation', () => {
  it('produces a real PDF for a monthly employee', async () => {
    const buffer = await render(snapshot());
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(10_000);
  });

  it('produces a real PDF for a daily employee with no deductions at all', async () => {
    // An empty deduction column used to be the easiest way to break the layout.
    const buffer = await render(dailySnapshot());
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(10_000);
  });

  it('embeds the brand mark, so the document is not text-only', async () => {
    const withLogo = await render(snapshot());
    // An embedded image makes the file substantially larger than the text alone.
    expect(withLogo.length).toBeGreaterThan(100_000);
  });

  it('renders a single page for one employee', async () => {
    const buffer = await render(snapshot());
    const pageCount = (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pageCount).toBe(1);
  });

  it('renders on an A5 portrait MediaBox', async () => {
    const buffer = await render(snapshot());
    const text = buffer.toString('latin1');
    expect(text).toContain('/MediaBox [0 0 419.53 595.28]');
    const pdf = source('src/services/payslip-pdf.service.ts');
    expect(pdf).toContain("size: 'A5'");
    expect(pdf).not.toContain("size: 'A4'");
  });

  it('marks a period that is still being reviewed as a draft', () => {
    const pdf = source('src/services/payslip-pdf.service.ts');
    expect(pdf).toContain("const DRAFT_STATUSES = ['DRAFT', 'ATTENDANCE_REVIEW', 'CALCULATED', 'REVIEW']");
    expect(pdf).toContain('drawDraftWatermark');
    expect(pdf).toContain('ฉบับร่าง');
  });

  it('does not watermark an approved period', async () => {
    // Both render; the assertion is that the status drives the branch at all.
    const approved = await render(snapshot());
    const draft = await render(
      snapshot({ period: { ...snapshot().period, status: 'CALCULATED' } })
    );
    expect(draft.length).not.toBe(approved.length);
  });
});

// ---------------------------------------------------------------------------
// Layout content
// ---------------------------------------------------------------------------

describe('the document is honest about how each employee is paid', () => {
  const pdf = source('src/services/payslip-pdf.service.ts');

  it('shows a rate and worked time for hourly staff, not a monthly salary', () => {
    const fn = pdf.slice(pdf.indexOf('function drawPayBasis'), pdf.indexOf('function baseAmount'));
    expect(fn).toContain('อัตราค่าจ้าง');
    // Actual and paid hours are two separate figures: a day past eight hours
    // loses an unpaid break and is floored, so printing one as the other would
    // misstate what the employee worked.
    expect(fn).toContain('ชั่วโมงทำงานจริง');
    expect(fn).toContain('ชั่วโมงคิดค่าจ้าง');
    // Older snapshots carry no payable figure and fall back to the amount.
    expect(fn).toContain('ค่าจ้างตามเวลาทำงาน');
  });

  it('labels the monthly per-day and per-hour figures as derived', () => {
    const fn = pdf.slice(pdf.indexOf('function drawPayBasis'), pdf.indexOf('function baseAmount'));
    expect(fn).toContain('ฐานต่อวัน (คำนวณ)');
    expect(fn).toContain('ฐานต่อชั่วโมง (คำนวณ)');
  });

  it('formats a worked duration in hours and minutes', () => {
    expect(formatDuration(4715)).toBe('78 ชม. 35 นาที');
    expect(formatDuration(60)).toBe('1 ชม. 0 นาที');
    expect(formatDuration(0)).toBe('0 ชม. 0 นาที');
  });

  it('carries the brand and the period in the header', () => {
    expect(pdf).toContain("const BRAND = 'S2A-PAYROLL'");
    expect(pdf).toContain("const BRAND_TAGLINE = 'ระบบบริหารเงินเดือน'");
    expect(pdf).toContain('ใบสลิปเงินเดือน');
    expect(pdf).toContain('s.period.name');
  });

  it('makes net pay the most prominent figure', () => {
    // A filled band and the largest type on the page.
    expect(pdf).toContain('รับสุทธิ');
    expect(pdf).toContain('fontSize(15)');
  });
});

// ---------------------------------------------------------------------------
// Preview parity and print
// ---------------------------------------------------------------------------

describe('the on-screen payslip matches the printed one', () => {
  const sheet = source('../frontend/src/features/payslips/PayslipDocument.tsx');
  const css = source('../frontend/src/index.css');

  it('uses the same sections as the PDF', () => {
    for (const section of ['ใบสลิปเงินเดือน', 'รายได้', 'รายการหัก', 'รับสุทธิ', 'S2A-PAYROLL']) {
      expect(sheet).toContain(section);
    }
  });

  it('branches on employment type the same way the PDF does', () => {
    expect(sheet).toContain("pay.kind === 'HOURLY'");
    expect(sheet).toContain('อัตราค่าจ้าง');
    expect(sheet).toContain('ฐานต่อวัน (คำนวณ)');
  });

  it('shows the same draft marking', () => {
    const shared = source('../frontend/src/features/payslips/payslipSnapshot.ts');
    expect(shared).toContain("export const DRAFT_STATUSES = ['DRAFT', 'ATTENDANCE_REVIEW', 'CALCULATED', 'REVIEW']");
    expect(sheet).toContain('ฉบับร่าง');
  });

  it('offers print and PDF actions', () => {
    expect(sheet).toContain('พิมพ์');
    expect(sheet).toContain('ดาวน์โหลด PDF');
    expect(sheet).toContain('window.print()');
  });

  it('uses the same existing brand asset as the PDF', () => {
    expect(sheet).toContain('/images/s2a-payroll-icon.png');
    expect(sheet).toContain('rounded-full');
    expect(sheet).toContain('overflow-hidden');
    expect(sheet).toContain('object-cover');
  });
});

describe('print styles', () => {
  const css = source('../frontend/src/index.css');
  const printBlock = css.slice(css.indexOf('@media print'));
  const doc = source('../frontend/src/features/payslips/PayslipDocument.tsx');
  const portal = source('../frontend/src/features/payslips/PayslipPrintPortal.tsx');

  it('prints A5 portrait with compact margins', () => {
    expect(printBlock).toContain('size: A5 portrait');
    expect(printBlock).toContain('margin: 7mm');
    expect(printBlock).not.toContain('A4');
  });

  it('prints from a dedicated root mounted on document.body', () => {
    // Printing the dialog itself cannot work: the panel is position:fixed and
    // transform-centred, which makes it a containing block, so print rules
    // resolved against the panel instead of the page.
    expect(portal).toContain("id=\"payslip-print-root\"");
    expect(portal).toContain('document.body');
    expect(doc).toContain('<PayslipPrintPortal snapshot={printable} />');
  });

  it('keeps that root out of the on-screen layout', () => {
    // Declared outside the print block, so the second copy of the sheet is
    // never visible on screen.
    const beforePrint = css.slice(0, css.indexOf('@media print'));
    expect(beforePrint).toContain('#payslip-print-root');
    expect(beforePrint).toContain('display: none;');
  });

  it('removes every other top-level subtree from the printed page', () => {
    // display:none, not visibility:hidden - a hidden box still occupies space
    // and can push content onto a second sheet.
    expect(printBlock).toContain('body > *:not(#payslip-print-root)');
    expect(printBlock).toContain('display: none !important');
  });

  it('strips modal positioning from the printed copy', () => {
    expect(printBlock).toContain('#payslip-print-root * {');
    expect(printBlock).toContain('position: static !important');
    expect(printBlock).toContain('transform: none !important');
  });

  it('spares the draft watermark, which is positioned on purpose', () => {
    expect(printBlock).toContain('[data-payslip-watermark]');
    expect(doc).toContain('data-payslip-watermark');
  });

  it('prints on white with no scroll container', () => {
    expect(printBlock).toContain('background: #fff !important');
    expect(printBlock).toContain('overflow: visible !important');
    expect(printBlock).toContain('max-height: none !important');
  });

  it('preserves the colours that carry meaning', () => {
    expect(printBlock).toContain('print-color-adjust: exact !important');
    expect(printBlock).toContain('.print-navy');
    expect(printBlock).toContain('#1e3a8a');
  });

  it('sizes the type for one readable A5 page', () => {
    expect(printBlock).toContain('font-size: 7.5pt !important');
    expect(printBlock).toContain('font-size: 13pt !important');
    expect(printBlock).toContain('font-size: 10.5pt !important');
    expect(printBlock).toContain('font-size: 14pt !important');
  });

  it('keeps right-aligned text off the trim edge', () => {
    expect(printBlock).toContain('padding: 0 2mm !important');
  });

  it('keeps a payslip section from splitting across pages', () => {
    expect(printBlock).toContain('break-inside: avoid');
    expect(printBlock).toContain('page-break-after: auto');
  });

  it('still hides anything explicitly marked no-print', () => {
    expect(printBlock).toContain('.no-print');
  });
});

describe('the dialog chrome never reaches the paper', () => {
  const doc = source('../frontend/src/features/payslips/PayslipDocument.tsx');
  const css = source('../frontend/src/index.css');
  const printBlock = css.slice(css.indexOf('@media print'));

  it('marks the toolbar as no-print', () => {
    expect(doc).toContain('className="no-print');
  });

  it('excludes the whole dialog subtree regardless', () => {
    // The toolbar sits inside the dialog, and the dialog is not the print root,
    // so it is removed by the top-level rule even without .no-print.
    expect(printBlock).toContain('body > *:not(#payslip-print-root)');
  });

  it('does not print the on-screen copy of the sheet', () => {
    // The old .print-area wrapper is gone; the screen copy is a plain wrapper.
    expect(doc).not.toContain('className="print-area');
  });

  it('leaves the on-screen preview otherwise untouched', () => {
    for (const kept of ['S2A-PAYROLL', 'ระบบบริหารเงินเดือน', 'รับสุทธิ', 'print-navy']) {
      expect(doc).toContain(kept);
    }
    expect(doc).toContain('/images/s2a-payroll-icon.png');
  });
});

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

describe('payslip editing', () => {
  const payroll = source('src/services/payroll.service.ts');
  const dialog = source('../frontend/src/features/payroll/PayslipEditDialog.tsx');
  const drawer = source('../frontend/src/features/payroll/PayrollEmployeeDrawer.tsx');
  const page = source('../frontend/src/pages/PayrollDetailPage.tsx');

  it('wires the preview Edit button to the usable adjustment dialog', () => {
    expect(drawer).toContain('onEdit={canEdit ? () => { setPrintOpen(false); setEditOpen(true); }');
    expect(drawer).toContain('<PayslipEditDialog');
    expect(dialog).toContain('title="แก้ไขรายการเงินเดือน"');
  });

  it('allows only draft through review and refuses approved, paid or locked periods', () => {
    expect(payroll).toContain('const FINANCIALLY_EDITABLE: PayrollPeriodStatus[] = [');
    for (const status of ['DRAFT', 'ATTENDANCE_REVIEW', 'CALCULATED', 'REVIEW']) {
      expect(payroll).toContain(`PayrollPeriodStatus.${status}`);
    }
    expect(payroll).toContain('if (!FINANCIALLY_EDITABLE.includes(status))');
    expect(payroll).toContain('assertFinanciallyEditable(period.status)');
    expect(page).toContain("['DRAFT', 'ATTENDANCE_REVIEW', 'CALCULATED', 'REVIEW'].includes(period.status)");
  });

  it('edits payroll inputs, not the generated document', () => {
    for (const field of ['bonusAmount', 'allowanceAmount', 'commissionAmount', 'otherIncome']) {
      expect(dialog).toContain(field);
    }
    for (const field of ['socialSecurity', 'tax', 'otherDeduction', 'lateDeduction']) {
      expect(dialog).toContain(field);
    }
  });

  it('does not offer base pay as a free-text field', () => {
    // Base pay is derived from the rate and attendance; it is corrected there.
    expect(dialog).not.toMatch(/key:\s*'baseSalary'/);
  });

  it('requires a reason before saving', () => {
    expect(dialog).toContain('เหตุผลในการแก้ไข');
    expect(dialog).toContain('reason.trim().length < 3');
  });

  it('sends only the fields that actually changed', () => {
    expect(dialog).toContain('const changed = FIELDS.filter(');
    expect(dialog).toContain('adjustments: changed.map(');
  });

  it('recalculates the totals after saving', () => {
    expect(payroll).toContain('await refreshPeriodTotals(periodId)');
    expect(dialog).toContain('บันทึกและคำนวณยอดใหม่');
    expect(dialog).toContain("['payslip-preview', periodId, row!.employeeId]");
    expect(dialog).toContain('onSaved?.()');
  });

  it('writes an adjustment row for every change', () => {
    expect(payroll).toContain('tx.payrollAdjustment.createMany');
    expect(payroll).toContain("action: 'PAYROLL_EMPLOYEE_ADJUSTMENT'");
  });

  it('shows policy values as read-only context without writing the policy endpoint', () => {
    expect(dialog).toContain('นโยบายพนักงาน (อ่านอย่างเดียว)');
    expect(dialog).toContain('row.employee.payrollPolicy');
    expect(dialog).not.toContain('savePayrollPolicy');
  });

  it('labels every monetary field in baht', () => {
    expect(dialog).toContain('บาท');
    expect(dialog).toContain('pr-12');
  });
});

// ---------------------------------------------------------------------------
// Preview availability and failure handling
// ---------------------------------------------------------------------------

describe('payslip preview availability', () => {
  const svc = source('src/services/payslip.service.ts');
  const preview = svc.slice(svc.indexOf('export async function previewPayslip'));

  it('is built from the calculated payroll row, not from a persisted payslip', () => {
    expect(preview).toContain('prisma.payrollEmployee.findUnique');
    expect(preview).not.toContain('prisma.payslip.findUnique');
  });

  it('is not gated on the payroll workflow status', () => {
    // Every status from DRAFT through LOCKED can be previewed; only *issuing* a
    // payslip is approval-gated, and that is a different function.
    for (const status of ['APPROVED', 'PAID', 'LOCKED', 'CALCULATED']) {
      expect(preview).not.toContain(`'${status}'`);
    }
    expect(preview).not.toContain('period.status');
  });

  it('issuing a payslip stays approval-gated, unlike previewing', () => {
    const generate = svc.slice(svc.indexOf('export async function generatePayslips'));
    expect(generate).toContain("['APPROVED', 'PAID', 'LOCKED'].includes(period.status)");
  });

  it('explains each failure in Thai rather than returning a bare not-found', () => {
    expect(preview).toContain('ไม่พบรายการเงินเดือนของพนักงานคนนี้ในรอบนี้');
    expect(preview).toContain('ยังไม่มีผลการคำนวณเงินเดือนของพนักงานคนนี้ในรอบนี้');
  });

  it('distinguishes an unknown period from an uncalculated employee', () => {
    expect(preview).toContain("notFound('Payroll period')");
    expect(preview).toContain('!row.calculatedAt');
  });
});

describe('the preview survives an older snapshot', () => {
  const sheet = source('../frontend/src/features/payslips/PayslipDocument.tsx');

  it('derives the pay basis when the snapshot predates the field', () => {
    // A snapshot is frozen at issue time, so a payslip issued before `pay`
    // existed will never gain it. Reading it directly threw mid-render and left
    // the dialog blank - the exact failure this guards against.
    const shared = source('../frontend/src/features/payslips/payslipSnapshot.ts');
    expect(shared).toContain('export function resolvePayBasis');
    expect(shared).toContain('if (snapshot.pay) return snapshot.pay');
    expect(sheet).toContain('const pay = resolvePayBasis(snapshot)');
  });

  it('never dereferences the optional fields directly', () => {
    expect(sheet).not.toContain('snapshot.pay.kind');
    expect(sheet).toContain('const isDraft = isDraftSnapshot(snapshot)');
  });

  it('hides the derived bases rather than printing a confident zero', () => {
    expect(sheet).toContain('const showDerivedBases =');
  });

  it('types the optional fields as optional, so the compiler enforces this', () => {
    const types = source('../frontend/src/types/index.ts');
    expect(types).toContain('pay?: PayslipPayBasis;');
    expect(types).toContain('status?: PayrollPeriodStatus;');
  });
});

describe('a failed preview is never silent', () => {
  const sheet = source('../frontend/src/features/payslips/PayslipDocument.tsx');
  const boundary = source('../frontend/src/features/payslips/PayslipBoundary.tsx');
  const drawer = source('../frontend/src/features/payroll/PayrollEmployeeDrawer.tsx');

  it('shows a Thai error in the dialog when the fetch fails', () => {
    expect(sheet).toContain('ไม่สามารถเปิดสลิปเงินเดือนได้');
    expect(sheet).toContain('onRetry');
  });

  it('says so when there is no calculation to show', () => {
    expect(sheet).toContain('ยังไม่มีผลการคำนวณเงินเดือนของพนักงานคนนี้ในรอบนี้');
  });

  it('catches a render failure instead of unmounting to a blank dialog', () => {
    expect(boundary).toContain('getDerivedStateFromError');
    expect(boundary).toContain('ไม่สามารถแสดงสลิปเงินเดือนได้');
    expect(sheet).toContain('<PayslipBoundary>');
  });

  it('keeps the stack trace out of the user interface', () => {
    expect(boundary).toContain('console.error');
    expect(boundary).not.toContain('error.stack');
    expect(boundary).not.toContain('{String(error)}');
  });

  it('wires the query error through from the payroll drawer', () => {
    expect(drawer).toContain('error={previewQuery.isError ? apiErrorMessage(previewQuery.error) : null}');
    expect(drawer).toContain('onRetry={() => void previewQuery.refetch()}');
  });

  it('disables print and PDF while the preview is unusable', () => {
    expect(sheet).toContain('disabled={!snapshot || Boolean(error)}');
  });
});

// ---------------------------------------------------------------------------
// The exact shapes that caused the render crash
// ---------------------------------------------------------------------------

describe('older snapshot shapes render instead of throwing', () => {
  const shared = source('../frontend/src/features/payslips/payslipSnapshot.ts');
  const types = source('../frontend/src/types/index.ts');

  it('returns the stored pay basis when the snapshot has one', () => {
    expect(shared).toContain('if (snapshot.pay) return snapshot.pay');
  });

  it('recovers an hourly rate from the pay and the hours when it does not', () => {
    expect(shared).toContain("snapshot.employee?.employmentType === 'DAILY'");
    expect(shared).toContain('(Number(base) / hours).toFixed(2)');
    // Guarded against a divide-by-zero on a snapshot with no recorded hours.
    expect(shared).toContain('hourly && hours > 0');
  });

  it('reads every optional field defensively', () => {
    for (const access of [
      'snapshot.employee?.employmentType',
      'snapshot.incomes?.[0]?.amount',
      'snapshot.attendance?.workingHours',
      'snapshot.period?.status',
    ]) {
      expect(shared).toContain(access);
    }
  });

  it('does not fabricate the derived bases it cannot recover', () => {
    expect(shared).toContain("dailyBase: '0.00'");
    expect(shared).toContain("hourlyBase: '0.00'");
    expect(shared).toContain('export function hasDerivedBases');
  });

  it('does not mark a snapshot without a status as a draft', () => {
    // Stamping "ฉบับร่าง" across a real payslip is the worse mistake.
    expect(shared).toContain('return status ? DRAFT_STATUSES.includes(status) : false');
  });

  it('makes the compiler enforce this, not just the tests', () => {
    // With `pay` optional, any direct snapshot.pay.x dereference is a build
    // error in the frontend - a stronger guarantee than an assertion here.
    expect(types).toContain('pay?: PayslipPayBasis;');
    expect(types).toContain('status?: PayrollPeriodStatus;');
  });
});
