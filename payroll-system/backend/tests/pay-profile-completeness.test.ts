import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EmploymentType, PayType, Prisma } from '@prisma/client';
import {
  evaluateEmployeeProfileCompleteness,
  type CompletenessInput,
} from '../src/services/employee-completeness.service.js';
import { resolveEffectivePayProfile } from '../src/services/pay-profile-resolution.js';

const date = (value: string) => new Date(`${value}T00:00:00.000Z`);
const profile = (
  payType: PayType,
  amount: string,
  from = '2026-01-01',
  to: string | null = null
) => ({
  id: `${payType}-${from}`,
  payType,
  monthlySalary: payType === PayType.MONTHLY ? new Prisma.Decimal(amount) : null,
  hourlyRate: payType === PayType.HOURLY ? new Prisma.Decimal(amount) : null,
  effectiveFrom: date(from),
  effectiveTo: to ? date(to) : null,
  isActive: true,
});

const employee = (
  employmentType: EmploymentType,
  payProfiles: ReturnType<typeof profile>[],
  baseSalary = '0'
): CompletenessInput => ({
  employeeCode: 'S2ATEST',
  firstName: 'Test',
  lastName: 'Employee',
  employmentType,
  departmentId: 'department',
  positionId: 'position',
  startDate: date('2026-01-01'),
  status: 'ACTIVE',
  attendanceRequired: true,
  leaveTrackingRequired: true,
  baseSalary,
  payProfiles,
});

const completeOn = (input: CompletenessInput, on: string) =>
  evaluateEmployeeProfileCompleteness(input, date(on)).complete;

describe('canonical employee compensation completeness', () => {
  it('DAILY with hourlyRate is complete', () => {
    expect(completeOn(employee(EmploymentType.DAILY, [profile(PayType.HOURLY, '75')]), '2026-10-06')).toBe(true);
  });

  it('DAILY without hourlyRate is incomplete', () => {
    expect(completeOn(employee(EmploymentType.DAILY, []), '2026-10-06')).toBe(false);
  });

  it('MONTHLY with monthlySalary is complete', () => {
    expect(completeOn(employee(EmploymentType.MONTHLY, [profile(PayType.MONTHLY, '24000')]), '2026-10-06')).toBe(true);
  });

  it('MONTHLY without monthlySalary is incomplete', () => {
    expect(completeOn(employee(EmploymentType.MONTHLY, []), '2026-10-06')).toBe(false);
  });

  it('DAILY -> MONTHLY recomputes from the new effective monthly profile', () => {
    const profiles = [
      profile(PayType.HOURLY, '75', '2026-01-01', '2026-08-31'),
      profile(PayType.MONTHLY, '24000', '2026-09-01'),
    ];
    expect(completeOn(employee(EmploymentType.DAILY, profiles), '2026-08-31')).toBe(true);
    expect(completeOn(employee(EmploymentType.MONTHLY, profiles), '2026-09-01')).toBe(true);
  });

  it('MONTHLY -> DAILY recomputes from the new effective hourly profile', () => {
    const profiles = [
      profile(PayType.MONTHLY, '24000', '2026-01-01', '2026-08-31'),
      profile(PayType.HOURLY, '75', '2026-09-01'),
    ];
    expect(completeOn(employee(EmploymentType.MONTHLY, profiles), '2026-08-31')).toBe(true);
    expect(completeOn(employee(EmploymentType.DAILY, profiles), '2026-09-01')).toBe(true);
  });

  it('an old mismatched profile does not satisfy the current employment type', () => {
    const oldHourly = profile(PayType.HOURLY, '75', '2026-01-01');
    expect(completeOn(employee(EmploymentType.MONTHLY, [oldHourly]), '2026-10-06')).toBe(false);
    expect(resolveEffectivePayProfile([oldHourly], EmploymentType.MONTHLY, date('2026-10-06'))).toBeNull();
  });

  it('does not let legacy baseSalary satisfy a missing canonical profile', () => {
    expect(completeOn(employee(EmploymentType.MONTHLY, [], '99999'), '2026-10-06')).toBe(false);
  });

  it('honours effectiveFrom and effectiveTo boundaries', () => {
    const october = profile(PayType.MONTHLY, '24000', '2026-10-01', '2026-10-31');
    expect(completeOn(employee(EmploymentType.MONTHLY, [october]), '2026-09-30')).toBe(false);
    expect(completeOn(employee(EmploymentType.MONTHLY, [october]), '2026-10-01')).toBe(true);
    expect(completeOn(employee(EmploymentType.MONTHLY, [october]), '2026-10-31')).toBe(true);
    expect(completeOn(employee(EmploymentType.MONTHLY, [october]), '2026-11-01')).toBe(false);
  });
});

describe('frontend refreshes all employee completeness surfaces', () => {
  const form = readFileSync(new URL('../../frontend/src/features/employees/EmployeeFormDialog.tsx', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('../../frontend/src/pages/PayrollSettingsPage.tsx', import.meta.url), 'utf8');

  it.each([['Employee Edit', form], ['Payroll Settings', settings]])('%s invalidates badge and detail queries', (_name, source) => {
    expect(source).toContain("queryKey: ['employees']");
    expect(source).toContain("queryKey: ['employee']");
    expect(source).toContain("queryKey: ['employee-summary']");
    expect(source).toContain("queryKey: ['employee-completeness-summary']");
  });
});

