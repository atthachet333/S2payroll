import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EmploymentType } from '@prisma/client';
import { DEFAULT_SETTINGS_MAP } from '../src/config/payroll-defaults.js';
import { PayrollSettings } from '../src/services/settings.service.js';
import { computeAttendanceMetrics } from '../src/services/attendance.service.js';
import { assertNoDuplicateDateOverride, rangesOverlap, resolveScheduleFromRanges } from '../src/services/employee-work-schedule.service.js';
import { employeeWorkScheduleUpdateSchema } from '../src/schemas/index.js';
import { calculateDailyPayableTime } from '../src/utils/time-rounding.js';

const readBackend = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

const base = new PayrollSettings({ ...DEFAULT_SETTINGS_MAP });
const date = (value: string) => new Date(`${value}T00:00:00.000Z`);
const at = (value: string) => new Date(`2026-10-08T${value}:00.000Z`);
const personal = [{
  employeeId: 'S2A008', workStartTime: '07:45', workEndTime: '16:45',
  effectiveFrom: date('2026-10-01'), effectiveTo: null, isActive: true,
}];
const resolve = (employeeId: string, workDate = date('2026-10-08')) =>
  resolveScheduleFromRanges({ employeeId, date: workDate, base, companySchedules: [], employeeSchedules: personal });
const metrics = (checkIn: string, checkOut: string) => computeAttendanceMetrics({
  workDate: date('2026-10-08'), checkIn: at(checkIn), checkOut: at(checkOut),
  isHoliday: false, isWeekend: false, isOnLeave: false,
  employmentType: EmploymentType.MONTHLY,
}, resolve('S2A008').settings);

