import { env, corsOrigins, isGoogleSheetsConfigured } from './env.js';

/**
 * Fail-fast validation of unsafe production configuration.
 *
 * Zod already guarantees the shape of the environment. This adds the checks
 * that shape cannot express: that secrets are not the shipped placeholders,
 * that CORS is not wide open, and that a known seed password is not still in
 * use. Every message names the variable but never prints its value.
 */

/** Placeholder values shipped in .env.example. Using them in production is fatal. */
const PLACEHOLDER_SECRETS = [
  'change-me-access-secret-min-32-characters-long',
  'change-me-refresh-secret-min-32-characters',
  'changeme',
  'secret',
  'your-secret-here',
];

/** Seed passwords that must never remain active in production. */
const KNOWN_SEED_PASSWORDS = ['Admin@12345', 'admin', 'password', 'Password123'];

const MIN_PRODUCTION_SECRET_LENGTH = 32;

export interface ConfigIssue {
  variable: string;
  message: string;
}

/**
 * Collect configuration problems. Pure - returns findings rather than exiting,
 * so it is directly testable.
 */
export function collectConfigIssues(options: {
  nodeEnv: string;
  jwtSecret: string;
  jwtRefreshSecret: string;
  databaseUrl: string;
  corsOrigins: string[];
  seedAdminPassword: string;
  googleSheetsConfigured: boolean;
  googleSheetId: string;
}): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const isProduction = options.nodeEnv === 'production';

  if (!options.databaseUrl) {
    issues.push({ variable: 'DATABASE_URL', message: 'is required' });
  }

  for (const [variable, value] of [
    ['JWT_SECRET', options.jwtSecret],
    ['JWT_REFRESH_SECRET', options.jwtRefreshSecret],
  ] as const) {
    if (!value) {
      issues.push({ variable, message: 'is required' });
      continue;
    }
    if (PLACEHOLDER_SECRETS.includes(value.toLowerCase()) || PLACEHOLDER_SECRETS.includes(value)) {
      issues.push({ variable, message: 'is still set to the placeholder from .env.example' });
    }
    if (isProduction && value.length < MIN_PRODUCTION_SECRET_LENGTH) {
      issues.push({
        variable,
        message: `must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production`,
      });
    }
  }

  if (options.jwtSecret && options.jwtSecret === options.jwtRefreshSecret) {
    issues.push({
      variable: 'JWT_REFRESH_SECRET',
      message: 'must differ from JWT_SECRET',
    });
  }

  if (options.corsOrigins.length === 0) {
    issues.push({ variable: 'CORS_ORIGIN', message: 'must list at least one allowed origin' });
  }
  if (isProduction) {
    if (options.corsOrigins.includes('*')) {
      issues.push({ variable: 'CORS_ORIGIN', message: 'must not be "*" in production' });
    }
    const localhostOnly = options.corsOrigins.every((o) => /localhost|127\.0\.0\.1/.test(o));
    if (localhostOnly) {
      issues.push({
        variable: 'CORS_ORIGIN',
        message: 'points only at localhost, which is unlikely to be correct in production',
      });
    }
    if (options.corsOrigins.some((o) => o.startsWith('http://'))) {
      issues.push({
        variable: 'CORS_ORIGIN',
        message: 'uses plain http in production; expected https',
      });
    }
  }

  if (isProduction && KNOWN_SEED_PASSWORDS.includes(options.seedAdminPassword)) {
    issues.push({
      variable: 'SEED_ADMIN_PASSWORD',
      message: 'is a known default seed password and must not be used in production',
    });
  }

  // Only meaningful once the integration is partially configured: a half-filled
  // Google config silently disables sync, which is worse than failing loudly.
  if (options.googleSheetId && !options.googleSheetsConfigured) {
    issues.push({
      variable: 'GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY',
      message: 'GOOGLE_SHEET_ID is set but the service-account credentials are incomplete',
    });
  }

  return issues;
}

/**
 * Run the checks against the live environment.
 * In production any issue is fatal; elsewhere issues are warnings so local
 * development with placeholder values still runs.
 */
export function assertProductionConfig(logger: {
  error: (msg: string) => void;
  warn: (msg: string) => void;
}): void {
  const issues = collectConfigIssues({
    nodeEnv: env.NODE_ENV,
    jwtSecret: env.JWT_SECRET,
    jwtRefreshSecret: env.JWT_REFRESH_SECRET,
    databaseUrl: env.DATABASE_URL,
    corsOrigins,
    seedAdminPassword: env.SEED_ADMIN_PASSWORD,
    googleSheetsConfigured: isGoogleSheetsConfigured(),
    googleSheetId: env.GOOGLE_SHEET_ID,
  });

  if (issues.length === 0) return;

  const lines = issues.map((i) => `  - ${i.variable} ${i.message}`).join('\n');

  if (env.NODE_ENV === 'production') {
    logger.error(`Unsafe production configuration detected:\n${lines}`);
    // Refuse to serve rather than run a production system with known-weak config.
    process.exit(1);
  }

  logger.warn(`Configuration warnings (fatal in production):\n${lines}`);
}
