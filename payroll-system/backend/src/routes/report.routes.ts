import type { FastifyInstance } from 'fastify';
import { reportQuerySchema, reportTypeSchema } from '../schemas/index.js';
import { buildReport, toCsv, toExcel, type ReportType } from '../services/report.service.js';
import { toReportPdf } from '../services/report-pdf.service.js';
import { dayjs } from '../utils/datetime.js';

export default async function reportRoutes(app: FastifyInstance): Promise<void> {
  /**
   * One endpoint per report type, all sharing the same query contract.
   * `format` selects JSON (for the on-screen table), CSV or XLSX.
   * PDF is produced client-side from the same JSON via the A4 print layout,
   * which keeps Thai typography identical to what the user sees on screen.
   */
  const handler = (type: ReportType) => async (request: any, reply: any) => {
    const query = reportQuerySchema.parse(request.query);
    const report = await buildReport(type, {
      periodId: query.periodId,
      departmentId: query.departmentId,
      employeeId: query.employeeId,
      employmentType: query.employmentType,
      status: query.status,
      from: query.from ? dayjs.utc(query.from).startOf('day').toDate() : undefined,
      to: query.to ? dayjs.utc(query.to).startOf('day').toDate() : undefined,
    });

    const stamp = dayjs().format('YYYYMMDD-HHmm');

    if (query.format === 'csv') {
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${type}-${stamp}.csv"`)
        .send(toCsv(report));
    }

    if (query.format === 'excel') {
      const buffer = await toExcel(report);
      return reply
        .header(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
        .header('Content-Disposition', `attachment; filename="${type}-${stamp}.xlsx"`)
        .send(buffer);
    }

    if (query.format === 'pdf') {
      const buffer = await toReportPdf(report);
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${type}-${stamp}.pdf"`)
        .send(buffer);
    }

    return reply.send(report);
  };

  app.get('/types', { preHandler: [app.requirePermission('report:read')] }, async (_req, reply) =>
    reply.send({ types: reportTypeSchema.options })
  );

  for (const type of reportTypeSchema.options) {
    app.get(`/${type}`, { preHandler: [app.requirePermission('report:read')] }, handler(type));
  }

  // Aliases matching the documented API surface.
  app.get('/payroll', { preHandler: [app.requirePermission('report:read')] }, handler('payroll-summary'));
  app.get(
    '/attendance',
    { preHandler: [app.requirePermission('report:read')] },
    handler('attendance-summary')
  );
}
