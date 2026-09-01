import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Prisma } from '@prisma/client';
import { buildPayrollTrend } from '../src/services/dashboard.service.js';
import { computeDailyEarnings } from '../src/services/daily-earnings.service.js';
import { thaiMonthLabel, thaiMonthShortLabel } from '../src/utils/datetime.js';

const source = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// DAILY hourly rate: typed, not chosen from a list
// ---------------------------------------------------------------------------

/**
 * The rate whitelist was removed deliberately. Restricting DAILY wages to
 * 60/75/93/100 made the system unable to record rates the company actually
 * negotiates - 62, 82.50, 120 - so a validator refusing them was describing a
 * policy that does not exist. What is still enforced is that a wage is positive
 * money, because 0 is not a cheaper wage, it is the absence of one.
 */
describe('DAILY hourly rate accepts any positive money amount', () => {
  const svc = source('src/services/pay-profile.service.ts');

  it('no longer validates against a fixed list of rates', () => {
    expect(svc).not.toContain('assertAllowedDailyRate');
    expect(svc).not.toContain('dailyHourlyRateOptions');
    expect(svc).not.toContain('ต้องเลือกจาก');
  });

  it('validates that the amount is a real positive wage', () => {
    expect(svc).toContain('function assertUsableRate');
    expect(svc).toContain('lessThanOrEqualTo(0)');
    expect(svc).toContain('ต้องมากกว่า 0');
  });

  it('rejects more than two decimal places rather than rounding silently', () => {
    // Money is stored at two places; a third would vanish on write.
    expect(svc).toContain('decimalPlaces() > 2');
    expect(svc).toContain('ทศนิยมไม่เกิน 2 ตำแหน่ง');
  });

  it('runs the same check for monthly salaries, so neither side is weakened', () => {
    expect(svc).toContain('assertUsableRate(data)');
    expect(svc).toContain('data.payType === PayType.HOURLY ? data.hourlyRate : data.monthlySalary');
  });

  /** The rule the validator applies, exercised over the values that matter. */
  const usable = (raw: string) => {
    const amount = new Prisma.Decimal(raw);
    return amount.isFinite() && amount.greaterThan(0) && amount.decimalPlaces() <= 2;
  };

  it.each(['60', '75', '93', '100', '62', '82.50', '55.25', '120', '75.5'])(
    'accepts %s',
    (rate) => expect(usable(rate)).toBe(true)
  );

  it.each(['0', '0.00', '-1', '-82.50'])('rejects %s', (rate) =>
    expect(usable(rate)).toBe(false)
  );

  it('rejects a third decimal place', () => {
    expect(usable('82.505')).toBe(false);
  });
});

describe('the preset list is a convenience, not a gate', () => {
  const settings = source('src/config/payroll-defaults.ts');
  const routes = source('src/routes/settings.routes.ts');
  const field = source('../frontend/src/features/employees/PayrollSettingsFields.tsx');

  it('describes the setting as frequently-used rates', () => {
    expect(settings).toContain('อัตราค่าจ้างต่อชั่วโมงที่ใช้บ่อย (บาท)');
    expect(settings).toContain('ไม่ใช่ข้อจำกัด');
  });

  it('exposes the presets for the form to offer', () => {
    expect(routes).toContain('/daily-rate-presets');
    expect(routes).toContain('dailyHourlyRatePresets');
  });

  it('renders a typed money field, not a set of radio cards', () => {
    expect(field).toContain('export function validateHourlyRate');
    expect(field).toContain('type="number"');
    expect(field).toContain('step="0.01"');
    expect(field).toContain('อัตราที่ใช้บ่อย:');
    // The old radio-group markup is gone.
    expect(field).not.toContain('role="radiogroup"');
  });

  it('fills the input when a preset is clicked, leaving it editable', () => {
    expect(field).toContain('onClick={() => onChange(String(rate))}');
  });

  it('validates the typed amount to two decimal places', () => {
    expect(field).toContain('อัตราค่าจ้างต้องมากกว่า 0');
    expect(field).toContain('ทศนิยมไม่เกิน 2 ตำแหน่ง');
  });
});

describe('both edit screens write the same pay profile', () => {
  const editDialog = source('../frontend/src/features/employees/EmployeeFormDialog.tsx');
  const settingsPage = source('../frontend/src/pages/PayrollSettingsPage.tsx');

  it('Employee Edit uses the shared rate field and the shared presets', () => {
    expect(editDialog).toContain('<DailyRateSelector');
    expect(editDialog).toContain('presets={presetsQuery.data?.presets}');
    expect(editDialog).toContain('employeeApi.createPayProfile');
  });

  it('Payroll Settings uses the same field and the same endpoint', () => {
    expect(settingsPage).toContain('<DailyRateSelector');
    expect(settingsPage).toContain('presets={presetsQuery.data?.presets}');
    expect(settingsPage).toContain('employeeApi.createPayProfile');
  });

  it('both block a save while the typed rate is invalid', () => {
    expect(editDialog).toContain('validateHourlyRate(form.payProfileAmount)');
    expect(settingsPage).toContain('validateHourlyRate(amount)');
  });
});

