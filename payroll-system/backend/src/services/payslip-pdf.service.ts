import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

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

/**
 * The S2A-PAYROLL mark, resolved from the frontend's existing public asset
 * rather than copied into the backend. A second copy would be a second thing to
 * keep in step, and the two would eventually disagree about what the brand
 * looks like.
 *
 * Candidates are probed in order and the first that exists wins, so the PDF
 * renders correctly whether the process runs from src/ in development, from
 * dist/ under PM2, or against a built frontend. PAYSLIP_LOGO_PATH overrides
 * everything for a deployment that puts the asset somewhere else entirely.
 */
// The mark is preferred over the full logo purely on weight: both are the same
// artwork, but PDFKit stores a decoded bitmap, so the 1254px logo costs ~1.7MB
// per payslip against ~300KB for the 512px mark. At the 46pt box this renders
// into, 512px is already far beyond print resolution.
const LOGO_FILES = ['s2a-payroll-icon.png', 's2a-payroll-mark.png', 's2a-payroll-logo.png'];
const LOGO_ROOTS = [
  path.resolve(process.cwd(), '../frontend/public/images'),
  path.resolve(process.cwd(), '../frontend/dist/images'),
  path.resolve(moduleDir, '../../../frontend/public/images'),
  path.resolve(moduleDir, '../../../frontend/dist/images'),
  path.resolve(moduleDir, '../../../../frontend/public/images'),
];
const LOGO_CANDIDATES = [
  process.env.PAYSLIP_LOGO_PATH,
  ...LOGO_FILES.flatMap((file) => LOGO_ROOTS.map((root) => path.join(root, file))),
].filter((p): p is string => Boolean(p));

/** Resolved once. null means "render without a logo" - never a hard failure:
 *  a payslip missing its mark is still a correct payslip, and refusing to
 *  produce one over a missing decoration would be the worse outcome. */
export function resolveLogoPath(): string | null {
  for (const candidate of LOGO_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // An unreadable candidate is simply not the one.
    }
  }
  return null;
}

const LOGO_PATH = resolveLogoPath();

const BRAND = 'S2A-PAYROLL';
const BRAND_TAGLINE = 'ระบบบริหารเงินเดือน';

/** Periods whose figures are not yet settled, so the document is a draft. */
const DRAFT_STATUSES = ['DRAFT', 'ATTENDANCE_REVIEW', 'CALCULATED', 'REVIEW'];

// A5 portrait at 72dpi. 20pt is approximately the requested 7mm trim margin.
const PAGE = { size: 'A5' as const, margin: 20 };
const PAGE_WIDTH = 419.53;
const PAGE_HEIGHT = 595.28;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE.margin * 2;

// Restrained navy/slate palette with one accent each way: teal reads as money
// coming in, a muted rose as money going out. Anything louder competes with the
// figures, which are the only thing on the page that matters.
const NAVY = '#1e3a8a';
const NAVY_SOFT = '#eef2ff';
const INK = '#0f172a';
const MUTED = '#64748b';
const RULE = '#cbd5e1';
const RULE_SOFT = '#e2e8f0';
const TEAL = '#0f766e';
const ROSE = '#b91c1c';

const fmt = (value: string | number): string =>
  Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Build a filename that is safe on every filesystem and inside a ZIP:
 * ASCII only, no separators, no traversal.
 */
