import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EmploymentType } from '@prisma/client';
import {
  ALWAYS_REQUIRED_FIELDS,
  COMPENSATION_FIELD_BY_TYPE,
  COMPENSATION_REQUIRED_TYPES,
  EMPLOYEE_FIELD_LABELS,
  OPTIONAL_EMPLOYEE_FIELDS,
  completenessWhere,
  evaluateEmployeeProfileCompleteness,
  withProfileCompleteness,
  type CompletenessInput,
} from '../src/services/employee-completeness.service.js';

/**
 * Employee master-data completeness.
 *
 * One rule, evaluated on the backend. These tests pin the rule itself, the
 * deliberate exclusions (executive exemptions, optional contact fields,
 * attendance state), and the fact that the database filter agrees with the
 * in-memory evaluator.
 */

const FRONTEND = path.resolve(__dirname, '../../frontend');
const readFe = (p: string) => fs.readFileSync(path.join(FRONTEND, p), 'utf8');

/** A fully-populated MONTHLY employee. Individual cases knock one field out. */
const complete = (over: Partial<CompletenessInput> = {}): CompletenessInput => ({
  employeeCode: 'S2A010',
  firstName: 'ทดสอบ',
  lastName: 'ระบบ',
  employmentType: EmploymentType.MONTHLY,
  departmentId: 'dept-1',
  positionId: 'pos-1',
  startDate: new Date('2026-01-01T00:00:00.000Z'),
  status: 'ACTIVE',
  baseSalary: 18000,
  attendanceRequired: true,
  leaveTrackingRequired: true,
  ...over,
});

/**
 * An executive: excused from BOTH attendance and leave tracking, which is how
 * the system records someone whose pay does not come from a timesheet.
 */
const executive = (over: Partial<CompletenessInput> = {}): CompletenessInput =>
  complete({ attendanceRequired: false, leaveTrackingRequired: false, baseSalary: 0, ...over });

describe('a fully populated profile is complete', () => {
  it('reports complete with nothing missing', () => {
    const result = evaluateEmployeeProfileCompleteness(complete());
    expect(result.complete).toBe(true);
    expect(result.missingFields).toEqual([]);
    expect(result.missingCount).toBe(0);
    expect(result.missingLabels).toEqual([]);
  });

  it('accepts a Decimal-like salary object', () => {
    const decimalish = { toString: () => '18000.00' };
    expect(evaluateEmployeeProfileCompleteness(complete({ baseSalary: decimalish })).complete).toBe(true);
  });

  it('accepts a salary supplied as a string', () => {
    expect(evaluateEmployeeProfileCompleteness(complete({ baseSalary: '16000' })).complete).toBe(true);
  });
});

describe('each required field is genuinely required', () => {
  it.each([
    ['employeeCode', { employeeCode: '' }, 'รหัสพนักงาน'],
    ['firstName', { firstName: '' }, 'ชื่อ'],
    ['lastName', { lastName: '  ' }, 'นามสกุล'],
    ['department', { departmentId: null }, 'แผนก'],
    ['position', { positionId: null }, 'ตำแหน่ง'],
    ['startDate', { startDate: null }, 'วันที่เริ่มงาน'],
    ['status', { status: null }, 'สถานะพนักงาน'],
  ])('missing %s makes the profile incomplete', (_name, override, label) => {
    const result = evaluateEmployeeProfileCompleteness(complete(override as Partial<CompletenessInput>));
    expect(result.complete).toBe(false);
    expect(result.missingLabels).toContain(label);
  });

  it('reports several missing fields at once with an accurate count', () => {
    const result = evaluateEmployeeProfileCompleteness(
      complete({ departmentId: null, positionId: null, baseSalary: 0 })
    );
    expect(result.missingCount).toBe(3);
    expect(result.missingLabels).toEqual(['แผนก', 'ตำแหน่ง', 'เงินเดือนพื้นฐาน']);
  });
});