describe('payroll prices a typed rate exactly', () => {
  const day = (date: string, workedMinutes: number) => ({
    workDate: new Date(`${date}T00:00:00.000Z`),
    checkIn: null,
    checkOut: null,
    workedMinutes,
    status: 'NORMAL',
  });
  const profile = (rate: string) =>
    ({
      id: 'p1',
      employeeId: 'e1',
      payType: 'HOURLY',
      monthlySalary: null,
      hourlyRate: new Prisma.Decimal(rate),
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: null,
      isActive: true,
      createdBy: null,
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as never;

  it('pays 82.50/hour for 90 minutes as exactly 123.75', () => {
    // The formula is unchanged: workedMinutes / 60 x rate, all on Decimal.
    const summary = computeDailyEarnings([day('2026-08-03', 90)], [profile('82.50')]);
    expect(summary.totalAmount.toFixed(2)).toBe('123.75');
  });

  it('is exact on a rate float arithmetic would round wrong', () => {
    // 35 worked minutes floor to 30 payable. 55.25 x 0.5 = 27.625 -> 27.63.
    const summary = computeDailyEarnings([day('2026-08-03', 35)], [profile('55.25')]);
    expect(summary.totalAmount.toFixed(2)).toBe('27.63');
  });

  it('prices an off-preset rate the same way as a preset one', () => {
    const preset = computeDailyEarnings([day('2026-08-03', 480)], [profile('75')]);
    const typed = computeDailyEarnings([day('2026-08-03', 480)], [profile('62')]);
    expect(preset.totalAmount.toFixed(2)).toBe('600.00');
    expect(typed.totalAmount.toFixed(2)).toBe('496.00');
  });
});

// ---------------------------------------------------------------------------
// Monthly trend
// ---------------------------------------------------------------------------

const period = (
  year: number,
  month: number,
  rows: { gross: string; net: string; ot: string; deduction: string; isEstimate?: boolean }[]
) =>
  ({
    year,
    month,
    name: thaiMonthLabel(year, month),
    status: 'CALCULATED',
    payrollEmployees: rows.map((r) => ({
      grossIncome: new Prisma.Decimal(r.gross),
      netSalary: new Prisma.Decimal(r.net),
      otAmount: new Prisma.Decimal(r.ot),
      totalDeduction: new Prisma.Decimal(r.deduction),
      isEstimate: r.isEstimate ?? false,
    })),
  }) as never;

const anchor = new Date(Date.UTC(2026, 7, 1));

describe('payroll trend never invents history', () => {
  it('marks a month with no payroll as null, not zero', () => {
    // Zero would assert that payroll ran and paid nobody, and would drag a
    // trend line to the axis on the strength of a month that never existed.
    const trend = buildPayrollTrend([], 6, anchor);
    expect(trend).toHaveLength(6);
    for (const point of trend) {
      expect(point.gross).toBeNull();
      expect(point.net).toBeNull();
      expect(point.ot).toBeNull();
      expect(point.deduction).toBeNull();
    }
  });

  it('reports exactly one meaningful month when only one period exists', () => {
    const trend = buildPayrollTrend(
      [
        period(2026, 8, [
          { gross: '41045.95', net: '37728.02', ot: '0', deduction: '3317.93', isEstimate: true },
        ]),
      ],
      6,
      anchor
    );
    const meaningful = trend.filter((p) => p.gross !== null);
    expect(meaningful).toHaveLength(1);
    expect(meaningful[0].code).toBe('2026-08');
    expect(meaningful[0].gross).toBe(41045.95);
    expect(meaningful[0].net).toBe(37728.02);
    expect(meaningful[0].deduction).toBe(3317.93);
    expect(meaningful[0].isEstimate).toBe(true);
  });

  it('reports two meaningful months once a second period exists', () => {
    const trend = buildPayrollTrend(
      [
        period(2026, 7, [{ gross: '38200.50', net: '35100.25', ot: '1200', deduction: '3100.25' }]),
        period(2026, 8, [{ gross: '41045.95', net: '37728.02', ot: '0', deduction: '3317.93' }]),
      ],
      6,
      anchor
    );
    expect(trend.filter((p) => p.gross !== null)).toHaveLength(2);
    // The months between remain gaps rather than being bridged.
    expect(trend.slice(0, 4).every((p) => p.gross === null)).toBe(true);
  });

  it('honours the 3 / 6 / 12 month window without faking the empty months', () => {
    for (const months of [3, 6, 12]) {
      const trend = buildPayrollTrend(
        [period(2026, 8, [{ gross: '41045.95', net: '37728.02', ot: '0', deduction: '3317.93' }])],
        months,
        anchor
      );
      expect(trend).toHaveLength(months);
      expect(trend.filter((p) => p.gross !== null)).toHaveLength(1);
      expect(trend[trend.length - 1].code).toBe('2026-08');
    }
  });

  it('labels every month in Thai, including the ones with no payroll', () => {
    // dayjs's Thai locale is not registered here, so .locale('th') silently
    // produced English names on exactly the months that carry no payroll.
    const trend = buildPayrollTrend([], 6, anchor);
    expect(trend.map((p) => p.shortLabel)).toEqual([
      'มี.ค. 2026',
      'เม.ย. 2026',
      'พ.ค. 2026',
      'มิ.ย. 2026',
      'ก.ค. 2026',
      'ส.ค. 2026',
    ]);
    expect(trend[0].name).toBe('มีนาคม 2026');
    expect(trend[5].name).toBe('สิงหาคม 2026');
  });

  it('keeps the machine-readable month key as YYYY-MM', () => {
    const trend = buildPayrollTrend([], 3, anchor);
    expect(trend.map((p) => p.code)).toEqual(['2026-06', '2026-07', '2026-08']);
  });

  it('formats Thai months correctly at both lengths', () => {
    expect(thaiMonthLabel(2026, 8)).toBe('สิงหาคม 2026');
    expect(thaiMonthShortLabel(2026, 8)).toBe('ส.ค. 2026');
    expect(thaiMonthShortLabel(2026, 4)).toBe('เม.ย. 2026');
  });

  it('sums a month from its own payroll rows', () => {
    const trend = buildPayrollTrend(
      [
        period(2026, 8, [
          { gross: '18000.00', net: '16475.00', ot: '0', deduction: '1525.00' },
          { gross: '23045.95', net: '21253.02', ot: '0', deduction: '1792.93' },
        ]),
      ],
      3,
      anchor
    );
    const august = trend[trend.length - 1];
    expect(august.gross).toBe(41045.95);
    expect(august.net).toBe(37728.02);
    expect(august.deduction).toBe(3317.93);
  });
});

describe('the trend chart picks its visualisation from the data', () => {
  const chart = source('../frontend/src/features/overview/PayrollTrendChart.tsx');

  it('counts only months that carry calculated payroll', () => {
    expect(chart).toContain('trend.filter((point) => point.gross !== null)');
  });

  it('shows an empty state when nothing has been calculated', () => {
    expect(chart).toContain('if (meaningful.length === 0) return <EmptyTrend />');
    expect(chart).toContain('ยังไม่มีข้อมูลเงินเดือนย้อนหลัง');
    expect(chart).toContain('เมื่อมีการคำนวณเงินเดือน กราฟแนวโน้มจะแสดงที่นี่');
  });

  it('does not use a line chart as the primary view for a single period', () => {
    expect(chart).toContain('if (meaningful.length === 1) return <SinglePeriodTrend');
    const single = chart.slice(
      chart.indexOf('function SinglePeriodTrend'),
      chart.indexOf('/** Two or more months')
    );
    expect(single).toContain('<BarChart');
    expect(single).not.toContain('<LineChart');
  });

  it('labels the single period and flags a preview', () => {
    const single = chart.slice(
      chart.indexOf('function SinglePeriodTrend'),
      chart.indexOf('/** Two or more months')
    );
    expect(single).toContain('{point.name}');
    expect(single).toContain('ประมาณการ');
    expect(single).toContain('มีข้อมูลเพียง 1 รอบเงินเดือน');
  });

  it('shows the single period figures from the same payload as the cards', () => {
    const single = chart.slice(
      chart.indexOf('function SinglePeriodTrend'),
      chart.indexOf('/** Two or more months')
    );
    // Read straight off the trend point - no second aggregation in the client.
    for (const field of ['point.gross', 'point.deduction', 'point.net', 'point.ot']) {
      expect(single).toContain(field);
    }
    expect(single).not.toContain('reduce(');
  });

  it('uses the line trend as soon as a second period exists', () => {
    expect(chart).toContain('return <MultiPeriodTrend trend={trend} />');
    const multi = chart.slice(chart.indexOf('function MultiPeriodTrend'));
    expect(multi).toContain('<LineChart');
  });

  it('never bridges a month with no payroll', () => {
    expect(chart).toContain('connectNulls={false}');
  });

  it('uses Thai month ticks and the full Thai name in the tooltip', () => {
    expect(chart).toContain('dataKey="shortLabel"');
    expect(chart).toContain('payload?.[0]?.payload?.name');
  });

  it('renders bars without the entry animation that left them at zero height', () => {
    expect(chart).toContain('isAnimationActive={false}');
  });
});
