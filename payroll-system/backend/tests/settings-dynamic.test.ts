import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AttendanceStatus, EmploymentType } from '@prisma/client';
import { computeAttendanceMetrics } from '../src/services/attendance.service.js';
import { dailyRate, hourlyRate } from '../src/services/payroll-calculator.service.js';
import { PayrollSettings } from '../src/services/settings.service.js';
import { isScheduledWorkday } from '../src/services/schedule-policy.service.js';
import { DEFAULT_PAYROLL_SETTINGS, DEFAULT_SETTINGS_MAP } from '../src/config/payroll-defaults.js';

/**
 * Guards that business rules stay configurable.
 *
 * Two defects motivated this file:
 *   - a non-working day with no punches evaluated to ABSENT, because the branch
 *     was gated on the withdrawn COUNT_WEEKEND_AS_WORKDAY flag instead of
 *     trusting WORKING_DAYS;
 *   - several settings existed in the Settings page while nothing read them,
 *     so a toggle promised behaviour the system did not have.
 */

const BACKEND = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(BACKEND, p), 'utf8');

const settings = (overrides: Record<string, string> = {}) =>
  new PayrollSettings({ ...DEFAULT_SETTINGS_MAP, ...overrides });

const SUNDAY = new Date('2026-08-30T00:00:00.000Z');
const TUESDAY = new Date('2026-08-25T00:00:00.000Z');
const at = (t: string) => new Date(`2026-08-25T${t}:00.000Z`);

const emptyDay = (date: Date, scheduled: boolean, over: Record<string, string> = {}) =>
  computeAttendanceMetrics(
    {
      workDate: date, checkIn: null, checkOut: null,
      isHoliday: false, isWeekend: !scheduled, isOnLeave: false,
      employmentType: EmploymentType.MONTHLY,
    },
    settings(over)
  );

// ---------------------------------------------------------------------------
// A non-working day is never an absence
// ---------------------------------------------------------------------------

