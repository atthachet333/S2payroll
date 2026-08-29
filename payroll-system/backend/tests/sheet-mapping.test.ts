import { describe, it, expect } from 'vitest';
import {
  describeMissingColumns,
  extractRows,
  normaliseHeader,
  resolveColumns,
} from '../src/services/sheet-mapping.service.js';
import { buildSheetRange } from '../src/config/env.js';

/**
 * Header resolution is the boundary between a real customer spreadsheet and the
 * payroll engine. Getting a column wrong here would silently attribute the
 * wrong hours, so every supported header shape is asserted explicitly.
 */

describe('header normalisation', () => {
  it('ignores case, spaces, underscores, dots and brackets', () => {
    for (const variant of [
      'Employee Code',
      'employee_code',
      'EMPLOYEE-CODE',
      'employee.code',
      ' Employee   Code ',
      '(employee code)',
    ]) {
      expect(normaliseHeader(variant), variant).toBe('employeecode');
    }
  });

  it('leaves Thai text intact apart from whitespace', () => {
    expect(normaliseHeader(' รหัสพนักงาน ')).toBe('รหัสพนักงาน');
    expect(normaliseHeader('รหัส พนักงาน')).toBe('รหัสพนักงาน');
  });

  it('handles null and undefined cells', () => {
    expect(normaliseHeader(null)).toBe('');
    expect(normaliseHeader(undefined)).toBe('');
  });
});

describe('English headers', () => {
  it('resolves the canonical names', () => {
    const map = resolveColumns(['employee_code', 'date', 'check_in', 'check_out']);
    expect(map.hasHeader).toBe(true);
    expect(map.missing).toEqual([]);
    expect(map.indexes).toEqual({ employeeCode: 0, date: 1, checkIn: 2, checkOut: 3 });
  });

  it('resolves common variants', () => {
    const map = resolveColumns(['Employee ID', 'Work Date', 'Time In', 'Time Out']);
    expect(map.missing).toEqual([]);
    expect(map.indexes.employeeCode).toBe(0);
    expect(map.indexes.checkOut).toBe(3);
  });

  it('resolves clock in/out naming', () => {
    const map = resolveColumns(['Code', 'Date', 'Clock In', 'Clock Out']);
    expect(map.missing).toEqual([]);
  });
});

describe('Thai headers', () => {
  it('resolves the standard Thai header row', () => {
    const map = resolveColumns(['รหัสพนักงาน', 'วันที่', 'เวลาเข้างาน', 'เวลาออกงาน']);
    expect(map.hasHeader).toBe(true);
    expect(map.missing).toEqual([]);
    expect(map.indexes).toEqual({ employeeCode: 0, date: 1, checkIn: 2, checkOut: 3 });
  });

  it('resolves shorter Thai variants', () => {
    const map = resolveColumns(['รหัส', 'วันทำงาน', 'เวลาเข้า', 'เวลาออก']);
    expect(map.missing).toEqual([]);
    expect(map.indexes.checkIn).toBe(2);
  });

  it('resolves a mixed Thai/English header row', () => {
    const map = resolveColumns(['รหัสพนักงาน', 'Date', 'เวลาเข้างาน', 'check_out']);
    expect(map.missing).toEqual([]);
    expect(map.indexes).toEqual({ employeeCode: 0, date: 1, checkIn: 2, checkOut: 3 });
  });
});

describe('real-world sheet shapes', () => {
  it('handles reordered columns', () => {
    const map = resolveColumns(['วันที่', 'เวลาออกงาน', 'รหัสพนักงาน', 'เวลาเข้างาน']);
    expect(map.indexes).toEqual({ employeeCode: 2, date: 0, checkIn: 3, checkOut: 1 });
  });

  it('ignores extra columns the sheet happens to carry', () => {
    const map = resolveColumns([
      'ลำดับ',
      'รหัสพนักงาน',
      'ชื่อ-นามสกุล',
      'แผนก',
      'วันที่',
      'เวลาเข้างาน',
      'เวลาออกงาน',
      'หมายเหตุ',
    ]);
    expect(map.missing).toEqual([]);
    expect(map.indexes.employeeCode).toBe(1);
    expect(map.indexes.date).toBe(4);
    expect(map.indexes.checkOut).toBe(6);
  });

  it('accepts a sheet with no time columns at all', () => {
    const map = resolveColumns(['รหัสพนักงาน', 'วันที่']);
    // Times are optional; a row with neither becomes a missing-punch day.
    expect(map.missing).toEqual([]);
    expect(map.indexes.checkIn).toBe(-1);
    expect(map.indexes.checkOut).toBe(-1);
  });
});

