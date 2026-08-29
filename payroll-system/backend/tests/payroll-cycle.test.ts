import { describe, it, expect } from 'vitest';
import { cycleBounds, dayjs } from '../src/utils/datetime.js';
import { defaultPaymentDate, suggestPeriodBounds } from '../src/services/payroll.service.js';
import { DEFAULT_PAYROLL_SETTINGS } from '../src/config/payroll-defaults.js';

/**
 * The company runs a 26 -> 25 payroll cycle, but the rule lives entirely in
 * settings. These tests pin both the default behaviour and the fact that any
 * other cycle is expressible without a code change.
 */

const fmt = (d: Date) => dayjs.utc(d).format('YYYY-MM-DD');

describe('default 26 -> 25 cycle', () => {
  it('runs September 2026 from 26 Aug to 25 Sep', () => {
    const b = cycleBounds(2026, 9, 26, 25);
    expect(fmt(b.startDate)).toBe('2026-08-26');
    expect(fmt(b.endDate)).toBe('2026-09-25');
  });

  it('crosses the year boundary for January', () => {
    const b = cycleBounds(2027, 1, 26, 25);
    expect(fmt(b.startDate)).toBe('2026-12-26');
    expect(fmt(b.endDate)).toBe('2027-01-25');
  });

  it('handles the February period, which opens in January', () => {
    const b = cycleBounds(2026, 2, 26, 25);
    expect(fmt(b.startDate)).toBe('2026-01-26');
    expect(fmt(b.endDate)).toBe('2026-02-25');
  });

  it('produces contiguous, non-overlapping consecutive periods', () => {
    const sep = cycleBounds(2026, 9, 26, 25);
    const oct = cycleBounds(2026, 10, 26, 25);
    // October opens the day after September closes.
    expect(fmt(oct.startDate)).toBe('2026-09-26');
    expect(dayjs.utc(oct.startDate).diff(dayjs.utc(sep.endDate), 'day')).toBe(1);
  });

  it('covers every month of a year without gaps', () => {
    for (let m = 1; m <= 11; m += 1) {
      const current = cycleBounds(2026, m, 26, 25);
      const next = cycleBounds(2026, m + 1, 26, 25);
      expect(dayjs.utc(next.startDate).diff(dayjs.utc(current.endDate), 'day'), `month ${m}`).toBe(1);
    }
  });
});

describe('configurable cycle', () => {
  it('supports a plain calendar month with 1 -> 31', () => {
    const b = cycleBounds(2026, 9, 1, 31);
    expect(fmt(b.startDate)).toBe('2026-09-01');
    expect(fmt(b.endDate)).toBe('2026-09-30');
  });

  it('treats endDay 0 as the last day of the month', () => {
    expect(fmt(cycleBounds(2026, 2, 1, 0).endDate)).toBe('2026-02-28');
    expect(fmt(cycleBounds(2028, 2, 1, 0).endDate)).toBe('2028-02-29');
  });

  it('supports a 16 -> 15 cycle', () => {
    const b = cycleBounds(2026, 9, 16, 15);
    expect(fmt(b.startDate)).toBe('2026-08-16');
    expect(fmt(b.endDate)).toBe('2026-09-15');
  });

  it('supports a 21 -> 20 cycle', () => {
    const b = cycleBounds(2027, 3, 21, 20);
    expect(fmt(b.startDate)).toBe('2027-02-21');
    expect(fmt(b.endDate)).toBe('2027-03-20');
  });

  it('clamps a start day past the end of a short month', () => {
    // 31 Feb does not exist; the cycle opens on the last day of February.
    const b = cycleBounds(2026, 3, 31, 30);
    expect(fmt(b.startDate)).toBe('2026-02-28');
  });

  it('clamps an end day past the end of the month', () => {
    expect(fmt(cycleBounds(2026, 4, 26, 31).endDate)).toBe('2026-04-30');
  });

  it('handles a leap-year February start', () => {
    const b = cycleBounds(2028, 3, 29, 28);
    expect(fmt(b.startDate)).toBe('2028-02-29');
    expect(fmt(b.endDate)).toBe('2028-03-28');
  });
});

describe('default payment date', () => {
  // Regression: this was previously derived from the period START, which on a
  // 26 -> 25 cycle produced a September payroll paying on 25 August — before
  // the period had even finished.
  it('falls in the month the cycle CLOSES in, never before the period ends', () => {
    const sep = cycleBounds(2026, 9, 26, 25); // 2026-08-26 -> 2026-09-25
    const pay = defaultPaymentDate(sep.endDate, 28);
    expect(fmt(pay)).toBe('2026-09-28');
    expect(dayjs.utc(pay).isAfter(dayjs.utc(sep.endDate))).toBe(true);
    expect(dayjs.utc(pay).isAfter(dayjs.utc(sep.startDate))).toBe(true);
  });

  it('never precedes the period end for any month on the default cycle', () => {
    for (let m = 1; m <= 12; m += 1) {
      const b = cycleBounds(2026, m, 26, 25);
      const pay = defaultPaymentDate(b.endDate, 28);
      expect(
        dayjs.utc(pay).isSame(dayjs.utc(b.endDate)) || dayjs.utc(pay).isAfter(dayjs.utc(b.endDate)),
        `month ${m}: pay ${fmt(pay)} vs end ${fmt(b.endDate)}`
      ).toBe(true);
    }
  });

  it('clamps a pay day past the end of a short month', () => {
    const feb = cycleBounds(2026, 2, 1, 0); // full February
    expect(fmt(defaultPaymentDate(feb.endDate, 31))).toBe('2026-02-28');
  });

  it('works for a plain calendar-month cycle', () => {
    const b = cycleBounds(2026, 9, 1, 31);
    expect(fmt(defaultPaymentDate(b.endDate, 28))).toBe('2026-09-28');
  });
});

describe('the cycle is configuration, not code', () => {
  it('ships both cycle days as editable settings', () => {
    const keys = DEFAULT_PAYROLL_SETTINGS.map((s) => s.key);
    expect(keys).toContain('PAYROLL_CYCLE_START_DAY');
    expect(keys).toContain('PAYROLL_CYCLE_END_DAY');
  });

  it('defaults to the company 26 -> 25 cycle', () => {
    const start = DEFAULT_PAYROLL_SETTINGS.find((s) => s.key === 'PAYROLL_CYCLE_START_DAY');
    const end = DEFAULT_PAYROLL_SETTINGS.find((s) => s.key === 'PAYROLL_CYCLE_END_DAY');
    expect(start?.value).toBe('26');
    expect(end?.value).toBe('25');
  });

  it('exposes the same computation the API suggests to the UI', () => {
    const viaService = suggestPeriodBounds(2026, 9, 26, 25);
    const viaUtil = cycleBounds(2026, 9, 26, 25);
    expect(fmt(viaService.startDate)).toBe(fmt(viaUtil.startDate));
    expect(fmt(viaService.endDate)).toBe(fmt(viaUtil.endDate));
  });
});