describe('effective employee work schedules', () => {
  it('uses the company default when no personal range exists', () => {
    expect(resolve('OTHER')).toMatchObject({ workStartTime: '08:30', workEndTime: '17:30', source: 'COMPANY_DEFAULT' });
  });

  it('resolves S2A008 to the personal 07:45-16:45 range', () => {
    expect(resolve('S2A008')).toMatchObject({ workStartTime: '07:45', workEndTime: '16:45', source: 'EMPLOYEE' });
  });

  it('does not apply a personal range before its effective date', () => {
    expect(resolve('S2A008', date('2026-09-30')).source).toBe('COMPANY_DEFAULT');
  });

  it('07:45 is not late', () => expect(metrics('07:45', '16:45').lateMinutes).toBe(0));
  it('07:46 is one minute late', () => expect(metrics('07:46', '16:45').lateMinutes).toBe(1));
  it('08:45 is 60 minutes late', () => expect(metrics('08:45', '16:45').lateMinutes).toBe(60));
  it('16:45 is not early', () => expect(metrics('07:45', '16:45').earlyLeaveMinutes).toBe(0));
  it('16:30 is 15 minutes early', () => expect(metrics('07:45', '16:30').earlyLeaveMinutes).toBe(15));

  it('detects inclusive overlapping ranges', () => {
    expect(rangesOverlap(date('2026-10-01'), null, date('2026-10-20'), null)).toBe(true);
    expect(rangesOverlap(date('2026-10-01'), date('2026-10-19'), date('2026-10-20'), null)).toBe(false);
  });

  it('does not mutate source ranges or punches while resolving and computing', () => {
    const before = JSON.stringify(personal);
    const checkIn = at('07:45');
    const checkOut = at('16:45');
    computeAttendanceMetrics({ workDate: date('2026-10-08'), checkIn, checkOut,
      isHoliday: false, isWeekend: false, isOnLeave: false, employmentType: EmploymentType.MONTHLY }, resolve('S2A008').settings);
    expect(JSON.stringify(personal)).toBe(before);
    expect(checkIn.toISOString()).toBe('2026-10-08T07:45:00.000Z');
  });

  it('preserves DAILY inter-session break credit', () => {
    const result = calculateDailyPayableTime({
      sessions: [
        { checkIn: at('07:45'), checkOut: at('12:00'), workedMinutes: 255 },
        { checkIn: at('13:00'), checkOut: at('16:45'), workedMinutes: 225 },
      ],
      roundingIntervalMinutes: 15, thresholdMinutes: 240, requiredBreakMinutes: 60,
    });
    expect(result).toMatchObject({ actualWorkedMinutes: 480, creditedBreakMinutes: 60, additionalBreakDeductionMinutes: 0, payableMinutes: 480 });
  });

  it('gives a date override priority over the employee effective schedule', () => {
    const resolved = resolveScheduleFromRanges({ employeeId: 'S2A008', date: date('2026-10-07'), base,
      companySchedules: [], employeeSchedules: personal,
      dateOverrides: [{ employeeId: 'S2A008', workDate: date('2026-10-07'), workStartTime: '08:30', workEndTime: '17:30' }],
    });
    expect(resolved).toMatchObject({ workStartTime: '08:30', workEndTime: '17:30', source: 'DATE_OVERRIDE' });
    const result = computeAttendanceMetrics({ workDate: date('2026-10-07'), checkIn: new Date('2026-10-07T08:26:00.000Z'),
      checkOut: new Date('2026-10-07T17:33:00.000Z'), isHoliday: false, isWeekend: false, isOnLeave: false,
      employmentType: EmploymentType.MONTHLY }, resolved.settings);
    expect(result).toMatchObject({ lateMinutes: 0, earlyLeaveMinutes: 0 });
  });

  it('returns to the employee schedule on the next day', () => {
    const resolved = resolveScheduleFromRanges({ employeeId: 'S2A008', date: date('2026-10-08'), base,
      companySchedules: [], employeeSchedules: personal,
      dateOverrides: [{ employeeId: 'S2A008', workDate: date('2026-10-07'), workStartTime: '08:30', workEndTime: '17:30' }],
    });
    expect(resolved).toMatchObject({ workStartTime: '07:45', workEndTime: '16:45', source: 'EMPLOYEE' });
  });

  it('blocks a duplicate override for the same employee and date', () => {
    expect(() => assertNoDuplicateDateOverride({ employeeId: 'S2A008', workDate: date('2026-10-07'),
      workStartTime: '08:30', workEndTime: '17:30' })).toThrow(/เฉพาะวัน/);
  });

  // -------------------------------------------------------------------------
  // S2A008 scenario from the production fix: 2026-10-01 EMPLOYEE schedule
  // corrected to 07:45-16:45 while 2026-10-07 keeps its DATE_OVERRIDE.
  // -------------------------------------------------------------------------

  it('S2A008 2026-10-08 resolves to the corrected 07:45-16:45 employee schedule', () => {
    expect(resolve('S2A008', date('2026-10-08'))).toMatchObject({ workStartTime: '07:45', workEndTime: '16:45', source: 'EMPLOYEE' });
  });

  it('S2A008 2026-10-07 still resolves the DATE_OVERRIDE regardless of the employee schedule', () => {
    const resolved = resolveScheduleFromRanges({ employeeId: 'S2A008', date: date('2026-10-07'), base,
      companySchedules: [], employeeSchedules: personal,
      dateOverrides: [{ employeeId: 'S2A008', workDate: date('2026-10-07'), workStartTime: '08:30', workEndTime: '17:30' }],
    });
    expect(resolved).toMatchObject({ workStartTime: '08:30', workEndTime: '17:30', source: 'DATE_OVERRIDE' });
  });

  it('other employees are unaffected by S2A008 personal schedule', () => {
    expect(resolve('S2A999', date('2026-10-08'))).toMatchObject({ workStartTime: '08:30', workEndTime: '17:30', source: 'COMPANY_DEFAULT' });
  });
});

// ---------------------------------------------------------------------------
// Edit vs create: the duplicate/overlap check must exclude the row being
// edited. The actual create/update writes are not exercised here (they hit
// the live database), so this verifies the fix at the source level - the
// same guard other DB-touching rules in this project use.
// ---------------------------------------------------------------------------

