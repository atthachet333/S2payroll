import type { FastifyInstance } from 'fastify';
import { paginationSchema, syncSchema } from '../schemas/index.js';
import * as sheetsService from '../services/google-sheets.service.js';
import { getActor } from '../middleware/actor.js';
import { importLeaves, previewLeaveSync } from '../services/leave-sync.service.js';
import { autoSync } from '../services/auto-sync.service.js';

export default async function sheetsRoutes(app: FastifyInstance): Promise<void> {
  // Operational status only - no credentials, no connection strings, and any
  // error text is scrubbed before it is stored.
  app.get(
    '/auto-sync/status',
    { preHandler: [app.requirePermission('attendance:read')] },
    async (_request, reply) => reply.send(await autoSync.getLiveStatus())
  );

  // Runs Employees -> Attendance -> Leave through the same mutex the scheduler
  // uses, so a manual trigger can never overlap a background cycle.
  app.post(
    '/sync-all',
    {
      preHandler: [app.requirePermission('attendance:sync')],
      config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
    },
    async (_request, reply) => {
      const result = await autoSync.runCycle('manual');
      if (!result) {
        return reply.status(409).send({
          code: 'SYNC_ALREADY_RUNNING',
          message: 'กำลังซิงก์ข้อมูลอยู่ กรุณารอสักครู่แล้วลองใหม่',
        });
      }
      return reply.send(result);
    }
  );

  app.get(
    '/leaves/preview',
    { preHandler: [app.requirePermission('attendance:sync')] },
    async (_request, reply) => reply.send(await previewLeaveSync())
  );

  app.post(
    '/leaves/sync',
    { preHandler: [app.requirePermission('attendance:sync')] },
    async (request, reply) => {
      const actor = getActor(request);
      return reply.send(await importLeaves({ actorId: actor.userId }));
    }
  );

  app.post(
    '/sync',
    {
      preHandler: [app.requirePermission('attendance:sync')],
      // A sync is expensive; keep concurrent triggers low.
      config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const body = syncSchema.parse(request.body ?? {});
      const actor = getActor(request);
      const result = await sheetsService.syncAttendance({
        sheetId: body.sheetId,
        range: body.range,
        dryRun: body.dryRun,
        actor: {
          userId: actor.userId,
          email: actor.email,
          ip: actor.ip,
          userAgent: actor.userAgent,
        },
      });
      return reply.send(result);
    }
  );

  app.get(
    '/status',
    { preHandler: [app.requirePermission('attendance:read')] },
    async (_request, reply) => {
      const [lastSync] = await Promise.all([sheetsService.getLastSync()]);
      return reply.send({ ...sheetsService.sheetsStatus(), lastSync });
    }
  );

  app.get(
    '/history',
    { preHandler: [app.requirePermission('attendance:read')] },
    async (request, reply) => {
      const { page, pageSize } = paginationSchema.parse(request.query);
      return reply.send(await sheetsService.listSyncHistory(page, pageSize));
    }
  );

  app.get(
    '/preview',
    { preHandler: [app.requirePermission('attendance:sync')] },
    async (request, reply) => {
      const { sheetId, range } = request.query as { sheetId?: string; range?: string };
      const rows = await sheetsService.fetchSheetRows(sheetId, range);
      return reply.send({ total: rows.length, rows: rows.slice(0, 50) });
    }
  );
}
