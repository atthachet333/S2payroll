import type { FastifyInstance } from 'fastify';
import {
  attendanceQuerySchema,
  correctAttendanceSchema,
  recalculateSchema,
} from '../schemas/index.js';
import * as attendanceService from '../services/attendance.service.js';
import { getActor } from '../middleware/actor.js';
import { dayjs } from '../utils/datetime.js';

export default async function attendanceRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/',
    { preHandler: [app.requirePermission('attendance:read')] },
    async (request, reply) => {
      const query = attendanceQuerySchema.parse(request.query);
      return reply.send(
        await attendanceService.listAttendance({
          ...query,
          from: query.from ? dayjs.utc(query.from).startOf('day').toDate() : undefined,
          to: query.to ? dayjs.utc(query.to).startOf('day').toDate() : undefined,
        })
      );
    }
  );

  app.get(
    '/summary',
    { preHandler: [app.requirePermission('attendance:read')] },
    async (request, reply) => {
      const { from, to, departmentId } = request.query as {
        from?: string;
        to?: string;
        departmentId?: string;
      };
      const start = from ? dayjs.utc(from) : dayjs.utc().startOf('month');
      const end = to ? dayjs.utc(to) : dayjs.utc().endOf('month');
      return reply.send(
        await attendanceService.attendanceSummary(
          start.startOf('day').toDate(),
          end.startOf('day').toDate(),
          departmentId
        )
      );
    }
  );

  app.get(
    '/:id',
    { preHandler: [app.requirePermission('attendance:read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await attendanceService.getAttendanceById(id));
    }
  );

  app.patch(
    '/:id',
    { preHandler: [app.requirePermission('attendance:write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = correctAttendanceSchema.parse(request.body);
      const actor = getActor(request);
      return reply.send(
        await attendanceService.correctAttendance(id, body, {
          userId: actor.userId,
          email: actor.email,
          ip: actor.ip,
          userAgent: actor.userAgent,
        })
      );
    }
  );

  app.post(
    '/recalculate',
    { preHandler: [app.requirePermission('attendance:write')] },
    async (request, reply) => {
      const body = recalculateSchema.parse(request.body);
      const updated = await attendanceService.recalculateRange(
        dayjs.utc(body.from).startOf('day').toDate(),
        dayjs.utc(body.to).startOf('day').toDate()
      );
      return reply.send({ updated });
    }
  );
}
