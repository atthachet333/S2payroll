import { describe, expect, it } from 'vitest';
import { extractEventRows, isEventSheet, resolveEventColumns } from '../src/services/sheet-mapping.service.js';
import { resolveEventAttendance, type AttendanceSourceEvent } from '../src/services/event-attendance.service.js';

const headers = ['timestamp', 'date', 'empId', 'displayName', 'type', 'time', 'workHours', 'lat', 'lng', 'summary', 'employmentType', 'userId', 'clientRequestId'];
const event = (overrides: Partial<AttendanceSourceEvent> = {}): AttendanceSourceEvent => ({
  sheetRow: 2,
  timestamp: '2026-08-10T08:00:00+07:00',
  date: '2026-08-10',
  employeeCode: 'S2A001',
  displayName: 'Employee',
  type: 'checkin',
  time: '08:00:00',
  workHours: '',
  lat: '', lng: '', summary: '', employmentType: '', userId: '',
  clientRequestId: 'request-1',
  ...overrides,
});

describe('event attendance sheet', () => {
  it('maps all real event headers without relying on column positions', () => {
    const shuffled = [...headers].reverse();
    const map = resolveEventColumns(shuffled);
    expect(isEventSheet(shuffled)).toBe(true);
    expect(map.missing).toEqual([]);
    expect(map.indexes.employeeCode).toBe(shuffled.indexOf('empId'));
    expect(map.indexes.clientRequestId).toBe(shuffled.indexOf('clientRequestId'));
  });

  it('extracts all 13 source values and preserves the source row number', () => {
    const rows = extractEventRows([headers, ['ts', '2026-08-10', 'S2A001', 'Name', 'checkin', '08:00', '8', '1', '2', 'ok', 'fulltime', 'u1', 'r1']], resolveEventColumns(headers));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sheetRow: 2, employeeCode: 'S2A001', clientRequestId: 'r1' });
  });

  it('orders by timestamp and resolves exactly one check-in and checkout', () => {
    const result = resolveEventAttendance([
      event({ sheetRow: 3, timestamp: '2026-08-10T17:00:00+07:00', type: 'checkout', time: '17:00', clientRequestId: 'r2' }),
      event(),
    ])[0];
    expect(result.status).toBe('VALID');
    expect(result.sheetRows).toEqual([2, 3]);
    expect(result.checkIn).toBe('08:00:00');
    expect(result.checkOut).toBe('17:00');
  });

  it('classifies missing and multiple punches deterministically', () => {
    expect(resolveEventAttendance([event()])[0].status).toBe('MISSING_CHECKOUT');
    expect(resolveEventAttendance([event({ type: 'checkout' })])[0].status).toBe('MISSING_CHECKIN');
    expect(resolveEventAttendance([event(), event({ sheetRow: 3, time: '08:05', clientRequestId: 'r2' })])[0].status).toBe('MULTIPLE_EVENTS');
  });

  it('deduplicates client request IDs and treats workHours only as a warning', () => {
    const result = resolveEventAttendance([
      event(),
      event({ sheetRow: 3, time: '08:01' }),
      event({ sheetRow: 4, timestamp: '2026-08-10T17:00:00+07:00', type: 'checkout', time: '17:00', workHours: '7', clientRequestId: 'r2' }),
    ])[0];
    expect(result.duplicateSourceEvents).toHaveLength(1);
    expect(result.status).toBe('VALID');
    expect(result.workHoursWarning).toContain('120 นาที');
  });
});
