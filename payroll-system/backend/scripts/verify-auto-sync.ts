/**
 * Live verification of the background sync cycle against the real Google Sheet.
 *
 * Google is read-only throughout. Runs two full cycles back to back and asserts
 * the second changed nothing, then checks that manual and background runs share
 * one lock and that protected rows were left alone.
 *
 * Usage: tsx scripts/verify-auto-sync.ts
 */
import 'dotenv/config';
import { prisma } from '../src/plugins/prisma.js';
import { checkDatabaseUrl } from './db-guard.js';
import { autoSync } from '../src/services/auto-sync.service.js';

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

const counts = async () => ({
  employees: await prisma.employee.count(),
  attendance: await prisma.attendanceRecord.count(),
  leave: await prisma.leaveRecord.count(),
  raw: await prisma.attendanceRawData.count(),
  corrected: await prisma.attendanceRecord.count({ where: { isCorrected: true } }),
  locked: await prisma.attendanceRecord.count({ where: { isLocked: true } }),
});

async function main(): Promise<void> {
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT DATABASE() AS db');
  console.log(`SELECT DATABASE() => ${db}\n`);
  if (db !== 's2apayroll') process.exit(1);

  const before = await counts();
  console.log('BEFORE  ' + JSON.stringify(before));

  // --- cycle 1 -------------------------------------------------------------
  console.log('\nCYCLE 1');
  const first = await autoSync.runCycle('manual');
  ok('cycle completed', Boolean(first));
  if (!first) return;
  for (const source of ['employees', 'attendance', 'leave'] as const) {
    const s = first.sources[source];
    ok(`${source} succeeded`, Boolean(s.lastSuccessfulAt) && !s.lastErrorSummary,
      s.lastErrorSummary ?? JSON.stringify(s.lastCounts));
  }
  const afterFirst = await counts();
  console.log('AFTER 1 ' + JSON.stringify(afterFirst));

  // --- cycle 2: must be a no-op -------------------------------------------
  console.log('\nCYCLE 2 (idempotency)');
  const second = await autoSync.runCycle('manual');
  ok('cycle completed', Boolean(second));
  const afterSecond = await counts();
  console.log('AFTER 2 ' + JSON.stringify(afterSecond));

  ok('employee count unchanged', afterFirst.employees === afterSecond.employees);
  ok('attendance count unchanged', afterFirst.attendance === afterSecond.attendance);
  ok('leave count unchanged', afterFirst.leave === afterSecond.leave);
  ok('raw archive unchanged', afterFirst.raw === afterSecond.raw);

  const emp = second!.sources.employees.lastCounts ?? {};
  const lv = second!.sources.leave.lastCounts ?? {};
  const att = second!.sources.attendance.lastCounts ?? {};
  ok('employees: nothing created or updated on re-run',
    emp.created === 0 && emp.updated === 0, JSON.stringify(emp));
  ok('leave: nothing created or updated on re-run',
    lv.created === 0 && lv.updated === 0, JSON.stringify(lv));
  ok('attendance: nothing imported or updated on re-run',
    att.imported === 0 && att.updated === 0, JSON.stringify(att));

  // --- protections ---------------------------------------------------------
  console.log('\nPROTECTIONS');
  ok('manually corrected rows preserved', before.corrected === afterSecond.corrected,
    `${before.corrected} -> ${afterSecond.corrected}`);
  ok('locked rows untouched', before.locked === afterSecond.locked,
    `${before.locked} -> ${afterSecond.locked}`);
  ok('attendance count stable across the whole run',
    before.attendance === afterSecond.attendance, `${before.attendance} -> ${afterSecond.attendance}`);

  // --- single flight -------------------------------------------------------
  console.log('\nSINGLE FLIGHT');
  const [a, b] = await Promise.all([autoSync.runCycle('manual'), autoSync.runCycle('manual')]);
  const declined = [a, b].filter((r) => r === null).length;
  ok('two concurrent cycles produce exactly one refusal', declined === 1, `${declined} declined`);
  ok('the refusal was counted', (autoSync.getStatus().skippedBecauseBusy ?? 0) > 0);

  // --- status shape --------------------------------------------------------
  console.log('\nSTATUS');
  const status = autoSync.getStatus();
  console.log('  ' + JSON.stringify({
    enabled: status.enabled, running: status.running,
    intervalSeconds: status.intervalSeconds,
    lastSuccessfulAt: status.lastSuccessfulAt,
    cyclesRun: status.cyclesRun, skippedBecauseBusy: status.skippedBecauseBusy,
  }));
  const serialised = JSON.stringify(status);
  for (const secret of ['BEGIN PRIVATE KEY', 'mysql://', 'JWT', 'password']) {
    ok(`status contains no ${secret}`, !serialised.includes(secret));
  }
  ok('not running once cycles have finished', status.running === false);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  await prisma.$disconnect();
  if (failures) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
