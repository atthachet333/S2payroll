/**
 * Applies the new company working-time policy to SETTINGS ONLY.
 *
 *   monthly day        08:30 - 17:30, fixed
 *   flexible arrival   withdrawn (0)
 *   salary divisors    30 days, 8 paid hours
 *   late deduction     charged in whole-hour blocks
 *
 * Attendance rows are NOT touched. Historical recalculation is a separate,
 * explicitly approved step - run scripts/preview-policy-recalc.ts first.
 *
 * Usage: tsx scripts/apply-new-work-policy.ts [--confirm]
 */
import 'dotenv/config';
import { prisma } from '../src/plugins/prisma.js';
import { checkDatabaseUrl } from './db-guard.js';
import { ensureDefaultSettings } from '../src/services/settings.service.js';
import { recordAudit } from '../src/services/audit.service.js';

const CONFIRM = process.argv.includes('--confirm');

/**
 * Both the new authoritative keys and the legacy fallbacks are set, so no
 * reader can still resolve the withdrawn 08:00-17:00 window and leave two
 * conflicting policies live at once.
 */
const POLICY: Record<string, string> = {
  MONTHLY_WORK_START_TIME: '08:30',
  MONTHLY_WORK_END_TIME: '17:30',
  MONTHLY_FLEX_ARRIVAL_MINUTES: '0',
  WORK_START_TIME: '08:30',
  WORK_END_TIME: '17:30',
  LATE_GRACE_MINUTES: '0',
  MONTHLY_SALARY_DAY_DIVISOR: '30',
  STANDARD_PAID_HOURS_PER_DAY: '8',
  LATE_DEDUCTION_ROUND_UP_HOURS: 'true',
  OT_REQUIRES_APPROVAL: 'true',
};

const guard = checkDatabaseUrl(process.env.DATABASE_URL);
if (!guard.ok) {
  console.error(`DATABASE SAFETY CHECK FAILED: ${guard.message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT DATABASE() AS db');
  console.log(`SELECT DATABASE() => ${db}`);
  if (db !== 's2apayroll') {
    console.error('Refusing to write to a database other than s2apayroll.');
    process.exit(1);
  }

  if (CONFIRM) {
    const added = await ensureDefaultSettings();
    console.log(`new setting keys inserted: ${added}`);
  } else {
    console.log('(dry run: new keys would be inserted by ensureDefaultSettings)');
  }

  const before: Record<string, string | null> = {};
  console.log('\nSETTING CHANGES');
  for (const [key, value] of Object.entries(POLICY)) {
    const current = await prisma.payrollSetting.findUnique({ where: { key } });
    before[key] = current?.value ?? null;
    if (!current) {
      console.log(`  ${key.padEnd(30)} (absent) -> ${value}`);
      continue;
    }
    console.log(
      `  ${key.padEnd(30)} ${current.value === value ? `already ${value}` : `${current.value} -> ${value}`}`
    );
    if (CONFIRM && current.value !== value) {
      await prisma.payrollSetting.update({ where: { key }, data: { value } });
    }
  }

  if (!CONFIRM) {
    console.log('\nDRY RUN - nothing written. Re-run with --confirm to apply.');
    await prisma.$disconnect();
    return;
  }

  await recordAudit({
    action: 'WORK_POLICY_UPDATE',
    entity: 'PayrollSetting',
    reason: 'นโยบายเวลาทำงานใหม่ 08:30-17:30 ยกเลิกช่วงเข้างานยืดหยุ่น',
    oldValue: before,
    newValue: POLICY,
  });

  const attendance = await prisma.attendanceRecord.count();
  console.log(`\nSettings applied. Attendance rows left untouched: ${attendance}`);
  console.log('Run scripts/preview-policy-recalc.ts to see what a historical recalculation would change.');

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
