import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { EmployeeStatus } from '@prisma/client';
import {
  effectiveEmploymentStart,
  isEmployeeEligibleForPayrollPeriod,
  payrollEligibleEmployeeWhere,
} from '../src/services/employee-payroll-eligibility.service.js';

const source = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const period = {
  startDate: new Date('2026-08-01T00:00:00.000Z'),
  endDate: new Date('2026-08-31T00:00:00.000Z'),
};

const employee = (over: Partial<{
  status: EmployeeStatus;
  startDate: Date;
  endDate: Date | null;
  reactivatedAt: Date | null;
}> = {}) => ({
  status: EmployeeStatus.ACTIVE,
  startDate: new Date('2020-01-01T00:00:00.000Z'),
  endDate: null,
  reactivatedAt: null,
  ...over,
});

// ---------------------------------------------------------------------------
// Restoring an employee
// ---------------------------------------------------------------------------

describe('effective employment start', () => {
  it('is the hire date for someone who never left', () => {
    expect(effectiveEmploymentStart(employee())).toEqual(new Date('2020-01-01T00:00:00.000Z'));
  });

  it('is the return date for someone who was brought back', () => {
    const reactivated = new Date('2026-08-15T00:00:00.000Z');
    expect(effectiveEmploymentStart(employee({ reactivatedAt: reactivated }))).toEqual(reactivated);
  });

  it('ignores a reactivation date that predates the hire date', () => {
    // Defensive: a nonsensical stored value must not move the start backwards.
    expect(
      effectiveEmploymentStart(employee({ reactivatedAt: new Date('2019-01-01T00:00:00.000Z') }))
    ).toEqual(new Date('2020-01-01T00:00:00.000Z'));
  });
});

describe('a restored employee is not retroactively payable', () => {
  it('is eligible for a period that starts after their return', () => {
    expect(
      isEmployeeEligibleForPayrollPeriod(
        employee({ reactivatedAt: new Date('2026-08-01T00:00:00.000Z') }),
        period
      )
    ).toBe(true);
  });

  it('is eligible for the period their return falls inside', () => {
    expect(
      isEmployeeEligibleForPayrollPeriod(
        employee({ reactivatedAt: new Date('2026-08-15T00:00:00.000Z') }),
        period
      )
    ).toBe(true);
  });

  it('is NOT eligible for a period that closed before they came back', () => {
    // This is the whole point of the column. Clearing end_date on a restore
    // without recording where the new spell begins would make recalculating an
    // old month quietly pay them for time they did not work.
    expect(
      isEmployeeEligibleForPayrollPeriod(
        employee({ reactivatedAt: new Date('2026-09-01T00:00:00.000Z') }),
        period
      )
    ).toBe(false);
  });

  it('expresses the same rule in the database query', () => {
    const where = payrollEligibleEmployeeWhere(period) as {
      AND: { OR: Record<string, unknown>[] }[];
    };
    // Branch one: never reactivated, measured from the hire date.
    expect(where.AND[0].OR[0]).toEqual({ reactivatedAt: null, startDate: { lte: period.endDate } });
    // Branch two: reactivated, measured from the return date.
    expect(where.AND[0].OR[1]).toEqual({ reactivatedAt: { lte: period.endDate } });
  });
});

