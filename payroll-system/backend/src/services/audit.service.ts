import type { Prisma, PrismaClient } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import { prisma as defaultPrisma } from '../plugins/prisma.js';

export interface AuditInput {
  action: string;
  entity: string;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  userId?: string | null;
  userEmail?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * Append-only audit trail. Failures are logged but never propagate - an audit
 * write must not roll back the business operation it is describing, except when
 * the caller passes a transaction client and explicitly wants them to share fate.
 */
export async function recordAudit(input: AuditInput, client: Client = defaultPrisma): Promise<void> {
  try {
    await client.auditLog.create({
      data: {
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        oldValue: (input.oldValue ?? null) as Prisma.InputJsonValue,
        newValue: (input.newValue ?? null) as Prisma.InputJsonValue,
        reason: input.reason ?? null,
        userId: input.userId ?? null,
        userEmail: input.userEmail ?? null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent?.slice(0, 255) ?? null,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[audit] failed to write audit log', err);
  }
}

/** Pull the actor + request metadata off a Fastify request for an audit entry. */
export function auditContext(request: FastifyRequest): Pick<
  AuditInput,
  'userId' | 'userEmail' | 'ipAddress' | 'userAgent'
> {
  return {
    userId: request.currentUser?.sub ?? null,
    userEmail: request.currentUser?.email ?? null,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

export async function listAuditLogs(params: {
  page: number;
  pageSize: number;
  entity?: string;
  entityId?: string;
  userId?: string;
  action?: string;
  from?: Date;
  to?: Date;
}) {
  const where: Prisma.AuditLogWhereInput = {
    ...(params.entity ? { entity: params.entity } : {}),
    ...(params.entityId ? { entityId: params.entityId } : {}),
    ...(params.userId ? { userId: params.userId } : {}),
    ...(params.action ? { action: params.action } : {}),
    ...(params.from || params.to
      ? {
          createdAt: {
            ...(params.from ? { gte: params.from } : {}),
            ...(params.to ? { lte: params.to } : {}),
          },
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    defaultPrisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    defaultPrisma.auditLog.count({ where }),
  ]);

  return { items, total, page: params.page, pageSize: params.pageSize };
}