describe('missing required columns', () => {
  it('reports a missing employee code', () => {
    const map = resolveColumns(['วันที่', 'เวลาเข้างาน', 'เวลาออกงาน']);
    expect(map.missing).toEqual(['employeeCode']);
  });

  it('reports a missing date', () => {
    const map = resolveColumns(['รหัสพนักงาน', 'เวลาเข้างาน']);
    expect(map.missing).toEqual(['date']);
  });

  it('produces a message naming the missing column, the found headers and the accepted names', () => {
    const map = resolveColumns(['วันที่', 'เวลาเข้างาน']);
    const message = describeMissingColumns(map);
    expect(message).toContain('รหัสพนักงาน');
    expect(message).toContain('วันที่');
    expect(message).toContain('employee_code');
  });
});

describe('positional fallback', () => {
  it('falls back to A-D when no header is recognised', () => {
    const map = resolveColumns(['ลำดับ', 'ชื่อ', 'อะไรก็ไม่รู้', 'x']);
    expect(map.hasHeader).toBe(false);
    expect(map.indexes).toEqual({ employeeCode: 0, date: 1, checkIn: 2, checkOut: 3 });
    expect(map.firstDataRow).toBe(1);
  });

  it('treats the first row as data when there is no header', () => {
    const map = resolveColumns(['EMP001', '2026-09-01', '08:55', '18:05']);
    const rows = extractRows([['EMP001', '2026-09-01', '08:55', '18:05']], map);
    expect(rows).toHaveLength(1);
    expect(rows[0].employeeCode).toBe('EMP001');
    expect(rows[0].sheetRow).toBe(1);
  });
});

describe('row extraction', () => {
  const header = ['รหัสพนักงาน', 'วันที่', 'เวลาเข้างาน', 'เวลาออกงาน'];
  const map = resolveColumns(header);

  it('numbers data rows from 2 when a header is present', () => {
    const rows = extractRows(
      [header, ['EMP001', '2026-09-01', '08:55', '18:05'], ['EMP002', '2026-09-01', '09:10', '18:00']],
      map
    );
    expect(rows[0].sheetRow).toBe(2);
    expect(rows[1].sheetRow).toBe(3);
  });

  it('trims cells and converts blanks to null times', () => {
    const rows = extractRows([header, ['  EMP001  ', ' 2026-09-01 ', '', '   ']], map);
    expect(rows[0].employeeCode).toBe('EMP001');
    expect(rows[0].date).toBe('2026-09-01');
    expect(rows[0].checkIn).toBeNull();
    expect(rows[0].checkOut).toBeNull();
  });

  it('drops entirely blank rows without treating them as errors', () => {
    const rows = extractRows([header, ['', '', '', ''], ['EMP001', '2026-09-01', '08:55', '18:05']], map);
    expect(rows).toHaveLength(1);
  });

  it('keeps a row that has a code but no date, so it can be reported as invalid', () => {
    const rows = extractRows([header, ['EMP001', '', '', '']], map);
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe('');
  });

  it('tolerates short rows where trailing cells are absent', () => {
    const rows = extractRows([header, ['EMP001', '2026-09-01']], map);
    expect(rows[0].checkIn).toBeNull();
    expect(rows[0].checkOut).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Range derivation
// ---------------------------------------------------------------------------

describe('sheet range derivation', () => {
  it('spans A:Z so extra columns are not truncated', () => {
    // A narrow A:D would cut off the columns of a real timesheet that carries
    // running numbers, names, departments and notes before the ones we need.
    expect(buildSheetRange('Attendance')).toBe('Attendance!A:Z');
  });

  it('quotes a tab name containing spaces', () => {
    expect(buildSheetRange('Time Sheet')).toBe("'Time Sheet'!A:Z");
  });

  it('quotes a Thai tab name', () => {
    expect(buildSheetRange('บันทึกเวลา')).toBe("'บันทึกเวลา'!A:Z");
  });

  it('escapes an apostrophe inside a tab name', () => {
    expect(buildSheetRange("Bob's Sheet")).toBe("'Bob''s Sheet'!A:Z");
  });

  it('does not quote a simple alphanumeric name', () => {
    expect(buildSheetRange('Sheet1')).toBe('Sheet1!A:Z');
    expect(buildSheetRange('attendance_2026')).toBe('attendance_2026!A:Z');
  });

  it('falls back to Attendance for a blank name', () => {
    expect(buildSheetRange('   ')).toBe('Attendance!A:Z');
  });

  it('trims surrounding whitespace', () => {
    expect(buildSheetRange('  Attendance  ')).toBe('Attendance!A:Z');
  });
});
