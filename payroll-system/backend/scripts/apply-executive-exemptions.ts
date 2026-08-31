/** Idempotently installs employee compliance flags and exempts only S2A000/S2A001. */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { checkDatabaseUrl } from './db-guard.js';

const prisma = new PrismaClient();
const TARGET_CODES = ['S2A000', 'S2A001'] as const;

async function main() {
  const guard = checkDatabaseUrl(process.env.DATABASE_URL);
  if (!guard.ok) throw new Error(guard.message);
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT DATABASE() AS db');
  if (db !== 's2apayroll') throw new Error(`Refusing database ${db}`);
  console.log(`SELECT DATABASE() => ${db}`);

  await prisma.$executeRawUnsafe(
    'ALTER TABLE `employees` ADD COLUMN IF NOT EXISTS `attendance_required` BOOLEAN NOT NULL DEFAULT true'
  );
  await prisma.$executeRawUnsafe(
    'ALTER TABLE `employees` ADD COLUMN IF NOT EXISTS `leave_tracking_required` BOOLEAN NOT NULL DEFAULT true'
  );
  const found = await prisma.$queryRawUnsafe<Array<{ employee_code: string }>>(
    'SELECT employee_code FROM employees WHERE employee_code IN (?, ?) ORDER BY employee_code',
    ...TARGET_CODES
  );
  if (found.length !== TARGET_CODES.length) {
    throw new Error(`Expected ${TARGET_CODES.join(', ')}; found ${found.map((r) => r.employee_code).join(', ')}`);
  }
  const changed = await prisma.$executeRawUnsafe(
    'UPDATE employees SET attendance_required = false, leave_tracking_required = false WHERE employee_code IN (?, ?)',
    ...TARGET_CODES
  );
  if (changed > 0) {
    await prisma.auditLog.create({
      data: {
        action: 'EMPLOYEE_COMPLIANCE_EXEMPTION',
        entity: 'Employee',
        reason: 'Executive attendance and leave tracking exemption',
        newValue: {
          employeeCodes: [...TARGET_CODES],
          attendanceRequired: false,
          leaveTrackingRequired: false,
        },
      },
    });
  }
  console.log(`Executive exemption applied safely; matched rows=${found.length}, changed=${changed}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : 'Executive exemption failed');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
