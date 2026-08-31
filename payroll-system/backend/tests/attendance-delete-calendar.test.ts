import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { deleteAttendanceSchema } from '../src/schemas/index.js';

/**
 * Attendance deletion and the calendar day view.
 *
 * The delete path is deliberately not exercised against the live database:
 * removing a real workday is destructive and needs explicit approval. What is
 * asserted here is the contract around it - the mandatory reason, the
 * suppression rule that stops a read-only Google Sheet re-importing a deleted
 * day, the audit actions, and the pure summary/late/leave selection rules that
 * drive the calendar.
 */

const BACKEND = path.resolve(__dirname, '..');
const FRONTEND = path.resolve(__dirname, '../../frontend');
const readBackend = (p: string) => fs.readFileSync(path.join(BACKEND, p), 'utf8');
const readFrontend = (p: string) => fs.readFileSync(path.join(FRONTEND, p), 'utf8');

// ---------------------------------------------------------------------------
// The delete reason is not optional
// ---------------------------------------------------------------------------

describe('a deletion must carry a reason', () => {
  it('rejects a missing reason', () => {
    expect(deleteAttendanceSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an empty or whitespace-only reason', () => {
    expect(deleteAttendanceSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(deleteAttendanceSchema.safeParse({ reason: '   ' }).success).toBe(false);
  });

  it('rejects a reason too short to mean anything', () => {
    expect(deleteAttendanceSchema.safeParse({ reason: 'x' }).success).toBe(false);
  });

  it('accepts a real reason and trims it', () => {
    const parsed = deleteAttendanceSchema.safeParse({ reason: '  สแกนผิดวัน  ' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.reason).toBe('สแกนผิดวัน');
  });

  it('bounds the reason so it cannot overflow the column', () => {
    expect(deleteAttendanceSchema.safeParse({ reason: 'ก'.repeat(501) }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suppression: the sheet is read-only, so a delete must be remembered
// ---------------------------------------------------------------------------

describe('suppression stops a deleted day being re-imported', () => {
  const schema = readBackend('prisma/schema.prisma');
  const sync = readBackend('src/services/google-sheets.service.ts');
  const service = readBackend('src/services/attendance.service.ts');

  it('models a suppression uniquely per employee and workday', () => {
    expect(schema).toContain('model AttendanceSuppression');
    expect(schema).toMatch(/@@unique\(\[employeeId, workDate\]/);
  });

  it('keeps the previous punches on the suppression for audit', () => {
    expect(schema).toContain('previousCheckIn');
    expect(schema).toContain('previousCheckOut');
  });

  it('makes the sync consult suppressions before importing', () => {
    expect(sync).toContain('attendanceSuppression.findMany');
    expect(sync).toContain('suppressed.has(dayKey)');
  });

  it('reports a skipped day as SUPPRESSED rather than silently dropping it', () => {
    expect(sync).toContain("| 'SUPPRESSED'");
    expect(sync).toContain("action: 'SUPPRESSED'");
    expect(sync).toContain('SUPPRESSED: suppressedCount');
  });

  it('counts suppressed days separately from locked ones', () => {
    // Conflating them would report a deliberate deletion as a locked period.
    expect(sync).toContain('let suppressedCount = 0;');
    expect(sync).not.toMatch(/if \(suppressed\.has\(dayKey\)\) \{\s*skipped \+= 1;/);
  });

  it('writes the suppression in the same transaction as the delete', () => {
    expect(service).toContain('prisma.$transaction');
    expect(service).toContain('attendanceSuppression.upsert');
    expect(service).toContain('attendanceRecord.delete');
  });

  it('restores by removing the suppression, not by re-inserting attendance', () => {
    expect(service).toContain('export async function restoreAttendance');
    expect(service).toContain('attendanceSuppression.delete');
  });
});

// ---------------------------------------------------------------------------
// Protection and audit
// ---------------------------------------------------------------------------

describe('deletion is refused over finalised payroll', () => {
  const service = readBackend('src/services/attendance.service.ts');

  it('refuses a locked attendance row', () => {
    expect(service).toContain('รอบเงินเดือนถูกล็อกแล้ว');
  });

  it('also refuses APPROVED and PAID periods, not just LOCKED', () => {
    expect(service).toContain("const FINALISED_PERIOD_STATUSES = ['APPROVED', 'PAID', 'LOCKED']");
  });
});

describe('deletion and restore are audited', () => {
  const service = readBackend('src/services/attendance.service.ts');

  it('records ATTENDANCE_DELETE with the reason and the previous punches', () => {
    expect(service).toContain("action: 'ATTENDANCE_DELETE'");
    expect(service).toContain('oldValue: snapshot');
    expect(service).toMatch(/reason,\s*\n\s*userId: actor\.userId/);
  });

  it('records ATTENDANCE_RESTORE', () => {
    expect(service).toContain("action: 'ATTENDANCE_RESTORE'");
  });

  it('keeps raw source events - only the effective record is removed', () => {
    // attendance_raw_data must never be touched by the delete path.
    const deleteBlock = service.slice(
      service.indexOf('export async function deleteAttendance'),
      service.indexOf('export async function restoreAttendance')
    );
    expect(deleteBlock).not.toContain('attendanceRawData.delete');
    expect(deleteBlock).not.toContain('attendanceRawData.deleteMany');
  });

  it('never writes to Google in the delete path', () => {
    const deleteBlock = service.slice(
      service.indexOf('export async function deleteAttendance'),
      service.indexOf('export async function restoreAttendance')
    );
    expect(deleteBlock).not.toMatch(/sheets\.|values\.update|values\.append|batchUpdate/);
  });
});

// ---------------------------------------------------------------------------
// Calendar: summary source, identity and selection rules
// ---------------------------------------------------------------------------

/** Mirrors the selection the service applies to an archived raw event. */
const isCheckoutEvent = (payload: { type?: string }) =>
  String(payload.type ?? '').toLowerCase().replace(/[\s_-]/g, '').includes('out');

describe('checkout summary selection', () => {
  it('takes summaries from checkout events', () => {
    expect(isCheckoutEvent({ type: 'checkout' })).toBe(true);
    expect(isCheckoutEvent({ type: 'CHECK_OUT' })).toBe(true);
    expect(isCheckoutEvent({ type: 'clock out' })).toBe(true);
  });

  it('ignores check-in events', () => {
    expect(isCheckoutEvent({ type: 'checkin' })).toBe(false);
    expect(isCheckoutEvent({ type: 'clock_in' })).toBe(false);
    expect(isCheckoutEvent({})).toBe(false);
  });

  it('derives summaries from archived raw events rather than a new store', () => {
    const service = readBackend('src/services/attendance.service.ts');
    expect(service).toContain('prisma.attendanceRawData.findMany');
    // No separate calendar table exists in the schema.
    expect(readBackend('prisma/schema.prisma')).not.toContain('model CalendarSummary');
  });

  it('deduplicates by the source event identity so a re-sync cannot double up', () => {
    const service = readBackend('src/services/attendance.service.ts');
    expect(service).toContain('clientRequestId');
    expect(service).toContain('seenIdentity');
  });

  it('keeps two genuinely different summaries on one day, with their own times', () => {
    const service = readBackend('src/services/attendance.service.ts');
    // Only identical text for the same employee-day is collapsed.
    expect(service).toContain('e.employeeCode === row.employeeCode && e.text === text');
    expect(service).toContain('checkOutTime');
  });

  it('never rewrites the employee text', () => {
    const service = readBackend('src/services/attendance.service.ts');
    // Trimmed for emptiness checks only; no truncation or normalisation.
    expect(service).not.toMatch(/summary[^\n]*\.slice\(0,\s*\d+\)/);
  });
});

describe('late and leave selection for the calendar', () => {
  const service = readBackend('src/services/attendance.service.ts');
  const dayDetail = service.slice(
    service.indexOf('export async function getCalendarDayDetail'),
    service.indexOf('export async function getWorkCalendar')
  );

  it('counts only MONTHLY employees as late', () => {
    expect(dayDetail).toContain("r.employee.employmentType === 'MONTHLY'");
  });

  it('excludes exempt executives from the late list', () => {
    expect(dayDetail).toContain('attendanceRequired: true');
  });

  it('counts only APPROVED leave', () => {
    expect(dayDetail).toContain("status: 'APPROVED'");
  });

  it('excludes leave-exempt employees', () => {
    expect(dayDetail).toContain('leaveTrackingRequired: true');
  });

  it('applies the same MONTHLY and exemption filters to the month counts', () => {
    const monthly = service.slice(service.indexOf('export async function getWorkCalendar'));
    expect(monthly).toContain("employmentType: 'MONTHLY'");
    expect(monthly).toContain('attendanceRequired: true');
    expect(monthly).toContain('lateMinutes: { gt: 0 }');
  });

  it('returns counts on the month and full text only on the day endpoint', () => {
    const monthly = service.slice(service.indexOf('export async function getWorkCalendar'));
    expect(monthly).toContain('summaryCount');
    expect(monthly).toContain('lateCount');
    expect(monthly).toContain('leaveCount');
    expect(monthly).toContain('hasActivity');
  });

  it('excludes a suppressed day from the counts but keeps its summary for audit', () => {
    expect(dayDetail).toContain('suppressedSummaries');
    expect(dayDetail).toContain('summaries.filter((s) => !s.suppressed)');
  });
});

// ---------------------------------------------------------------------------
// Frontend wiring
// ---------------------------------------------------------------------------

describe('attendance table and calendar UI', () => {
  const page = readFrontend('src/pages/AttendancePage.tsx');

  it('offers both an edit and a delete action with tooltips', () => {
    expect(page).toContain('aria-label="แก้ไข"');
    expect(page).toContain('aria-label="ลบ"');
    expect(page).toContain('title="แก้ไข"');
    expect(page).toContain('title="ลบ"');
    expect(page).toContain('Trash2');
  });

  it('confirms a deletion and states that Google Sheet data survives', () => {
    expect(page).toContain('ลบบันทึกการลงเวลา?');
    expect(page).toContain('จะไม่ลบข้อมูลต้นทางใน Google Sheet');
  });

  it('requires a reason before the delete request is sent', () => {
    expect(page).toContain('เหตุผลในการลบ');
    expect(page).toContain('reason.trim().length < 3');
  });

  it('makes calendar days clickable and shows compact activity counters', () => {
    expect(page).toContain('ดูรายละเอียดวันที่');
    expect(page).toContain('📝');
    expect(page).toContain('🟡 สาย');
    expect(page).toContain('🔴 ลา');
  });

  it('renders the three day-detail sections with empty states', () => {
    expect(page).toContain('สรุปงานพนักงาน');
    expect(page).toContain('พนักงานมาสาย');
    expect(page).toContain('พนักงานลา');
    expect(page).toContain('ไม่มีสรุปงาน');
    expect(page).toContain('ไม่มีพนักงานมาสาย');
    expect(page).toContain('ไม่มีพนักงานลา');
  });

  it('styles late yellow and leave red', () => {
    expect(page).toContain('border-warning/30 bg-warning-soft');
    expect(page).toContain('border-danger/30 bg-danger-soft');
  });

  it('preserves employee line breaks rather than collapsing the text', () => {
    expect(page).toContain('whitespace-pre-wrap');
  });

  it('shows each employee summary as its own card, not one paragraph', () => {
    expect(page).toContain('detail.summaries.map');
    expect(page).toContain('พนักงานส่งสรุปงาน');
  });

  it('never calls Google from the browser', () => {
    expect(page).not.toMatch(/googleapis|sheets\.googleapis/);
  });
});