describe('edit vs create schedule validation', () => {
  const service = readBackend('src/services/employee-work-schedule.service.ts');

  it('shares one window-reservation helper between create and update, parameterised by an optional excludeId', () => {
    expect(service).toMatch(/function reserveScheduleWindow\([\s\S]{0,400}excludeId\?:\s*string/);
    expect(service).toContain('...(excludeId ? { id: { not: excludeId } } : {})');
  });

  it('create calls the shared guard without excluding any row (same effectiveFrom is always a duplicate)', () => {
    const createFn = service.slice(service.indexOf('export async function createEmployeeWorkSchedule'));
    expect(createFn.slice(0, createFn.indexOf('export async function updateEmployeeWorkSchedule')))
      .toMatch(/reserveScheduleWindow\(tx, employeeId, effectiveFrom, effectiveTo, actor\.userId\);/);
  });

  it('update calls the shared guard excluding the schedule id being edited', () => {
    const updateFn = service.slice(service.indexOf('export async function updateEmployeeWorkSchedule'));
    expect(updateFn).toMatch(/reserveScheduleWindow\(tx, employeeId, effectiveFrom, effectiveTo, actor\.userId, scheduleId\);/);
  });

  it('update looks the row up scoped to the employee and 404s when missing', () => {
    const updateFn = service.slice(service.indexOf('export async function updateEmployeeWorkSchedule'));
    expect(updateFn).toContain('findFirst({ where: { id: scheduleId, employeeId } })');
    expect(updateFn).toMatch(/if \(!existing\) throw notFound/);
  });

  it('update records an audit entry carrying the old value, new value and reason', () => {
    const updateFn = service.slice(service.indexOf('export async function updateEmployeeWorkSchedule'));
    expect(updateFn).toContain("action: 'EMPLOYEE_WORK_SCHEDULE_UPDATE'");
    expect(updateFn).toContain('oldValue: existing, newValue: result');
  });
});

describe('employeeWorkScheduleUpdateSchema', () => {
  it('accepts an update with a reason and trims it', () => {
    const parsed = employeeWorkScheduleUpdateSchema.safeParse({
      workStartTime: '07:45', workEndTime: '16:45', effectiveFrom: '2026-10-01', reason: '  ปรับเวลาทำงานจริงของพนักงาน  ',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.reason).toBe('ปรับเวลาทำงานจริงของพนักงาน');
  });

  it('allows omitting the reason', () => {
    expect(employeeWorkScheduleUpdateSchema.safeParse({
      workStartTime: '07:45', workEndTime: '16:45', effectiveFrom: '2026-10-01',
    }).success).toBe(true);
  });

  it('rejects a reason too short to mean anything', () => {
    expect(employeeWorkScheduleUpdateSchema.safeParse({
      workStartTime: '07:45', workEndTime: '16:45', effectiveFrom: '2026-10-01', reason: 'x',
    }).success).toBe(false);
  });
});

describe('the PATCH route recalculates only this employee and protects finalised payroll', () => {
  const routes = readBackend('src/routes/employee.routes.ts');
  const routeBody = routes.slice(routes.indexOf("'/:id/work-schedules/:scheduleId'"));

  it('wires PATCH /:id/work-schedules/:scheduleId behind employee:write', () => {
    expect(routes).toMatch(/app\.patch\(\s*'\/:id\/work-schedules\/:scheduleId'/);
    expect(routeBody.slice(0, 200)).toContain("requirePermission('employee:write')");
  });

  it('recalculates only the updated employee, never the whole company', () => {
    expect(routeBody).toMatch(/recalculateRange\(\s*schedule\.effectiveFrom, schedule\.effectiveTo \?\? new Date\(\), id\s*\)/);
  });

  it('recalculateRange itself skips attendance inside APPROVED/PAID/LOCKED periods', () => {
    const attendanceService = readBackend('src/services/attendance.service.ts');
    const fn = attendanceService.slice(attendanceService.indexOf('export async function recalculateRange'));
    expect(fn).toContain("status: { in: ['APPROVED', 'PAID', 'LOCKED'] }");
    expect(fn).toMatch(/isLocked:\s*false/);
  });
});