export function payslipFilename(employeeCode: string, periodCode: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'unknown';
  return `${BRAND}_${safe(employeeCode)}_${safe(periodCode)}.pdf`;
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
  let textX = PAGE.margin;

  // The mark, when it resolves. A payslip without it is still correct, so a
  // missing or unreadable file degrades to a text-only header rather than
  // failing the document.
  if (LOGO_PATH) {
    try {
      const logoSize = 40;
      doc.save();
      doc.circle(PAGE.margin + logoSize / 2, top + logoSize / 2, logoSize / 2).clip();
      doc.image(LOGO_PATH, PAGE.margin, top, {
        fit: [logoSize, logoSize],
        align: 'center',
        valign: 'center',
      });
      doc.restore();
      doc.circle(PAGE.margin + logoSize / 2, top + logoSize / 2, logoSize / 2)
        .lineWidth(0.5).strokeColor(RULE).stroke();
      textX = PAGE.margin + 48;
    } catch {
      textX = PAGE.margin;
    }
  }

  doc.font(BOLD).fontSize(11).fillColor(NAVY).text(BRAND, textX, top + 1, { width: 190 });
  doc.font(REGULAR).fontSize(6.5).fillColor(MUTED).text(BRAND_TAGLINE, textX, doc.y, { width: 190 });

  doc.font(BOLD).fontSize(7.5).fillColor(INK).text(s.company.name, textX, doc.y + 2, { width: 190 });
  doc.font(REGULAR).fontSize(6).fillColor(MUTED);
  if (s.company.address) doc.text(s.company.address, textX, doc.y + 1, { width: 190, lineBreak: false, ellipsis: true });
  const meta = [
    s.company.taxId ? `เลขประจำตัวผู้เสียภาษี: ${s.company.taxId}` : null,
    s.company.phone ? `โทร. ${s.company.phone}` : null,
  ].filter(Boolean);
  if (meta.length) doc.text(meta.join('   '), textX, doc.y + 1, { width: 190, lineBreak: false, ellipsis: true });
  // Captured before the right-hand column is drawn: writing that column resets
  // doc.y to ITS bottom, which sits higher, and the divider would then be drawn
  // straight through the company address lines.
  const leftBottom = doc.y;

  // Document title, right aligned against the same top edge.
  const rightWidth = 128;
  const rightX = PAGE.margin + CONTENT_WIDTH - rightWidth;
  doc.font(BOLD).fontSize(13).fillColor(INK).text('ใบสลิปเงินเดือน', rightX, top + 1, {
    width: rightWidth,
    align: 'right',
  });
  doc.font(REGULAR).fontSize(7).fillColor(MUTED).text('PAY SLIP', rightX, doc.y, {
    width: rightWidth,
    align: 'right',
  });
  doc.font(REGULAR).fontSize(6.5).fillColor(MUTED).text('รอบ', rightX, doc.y + 2, {
    width: rightWidth,
    align: 'right',
  });
  doc.font(BOLD).fontSize(9).fillColor(NAVY).text(s.period.name, rightX, doc.y, {
    width: rightWidth,
    align: 'right',
  });

  const y = Math.max(leftBottom, doc.y, top + 43) + 5;
  doc.moveTo(PAGE.margin, y).lineTo(PAGE.margin + CONTENT_WIDTH, y).lineWidth(1.5).strokeColor(NAVY).stroke();
  doc.y = y + 7;
}

/**
 * Who this payslip is for. Compact by design - two label/value pairs per row,
 * so the identity block never pushes the figures onto a second page.
 */
function drawEmployeeBlock(doc: Doc, s: PayslipSnapshot): void {
  const rows: [string, string, string, string][] = [
    ['รหัสพนักงาน', s.employee.employeeCode, 'รอบการจ่าย', `${s.period.startDate} ถึง ${s.period.endDate}`],
    [
      'ชื่อ-นามสกุล',
      s.employee.nickname ? `${s.employee.name} (${s.employee.nickname})` : s.employee.name,
      'วันที่จ่าย',
      s.paymentDate ?? '-',
    ],
    ['แผนก', s.employee.department ?? '-', 'ธนาคาร', s.employee.bankName ?? '-'],
    ['ตำแหน่ง', s.employee.position ?? '-', 'เลขที่บัญชี', s.employee.bankAccount ?? '-'],
    ['ประเภทพนักงาน', EMPLOYMENT_TYPE_LABEL[s.employee.employmentType] ?? s.employee.employmentType, 'เลขที่ประกันสังคม', s.employee.socialSecurity ?? '-'],
  ];

  const colL = PAGE.margin;
  const colR = PAGE.margin + CONTENT_WIDTH / 2;
  doc.fontSize(7.2);

  for (const [l1, v1, l2, v2] of rows) {
    const y = doc.y;
    doc.font(REGULAR).fillColor(MUTED).text(l1, colL, y, { width: 55 });
    doc.font(BOLD).fillColor(INK).text(v1, colL + 57, y, {
      width: CONTENT_WIDTH / 2 - 62,
      ellipsis: true,
      lineBreak: false,
    });
    doc.font(REGULAR).fillColor(MUTED).text(l2, colR, y, { width: 54 });
    doc.font(BOLD).fillColor(INK).text(v2, colR + 56, y, {
      width: CONTENT_WIDTH / 2 - 61,
      ellipsis: true,
      lineBreak: false,
    });
    doc.y = y + 10.5;
  }
  doc.y += 3;
}

const EMPLOYMENT_TYPE_LABEL: Record<string, string> = {
  MONTHLY: 'รายเดือน',
  DAILY: 'รายวัน',
  HOURLY: 'รายชั่วโมง',
  CONTRACT: 'สัญญาจ้าง',
};

/**
 * How this employee is paid, stated in their own terms.
 *
 * An hourly employee gets a rate and the hours behind it; a salaried one gets
 * their salary, with the per-day and per-hour figures labelled as derived so
 * nobody reads them as a second wage the company also owes.
 */
