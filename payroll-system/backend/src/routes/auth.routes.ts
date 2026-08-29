import type { FastifyInstance } from 'fastify';
import { changePasswordSchema, loginSchema, refreshSchema } from '../schemas/index.js';
import * as authService from '../services/auth.service.js';
import { recordAudit, auditContext } from '../services/audit.service.js';

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/login',
    {
      // Brute-force protection is tighter here than the global limit.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const body = loginSchema.parse(request.body);
      const result = await authService.login(app, body.email, body.password, {
        userAgent: request.headers['user-agent'],
        ipAddress: request.ip,
      });

      await recordAudit({
        action: 'LOGIN',
        entity: 'User',
        entityId: result.user.id,
        userId: result.user.id,
        userEmail: result.user.email,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return reply.send(result);
    }
  );

  app.post(
    '/refresh',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = refreshSchema.parse(request.body);
      const result = await authService.refresh(app, body.refreshToken, {
        userAgent: request.headers['user-agent'],
        ipAddress: request.ip,
      });
      return reply.send(result);
    }
  );

  app.post('/logout', async (request, reply) => {
    const body = (request.body ?? {}) as { refreshToken?: string };
    await authService.logout(body.refreshToken, request.currentUser?.sub);
    return reply.send({ success: true });
  });

  app.get('/me', { preHandler: [app.authenticate] }, async (request, reply) => {
    const user = await authService.getSessionUser(request.currentUser!.sub);
    return reply.send(user);
  });

  app.post('/change-password', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = changePasswordSchema.parse(request.body);
    await authService.changePassword(
      request.currentUser!.sub,
      body.currentPassword,
      body.newPassword
    );

    await recordAudit({
      action: 'PASSWORD_CHANGE',
      entity: 'User',
      entityId: request.currentUser!.sub,
      ...auditContext(request),
    });

    return reply.send({ success: true, message: 'เปลี่ยนรหัสผ่านเรียบร้อยแล้ว' });
  });
}
