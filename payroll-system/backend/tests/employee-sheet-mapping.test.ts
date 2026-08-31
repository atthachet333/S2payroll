import { describe, it, expect } from 'vitest';
import {
  describeMissingEmployeeColumns,
  extractEmployeeRows,
  findDuplicateCodes,
  normaliseEmployeeCode,
  parseEmployeeStatus,
  parseEmploymentType,
  parseThaiFullName,
  resolveEmployeeColumns,
  slugCode,
} from '../src/services/employee-sheet-mapping.service.js';
import { checkDatabaseUrl, EXPECTED_DATABASE, FORBIDDEN_DATABASES } from '../scripts/db-guard.js';

/**
 * The Employees tab is the boundary between the real HR spreadsheet and the
 * payroll database. A mis-read header here would attach one person's identity
 * to another person's payslip, so every supported shape is asserted directly.
 */

/** The real S2A_DB `Employees` header row, including Google's placeholders. */
const REAL_HEADERS = [
  'lineUserId', 'employeeId', 'name', 'position', 'department', 'EmploymentType',
  'คอลัมน์ 7', 'คอลัมน์ 8', 'คอลัมน์ 9',
];

const REAL_ROWS: string[][] = [
  REAL_HEADERS,
  ['Ub1', 'S2A000', 'นางสาว สรวงพรรณ ศรีเปี่ยมลาภ (ผึ้ง)', 'CEO', 'Accounting Department', 'พนักงานประจำ'],
  ['U82', 'S2A001', 'นาย อัฐเชษฐ์ ทองชัช (วิน)', 'Full-Stack Developer', 'Information Technology', 'พนักงานประจำ'],
  ['Ub3', 'S2A002', 'นางสาว ฐิติรัตน์ ทิพย์สุราษฏร์ (ดรีม)', 'Accounting Officer', 'Accounting Department', 'พนักงานรายวัน'],
];

describe('employee header resolution', () => {
  it('maps the real S2A_DB Employees header row', () => {
    const map = resolveEmployeeColumns(REAL_HEADERS);
    expect(map.missing).toEqual([]);
    expect(map.indexes.employeeCode).toBe(1);
    expect(map.indexes.name).toBe(2);
    expect(map.indexes.position).toBe(3);
    expect(map.indexes.department).toBe(4);
    expect(map.indexes.employmentType).toBe(5);
  });

  it('never treats lineUserId as an identifier', () => {
    const map = resolveEmployeeColumns(REAL_HEADERS);
    // lineUserId is at index 0 and must not be claimed by any mapped field.
    expect(Object.values(map.indexes)).not.toContain(0);
    expect(map.unmapped).not.toContain('lineUserId');
  });

  it('ignores Google placeholder headers rather than reporting them unmapped', () => {
    const map = resolveEmployeeColumns(REAL_HEADERS);
    expect(map.unmapped).toEqual([]);
  });

  it('reports a genuinely unrecognised header', () => {
    const map = resolveEmployeeColumns([...REAL_HEADERS, 'Bonus Scheme']);
    expect(map.unmapped).toEqual(['Bonus Scheme']);
  });

  it('resolves reordered and Thai headers', () => {
    const map = resolveEmployeeColumns(['แผนก', 'ชื่อ-นามสกุล', 'รหัสพนักงาน', 'ตำแหน่ง', 'ประเภทพนักงาน']);
    expect(map.missing).toEqual([]);
    expect(map.indexes.employeeCode).toBe(2);
    expect(map.indexes.department).toBe(0);
  });

  it('reports a missing employee-code column with the accepted names', () => {
    const map = resolveEmployeeColumns(['name', 'position', 'department']);
    expect(map.missing).toEqual(['employeeCode']);
    const message = describeMissingEmployeeColumns(map);
    expect(message).toContain('employeeCode');
    expect(message).toContain('employee_code');
  });
});

describe('Thai name parsing', () => {
  it('splits title, first, last and nickname', () => {
    expect(parseThaiFullName('นางสาว ฐิติรัตน์ ทิพย์สุราษฏร์ (ดรีม)')).toEqual({
      title: 'นางสาว',
      firstName: 'ฐิติรัตน์',
      lastName: 'ทิพย์สุราษฏร์',
      nickname: 'ดรีม',
    });
  });

  it('handles a นาย prefix', () => {
    const parsed = parseThaiFullName('นาย ธนพล วนิชสุนทร (อาร์ม)');
    expect(parsed.firstName).toBe('ธนพล');
    expect(parsed.lastName).toBe('วนิชสุนทร');
    expect(parsed.nickname).toBe('อาร์ม');
  });

  it('keeps a multi-word surname intact', () => {
    const parsed = parseThaiFullName('นางสาว ธนพร ศุภชัยศิริจันทร์ (เนส)');
    expect(parsed.lastName).toBe('ศุภชัยศิริจันทร์');
  });

  it('does not invent a surname when only one name is present', () => {
    const parsed = parseThaiFullName('สมชาย');
    expect(parsed.firstName).toBe('สมชาย');
    expect(parsed.lastName).toBe('');
    expect(parsed.nickname).toBeNull();
  });

  it('tolerates missing nickname and extra whitespace', () => {
    const parsed = parseThaiFullName('  นาย   อัฐเชษฐ์    ทองชัช  ');
    expect(parsed.firstName).toBe('อัฐเชษฐ์');
    expect(parsed.lastName).toBe('ทองชัช');
    expect(parsed.nickname).toBeNull();
  });
});

