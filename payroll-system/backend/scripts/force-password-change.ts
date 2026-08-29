/**
 * Force a user to change their password at next login.
 *
 * Sets `mustChangePassword = true` and nothing else. It never sets, generates,
 * reads or prints a password — the account keeps its current credential until
 * the holder replaces it through the application.
 *
 * Once flagged, the account receives 403 PASSWORD_CHANGE_REQUIRED on every
 * endpoint except /api/auth/me, /change-password and /logout.
 *
 * Usage:
 *   npm run admin:force-password-change -- --email admin@payroll.local
 *   npm run admin:force-password-change -- --email someone@corp.com --clear
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { checkDatabaseUrl } from './db-guard.js';

const prisma = new PrismaClient();

interface Args {
  email?: string;
  clear: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { clear: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--email' || a === '-e') args.email = argv[i + 1];
    else if (a.startsWith('--email=')) args.email = a.slice('--email='.length);
    else if (a === '--clear') args.clear = true;
  }
  return args;
}

function fail(message: string, hint?: string): never {
  console.error(`\n  REFUSED\n`);
  console.error(`  ${message}`);
  if (hint) console.error(`  ${hint}`);
  console.error('');
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Same database guard as every other script: never the ERP database.
  const guard = checkDatabaseUrl(process.env.DATABASE_URL);
  if (!guard.ok) fail(guard.message ?? 'DATABASE_URL failed the safety check.', guard.detail);

  if (!args.email) {
    fail(
      'No email specified.',
      'Usage: npm run admin:force-password-change -- --email admin@payroll.local'
    );
  }

  const email = args.email.toLowerCase().trim();
  const user = await prisma.user.findUnique({
    where: { email },
    // Never select passwordHash - there is no reason for this script to see it.
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      isActive: true,
      mustChangePassword: true,
      role: { select: { code: true } },
    },
  });

  if (!user) fail(`No user found with email "${email}".`);

  const target = !args.clear;
  if (user.mustChangePassword === target) {
    console.log(
      `\n  ${user.email} already has mustChangePassword = ${target}. Nothing to do.\n`
    );
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { mustChangePassword: target } });

    // Forcing a change also ends existing sessions, so an already-signed-in
    // browser cannot keep working around the requirement.
    if (target) {
      await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await tx.auditLog.create({
      data: {
        action: target ? 'USER_FORCE_PASSWORD_CHANGE' : 'USER_CLEAR_PASSWORD_CHANGE',
        entity: 'User',
        entityId: user.id,
        userEmail: user.email,
        oldValue: { mustChangePassword: user.mustChangePassword },
        newValue: { mustChangePassword: target },
        reason: 'Administrative CLI action (admin:force-password-change)',
      },
    });
  });

  console.log(`\n  ${user.email}  (${user.role.code})`);
  console.log(`  mustChangePassword: ${user.mustChangePassword} -> ${target}`);
  if (target) {
    console.log('  Active sessions revoked.');
    console.log('  The account must set a new password at next login.');
    console.log('  No password was set, generated or displayed by this command.');
  } else {
    console.log('  The forced password change has been cleared.');
  }
  console.log('');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
