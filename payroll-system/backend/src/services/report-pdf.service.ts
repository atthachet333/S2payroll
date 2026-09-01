import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import type { ReportData } from './report.service.js';

const require = createRequire(import.meta.url);
const font = (file: string) => require.resolve(`@expo-google-fonts/sarabun/${file}`);
const REGULAR = font('400Regular/Sarabun_400Regular.ttf');
const BOLD = font('700Bold/Sarabun_700Bold.ttf');
const NAVY = '#17324D';
const TEAL = '#158078';
const MUTED = '#627183';

function number(value: unknown): string {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-';
}

/** Render from the exact ReportData DTO used by JSON/CSV/Excel. */
export async function toReportPdf(report: ReportData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28, bufferPages: true, info: { Title: report.title } });
  doc.registerFont('Sarabun', REGULAR).registerFont('Sarabun-Bold', BOLD);
  const chunks: Buffer[] = [];
  doc.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const keys = report.kind === 'detailed-payroll'
    ? ['employee_code', 'employee_name', 'employment_type', 'worked_hours', 'late_count', 'base_earnings', 'gross_income', 'total_deduction', 'net_salary']
    : report.columns.slice(0, 9).map((column) => column.key);
  const widths = [62, 142, 74, 58, 46, 78, 78, 78, 78].slice(0, keys.length);
  const headers = keys.map((key) => report.columns.find((column) => column.key === key)?.header ?? key);
  const numericKeys = new Set(report.columns.filter((column) => column.numeric).map((column) => column.key));
  const left = doc.page.margins.left;
  const rowHeight = 22;

  const pageHeader = () => {
    doc.font('Sarabun-Bold').fontSize(16).fillColor(NAVY).text('S2A-PAYROLL', left, 25);
    doc.font('Sarabun-Bold').fontSize(15).fillColor(NAVY).text(report.title, left, 49);
    doc.font('Sarabun').fontSize(8).fillColor(MUTED).text(Object.values(report.meta).filter(Boolean).join('  |  '), left, 70);
    doc.moveTo(left, 84).lineTo(doc.page.width - left, 84).strokeColor(TEAL).lineWidth(1.5).stroke();
  };
  const tableHeader = (y: number) => {
    let x = left;
    doc.rect(left, y, widths.reduce((a, b) => a + b, 0), rowHeight).fill(NAVY);
    headers.forEach((header, index) => {
      doc.font('Sarabun-Bold').fontSize(7.3).fillColor('#FFFFFF').text(header, x + 3, y + 6, { width: widths[index] - 6, align: index > 2 ? 'right' : 'left' });
      x += widths[index];
    });
  };

  pageHeader();
  let y = 96;
  if (report.summary) {
    const cards = [
      ['พนักงาน', `${report.summary.employeeCount} คน`],
      ['รายได้รวม', number(report.summary.grossTotal)],
      ['รายการหักรวม', number(report.summary.deductionTotal)],
      ['เงินสุทธิ', number(report.summary.netTotal)],
    ];
    cards.forEach(([label, value], index) => {
      const x = left + index * 190;
      doc.roundedRect(x, y, 178, 38, 4).fill('#F2F6F8');
      doc.font('Sarabun').fontSize(7.5).fillColor(MUTED).text(label, x + 8, y + 5);
      doc.font('Sarabun-Bold').fontSize(11).fillColor(index === 3 ? TEAL : NAVY).text(value, x + 8, y + 18, { width: 162, align: 'right' });
    });
    y += 48;
  }
  tableHeader(y);
  y += rowHeight;

  report.rows.forEach((row, rowIndex) => {
    if (y + rowHeight > doc.page.height - 35) {
      doc.addPage();
      pageHeader();
      y = 96;
      tableHeader(y);
      y += rowHeight;
    }
    if (rowIndex % 2) doc.rect(left, y, widths.reduce((a, b) => a + b, 0), rowHeight).fill('#F7F9FA');
    let x = left;
    keys.forEach((key, index) => {
      const raw = row[key];
      const value = numericKeys.has(key) ? number(raw) : String(raw ?? '-');
      doc.font('Sarabun').fontSize(7.2).fillColor('#243746').text(value, x + 3, y + 6, { width: widths[index] - 6, align: numericKeys.has(key) ? 'right' : 'left', ellipsis: true, lineBreak: false });
      x += widths[index];
    });
    y += rowHeight;
  });

  if (report.totals && y + rowHeight <= doc.page.height - 30) {
    doc.rect(left, y, widths.reduce((a, b) => a + b, 0), rowHeight).fill('#DCE9EA');
    let x = left;
    keys.forEach((key, index) => {
      const raw = report.totals?.[key];
      doc.font('Sarabun-Bold').fontSize(7.4).fillColor(NAVY).text(raw === undefined ? '' : (numericKeys.has(key) ? number(raw) : String(raw)), x + 3, y + 6, { width: widths[index] - 6, align: numericKeys.has(key) ? 'right' : 'left' });
      x += widths[index];
    });
  }
  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index);
    doc.font('Sarabun').fontSize(7).fillColor(MUTED).text(
      `สร้างเมื่อ ${new Date().toLocaleString('th-TH')}  |  หน้า ${index + 1}/${range.count}`,
      left,
      doc.page.height - 22,
      { width: doc.page.width - left * 2, align: 'right', lineBreak: false }
    );
  }
  doc.end();
  return finished;
}
