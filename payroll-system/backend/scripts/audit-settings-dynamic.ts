/**
 * Proves that a Settings change reaches real calculation without a code edit.
 *
 * For each probe it uses the same service the PATCH /api/settings route calls,
 * re-reads the value from the database, runs a dependent calculation, then puts
 * the original value back. Every probe is reversible and the final state is
 * asserted to match the starting state.
 *
 * Usage: tsx scripts/audit-settings-dynamic.ts
 */
import 'dotenv/config';
import { EmploymentType } from '@prisma/client';
import { prisma } from '../src/plugins/prisma.js';
import { checkDatabaseUrl } from './db-guard.js';
import { loadSettings, updateSetting } from '../src/services/settings.service.js';
import { computeAttendanceMetrics } from '../src/services/attendance.service.js';
import { hourlyRate, dailyRate } from '../src/services/payroll-calculator.service.js';
import { isScheduledWorkday } from '../src/services/schedule-policy.service.js';

const guard = checkDatabaseUrl(process.env.DATABASE_URL);
if (!guard.ok) {
  console.error(`DATABASE SAFETY CHECK FAILED: ${guard.message}`);
  process.exit(1);
}

let failures = 0;
const ok = (label: string, pass: boolean, detail = '') => {
  if (!pass) failures += 1;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
};

const DAY = new Date('2026-08-25T00:00:00.000Z'); // a Tuesday
const at = (t: string) => new Date(`2026-08-25T${t}:00.000Z`);

const monthlyEmployee = {
  employeeId: 'probe', employeeCode: 'PROBE', employeeName: 'probe',
  departmentName: null, positionName: null,
  employmentType: EmploymentType.MONTHLY, baseSalary: 18000,
  ssoEnabled: false, taxEnabled: false, otEligible: true, attendanceRequired: true,
};

const lateAt = async (time: string) => {
  const s = await loadSettings();
  return computeAttendanceMetrics(
    {
      workDate: DAY, checkIn: at(time), checkOut: at('17:30'),
      isHoliday: false, isWeekend: false, isOnLeave: false,
      employmentType: EmploymentType.MONTHLY,
    },
    s
  ).lateMinutes;
};

/** Change a setting through the real service, observe, then restore it. */
async function probe(
  key: string,
  temporary: string,
  observe: () => Promise<string>,
  expectation: { before: string; after: string }
): Promise<void> {
  const original = await prisma.payrollSetting.findUnique({ where: { key } });
  if (!original) {
    ok(`${key} exists`, false, 'setting row missing');
    return;
  }
  console.log(`\n${key}`);
  const before = await observe();
  ok(`baseline observed value`, before === expectation.before, `${before}`);

  await updateSetting(key, temporary, 'audit-probe');
  const persisted = await prisma.payrollSetting.findUnique({ where: { key } });
  ok(`database now holds the new value`, persisted?.value === temporary, `${persisted?.value}`);

  const after = await observe();
  ok(`dependent calculation sees the new value`, after === expectation.after, `${before} -> ${after}`);
  ok(`the change actually altered behaviour`, before !== after);

  await updateSetting(key, original.value, 'audit-probe');
  const restored = await prisma.payrollSetting.findUnique({ where: { key } });
  ok(`original value restored`, restored?.value === original.value, `${restored?.value}`);
  ok(`behaviour returns to baseline`, (await observe()) === expectation.before);
}

async function main(): Promise<void> {
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT DATABASE() AS db');
  console.log(`SELECT DATABASE() => ${db}\n`);
  if (db !== 's2apayroll') process.exit(1);

  const snapshot = Object.fromEntries(
    (await prisma.payrollSetting.findMany()).map((s) => [s.key, s.value])
  );

  // 1. attendance: the monthly start time drives lateness
  await probe('MONTHLY_WORK_START_TIME', '09:00', async () => String(await lateAt('08:45')),
    { before: '15', after: '0' });

  // 2. attendance: the withdrawn flex window can still be re-opened by config
  await probe('MONTHLY_FLEX_ARRIVAL_MINUTES', '20', async () => String(await lateAt('08:45')),
    { before: '15', after: '0' });

  // 3. payroll: the salary day divisor drives the absence day rate
  await probe('MONTHLY_SALARY_DAY_DIVISOR', '25',
    async () => dailyRate(monthlyEmployee, await loadSettings()).toString(),
    { before: '600', after: '720' });

  // 4. payroll: paid hours per day drives the late-deduction hourly rate
  await probe('STANDARD_PAID_HOURS_PER_DAY', '10',
    async () => hourlyRate(monthlyEmployee, await loadSettings()).toString(),
    { before: '75', after: '60' });

  // 5. schedule: the working-day set decides which dates are worked
  await probe('WORKING_DAYS', 'MON,TUE,WED,THU,FRI',
    async () => String(isScheduledWorkday(new Date('2026-08-29T00:00:00.000Z'), await loadSettings())),
    { before: 'true', after: 'false' });

  // 6. attendance: DAILY break deduction
  await probe('DAILY_DEDUCT_BREAK', 'true', async () => {
    const s = await loadSettings();
    return String(computeAttendanceMetrics(
      {
        workDate: DAY, checkIn: at('08:00'), checkOut: at('17:00'),
        isHoliday: false, isWeekend: false, isOnLeave: false,
        employmentType: EmploymentType.DAILY,
      },
      s
    ).workedMinutes);
  }, { before: '540', after: '480' });

  // 7. OT: the monthly OT switch
  await probe('MONTHLY_OT_ENABLED', 'true', async () => {
    const s = await loadSettings();
    return String(computeAttendanceMetrics(
      {
        workDate: DAY, checkIn: at('08:30'), checkOut: at('20:00'),
        isHoliday: false, isWeekend: false, isOnLeave: false,
        employmentType: EmploymentType.MONTHLY,
      },
      s
    ).otMinutes);
  }, { before: '0', after: '150' });

  // 8. OT: the daily OT switch
  await probe('DAILY_OT_ENABLED', 'true', async () => {
    const s = await loadSettings();
    return String(computeAttendanceMetrics(
      {
        workDate: DAY, checkIn: at('08:00'), checkOut: at('20:00'),
        isHoliday: false, isWeekend: false, isOnLeave: false,
        employmentType: EmploymentType.DAILY,
      },
      s
    ).otMinutes);
  }, { before: '0', after: '240' });

  // --- final state must equal the starting state -------------------------
  const finalState = Object.fromEntries(
    (await prisma.payrollSetting.findMany()).map((s) => [s.key, s.value])
  );
  const drifted = Object.keys(snapshot).filter((k) => snapshot[k] !== finalState[k]);
  console.log('\nFINAL STATE');
  ok('every setting restored to its original value', drifted.length === 0, drifted.join(', ') || 'no drift');

  console.log(`\n${failures === 0 ? 'ALL PROBES PASSED' : `${failures} CHECK(S) FAILED`}`);
  await prisma.$disconnect();
  if (failures) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
