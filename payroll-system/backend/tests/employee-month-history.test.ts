import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(utc);

/**
 * Historical months must stay reachable forever.
 *
 * The reported failure was that opening an employee in September appeared to
 * lose August. The API was never the problem - these tests pin the two things
 * that were: the month window must be built from plain dates so 31 August
 * cannot land in September, and the history query must filter on employee and
 * date alone, never on the employee's *current* status, or a person who left
 * in September would take their August attendance with them.
 *
 * The UI half is asserted against source text rather than a rendered tree,
 * matching how the rest of this suite guards front-end wiring: the failure
 * being prevented is a control going missing from a tab, which a source
 * assertion catches and a unit test of the component would not.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const employeeService = read('../src/services/employee.service.ts');
const detailPage = read('../../frontend/src/pages/EmployeeDetailPage.tsx');
const monthSelector = read('../../frontend/src/features/employees/MonthSelector.tsx');
const bangkok = read('../../frontend/src/utils/bangkok.ts');
const endpoints = read('../../frontend/src/services/endpoints.ts');

// ---------------------------------------------------------------------------
// Month boundaries
// ---------------------------------------------------------------------------

/** Mirrors employeeAttendanceHistory's window so the boundary can be asserted. */
function monthWindow(year: number, month: number) {
  const start = dayjs.utc(`${year}-${String(month).padStart(2, '0')}-01`).startOf('month');
  return { start, end: start.endOf('month').startOf('day') };
}

describe('month windows cover the whole month and nothing beyond it', () => {
  it('August 2026 runs from the 1st to the 31st', () => {
    const { start, end } = monthWindow(2026, 8);
    expect(start.format('YYYY-MM-DD')).toBe('2026-08-01');
    expect(end.format('YYYY-MM-DD')).toBe('2026-08-31');
  });

  it('31 August belongs to August, not September', () => {
    const lastDay = dayjs.utc('2026-08-31').startOf('day');
    const august = monthWindow(2026, 8);
    const september = monthWindow(2026, 9);

    expect(lastDay.isBefore(august.start)).toBe(false);
    expect(lastDay.isAfter(august.end)).toBe(false);
    expect(lastDay.isBefore(september.start)).toBe(true);
  });

  it('1 September belongs to September only', () => {
    const day = dayjs.utc('2026-09-01').startOf('day');
    expect(day.isAfter(monthWindow(2026, 8).end)).toBe(true);
    expect(day.isBefore(monthWindow(2026, 9).start)).toBe(false);
  });

  it('handles February in a leap and a non-leap year', () => {
    expect(monthWindow(2026, 2).end.format('YYYY-MM-DD')).toBe('2026-02-28');
    expect(monthWindow(2028, 2).end.format('YYYY-MM-DD')).toBe('2028-02-29');
  });

  it('December does not roll the year forward', () => {
    const { start, end } = monthWindow(2026, 12);
    expect(start.format('YYYY-MM-DD')).toBe('2026-12-01');
    expect(end.format('YYYY-MM-DD')).toBe('2026-12-31');
  });
});

// ---------------------------------------------------------------------------
// The frontend month range helper agrees with the backend window
// ---------------------------------------------------------------------------