describe('value parsing', () => {
  it('maps the Thai employment types used by the sheet', () => {
    expect(parseEmploymentType('พนักงานประจำ')).toBe('MONTHLY');
    expect(parseEmploymentType('พนักงานรายวัน')).toBe('DAILY');
  });

  it('returns null for an unknown employment type rather than defaulting', () => {
    expect(parseEmploymentType('ฟรีแลนซ์บางเวลา')).toBeNull();
  });

  it('maps statuses and returns null for unknown ones', () => {
    expect(parseEmployeeStatus('active')).toBe('ACTIVE');
    expect(parseEmployeeStatus('ลาออก')).toBe('TERMINATED');
    expect(parseEmployeeStatus('???')).toBeNull();
  });

  it('normalises employee codes to uppercase without spaces', () => {
    expect(normaliseEmployeeCode('  s2a002 ')).toBe('S2A002');
    expect(normaliseEmployeeCode('S2A 003')).toBe('S2A003');
  });

  it('derives stable master-data codes', () => {
    expect(slugCode('Accounting Department', 'X')).toBe('ACCOUNTING_DEPARTMENT');
    expect(slugCode('Full-Stack Developer', 'X')).toBe('FULL_STACK_DEVELOPER');
    expect(slugCode('   ', 'FALLBACK')).toBe('FALLBACK');
  });
});

describe('row extraction', () => {
  const map = resolveEmployeeColumns(REAL_HEADERS);

  it('extracts S2A codes with parsed names and mapped types', () => {
    const rows = extractEmployeeRows(REAL_ROWS, map);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.employeeCode)).toEqual(['S2A000', 'S2A001', 'S2A002']);
    expect(rows[2]).toMatchObject({
      employeeCode: 'S2A002',
      firstName: 'ฐิติรัตน์',
      lastName: 'ทิพย์สุราษฏร์',
      nickname: 'ดรีม',
      department: 'Accounting Department',
      position: 'Accounting Officer',
      employmentType: 'DAILY',
      errors: [],
    });
    expect(rows[0].sheetRow).toBe(2);
  });

  it('leaves fields the sheet does not carry as null instead of inventing them', () => {
    const rows = extractEmployeeRows(REAL_ROWS, map);
    // The real tab has no start date, salary or status column.
    expect(rows[0].startDate).toBeNull();
    expect(rows[0].status).toBeNull();
    expect(rows[0]).not.toHaveProperty('baseSalary');
  });

  it('flags a row with no employee code as invalid', () => {
    const rows = extractEmployeeRows([REAL_HEADERS, ['U1', '', 'นาย ก ข (ก)', 'Dev', 'IT', 'พนักงานประจำ']], map);
    expect(rows[0].errors).toContain('ไม่มีรหัสพนักงาน');
  });

  it('flags a row with no name as invalid', () => {
    const rows = extractEmployeeRows([REAL_HEADERS, ['U1', 'S2A009', '', 'Dev', 'IT', 'พนักงานประจำ']], map);
    expect(rows[0].errors).toContain('ไม่มีชื่อพนักงาน');
  });

  it('flags an unrecognised employment type instead of silently defaulting', () => {
    const rows = extractEmployeeRows([REAL_HEADERS, ['U1', 'S2A009', 'นาย ก ข', 'Dev', 'IT', 'ฟรีแลนซ์']], map);
    expect(rows[0].employmentType).toBeNull();
    expect(rows[0].errors.join(' ')).toContain('ประเภทพนักงานไม่รู้จัก');
  });

  it('drops entirely blank trailing rows', () => {
    const rows = extractEmployeeRows([REAL_HEADERS, ['', '', '', '', '', '']], map);
    expect(rows).toHaveLength(0);
  });

  it('detects duplicate employee codes across the pull', () => {
    const rows = extractEmployeeRows(
      [
        REAL_HEADERS,
        ['U1', 'S2A002', 'นาย ก ข', 'Dev', 'IT', 'พนักงานประจำ'],
        ['U2', 'S2A002', 'นาย ค ง', 'Dev', 'IT', 'พนักงานประจำ'],
        ['U3', 'S2A003', 'นาย จ ฉ', 'Dev', 'IT', 'พนักงานประจำ'],
      ],
      map
    );
    expect(findDuplicateCodes(rows)).toEqual(['S2A002']);
  });

  it('treats codes differing only by case or spacing as the same duplicate', () => {
    const rows = extractEmployeeRows(
      [
        REAL_HEADERS,
        ['U1', 's2a002', 'นาย ก ข', 'Dev', 'IT', 'พนักงานประจำ'],
        ['U2', 'S2A 002', 'นาย ค ง', 'Dev', 'IT', 'พนักงานประจำ'],
      ],
      map
    );
    expect(findDuplicateCodes(rows)).toEqual(['S2A002']);
  });

  it('reports no duplicates for the real roster', () => {
    expect(findDuplicateCodes(extractEmployeeRows(REAL_ROWS, map))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The guard that keeps all of this pointed at the right database
// ---------------------------------------------------------------------------

describe('database guard still protects the ERP database', () => {
  it('only accepts s2apayroll', () => {
    expect(EXPECTED_DATABASE).toBe('s2apayroll');
    expect(checkDatabaseUrl('mysql://u:p@192.168.2.135:3306/s2apayroll').ok).toBe(true);
  });

  it('refuses s2a_erp_main', () => {
    const result = checkDatabaseUrl('mysql://u:p@192.168.2.135:3306/s2a_erp_main');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('never modify');
  });

  it('refuses every forbidden database by name', () => {
    for (const db of FORBIDDEN_DATABASES) {
      expect(checkDatabaseUrl(`mysql://u:p@h:3306/${db}`).ok, db).toBe(false);
    }
  });

  it('refuses any other database, however plausible', () => {
    expect(checkDatabaseUrl('mysql://u:p@h:3306/s2apayroll_backup').ok).toBe(false);
  });
});
