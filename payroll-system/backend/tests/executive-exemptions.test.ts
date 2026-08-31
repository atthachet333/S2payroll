import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), 'utf8');

describe('employee attendance and leave policies', () => {
  const schema = read('prisma', 'schema.prisma');
  const employeeService = read('src', 'services', 'employee.service.ts');

  it('defaults both policies to required for every new employee', () => {
    expect(schema).toMatch(/attendanceRequired\s+Boolean\s+@default\(true\)/);
    expect(schema).toMatch(/leaveTrackingRequired\s+Boolean\s+@default\(true\)/);
    expect(employeeService).toContain('attendanceRequired: input.attendanceRequired ?? true');
    expect(employeeService).toContain('leaveTrackingRequired: input.leaveTrackingRequired ?? true');
  });

  it('exempts only the two explicitly approved employee codes', () => {
    const script = read('scripts', 'apply-executive-exemptions.ts');
    expect(script).toContain("const TARGET_CODES = ['S2A000', 'S2A001'] as const");
    expect(script).toContain("if (db !== 's2apayroll')");
    expect(script).toContain('WHERE employee_code IN (?, ?)');
    expect(script).not.toContain('s2a_erp_main');
  });
});

describe('exempt employees do not create compliance noise', () => {
  it('filters attendance tables, summaries, recalculation and payroll aggregation', () => {
    const attendance = read('src', 'services', 'attendance.service.ts');
    const payroll = read('src', 'services', 'payroll.service.ts');
    expect(attendance.match(/attendanceRequired: true/g)?.length).toBeGreaterThanOrEqual(4);
    expect(attendance).toContain('employmentType: { not: EmploymentType.DAILY }');
    expect(attendance).toContain('employmentType: record.employee.employmentType');
    expect(payroll).toContain('employee: { attendanceRequired: true }');
    expect(payroll).toContain('employee: { leaveTrackingRequired: true }');
    expect(payroll).toContain('attendanceRequired: employee.attendanceRequired');
  });

  it('does not flag attendance-exempt employees in payroll pre-check', () => {
    const precheck = read('src', 'services', 'pre-payroll-check.service.ts');
    expect(precheck).toContain('e.attendanceRequired && (expectedDates.get(e.id)?.length ?? 0) > 0');
    expect(precheck).toContain('attendanceRequired === false && e.leaveTrackingRequired === false');
  });

  it('skips leave-exempt employees during preview, import and materialization', () => {
    const leave = read('src', 'services', 'leave-sync.service.ts');
    expect(leave).toContain("'EXEMPT'");
    expect(leave).toContain('if (!employee.leaveTrackingRequired)');
    expect(leave).toContain('employee: { leaveTrackingRequired: true }');
  });
});

describe('employment-type attendance paths share the same policy engine', () => {
  it('passes employment type through imports, corrections and recalculation', () => {
    const attendance = read('src', 'services', 'attendance.service.ts');
    const sheets = read('src', 'services', 'google-sheets.service.ts');
    expect(attendance).toContain('employmentType: record.employee.employmentType');
    expect(sheets).toContain('employmentType: employee.employmentType');
    expect(attendance).toContain('พนักงานรายวันไม่ใช้สถานะมาสาย');
  });

  it('filters DAILY and exempt employees from late summary/report queries', () => {
    const attendance = read('src', 'services', 'attendance.service.ts');
    const reports = read('src', 'services', 'report.service.ts');
    expect(attendance).toContain('employmentType: { not: EmploymentType.DAILY }');
    expect(reports).toContain("variant === 'late' ? { employmentType: { not: 'DAILY' } }");
  });

  it('makes preview sanity violations a hard stop before apply', () => {
    const preview = read('scripts', 'apply-attendance-policy.ts');
    expect(preview).toContain('sanityViolations');
    expect(preview).toContain('Refusing apply:');
    expect(preview.indexOf('Refusing apply:')).toBeLessThan(preview.indexOf('payrollSetting.upsert'));
  });
});

describe('employee UI exposes the policy without hiding the employee', () => {
  it('has edit controls and visible executive indicators', () => {
    const form = read('..', 'frontend', 'src', 'features', 'employees', 'EmployeeFormDialog.tsx');
    const list = read('..', 'frontend', 'src', 'pages', 'EmployeesPage.tsx');
    const detail = read('..', 'frontend', 'src', 'pages', 'EmployeeDetailPage.tsx');
    expect(form).toContain('ต้องลงเวลาเข้า-ออกงาน');
    expect(form).toContain('ต้องติดตามและตรวจสอบวันลา');
    expect(list).toContain('ผู้บริหาร · ยกเว้นลงเวลา/วันลา');
    expect(detail).toContain('employee.attendanceRequired');
    expect(detail).toContain('employee.leaveTrackingRequired');
  });
});
