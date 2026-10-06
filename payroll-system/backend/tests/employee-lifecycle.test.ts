import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { EmployeeStatus } from '@prisma/client';
import {
  isEmployeeEligibleForPayrollPeriod,
  payrollEmployeeVisibilityWhere,
  payrollEligibleEmployeeWhere,
  shouldApplyEmploymentOverlapToPayrollRows,
  visiblePayrollRowsForPeriod,
} from '../src/services/employee-payroll-eligibility.service.js';

/**
 * Who is on the payroll, and who decides.
 *
 * The bug these tests pin down: an admin deactivating an employee in the UI had
 * them silently restored to ACTIVE by the next Google Sheets auto-sync, because
 * the sync treated employment status as a sheet-owned field. The employee then
 * reappeared in payroll readiness, in the pay-settings list and in attendance
 * expectations, and no audit trail explained why.
 *
 * The sheet owns who a person is. The app owns whether they are still on the
 * payroll. Nothing about this is specific to one employee code.
 */

const period = {
  startDate: new Date('2026-08-01T00:00:00.000Z'),
  endDate: new Date('2026-08-31T00:00:00.000Z'),
};

const employee = (overrides: Partial<{ status: EmployeeStatus; startDate: Date; endDate: Date | null }> = {}) => ({
  status: EmployeeStatus.ACTIVE,
  startDate: new Date('2020-01-01T00:00:00.000Z'),
  endDate: null,
  ...overrides,
});

