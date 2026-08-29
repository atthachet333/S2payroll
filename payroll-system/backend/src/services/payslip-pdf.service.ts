import { createRequire } from 'node:module';
import fs from 'node:fs';
import PDFDocument from 'pdfkit';
import { prisma } from '../plugins/prisma.js';
import { dec, money } from '../utils/money.js';
import { notFound, unprocessable } from '../utils/errors.js';
import type { PayslipSnapshot } from './payslip.service.js';

/**
 * Server-side payslip PDF.
 *
 * Rendered exclusively from the payslip snapshot stored in the database - the
 * same frozen payload the on-screen preview uses. No total is ever taken from
 * the client, and the rendered figures are re-checked against the payroll row
 * before a byte is written.
 *
 * Thai text is rendered with Sarabun (SIL Open Font License), shipped as a
 * package dependency rather than relying on a font being installed on the host.
 */

const require = createRequire(import.meta.url);

/** Resolve a bundled font through node resolution so it works from src/ and dist/. */
function resolveFont(subpath: string): string {
  try {
    return require.resolve(`@expo-google-fonts/sarabun/${subpath}`);
  } catch {
    // The package exposes the .ttf as a plain file; fall back to a path probe.
    const pkg = require.resolve('@expo-google-fonts/sarabun/package.json');
    return pkg.replace(/package\.json$/, subpath);
  }
}

const FONT_REGULAR = resolveFont('400Regular/Sarabun_400Regular.ttf');
const FONT_BOLD = resolveFont('700Bold/Sarabun_700Bold.ttf');

/** Verified once at startup so a packaging mistake fails loudly, not per-request. */
export function assertFontsAvailable(): void {
  for (const path of [FONT_REGULAR, FONT_BOLD]) {
    if (!fs.existsSync(path)) {
      throw new Error(`Payslip PDF font missing: ${path}`);
    }
  }
}

const REGULAR = 'Sarabun';
const BOLD = 'Sarabun-Bold';

// A4 at 72dpi, with a 40pt margin.
const PAGE = { size: 'A4' as const, margin: 40 };
const CONTENT_WIDTH = 595.28 - PAGE.margin * 2;

const NAVY = '#1e3a8a';
const INK = '#0f172a';
const MUTED = '#64748b';
const RULE = '#cbd5e1';

const fmt = (value: string | number): string =>
  Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Build a filename that is safe on every filesystem and inside a ZIP:
 * ASCII only, no separators, no traversal.
 */
export function payslipFilename(employeeCode: string, periodCode: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'unknown';
  return `payslip-${safe(employeeCode)}-${safe(periodCode)}.pdf`;
}

export interface PayslipPdfData {
  snapshot: PayslipSnapshot;
  payslipNo: string;
  employeeCode: string;
  periodCode: string;
}

/**
 * Load a payslip and verify its snapshot still agrees with the payroll row.
 * A payslip whose stored totals have drifted from the payroll record is a
 * reconciliation failure and must not be handed out as a document.
 */
