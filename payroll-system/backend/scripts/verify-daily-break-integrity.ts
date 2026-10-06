/** Read-only fingerprints for deployment safety verification. */
import 'dotenv/config';
import { prisma } from '../src/plugins/prisma.js';
import { checkDatabaseUrl, EXPECTED_DATABASE } from './db-guard.js';

type Row = Record<string, string | number | Date | null>;

async function main(): Promise<void> {
  const guard = checkDatabaseUrl(process.env.DATABASE_URL);
  if (!guard.ok || guard.target?.database !== EXPECTED_DATABASE) {
    throw new Error(guard.message ?? 'Database safety check failed');
  }
  const [{ db }] = await prisma.$queryRaw<Array<{ db: string }>>`SELECT DATABASE() AS db`;
  if (db !== EXPECTED_DATABASE) throw new Error(`Refusing verification against ${db}`);

  const [rawAttendance, protectedPayroll, payProfiles, settings] = await Promise.all([
    prisma.$queryRawUnsafe<Row[]>(`
      SELECT
        CAST(COUNT(*) AS CHAR) AS row_count,
        CAST(COALESCE(SUM(CRC32(CONCAT_WS('|', id, row_hash, employee_code, raw_date,
          COALESCE(raw_check_in, ''), COALESCE(raw_check_out, ''), COALESCE(sheet_row, '')))), 0) AS CHAR) AS fingerprint
      FROM attendance_raw_data
    `),
    prisma.$queryRawUnsafe<Row[]>(`
      SELECT
        pp.status,
        CAST(COUNT(DISTINCT pp.id) AS CHAR) AS period_count,
        CAST(COUNT(pe.id) AS CHAR) AS employee_row_count,
        CAST(COALESCE(SUM(pe.base_salary), 0) AS CHAR) AS base_salary_total,
        CAST(COALESCE(SUM(pe.gross_income), 0) AS CHAR) AS gross_total,
        CAST(COALESCE(SUM(pe.net_salary), 0) AS CHAR) AS net_total,
        CAST(COALESCE(SUM(CRC32(CONCAT_WS('|', pe.id, pe.status, pe.base_salary,
          pe.gross_income, pe.total_deduction, pe.net_salary))), 0) AS CHAR) AS fingerprint
      FROM payroll_periods pp
      LEFT JOIN payroll_employees pe ON pe.period_id = pp.id
      WHERE pp.status IN ('APPROVED', 'PAID', 'LOCKED')
      GROUP BY pp.status
      ORDER BY pp.status
    `),
    prisma.$queryRawUnsafe<Row[]>(`
      SELECT
        CAST(COUNT(*) AS CHAR) AS row_count,
        CAST(COALESCE(SUM(CRC32(CONCAT_WS('|', id, employee_id, pay_type,
          COALESCE(monthly_salary, ''), COALESCE(hourly_rate, ''), effective_from,
          COALESCE(effective_to, ''), is_active))), 0) AS CHAR) AS fingerprint
      FROM employee_pay_profiles
    `),
    prisma.$queryRawUnsafe<Row[]>(`
      SELECT \`key\`, value
      FROM payroll_settings
      WHERE \`key\` IN (
        'TIME_ROUNDING_MINUTES',
        'DAILY_BREAK_THRESHOLD_MINUTES',
        'DAILY_BREAK_DEDUCTION_MINUTES',
        'DAILY_REQUIRED_BREAK_MINUTES'
      )
      ORDER BY \`key\`
    `),
  ]);

  console.log(JSON.stringify({
    database: db,
    readOnly: true,
    rawAttendance: rawAttendance[0],
    protectedPayroll,
    payProfiles: payProfiles[0],
    settings,
  }, null, 2));
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
