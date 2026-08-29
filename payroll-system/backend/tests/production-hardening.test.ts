import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectConfigIssues } from '../src/config/production-guard.js';
import { payslipFilename } from '../src/services/payslip-pdf.service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(here, '..');

// ---------------------------------------------------------------------------
// Phase 1 - seeded admin password safety
// ---------------------------------------------------------------------------

describe('seed never resets an existing password', () => {
  const seedSource = fs.readFileSync(path.join(backendRoot, 'prisma', 'seed.ts'), 'utf8');

  it('returns early when the admin account already exists', () => {
    const fn = seedSource.slice(
      seedSource.indexOf('async function seedAdmin'),
      seedSource.indexOf('async function seedCompany')
    );
    // The existence check must short-circuit before any create/update runs.
    const guardIndex = fn.indexOf('if (existing)');
    const createIndex = fn.indexOf('prisma.user.create');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(guardIndex);
    expect(fn.slice(guardIndex, createIndex)).toContain('return;');
  });

  it('contains no user update or upsert that could rewrite a password', () => {
    expect(seedSource).not.toMatch(/prisma\.user\.update/);
    expect(seedSource).not.toMatch(/prisma\.user\.upsert/);
    expect(seedSource).not.toMatch(/passwordHash:\s*await argonHash\(env\.SEED_ADMIN_PASSWORD[\s\S]{0,80}update/);
  });

  it('hashes the seed password exactly once, in the create branch only', () => {
    expect(seedSource.match(/argonHash\(/g) ?? []).toHaveLength(1);
  });

  it('never interpolates the seed password value into any log line', () => {
    // Printing the value would leak the credential into logs, CI output and
    // shell history. Mentioning the variable *name* in prose is fine; what must
    // never appear is the interpolated value.
    const interpolations = seedSource.match(/\$\{[^}]*SEED_ADMIN_PASSWORD[^}]*\}/g) ?? [];
    expect(interpolations).toEqual([]);
  });

  it('marks the bootstrap admin as requiring a password change', () => {
    expect(seedSource).toContain('mustChangePassword: true');
  });
});

describe('forced password change is enforced server-side', () => {
  const authSource = fs.readFileSync(path.join(backendRoot, 'src', 'plugins', 'auth.ts'), 'utf8');

  it('blocks ordinary routes while mustChangePassword is set', () => {
    expect(authSource).toContain('mustChangePassword');
    expect(authSource).toContain('PASSWORD_CHANGE_REQUIRED');
  });

  it('still allows the endpoints needed to change the password', () => {
    for (const route of ['/api/auth/me', '/api/auth/change-password', '/api/auth/logout']) {
      expect(authSource).toContain(route);
    }
  });

  it('clears the flag when the password is replaced', () => {
    const authService = fs.readFileSync(
      path.join(backendRoot, 'src', 'services', 'auth.service.ts'),
      'utf8'
    );
    expect(authService).toContain('mustChangePassword: false');
  });
});

// ---------------------------------------------------------------------------
// Phase 9 - production config validation
// ---------------------------------------------------------------------------

const baseConfig = {
  nodeEnv: 'production',
  jwtSecret: 'a'.repeat(48),
  jwtRefreshSecret: 'b'.repeat(48),
  databaseUrl: 'mysql://u:p@192.168.2.135:3306/s2apayroll',
  corsOrigins: ['https://payroll.example.co.th'],
  seedAdminPassword: 'a-strong-unique-password',
  googleSheetsConfigured: true,
  googleSheetId: 'sheet-id',
};

const issuesFor = (o: Partial<typeof baseConfig>) =>
  collectConfigIssues({ ...baseConfig, ...o });

