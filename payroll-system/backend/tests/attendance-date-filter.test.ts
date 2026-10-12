import { describe, expect, it } from 'vitest';
import { AttendanceStatus } from '@prisma/client';
import { buildAttendanceWhere } from '../src/services/attendance.service.js';

const utc = (value: string) => new Date(`${value}T00:00:00.000Z`);
const params = { page: 1, pageSize: 25 };

describe('attendance date filters', () => {
  it('builds an inclusive single-date predicate', () => {
    expect(buildAttendanceWhere({ ...params, from: utc('2026-10-07'), to: utc('2026-10-07') })).toMatchObject({
      workDate: { gte: utc('2026-10-07'), lte: utc('2026-10-07') },
    });
  });

  it('builds an inclusive date-range predicate', () => {
    expect(buildAttendanceWhere({ ...params, from: utc('2026-10-01'), to: utc('2026-10-07') })).toMatchObject({
      workDate: { gte: utc('2026-10-01'), lte: utc('2026-10-07') },
    });
  });

  it('combines date, employee and status filters for pagination and count', () => {
    expect(buildAttendanceWhere({ ...params, employeeId: 'employee-1', status: AttendanceStatus.LATE,
      from: utc('2026-10-01'), to: utc('2026-10-07') })).toMatchObject({
      employeeId: 'employee-1', status: AttendanceStatus.LATE,
      workDate: { gte: utc('2026-10-01'), lte: utc('2026-10-07') },
    });
  });
});
