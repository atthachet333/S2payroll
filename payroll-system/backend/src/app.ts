import Fastify, { type FastifyInstance } from 'fastify';
import { env } from './config/env.js';
import prismaPlugin from './plugins/prisma.js';
import securityPlugin from './plugins/security.js';
import authPlugin from './plugins/auth.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import registerRoutes from './routes/index.js';

/** Build the Fastify instance. Kept separate from server.ts so tests can boot it. */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
          : undefined,
      // Keep credentials and tokens out of the logs.
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password'],
    },
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
  });

  await app.register(errorHandlerPlugin);
  await app.register(prismaPlugin);
  await app.register(securityPlugin);
  await app.register(authPlugin);
  await app.register(registerRoutes);

  return app;
}
