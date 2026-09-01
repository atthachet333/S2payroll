import type { FastifyInstance } from 'fastify';
import { payslipQuerySchema } from '../schemas/index.js';
import * as payslipService from '../services/payslip.service.js';
import { generatePayslipPdf } from '../services/payslip-pdf.service.js';
import { recordAudit, auditContext } from '../services/audit.service.js';

export default async function payslipRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: [app.requirePermission('payslip:read')] }, async (request, reply) => {
    const query = payslipQuerySchema.parse(request.query);
    return reply.send(await payslipService.listPayslips(query));
  });

  app.get(
    '/:id',
    { preHandler: [app.requirePermission('payslip:read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await payslipService.getPayslip(id));
    }
  );

  /**
   * Server-rendered A5 PDF. Every figure comes from the stored snapshot and is
   * re-verified against the payroll row before rendering, so a client cannot
   * influence what the document says.
   */
  app.get(
    '/:id/pdf',
    { preHandler: [app.requirePermission('payslip:read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { buffer, filename, payslipNo } = await generatePayslipPdf(id);

      await recordAudit({
        action: 'PAYSLIP_PDF_DOWNLOAD',
        entity: 'Payslip',
        entityId: id,
        newValue: { payslipNo, filename, bytes: buffer.length },
        ...auditContext(request),
      });

      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('Content-Length', buffer.length)
        .header('Cache-Control', 'private, no-store')
        .send(buffer);
    }
  );
}