function drawPayBasis(doc: Doc, s: PayslipSnapshot): void {
  const hourly = s.pay.kind === 'HOURLY';
  // Actual and paid hours are printed as two figures, never one. A day past
  // eight hours loses an unpaid break and the remainder is floored, so showing
  // paid hours alone would misstate what the employee actually worked.
  const payable = s.pay.payableMinutes;
  const cells: [string, string][] = hourly
    ? [
        ['อัตราค่าจ้าง', s.pay.payConfigured ? `${fmt(s.pay.hourlyRate ?? 0)} บาท/ชม.` : 'ยังไม่กำหนด'],
        ['ชั่วโมงทำงานจริง', formatDuration(s.pay.workedMinutes)],
        typeof payable === 'number' && payable > 0
          ? ['ชั่วโมงคิดค่าจ้าง', formatDuration(payable)]
          : ['ค่าจ้างตามเวลาทำงาน', s.pay.payConfigured ? `${fmt(baseAmount(s))} บาท` : '-'],
      ]
    : [
        ['เงินเดือน', s.pay.payConfigured ? `${fmt(s.pay.monthlySalary ?? 0)} บาท/เดือน` : 'ยังไม่กำหนด'],
        ['ฐานต่อวัน (คำนวณ)', `${fmt(s.pay.dailyBase)} บาท`],
        ['ฐานต่อชั่วโมง (คำนวณ)', `${fmt(s.pay.hourlyBase)} บาท`],
      ];

  const top = doc.y;
  const height = 28;
  const colW = CONTENT_WIDTH / cells.length;

  doc.rect(PAGE.margin, top, CONTENT_WIDTH, height).fillColor(NAVY_SOFT).fill();
  doc.rect(PAGE.margin, top, CONTENT_WIDTH, height).lineWidth(0.5).strokeColor(RULE).stroke();

  cells.forEach((cell, i) => {
    const x = PAGE.margin + i * colW;
    doc.font(REGULAR).fontSize(6.2).fillColor(MUTED).text(cell[0], x + 6, top + 4, { width: colW - 12 });
    doc.font(BOLD).fontSize(8.5).fillColor(NAVY).text(cell[1], x + 6, top + 13, { width: colW - 12, lineBreak: false, ellipsis: true });
  });

  doc.y = top + height + 7;
}

/** The base pay line, used for the hourly summary. */
function baseAmount(s: PayslipSnapshot): string {
  const base = s.incomes.find((l) => l.label.includes('เงินเดือน') || l.label.includes('ค่าจ้าง'));
  return base?.amount ?? '0.00';
}

/** 4715 minutes -> "78 ชม. 35 นาที". */
export function formatDuration(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  return `${Math.floor(safe / 60)} ชม. ${safe % 60} นาที`;
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
  const rowH = 21;
  const rows = Math.ceil(cells.length / 4);

  doc.rect(PAGE.margin, top, CONTENT_WIDTH, rowH * rows).lineWidth(0.5).strokeColor(RULE).stroke();

  cells.forEach((cell, i) => {
    const x = PAGE.margin + (i % 4) * colW;
    const y = top + Math.floor(i / 4) * rowH;
    doc.font(REGULAR).fontSize(6).fillColor(MUTED).text(cell[0], x + 5, y + 3, { width: colW - 10 });
    doc.font(BOLD).fontSize(8).fillColor(INK).text(cell[1], x + 5, y + 11, { width: colW - 10 });
  });

  doc.y = top + rowH * rows + 7;
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
  width: number,
  accent: string
): number {
  const headerH = 15;
  const rowH = 12;
  const bodyRows = Math.max(lines.length, 1);
  const height = headerH + bodyRows * rowH + rowH;

  doc.rect(x, y, width, height).lineWidth(0.5).strokeColor(RULE).stroke();
  doc.rect(x, y, width, headerH).fillColor(NAVY_SOFT).fill();
  doc.font(BOLD).fontSize(7.5).fillColor(NAVY).text(title, x + 6, y + 4, { width: width - 12 });

  let cursor = y + headerH;
  if (lines.length === 0) {
    doc.font(REGULAR).fontSize(7).fillColor(MUTED).text('ไม่มีรายการ', x + 6, cursor + 3, { width: width - 12 });
    cursor += rowH;
  } else {
    for (const line of lines) {
      doc.font(REGULAR).fontSize(7).fillColor(INK).text(line.label, x + 6, cursor + 3, {
        width: width - 68,
        ellipsis: true,
        lineBreak: false,
      });
      doc.fillColor(accent).text(fmt(line.amount), x + width - 62, cursor + 3, { width: 56, align: 'right' });
      // Hairline between rows so a long column stays readable across the page.
      if (line !== lines[lines.length - 1]) {
        doc.moveTo(x + 6, cursor + rowH).lineTo(x + width - 6, cursor + rowH)
          .lineWidth(0.4).strokeColor(RULE_SOFT).stroke();
      }
      cursor += rowH;
    }
  }

  doc.moveTo(x, cursor).lineTo(x + width, cursor).lineWidth(0.5).strokeColor(RULE).stroke();
  doc.font(BOLD).fontSize(7.5).fillColor(INK).text(totalLabel, x + 6, cursor + 3, { width: width - 68 });
  doc.fillColor(accent).text(fmt(total), x + width - 62, cursor + 3, { width: 56, align: 'right' });

  return y + height;
}