export async function loadPayslipForPdf(payslipId: string): Promise<PayslipPdfData> {
  const payslip = await prisma.payslip.findUnique({
    where: { id: payslipId },
    include: {
      employee: { select: { employeeCode: true } },
      period: { select: { code: true } },
      payrollEmployee: {
        select: { netSalary: true, grossIncome: true, totalDeduction: true },
      },
    },
  });
  if (!payslip) throw notFound('Payslip');

  const snapshot = payslip.snapshot as unknown as PayslipSnapshot;

  // 1. The snapshot's own lines must sum to the totals it states.
  const incomeSum = snapshot.incomes.reduce((a, l) => a.plus(dec(l.amount)), dec(0));
  const deductionSum = snapshot.deductions.reduce((a, l) => a.plus(dec(l.amount)), dec(0));

  if (!money(incomeSum).equals(money(snapshot.totals.grossIncome))) {
    throw unprocessable(
      `Payslip ${payslip.payslipNo}: income lines (${money(incomeSum).toFixed(2)}) do not sum to the stated gross (${money(snapshot.totals.grossIncome).toFixed(2)})`
    );
  }
  if (!money(deductionSum).equals(money(snapshot.totals.totalDeduction))) {
    throw unprocessable(
      `Payslip ${payslip.payslipNo}: deduction lines (${money(deductionSum).toFixed(2)}) do not sum to the stated total (${money(snapshot.totals.totalDeduction).toFixed(2)})`
    );
  }

  // 2. gross - deductions must equal net.
  const computedNet = money(dec(snapshot.totals.grossIncome).minus(dec(snapshot.totals.totalDeduction)));
  if (!computedNet.equals(money(snapshot.totals.netSalary))) {
    throw unprocessable(
      `Payslip ${payslip.payslipNo}: gross minus deductions (${computedNet.toFixed(2)}) does not equal the stated net (${money(snapshot.totals.netSalary).toFixed(2)})`
    );
  }

  // 3. The snapshot must still match the live payroll row.
  if (!money(snapshot.totals.netSalary).equals(money(payslip.payrollEmployee.netSalary))) {
    throw unprocessable(
      `Payslip ${payslip.payslipNo}: snapshot net (${money(snapshot.totals.netSalary).toFixed(2)}) does not match the payroll record (${money(payslip.payrollEmployee.netSalary).toFixed(2)}). Re-issue the payslip.`
    );
  }

  return {
    snapshot,
    payslipNo: payslip.payslipNo,
    employeeCode: payslip.employee.employeeCode,
    periodCode: payslip.period.code,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

type Doc = InstanceType<typeof PDFDocument>;

function drawHeader(doc: Doc, s: PayslipSnapshot): void {
  const top = doc.y;

  doc.font(BOLD).fontSize(15).fillColor(NAVY).text(s.company.name, PAGE.margin, top, { width: 340 });
  doc.font(REGULAR).fontSize(8.5).fillColor(MUTED);
  if (s.company.nameEn) doc.text(s.company.nameEn, { width: 340 });
  if (s.company.address) doc.text(s.company.address, { width: 340 });
  const meta = [
    s.company.taxId ? `เลขประจำตัวผู้เสียภาษี: ${s.company.taxId}` : null,
    s.company.phone ? `โทร. ${s.company.phone}` : null,
  ].filter(Boolean);
  if (meta.length) doc.text(meta.join('   '), { width: 340 });

  // Document title, right aligned against the same top edge.
  doc.font(BOLD).fontSize(14).fillColor(INK).text('สลิปเงินเดือน', 380, top, {
    width: CONTENT_WIDTH - 340,
    align: 'right',
  });
  doc.font(REGULAR).fontSize(8.5).fillColor(MUTED).text('PAY SLIP', {
    width: CONTENT_WIDTH - 340,
    align: 'right',
  });
  doc.font(BOLD).fontSize(11).fillColor(INK).text(s.period.name, {
    width: CONTENT_WIDTH - 340,
    align: 'right',
  });

  const y = Math.max(doc.y, top + 62) + 6;
  doc.moveTo(PAGE.margin, y).lineTo(PAGE.margin + CONTENT_WIDTH, y).lineWidth(1.5).strokeColor(NAVY).stroke();
  doc.y = y + 10;
}

function drawEmployeeBlock(doc: Doc, s: PayslipSnapshot): void {
  const rows: [string, string, string, string][] = [
    ['รหัสพนักงาน', s.employee.employeeCode, 'รอบการจ่าย', `${s.period.startDate} ถึง ${s.period.endDate}`],
    ['ชื่อ-นามสกุล', s.employee.name, 'วันที่จ่าย', s.paymentDate ?? '-'],
    ['แผนก', s.employee.department ?? '-', 'ธนาคาร', s.employee.bankName ?? '-'],
    ['ตำแหน่ง', s.employee.position ?? '-', 'เลขที่บัญชี', s.employee.bankAccount ?? '-'],
  ];

  const colL = PAGE.margin;
  const colR = PAGE.margin + CONTENT_WIDTH / 2;
  doc.fontSize(9);

  for (const [l1, v1, l2, v2] of rows) {
    const y = doc.y;
    doc.font(REGULAR).fillColor(MUTED).text(l1, colL, y, { width: 78 });
    doc.font(BOLD).fillColor(INK).text(v1, colL + 80, y, { width: CONTENT_WIDTH / 2 - 90 });
    doc.font(REGULAR).fillColor(MUTED).text(l2, colR, y, { width: 70 });
    doc.font(BOLD).fillColor(INK).text(v2, colR + 72, y, { width: CONTENT_WIDTH / 2 - 82 });
    doc.y = y + 14;
  }
  doc.y += 4;
}

function drawAttendance(doc: Doc, s: PayslipSnapshot): void {
  const a = s.attendance;
  const cells: [string, string][] = [
    ['วันทำงานในรอบ', String(a.workingDays)],
    ['วันที่มาทำงาน', String(a.presentDays)],
    ['ชั่วโมงทำงาน', fmt(a.workingHours)],
    ['ชั่วโมง OT', fmt(a.otHours)],
    ['มาสาย (ครั้ง)', String(a.lateCount)],
    ['นาทีที่สาย', String(a.lateMinutes)],
    ['ขาดงาน (วัน)', String(a.absentDays)],
    ['ลา (วัน)', fmt(a.leaveDays)],
  ];

  const top = doc.y;
  const colW = CONTENT_WIDTH / 4;
  const rowH = 26;
  const rows = Math.ceil(cells.length / 4);

  doc.rect(PAGE.margin, top, CONTENT_WIDTH, rowH * rows).lineWidth(0.5).strokeColor(RULE).stroke();

  cells.forEach((cell, i) => {
    const x = PAGE.margin + (i % 4) * colW;
    const y = top + Math.floor(i / 4) * rowH;
    doc.font(REGULAR).fontSize(7.5).fillColor(MUTED).text(cell[0], x + 6, y + 5, { width: colW - 12 });
    doc.font(BOLD).fontSize(9.5).fillColor(INK).text(cell[1], x + 6, y + 14, { width: colW - 12 });
  });

  doc.y = top + rowH * rows + 12;
}

/** One income/deduction column. Returns the y coordinate it finished at. */
function drawLineBlock(
  doc: Doc,
  title: string,
  lines: { label: string; amount: string }[],
  total: string,
  totalLabel: string,
  x: number,
  y: number,
  width: number
): number {
  const headerH = 18;
  const rowH = 15;
  const bodyRows = Math.max(lines.length, 1);
  const height = headerH + bodyRows * rowH + rowH;

  doc.rect(x, y, width, height).lineWidth(0.5).strokeColor(RULE).stroke();
  doc.rect(x, y, width, headerH).fillColor('#f1f5f9').fill();
  doc.font(BOLD).fontSize(9).fillColor(INK).text(title, x + 8, y + 5, { width: width - 16 });

  let cursor = y + headerH;
  if (lines.length === 0) {
    doc.font(REGULAR).fontSize(8.5).fillColor(MUTED).text('ไม่มีรายการ', x + 8, cursor + 4, { width: width - 16 });
    cursor += rowH;
  } else {
    for (const line of lines) {
      doc.font(REGULAR).fontSize(8.5).fillColor(INK).text(line.label, x + 8, cursor + 4, {
        width: width - 90,
        ellipsis: true,
        lineBreak: false,
      });
      doc.text(fmt(line.amount), x + width - 82, cursor + 4, { width: 74, align: 'right' });
      cursor += rowH;
    }
  }

  doc.moveTo(x, cursor).lineTo(x + width, cursor).lineWidth(0.5).strokeColor(RULE).stroke();
  doc.font(BOLD).fontSize(9).fillColor(INK).text(totalLabel, x + 8, cursor + 4, { width: width - 90 });
  doc.text(fmt(total), x + width - 82, cursor + 4, { width: 74, align: 'right' });

  return y + height;
}

function drawSignatures(doc: Doc, y: number): void {
  const colW = CONTENT_WIDTH / 2 - 30;
  for (const [i, label] of ['ผู้จ่ายเงิน', 'ผู้รับเงิน'].entries()) {
    const cx = PAGE.margin + i * (CONTENT_WIDTH / 2 + 20);
    doc
      .moveTo(cx + 20, y + 34)
      .lineTo(cx + colW - 20, y + 34)
      .dash(2, { space: 2 })
      .lineWidth(0.5)
      .strokeColor(RULE)
      .stroke()
      .undash();
    doc.font(REGULAR).fontSize(8).fillColor(MUTED).text(`(${label})`, cx, y + 40, {
      width: colW,
      align: 'center',
    });
    doc.text('วันที่ ......... / ......... / .........', cx, y + 52, { width: colW, align: 'center' });
  }
}

/** Render one payslip to a PDF buffer. */
export async function renderPayslipPdf(data: PayslipPdfData): Promise<Buffer> {
  const { snapshot: s } = data;

  const doc = new PDFDocument({
    size: PAGE.size,
    margin: PAGE.margin,
    info: {
      Title: `Payslip ${data.payslipNo}`,
      Author: s.company.name,
      Subject: `${s.employee.name} - ${s.period.name}`,
      Creator: s.company.name,
      Producer: s.company.name,
    },
  });

  doc.registerFont(REGULAR, FONT_REGULAR);
  doc.registerFont(BOLD, FONT_BOLD);
  doc.font(REGULAR);

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    doc.on('end', () => resolve());
    doc.on('error', reject);
  });

  drawHeader(doc, s);
  drawEmployeeBlock(doc, s);
  drawAttendance(doc, s);

  const colW = CONTENT_WIDTH / 2 - 6;
  const blockTop = doc.y;
  const leftBottom = drawLineBlock(
    doc, 'รายได้', s.incomes, s.totals.grossIncome, 'รวมรายได้',
    PAGE.margin, blockTop, colW
  );
  const rightBottom = drawLineBlock(
    doc, 'รายการหัก', s.deductions, s.totals.totalDeduction, 'รวมรายการหัก',
    PAGE.margin + colW + 12, blockTop, colW
  );

  // Net pay box
  const netY = Math.max(leftBottom, rightBottom) + 14;
  doc.rect(PAGE.margin, netY, CONTENT_WIDTH, 34).lineWidth(1.2).strokeColor(NAVY).stroke();
  doc.font(BOLD).fontSize(11).fillColor(INK).text('เงินเดือนสุทธิที่ได้รับ', PAGE.margin + 12, netY + 11);
  doc.fontSize(14).fillColor(NAVY).text(
    `${fmt(s.totals.netSalary)} บาท`,
    PAGE.margin + CONTENT_WIDTH / 2,
    netY + 9,
    { width: CONTENT_WIDTH / 2 - 12, align: 'right' }
  );

  drawSignatures(doc, netY + 48);

  doc.font(REGULAR).fontSize(7).fillColor(MUTED).text(
    'เอกสารนี้เป็นข้อมูลลับเฉพาะบุคคล กรุณาเก็บรักษาไว้เป็นหลักฐาน',
    PAGE.margin,
    netY + 120,
    { width: CONTENT_WIDTH, align: 'center' }
  );

  doc.end();
  await done;
  return Buffer.concat(chunks);
}

/** Convenience: load, verify and render in one call. */
export async function generatePayslipPdf(payslipId: string): Promise<{
  buffer: Buffer;
  filename: string;
  payslipNo: string;
}> {
  const data = await loadPayslipForPdf(payslipId);
  return {
    buffer: await renderPayslipPdf(data),
    filename: payslipFilename(data.employeeCode, data.periodCode),
    payslipNo: data.payslipNo,
  };
}
