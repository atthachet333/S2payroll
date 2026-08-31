import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS_MAP } from '../src/config/payroll-defaults.js';
import { PayrollSettings } from '../src/services/settings.service.js';
import { getDayType, isScheduledWorkday } from '../src/services/schedule-policy.service.js';
import { eachDay } from '../src/utils/datetime.js';

const settings = (overrides: Record<string, string> = {}) =>
  new PayrollSettings({ ...DEFAULT_SETTINGS_MAP, ...overrides });
const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('central Monday-Saturday schedule policy', () => {
  it('treats Monday through Saturday as working days and Sunday as weekly off', () => {
    for (const iso of ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29']) {
      expect(isScheduledWorkday(date(iso), settings())).toBe(true);
    }
    expect(isScheduledWorkday(date('2026-08-30'), settings())).toBe(false);
    expect(getDayType(date('2026-08-30'), settings(), new Set())).toBe('WEEKLY_OFF');
  });

  it('counts 26 scheduled days in August 2026 before configured holidays', () => {
    const days = eachDay(date('2026-08-01'), date('2026-08-31'));
    expect(days.filter((day) => isScheduledWorkday(day, settings())).length).toBe(26);
  });

  it('lets a configured company holiday override a scheduled workday', () => {
    expect(getDayType(date('2026-08-12'), settings(), new Set(['2026-08-12']))).toBe('HOLIDAY');
  });

  it('responds to a changed WORKING_DAYS setting', () => {
    const weekdaysOnly = settings({ WORKING_DAYS: 'MON,TUE,WED,THU,FRI' });
    expect(isScheduledWorkday(date('2026-08-29'), weekdaysOnly)).toBe(false);
  });
});

describe('calendar and Thai date UI wiring', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend', 'src');
  const attendancePage = fs.readFileSync(path.join(root, 'pages', 'AttendancePage.tsx'), 'utf8');
  const format = fs.readFileSync(path.join(root, 'utils', 'format.ts'), 'utf8');

  it('includes the work calendar tab and payroll period overlay', () => {
    expect(attendancePage).toContain('ปฏิทินการทำงาน');
    expect(attendancePage).toContain('อยู่ในรอบเงินเดือน');
  });

  it('formats dates with all Thai weekday abbreviations', () => {
    for (const label of ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.']) expect(format).toContain(label);
    expect(attendancePage).toContain('formatDateWithWeekday(record.workDate)');
  });
});
