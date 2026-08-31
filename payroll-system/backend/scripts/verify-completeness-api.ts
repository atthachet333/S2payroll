/**
 * READ-ONLY verification of the completeness API surface against real data.
 *
 * Usage: tsx scripts/verify-completeness-api.ts
 */
import 'dotenv/config';
import { prisma } from '../src/plugins/prisma.js';
import {
  listEmployees,
  getEmployee,
  employeeCompletenessSummary,
} from '../src/services/employee.service.js';

async function main(): Promise<void> {
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT DATABASE() AS db');
  console.log(`SELECT DATABASE() => ${db}   (READ ONLY)\n`);

  const all = await listEmployees({ page: 1, pageSize: 50 });
  console.log(`LIST (${all.total} rows) — every row carries profileCompleteness`);
  for (const e of all.items) {
    const c = (e as unknown as { profileCompleteness: { complete: boolean; missingCount: number; missingLabels: string[] } })
      .profileCompleteness;
    console.log(
      `  ${e.employeeCode}  ${e.employmentType.padEnd(8)} ` +
      `${c.complete ? 'ข้อมูลครบ' : `ข้อมูลไม่ครบ ${c.missingCount} รายการ`}  ${c.missingLabels.join(', ')}`
    );
  }

  const incomplete = await listEmployees({ page: 1, pageSize: 50, completeness: 'INCOMPLETE' });
  const complete = await listEmployees({ page: 1, pageSize: 50, completeness: 'COMPLETE' });
  console.log(`\nFILTER  INCOMPLETE=${incomplete.total}  COMPLETE=${complete.total}  (sum must equal ${all.total})`);
  console.log(`  sums correctly: ${incomplete.total + complete.total === all.total}`);

  const combo = await listEmployees({
    page: 1, pageSize: 50, completeness: 'INCOMPLETE', employmentType: 'DAILY',
  });
  console.log(`  combined with employmentType=DAILY -> ${combo.total}: ${combo.items.map((i) => i.employeeCode).join(', ')}`);

  const searched = await listEmployees({
    page: 1, pageSize: 50, completeness: 'INCOMPLETE', search: 'S2A00',
  });
  console.log(`  combined with search "S2A00" -> ${searched.total}`);

  const summary = await employeeCompletenessSummary();
  console.log(`\nSUMMARY total=${summary.total} complete=${summary.complete} incomplete=${summary.incomplete}`);
  console.log(`  agrees with the filter: ${summary.incomplete === incomplete.total && summary.complete === complete.total}`);

  const detail = await getEmployee(all.items[0].id);
  const serialised = JSON.stringify(detail);
  console.log(`\nDETAIL ${all.items[0].employeeCode}`);
  console.log(`  carries profileCompleteness: ${Boolean((detail as unknown as { profileCompleteness?: unknown }).profileCompleteness)}`);
  for (const secret of ['passwordHash', 'accessToken', 'refreshToken', 'JWT']) {
    console.log(`  leaks ${secret}: ${serialised.includes(secret)}`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
