import type { FastifyInstance } from 'fastify';
import {
  createEmployeeSchema,
  deactivateSchema,
  employeeQuerySchema,
  updateEmployeeSchema,
} from '../schemas/index.js';
import * as employeeService from '../services/employee.service.js';
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