describe('compensation requirement follows the pay type', () => {
  it('MONTHLY needs a monthly salary above zero', () => {
    const result = evaluateEmployeeProfileCompleteness(complete({ baseSalary: 0 }));
    expect(result.complete).toBe(false);
    expect(result.missingFields).toContain('monthlySalary');
    expect(result.missingLabels).toContain('เงินเดือนพื้นฐาน');
  });

  it('CONTRACT follows MONTHLY - it is a fixed monthly figure', () => {
    const result = evaluateEmployeeProfileCompleteness(
      complete({ employmentType: EmploymentType.CONTRACT, baseSalary: 0 })
    );
    expect(result.complete).toBe(false);
    expect(result.missingFields).toContain('monthlySalary');
  });

  // A daily or hourly rate is payroll configuration settled later, not part of
  // the employee's master data. Payroll readiness still requires it separately.
  it('DAILY with no rate is COMPLETE - the rate is not master data', () => {
    const result = evaluateEmployeeProfileCompleteness(
      complete({ employmentType: EmploymentType.DAILY, baseSalary: 0 })
    );
    expect(result.complete).toBe(true);
    expect(result.missingCount).toBe(0);
    expect(result.compensationRequired).toBe(false);
  });

  it('DAILY never lists a compensation field as missing', () => {
    const result = evaluateEmployeeProfileCompleteness(
      complete({ employmentType: EmploymentType.DAILY, baseSalary: 0 })
    );
    expect(result.missingFields).not.toContain('dailyRate');
    expect(result.missingLabels).not.toContain('อัตราค่าจ้างรายวัน');
    expect(result.missingLabels).toEqual([]);
  });

  it('HOURLY with no rate is COMPLETE, consistent with DAILY', () => {
    const result = evaluateEmployeeProfileCompleteness(
      complete({ employmentType: EmploymentType.HOURLY, baseSalary: 0 })
    );
    expect(result.complete).toBe(true);
    expect(result.missingFields).not.toContain('hourlyRate');
    expect(result.compensationRequired).toBe(false);
  });

  it('a DAILY employee still fails on genuinely missing master data', () => {
    const result = evaluateEmployeeProfileCompleteness(
      complete({ employmentType: EmploymentType.DAILY, baseSalary: 0, positionId: null })
    );
    expect(result.complete).toBe(false);
    expect(result.missingLabels).toEqual(['ตำแหน่ง']);
  });

  it('only the salaried pay types require compensation', () => {
    expect([...COMPENSATION_REQUIRED_TYPES].sort()).toEqual(['CONTRACT', 'MONTHLY']);
  });

  it('a configured DAILY rate satisfies the requirement', () => {
    expect(
      evaluateEmployeeProfileCompleteness(
        complete({ employmentType: EmploymentType.DAILY, baseSalary: 600 })
      ).complete
    ).toBe(true);
  });

  it('rejects a negative amount as well as zero', () => {
    expect(evaluateEmployeeProfileCompleteness(complete({ baseSalary: -1 })).complete).toBe(false);
  });

  it('maps every employment type to a compensation field', () => {
    for (const type of Object.values(EmploymentType)) {
      expect(COMPENSATION_FIELD_BY_TYPE[type], type).toBeDefined();
    }
  });
});

describe('deliberate exclusions', () => {
  it('an exempt executive with a filled record is complete', () => {
    const result = evaluateEmployeeProfileCompleteness(executive());
    expect(result.complete).toBe(true);
    expect(result.exempt).toBe(true);
  });

  it('an exempt executive with zero salary is still complete', () => {
    const result = evaluateEmployeeProfileCompleteness(executive({ baseSalary: 0 }));
    expect(result.complete).toBe(true);
    expect(result.missingLabels).not.toContain('เงินเดือนพื้นฐาน');
    expect(result.compensationRequired).toBe(false);
  });

  it('the exemption flags are never themselves reported as missing fields', () => {
    const result = evaluateEmployeeProfileCompleteness(executive({ baseSalary: 0 }));
    expect(result.missingFields as string[]).not.toContain('attendanceRequired');
    expect(result.missingFields as string[]).not.toContain('leaveTrackingRequired');
  });

  it('needs BOTH exemptions - one alone still requires compensation', () => {
    const attendanceOnly = evaluateEmployeeProfileCompleteness(
      complete({ baseSalary: 0, attendanceRequired: false, leaveTrackingRequired: true })
    );
    expect(attendanceOnly.exempt).toBe(false);
    expect(attendanceOnly.complete).toBe(false);

    const leaveOnly = evaluateEmployeeProfileCompleteness(
      complete({ baseSalary: 0, attendanceRequired: true, leaveTrackingRequired: false })
    );
    expect(leaveOnly.exempt).toBe(false);
    expect(leaveOnly.complete).toBe(false);
  });

  it('an exempt executive still needs identity and placement', () => {
    const result = evaluateEmployeeProfileCompleteness(executive({ departmentId: null, positionId: null }));
    expect(result.complete).toBe(false);
    expect(result.missingLabels).toEqual(['แผนก', 'ตำแหน่ง']);
  });

  it('does not hardcode any employee code', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/services/employee-completeness.service.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/S2A\d{3}/);
  });

  it('optional contact and banking fields never block completeness', () => {
    const result = evaluateEmployeeProfileCompleteness(complete());
    for (const optional of OPTIONAL_EMPLOYEE_FIELDS) {
      expect(result.missingFields as string[], optional).not.toContain(optional);
    }
    expect(result.complete).toBe(true);
  });

  it('says nothing about attendance - that is payroll readiness, not profile data', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/services/employee-completeness.service.ts'),
      'utf8'
    );
    expect(source).not.toContain('MISSING_DATA');
    expect(source).not.toContain('attendanceRecord');
  });
});