describe('payroll eligibility', () => {
  it('includes an active employee', () => {
    expect(isEmployeeEligibleForPayrollPeriod(employee(), period)).toBe(true);
  });

  it('includes an employee on probation', () => {
    expect(
      isEmployeeEligibleForPayrollPeriod(employee({ status: EmployeeStatus.PROBATION }), period)
    ).toBe(true);
  });

  it('does not let inactive status override open employment dates', () => {
    expect(
      isEmployeeEligibleForPayrollPeriod(employee({ status: EmployeeStatus.INACTIVE }), period)
    ).toBe(true);
  });

  it('does not let terminated status override open employment dates', () => {
    expect(
      isEmployeeEligibleForPayrollPeriod(employee({ status: EmployeeStatus.TERMINATED }), period)
    ).toBe(true);
  });

  it('excludes someone who left before the period opened', () => {
    expect(
      isEmployeeEligibleForPayrollPeriod(
        employee({ endDate: new Date('2026-07-15T00:00:00.000Z') }),
        period
      )
    ).toBe(false);
  });

  it('still includes someone who left partway through the period', () => {
    expect(
      isEmployeeEligibleForPayrollPeriod(
        employee({ endDate: new Date('2026-08-15T00:00:00.000Z') }),
        period
      )
    ).toBe(true);
  });

  it('excludes someone hired after the period closed', () => {
    expect(
      isEmployeeEligibleForPayrollPeriod(
        employee({ startDate: new Date('2026-09-01T00:00:00.000Z') }),
        period
      )
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // A former employee who worked part of the period must still be paid for it.
  // -------------------------------------------------------------------------

  it('includes an employee who resigned partway through the period', () => {
    // The S2A007 shape: INACTIVE today, but employed for most of August. Their
    // recorded days are real and must reach the payroll run.
    expect(
      isEmployeeEligibleForPayrollPeriod(
        employee({
          status: EmployeeStatus.INACTIVE,
          startDate: new Date('2026-07-06T00:00:00.000Z'),
          endDate: new Date('2026-08-25T00:00:00.000Z'),
        }),
        period
      )
    ).toBe(true);
  });

  it('includes a terminated employee whose last day was inside the period', () => {
    expect(
      isEmployeeEligibleForPayrollPeriod(
        employee({
          status: EmployeeStatus.TERMINATED,
          endDate: new Date('2026-08-31T00:00:00.000Z'),
        }),
        period
      )
    ).toBe(true);
  });

  it('excludes a former employee who left before the period opened', () => {
    expect(
      isEmployeeEligibleForPayrollPeriod(
        employee({
          status: EmployeeStatus.INACTIVE,
          endDate: new Date('2026-07-10T00:00:00.000Z'),
        }),
        period
      )
    ).toBe(false);
  });

  it('treats a missing end date as open employment regardless of status', () => {
    expect(
      isEmployeeEligibleForPayrollPeriod(
        employee({ status: EmployeeStatus.INACTIVE, endDate: null }),
        period
      )
    ).toBe(true);
  });

  it('does not let current status alone erase historical period work', () => {
    // Same person, same dates - only the status differs. Both are eligible,
    // because eligibility is decided by the employment dates.
    const dates = {
      startDate: new Date('2026-07-06T00:00:00.000Z'),
      endDate: new Date('2026-08-25T00:00:00.000Z'),
    };
    const asActive = isEmployeeEligibleForPayrollPeriod(
      employee({ ...dates, status: EmployeeStatus.ACTIVE }),
      period
    );
    const asInactive = isEmployeeEligibleForPayrollPeriod(
      employee({ ...dates, status: EmployeeStatus.INACTIVE }),
      period
    );
    expect(asActive).toBe(true);
    expect(asInactive).toBe(true);
  });

  it('does not narrow the query to active employees alone', () => {
    // Eligibility is a question about dates. Somebody who resigned mid-period
    // still worked most of it, and filtering on status today would silently
    // drop those days from the run.
    const where = payrollEligibleEmployeeWhere(period);
    // No top-level status filter: eligibility is decided by dates.
    expect((where as Record<string, unknown>).status).toBeUndefined();
    const and = (where as { AND: unknown[] }).AND;
    expect(and).toHaveLength(2);
  });
});

describe('payroll employee row visibility', () => {
  const september = {
    status: 'CALCULATED' as const,
    startDate: new Date('2026-09-01T00:00:00.000Z'),
    endDate: new Date('2026-09-30T00:00:00.000Z'),
  };
  const rows = [
    { id: 'ended-aug-31', net: 1000, employee: { status: 'INACTIVE', startDate: new Date('2026-01-01'), endDate: new Date('2026-08-31'), reactivatedAt: null } },
    { id: 'ended-sep-15', net: 2000, employee: { status: 'INACTIVE', startDate: new Date('2026-01-01'), endDate: new Date('2026-09-15'), reactivatedAt: null } },
    { id: 'future-start', net: 3000, employee: { status: 'ACTIVE', startDate: new Date('2026-10-01'), endDate: null, reactivatedAt: null } },
    { id: 'active-current', net: 4000, employee: { status: 'ACTIVE', startDate: new Date('2026-01-01'), endDate: null, reactivatedAt: null } },
    { id: 'terminated-current', net: 5000, employee: { status: 'TERMINATED', startDate: new Date('2026-01-01'), endDate: new Date('2026-09-30'), reactivatedAt: null } },
  ];

  it('shows ACTIVE while hiding INACTIVE, TERMINATED, and non-overlapping employees by default', () => {
    expect(visiblePayrollRowsForPeriod(rows, september).map((row) => row.id)).toEqual(['active-current']);
  });

  it('the toggle shows inactive and terminated rows that still overlap the period', () => {
    expect(
      visiblePayrollRowsForPeriod(rows, september, { includeInactive: true }).map((row) => row.id)
    ).toEqual(['ended-sep-15', 'active-current', 'terminated-current']);
  });

  it('uses the same visible rows for count and totals', () => {
    const visible = visiblePayrollRowsForPeriod(rows, september);
    expect(visible).toHaveLength(1);
    expect(visible.reduce((total, row) => total + row.net, 0)).toBe(4000);
  });

  it('still shows a former employee in an overlapping August period', () => {
    const august = { ...period, status: 'APPROVED' as const };
    expect(visiblePayrollRowsForPeriod(rows, august).map((row) => row.id)).toContain('ended-aug-31');
  });

  it.each(['APPROVED', 'PAID', 'LOCKED'] as const)('preserves every %s snapshot row', (status) => {
    const finalised = { ...september, status };
    expect(shouldApplyEmploymentOverlapToPayrollRows(finalised)).toBe(false);
    expect(payrollEmployeeVisibilityWhere(finalised)).toEqual({});
    expect(visiblePayrollRowsForPeriod(rows, finalised)).toBe(rows);
  });

  it('adds the employee overlap relation to editable-period queries', () => {
    const normal = JSON.stringify(payrollEmployeeVisibilityWhere(september));
    const toggled = JSON.stringify(payrollEmployeeVisibilityWhere(september, undefined, { includeInactive: true }));
    expect(normal).toContain('notIn');
    expect(normal).toContain('INACTIVE');
    expect(toggled).not.toContain('notIn');
  });
});

describe('Google Sheets never resurrects a deactivated employee', () => {
  const source = readFileSync(
    new URL('../src/services/employee-sync.service.ts', import.meta.url),
    'utf8'
  );

  it('does not write status onto an existing employee', () => {
    // The sync builds a Prisma update object field by field. If it ever assigns
    // status there again, a deactivation made in the app is undone within a
    // minute by the next scheduled sync.
    expect(source).not.toContain('data.status = sheetOwned.status');
  });

  it('still seeds a status when the sheet introduces a brand-new employee', () => {
    expect(source).toContain("status: sheetOwned.status ?? 'ACTIVE'");
  });

  it('does not advertise a status change the apply step will not make', () => {
    expect(source).not.toContain("diff('status', current.status, row.status)");
  });
});

describe('pay settings lists exclude inactive staff', () => {
  const policySource = readFileSync(
    new URL('../src/services/employee-payroll-policy.service.ts', import.meta.url),
    'utf8'
  );
  const profileSource = readFileSync(
    new URL('../src/services/pay-profile.service.ts', import.meta.url),
    'utf8'
  );

  it('filters the payroll-policy list to active and probation employees', () => {
    expect(policySource).toContain("status: { in: ['ACTIVE', 'PROBATION'] }");
  });

  it('filters the pay-configuration list to active and probation employees', () => {
    expect(profileSource).toContain("status: { in: ['ACTIVE', 'PROBATION'] }");
  });
});
