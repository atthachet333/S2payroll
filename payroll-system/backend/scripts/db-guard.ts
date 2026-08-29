/**
 * Datasource safety guard.
 *
 * Runs before every migration, deploy and seed. It parses DATABASE_URL and
 * refuses to continue unless the target database is the dedicated payroll
 * database. This is what stops a stray .env edit from pointing a migration or a
 * seed at the ERP database, which shares the same MariaDB server.
 *
 * The decision logic lives in `checkDatabaseUrl`, a pure function, so it is
 * unit-tested directly rather than by spawning a process.
 *
 * Usage:  tsx scripts/db-guard.ts
 * Exits 0 when the target is safe, 1 otherwise.
 */
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The only database this project is ever allowed to write to. */
export const EXPECTED_DATABASE = 's2apayroll';

/** Databases that must never be touched, matched case-insensitively. */
export const FORBIDDEN_DATABASES = [
  's2a_erp_main',
  's2a_erp',
  'mysql',
  'information_schema',
  'performance_schema',
  'sys',
  'test',
];

export interface GuardResult {
  ok: boolean;
  /** Present when the URL parsed, even if the target was rejected. */
  target?: { host: string; port: string; database: string; user: string };
  message?: string;
  detail?: string;
}

/**
 * Decide whether a DATABASE_URL may be migrated or seeded.
 * Pure: no I/O, no process exit, no environment access.
 */
export function checkDatabaseUrl(raw: string | undefined): GuardResult {
  if (!raw) return { ok: false, message: 'DATABASE_URL is not set.' };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: 'DATABASE_URL could not be parsed as a URL.' };
  }

  const target = {
    host: url.hostname,
    port: url.port || '3306',
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    user: decodeURIComponent(url.username),
  };

  if (!target.database) {
    return { ok: false, target, message: 'DATABASE_URL does not name a database.' };
  }

  if (FORBIDDEN_DATABASES.includes(target.database.toLowerCase())) {
    return {
      ok: false,
      target,
      message: `DATABASE_URL points at "${target.database}", which this project must never modify.`,
      detail: `Host: ${target.host}:${target.port}`,
    };
  }

  if (target.database !== EXPECTED_DATABASE) {
    return {
      ok: false,
      target,
      message: `DATABASE_URL points at "${target.database}" but "${EXPECTED_DATABASE}" was expected.`,
      detail: `Host: ${target.host}:${target.port}`,
    };
  }

  return { ok: true, target };
}

/** CLI wrapper. Only runs when this file is executed directly. */
function main(): void {
  const result = checkDatabaseUrl(process.env.DATABASE_URL);

  if (!result.ok) {
    console.error(`\n  DATABASE SAFETY CHECK FAILED\n`);
    console.error(`  ${result.message}`);
    if (result.detail) console.error(`  ${result.detail}`);
    console.error(`\n  Fix backend/.env so DATABASE_URL points at "${EXPECTED_DATABASE}".\n`);
    process.exit(1);
  }

  const t = result.target!;
  console.log(
    `  Database safety check passed: ${t.user}@${t.host}:${t.port}/${t.database}`
  );
}

// Run only when executed directly, so importing this module from a test is inert.
const invokedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) main();
