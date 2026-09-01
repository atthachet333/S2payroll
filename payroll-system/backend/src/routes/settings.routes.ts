import type { FastifyInstance } from 'fastify';
import { prisma } from '../plugins/prisma.js';
import {
  auditQuerySchema,
  companySchema,
  createUserSchema,
  departmentSchema,
  holidaySchema,
  leaveSchema,
  positionSchema,
  updateSettingsSchema,
  updateUserSchema,
  workScheduleProfileSchema,
} from '../schemas/index.js';
import * as settingsService from '../services/settings.service.js';
import * as employeeService from '../services/employee.service.js';
import { hashPassword } from '../services/auth.service.js';
import { listAuditLogs, recordAudit, auditContext } from '../services/audit.service.js';
import { ROLE_LABELS, ROLE_PERMISSIONS } from '../config/permissions.js';
import { getActor } from '../middleware/actor.js';
import { dayjs, eachDay } from '../utils/datetime.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import * as workScheduleService from '../services/work-schedule-profile.service.js';
import * as payProfileService from '../services/pay-profile.service.js';
import * as payrollPolicyService from '../services/employee-payroll-policy.service.js';

export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // --- payroll / attendance / OT rules ---------------------------------------

  app.get('/', { preHandler: [app.requirePermission('settings:read')] }, async (request, reply) => {
    const { group } = request.query as { group?: string };
    return reply.send(await settingsService.listSettings(group));
  });

  app.patch('/', { preHandler: [app.requirePermission('settings:write')] }, async (request, reply) => {
    const body = updateSettingsSchema.parse(request.body);
    const actor = getActor(request);

    const before = await settingsService.listSettings();
    const beforeMap = Object.fromEntries(before.map((s) => [s.key, s.value]));

    const updated = [];
    for (const item of body.settings) {
      updated.push(await settingsService.updateSetting(item.key, item.value, actor.userId));
    }

    await recordAudit({
      action: 'SETTINGS_UPDATE',
      entity: 'PayrollSetting',
      oldValue: Object.fromEntries(body.settings.map((s) => [s.key, beforeMap[s.key]])),
      newValue: Object.fromEntries(body.settings.map((s) => [s.key, s.value])),
      ...auditContext(request),
    });

    return reply.send(updated);
  });

  app.get('/pay-configurations', { preHandler: [app.requirePermission('settings:read')] }, async (_request, reply) => {
    return reply.send(await payProfileService.listEmployeePayConfigurations());
  });

  /**
   * Quick-pick hourly rates for the daily-rate form. Suggestions only - the API
   * accepts any positive money amount - so this needs read access, not write.
   */
  app.get('/daily-rate-presets', { preHandler: [app.requirePermission('employee:read')] }, async (_request, reply) => {
    const settings = await settingsService.loadSettings();
    return reply.send({ presets: settingsService.dailyHourlyRatePresets(settings) });
  });

  // Per-employee payroll policies, for the employee-overrides table on the
  // Payroll Settings page. Writes go through the employee endpoint, so there is
  // one write path and one audit trail.
  app.get('/payroll-policies', { preHandler: [app.requirePermission('settings:read')] }, async (_request, reply) => {
    return reply.send(await payrollPolicyService.listEmployeePayrollPolicies());
  });

  // --- company ---------------------------------------------------------------

  app.get('/company', { preHandler: [app.requirePermission('settings:read')] }, async (_req, reply) =>
    reply.send(await prisma.company.findFirst())
  );

  app.put(
    '/company',
    { preHandler: [app.requirePermission('settings:write')] },
    async (request, reply) => {
      const body = companySchema.parse(request.body);
      const existing = await prisma.company.findFirst();
      const data = { ...body, email: body.email || null };

      const company = existing
        ? await prisma.company.update({ where: { id: existing.id }, data })
        : await prisma.company.create({ data });

      await recordAudit({
        action: 'COMPANY_UPDATE',
        entity: 'Company',
        entityId: company.id,
        newValue: { name: company.name },
        ...auditContext(request),
      });

      return reply.send(company);
    }
  );

  // --- departments -----------------------------------------------------------

  app.get(
    '/departments',
    { preHandler: [app.requirePermission('employee:read')] },
    async (_req, reply) => reply.send(await employeeService.listDepartments())
  );

  app.post(
    '/departments',
    { preHandler: [app.requirePermission('settings:write')] },
    async (request, reply) => {
      const body = departmentSchema.parse(request.body);
      return reply.status(201).send(await employeeService.createDepartment(body, getActor(request)));
    }
  );

  app.patch(
    '/departments/:id',
    { preHandler: [app.requirePermission('settings:write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = departmentSchema.partial().extend({}).parse(request.body) as {
        name?: string;
        isActive?: boolean;
      };
      return reply.send(await employeeService.updateDepartment(id, body));
    }
  );

  // --- positions -------------------------------------------------------------

  app.get(
    '/positions',
    { preHandler: [app.requirePermission('employee:read')] },
    async (_req, reply) => reply.send(await employeeService.listPositions())
  );

  app.post(
    '/positions',
    { preHandler: [app.requirePermission('settings:write')] },
    async (request, reply) => {
      const body = positionSchema.parse(request.body);
      return reply
        .status(201)
        .send(
          await employeeService.createPosition(
            { ...body, departmentId: body.departmentId || null },
            getActor(request)
          )
        );
    }
  );

  app.patch(
    '/positions/:id',
    { preHandler: [app.requirePermission('settings:write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = positionSchema.partial().parse(request.body);
      return reply.send(
        await employeeService.updatePosition(id, {
          name: body.name,
          departmentId: body.departmentId || null,
        })
      );
    }
  );

  // --- roles -----------------------------------------------------------------

  app.get('/roles', { preHandler: [app.requirePermission('user:read')] }, async (_req, reply) => {
    const roles = await prisma.role.findMany({ orderBy: { code: 'asc' } });
    return reply.send(
      roles.map((r) => ({
        ...r,
        label: ROLE_LABELS[r.code],
        permissions: ROLE_PERMISSIONS[r.code],
      }))
    );
  });

  // --- users -----------------------------------------------------------------

  app.get('/users', { preHandler: [app.requirePermission('user:read')] }, async (_req, reply) => {
    const users = await prisma.user.findMany({
      include: { role: true, employee: { select: { employeeCode: true } } },
      orderBy: { createdAt: 'desc' },
    });
    // Never leak password hashes over the API.
    return reply.send(
      users.map(({ passwordHash: _passwordHash, ...user }) => ({
        ...user,
        roleLabel: ROLE_LABELS[user.role.code],
      }))
    );
  });

  app.post('/users', { preHandler: [app.requirePermission('user:write')] }, async (request, reply) => {
    const body = createUserSchema.parse(request.body);
    const actor = getActor(request);

    const existing = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (existing) throw conflict('อีเมลนี้ถูกใช้แล้ว');

    const role = await prisma.role.findUnique({ where: { code: body.roleCode } });
    if (!role) throw notFound('Role');

    // Only a SUPER_ADMIN may mint another SUPER_ADMIN.
    if (body.roleCode === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') {
      throw badRequest('เฉพาะ SUPER_ADMIN เท่านั้นที่สามารถสร้างผู้ใช้ระดับ SUPER_ADMIN ได้');
    }

    const user = await prisma.user.create({
      data: {
        email: body.email.toLowerCase(),
        passwordHash: await hashPassword(body.password),
        firstName: body.firstName,
        lastName: body.lastName,
        roleId: role.id,
        employeeId: body.employeeId || null,
        createdBy: actor.userId,
      },
      include: { role: true },
    });

    await recordAudit({
      action: 'USER_CREATE',
      entity: 'User',
      entityId: user.id,
      newValue: { email: user.email, role: body.roleCode },
      ...auditContext(request),
    });

    const { passwordHash: _passwordHash, ...safe } = user;
    return reply.status(201).send(safe);
  });

  app.patch(
    '/users/:id',
    { preHandler: [app.requirePermission('user:write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = updateUserSchema.parse(request.body);
      const actor = getActor(request);

      const current = await prisma.user.findUnique({ where: { id }, include: { role: true } });
      if (!current) throw notFound('User');

      if (body.roleCode === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') {
        throw badRequest('เฉพาะ SUPER_ADMIN เท่านั้นที่สามารถกำหนดสิทธิ์ SUPER_ADMIN ได้');
      }
      // Guard against locking everyone out of the system.
      if (body.isActive === false && current.role.code === 'SUPER_ADMIN') {
        const activeSuperAdmins = await prisma.user.count({
          where: { isActive: true, role: { code: 'SUPER_ADMIN' } },
        });
        if (activeSuperAdmins <= 1) throw badRequest('ต้องมี SUPER_ADMIN ที่ใช้งานได้อย่างน้อย 1 บัญชี');
      }

      const role = body.roleCode
        ? await prisma.role.findUnique({ where: { code: body.roleCode } })
        : null;

      const user = await prisma.user.update({
        where: { id },
        data: {
          firstName: body.firstName,
          lastName: body.lastName,
          isActive: body.isActive,
          ...(role ? { roleId: role.id } : {}),
          ...(body.password ? { passwordHash: await hashPassword(body.password) } : {}),
        },
        include: { role: true },
      });

      if (body.password || body.isActive === false) {
        await prisma.refreshToken.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      await recordAudit({
        action: 'USER_UPDATE',
        entity: 'User',
        entityId: id,
        oldValue: { role: current.role.code, isActive: current.isActive },
        newValue: { role: user.role.code, isActive: user.isActive },
        ...auditContext(request),
      });

      const { passwordHash: _passwordHash, ...safe } = user;
      return reply.send(safe);
    }
  );

  // --- audit logs ------------------------------------------------------------

  app.get('/audit-logs', { preHandler: [app.requirePermission('audit:read')] }, async (request, reply) => {
    const query = auditQuerySchema.parse(request.query);
    return reply.send(
      await listAuditLogs({
        ...query,
        from: query.from ? dayjs.utc(query.from).startOf('day').toDate() : undefined,
        to: query.to ? dayjs.utc(query.to).endOf('day').toDate() : undefined,
      })
    );
  });

  // --- holidays --------------------------------------------------------------

  app.get('/holidays', { preHandler: [app.requirePermission('settings:read')] }, async (_req, reply) =>
    reply.send(await prisma.holiday.findMany({ orderBy: { date: 'asc' } }))
  );

  app.post(
    '/holidays',
    { preHandler: [app.requirePermission('settings:write')] },
    async (request, reply) => {
      const body = holidaySchema.parse(request.body);
      const actor = getActor(request);
      const holiday = await prisma.holiday.create({
        data: {
          date: dayjs.utc(body.date).startOf('day').toDate(),
          name: body.name,
          type: body.type,
          note: body.note || null,
          isPaid: body.isPaid,
          createdBy: actor.userId,
        },
      });
      await recordAudit({
        action: 'HOLIDAY_CREATE', entity: 'Holiday', entityId: holiday.id,
        newValue: { date: holiday.date, name: holiday.name, type: holiday.type },
        ...auditContext(request),
      });
      return reply.status(201).send(holiday);
    }
  );

  app.patch(
    '/holidays/:id',
    { preHandler: [app.requirePermission('settings:write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = holidaySchema.partial().parse(request.body);
      const current = await prisma.holiday.findUnique({ where: { id } });
      if (!current) throw notFound('Holiday');
      const holiday = await prisma.holiday.update({
        where: { id },
        data: {
          ...(body.date ? { date: dayjs.utc(body.date).startOf('day').toDate() } : {}),
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.type !== undefined ? { type: body.type } : {}),
          ...(body.note !== undefined ? { note: body.note || null } : {}),
          ...(body.isPaid !== undefined ? { isPaid: body.isPaid } : {}),
        },
      });
      await recordAudit({
        action: 'HOLIDAY_UPDATE', entity: 'Holiday', entityId: id,
        oldValue: { date: current.date, name: current.name, type: current.type },
        newValue: { date: holiday.date, name: holiday.name, type: holiday.type },
        ...auditContext(request),
      });
      return reply.send(holiday);
    }
  );

  app.get('/work-schedules', { preHandler: [app.requirePermission('settings:read')] }, async (_request, reply) =>
    reply.send(await workScheduleService.listWorkSchedules())
  );

  app.post('/work-schedules', { preHandler: [app.requirePermission('settings:write')] }, async (request, reply) => {
    const body = workScheduleProfileSchema.parse(request.body);
    return reply.status(201).send(await workScheduleService.createWorkSchedule(body, getActor(request)));
  });

  app.delete(
    '/holidays/:id',
    { preHandler: [app.requirePermission('settings:write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await prisma.holiday.delete({ where: { id } });
      await recordAudit({
        action: 'HOLIDAY_DELETE',
        entity: 'Holiday',
        entityId: id,
        ...auditContext(request),
      });
      return reply.send({ success: true });
    }
  );

  // --- leave records ---------------------------------------------------------

  app.get('/leaves', { preHandler: [app.requirePermission('attendance:read')] }, async (request, reply) => {
    const { employeeId } = request.query as { employeeId?: string };
    return reply.send(
      await prisma.leaveRecord.findMany({
        where: employeeId ? { employeeId } : {},
        include: { employee: { select: { employeeCode: true, firstName: true, lastName: true } } },
        orderBy: { startDate: 'desc' },
        take: 500,
      })
    );
  });

  app.post(
    '/leaves',
    { preHandler: [app.requirePermission('attendance:write')] },
    async (request, reply) => {
      const body = leaveSchema.parse(request.body);
      const actor = getActor(request);

      const start = dayjs.utc(body.startDate).startOf('day').toDate();
      const end = dayjs.utc(body.endDate).startOf('day').toDate();
      if (end < start) throw badRequest('วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มต้น');

      const leave = await prisma.leaveRecord.create({
        data: {
          employeeId: body.employeeId,
          leaveType: body.leaveType,
          startDate: start,
          endDate: end,
          totalDays: eachDay(start, end).length,
          isPaid: body.isPaid,
          reason: body.reason ?? null,
          createdBy: actor.userId,
          approvedBy: actor.userId,
        },
      });

      await recordAudit({
        action: 'LEAVE_CREATE',
        entity: 'LeaveRecord',
        entityId: leave.id,
        newValue: { employeeId: body.employeeId, type: body.leaveType },
        ...auditContext(request),
      });

      return reply.status(201).send(leave);
    }
  );
}
