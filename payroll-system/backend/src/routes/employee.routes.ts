import type { FastifyInstance } from 'fastify';
import {
  createEmployeeSchema,
  deactivateSchema,
  employeeQuerySchema,
  updateEmployeeSchema,
  payProfileSchema,
  employeePayrollPolicySchema,
  reactivateEmployeeSchema,
  manualAttendanceSchema,
  employeeWorkScheduleSchema,
  employeeWorkScheduleUpdateSchema,
  useCompanyWorkScheduleSchema,
  employeeWorkScheduleOverrideSchema,
} from '../schemas/index.js';
import * as employeeService from '../services/employee.service.js';
import * as attendanceService from '../services/attendance.service.js';
import * as payProfileService from '../services/pay-profile.service.js';
import * as payrollPolicyService from '../services/employee-payroll-policy.service.js';
import { employeeDailyEarnings } from '../services/daily-earnings.service.js';
import { getActor } from '../middleware/actor.js';
import { dayjs } from '../utils/datetime.js';
import * as workScheduleService from '../services/employee-work-schedule.service.js';

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

  app.get(
    '/:id/work-schedule',
    { preHandler: [app.requirePermission('employee:read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { date } = request.query as { date?: string };
      const resolved = await workScheduleService.resolveEmployeeWorkSchedule(
        id,
        date ? dayjs.utc(date).startOf('day').toDate() : new Date()
      );
      const { settings: _settings, ...response } = resolved;
      return reply.send(response);
    }
  );

  app.get(
    '/:id/work-schedules',
    { preHandler: [app.requirePermission('employee:read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await workScheduleService.listEmployeeWorkSchedules(id));
    }
  );

  app.get(
    '/:id/work-schedule-overrides',
    { preHandler: [app.requirePermission('employee:read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await workScheduleService.listEmployeeWorkScheduleOverrides(id));
    }
  );

  app.post(
    '/:id/work-schedule-overrides',
    { preHandler: [app.requirePermission('attendance:write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = employeeWorkScheduleOverrideSchema.parse(request.body);
      const override = await workScheduleService.createEmployeeWorkScheduleOverride(id, body, getActor(request));
      const workDate = dayjs.utc(body.workDate).startOf('day').toDate();
      // Only this employee-day is re-derived. recalculateRange protects every
      // APPROVED, PAID and LOCKED period and never writes source punches.
      const recalculation = await attendanceService.recalculateRange(workDate, workDate, id);
      const resolved = await workScheduleService.resolveEmployeeWorkSchedule(id, workDate);
      const { settings: _settings, ...schedule } = resolved;
      return reply.status(201).send({ override, schedule, recalculation });
    }
  );

  app.post(
    '/:id/work-schedules',
    { preHandler: [app.requirePermission('employee:write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = employeeWorkScheduleSchema.parse(request.body);
      return reply.status(201).send(await workScheduleService.createEmployeeWorkSchedule(id, body, getActor(request)));
    }
  );

  app.patch(
    '/:id/work-schedules/:scheduleId',
    { preHandler: [app.requirePermission('employee:write')] },
    async (request, reply) => {
      const { id, scheduleId } = request.params as { id: string; scheduleId: string };
      const body = employeeWorkScheduleUpdateSchema.parse(request.body);
      const schedule = await workScheduleService.updateEmployeeWorkSchedule(id, scheduleId, body, getActor(request));
      // Only this employee's open window is re-derived. recalculateRange
      // protects every APPROVED, PAID and LOCKED period and never writes
      // source punches.
      const recalculation = await attendanceService.recalculateRange(
        schedule.effectiveFrom, schedule.effectiveTo ?? new Date(), id
      );
      return reply.send({ schedule, recalculation });
    }
  );

  app.post(
    '/:id/work-schedules/use-company-default',
    { preHandler: [app.requirePermission('employee:write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = useCompanyWorkScheduleSchema.parse(request.body);
      return reply.send(await workScheduleService.useCompanyWorkSchedule(id, body.effectiveFrom, getActor(request)));
    }
  );

  // Per-employee payroll policy. Employee Edit and Payroll Settings both write
  // here, so the two screens can never hold different numbers for one person.
  app.get(
    '/:id/payroll-policy',
    { preHandler: [app.requirePermission('employee:read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await payrollPolicyService.getPayrollPolicy(id));
    }
  );

  app.put(
    '/:id/payroll-policy',
    { preHandler: [app.requirePermission('employee:write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = employeePayrollPolicySchema.parse(request.body);
      return reply.send(
        await payrollPolicyService.upsertPayrollPolicy(id, body, getActor(request))
      );
    }
  );

  // Per-day earnings for staff paid by the hour: what each day was worth at the
  // rate in force on that date.
  app.get(
    '/:id/daily-earnings',
    { preHandler: [app.requirePermission('employee:read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { year?: string; month?: string };
      const now = dayjs();
      return reply.send(
        await employeeDailyEarnings(
          id,
          Number(query.year ?? now.year()),
          Number(query.month ?? now.month() + 1)
        )
      );
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

  /** Bring a deactivated or terminated employee back onto the payroll. */
  app.post(
    '/:id/reactivate',
    { preHandler: [app.requirePermission('employee:write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = reactivateEmployeeSchema.parse(request.body);
      return reply.send(
        await employeeService.reactivateEmployee(
          id,
          { returnDate: body.returnDate, reason: body.reason ?? null },
          getActor(request)
        )
      );
    }
  );

  /**
   * Create one attendance day by hand. Derived values are computed by the
   * backend from the punches; nothing is written to Google Sheets.
   */
  app.post(
    '/:id/attendance',
    { preHandler: [app.requirePermission('attendance:write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = manualAttendanceSchema.parse(request.body);
      const actor = getActor(request);
      return reply.status(201).send(
        await attendanceService.createManualAttendance(
          id,
          {
            workDate: body.workDate,
            checkIn: body.checkIn ?? null,
            checkOut: body.checkOut ?? null,
            reason: body.reason,
            note: body.note ?? null,
          },
          { userId: actor.userId, email: actor.email, ip: actor.ip, userAgent: actor.userAgent }
        )
      );
    }
  );

  app.post(
    '/:id/deactivate',
    { preHandler: [app.requirePermission('employee:write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = deactivateSchema.parse(request.body);
      return reply.send(
        await employeeService.deactivateEmployee(id, body, getActor(request))
      );
    }
  );
}
