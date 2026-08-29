import type { FastifyInstance } from 'fastify';
import authRoutes from './auth.routes.js';
import employeeRoutes from './employee.routes.js';
import attendanceRoutes from './attendance.routes.js';
import sheetsRoutes from './sheets.routes.js';
import payrollRoutes from './payroll.routes.js';
import payslipRoutes from './payslip.routes.js';
import reportRoutes from './report.routes.js';
import settingsRoutes from './settings.routes.js';
import { getOverview } from '../services/dashboard.service.js';
import { loadSettings } from '../services/settings.service.js';
import { assertFontsAvailable } from '../services/payslip-pdf.service.js';
import { isGoogleSheetsConfigured } from '../config/env.js';

export default async function registerRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Liveness + readiness. The database is actually probed with a trivial query
   * rather than assumed, so a load balancer sees 503 while MariaDB is
   * unreachable instead of routing traffic to an instance that cannot serve it.
   */
  app.get('/api/health', async (_request, reply) => {
    let database: 'connected' | 'disconnected' = 'disconnected';
    let databaseError: string | undefined;

    try {
      await app.prisma.$queryRaw`SELECT 1`;
      database = 'connected';
    } catch (err) {
      databaseError = err instanceof Error ? err.message.split('\n')[0] : 'Unknown database error';
      app.log.error({ err }, 'Health check: database unreachable');
    }

    const healthy = database === 'connected';
    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'error',
      database,
      ...(databaseError ? { databaseError } : {}),
      service: 'payroll-api',
      time: new Date().toISOString(),
    });
  });

  /**
   * Readiness: is this instance able to serve payroll work right now?
   *
   * Checks the database, the settings the calculator depends on, and the PDF
   * fonts. Google Sheets is deliberately NOT required — payroll must keep
   * running from already-synced attendance when the sheet is unreachable.
   */
  app.get('/api/ready', async (_request, reply) => {
    const checks: { name: string; ok: boolean; detail?: string; required: boolean }[] = [];

    try {
      await app.prisma.$queryRaw`SELECT 1`;
      checks.push({ name: 'database', ok: true, required: true });
    } catch (err) {
      checks.push({
        name: 'database',
        ok: false,
        required: true,
        detail: err instanceof Error ? err.message.split('\n')[0] : 'unreachable',
      });
    }

    // The settings the payroll engine divides by; a zero here breaks every rate.
    try {
      const settings = await loadSettings();
      const bad = ['STANDARD_WORK_DAYS', 'STANDARD_WORK_HOURS'].filter((k) =>
        settings.decimal(k).lessThanOrEqualTo(0)
      );
      checks.push({
        name: 'payroll-settings',
        ok: bad.length === 0,
        required: true,
        detail: bad.length > 0 ? `invalid: ${bad.join(', ')}` : undefined,
      });
    } catch (err) {
      checks.push({
        name: 'payroll-settings',
        ok: false,
        required: true,
        detail: err instanceof Error ? err.message : 'unavailable',
      });
    }

    // Payslip PDFs need their bundled Thai font present in the deployed tree.
    try {
      assertFontsAvailable();
      checks.push({ name: 'payslip-fonts', ok: true, required: true });
    } catch (err) {
      checks.push({
        name: 'payslip-fonts',
        ok: false,
        required: true,
        detail: err instanceof Error ? err.message : 'missing',
      });
    }

    // Informational only - never gates readiness.
    checks.push({
      name: 'google-sheets',
      ok: isGoogleSheetsConfigured(),
      required: false,
      detail: isGoogleSheetsConfigured()
        ? undefined
        : 'not configured; attendance sync unavailable but payroll operates from synced data',
    });

    const ready = checks.filter((c) => c.required).every((c) => c.ok);
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not-ready',
      checks,
      service: 'payroll-api',
      time: new Date().toISOString(),
    });
  });

  app.get(
    '/api/overview',
    { preHandler: [app.requirePermission('payroll:read')] },
    async (request, reply) => {
      const { periodId } = request.query as { periodId?: string };
      return reply.send(await getOverview(periodId));
    }
  );

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(employeeRoutes, { prefix: '/api/employees' });
  await app.register(attendanceRoutes, { prefix: '/api/attendance' });
  await app.register(sheetsRoutes, { prefix: '/api/sheets' });
  await app.register(payrollRoutes, { prefix: '/api/payroll' });
  await app.register(payslipRoutes, { prefix: '/api/payslips' });
  await app.register(reportRoutes, { prefix: '/api/reports' });
  await app.register(settingsRoutes, { prefix: '/api/settings' });
}