describe('labels are operator-facing, never column names', () => {
  it('gives every field a Thai label', () => {
    for (const field of [...ALWAYS_REQUIRED_FIELDS, 'monthlySalary', 'dailyRate', 'hourlyRate'] as const) {
      expect(EMPLOYEE_FIELD_LABELS[field], field).toBeTruthy();
      expect(EMPLOYEE_FIELD_LABELS[field]).toMatch(/[ก-๙]/);
    }
  });

  it('never surfaces an internal column name', () => {
    const labels = Object.values(EMPLOYEE_FIELD_LABELS).join(' ');
    for (const internal of ['baseSalary', 'employmentType', 'attendanceRequired', 'departmentId']) {
      expect(labels, internal).not.toContain(internal);
    }
  });
});

describe('the database filter agrees with the evaluator', () => {
  const incompleteClauses = () => (completenessWhere('INCOMPLETE') as { OR: object[] }).OR;

  it('INCOMPLETE matches on any missing required field', () => {
    const serialised = JSON.stringify(incompleteClauses());
    expect(serialised).toContain('departmentId');
    expect(serialised).toContain('positionId');
    expect(serialised).toContain('baseSalary');
  });

  it('COMPLETE is the exact negation of INCOMPLETE', () => {
    const complete = completenessWhere('COMPLETE') as { NOT: { OR: object[] } };
    expect(complete.NOT.OR).toEqual(incompleteClauses());
  });

  it('treats a zero or negative salary as incomplete, matching the evaluator', () => {
    expect(JSON.stringify(incompleteClauses())).toContain('"lte":0');
    expect(evaluateEmployeeProfileCompleteness(complete({ baseSalary: 0 })).complete).toBe(false);
  });
});

describe('the API decorates rows without mutating them', () => {
  it('attaches profileCompleteness and leaves the original fields intact', () => {
    const row = complete({ baseSalary: 0 });
    const decorated = withProfileCompleteness(row);
    expect(decorated.profileCompleteness.complete).toBe(false);
    expect(decorated.employeeCode).toBe('S2A010');
    expect(decorated.baseSalary).toBe(0);
  });

  it('is exposed by both the list and the detail service', () => {
    const service = fs.readFileSync(
      path.resolve(__dirname, '../src/services/employee.service.ts'),
      'utf8'
    );
    expect(service).toContain('items: items.map(withProfileCompleteness)');
    expect(service).toContain('return withProfileCompleteness(employee)');
  });

  it('applies the completeness filter in the query, alongside the others', () => {
    const service = fs.readFileSync(
      path.resolve(__dirname, '../src/services/employee.service.ts'),
      'utf8'
    );
    expect(service).toContain('...(params.completeness ? completenessWhere(params.completeness) : {})');
    // The other filters must still be present in the same where clause.
    expect(service).toContain('params.departmentId');
    expect(service).toContain('params.employmentType');
    expect(service).toContain('params.search');
  });
});

// ---------------------------------------------------------------------------
// Frontend contract
// ---------------------------------------------------------------------------

