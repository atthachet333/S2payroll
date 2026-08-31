import type { FastifyInstance } from 'fastify';
import {
  createEmployeeSchema,
  deactivateSchema,
  employeeQuerySchema,
  updateEmployeeSchema,
  payProfileSchema,
} from '../schemas/index.js';
import * as employeeService from '../services/employee.service.js';
import * as payProfileService from '../services/pay-profile.service.js';
import { getActor } from '../middleware/actor.js';
import { dayjs } from '../utils/datetime.js';

export default async function employeeRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/',
    { preHandler: [app.requirePermission('employee:read')] },
    async (request, reply) => {
      const query = employeeQuerySchema.parse(request.query);
      return reply.send(await employeeService.listEmployees(query));
    }
  );

  // Counters for the Employees page header. Declared before '/:id' so the
  // static segment is not captured as an employee id.
  app.get(
    '/completeness-summary',
    { preHandler: [app.requirePermission('employee:read')] },
    async (_request, reply) => reply.send(await employeeService.employeeCompletenessSummary())
  );

  app.get(
    '/:id/attendance',
    { preHandler: [app.requirePermission('employee:read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { year?: string; month?: string; page?: string; pageSize?: string; status?: string };
      const now = dayjs();
      const year = Number(query.year ?? now.year());
      const month = Number(query.month ?? now.month() + 1);
      const page = Math.max(1, Number(query.page ?? 1));
      const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 31)));
      return reply.send(await employeeService.employeeAttendanceHistory(id, year, month, page, pageSize, query.status));
    }
  );

  app.get(
    '/:id',
    { preHandler: [app.requirePermission('employee:read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await employeeService.getEmployee(id));
    }
  );

  app.get(
    '/:id/summary',
    { preHandler: [app.requirePermission('employee:read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { from, to } = request.query as { from?: string; to?: string };
      return reply.send(
        await employeeService.employeeSummary(
          id,
          from ? dayjs.utc(from).startOf('day').toDate() : undefined,
          to ? dayjs.utc(to).startOf('day').toDate() : undefined
        )
      );
    }
  );

  app.get(
    '/:id/pay-profiles',
    { preHandler: [app.requirePermission('employee:read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await payProfileService.listPayProfiles(id));
    }
  );

  app.post(
    '/:id/pay-profiles',
    { preHandler: [app.requirePermission('employee:write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = payProfileSchema.parse(request.body);
      return reply.status(201).send(
        await payProfileService.createPayProfile(id, body, getActor(request))
      );
    }
  );

  app.post(
    '/',
    { preHandler: [app.requirePermission('employee:write')] },
    async (request, reply) => {
      const body = createEmployeeSchema.parse(request.body);
      const employee = await employeeService.createEmployee(
        body as employeeService.EmployeeInput,
        getActor(request)
      );
      return reply.status(201).send(employee);
    }
  );

  app.patch(
    '/:id',
    { preHandler: [app.requirePermission('employee:write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = updateEmployeeSchema.parse(request.body);
      return reply.send(await employeeService.updateEmployee(id, body, getActor(request)));
    }
  );

  app.post(
    '/:id/deactivate',
    { preHandler: [app.requirePermission('employee:write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = deactivateSchema.parse(request.body);
      return reply.send(
        await employeeService.deactivateEmployee(id, body.reason, getActor(request))
      );
    }
  );
}
