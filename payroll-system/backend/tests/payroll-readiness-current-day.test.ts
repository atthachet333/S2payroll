import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyOpenPunch } from '../src/services/pre-payroll-check.service.js';
import { isEmployeeEligibleForPayrollPeriod } from '../src/services/employee-payroll-eligibility.service.js';
import { EmployeeStatus } from '@prisma/client';

const date = new Date('2026-08-31T00:00:00.000Z');
const checkIn = new Date('2026-08-31T08:24:00.000Z');
const root = resolve(import.meta.dirname, '..', '..');
const source = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('current-day payroll readiness', () => {
  it('classifies a checked-in employee before 17:30 Bangkok as IN_PROGRESS', () => {
    expect(classifyOpenPunch({ workDate: date, checkIn, checkOut: null, now: new Date('2026-08-31T09:00:00.000Z'), closeMinutes: 17 * 60 + 30 })).toBe('IN_PROGRESS');
  });

  it('classifies the same punch after 17:30 Bangkok as MISSING_DATA', () => {
    expect(classifyOpenPunch({ workDate: date, checkIn, checkOut: null, now: new Date('2026-08-31T10:31:00.000Z'), closeMinutes: 17 * 60 + 30 })).toBe('MISSING_DATA');
  });

  it('keeps a past missing checkout blocking', () => {
    expect(classifyOpenPunch({ workDate: new Date('2026-08-30T00:00:00.000Z'), checkIn, checkOut: null, now: new Date('2026-08-31T09:00:00.000Z'), closeMinutes: 17 * 60 + 30 })).toBe('MISSING_DATA');
  });

  it('uses employee period overlap and executive exemption in eligibility', () => {
    const text = source('backend/src/services/pre-payroll-check.service.ts');
    expect(text).toContain('payrollEligibleEmployeeWhere(period)');
    expect(text).toContain('e.attendanceRequired');
    expect(text).toContain('attendanceRequired === false && e.leaveTrackingRequired === false');
  });

  it('excludes inactive/deleted-like employees and employees outside the period', () => {
    const period = { startDate: new Date('2026-08-01'), endDate: new Date('2026-08-31') };
    expect(isEmployeeEligibleForPayrollPeriod({ status: EmployeeStatus.INACTIVE, startDate: new Date('2026-08-01'), endDate: null }, period)).toBe(false);
    expect(isEmployeeEligibleForPayrollPeriod({ status: EmployeeStatus.ACTIVE, startDate: new Date('2026-09-01'), endDate: null }, period)).toBe(false);
    expect(isEmployeeEligibleForPayrollPeriod({ status: EmployeeStatus.ACTIVE, startDate: new Date('2026-01-01'), endDate: new Date('2026-07-31') }, period)).toBe(false);
    expect(isEmployeeEligibleForPayrollPeriod({ status: EmployeeStatus.ACTIVE, startDate: new Date('2026-08-01'), endDate: null }, period)).toBe(true);
  });

  it('collapses compensation blockers into monthly or hourly categories', () => {
    const text = source('backend/src/services/pre-payroll-check.service.ts');
    expect(text).toContain("code: 'MISSING_MONTHLY_SALARY'");
    expect(text).toContain("code: 'MISSING_HOURLY_RATE'");
    expect(text).toContain("code: 'DAILY_RATE_UNCONFIGURED'");
    expect(text).not.toContain("code: 'MISSING_SALARY'");
    expect(text).not.toContain("code: 'MISSING_DAILY_RATE'");
  });

  it('checks effective-date coverage and never backfills a later profile', () => {
    const text = source('backend/src/services/pre-payroll-check.service.ts');
    expect(text).toContain("code: 'MISSING_PAY_PROFILE_FOR_DATE_RANGE'");
    expect(text).toContain('profile.effectiveFrom <= date');
    expect(text).toContain('profile.effectiveTo >= date');
  });

  it('keeps monthly and hourly calculation rules decimal-safe', () => {
    const text = source('backend/src/services/payroll-calculator.service.ts');
    expect(text).toContain('monthlySalary');
    expect(text).toContain('hourlyRate');
    expect(text).toContain('workedMinutes');
    expect(text).toContain('Decimal');
  });

  it('calculates straight through only when the whole roster is ready', () => {
    // Calculation is employee-scoped now, so the readiness dialog is a briefing
    // rather than a gate. It still opens first whenever anyone is not ready, so
    // the operator sees who will be marked incomplete before committing.
    const text = source('frontend/src/pages/PayrollDetailPage.tsx');
    expect(text).toContain(
      'if (report.canCalculate && report.readiness.ready === report.readiness.employees)'
    );
    expect(text).toContain("actionMutation.mutate('calculate')");
    expect(text).toContain('setPreCheckOpen(true)');
  });

  it('prevents approval, payment and locking while the period is open', () => {
    const backend = source('backend/src/services/payroll.service.ts');
    expect(backend.match(/await assertPeriodFinalizable\(periodId\)/g)?.length).toBe(3);
    expect(backend).toContain('ยังไม่สามารถอนุมัติ จ่าย หรือล็อก');
  });

  it('provides direct remediation actions and readiness counters', () => {
    const dialog = source('frontend/src/features/payroll/PrePayrollCheckDialog.tsx');
    const detail = source('frontend/src/pages/PayrollDetailPage.tsx');
    expect(dialog).toContain('ไปกำหนดค่าจ้าง');
    expect(dialog).toContain('ไปบันทึกการลงเวลา');
    expect(dialog).toContain('แก้ไขเวลา');
    expect(detail).toContain('กำลังทำงานวันนี้');
  });
});
