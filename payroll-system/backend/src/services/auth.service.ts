import crypto from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../plugins/prisma.js';
import { env } from '../config/env.js';
import { ROLE_PERMISSIONS } from '../config/permissions.js';
import { unauthorized, badRequest } from '../utils/errors.js';
import { dayjs } from '../utils/datetime.js';

/** OWASP-aligned Argon2id parameters (19 MiB, 2 iterations, 1 lane). */
const ARGON_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (plain: string): Promise<string> => argonHash(plain, ARGON_OPTIONS);

export const verifyPassword = (hashValue: string, plain: string): Promise<boolean> =>
  argonVerify(hashValue, plain).catch(() => false);

/** Refresh tokens are stored as SHA-256 digests so a DB leak cannot replay them. */
const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');

const parseTtlToDate = (ttl: string): Date => {
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) return dayjs().add(7, 'day').toDate();
  const value = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  const unitMap = { s: 'second', m: 'minute', h: 'hour', d: 'day' } as const;
  return dayjs().add(value, unitMap[unit]).toDate();
};

export interface SessionUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  permissions: string[];
  employeeId: string | null;
  mustChangePassword: boolean;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
}

const toSessionUser = (user: {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  employeeId: string | null;
  mustChangePassword: boolean;
  role: { code: keyof typeof ROLE_PERMISSIONS };
}): SessionUser => ({
  id: user.id,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  role: user.role.code,
  permissions: ROLE_PERMISSIONS[user.role.code],
  employeeId: user.employeeId,
  mustChangePassword: user.mustChangePassword,
});

async function issueTokens(
  app: FastifyInstance,
  user: Parameters<typeof toSessionUser>[0],
  meta: { userAgent?: string | null; ipAddress?: string | null }
): Promise<AuthResult> {
  const accessToken = app.jwt.sign(
    { sub: user.id, email: user.email, role: user.role.code, type: 'access' },
    { expiresIn: env.JWT_ACCESS_TTL }
  );

  // Refresh tokens are opaque random strings tracked in the DB, so logout and
  // rotation can revoke them server-side.
  const refreshToken = crypto.randomBytes(48).toString('hex');
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: parseTtlToDate(env.JWT_REFRESH_TTL),
      userAgent: meta.userAgent?.slice(0, 255) ?? null,
      ipAddress: meta.ipAddress ?? null,
    },
  });

  return { accessToken, refreshToken, user: toSessionUser(user) };
}

export async function login(
  app: FastifyInstance,
  email: string,
  password: string,
  meta: { userAgent?: string | null; ipAddress?: string | null }
): Promise<AuthResult> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    include: { role: true },
  });

  // Same generic message whether the account is missing, disabled, or the
  // password is wrong, so the endpoint cannot be used to enumerate accounts.
  if (!user || !user.isActive) throw unauthorized('อีเมลหรือรหัสผ่านไม่ถูกต้อง');

  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) throw unauthorized('อีเมลหรือรหัสผ่านไม่ถูกต้อง');

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  return issueTokens(app, user, meta);
}

export async function refresh(
  app: FastifyInstance,
  refreshToken: string,
  meta: { userAgent?: string | null; ipAddress?: string | null }
): Promise<AuthResult> {
  const tokenHash = hashToken(refreshToken);
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: { include: { role: true } } },
  });

  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    throw unauthorized('Refresh token is invalid or expired');
  }
  if (!stored.user.isActive) throw unauthorized('Account is disabled');

  // Rotate: the presented token is revoked as part of issuing the new pair.
  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date() },
  });

  return issueTokens(app, stored.user, meta);
}

export async function logout(refreshToken: string | undefined, userId?: string): Promise<void> {
  if (refreshToken) {
    await prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return;
  }
  if (userId) {
    await prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw unauthorized('User not found');

  const ok = await verifyPassword(user.passwordHash, currentPassword);
  if (!ok) throw badRequest('รหัสผ่านปัจจุบันไม่ถูกต้อง');

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      // Replacing the password satisfies the forced-change requirement.
      data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false },
    }),
    // Changing a password invalidates every existing session.
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}

export async function getSessionUser(userId: string): Promise<SessionUser> {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
  if (!user) throw unauthorized('User not found');
  return toSessionUser(user);
}