describe('production configuration validation', () => {
  it('passes a correctly configured production environment', () => {
    expect(issuesFor({})).toEqual([]);
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(issuesFor({ databaseUrl: '' }).map((i) => i.variable)).toContain('DATABASE_URL');
  });

  it('rejects the placeholder JWT secrets from .env.example', () => {
    const issues = issuesFor({
      jwtSecret: 'change-me-access-secret-min-32-characters-long',
      jwtRefreshSecret: 'change-me-refresh-secret-min-32-characters',
    });
    expect(issues.filter((i) => i.message.includes('placeholder'))).toHaveLength(2);
  });

  it('rejects short secrets in production', () => {
    const issues = issuesFor({ jwtSecret: 'short' });
    expect(issues.some((i) => i.variable === 'JWT_SECRET' && i.message.includes('at least'))).toBe(true);
  });

  it('rejects identical access and refresh secrets', () => {
    const same = 'c'.repeat(48);
    const issues = issuesFor({ jwtSecret: same, jwtRefreshSecret: same });
    expect(issues.some((i) => i.message.includes('must differ'))).toBe(true);
  });

  it('rejects wildcard CORS in production', () => {
    expect(issuesFor({ corsOrigins: ['*'] }).some((i) => i.variable === 'CORS_ORIGIN')).toBe(true);
  });

  it('rejects an empty CORS allow-list', () => {
    expect(issuesFor({ corsOrigins: [] }).some((i) => i.variable === 'CORS_ORIGIN')).toBe(true);
  });

  it('rejects localhost-only CORS in production', () => {
    expect(
      issuesFor({ corsOrigins: ['http://localhost:2233'] }).some((i) => i.variable === 'CORS_ORIGIN')
    ).toBe(true);
  });

  it('rejects known seed passwords in production', () => {
    for (const pw of ['Admin@12345', 'admin', 'password']) {
      expect(
        issuesFor({ seedAdminPassword: pw }).some((i) => i.variable === 'SEED_ADMIN_PASSWORD'),
        pw
      ).toBe(true);
    }
  });

  it('rejects a half-configured Google Sheets integration', () => {
    const issues = issuesFor({ googleSheetsConfigured: false, googleSheetId: 'abc' });
    expect(issues.some((i) => i.variable.includes('GOOGLE_'))).toBe(true);
  });

  it('does not complain when Google Sheets is entirely unconfigured', () => {
    expect(issuesFor({ googleSheetsConfigured: false, googleSheetId: '' })).toEqual([]);
  });

  it('is lenient outside production but still flags placeholders', () => {
    const dev = issuesFor({
      nodeEnv: 'development',
      corsOrigins: ['http://localhost:2233'],
      seedAdminPassword: 'Admin@12345',
      jwtSecret: 'change-me-access-secret-min-32-characters-long',
    });
    // Localhost CORS and the seed password are fine in development...
    expect(dev.some((i) => i.variable === 'CORS_ORIGIN')).toBe(false);
    expect(dev.some((i) => i.variable === 'SEED_ADMIN_PASSWORD')).toBe(false);
    // ...but a placeholder secret is always worth reporting.
    expect(dev.some((i) => i.message.includes('placeholder'))).toBe(true);
  });

  it('never includes a secret value in an issue message', () => {
    const secret = 'super-secret-value-that-must-not-leak-0000';
    const issues = collectConfigIssues({
      ...baseConfig,
      jwtSecret: secret,
      jwtRefreshSecret: secret,
      databaseUrl: 'mysql://user:hunter2@host:3306/s2apayroll',
    });
    const text = JSON.stringify(issues);
    expect(text).not.toContain(secret);
    expect(text).not.toContain('hunter2');
  });
});

// ---------------------------------------------------------------------------
// Phase 3/4 - PDF filenames
// ---------------------------------------------------------------------------

