/**
 * READ-ONLY completeness audit over the real employee records.
 * Reports only; it never writes and never fills anything in.
 *
 * Usage: tsx scripts/audit-employee-completeness.ts
 */
import 'dotenv/config';
import { prisma } from '../src/plugins/prisma.js';
import { employeeCompletenessSummary } from '../src/services/employee.service.js';
import {
  ALWAYS_REQUIRED_FIELDS,
  COMPENSATION_FIELD_BY_TYPE,
  EMPLOYEE_FIELD_LABELS,
  OPTIONAL_EMPLOYEE_FIELDS,
} from '../src/services/employee-completeness.service.js';

async function main(): Promise<void> {
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT DATABASE() AS db');
  console.log(`SELECT DATABASE() => ${db}   (READ ONLY - writes nothing)\n`);

  console.log('RULE');
  console.log(`  always required : ${ALWAYS_REQUIRED_FIELDS.map((f) => EMPLOYEE_FIELD_LABELS[f]).join(', ')}`);
  console.log('  plus compensation by pay type:');
  for (const [type, field] of Object.entries(COMPENSATION_FIELD_BY_TYPE)) {
    console.log(`    ${type.padEnd(9)} -> ${EMPLOYEE_FIELD_LABELS[field]} ต้องมากกว่า 0`);
  }
  console.log(`  optional (never blocks): ${OPTIONAL_EMPLOYEE_FIELDS.join(', ')}`);

  const summary = await employeeCompletenessSummary();
  console.log('\nSUMMARY');
  console.log(`  พนักงานทั้งหมด   ${summary.total}`);
  console.log(`  ข้อมูลครบ        ${summary.complete}`);
  console.log(`  ข้อมูลไม่ครบ      ${summary.incomplete}`);

  if (summary.incompleteEmployees.length) {
    console.log('\nINCOMPLETE EMPLOYEES');
    for (const e of summary.incompleteEmployees) {
      console.log(`  ${e.employeeCode}  ${e.name.padEnd(26)} ขาด ${e.missingCount} รายการ: ${e.missingLabels.join(', ')}`);
    }
  } else {
    console.log('\nEvery employee profile is complete.');
  }

  // Show the exemption flags alongside, to demonstrate they do not affect the verdict.
  const employees = await prisma.employee.findMany({
    select: {
      employeeCode: true, employmentType: true, attendanceRequired: true,
      leaveTrackingRequired: true, baseSalary: true, departmentId: true, positionId: true,
    },
    orderBy: { employeeCode: 'asc' },
  });
  const incompleteCodes = new Set(summary.incompleteEmployees.map((e) => e.employeeCode));
  console.log('\nPER EMPLOYEE');
  for (const e of employees) {
    console.log(
      `  ${e.employeeCode}  ${e.employmentType.padEnd(8)} ` +
      `salary=${String(e.baseSalary).padStart(8)} dept=${e.departmentId ? 'yes' : 'NO '} pos=${e.positionId ? 'yes' : 'NO '} ` +
      `attReq=${e.attendanceRequired ? 'yes' : 'no '} leaveReq=${e.leaveTrackingRequired ? 'yes' : 'no '} ` +
      `-> ${incompleteCodes.has(e.employeeCode) ? 'ข้อมูลไม่ครบ' : 'ข้อมูลครบ'}`
    );
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
