import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors.js';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

async function errorHandlerPlugin(app: FastifyInstance): Promise<void> {
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'ROUTE_NOT_FOUND', message: `${request.method} ${request.url} not found` },
    } satisfies ErrorBody);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message, details: error.details } });
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        const target = (error.meta?.target as string[] | string | undefined) ?? 'field';
        return reply.status(409).send({
          error: {
            code: 'DUPLICATE',
            message: `A record with this ${Array.isArray(target) ? target.join(', ') : target} already exists`,
          },
        });
      }
      if (error.code === 'P2025') {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Record not found' } });
      }
      if (error.code === 'P2003') {
        return reply.status(409).send({
          error: { code: 'FK_CONSTRAINT', message: 'Referenced record is missing or still in use' },
        });
      }
    }

    // Fastify's own validation / rate-limit errors carry a statusCode.
    const fastifyError = error as { statusCode?: number; code?: string; message?: string };
    const statusCode = fastifyError.statusCode ?? 500;
    if (statusCode < 500) {
      return reply.status(statusCode).send({
        error: {
          code: fastifyError.code ?? 'REQUEST_ERROR',
          message: fastifyError.message ?? 'Request could not be processed',
        },
      });
    }

    request.log.error({ err: error }, 'Unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  });
}

export default fp(errorHandlerPlugin, { name: 'error-handler' });
