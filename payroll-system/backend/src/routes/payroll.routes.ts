import type { FastifyInstance } from 'fastify';
import {
  adjustPayrollSchema,
  createPeriodSchema,
  markPaidSchema,
  periodEmployeeQuerySchema,
  unlockSchema,
  periodSuggestQuerySchema,
} from '../schemas/index.js';
import * as payrollService from '../services/payroll.service.js';
import * as payslipService from '../services/payslip.service.js';
import { planBulkExport, streamBulkExport } from '../services/payslip-bulk.service.js';
import { recordAudit, auditContext } from '../services/audit.service.js';
import { runPrePayrollChecks } from '../services/pre-payroll-check.service.js';
import { getActor } from '../middleware/actor.js';

export default async function payrollRoutes(app: FastifyInstance): Promise<void> {
  // --- periods ---------------------------------------------------------------

  app.get('/periods', { preHandler: [app.requirePermission('payroll:read')] }, async (_req, reply) =>
    reply.send(await payrollService.listPeriods())
  );

  app.post(
    '/periods',
    { preHandler: [app.requirePermission('payroll:write')] },
    async (request, reply) => {
      const body = createPeriodSchema.parse(request.body);
      const period = await payrollService.createPeriod(body, getActor(request));
      return reply.status(201).send(period);
    }
  );

  app.get(
    '/periods/:id',
    { preHandler: [app.requirePermission('payroll:read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await payrollService.periodSummary(id));
    }
  );

  /** Suggested window for a month, from the configured payroll cycle. */
  app.get(
    '/periods/suggest',
    { preHandler: [app.requirePermission('payroll:read')] },
    async (request, reply) => {
      const q = periodSuggestQuerySchema.parse(request.query);
      return reply.send(await payrollService.getPeriodSuggestion(q.year, q.month));
    }
  );

  /** Pre-payroll validation. Blocking findings prevent calculation. */
  app.get(
    '/periods/:id/pre-check',
    { preHandler: [app.requirePermission('payroll:read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await runPrePayrollChecks(id));
    }
  );

  // --- workflow --------------------------------------------------------------

  app.post(
    '/periods/:id/attendance-review',
    { preHandler: [app.requirePermission('payroll:write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await payrollService.startAttendanceReview(id, getActor(request)));
    }
  );

  app.post(
    '/periods/:id/calculate',
    { preHandler: [app.requirePermission('payroll:calculate')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await payrollService.calculatePeriod(id, getActor(request)));
    }
  );

  app.post(
    '/periods/:id/submit-review',
    { preHandler: [app.requirePermission('payroll:write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await payrollService.submitForReview(id, getActor(request)));
    }
  );

  app.post(
    '/periods/:id/approve',
    { preHandler: [app.requirePermission('payroll:approve')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await payrollService.approvePeriod(id, getActor(request)));
    }
  );

  app.post(
    '/periods/:id/mark-paid',
    { preHandler: [app.requirePermission('payroll:pay')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = markPaidSchema.parse(request.body ?? {});
      return reply.send(await payrollService.markPaid(id, getActor(request), body.paymentDate));
    }
  );

  app.post(
    '/periods/:id/lock',
    { preHandler: [app.requirePermission('payroll:lock')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await payrollService.lockPeriod(id, getActor(request)));
    }
  );

  // Unlocking is SUPER_ADMIN only and always writes an audit entry.
  app.post(
    '/periods/:id/unlock',
    { preHandler: [app.requireRole('SUPER_ADMIN')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = unlockSchema.parse(request.body);
      return reply.send(await payrollService.unlockPeriod(id, body.reason, getActor(request)));
    }
  );

  // --- payroll employees -----------------------------------------------------

  app.get(
    '/periods/:id/employees',
    { preHandler: [app.requirePermission('payroll:read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = periodEmployeeQuerySchema.parse(request.query);
      return reply.send(await payrollService.listPeriodEmployees(id, query));
    }
  );

  app.get(
    '/periods/:id/employees/:employeeId',
    { preHandler: [app.requirePermission('payroll:read')] },
    async (request, reply) => {
      const { id, employeeId } = request.params as { id: string; employeeId: string };
      return reply.send(await payrollService.getPeriodEmployee(id, employeeId));
    }
  );

  app.patch(
    '/periods/:id/employees/:employeeId',
    { preHandler: [app.requirePermission('payroll:write')] },
    async (request, reply) => {
      const { id, employeeId } = request.params as { id: string; employeeId: string };
      const body = adjustPayrollSchema.parse(request.body);
      const actor = getActor(request);

      const updated = await payrollService.adjustPayrollEmployee(
        id,
        employeeId,
        body.adjustments,
        actor
      );

      if (body.status) {
        return reply.send(
          await payrollService.setPayrollEmployeeStatus(id, employeeId, body.status, actor)
        );
      }
      return reply.send(updated);
    }
  );

  app.get(
    '/periods/:id/employees/:employeeId/payslip-preview',
    { preHandler: [app.requirePermission('payslip:read')] },
    async (request, reply) => {
      const { id, employeeId } = request.params as { id: string; employeeId: string };
      return reply.send(await payslipService.previewPayslip(id, employeeId));
    }
  );

  app.post(
    '/periods/:id/generate-payslips',
    { preHandler: [app.requirePermission('payslip:issue')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await payslipService.generatePayslips(id, getActor(request)));
    }
  );

  /**
   * Bulk payslip download as a streamed ZIP. Validation happens before any
   * bytes are written, so a rejected export returns JSON rather than a
   * truncated archive.
   */
  app.get(
    '/periods/:id/payslips/download',
    { preHandler: [app.requirePermission('payslip:read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const plan = await planBulkExport(id);
      const { stream, completed } = streamBulkExport(plan);

      // Audit the intent up front: the export is authorised and starting, even
      // if the client disconnects part-way through the download.
      await recordAudit({
        action: 'PAYSLIP_BULK_EXPORT',
        entity: 'PayrollPeriod',
        entityId: id,
        newValue: {
          periodCode: plan.periodCode,
          payslipCount: plan.payslipIds.length,
          filename: plan.zipFilename,
        },
        ...auditContext(request),
      });

      // Report anything skipped once the archive finishes assembling.
      void completed.then((result) => {
        if (result.failed.length > 0) {
          request.log.warn(
            { periodId: id, failed: result.failed },
            'Bulk payslip export excluded payslips that failed verification'
          );
        }
      });

      return reply
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', `attachment; filename="${plan.zipFilename}"`)
        .header('Cache-Control', 'private, no-store')
        .send(stream);
    }
  );
}
