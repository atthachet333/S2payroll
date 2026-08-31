/**
 * Restores the four attendance settings the operator had changed on
 * 2026-08-29T04:04:36Z, recovered from the SETTINGS_UPDATE audit entry read
 * before the database was cleared.
 *
 * The seed rewrites these to their defaults, so this puts the operator's own
 * values back rather than leaving the system quietly running on defaults.
 *
 * Usage: tsx scripts/restore-user-settings.ts [--confirm]
 */
import 'dotenv/config';
import { prisma } from '../src/plugins/prisma.js';
import { checkDatabaseUrl } from './db-guard.js';

const CONFIRM = process.argv.includes('--confirm');

/** Exactly the newValue payload of the operator's own SETTINGS_UPDATE audit row. */
const OPERATOR_VALUES: Record<string, string> = {
  COUNT_WEEKEND_AS_WORKDAY: 'true',
  LATE_GRACE_MINUTES: '30',
  WORK_START_TIME: '08:00',
  WORK_END_TIME: '17:30',
};

const guard = checkDatabaseUrl(process.env.DATABASE_URL);
if (!guard.ok) {
  console.error(`DATABASE SAFETY CHECK FAILED: ${guard.message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT DATABASE() AS db');
  console.log(`SELECT DATABASE() => ${db}`);
  if (db !== 's2apayroll') process.exit(1);

  for (const [key, value] of Object.entries(OPERATOR_VALUES)) {
    const current = await prisma.payrollSetting.findUnique({ where: { key } });
    if (!current) {
      console.log(`  ${key.padEnd(26)} MISSING - skipped`);
      continue;
    }
    const change = current.value === value ? 'already set' : `${current.value} -> ${value}`;
    console.log(`  ${key.padEnd(26)} ${change}`);
    if (CONFIRM && current.value !== value) {
      await prisma.payrollSetting.update({ where: { key }, data: { value } });
    }
  }

  if (!CONFIRM) console.log('\nDRY RUN - re-run with --confirm to apply.');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
