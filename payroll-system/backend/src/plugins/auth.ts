import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RoleCode } from '@prisma/client';
import { env } from '../config/env.js';
import { roleHasPermission, type Permission } from '../config/permissions.js';
import { AppError, forbidden, unauthorized } from '../utils/errors.js';

/**
 * Routes an account with mustChangePassword set may still reach: everything
 * needed to inspect the session and replace the password, and nothing else.
 */
const PASSWORD_CHANGE_ALLOWED = new Set([
  '/api/auth/me',
  '/api/auth/change-password',
  '/api/auth/logout',
]);

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: RoleCode;
  type: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  type: 'refresh';
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Verify the bearer access token and attach `request.currentUser`. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Guard a route with a single permission from the RBAC matrix. */
    requirePermission: (
      permission: Permission
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Guard a route by explicit role list (used for unlock). */
    requireRole: (
      ...roles: RoleCode[]
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    currentUser?: AccessTokenPayload;
  }
}

async function authPlugin(app: FastifyInstance): Promise<void> {
  await app.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_ACCESS_TTL },
  });

  app.decorate('authenticate', async (request: FastifyRequest) => {
    let payload: AccessTokenPayload;
    try {
      payload = await request.jwtVerify<AccessTokenPayload>();
    } catch {
      throw unauthorized('Invalid or expired access token');
    }
    if (payload.type !== 'access') {
      throw unauthorized('Refresh token cannot be used to access resources');
    }

    // A token stays valid until it expires, so re-check that the account is
    // still enabled on every request rather than trusting the claim alone.
    const user = await app.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        isActive: true,
        mustChangePassword: true,
        role: { select: { code: true } },
      },
    });
    if (!user || !user.isActive) throw unauthorized('Account is disabled');

    // An account still carrying the bootstrap password may only reach the
    // endpoints needed to replace it. Enforced here rather than only in the UI,
    // so a known seed credential cannot be used against the API directly.
    if (user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(request.routeOptions.url ?? '')) {
      throw new AppError(
        403,
        'PASSWORD_CHANGE_REQUIRED',
        'ต้องเปลี่ยนรหัสผ่านก่อนใช้งานระบบ'
      );
    }

    request.currentUser = { ...payload, role: user.role.code };
  });

  app.decorate(
    'requirePermission',
    (permission: Permission) => async (request: FastifyRequest, reply: FastifyReply) => {
      await app.authenticate(request, reply);
      const user = request.currentUser;
      if (!user || !roleHasPermission(user.role, permission)) {
        throw forbidden(`Missing permission: ${permission}`);
      }
    }
  );

  app.decorate(
    'requireRole',
    (...roles: RoleCode[]) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        await app.authenticate(request, reply);
        const user = request.currentUser;
        if (!user || !roles.includes(user.role)) {
          throw forbidden(`Requires role: ${roles.join(', ')}`);
        }
      }
  );
}

export default fp(authPlugin, { name: 'auth', dependencies: ['prisma'] });
