import { describe, it, expect } from 'vitest';
import type { RoleCode } from '@prisma/client';
import { ROLE_PERMISSIONS, roleHasPermission, PERMISSIONS, type Permission } from '../src/config/permissions.js';
import {
  checkDatabaseUrl,
  EXPECTED_DATABASE,
  FORBIDDEN_DATABASES,
} from '../scripts/db-guard.js';

const ROLES: RoleCode[] = ['SUPER_ADMIN', 'ADMIN', 'HR', 'PAYROLL', 'VIEWER'];

const WRITE_PERMISSIONS: Permission[] = [
  'employee:write',
  'attendance:write',
  'attendance:sync',
  'payroll:write',
  'payroll:calculate',
  'payroll:approve',
  'payroll:pay',
  'payroll:lock',
  'payroll:unlock',
  'payslip:issue',
  'settings:write',
  'user:write',
];

describe('RBAC matrix', () => {
  it('grants SUPER_ADMIN every permission', () => {
    for (const permission of PERMISSIONS) {
      expect(roleHasPermission('SUPER_ADMIN', permission), permission).toBe(true);
    }
  });

  it('reserves payroll:unlock for SUPER_ADMIN alone', () => {
    expect(roleHasPermission('SUPER_ADMIN', 'payroll:unlock')).toBe(true);
    for (const role of ROLES.filter((r) => r !== 'SUPER_ADMIN')) {
      expect(roleHasPermission(role, 'payroll:unlock'), role).toBe(false);
    }
  });

  it('gives ADMIN everything except payroll:unlock', () => {
    for (const permission of PERMISSIONS) {
      const expected = permission !== 'payroll:unlock';
      expect(roleHasPermission('ADMIN', permission), permission).toBe(expected);
    }
  });

  it('denies VIEWER every write permission', () => {
    for (const permission of WRITE_PERMISSIONS) {
      expect(roleHasPermission('VIEWER', permission), permission).toBe(false);
    }
  });

  it('gives VIEWER read access without any mutation rights', () => {
    expect(roleHasPermission('VIEWER', 'employee:read')).toBe(true);
    expect(roleHasPermission('VIEWER', 'payroll:read')).toBe(true);
    expect(roleHasPermission('VIEWER', 'report:read')).toBe(true);
    expect(ROLE_PERMISSIONS.VIEWER.every((p) => p.endsWith(':read'))).toBe(true);
  });

  it('keeps HR out of payroll entirely', () => {
    for (const permission of PERMISSIONS.filter((p) => p.startsWith('payroll:'))) {
      expect(roleHasPermission('HR', permission), permission).toBe(false);
    }
    expect(roleHasPermission('HR', 'payslip:issue')).toBe(false);
  });

  it('lets HR manage employees and attendance', () => {
    expect(roleHasPermission('HR', 'employee:write')).toBe(true);
    expect(roleHasPermission('HR', 'attendance:write')).toBe(true);
    expect(roleHasPermission('HR', 'attendance:sync')).toBe(true);
  });

  it('keeps PAYROLL out of employee and attendance mutation', () => {
    expect(roleHasPermission('PAYROLL', 'employee:write')).toBe(false);
    expect(roleHasPermission('PAYROLL', 'attendance:write')).toBe(false);
    expect(roleHasPermission('PAYROLL', 'employee:read')).toBe(true);
  });

  it('lets PAYROLL run the payroll cycle but not unlock it', () => {
    for (const p of ['payroll:calculate', 'payroll:approve', 'payroll:pay', 'payroll:lock'] as Permission[]) {
      expect(roleHasPermission('PAYROLL', p), p).toBe(true);
    }
    expect(roleHasPermission('PAYROLL', 'payroll:unlock')).toBe(false);
  });

  it('restricts audit log access to SUPER_ADMIN and ADMIN', () => {
    expect(roleHasPermission('SUPER_ADMIN', 'audit:read')).toBe(true);
    expect(roleHasPermission('ADMIN', 'audit:read')).toBe(true);
    for (const role of ['HR', 'PAYROLL', 'VIEWER'] as RoleCode[]) {
      expect(roleHasPermission(role, 'audit:read'), role).toBe(false);
    }
  });

  it('defines a permission list for every role with no unknown entries', () => {
    for (const role of ROLES) {
      expect(Array.isArray(ROLE_PERMISSIONS[role]), role).toBe(true);
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(PERMISSIONS, `${role}:${permission}`).toContain(permission);
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe('database safety guard', () => {
  it('allows the dedicated payroll database', () => {
    const result = checkDatabaseUrl('mysql://s2apayroll:pw@192.168.2.135:3306/s2apayroll');
    expect(result.ok).toBe(true);
    expect(result.target).toMatchObject({
      host: '192.168.2.135',
      port: '3306',
      database: 's2apayroll',
      user: 's2apayroll',
    });
  });

  it('refuses the ERP database that shares the same server', () => {
    const result = checkDatabaseUrl('mysql://root:pw@192.168.2.135:3306/s2a_erp_main');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('s2a_erp_main');
    expect(result.message).toContain('never modify');
  });

  it('refuses the secondary ERP database', () => {
    expect(checkDatabaseUrl('mysql://root:pw@143.14.200.109:3306/s2a_erp').ok).toBe(false);
  });

  it('refuses system and scratch databases', () => {
    for (const db of ['mysql', 'information_schema', 'performance_schema', 'sys', 'test']) {
      expect(checkDatabaseUrl(`mysql://root:pw@192.168.2.135:3306/${db}`).ok, db).toBe(false);
    }
  });

  it('is case-insensitive about forbidden names', () => {
    expect(checkDatabaseUrl('mysql://r:p@h:3306/S2A_ERP_MAIN').ok).toBe(false);
    expect(checkDatabaseUrl('mysql://r:p@h:3306/S2a_Erp_Main').ok).toBe(false);
  });

  it('refuses any other database name, including near-misses', () => {
    for (const db of ['payroll_db', 's2apayroll_old', 's2apayrol', 'S2APAYROLL', 's2apayroll_backup']) {
      expect(checkDatabaseUrl(`mysql://u:p@127.0.0.1:3306/${db}`).ok, db).toBe(false);
    }
  });

  it('refuses a missing or empty DATABASE_URL', () => {
    expect(checkDatabaseUrl(undefined).ok).toBe(false);
    expect(checkDatabaseUrl('').ok).toBe(false);
  });

  it('refuses an unparseable DATABASE_URL', () => {
    expect(checkDatabaseUrl('not-a-url').ok).toBe(false);
  });

  it('refuses a URL that names no database at all', () => {
    expect(checkDatabaseUrl('mysql://u:p@127.0.0.1:3306/').ok).toBe(false);
    expect(checkDatabaseUrl('mysql://u:p@127.0.0.1:3306').ok).toBe(false);
  });

  it('lists both ERP databases as forbidden', () => {
    expect(FORBIDDEN_DATABASES).toContain('s2a_erp_main');
    expect(FORBIDDEN_DATABASES).toContain('s2a_erp');
    expect(EXPECTED_DATABASE).toBe('s2apayroll');
  });
});