describe('a day outside WORKING_DAYS is never an absence', () => {
  it('treats an empty Sunday as off, not absent', () => {
    const day = emptyDay(SUNDAY, false);
    expect(day.status).toBe(AttendanceStatus.NORMAL);
    expect(day.isAbsent).toBe(false);
  });

  it('still treats an empty scheduled weekday as an absence', () => {
    const day = emptyDay(TUESDAY, true);
    expect(day.status).toBe(AttendanceStatus.ABSENT);
    expect(day.isAbsent).toBe(true);
  });

  it('ignores the withdrawn COUNT_WEEKEND_AS_WORKDAY flag in both positions', () => {
    // The flag used to invert this branch. Neither setting may bring that back.
    for (const value of ['true', 'false']) {
      const day = emptyDay(SUNDAY, false, { COUNT_WEEKEND_AS_WORKDAY: value });
      expect(day.status, `COUNT_WEEKEND_AS_WORKDAY=${value}`).toBe(AttendanceStatus.NORMAL);
      expect(day.isAbsent, `COUNT_WEEKEND_AS_WORKDAY=${value}`).toBe(false);
    }
  });

  it('no longer reads the flag anywhere in the engine', () => {
    const service = read('src/services/attendance.service.ts');
    expect(service).not.toContain("settings.boolean('COUNT_WEEKEND_AS_WORKDAY')");
  });

  it('derives the working week from WORKING_DAYS alone', () => {
    expect(isScheduledWorkday(SUNDAY, settings())).toBe(false);
    expect(isScheduledWorkday(TUESDAY, settings())).toBe(true);
    // Saturday drops out the moment the setting says so.
    const satOff = settings({ WORKING_DAYS: 'MON,TUE,WED,THU,FRI' });
    expect(isScheduledWorkday(new Date('2026-08-29T00:00:00.000Z'), satOff)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rules follow settings, not literals
// ---------------------------------------------------------------------------

describe('policy values come from settings rather than the source', () => {
  const monthly = (over: Record<string, string>, inTime: string) =>
    computeAttendanceMetrics(
      {
        workDate: TUESDAY, checkIn: at(inTime), checkOut: at('17:30'),
        isHoliday: false, isWeekend: false, isOnLeave: false,
        employmentType: EmploymentType.MONTHLY,
      },
      settings(over)
    );

  it('moves the lateness boundary with MONTHLY_WORK_START_TIME', () => {
    expect(monthly({}, '08:45').lateMinutes).toBe(15);
    expect(monthly({ MONTHLY_WORK_START_TIME: '09:00' }, '08:45').lateMinutes).toBe(0);
  });

  it('re-opens a grace window through MONTHLY_FLEX_ARRIVAL_MINUTES', () => {
    expect(monthly({ MONTHLY_FLEX_ARRIVAL_MINUTES: '20' }, '08:45').lateMinutes).toBe(0);
  });

  it('moves the required checkout with MONTHLY_WORK_END_TIME', () => {
    expect(monthly({}, '08:30').earlyLeaveMinutes).toBe(0);
    expect(monthly({ MONTHLY_WORK_END_TIME: '18:00' }, '08:30').earlyLeaveMinutes).toBe(30);
  });

  const employee = {
    employeeId: 'x', employeeCode: 'X', employeeName: 'x',
    departmentName: null, positionName: null,
    employmentType: EmploymentType.MONTHLY, baseSalary: 18000,
    ssoEnabled: false, taxEnabled: false, otEligible: true, attendanceRequired: true,
  };

  it('takes the day rate from MONTHLY_SALARY_DAY_DIVISOR', () => {
    expect(dailyRate(employee, settings()).toString()).toBe('600');
    expect(dailyRate(employee, settings({ MONTHLY_SALARY_DAY_DIVISOR: '25' })).toString()).toBe('720');
  });

  it('takes the hour rate from STANDARD_PAID_HOURS_PER_DAY', () => {
    expect(hourlyRate(employee, settings()).toString()).toBe('75');
    expect(hourlyRate(employee, settings({ STANDARD_PAID_HOURS_PER_DAY: '10' })).toString()).toBe('60');
  });

  it('records the full DAILY duration regardless of the withdrawn break flag', () => {
    // The DAILY break moved to payroll, where it is applied once. Attendance
    // keeps the observed duration so the two figures stay distinguishable.
    const daily = (over: Record<string, string>) =>
      computeAttendanceMetrics(
        {
          workDate: TUESDAY, checkIn: at('08:00'), checkOut: at('17:00'),
          isHoliday: false, isWeekend: false, isOnLeave: false,
          employmentType: EmploymentType.DAILY,
        },
        settings(over)
      ).workedMinutes;
    expect(daily({})).toBe(540);
    expect(daily({ DAILY_DEDUCT_BREAK: 'true' })).toBe(540);
  });

  it('switches OT per employment type from settings', () => {
    const ot = (type: EmploymentType, over: Record<string, string>) =>
      computeAttendanceMetrics(
        {
          workDate: TUESDAY, checkIn: at('08:30'), checkOut: at('20:00'),
          isHoliday: false, isWeekend: false, isOnLeave: false, employmentType: type,
        },
        settings(over)
      ).otMinutes;
    expect(ot(EmploymentType.MONTHLY, {})).toBe(0);
    expect(ot(EmploymentType.MONTHLY, { MONTHLY_OT_ENABLED: 'true' })).toBeGreaterThan(0);
    expect(ot(EmploymentType.DAILY, {})).toBe(0);
    expect(ot(EmploymentType.DAILY, { DAILY_OT_ENABLED: 'true' })).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// No hardcoded policy in the engine
// ---------------------------------------------------------------------------

describe('the engine holds no hardcoded schedule or divisor', () => {
  const engineFiles = [
    'src/services/attendance.service.ts',
    'src/services/payroll-calculator.service.ts',
    'src/services/schedule-policy.service.ts',
  ];

  it('contains no literal clock times', () => {
    for (const file of engineFiles) {
      expect(read(file), file).not.toMatch(/['"](?:0[6-9]|1[0-9]):[0-5][0-9]['"]/);
    }
  });

  it('contains no literal salary divisor', () => {
    const calc = read('src/services/payroll-calculator.service.ts');
    expect(calc).not.toMatch(/dividedBy\(\s*(?:22|30)\s*\)/);
    expect(calc).toContain("settings.decimal('MONTHLY_SALARY_DAY_DIVISOR')");
    expect(calc).toContain("settings.decimal('STANDARD_PAID_HOURS_PER_DAY')");
  });

  it('resolves the working week from a setting, with a fallback only', () => {
    const policy = read('src/services/schedule-policy.service.ts');
    expect(policy).toContain("settings.string('WORKING_DAYS')");
    // The literal is a fallback for a missing row, not the operating value.
    expect(policy).toMatch(/settings\.string\('WORKING_DAYS'\)\s*\|\|/);
  });
});

// ---------------------------------------------------------------------------
// The Settings page must not advertise behaviour that does not exist
// ---------------------------------------------------------------------------

describe('settings with no consumer are labelled as not implemented', () => {
  const backendSrc = (() => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(BACKEND, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (entry.name.endsWith('.ts')) files.push(rel);
      }
    };
    walk('src');
    return files
      .filter((f) => !f.endsWith('config/payroll-defaults.ts'))
      .map((f) => read(f))
      .join('\n');
  })();

  const inert = DEFAULT_PAYROLL_SETTINGS.filter((d) => !backendSrc.includes(d.key));

  it('every inert setting says so in its label', () => {
    const unlabelled = inert
      .filter((d) => !/ยังไม่เปิดใช้งาน|ยกเลิกแล้ว|ยังไม่กำหนด/.test(`${d.label} ${d.description ?? ''}`))
      .map((d) => d.key);
    expect(unlabelled).toEqual([]);
  });

  it('every setting the engine reads is defined with a default', () => {
    for (const key of [
      'MONTHLY_WORK_START_TIME', 'MONTHLY_WORK_END_TIME', 'MONTHLY_FLEX_ARRIVAL_MINUTES',
      'WORKING_DAYS', 'MONTHLY_SALARY_DAY_DIVISOR', 'STANDARD_PAID_HOURS_PER_DAY',
      'LATE_DEDUCTION_ROUND_UP_HOURS', 'DAILY_DEDUCT_BREAK', 'DAILY_OT_ENABLED',
      'MONTHLY_OT_ENABLED',
    ]) {
      expect(DEFAULT_SETTINGS_MAP[key], key).toBeDefined();
    }
  });

  it('refreshes label metadata without ever touching a stored value', () => {
    const service = read('src/services/settings.service.ts');
    const fn = service.slice(
      service.indexOf('export async function syncSettingMetadata'),
      service.indexOf('export async function ensureDefaultSettings')
    );
    expect(fn).toContain('label:');
    expect(fn).not.toMatch(/\bvalue:/);
  });
});