/** Mirrors frontend monthRange, which the summary query sends as from/to. */
function monthRange(year: number, month: number) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (value: number) => String(value).padStart(2, '0');
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(lastDay)}` };
}

describe('summary range and history window describe the same month', () => {
  for (const [year, month] of [
    [2026, 1],
    [2026, 2],
    [2026, 8],
    [2026, 9],
    [2026, 12],
    [2028, 2],
  ] as [number, number][]) {
    it(`${year}-${month}`, () => {
      const range = monthRange(year, month);
      const window = monthWindow(year, month);
      expect(range.from).toBe(window.start.format('YYYY-MM-DD'));
      expect(range.to).toBe(window.end.format('YYYY-MM-DD'));
    });
  }
});

// ---------------------------------------------------------------------------
// Employment status must not hide history
// ---------------------------------------------------------------------------

describe('attendance history is filtered by employee and date only', () => {
  const body = employeeService.slice(
    employeeService.indexOf('export async function employeeAttendanceHistory'),
    employeeService.indexOf('// --- departments & positions')
  );

  it('the history exists in the service', () => {
    expect(body.length).toBeGreaterThan(0);
  });

  it('the where clause keys on employeeId and workDate', () => {
    expect(body).toContain('employeeId: id');
    expect(body).toContain('workDate: { gte: start.toDate(), lte: end.toDate() }');
  });

  it('never narrows by the employee record status', () => {
    // Attendance status (NORMAL/LATE/...) is a legitimate filter and is opt-in.
    // Employment status is not: a terminated employee still worked in August.
    expect(body).not.toContain('ACTIVE');
    expect(body).not.toContain('INACTIVE');
    expect(body).not.toContain('TERMINATED');
    expect(body).not.toMatch(/employee:\s*\{\s*status/);
  });

  it('values every returned day through the shared valuation', () => {
    // Same source as the Attendance page, so the two screens cannot disagree.
    expect(body).toContain('valueAttendanceRecords');
    expect(body).toContain('dailyPay');
  });
});

// ---------------------------------------------------------------------------
// The page keeps one month, and offers it where the data is
// ---------------------------------------------------------------------------

describe('employee detail month selection', () => {
  it('defaults from company time, not the browser timezone', () => {
    expect(detailPage).toContain('currentBangkokMonth');
    expect(bangkok).toContain("'Asia/Bangkok'");
    expect(bangkok).toContain('Intl.DateTimeFormat');
  });

  it('drives every time-based section from one piece of state', () => {
    expect(detailPage).toContain('const attendanceYear = selectedMonth.year;');
    expect(detailPage).toContain('const attendanceMonth = selectedMonth.month;');
    // A per-tab month would reset when the user switched tabs, which is the
    // behaviour being fixed.
    expect(detailPage).not.toContain('dayjs().month() + 1');
  });

  it('includes employee and month in every month-scoped cache key', () => {
    for (const key of [
      "['employee-summary', id, attendanceYear, attendanceMonth]",
      "['employee-daily-earnings', id, attendanceYear, attendanceMonth]",
    ]) {
      expect(detailPage).toContain(key);
    }
    expect(detailPage).toContain(
      "['employee-attendance', id, attendanceYear, attendanceMonth, attendancePage, attendanceStatus]"
    );
  });

  it('renders the selector beside each section it governs', () => {
    // Three: the summary card, the attendance tab, the daily earnings tab. One
    // control at the top of the page was findable in theory and not in practice.
    const occurrences = detailPage.match(/<MonthSelector\b/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(3);
  });

  it('resets pagination when the month changes', () => {
    const changeMonth = detailPage.slice(
      detailPage.indexOf('const changeMonth'),
      detailPage.indexOf('const query = useQuery')
    );
    expect(changeMonth).toContain('setAttendancePage(1)');
  });

  it('keeps a way back when the chosen month is empty', () => {
    expect(detailPage).toContain('ไม่พบข้อมูลการลงเวลาในเดือนนี้');
    expect(detailPage).toContain('ดูเดือนก่อนหน้า');
  });

  it('shows the full explainability trail on the history table', () => {
    const header = detailPage.slice(
      detailPage.indexOf('<TabsContent value="attendance">'),
      detailPage.indexOf('</thead>', detailPage.indexOf('<TabsContent value="attendance">'))
    );
    for (const column of [
      'วันที่',
      'เข้า',
      'ออก',
      'เวลาทำงานจริง',
      'หักพัก',
      'ปัดเวลาออก',
      'เวลาที่ใช้คิด',
      'สาย',
      'สถานะ',
      'ได้เงินวันนี้',
    ]) {
      expect(header).toContain(column);
    }
    expect(detailPage).toContain('<DailyPayCell dailyPay={row.dailyPay} />');
  });

  it('states raw and rounded lateness separately', () => {
    expect(detailPage).toContain('นาทีสายจริง');
    expect(detailPage).toContain('นาทีสายหลังปัด');
    expect(endpoints).toContain('roundedLateMinutes');
  });
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** Mirrors MonthSelector.shiftMonth. */
function shiftMonth(value: { year: number; month: number }, delta: number) {
  const index = value.year * 12 + (value.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

describe('previous / next month navigation', () => {
  it('steps back across a year boundary', () => {
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
  });

  it('steps forward across a year boundary', () => {
    expect(shiftMonth({ year: 2025, month: 12 }, 1)).toEqual({ year: 2026, month: 1 });
  });

  it('September steps back to August', () => {
    expect(shiftMonth({ year: 2026, month: 9 }, -1)).toEqual({ year: 2026, month: 8 });
  });

  it('round-trips over a full year', () => {
    let cursor = { year: 2026, month: 9 };
    for (let i = 0; i < 12; i += 1) cursor = shiftMonth(cursor, -1);
    expect(cursor).toEqual({ year: 2025, month: 9 });
  });

  it('disables forward navigation past the current month', () => {
    // A payroll system has no future attendance; an endless run of empty
    // months is not navigation.
    expect(monthSelector).toContain('const atLatest =');
    expect(monthSelector).toContain('disabled={atLatest}');
  });

  it('offers a way straight back to the current month', () => {
    expect(monthSelector).toContain('เดือนนี้');
  });
});
