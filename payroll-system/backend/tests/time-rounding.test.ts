import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { EmploymentType, PayType, Prisma, type EmployeePayProfile } from '@prisma/client';
import {
  DEFAULT_WORK_TIME_POLICY,
  calculateRoundedWorkTime,
  chargeableLateHours,
  floorToInterval,
  roundDownMinutes,
  roundingIntervalMinutes,
  workTimePolicy,
} from '../src/utils/time-rounding.js';
import { computeDailyEarnings } from '../src/services/daily-earnings.service.js';
import { computeAttendanceMetrics } from '../src/services/attendance.service.js';
import { PayrollSettings } from '../src/services/settings.service.js';
import { DEFAULT_SETTINGS_MAP } from '../src/config/payroll-defaults.js';

/**
 * The two DAILY wage rules, pinned to the worked examples the business stated.
 *
 * Both are easy to get subtly wrong and impossible to notice afterwards: a
 * round-to-nearest instead of a floor overpays a few baht a day, and a
 * greater-than-or-equal threshold takes an hour off a shift that was exactly
 * eight hours long.
 */

const settings = (overrides: Record<string, string> = {}) =>
  new PayrollSettings({ ...DEFAULT_SETTINGS_MAP, ...overrides });

// ---------------------------------------------------------------------------
// The 15-minute floor
// ---------------------------------------------------------------------------

