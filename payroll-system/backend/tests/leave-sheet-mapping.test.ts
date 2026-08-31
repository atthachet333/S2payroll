import { describe, expect, it } from 'vitest';
import {
  extractLeaveRows,
  findDuplicateRequestIds,
  parseLeaveStatus,
  resolveLeaveColumns,
} from '../src/services/leave-sheet-mapping.service.js';

const REAL_HEADERS = [
  'requestId', 'clientRequestId', 'employeeLineUserId', 'employeeId', 'employeeName',
  'position', 'department', 'leaveType', 'startDate', 'endDate', 'totalDays', 'reason',
  'managerLineUserId', 'status', 'approvedBy', 'approvedAt', 'rejectedBy', 'rejectedAt',
  'rejectedReason', 'createdAt', 'updatedAt',
];

describe('LeaveRequests mapping', () => {
  it('maps the real header shape by name and uses employeeId as employee code', () => {
    const map = resolveLeaveColumns(REAL_HEADERS);
    expect(map.missing).toEqual([]);
    expect(map.indexes.employeeCode).toBe(3);
    expect(map.indexes.status).toBe(13);
  });

  it('normalises the actual approval states without guessing unknown values', () => {
    expect(parseLeaveStatus('APPROVED')).toBe('APPROVED');
    expect(parseLeaveStatus('PENDING')).toBe('PENDING');
    expect(parseLeaveStatus('REJECTED')).toBe('REJECTED');
    expect(parseLeaveStatus('CANCELLED')).toBe('CANCELLED');
    expect(parseLeaveStatus('UNKNOWN')).toBeNull();
  });

  it('extracts an approved request with stable employee and request identifiers', () => {
    const map = resolveLeaveColumns(REAL_HEADERS);
    const row = Array(REAL_HEADERS.length).fill('');
    row[0] = 'REQ-1'; row[3] = 'S2A004'; row[7] = 'ลาป่วย';
    row[8] = '2026-08-14'; row[9] = '2026-08-14'; row[10] = '1';
    row[11] = 'ป่วย'; row[13] = 'APPROVED';
    expect(extractLeaveRows([REAL_HEADERS, row], map)[0]).toMatchObject({
      requestId: 'REQ-1', employeeCode: 'S2A004', leaveType: 'SICK', status: 'APPROVED', errors: [],
    });
  });

  it('reports malformed and duplicate requests', () => {
    const map = resolveLeaveColumns(REAL_HEADERS);
    const make = () => {
      const row = Array(REAL_HEADERS.length).fill('');
      row[0] = 'REQ-1'; row[3] = 'S2A004'; row[8] = 'bad-date'; row[13] = 'PENDING';
      return row;
    };
    const rows = extractLeaveRows([REAL_HEADERS, make(), make()], map);
    expect(rows[0].errors).toContain('วันที่เริ่มลาไม่ถูกต้อง: bad-date');
    expect(findDuplicateRequestIds(rows)).toEqual(['REQ-1']);
  });
});
