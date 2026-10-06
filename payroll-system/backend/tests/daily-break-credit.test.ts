import { describe, expect, it } from 'vitest';
import { EmploymentType, PayType, Prisma, type EmployeePayProfile } from '@prisma/client';
import { DEFAULT_WORK_TIME_POLICY, calculateDailyPayableTime } from '../src/utils/time-rounding.js';
import { computeDailyEarnings } from '../src/services/daily-earnings.service.js';
import { pairAttendanceEvents, type AttendanceSourceEvent } from '../src/services/event-attendance.service.js';

const DATE = '2026-10-06';
const at = (clock: string, day = DATE) => new Date(`${day}T${clock}:00.000+07:00`);
const session = (start: string, end: string, workedMinutes: number, endDay = DATE) => ({
  checkIn: at(start),
  checkOut: at(end, endDay),
  workedMinutes,
});
const calculate = (sessions: Array<ReturnType<typeof session>>, overrides = {}) =>
  calculateDailyPayableTime({
    sessions,
    roundingIntervalMinutes: 15,
    thresholdMinutes: 240,
    requiredBreakMinutes: 60,
    ...overrides,
  });

const profile = (): EmployeePayProfile => ({
  id: 'profile-1',
  employeeId: 'employee-1',
  payType: PayType.HOURLY,
  monthlySalary: null,
  hourlyRate: new Prisma.Decimal(75),
  effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
  effectiveTo: null,
  isActive: true,
  createdBy: null,
  updatedBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const source = (
  sheetRow: number,
  type: 'checkin' | 'checkout',
  timestamp: string,
  time: string
): AttendanceSourceEvent => ({
  sheetRow,
  timestamp,
  date: DATE,
  employeeCode: 'S2A-TEST',
  displayName: 'Test',
  type,
  time,
  workHours: '',
  lat: '',
  lng: '',
  summary: '',
  employmentType: 'DAILY',
  userId: 'test',
  clientRequestId: `request-${sheetRow}`,
});

describe('DAILY break credit after four completed work hours', () => {
  it('does not require a break at exactly 240 worked minutes', () => {
    expect(calculate([session('08:00', '12:00', 240)])).toMatchObject({
      actualWorkedMinutes: 240,
      requiredBreakMinutes: 0,
      additionalBreakDeductionMinutes: 0,
      payableMinutes: 240,
    });
  });

  it('requires 60 minutes at 241 worked minutes and floors after deduction', () => {
    expect(calculate([session('08:00', '12:01', 241)])).toMatchObject({
      requiredBreakMinutes: 60,
      creditedBreakMinutes: 0,
      additionalBreakDeductionMinutes: 60,
      minutesBeforeRounding: 181,
      roundedAwayMinutes: 1,
      payableMinutes: 180,
    });
  });

  it('17:00-00:00 has 420 actual, no gap, 60 additional and 360 payable', () => {
    expect(calculate([session('17:00', '00:00', 420, '2026-10-07')])).toMatchObject({
      actualWorkedMinutes: 420,
      interSessionGapMinutes: 0,
      additionalBreakDeductionMinutes: 60,
      payableMinutes: 360,
    });
  });

  it('credits a complete 60-minute gap without deducting it twice', () => {
    expect(calculate([
      session('17:00', '20:00', 180),
      session('21:00', '00:00', 180, '2026-10-07'),
    ])).toMatchObject({
      actualWorkedMinutes: 360,
      interSessionGapMinutes: 60,
      creditedBreakMinutes: 60,
      additionalBreakDeductionMinutes: 0,
      payableMinutes: 360,
    });
  });

  it('credits a 30-minute gap and deducts only the remaining 30 minutes', () => {
    expect(calculate([
      session('17:00', '20:00', 180),
      session('20:30', '00:00', 210, '2026-10-07'),
    ])).toMatchObject({
      actualWorkedMinutes: 390,
      interSessionGapMinutes: 30,
      creditedBreakMinutes: 30,
      additionalBreakDeductionMinutes: 30,
      payableMinutes: 360,
    });
  });

  it('adds multiple positive gaps before crediting the daily requirement once', () => {
    expect(calculate([
      session('08:00', '10:00', 120),
      session('10:15', '12:15', 120),
      session('12:45', '15:00', 135),
    ])).toMatchObject({
      actualWorkedMinutes: 375,
      interSessionGapMinutes: 45,
      creditedBreakMinutes: 45,
      additionalBreakDeductionMinutes: 15,
      payableMinutes: 360,
    });
  });

  it('caps gap credit at 60 and never creates a negative deduction', () => {
    expect(calculate([
      session('08:00', '11:00', 180),
      session('13:00', '15:00', 120),
    ])).toMatchObject({
      interSessionGapMinutes: 120,
      creditedBreakMinutes: 60,
      additionalBreakDeductionMinutes: 0,
      payableMinutes: 300,
    });
  });

  it('applies the requirement once to a multi-session day', () => {
    const result = calculate([
      session('08:00', '10:00', 120),
      session('10:05', '12:05', 120),
      session('12:10', '14:10', 120),
    ]);
    expect(result.requiredBreakMinutes).toBe(60);
    expect(result.interSessionGapMinutes).toBe(10);
    expect(result.additionalBreakDeductionMinutes).toBe(50);
  });

  it('floors only after the remaining break has been deducted', () => {
    const result = calculate([
      session('08:00', '10:03', 123),
      session('10:33', '12:36', 123),
    ]);
    expect(result.actualWorkedMinutes).toBe(246);
    expect(result.additionalBreakDeductionMinutes).toBe(30);
    expect(result.minutesBeforeRounding).toBe(216);
    expect(result.payableMinutes).toBe(210);
  });

  it('does not credit gaps for malformed sequences', () => {
    expect(calculate([
      session('08:00', '10:30', 150),
      session('11:30', '13:30', 120),
    ], { allowGapCredit: false })).toMatchObject({
      interSessionGapMinutes: 0,
      creditedBreakMinutes: 0,
      additionalBreakDeductionMinutes: 60,
    });
  });

  it('derives payable time without mutating source sessions or punches', () => {
    const sessions = [
      session('17:00', '20:00', 180),
      session('21:00', '00:00', 180, '2026-10-07'),
    ];
    const before = sessions.map((item) => ({
      checkIn: item.checkIn.getTime(),
      checkOut: item.checkOut.getTime(),
      workedMinutes: item.workedMinutes,
    }));
    calculate(sessions);
    expect(sessions.map((item) => ({
      checkIn: item.checkIn.getTime(),
      checkOut: item.checkOut.getTime(),
      workedMinutes: item.workedMinutes,
    }))).toEqual(before);
  });
});

describe('finalization and employment-type boundaries', () => {
  it('does not finalize or price an open day', () => {
    const earnings = computeDailyEarnings([{
      workDate: new Date(`${DATE}T00:00:00.000Z`),
      checkIn: at('08:00'),
      checkOut: null,
      workedMinutes: 240,
      status: 'IN_PROGRESS',
      hasOpenSession: true,
    }], [profile()], DEFAULT_WORK_TIME_POLICY, EmploymentType.DAILY);
    expect(earnings.rows[0]).toMatchObject({ finalized: false, payableMinutes: 0 });
    expect(earnings.totalAmount.toFixed(2)).toBe('0.00');
    expect(earnings.unfinalizedDays).toBe(1);
  });

  it('does not apply the DAILY break to HOURLY staff', () => {
    const earnings = computeDailyEarnings([{
      workDate: new Date(`${DATE}T00:00:00.000Z`),
      checkIn: at('08:00'),
      checkOut: at('15:00'),
      workedMinutes: 420,
      status: 'NORMAL',
    }], [profile()], DEFAULT_WORK_TIME_POLICY, EmploymentType.HOURLY);
    expect(earnings.rows[0]).toMatchObject({
      requiredBreakMinutes: 0,
      additionalBreakDeductionMinutes: 0,
      payableMinutes: 420,
    });
  });
});

describe('source timestamp integrity across midnight', () => {
  it.each([
    ['00:00:00', 420],
    ['01:00:00', 480],
  ])('pairs 17:00 to %s using real source timestamps', (checkoutTime, expectedMinutes) => {
    const paired = pairAttendanceEvents([
      source(1, 'checkin', '2026-10-06T17:00:00+07:00', '17:00:00'),
      source(2, 'checkout', `2026-10-07T${checkoutTime}+07:00`, checkoutTime),
    ]);
    expect(paired.malformedSequence).toBe(false);
    expect(paired.sessions[0].durationMinutes).toBe(expectedMinutes);
  });
});
