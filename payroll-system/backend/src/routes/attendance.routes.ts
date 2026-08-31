import type { FastifyInstance } from 'fastify';
import {
  attendanceQuerySchema,
  correctAttendanceSchema,
  deleteAttendanceSchema,
  recalculateSchema,
} from '../schemas/index.js';
import * as attendanceService from '../services/attendance.service.js';
import { getActor } from '../middleware/actor.js';
import { dayjs } from '../utils/datetime.js';

export default async function attendanceRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/calendar',
    { preHandler: [app.requirePermission('attendance:read')] },
    async (request, reply) => {
      const now = dayjs();
      const { year = now.year(), month = now.month() + 1 } = request.query as {
        year?: number;
        month?: number;
      };
      const parsedYear = Number(year);
      const parsedMonth = Number(month);
      if (!Number.isInteger(parsedYear) || !Number.isInteger(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid year or month' });
      }
      return reply.send(await attendanceService.getWorkCalendar(parsedYear, parsedMonth));
    }
  );

  // Day detail is a separate call on purpose: the month view needs counts only,
  // and returning every employee's checkout summary for 31 days would bloat a
  // response that is polled.
  app.get(
    '/calendar/:date',
    { preHandler: [app.requirePermission('attendance:read')] },
    async (request, reply) => {
      const { date } = request.params as { date: string };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid date' });
      }
      return reply.send(await attendanceService.getCalendarDayDetail(date));
    }
  );

  app.get(
    '/suppressions',
    { preHandler: [app.requirePermission('attendance:read')] },
    async (_request, reply) => reply.send(await attendanceService.listSuppressions())
  );

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

  // Removes the day from the payroll system only. The Google Sheet is never
  // written to, and the archived raw events survive for audit.
  app.delete(
    '/:id',
    { preHandler: [app.requirePermission('attendance:write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = deleteAttendanceSchema.parse(request.body ?? {});
      const actor = getActor(request);
      return reply.send(
        await attendanceService.deleteAttendance(id, body, {
          userId: actor.userId,
          email: actor.email,
          ip: actor.ip,
          userAgent: actor.userAgent,
        })
      );
    }
  );

  app.delete(
    '/suppressions/:id',
    { preHandler: [app.requirePermission('attendance:write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const actor = getActor(request);
      return reply.send(
        await attendanceService.restoreAttendance(id, {
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
        dayjs.utc(body.to).startOf('day').toDate(),
        body.employeeId
      );
      return reply.send(updated);
    }
  );
}