describe('Employees page surfaces completeness without re-deciding it', () => {
  const page = readFe('src/pages/EmployeesPage.tsx');

  it('renders the badge from the backend verdict', () => {
    expect(page).toContain('ProfileCompletenessBadge');
    expect(page).toContain('employee.profileCompleteness');
    expect(page).toContain('ข้อมูลครบ');
    expect(page).toContain('ข้อมูลไม่ครบ');
  });

  it('does not reimplement the rule in the browser', () => {
    // No local recomputation from raw fields.
    expect(page).not.toMatch(/baseSalary\s*[<>]=?\s*0/);
    expect(page).not.toContain('missingFields.push');
  });

  it('offers the completeness filter alongside the existing ones', () => {
    expect(page).toContain('setCompleteness');
    expect(page).toContain('ความครบถ้วน');
    expect(page).toContain("completeness: (completeness || undefined)");
    // Selecting it must not clear the others.
    expect(page).toContain('departmentId: departmentId || undefined');
    expect(page).toContain('employmentType: employmentType || undefined');
  });

  it('shows header counters from the backend summary', () => {
    expect(page).toContain('employee-completeness-summary');
    expect(page).toContain('พนักงานทั้งหมด');
  });

  it('adds an eye action next to edit, both with tooltips', () => {
    expect(page).toContain('aria-label="ดูข้อมูล"');
    expect(page).toContain('title="ดูข้อมูล"');
    expect(page).toContain('aria-label="แก้ไข"');
    expect(page).toContain('<Eye ');
  });

  it('keeps the missing-field list out of the table body', () => {
    // Only a count in the cell; the detail goes in the tooltip.
    expect(page).toContain('missingCount');
    expect(page).toContain('title={`ข้อมูลที่ยังขาด');
  });
});

describe('the detail drawer is strictly read-only', () => {
  const drawer = readFe('src/features/employees/EmployeeDetailDrawer.tsx');

  it('contains no form controls at all', () => {
    for (const control of ['<Input', '<Textarea', '<Select', '<Switch', '<form', 'onSubmit']) {
      expect(drawer, control).not.toContain(control);
    }
  });

  it('has no save or mutation path', () => {
    expect(drawer).not.toContain('useMutation');
    expect(drawer).not.toContain('employeeApi.update');
    expect(drawer).not.toContain('employeeApi.create');
    // No submit control. ("ต้องบันทึกเวลา" is a read-only policy label, so a
    // bare substring check on บันทึก would be a false positive.)
    expect(drawer).not.toContain('type="submit"');
    expect(drawer).not.toMatch(/>\s*บันทึก\s*</);
  });

  it('renders the required sections', () => {
    expect(drawer).toContain('ข้อมูลทั่วไป');
    expect(drawer).toContain('ข้อมูลค่าตอบแทน');
    expect(drawer).toContain('ข้อมูลการทำงาน');
    expect(drawer).toContain('ข้อมูลเพิ่มเติม');
  });

  it('labels compensation by pay type', () => {
    expect(drawer).toContain('อัตราค่าจ้างรายชั่วโมง');
    expect(drawer).toContain('เงินเดือนพื้นฐาน');
    expect(drawer).toContain('คิดตามชั่วโมง');
  });

  it('lists what is still missing when incomplete', () => {
    expect(drawer).toContain('ข้อมูลยังไม่ครบ');
    expect(drawer).toContain('missingLabels');
  });

  it('leaves read-only mode explicitly before editing', () => {
    expect(drawer).toContain('แก้ไขข้อมูล');
    expect(drawer).toMatch(/onClose\(\);\s*\n\s*onEdit\(detail\);/);
  });

  it('offers a close action', () => {
    expect(drawer).toContain('ปิด');
  });
});

// ---------------------------------------------------------------------------
// Executive handling downstream: filter, pre-payroll, and the redesigned UI
// ---------------------------------------------------------------------------

describe('the completeness filter treats an exempt executive as complete', () => {
  const incompleteClauses = () => JSON.stringify((completenessWhere('INCOMPLETE') as { OR: object[] }).OR);

  it('only counts a zero salary against employees it is required of', () => {
    // The salary clause must be conditioned on NOT being doubly exempt.
    expect(incompleteClauses()).toContain('attendanceRequired');
    expect(incompleteClauses()).toContain('leaveTrackingRequired');
  });

  it('still counts a zero salary against a normal employee', () => {
    expect(incompleteClauses()).toContain('"baseSalary":{"lte":0}');
    expect(evaluateEmployeeProfileCompleteness(complete({ baseSalary: 0 })).complete).toBe(false);
  });

  it('COMPLETE remains the exact negation of INCOMPLETE', () => {
    const c = completenessWhere('COMPLETE') as { NOT: { OR: object[] } };
    expect(JSON.stringify(c.NOT.OR)).toBe(incompleteClauses());
  });
});