describe('payslip PDF filenames', () => {
  it('builds the documented filename shape', () => {
    expect(payslipFilename('EMP001', '2026-07')).toBe('payslip-EMP001-2026-07.pdf');
  });

  it('strips characters that are unsafe in a filesystem or a ZIP entry', () => {
    expect(payslipFilename('../../etc/passwd', '2026-07')).not.toContain('/');
    expect(payslipFilename('../../etc/passwd', '2026-07')).not.toContain('..');
    expect(payslipFilename('EMP 001', '2026/07')).toBe('payslip-EMP001-202607.pdf');
  });

  it('strips Thai and other non-ASCII characters rather than emitting them raw', () => {
    const name = payslipFilename('พนักงาน001', '2026-07');
    expect(/^[\x20-\x7E]+$/.test(name)).toBe(true);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('never produces an empty identifier', () => {
    expect(payslipFilename('', '')).toBe('payslip-unknown-unknown.pdf');
  });
});

// ---------------------------------------------------------------------------
// Phase 2 - cleanup script safety
// ---------------------------------------------------------------------------

describe('test-payroll cleanup script safety', () => {
  const source = fs.readFileSync(
    path.join(backendRoot, 'scripts', 'cleanup-test-payroll.ts'),
    'utf8'
  );

  it('refuses to run when NODE_ENV is production', () => {
    expect(source).toContain("nodeEnv === 'production'");
    expect(source).toMatch(/NODE_ENV is "production"/);
  });

  it('routes through the shared database guard', () => {
    expect(source).toContain('checkDatabaseUrl');
    expect(source).toContain('EXPECTED_DATABASE');
  });

  it('requires an explicit period and has no bulk mode', () => {
    expect(source).toContain('No payroll period specified');
    expect(source).not.toMatch(/--all\b/);
    expect(source).not.toMatch(/payrollPeriod\.deleteMany/);
  });

  it('requires --confirm before deleting anything', () => {
    expect(source).toContain('args.confirm');
    expect(source).toContain('Dry run only');
  });

  it('deletes only payroll output tables', () => {
    for (const table of [
      'payslip.deleteMany',
      'payrollAdjustment.deleteMany',
      'payrollIncome.deleteMany',
      'payrollDeduction.deleteMany',
      'payrollEmployee.deleteMany',
      'payrollPeriod.delete',
    ]) {
      expect(source, table).toContain(table);
    }
  });

  it('never deletes master data', () => {
    for (const forbidden of [
      'employee.deleteMany',
      'attendanceRecord.deleteMany',
      'attendanceRawData.deleteMany',
      'user.deleteMany',
      'payrollSetting.deleteMany',
      'company.deleteMany',
      'department.deleteMany',
      'auditLog.deleteMany',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('refuses to delete a locked period', () => {
    expect(source).toContain("period.status === 'LOCKED'");
  });

  it('writes an audit entry for the deletion', () => {
    expect(source).toContain('PAYROLL_PERIOD_CLEANUP');
  });
});

// ---------------------------------------------------------------------------
// Phase 8 - audit coverage
// ---------------------------------------------------------------------------

describe('audit coverage', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(backendRoot, ...p), 'utf8');
  const sources = [
    read('src', 'services', 'attendance.service.ts'),
    read('src', 'services', 'payroll.service.ts'),
    read('src', 'services', 'payslip.service.ts'),
    read('src', 'services', 'google-sheets.service.ts'),
    read('src', 'routes', 'payslip.routes.ts'),
    read('src', 'routes', 'payroll.routes.ts'),
    read('src', 'routes', 'auth.routes.ts'),
  ].join('\n');

  const REQUIRED_ACTIONS = [
    'ATTENDANCE_CORRECT',
    'PAYROLL_CALCULATE',
    'PAYROLL_ADJUST',
    'PAYROLL_APPROVE',
    'PAYROLL_MARK_PAID',
    'PAYROLL_LOCK',
    'PAYROLL_UNLOCK',
    'PAYSLIP_PDF_DOWNLOAD',
    'PAYSLIP_BULK_EXPORT',
    'SHEET_SYNC',
  ];

  for (const action of REQUIRED_ACTIONS) {
    it(`records ${action}`, () => {
      expect(sources).toContain(action);
    });
  }

  it('records a reason on unlock', () => {
    const payroll = read('src', 'services', 'payroll.service.ts');
    const unlockFn = payroll.slice(payroll.indexOf('export async function unlockPeriod'));
    expect(unlockFn).toContain("action: 'PAYROLL_UNLOCK'");
    expect(unlockFn).toContain('reason,');
  });

  it('never writes a password, token or connection string into an audit record', () => {
    const auditService = read('src', 'services', 'audit.service.ts');
    for (const secret of ['passwordHash', 'accessToken', 'refreshToken', 'DATABASE_URL', 'JWT_SECRET']) {
      expect(auditService, secret).not.toContain(secret);
    }
  });
});