describe('restore service behaviour', () => {
  const svc = source('src/services/employee.service.ts');

  it('sets the employee back to ACTIVE', () => {
    expect(svc).toContain('status: EmployeeStatus.ACTIVE');
  });

  it('refuses to restore somebody who is already working', () => {
    expect(svc).toContain('พนักงานคนนี้ทำงานอยู่แล้ว');
  });

  it('requires the return date rather than defaulting to today', () => {
    const fn = svc.slice(svc.indexOf('export async function reactivateEmployee'));
    expect(fn).toContain('dayjs.utc(input.returnDate)');
    expect(fn).not.toMatch(/returnDate\s*\?\?\s*dayjs\.utc\(\)/);
  });

  it('rejects a return date before the original hire date', () => {
    expect(svc).toContain('วันที่กลับมาทำงานต้องไม่ก่อนวันที่เริ่มงานเดิม');
  });

  it('keeps the original hire date rather than overwriting it', () => {
    const fn = svc.slice(
      svc.indexOf('export async function reactivateEmployee'),
      svc.indexOf('/** Attendance totals')
    );
    // The update writes status, endDate and reactivatedAt - never startDate.
    expect(fn).not.toMatch(/data:\s*\{[\s\S]{0,400}startDate:/);
    expect(fn).toContain('reactivatedAt: returnDate.toDate()');
  });

  it('records the previous status and end date in the audit entry', () => {
    const fn = svc.slice(svc.indexOf('export async function reactivateEmployee'));
    expect(fn).toContain("action: 'EMPLOYEE_REACTIVATE'");
    expect(fn).toContain('status: current.status');
    expect(fn).toContain('endDate: current.endDate');
    expect(fn).toContain('originalStartDate');
  });
});

describe('the restore action is offered only where it makes sense', () => {
  const page = source('../frontend/src/pages/EmployeesPage.tsx');

  it('drives both status actions from one predicate', () => {
    // Deactivate shows when isWorking() is true and restore when it is false,
    // so a row can never display both - it is mutually exclusive by
    // construction rather than by two lists being kept in step.
    expect(page).toContain('const isWorking = (status: string): boolean =>');
    expect(page).toContain('canWrite && isWorking(employee.status) && (');
    expect(page).toContain('canWrite && !isWorking(employee.status) && (');
  });

  it('offers exactly one status action per row', () => {
    const deactivate = (page.match(/isWorking\(employee\.status\)/g) ?? []).length;
    // Two occurrences: the positive branch and the negated one.
    expect(deactivate).toBe(2);
    expect(page).toContain('ให้กลับมาทำงาน');
    expect(page).toContain('กำหนดว่าไม่ทำงานแล้ว');
  });

  it('offers add-workday regardless of employment status', () => {
    // A person's status today says nothing about whether a day they worked last
    // month needs recording, so this action is never gated on it.
    const addWorkday = page.slice(
      page.indexOf('aria-label="เพิ่มวันมาทำงาน"') - 600,
      page.indexOf('aria-label="เพิ่มวันมาทำงาน"')
    );
    expect(addWorkday).toContain('{canWrite && (');
    expect(addWorkday).not.toContain('ACTIVE_STATUSES.includes');
  });

  it('asks for a return date and shows the current status before restoring', () => {
    const dialog = source('../frontend/src/features/employees/RestoreEmployeeDialog.tsx');
    expect(dialog).toContain('ให้พนักงานกลับมาทำงาน?');
    expect(dialog).toContain('วันที่กลับมาทำงาน');
    expect(dialog).toContain('สถานะปัจจุบัน');
    expect(dialog).toContain('รหัสพนักงาน');
    // The date is required and starts empty rather than defaulting to today.
    expect(dialog).toContain("setReturnDate('')");
    expect(dialog).toContain('disabled={!returnDate || tooEarly}');
  });
});

describe('Google Sheets sync still cannot change HR status', () => {
  const sync = source('src/services/employee-sync.service.ts');

  it('never writes status onto an existing employee', () => {
    expect(sync).not.toContain('data.status = sheetOwned.status');
  });

  it('cannot undo a restore or a deactivation', () => {
    // The only status assignment left is the create branch's default.
    const assignments = sync.match(/status:\s*sheetOwned\.status/g) ?? [];
    expect(assignments).toHaveLength(1);
    expect(sync).toContain("status: sheetOwned.status ?? 'ACTIVE'");
  });
});

// ---------------------------------------------------------------------------
// Manual attendance
// ---------------------------------------------------------------------------

describe('manual attendance creation', () => {
  const svc = source('src/services/attendance.service.ts');
  const fn = svc.slice(svc.indexOf('export async function createManualAttendance'));

  it('marks the row as manually sourced', () => {
    expect(fn).toContain("source: 'MANUAL'");
  });

  it('derives the metrics rather than accepting them from the caller', () => {
    expect(fn).toContain('computeAttendanceMetrics(');
    expect(fn).toContain('workedMinutes: metrics.workedMinutes');
    expect(fn).toContain('lateMinutes: metrics.lateMinutes');
    expect(fn).toContain('otMinutes: metrics.otMinutes');
    expect(fn).toContain('status: metrics.status');
  });

  it('does not accept worked, late or OT minutes as input', () => {
    const schema = source('src/schemas/index.ts');
    const manual = schema.slice(
      schema.indexOf('export const manualAttendanceSchema'),
      schema.indexOf('export const workScheduleProfileSchema')
    );
    expect(manual).not.toContain('workedMinutes');
    expect(manual).not.toContain('lateMinutes');
    expect(manual).not.toContain('otMinutes');
  });

  it('refuses a second record for a day that already has one', () => {
    expect(fn).toContain('มีข้อมูลการลงเวลาของวันที่เลือกอยู่แล้ว');
    // The conflict carries the existing id so the UI can offer to open it.
    expect(fn).toContain('attendanceId: existing.id');
  });

  it('refuses a date inside a finalised payroll period', () => {
    expect(fn).toContain('FINALISED_PERIOD_STATUSES');
    expect(fn).toContain('ไม่สามารถเพิ่มข้อมูลการลงเวลาได้');
  });

  it('treats LOCKED as finalised', () => {
    expect(svc).toContain("const FINALISED_PERIOD_STATUSES = ['APPROVED', 'PAID', 'LOCKED'] as const");
  });

  it('refuses a future date', () => {
    expect(fn).toContain('ไม่สามารถบันทึกเวลาทำงานล่วงหน้าในอนาคตได้');
  });

  it('requires a reason', () => {
    expect(fn).toContain('กรุณาระบุเหตุผลอย่างน้อย 3 ตัวอักษร');
  });

  it('writes an audit entry naming the actor, the day and the punches', () => {
    expect(fn).toContain("action: 'ATTENDANCE_MANUAL_CREATE'");
    expect(fn).toContain('userId: actor.userId');
    expect(fn).toContain('checkIn: fmt(checkIn)');
    expect(fn).toContain('checkOut: fmt(checkOut)');
    expect(fn).toContain('reason,');
  });

  it('never writes to Google Sheets', () => {
    expect(fn).not.toMatch(/sheets\.|spreadsheets\.|googleapis/i);
    expect(fn).not.toContain('append');
  });

  it('lifts a prior suppression, since re-adding the day reverses the removal', () => {
    expect(fn).toContain('attendanceSuppression.deleteMany');
  });
});

describe('the manual attendance form asks only for observed facts', () => {
  const dialog = source('../frontend/src/features/employees/ManualAttendanceDialog.tsx');

  it('collects the date, the punches and a reason', () => {
    expect(dialog).toContain('วันที่');
    expect(dialog).toContain('เวลาเข้า');
    expect(dialog).toContain('เวลาออก');
    expect(dialog).toContain('เหตุผล / หมายเหตุ');
  });

  it('does not ask for derived values', () => {
    expect(dialog).not.toContain('workedMinutes');
    expect(dialog).not.toContain('lateMinutes');
    expect(dialog).not.toContain('otMinutes');
  });

  it('offers a route to the existing record when the day is a duplicate', () => {
    expect(dialog).toContain('ไปแก้ไขข้อมูลเดิม');
    expect(dialog).toContain('attendanceId');
  });

  it('shows the current status and the allowed range for a former employee', () => {
    expect(dialog).toContain('สถานะปัจจุบัน');
    expect(dialog).toContain('สามารถเพิ่มข้อมูลย้อนหลังได้เฉพาะวันที่อยู่ในช่วงที่พนักงานยังทำงาน');
  });

  it('bounds the date picker by the employment period', () => {
    expect(dialog).toContain('min={startIso || undefined}');
    expect(dialog).toContain('max={maxIso}');
    expect(dialog).toContain('วันที่เลือกอยู่นอกช่วงการทำงานของพนักงาน');
  });

  it('requires explicit confirmation when no end date is recorded', () => {
    // No end date means no boundary to check. The decision is put to the
    // operator rather than an end date being invented.
    expect(dialog).toContain('const needsConfirmation = !working && !endIso');
    expect(dialog).toContain('(!needsConfirmation || confirmed)');
  });
});

// ---------------------------------------------------------------------------
// Historical attendance for a former employee
// ---------------------------------------------------------------------------

describe('historical attendance is bounded by employment, not by status today', () => {
  const svc = source('src/services/attendance.service.ts');
  const fn = svc.slice(svc.indexOf('export async function createManualAttendance'));

  it('does not reject an entry because the employee is no longer active', () => {
    // Someone who resigned last week may still need a day from the week before
    // recording; refusing that would leave real worked time unpayable.
    expect(fn).not.toMatch(/status\s*!==\s*['"]ACTIVE['"]/);
    expect(fn).not.toContain("['ACTIVE', 'PROBATION'].includes");
  });

  it('rejects a date before the employee was hired', () => {
    expect(fn).toContain('วันที่ต้องไม่ก่อนวันเริ่มงานของพนักงาน');
    expect(fn).toContain('workDate < toUtcDateOnly(employee.startDate)');
  });

  it('rejects a date after the employee left', () => {
    expect(fn).toContain('employee.endDate && workDate > toUtcDateOnly(employee.endDate)');
    expect(fn).toContain('วันที่เลือกอยู่นอกช่วงการทำงานของพนักงาน');
  });

  it('allows a date inside the employment period for a former employee', () => {
    // The only date guards are: not in the future, not before the hire date,
    // not after the leaving date. Nothing consults the current status.
    const guards = fn.slice(0, fn.indexOf('const finalised'));
    expect(guards).toContain('ไม่สามารถบันทึกเวลาทำงานล่วงหน้าในอนาคตได้');
    expect(guards).toContain('employee.startDate');
    expect(guards).toContain('employee.endDate');
    expect(guards).not.toContain('employee.status');
  });

  it('does not invent an end date when none is recorded', () => {
    // The ambiguous case is left to the operator, with a mandatory reason and
    // an audit entry, rather than a fabricated boundary.
    expect(fn).not.toMatch(/endDate\s*=\s*(new Date|dayjs)/);
    expect(fn).toContain('no reliable boundary');
  });

  it('still loads the end date it needs to validate against', () => {
    expect(fn).toContain('endDate: true');
  });
});

// ---------------------------------------------------------------------------
// The frontend and the backend must agree on one route
// ---------------------------------------------------------------------------

describe('manual attendance route contract', () => {
  const routes = source('src/routes/employee.routes.ts');
  const endpoints = source('../frontend/src/services/endpoints.ts');

  /**
   * The path is shared by two methods on purpose: GET returns the employee's
   * attendance history, POST creates one day. Fastify routes on method + path,
   * so this is one REST resource rather than a collision - but a test that
   * searches for the path alone finds the GET first, hence the explicit anchor.
   */
  // The POST is the later of the two registrations on this path.
  const postBlock = routes.slice(routes.lastIndexOf("'/:id/attendance'"));

  it('registers the manual-attendance route as a POST on the employee resource', () => {
    expect(routes).toContain("'/:id/attendance'");
    expect(postBlock).toContain('createManualAttendance');
    // No competing endpoint elsewhere - one contract, one handler.
    const attendanceRoutes = source('src/routes/attendance.routes.ts');
    expect(attendanceRoutes).not.toContain("'/manual'");
  });

  it('keeps the GET history route on the same path intact', () => {
    // Both methods must remain registered: the history view reads through GET.
    const occurrences = (routes.match(/'\/:id\/attendance'/g) ?? []).length;
    expect(occurrences).toBe(2);
    expect(routes.slice(0, routes.lastIndexOf("'/:id/attendance'"))).toContain(
      'employeeAttendanceHistory'
    );
  });

  it('is the same path the frontend posts to', () => {
    // The registration is relative to the /api/employees prefix.
    expect(endpoints).toContain('api.post(`/api/employees/${id}/attendance`, data)');
  });

  it('posts only observed facts, never derived values', () => {
    const fn = endpoints.slice(
      endpoints.indexOf('createAttendance:'),
      endpoints.indexOf('createAttendance:') + 500
    );
    for (const field of ['workDate', 'checkIn', 'checkOut', 'reason', 'note']) {
      expect(fn).toContain(field);
    }
    for (const derived of ['workedMinutes', 'lateMinutes', 'otMinutes', 'status']) {
      expect(fn).not.toContain(derived);
    }
  });

  it('guards the route with the attendance write permission', () => {
    expect(postBlock.slice(0, 300)).toContain("app.requirePermission('attendance:write')");
  });

  it('returns a structured code the UI can branch on for a duplicate day', () => {
    const svc = source('src/services/attendance.service.ts');
    expect(svc).toContain("'ATTENDANCE_ALREADY_EXISTS'");
    expect(svc).toContain('มีข้อมูลการลงเวลาของวันที่เลือกอยู่แล้ว');
  });

  it('branches on the code rather than the message text', () => {
    const dialog = source('../frontend/src/features/employees/ManualAttendanceDialog.tsx');
    expect(dialog).toContain("apiErrorCode(err) === 'ATTENDANCE_ALREADY_EXISTS'");
  });
});

describe('infrastructure errors are not shown raw', () => {
  const api = source('../frontend/src/services/api.ts');
  const dialog = source('../frontend/src/features/employees/ManualAttendanceDialog.tsx');

  it('translates a missing route instead of printing the URL', () => {
    // The server answers ROUTE_NOT_FOUND with "POST /api/... not found", which
    // is accurate and useless to a payroll clerk.
    expect(api).toContain('ROUTE_NOT_FOUND:');
    expect(api).toContain('เซิร์ฟเวอร์ยังไม่รองรับคำสั่งนี้');
  });

  it('never falls through to a raw axios message', () => {
    expect(api).not.toContain('return error.message;');
    expect(api).toContain('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์');
  });

  it('heads the dialog error with an application message', () => {
    expect(dialog).toContain('ไม่สามารถบันทึกวันมาทำงานได้');
  });
});