describe('pre-payroll does not block on an exempt executive', () => {
  const service = fs.readFileSync(
    path.resolve(__dirname, '../src/services/pre-payroll-check.service.ts'),
    'utf8'
  );

  it('scopes the compensation checks to employees paid from a rate', () => {
    expect(service).toContain('const paidFromRate = employees.filter(');
    expect(service).toContain('for (const e of paidFromRate)');
    expect(service).toContain('missingMonthly');
    expect(service).toContain('missingHourly');
  });

  it('derives that scope from the same double-exemption rule', () => {
    expect(service).toMatch(
      /attendanceRequired === false[\s\S]{0,60}leaveTrackingRequired === false/
    );
  });

  it('keeps the attendance check exemption-aware as before', () => {
    expect(service).toContain('e.attendanceRequired && (expectedDates.get(e.id)?.length ?? 0) > 0');
  });

  it('still validates normal employees - the checks themselves are unchanged', () => {
    for (const code of ['MISSING_MONTHLY_SALARY', 'MISSING_HOURLY_RATE', 'MISSING_PAY_PROFILE_FOR_DATE_RANGE', 'INVALID_SALARY']) {
      expect(service, code).toContain(code);
    }
  });

  it('flags a negative amount even for an exempt executive', () => {
    // A negative figure is a data error whoever it belongs to.
    expect(service).toContain('const invalidSalary = employees.filter((e) => dec(e.baseSalary).isNegative())');
  });
});

describe('the redesigned detail view', () => {
  const drawer = readFe('src/features/employees/EmployeeDetailDrawer.tsx');

  it('is wider than the old narrow modal and uses two columns on desktop', () => {
    expect(drawer).toContain('max-w-4xl');
    // General information gets the wider of the two columns.
    expect(drawer).toContain('lg:grid-cols-[1.35fr_1fr]');
  });

  it('keeps the header and footer fixed while only the body scrolls', () => {
    expect(drawer).toContain('<header');
    expect(drawer).toContain('<footer');
    expect(drawer).toContain('min-h-0 flex-1 overflow-y-auto');
    expect(drawer).toContain('shrink-0');
  });

  it('shows the executive badge', () => {
    expect(drawer).toContain('ผู้บริหาร');
  });

  it('renders an exemption as neutral, never as an error', () => {
    expect(drawer).toContain('ยกเว้น');
    // The exemption pill is slate; rose/red is reserved for real problems.
    // The exemption pill is slate; rose/red stays reserved for real problems.
    expect(drawer).toContain("'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'");
    expect(drawer).not.toMatch(/ยกเว้น[\s\S]{0,120}(rose|danger)/);
  });

  it('shows compensation as not required for an exempt executive', () => {
    expect(drawer).toContain('ไม่บังคับสำหรับผู้บริหาร');
    // The red "not set" wording sits in the final branch, reachable only when
    // the employee is neither paid nor exempt.
    expect(drawer).toMatch(/exempt \?[\s\S]*ไม่บังคับสำหรับผู้บริหาร[\s\S]*ยังไม่ได้กำหนด/);
    // ...and the exempt branch itself is rendered in neutral slate.
    expect(drawer).toMatch(/ไม่บังคับสำหรับผู้บริหาร/);
    expect(drawer).toContain('text-slate-600');
  });

  it('renders the warning box only when something is missing', () => {
    expect(drawer).toContain('!completeness.complete &&');
    expect(drawer).toContain('ข้อมูลยังไม่ครบ');
    // Compact banner, not a full-height alert block.
    expect(drawer).toContain('border-rose-200 bg-rose-50');
  });

  it('hides optional fields that have no value', () => {
    expect(drawer).toContain('.filter(([, value]) => Boolean(value && String(value).trim()))');
    expect(drawer).toContain('ยังไม่มีข้อมูลเพิ่มเติม');
  });

  it('collapses system information', () => {
    expect(drawer).toContain('ข้อมูลระบบ');
    expect(drawer).toContain('aria-expanded={systemOpen}');
  });

  it('drops the old bordered-row layout in favour of a grid', () => {
    expect(drawer).not.toContain('divide-y divide-border/70');
    expect(drawer).toContain('sm:grid-cols-2');
    expect(drawer).toContain('gap-x-6');
  });

  it('remains strictly read-only', () => {
    for (const control of ['<Input', '<Textarea', '<Select', '<Switch', '<form', 'onSubmit', 'useMutation', 'type="submit"']) {
      expect(drawer, control).not.toContain(control);
    }
  });
});

describe('the Employees table shows the executive marker', () => {
  const page = readFe('src/pages/EmployeesPage.tsx');

  it('renders ผู้บริหาร from the backend exempt flag', () => {
    expect(page).toContain('completeness.exempt');
    expect(page).toContain('ผู้บริหาร');
  });

  it('pairs the marker with the completeness badge rather than replacing it', () => {
    expect(page).toContain('{executive}');
    expect(page).toContain('ข้อมูลครบ');
    expect(page).toContain('ข้อมูลไม่ครบ');
  });
});

