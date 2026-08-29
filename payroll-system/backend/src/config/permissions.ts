import type { RoleCode } from '@prisma/client';

/**
 * Permission strings follow "<resource>:<action>".
 * Routes declare the permission they need; the RBAC middleware resolves the
 * caller's role to this table. Keeping the matrix in one file means a role
 * change is a single-line edit rather than a hunt through route handlers.
 */
export const PERMISSIONS = [
  'employee:read',
  'employee:write',
  'attendance:read',
  'attendance:write',
  'attendance:sync',
  'payroll:read',
  'payroll:write',
  'payroll:calculate',
  'payroll:approve',
  'payroll:pay',
  'payroll:lock',
  'payroll:unlock',
  'payslip:read',
  'payslip:issue',
  'report:read',
  'settings:read',
  'settings:write',
  'user:read',
  'user:write',
  'audit:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL: Permission[] = [...PERMISSIONS];

const READ_ONLY: Permission[] = [
  'employee:read',
  'attendance:read',
  'payroll:read',
  'payslip:read',
  'report:read',
  'settings:read',
];

/**
 * ADMIN gets everything except unlocking a locked payroll period, which is
 * deliberately reserved for SUPER_ADMIN.
 */
const ADMIN: Permission[] = ALL.filter((p) => p !== 'payroll:unlock');

const HR: Permission[] = [
  'employee:read',
  'employee:write',
  'attendance:read',
  'attendance:write',
  'attendance:sync',
  'report:read',
  'settings:read',
];

const PAYROLL: Permission[] = [
  'employee:read',
  'attendance:read',
  'payroll:read',
  'payroll:write',
  'payroll:calculate',
  'payroll:approve',
  'payroll:pay',
  'payroll:lock',
  'payslip:read',
  'payslip:issue',
  'report:read',
  'settings:read',
];

export const ROLE_PERMISSIONS: Record<RoleCode, Permission[]> = {
  SUPER_ADMIN: ALL,
  ADMIN,
  HR,
  PAYROLL,
  VIEWER: READ_ONLY,
};

export const roleHasPermission = (role: RoleCode, permission: Permission): boolean =>
  ROLE_PERMISSIONS[role]?.includes(permission) ?? false;

export const ROLE_LABELS: Record<RoleCode, string> = {
  SUPER_ADMIN: 'ผู้ดูแลระบบสูงสุด',
  ADMIN: 'ผู้ดูแลระบบ',
  HR: 'ฝ่ายบุคคล',
  PAYROLL: 'ฝ่ายเงินเดือน',
  VIEWER: 'ผู้อ่านอย่างเดียว',
};
