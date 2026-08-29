/**
 * Read-only database verification.
 *
 * Reports the live connection identity, the privileges the application user
 * holds, which databases it can see, and the tables present in the payroll
 * database. Used to prove that the payroll schema landed in `s2apayroll` and
 * that the ERP databases are neither visible nor writable from this project.
 *
 * Executes nothing but SELECT / SHOW statements.
 *
 * Usage: tsx scripts/verify-database.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const FORBIDDEN = ['s2a_erp_main', 's2a_erp'];

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const [identity] = await prisma.$queryRawUnsafe<
    { db: string; version: string; user: string }[]
  >('SELECT DATABASE() AS db, VERSION() AS version, CURRENT_USER() AS user');

  console.log('\n=== Connection ===');
  console.log(`  database : ${identity.db}`);
  console.log(`  server   : ${identity.version}`);
  console.log(`  user     : ${identity.user}`);

  if (identity.db !== 's2apayroll') {
    console.error(`\n  FAIL: connected to "${identity.db}", expected "s2apayroll".`);
    process.exitCode = 1;
  }

  console.log('\n=== Grants ===');
  const grants = await prisma.$queryRawUnsafe<Record<string, string>[]>('SHOW GRANTS');
  for (const row of grants) console.log(`  ${Object.values(row)[0]}`);

  const grantText = grants.map((g) => Object.values(g)[0]).join(' ').toLowerCase();
  const leakedGrant = FORBIDDEN.filter((db) => grantText.includes(db.toLowerCase()));
  console.log(
    leakedGrant.length === 0
      ? '  -> No privileges on any ERP database. Correct.'
      : `  -> FAIL: privileges reference ${leakedGrant.join(', ')}`
  );
  if (leakedGrant.length > 0) process.exitCode = 1;

  console.log('\n=== Databases visible to this user ===');
  const dbs = await prisma.$queryRawUnsafe<Record<string, string>[]>('SHOW DATABASES');
  const names = dbs.map((d) => Object.values(d)[0]);
  for (const name of names) console.log(`  ${name}`);

  const visibleErp = names.filter((n) => FORBIDDEN.includes(n.toLowerCase()));
  console.log(
    visibleErp.length === 0
      ? '  -> ERP databases are not visible to this user. Correct.'
      : `  -> WARNING: ERP database(s) visible: ${visibleErp.join(', ')}`
  );

  console.log('\n=== Tables in s2apayroll ===');
  const tables = await prisma.$queryRawUnsafe<Record<string, string>[]>(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = 's2apayroll' ORDER BY TABLE_NAME"
  );
  if (tables.length === 0) {
    console.log('  (none — migration has not been applied yet)');
  } else {
    for (const t of tables) console.log(`  ${t.name}`);
    console.log(`  -> ${tables.length} tables`);
  }

  if (tables.length > 0) {
    console.log('\n=== Seed data (must not grow when the seed is re-run) ===');
    const counts = {
      roles: await prisma.role.count(),
      users: await prisma.user.count(),
      'admin users': await prisma.user.count({ where: { email: process.env.SEED_ADMIN_EMAIL } }),
      settings: await prisma.payrollSetting.count(),
      companies: await prisma.company.count(),
      departments: await prisma.department.count(),
      positions: await prisma.position.count(),
      employees: await prisma.employee.count(),
      'attendance rows': await prisma.attendanceRecord.count(),
    };
    for (const [label, value] of Object.entries(counts)) {
      console.log(`  ${label.padEnd(16)} ${value}`);
    }

    // Expected cardinalities for the seeded baseline. The settings count is
    // derived from the defaults so adding a setting cannot make this go stale.
    const { DEFAULT_PAYROLL_SETTINGS } = await import('../src/config/payroll-defaults.js');
    const expected: Record<string, number> = {
      roles: 5,
      'admin users': 1,
      settings: DEFAULT_PAYROLL_SETTINGS.length,
      companies: 1,
      departments: 4,
      positions: 4,
      employees: 6,
    };
    const duplicated = Object.entries(expected).filter(([k, v]) => counts[k as keyof typeof counts] !== v);
    console.log(
      duplicated.length === 0
        ? '  -> No duplicates. Seed is idempotent.'
        : `  -> FAIL: unexpected counts for ${duplicated.map(([k]) => k).join(', ')}`
    );
    if (duplicated.length > 0) process.exitCode = 1;
  }

  console.log('');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
