import type { FastifyRequest } from 'fastify';
import type { Actor } from '../services/payroll.service.js';
import { unauthorized } from '../utils/errors.js';

/** Build the audit-carrying actor for a request. Routes are always authenticated first. */
export function getActor(request: FastifyRequest): Actor {
  const user = request.currentUser;
  if (!user) throw unauthorized();
  return {
    userId: user.sub,
    email: user.email,
    role: user.role,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}
