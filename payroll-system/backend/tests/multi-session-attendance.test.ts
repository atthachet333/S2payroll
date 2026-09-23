import { describe, expect, it } from 'vitest';
import { EmploymentType } from '@prisma/client';
import { DEFAULT_SETTINGS_MAP } from '../src/config/payroll-defaults.js';
import { computeAttendanceMetrics } from '../src/services/attendance.service.js';
import { overallSyncStatus } from '../src/services/auto-sync.service.js';
import {
  resolveEventAttendance,
  sourceEventHash,
  type AttendanceSourceEvent,
} from '../src/services/event-attendance.service.js';
import { PayrollSettings } from '../src/services/settings.service.js';
import { calculateRoundedWorkTime, workTimePolicy } from '../src/utils/time-rounding.js';

const DATE = '2026-09-22';
const workDate = new Date(`${DATE}T00:00:00.000Z`);
const at = (time: string) => new Date(`${DATE}T${time}:00.000Z`);
const settings = new PayrollSettings({ ...DEFAULT_SETTINGS_MAP, TIME_ROUNDING_MINUTES: '15' });
const event = (sheetRow: number, type: 'checkin' | 'checkout', time: string, id: string): AttendanceSourceEvent => ({
  sheetRow,
  timestamp: `${DATE}T${time}:00+07:00`,
  date: DATE,
  employeeCode: 'S2A003',
  displayName: 'Employee',
  type,
  time: `${time}:00`,
  workHours: '', lat: '', lng: '', summary: '', employmentType: 'DAILY', userId: 'u3',
  clientRequestId: id,
});

const resolve = (events: AttendanceSourceEvent[]) => resolveEventAttendance(events)[0];

describe('multi-session attendance', () => {
  it('A pairs one completed session', () => {
    const day = resolve([event(2, 'checkin', '09:52', 'a'), event(3, 'checkout', '15:30', 'b')]);
    expect(day.status).toBe('VALID');
    expect(day.sessions).toHaveLength(1);
    expect(day.completedWorkedMinutes).toBe(338);
  });

  it('B/E retains a completed session and reopens an existing day', () => {
    const day = resolve([
      event(2, 'checkin', '09:52', 'a'), event(3, 'checkout', '15:30', 'b'),
      event(4, 'checkin', '15:40', 'c'),
    ]);
    expect(day.status).toBe('MISSING_CHECKOUT');
    expect(day.sessions).toHaveLength(2);
    expect(day.hasOpenSession).toBe(true);
    expect(day.completedWorkedMinutes).toBe(338);

    const metrics = computeAttendanceMetrics({
      workDate, checkIn: at('09:52'), checkOut: at('15:30'),
      actualWorkedMinutes: day.completedWorkedMinutes, hasOpenSession: true,
      isHoliday: false, isWeekend: false, isOnLeave: false, employmentType: EmploymentType.DAILY,
    }, settings);
    expect(metrics.status).toBe('MISSING_DATA');
    expect(metrics.workedMinutes).toBe(338);
  });

  it('C excludes the gap between two completed sessions', () => {
    const day = resolve([
      event(2, 'checkin', '09:52', 'a'), event(3, 'checkout', '15:30', 'b'),
      event(4, 'checkin', '15:40', 'c'), event(5, 'checkout', '18:10', 'd'),
    ]);
    expect(day.status).toBe('VALID');
    expect(day.sessions).toHaveLength(2);
    expect(day.completedWorkedMinutes).toBe(488);
  });

  it('D uses clientRequestId identity so repeated pulls do not duplicate sessions', () => {
    const first = event(2, 'checkin', '09:52', 'same-request');
    const repeated = { ...first, sheetRow: 99 };
    expect(sourceEventHash(first)).toBe(sourceEventHash(repeated));
    const day = resolve([first, repeated, event(3, 'checkout', '15:30', 'out')]);
    expect(day.duplicateSourceEvents).toHaveLength(1);
    expect(day.sessions).toHaveLength(1);
  });

  it('F/G applies the DAILY break and floor once to the day total', () => {
    const rounded = calculateRoundedWorkTime(488, workTimePolicy(settings));
    expect(rounded.breakDeductionMinutes).toBe(60);
    expect(rounded.minutesBeforeRounding).toBe(428);
    expect(rounded.payableMinutes).toBe(420);
  });

  it('H supports monthly multi-session boundaries without hourly salary conversion', () => {
    const metrics = computeAttendanceMetrics({
      workDate, checkIn: at('08:30'), checkOut: at('17:30'), actualWorkedMinutes: 480,
      isHoliday: false, isWeekend: false, isOnLeave: false, employmentType: EmploymentType.MONTHLY,
    }, settings);
    expect(metrics.lateMinutes).toBe(0);
    expect(metrics.earlyLeaveMinutes).toBe(0);
  });

  it('I preserves and flags malformed IN/IN and OUT/OUT sequences', () => {
    const doubleIn = resolve([event(2, 'checkin', '08:30', 'a'), event(3, 'checkin', '09:00', 'b')]);
    const doubleOut = resolve([event(2, 'checkout', '17:00', 'a'), event(3, 'checkout', '17:30', 'b')]);
    expect(doubleIn.status).toBe('MULTIPLE_EVENTS');
    expect(doubleIn.sessions).toHaveLength(2);
    expect(doubleOut.status).toBe('MULTIPLE_EVENTS');
    expect(doubleOut.sessions).toHaveLength(2);
    const missing = computeAttendanceMetrics({
      workDate, checkIn: null, checkOut: null, actualWorkedMinutes: 0, malformedSequence: true,
      isHoliday: false, isWeekend: false, isOnLeave: false, employmentType: EmploymentType.DAILY,
    }, settings);
    expect(missing.status).toBe('MISSING_DATA');
    expect(missing.isAbsent).toBe(false);
  });

  it('J reports one failed source as PARTIAL, not FAILED', () => {
    expect(overallSyncStatus(1, 3)).toBe('PARTIAL');
    expect(overallSyncStatus(0, 3)).toBe('SUCCESS');
    expect(overallSyncStatus(3, 3)).toBe('FAILED');
  });
});
