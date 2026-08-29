import type { FastifyInstance } from 'fastify';
import { paginationSchema, syncSchema } from '../schemas/index.js';
import * as sheetsService from '../services/google-sheets.service.js';
import { getActor } from '../middleware/actor.js';

export default async function sheetsRoutes(app: FastifyInstance): Promise<void> {
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
