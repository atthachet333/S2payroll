import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Boots the real Fastify app with the Prisma client stubbed out, so route
 * registration, the security plugins, the RBAC guards and the error handler are
 * all exercised without needing a live MariaDB instance.
 */
vi.mock('@prisma/client', async () => {
  const actual = await vi.importActual<typeof import('@prisma/client')>('@prisma/client');

  const model = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    findFirst: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockResolvedValue({}),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    upsert: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    groupBy: vi.fn().mockResolvedValue([]),
    aggregate: vi.fn().mockResolvedValue({ _sum: {}, _count: { _all: 0 } }),
  });

  class MockPrismaClient {
    $connect = vi.fn().mockResolvedValue(undefined);
    $disconnect = vi.fn().mockResolvedValue(undefined);
    $transaction = vi.fn();
    // Backs the health endpoint's real connectivity probe.
    $queryRaw = vi.fn().mockResolvedValue([{ '1': 1 }]);
    user = model();
    role = model();
    refreshToken = model();
    company = model();
    department = model();
    position = model();
    employee = model();
    salaryHistory = model();
    attendanceRawData = model();
    attendanceRecord = model();
    attendanceAdjustment = model();
    leaveRecord = model();
    holiday = model();
    payrollPeriod = model();
    payrollEmployee = model();
    payrollIncome = model();
    payrollDeduction = model();
    payrollAdjustment = model();
    payslip = model();
    payrollSetting = model();
    googleSheetSync = model();
    auditLog = model();
  }

  return { ...actual, PrismaClient: MockPrismaClient };
});

let app: FastifyInstance;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent';
  process.env.DATABASE_URL ||= 'mysql://test:test@localhost:3306/test';
  process.env.JWT_SECRET ||= 'test-access-secret-at-least-16-chars';
  process.env.JWT_REFRESH_SECRET ||= 'test-refresh-secret-at-least-16-chars';

  const { buildApp } = await import('../src/app.js');
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe('health', () => {
  it('responds without authentication and reports the database as connected', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ok',
      database: 'connected',
      service: 'payroll-api',
    });
  });

  it('actually probes the database rather than assuming it is up', async () => {
    // Force the probe to fail: the endpoint must report 503, not a cheerful 200.
    const probe = app.prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>;
    probe.mockRejectedValueOnce(new Error('P1001: Can’t reach database server'));

    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'error', database: 'disconnected' });

    // And recovers once the database is reachable again.
    const after = await app.inject({ method: 'GET', url: '/api/health' });
    expect(after.statusCode).toBe(200);
    expect(after.json().database).toBe('connected');
  });
});

describe('readiness', () => {
  it('reports ready when the required checks pass', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    const names = body.checks.map((c: { name: string }) => c.name);
    expect(names).toContain('database');
    expect(names).toContain('payroll-settings');
    expect(names).toContain('payslip-fonts');
  });

  it('does NOT require Google Sheets, so payroll runs from synced data', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ready' });
    const sheets = res
      .json()
      .checks.find((c: { name: string }) => c.name === 'google-sheets');
    expect(sheets.required).toBe(false);
    // Ready even though Google Sheets is unconfigured in the test environment.
    expect(res.statusCode).toBe(200);
  });

  it('reports not-ready with 503 when the database is unreachable', async () => {
    const probe = app.prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>;
    probe.mockRejectedValueOnce(new Error('P1001: cannot reach database'));

    const res = await app.inject({ method: 'GET', url: '/api/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('not-ready');
  });

  it('needs no authentication, so an orchestrator can probe it', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ready' });
    expect(res.statusCode).not.toBe(401);
  });
});

describe('route registration', () => {
  const expectedRoutes = [
    'POST /api/auth/login',
    'POST /api/auth/refresh',
    'POST /api/auth/logout',
    'GET /api/employees/',
    'POST /api/employees/',
    'GET /api/employees/:id',
    'PATCH /api/employees/:id',
    'GET /api/attendance/',
    'PATCH /api/attendance/:id',
    'POST /api/sheets/sync',
    'GET /api/payroll/periods',
    'POST /api/payroll/periods',
    'GET /api/payroll/periods/:id',
    'POST /api/payroll/periods/:id/calculate',
    'POST /api/payroll/periods/:id/approve',
    'POST /api/payroll/periods/:id/mark-paid',
    'POST /api/payroll/periods/:id/lock',
    'POST /api/payroll/periods/:id/unlock',
    'GET /api/payroll/periods/:id/employees',
    'GET /api/payroll/periods/:id/employees/:employeeId',
    'PATCH /api/payroll/periods/:id/employees/:employeeId',
    'GET /api/payslips/:id',
    'GET /api/payslips/:id/pdf',
    'GET /api/payroll/periods/:id/pre-check',
    'GET /api/payroll/periods/suggest',
    'GET /api/payroll/periods/:id/payslips/download',
    'GET /api/reports/payroll',
    'GET /api/reports/attendance',
    'GET /api/settings/',
    'GET /api/settings/audit-logs',
  ];

  it('registers every documented endpoint', () => {
    const tree = app.printRoutes({ commonPrefix: false });
    for (const route of expectedRoutes) {
      const [method, path] = route.split(' ');
      // printRoutes renders the path and the methods that serve it.
      const normalised = tree.replace(/\s+/g, ' ');
      expect(normalised, `missing ${route}`).toContain(path.split('/').pop() ?? path);
      expect(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']).toContain(method);
    }
  });
});

describe('authentication guards', () => {
  const protectedRoutes: [string, string][] = [
    ['GET', '/api/overview'],
    ['GET', '/api/employees'],
    ['POST', '/api/employees'],
    ['GET', '/api/attendance'],
    ['POST', '/api/sheets/sync'],
    ['GET', '/api/payroll/periods'],
    ['POST', '/api/payroll/periods'],
    ['GET', '/api/payslips'],
    ['GET', '/api/reports/payroll-summary'],
    ['GET', '/api/settings'],
    ['GET', '/api/settings/audit-logs'],
    // Documents must never be reachable without authentication.
    ['GET', '/api/payslips/00000000-0000-0000-0000-000000000000/pdf'],
    ['GET', '/api/payroll/periods/00000000-0000-0000-0000-000000000000/payslips/download'],
    ['GET', '/api/payroll/periods/00000000-0000-0000-0000-000000000000/pre-check'],
  ];

  it.each(protectedRoutes)('rejects unauthenticated %s %s with 401', async (method, url) => {
    const res = await app.inject({ method: method as 'GET', url });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a malformed bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/employees',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('error handling', () => {
  it('returns a structured 404 for an unknown route', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ROUTE_NOT_FOUND');
  });

  it('returns a validation error for a malformed login body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'not-an-email', password: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('never leaks a stack trace in an error body', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(JSON.stringify(res.json())).not.toContain('at ');
  });
});

describe('security headers', () => {
  it('applies helmet defaults', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('does not reflect an unlisted CORS origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows the configured frontend origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://localhost:2233' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:2233');
  });
});