/** Diagonal "ฉบับร่าง" across the page, drawn last so it sits over the content. */
function drawDraftWatermark(doc: Doc): void {
  // Translate to the page centre first, then rotate, then draw a band centred on
  // the new origin. Rotating around an absolute point and drawing at absolute
  // coordinates swung the text off the left edge of the page.
  const centreX = PAGE_WIDTH / 2;
  const centreY = PAGE_HEIGHT / 2;
  doc.save();
  doc.translate(centreX, centreY);
  doc.rotate(-30);
  doc.font(BOLD).fontSize(48).fillColor(NAVY).opacity(0.08).text('ฉบับร่าง', -190, -35, {
    width: 380,
    align: 'center',
    lineBreak: false,
  });
  doc.opacity(1);
  doc.restore();
}

function drawSignatures(doc: Doc, y: number): void {
  const colW = CONTENT_WIDTH / 2 - 12;
  for (const [i, label] of ['ผู้จ่ายเงิน', 'ผู้รับเงิน'].entries()) {
    const cx = PAGE.margin + i * (CONTENT_WIDTH / 2 + 8);
    doc
      .moveTo(cx + 12, y + 20)
      .lineTo(cx + colW - 12, y + 20)
      .dash(2, { space: 2 })
      .lineWidth(0.5)
      .strokeColor(RULE)
      .stroke()
      .undash();
    doc.font(REGULAR).fontSize(7).fillColor(MUTED).text(`(${label})`, cx, y + 25, {
      width: colW,
      align: 'center',
    });
    doc.text('วันที่ ......... / ......... / .........', cx, y + 35, { width: colW, align: 'center' });
  }
}

/** Render one payslip to a PDF buffer. */
export async function renderPayslipPdf(data: PayslipPdfData): Promise<Buffer> {
  const { snapshot: s } = data;

  const doc = new PDFDocument({
    size: PAGE.size,
    margin: PAGE.margin,
    info: {
      Title: `${BRAND} ${data.payslipNo}`,
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
  drawPayBasis(doc, s);
  drawAttendance(doc, s);

  const colW = CONTENT_WIDTH / 2 - 4;
  const blockTop = doc.y;
  const leftBottom = drawLineBlock(
    doc, 'รายได้', s.incomes, s.totals.grossIncome, 'รวมรายได้',
    PAGE.margin, blockTop, colW, TEAL
  );
  const rightBottom = drawLineBlock(
    doc, 'รายการหัก', s.deductions, s.totals.totalDeduction, 'รวมรายการหัก',
    PAGE.margin + colW + 8, blockTop, colW, ROSE
  );

  // Net pay: the one figure the reader is looking for, so it gets the weight.
  const netY = Math.max(leftBottom, rightBottom) + 9;
  const netH = 36;
  doc.rect(PAGE.margin, netY, CONTENT_WIDTH, netH).fillColor(NAVY).fill();
  doc.font(REGULAR).fontSize(7).fillColor('#c7d2fe').text('รับสุทธิ', PAGE.margin + 10, netY + 6);
  doc.font(BOLD).fontSize(8.5).fillColor('#ffffff').text(
    'เงินเดือนสุทธิที่ได้รับ',
    PAGE.margin + 10,
    netY + 17
  );
  doc.font(BOLD).fontSize(15).fillColor('#ffffff').text(
    `${fmt(s.totals.netSalary)} บาท`,
    PAGE.margin + CONTENT_WIDTH / 2,
    netY + 10,
    { width: CONTENT_WIDTH / 2 - 10, align: 'right' }
  );

  drawSignatures(doc, netY + netH + 9);

  doc.font(REGULAR).fontSize(5.8).fillColor(MUTED).text(
    `เอกสารนี้เป็นข้อมูลลับเฉพาะบุคคล กรุณาเก็บรักษาไว้เป็นหลักฐาน · ออกโดย ${BRAND}`,
    PAGE.margin,
    netY + netH + 59,
    { width: CONTENT_WIDTH, align: 'center' }
  );

  // A period still being reviewed can be printed, but the paper has to say so -
  // an un-marked draft is indistinguishable from a settled payslip once it
  // leaves the screen.
  if (DRAFT_STATUSES.includes(s.period.status)) drawDraftWatermark(doc);

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