// ---------------------------------------------------------------------------
// Profile completeness is not payroll readiness
// ---------------------------------------------------------------------------

describe('profile completeness and payroll readiness stay separate', () => {
  const preCheck = fs.readFileSync(
    path.resolve(__dirname, '../src/services/pre-payroll-check.service.ts'),
    'utf8'
  );

  it('a DAILY employee with no rate is profile-complete', () => {
    expect(
      evaluateEmployeeProfileCompleteness(
        complete({ employmentType: EmploymentType.DAILY, baseSalary: 0 })
      ).complete
    ).toBe(true);
  });

  it('...and payroll reports the missing DAILY rate as a warning, not a blocker', () => {
    expect(preCheck).toContain('MISSING_HOURLY_RATE');
    expect(preCheck).toContain('DAILY_RATE_UNCONFIGURED');
    const dailyWarning = preCheck.slice(preCheck.indexOf("code: 'DAILY_RATE_UNCONFIGURED'"));
    expect(dailyWarning).toContain("severity: 'WARNING'");
    expect(preCheck).toContain('validProfile(p, e.employmentType)');
    expect(preCheck).toContain("profile.payType === 'HOURLY'");
    expect(preCheck).toContain('profile.hourlyRate');
  });

  it('the HOURLY pre-payroll rate check remains BLOCKING', () => {
    const block = preCheck.slice(preCheck.indexOf("code: 'MISSING_HOURLY_RATE'"));
    expect(block).toContain("severity: 'BLOCKING'");
  });

  it('the completeness service is not coupled to payroll at all', () => {
    const service = fs.readFileSync(
      path.resolve(__dirname, '../src/services/employee-completeness.service.ts'),
      'utf8'
    );
    // Doc comments may mention the payroll codes to explain the split; what
    // must not exist is a real dependency on payroll or the database.
    const code = service.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('payrollPeriod');
    expect(code).not.toContain('MISSING_DAILY_RATE');
    expect(code).not.toMatch(/from '\.\/(pre-payroll-check|payroll)/);
    // The @prisma/client import is the EmploymentType enum only - the module
    // performs no query and holds no client.
    expect(code).not.toMatch(/\bprisma\./);
    expect(code).not.toContain("from '../plugins/prisma");
  });
});

describe('the SQL filter matches the new rule', () => {
  const incomplete = () => JSON.stringify((completenessWhere('INCOMPLETE') as { OR: object[] }).OR);

  it('restricts the salary clause to the salaried pay types', () => {
    expect(incomplete()).toContain('"employmentType":{"in":["MONTHLY","CONTRACT"]}');
  });

  it('agrees with the evaluator for each pay type at salary 0', () => {
    // MONTHLY incomplete, DAILY/HOURLY complete - the clause above encodes
    // exactly that, and the evaluator must say the same.
    expect(evaluateEmployeeProfileCompleteness(complete({ baseSalary: 0 })).complete).toBe(false);
    for (const type of [EmploymentType.DAILY, EmploymentType.HOURLY]) {
      expect(
        evaluateEmployeeProfileCompleteness(complete({ employmentType: type, baseSalary: 0 })).complete,
        type
      ).toBe(true);
    }
  });

  it('still excludes an exempt executive from the salary clause', () => {
    expect(incomplete()).toContain('attendanceRequired');
    expect(evaluateEmployeeProfileCompleteness(executive({ baseSalary: 0 })).complete).toBe(true);
  });
});

describe('the detail view presents an unset rate neutrally', () => {
  const drawer = readFe('src/features/employees/EmployeeDetailDrawer.tsx');

  it('branches on compensationRequired before showing the red wording', () => {
    expect(drawer).toContain('!completeness?.compensationRequired');
    expect(drawer).toMatch(/compensationRequired[\s\S]*ข้อมูลค่าจ้างจะกำหนดในขั้นตอน Payroll[\s\S]*text-rose-600/);
  });

  it('explains that the rate does not affect profile completeness', () => {
    expect(drawer).toContain('ไม่มีผลกับความครบถ้วนของข้อมูลพนักงาน');
    expect(drawer).toContain('ข้อมูลค่าจ้างจะกำหนดในขั้นตอน Payroll');
  });

  it('renders that state in slate, not rose', () => {
    expect(drawer).toMatch(/ยังไม่ได้กำหนด[\s\S]{0,200}text-muted-foreground/);
  });
});