describe('payable minutes are always floored, never rounded', () => {
  const cases: [number, number][] = [
    [0, 0],
    [1, 0],
    [14, 0],
    [15, 15],
    [29, 15],
    [30, 30],
    [31, 30],
    [44, 30],
    [45, 45],
    [46, 45],
    [59, 45],
    [60, 60],
    [61, 60],
    [74, 60],
    [75, 75],
  ];

  it.each(cases)('floors %d minutes to %d', (input, expected) => {
    expect(floorToInterval(input, 15)).toBe(expected);
  });

  it('never rounds up, not even one minute short of the next increment', () => {
    // 44 must not become 45, and 59 must not become 60. Paying for time not
    // worked is not a rounding error the company agreed to.
    expect(floorToInterval(44, 15)).toBe(30);
    expect(floorToInterval(59, 15)).toBe(45);
    expect(floorToInterval(89, 15)).toBe(75);
  });

  it('never rounds to nearest', () => {
    // Nearest-rounding would send 46 to 45 but 44 to 45 as well; floor sends
    // 44 to 30. This is what separates the two behaviours.
    expect(floorToInterval(44, 15)).not.toBe(45);
  });

  it('treats a non-positive increment as no rounding rather than dividing by zero', () => {
    expect(floorToInterval(44, 0)).toBe(44);
    expect(floorToInterval(44, -15)).toBe(44);
  });

  it('never returns a negative or fractional result', () => {
    expect(floorToInterval(-10, 15)).toBe(0);
    expect(floorToInterval(Number.NaN, 15)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The eight-hour break
// ---------------------------------------------------------------------------

describe('the unpaid break applies only past eight hours', () => {
  const at = (minutes: number) => calculateRoundedWorkTime(minutes);

  it('takes nothing from a day of exactly eight hours', () => {
    // Strictly greater than. 480 exactly keeps every minute.
    const result = at(480);
    expect(result.breakDeductionMinutes).toBe(0);
    expect(result.minutesBeforeRounding).toBe(480);
    expect(result.payableMinutes).toBe(480);
  });

  it('takes the full hour from a day one minute longer', () => {
    const result = at(481);
    expect(result.breakDeductionMinutes).toBe(60);
    expect(result.minutesBeforeRounding).toBe(421);
    expect(result.payableMinutes).toBe(420);
  });

  it.each([
    [480, 0, 480, 480],
    [481, 60, 421, 420],
    [490, 60, 430, 420],
    [524, 60, 464, 450],
    [525, 60, 465, 465],
    [542, 60, 482, 480],
    [600, 60, 540, 540],
  ])(
    'worked %d -> break %d, net %d, payable %d',
    (worked, brk, net, payable) => {
      const result = at(worked);
      expect(result.breakDeductionMinutes).toBe(brk);
      expect(result.minutesBeforeRounding).toBe(net);
      expect(result.payableMinutes).toBe(payable);
    }
  );

  it('takes nothing from a short day', () => {
    for (const minutes of [0, 60, 300, 479]) {
      expect(at(minutes).breakDeductionMinutes).toBe(0);
    }
  });

  it('reports the observed duration back unchanged', () => {
    // The helper derives; it never rewrites what was observed.
    expect(at(524).actualMinutes).toBe(524);
    expect(at(481).actualMinutes).toBe(481);
  });

  it('never produces negative payable time when the break exceeds the day', () => {
    const result = calculateRoundedWorkTime(490, {
      roundingMinutes: 15,
      breakThresholdMinutes: 60,
      breakDeductionMinutes: 600,
    });
    expect(result.minutesBeforeRounding).toBe(0);
    expect(result.payableMinutes).toBe(0);
  });
});

describe('the break is deducted before the floor, not after', () => {
  it('gives a different answer than flooring first would', () => {
    // 542 worked. Break first: 542 - 60 = 482, floored to 480.
    // Floor first:  542 floors to 540, minus 60 = 480 - the same here...
    const result = calculateRoundedWorkTime(542);
    expect(result.payableMinutes).toBe(480);

    // ...but 524 separates them. Break first: 464 floored to 450.
    // Floor first: 520 - 60 = 460, which is not a 15-minute multiple at all.
    const edge = calculateRoundedWorkTime(524);
    expect(edge.minutesBeforeRounding).toBe(464);
    expect(edge.payableMinutes).toBe(450);
    expect(edge.payableMinutes % 15).toBe(0);
  });

  it('always yields a whole number of increments', () => {
    for (let minutes = 0; minutes <= 720; minutes += 7) {
      expect(calculateRoundedWorkTime(minutes).payableMinutes % 15).toBe(0);
    }
  });

  it('never pays for more time than was worked', () => {
    for (let minutes = 0; minutes <= 720; minutes += 3) {
      const result = calculateRoundedWorkTime(minutes);
      expect(result.payableMinutes).toBeLessThanOrEqual(minutes);
    }
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('the policy is configurable and defaults to the company rule', () => {
  it('reads the company defaults', () => {
    expect(workTimePolicy(settings())).toEqual(DEFAULT_WORK_TIME_POLICY);
    expect(DEFAULT_WORK_TIME_POLICY).toEqual({
      roundingMinutes: 15,
      breakThresholdMinutes: 480,
      breakDeductionMinutes: 60,
    });
  });

  it('honours a reconfigured increment, threshold and deduction', () => {
    const policy = workTimePolicy(
      settings({
        TIME_ROUNDING_MINUTES: '30',
        DAILY_BREAK_THRESHOLD_MINUTES: '360',
        DAILY_BREAK_DEDUCTION_MINUTES: '45',
      })
    );
    expect(policy).toEqual({
      roundingMinutes: 30,
      breakThresholdMinutes: 360,
      breakDeductionMinutes: 45,
    });
    // 400 worked, over the 360 threshold: 400 - 45 = 355, floored to 330.
    expect(calculateRoundedWorkTime(400, policy).payableMinutes).toBe(330);
  });

  it('falls back rather than silently disabling rounding', () => {
    // A zero increment is not a rule anyone stated; paying to the minute by
    // accident would quietly overpay every day.
    expect(workTimePolicy(settings({ TIME_ROUNDING_MINUTES: '0' })).roundingMinutes)
      .toBe(15);
    expect(
      workTimePolicy(settings({ TIME_ROUNDING_MINUTES: 'abc' })).roundingMinutes
    ).toBe(15);
  });

  it('allows the break to be switched off explicitly', () => {
    const policy = workTimePolicy(settings({ DAILY_BREAK_DEDUCTION_MINUTES: '0' }));
    expect(calculateRoundedWorkTime(600, policy).breakDeductionMinutes).toBe(0);
    expect(calculateRoundedWorkTime(600, policy).payableMinutes).toBe(600);
  });

  it('keeps one authoritative break rule', () => {
    // The old attendance-level flag is withdrawn; the payroll helper owns it.
    const defaults = DEFAULT_SETTINGS_MAP;
    expect(defaults.DAILY_DEDUCT_BREAK).toBe('false');
    expect(defaults.DAILY_BREAK_THRESHOLD_MINUTES).toBe('480');
    expect(defaults.DAILY_BREAK_DEDUCTION_MINUTES).toBe('60');
    expect(defaults.TIME_ROUNDING_MINUTES).toBe('15');
  });
});

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

const profile = (rate: string): EmployeePayProfile =>
  ({
    id: 'p1',
    employeeId: 'e1',
    payType: PayType.HOURLY,
    monthlySalary: null,
    hourlyRate: new Prisma.Decimal(rate),
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveTo: null,
    isActive: true,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as EmployeePayProfile;

const day = (workedMinutes: number) => ({
  workDate: new Date('2026-08-03T00:00:00.000Z'),
  checkIn: null,
  checkOut: null,
  workedMinutes,
  status: 'NORMAL',
});

describe('DAILY pay is priced from payable minutes', () => {
  it.each([
    [480, '600.00'],
    [481, '525.00'],
    [524, '562.50'],
    [600, '675.00'],
  ])('worked %d at 75 THB/h pays %s', (worked, expected) => {
    const summary = computeDailyEarnings([day(worked)], [profile('75')]);
    expect(summary.totalAmount.toFixed(2)).toBe(expected);
  });

  it('reports worked, break and payable minutes separately on each row', () => {
    const summary = computeDailyEarnings([day(524)], [profile('75')]);
    const row = summary.rows[0];
    expect(row.workedMinutes).toBe(524);
    expect(row.breakDeductionMinutes).toBe(60);
    expect(row.minutesBeforeRounding).toBe(464);
    expect(row.payableMinutes).toBe(450);
    expect(row.amount.toFixed(2)).toBe('562.50');
  });

  it('does not price from the unrounded worked minutes any more', () => {
    // 524/60 x 75 would be 655.00. The payable figure is 562.50.
    const summary = computeDailyEarnings([day(524)], [profile('75')]);
    expect(summary.totalAmount.toFixed(2)).not.toBe('655.00');
    expect(summary.totalAmount.toFixed(2)).toBe('562.50');
  });

  it('totals worked and payable minutes as distinct figures', () => {
    const summary = computeDailyEarnings([day(524), day(480)], [profile('75')]);
    expect(summary.totalWorkedMinutes).toBe(1004);
    expect(summary.totalBreakDeductionMinutes).toBe(60);
    expect(summary.totalPayableMinutes).toBe(930);
  });

  it('is exact on Decimal rather than drifting on floats', () => {
    // 450/60 x 82.50 = 618.75 exactly.
    const summary = computeDailyEarnings([day(524)], [profile('82.50')]);
    expect(summary.totalAmount.toFixed(2)).toBe('618.75');
  });
});

// ---------------------------------------------------------------------------
// Attendance data preservation, and MONTHLY exemption
// ---------------------------------------------------------------------------

describe('the attendance record keeps the true worked duration', () => {
  const at = (h: number, m: number) => new Date(Date.UTC(2026, 7, 3, h, m));
  const metrics = (checkIn: Date, checkOut: Date, type: EmploymentType, over: Record<string, string> = {}) =>
    computeAttendanceMetrics(
      {
        workDate: new Date(Date.UTC(2026, 7, 3)),
        checkIn,
        checkOut,
        isHoliday: false,
        isWeekend: false,
        isOnLeave: false,
        employmentType: type,
      },
      settings(over)
    );

  it('stores 524 minutes for an 08:30 to 17:14 DAILY shift', () => {
    // Payroll pays 450 of them; the record still says 524, because that is
    // what happened. Overwriting it would destroy the only copy.
    const result = metrics(at(8, 30), at(17, 14), EmploymentType.DAILY);
    expect(result.workedMinutes).toBe(524);
    expect(result.breakMinutes).toBe(0);
  });

  it('does not deduct a DAILY break even if the withdrawn flag is switched on', () => {
    const result = metrics(at(8, 30), at(17, 14), EmploymentType.DAILY, {
      DAILY_DEDUCT_BREAK: 'true',
    });
    expect(result.workedMinutes).toBe(524);
  });

  it('leaves the derived payable figure entirely outside the record', () => {
    const stored = metrics(at(8, 30), at(17, 14), EmploymentType.DAILY).workedMinutes;
    const derived = calculateRoundedWorkTime(stored);
    expect(stored).toBe(524);
    expect(derived.payableMinutes).toBe(450);
    // Deriving twice from the stored value is stable - it is not cumulative.
    expect(calculateRoundedWorkTime(stored).payableMinutes).toBe(450);
  });
});

describe('MONTHLY employees are untouched by both rules', () => {
  const at = (h: number, m: number) => new Date(Date.UTC(2026, 7, 3, h, m));
  const monthly = (checkIn: Date, checkOut: Date) =>
    computeAttendanceMetrics(
      {
        workDate: new Date(Date.UTC(2026, 7, 3)),
        checkIn,
        checkOut,
        isHoliday: false,
        isWeekend: false,
        isOnLeave: false,
        employmentType: EmploymentType.MONTHLY,
      },
      settings()
    );

  it('keeps the existing monthly break behaviour', () => {
    // Monthly staff have always had the configured break removed from a long
    // enough day, and that rule is deliberately unchanged.
    const result = monthly(at(8, 30), at(17, 14));
    expect(result.breakMinutes).toBe(60);
    expect(result.workedMinutes).toBe(464);
  });

  it('does not floor monthly worked time to 15 minutes', () => {
    // 464 is not a multiple of 15 and must stay as it is.
    expect(monthly(at(8, 30), at(17, 14)).workedMinutes % 15).not.toBe(0);
  });

  it('never routes a monthly day through the daily helper', () => {
    const valuation = readFileSync(
      new URL('../src/services/attendance-valuation.service.ts', import.meta.url),
      'utf8'
    );
    const monthlyFn = valuation.slice(
      valuation.indexOf('function valueMonthlyDay'),
      valuation.indexOf('/** Fixed company divisor')
    );
    // It may state zero for the two DAILY fields - that is how it declares the
    // rules do not apply - but it must never derive them.
    expect(monthlyFn).not.toContain('calculateDailyPayableMinutes');
    expect(monthlyFn).not.toContain('dailyPayableTimePolicy');
    expect(monthlyFn).toContain('payableMinutes: 0');
    expect(monthlyFn).toContain('breakDeductionMinutes: 0');
  });
});

// ---------------------------------------------------------------------------
// One source of truth
// ---------------------------------------------------------------------------

describe('the rules live in exactly one module', () => {
  const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

  it('is the only place the 15-minute floor is implemented', () => {
    const helper = read('src/utils/time-rounding.ts');
    expect(helper).toContain('Math.floor(minutes / interval) * interval');

    for (const file of [
      'src/services/daily-earnings.service.ts',
      'src/services/attendance-valuation.service.ts',
      'src/services/payroll-calculator.service.ts',
      'src/services/payroll-employee-context.service.ts',
      'src/services/payslip.service.ts',
    ]) {
      const source = read(file);
      expect(source, file).not.toMatch(/Math\.floor\([^)]*\/\s*15\s*\)/);
      expect(source, file).not.toMatch(/>\s*480/);
    }
  });

  it('is called by every DAILY money path', () => {
    expect(read('src/services/daily-earnings.service.ts')).toContain(
      'calculateRoundedWorkTime'
    );
    expect(read('src/services/attendance-valuation.service.ts')).toContain(
      'calculateRoundedWorkTime'
    );
    // Lateness, early leave and OT are floored on the same interval by the
    // payroll aggregation, so no caller invents a second rounding rule.
    expect(read('src/services/payroll.service.ts')).toContain('floorToInterval(');
    expect(read('src/services/payroll.service.ts')).toContain('roundingIntervalMinutes(');
    // The payroll run and the payslip read the figures the helper produced
    // rather than deriving their own.
    expect(read('src/services/payroll.service.ts')).toContain('totalPayableMinutes');
    expect(read('src/services/payslip.service.ts')).toContain('payableMinutes: row.payableMinutes');
  });
});

// ---------------------------------------------------------------------------
// One company-wide interval
// ---------------------------------------------------------------------------

describe('the interval is a single company-wide setting', () => {
  it('reads TIME_ROUNDING_MINUTES', () => {
    expect(roundingIntervalMinutes(settings())).toBe(15);
    expect(roundingIntervalMinutes(settings({ TIME_ROUNDING_MINUTES: '30' }))).toBe(30);
    expect(roundingIntervalMinutes(settings({ TIME_ROUNDING_MINUTES: '5' }))).toBe(5);
  });

  it('falls back rather than disabling rounding on a bad value', () => {
    for (const bad of ['0', '-15', 'abc', '']) {
      expect(roundingIntervalMinutes(settings({ TIME_ROUNDING_MINUTES: bad })), bad).toBe(15);
    }
  });

  it('no longer reads the superseded per-daily key', () => {
    // Two settings that could disagree about one rule is what the single
    // policy exists to prevent.
    const changed = settings({ DAILY_PAY_ROUNDING_MINUTES: '60' });
    expect(roundingIntervalMinutes(changed)).toBe(15);
    expect(workTimePolicy(changed).roundingMinutes).toBe(15);
  });

  it('drives the daily work-time policy from the same key', () => {
    const policy = workTimePolicy(settings({ TIME_ROUNDING_MINUTES: '30' }));
    expect(policy.roundingMinutes).toBe(30);
    // 628 - 60 break = 568, floored to 30 -> 540.
    expect(calculateRoundedWorkTime(628, policy).payableMinutes).toBe(540);
  });
});

describe('roundDownMinutes keeps the discarded remainder visible', () => {
  it.each([
    [1, 0, 1],
    [14, 0, 14],
    [15, 15, 0],
    [29, 15, 14],
    [30, 30, 0],
    [31, 30, 1],
    [44, 30, 14],
    [45, 45, 0],
    [46, 45, 1],
    [59, 45, 14],
    [60, 60, 0],
  ])('%d -> rounded %d, away %d', (actual, rounded, away) => {
    const result = roundDownMinutes(actual, 15);
    expect(result.actualMinutes).toBe(actual);
    expect(result.roundedMinutes).toBe(rounded);
    expect(result.roundedAwayMinutes).toBe(away);
  });

  it('always reconciles: actual = rounded + away', () => {
    for (let m = 0; m <= 600; m += 1) {
      const r = roundDownMinutes(m, 15);
      expect(r.roundedMinutes + r.roundedAwayMinutes).toBe(r.actualMinutes);
    }
  });
});

// ---------------------------------------------------------------------------
// Late: floor to the interval, then ceil to whole hours
// ---------------------------------------------------------------------------

describe('chargeable lateness applies the interval before the hour ceiling', () => {
  it.each([
    [10, 0],
    [16, 1],
    [59, 1],
    [61, 1],
    [76, 2],
  ])('%d observed late minutes charge %d hour(s)', (minutes, hours) => {
    expect(chargeableLateHours(minutes, 15)).toBe(hours);
  });

  it('forgives anything under one interval', () => {
    for (const minutes of [1, 5, 10, 14]) {
      expect(chargeableLateHours(minutes, 15), String(minutes)).toBe(0);
    }
  });

  it('differs from ceiling the raw minutes, which is the point', () => {
    // Ceiling 10 raw minutes would bill a whole hour; the interval forgives it.
    expect(Math.ceil(10 / 60)).toBe(1);
    expect(chargeableLateHours(10, 15)).toBe(0);
    // And 61 raw minutes would bill two hours; the floor pulls it back to one.
    expect(Math.ceil(61 / 60)).toBe(2);
    expect(chargeableLateHours(61, 15)).toBe(1);
  });

  it('never charges for zero or negative lateness', () => {
    expect(chargeableLateHours(0, 15)).toBe(0);
    expect(chargeableLateHours(-30, 15)).toBe(0);
  });

  it('follows a reconfigured interval', () => {
    // At 30-minute granularity, 29 minutes late is forgiven entirely.
    expect(chargeableLateHours(29, 30)).toBe(0);
    expect(chargeableLateHours(31, 30)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Money: sum precise, round once
// ---------------------------------------------------------------------------

describe('money is summed precisely and rounded once', () => {
  const rate = (r: string) =>
    ({
      id: 'p1', employeeId: 'e1', payType: PayType.HOURLY, monthlySalary: null,
      hourlyRate: new Prisma.Decimal(r), effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: null, isActive: true, createdBy: null, updatedBy: null,
      createdAt: new Date(), updatedAt: new Date(),
    }) as EmployeePayProfile;

  const shift = (date: string, minutes: number) => ({
    workDate: new Date(`${date}T00:00:00.000Z`),
    checkIn: null,
    checkOut: null,
    workedMinutes: minutes,
    status: 'NORMAL',
  });

  it('reproduces the 41h29 / 93.75 example exactly', () => {
    // Six days totalling 41h29m actual, two of them past eight hours so two
    // hours of break come out, and 59 minutes are floored away - leaving
    // 38h30m payable. 38.5 x 93.75 = 3,609.375 precisely, which rounds to
    // 3,609.38 and must not become 3,609.39 by summing rounded days.
    const days = [
      shift('2026-08-10', 628), // break 60 -> 568 -> 555, 13 away
      shift('2026-08-11', 568), // break 60 -> 508 -> 495, 13 away
      shift('2026-08-12', 314), //              314 -> 300, 14 away
      shift('2026-08-13', 349), //              349 -> 345,  4 away
      shift('2026-08-14', 322), //              322 -> 315,  7 away
      shift('2026-08-15', 308), //              308 -> 300,  8 away
    ];
    const summary = computeDailyEarnings(days, [rate('93.75')], DEFAULT_WORK_TIME_POLICY);

    expect(summary.totalWorkedMinutes).toBe(2489); // 41h29m
    expect(summary.totalBreakDeductionMinutes).toBe(120); // two long days
    expect(summary.totalRoundedAwayMinutes).toBe(59);
    expect(summary.totalPayableMinutes).toBe(2310); // 38h30m
    expect(summary.preciseTotal.toString()).toBe('3609.375');
    expect(summary.totalAmount.toFixed(2)).toBe('3609.38');
  });

  it('does not drift by summing already-rounded daily amounts', () => {
    const days = [shift('2026-08-01', 15), shift('2026-08-02', 15), shift('2026-08-03', 15)];
    const summary = computeDailyEarnings(days, [rate('93.75')], DEFAULT_WORK_TIME_POLICY);
    // Each day is 23.4375, which displays as 23.44. Three displayed days sum to
    // 70.32; the precise total is 70.3125, which rounds to 70.31.
    expect(summary.rows.every((r) => r.amount.toFixed(2) === '23.44')).toBe(true);
    expect(summary.preciseTotal.toString()).toBe('70.3125');
    expect(summary.totalAmount.toFixed(2)).toBe('70.31');
  });

  it('rounds the aggregate half-up, not away from it', () => {
    expect(new Prisma.Decimal('3609.375').toFixed(2)).not.toBe('3609.39');
  });
});
