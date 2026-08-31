/**
 * Refresh setting labels/descriptions from the code defaults. Values are never
 * touched; the script asserts that afterwards.
 *
 * Usage: tsx scripts/sync-setting-metadata.ts
 */
import 'dotenv/config';
import { prisma } from '../src/plugins/prisma.js';
import { checkDatabaseUrl } from './db-guard.js';
import { syncSettingMetadata } from '../src/services/settings.service.js';

const guard = checkDatabaseUrl(process.env.DATABASE_URL);
if (!guard.ok) {
  console.error(`DATABASE SAFETY CHECK FAILED: ${guard.message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT DATABASE() AS db');
  console.log(`SELECT DATABASE() => ${db}`);
  if (db !== 's2apayroll') process.exit(1);

  const before = Object.fromEntries(
    (await prisma.payrollSetting.findMany()).map((s) => [s.key, s.value])
  );
  const refreshed = await syncSettingMetadata();
  const after = Object.fromEntries(
    (await prisma.payrollSetting.findMany()).map((s) => [s.key, s.value])
  );

  const drift = Object.keys(before).filter((k) => before[k] !== after[k]);
  console.log(`metadata rows refreshed: ${refreshed}`);
  console.log(`VALUE DRIFT: ${drift.length ? drift.join(', ') : 'none'}`);
  if (drift.length) process.exitCode = 1;

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
