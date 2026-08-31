/**
 * Dumps the exact Employees API payload as JSON, for verifying frontend
 * rendering against real database rows. Read-only.
 *
 * Usage: tsx scripts/dump-employees-payload.ts > payload.json
 */
import 'dotenv/config';
import { prisma } from '../src/plugins/prisma.js';
import { listEmployees } from '../src/services/employee.service.js';

async function main(): Promise<void> {
  const employees = await listEmployees({ page: 1, pageSize: 25 });
  const departments = await prisma.department.findMany({
    select: { id: true, code: true, name: true, isActive: true },
    orderBy: { name: 'asc' },
  });
  process.stdout.write(JSON.stringify({ employees, departments }));
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
