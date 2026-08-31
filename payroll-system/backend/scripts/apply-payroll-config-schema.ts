import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { checkDatabaseUrl } from './db-guard.js';

const prisma = new PrismaClient();

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    'SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
    table, column
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

async function main() {
  const guard = checkDatabaseUrl(process.env.DATABASE_URL);
  if (!guard.ok) throw new Error(guard.message ?? 'Database safety check failed');
  const selected = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT DATABASE() AS db');
  if (selected[0]?.db !== 's2apayroll') throw new Error('Refusing schema update: active database is not s2apayroll');
  console.log('SELECT DATABASE() => s2apayroll');

  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS employee_pay_profiles (
    id CHAR(36) NOT NULL, employee_id CHAR(36) NOT NULL,
    pay_type ENUM('MONTHLY','HOURLY') NOT NULL,
    monthly_salary DECIMAL(15,2) NULL, hourly_rate DECIMAL(15,2) NULL,
    effective_from DATE NOT NULL, effective_to DATE NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by CHAR(36) NULL, updated_by CHAR(36) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY employee_pay_effective_from (employee_id, effective_from),
    KEY employee_pay_profiles_employee_id_is_active_effective_from_idx (employee_id, is_active, effective_from),
    PRIMARY KEY (id),
    CONSTRAINT employee_pay_profiles_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE ON UPDATE CASCADE
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS work_schedule_profiles (
    id CHAR(36) NOT NULL, name VARCHAR(191) NOT NULL,
    effective_from DATE NOT NULL, effective_to DATE NULL,
    working_days VARCHAR(64) NOT NULL, work_start_time VARCHAR(5) NOT NULL,
    work_end_time VARCHAR(5) NOT NULL, flex_arrival_minutes INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by CHAR(36) NULL, updated_by CHAR(36) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY work_schedule_profiles_effective_from_key (effective_from),
    KEY work_schedule_profiles_is_active_effective_from_effective_to_idx (is_active, effective_from, effective_to),
    PRIMARY KEY (id)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

  if (!(await columnExists('holidays', 'type'))) {
    await prisma.$executeRawUnsafe("ALTER TABLE holidays ADD COLUMN type ENUM('PUBLIC_HOLIDAY','COMPANY_HOLIDAY') NOT NULL DEFAULT 'COMPANY_HOLIDAY'");
  }
  if (!(await columnExists('holidays', 'note'))) {
    await prisma.$executeRawUnsafe('ALTER TABLE holidays ADD COLUMN note VARCHAR(500) NULL');
  }

  const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('employee_pay_profiles','work_schedule_profiles') ORDER BY table_name"
  );
  console.log(JSON.stringify({ tables: tables.map((row) => row.table_name), holidayType: await columnExists('holidays', 'type'), holidayNote: await columnExists('holidays', 'note') }));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
