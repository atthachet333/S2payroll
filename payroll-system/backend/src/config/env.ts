import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(2234),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),

  /**
   * Allowed browser origins, comma separated.
   * CORS_ORIGINS (plural) is accepted as an alias because some deployment
   * tooling prefers it; whichever is set wins, with the singular taking
   * precedence when both are present.
   */
  CORS_ORIGIN: z.string().default('http://localhost:2233'),
  CORS_ORIGINS: z.string().optional(),

  /** Public base URL of the application, used in operational messages. */
  APP_BASE_URL: z.string().default('http://localhost:2233'),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),

  GOOGLE_PROJECT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_EMAIL: z.string().optional().default(''),
  GOOGLE_PRIVATE_KEY: z.string().optional().default(''),
  GOOGLE_SHEET_ID: z.string().optional().default(''),
  /** Tab holding attendance. The A1 range is derived from this. */
  GOOGLE_ATTENDANCE_SHEET_NAME: z.string().optional().default('Attendance'),
  /**
   * Explicit A1 range override. Normally left blank so the range is derived
   * from GOOGLE_ATTENDANCE_SHEET_NAME across a wide column span.
   */
  GOOGLE_SHEET_RANGE: z.string().optional().default(''),

  SEED_ADMIN_EMAIL: z.string().email().default('admin@payroll.local'),
  SEED_ADMIN_PASSWORD: z.string().min(8).default('Admin@12345'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const env = parsed.data;

/** Origins allowed by CORS. Supports a comma separated list. */
export const corsOrigins = (env.CORS_ORIGIN || env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/**
 * Service-account private keys are stored in .env with literal "\n" sequences.
 * Restore the real newlines before handing the key to google-auth-library.
 */
export const googlePrivateKey = env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

export const isGoogleSheetsConfigured = (): boolean =>
  Boolean(env.GOOGLE_CLIENT_EMAIL && googlePrivateKey && env.GOOGLE_SHEET_ID);

/**
 * Build the A1 range for a sheet tab.
 *
 * Spans A:Z rather than A:D because columns are resolved by header NAME, not by
 * position: a real timesheet often carries extra columns (running number, name,
 * department, notes) and a narrow range would silently truncate the ones that
 * matter. Tab names containing spaces or punctuation are quoted.
 */
export function buildSheetRange(sheetName: string): string {
  const name = sheetName.trim() || 'Attendance';
  // An apostrophe inside a sheet name is escaped by doubling it in A1 notation.
  const needsQuotes = !/^[A-Za-z0-9_]+$/.test(name);
  const quoted = needsQuotes ? `'${name.replace(/'/g, "''")}'` : name;
  return `${quoted}!A:Z`;
}

/**
 * The range actually read. An explicit GOOGLE_SHEET_RANGE always wins; other-
 * wise it is derived from GOOGLE_ATTENDANCE_SHEET_NAME.
 */
export const attendanceRange = (): string =>
  env.GOOGLE_SHEET_RANGE.trim() || buildSheetRange(env.GOOGLE_ATTENDANCE_SHEET_NAME);
