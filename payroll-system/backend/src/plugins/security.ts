import fp from 'fastify-plugin';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import sensible from '@fastify/sensible';
import type { FastifyInstance } from 'fastify';
import { corsOrigins, env } from '../config/env.js';

async function securityPlugin(app: FastifyInstance): Promise<void> {
  await app.register(sensible);

  await app.register(helmet, {
    // The API serves JSON only; a restrictive default CSP is fine here.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      // Same-origin / server-to-server calls arrive without an Origin header.
      if (!origin) return cb(null, true);
      cb(null, corsOrigins.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await app.register(cookie);

  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    // Rate limit per authenticated user when we know who they are, per IP otherwise.
    keyGenerator: (request) => request.currentUser?.sub ?? request.ip,
  });
}

export default fp(securityPlugin, { name: 'security' });
