/**
 * Idempotent seed: roles, the bootstrap SUPER_ADMIN, company profile,
 * payroll settings, and a small demo dataset (departments, positions,
 * employees, one month of attendance) so the UI has something to show.
 *
 * Safe to re-run: everything is upserted by a natural key.
 */
import { PrismaClient, EmploymentType, RoleCode } from '@prisma/client';
import { hash as argonHash } from '@node-rs/argon2';
import { DEFAULT_PAYROLL_SETTINGS } from '../src/config/payroll-defaults.js';
import { ROLE_LABELS, ROLE_PERMISSIONS } from '../src/config/permissions.js';
import { env } from '../src/config/env.js';

const prisma = new PrismaClient();

const ROLE_DESCRIPTIONS: Record<RoleCode, string> = {
  SUPER_ADMIN: 'Full access including payroll unlock',
  ADMIN: 'All functions except unlocking a locked payroll period',
  HR: 'Employees and attendance',
  PAYROLL: 'Payroll, payslips and reports',
  VIEWER: 'Read-only access',
};

async function seedRoles() {
  for (const code of Object.keys(ROLE_PERMISSIONS) as RoleCode[]) {
    await prisma.role.upsert({
      where: { code },
      update: { name: ROLE_LABELS[code], permissions: ROLE_PERMISSIONS[code] },
      create: {
        code,
        name: ROLE_LABELS[code],
        description: ROLE_DESCRIPTIONS[code],
        permissions: ROLE_PERMISSIONS[code],
      },
    });
  }
  console.log('  roles: 5');
}

async function seedSettings() {
  let created = 0;
  for (const setting of DEFAULT_PAYROLL_SETTINGS) {
    const existing = await prisma.payrollSetting.findUnique({ where: { key: setting.key } });
    if (!existing) {
      await prisma.payrollSetting.create({ data: setting });
      created += 1;
    } else {
      // Refresh only the presentation metadata; never clobber a configured value.
      await prisma.payrollSetting.update({
        where: { key: setting.key },
        data: { label: setting.label, description: setting.description, group: setting.group },
      });
    }
  }
  console.log(`  settings: ${DEFAULT_PAYROLL_SETTINGS.length} (${created} new)`);
}

/**
 * Create the bootstrap administrator, once.
 *
 * SEED_ADMIN_PASSWORD is used ONLY when the account does not yet exist. If the
 * account is already present the seed leaves it completely untouched - it never
 * resets a password, a role, or the active flag. Re-running the seed on a live
 * database therefore cannot hand back access to whoever knows the seed value.
 *
 * The password is never printed. Echoing it would leak the credential into
 * terminal scrollback, CI logs and shell history.
 */
async function seedAdmin() {
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'SUPER_ADMIN' } });
  const email = env.SEED_ADMIN_EMAIL.toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`  admin: ${email} (already exists - password left unchanged)`);
    return;
  }

  await prisma.user.create({
    data: {
      email,
      passwordHash: await argonHash(env.SEED_ADMIN_PASSWORD, {
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      }),
      firstName: 'System',
      lastName: 'Administrator',
      roleId: role.id,
      // The bootstrap credential is known from .env, so it must be replaced
      // before the account can do anything.
      mustChangePassword: true,
    },
  });
  console.log(`  admin: ${email} created from the configured bootstrap password`);
  console.log('         a password change is required at first login');
}

async function seedCompany() {
  const existing = await prisma.company.findFirst();
  if (existing) return;
  await prisma.company.create({
    data: {
      name: 'บริษัท ตัวอย่าง จำกัด',
      nameEn: 'Example Company Limited',
      taxId: '0000000000000',
      address: '123 ถนนสุขุมวิท แขวงคลองเตย เขตคลองเตย กรุงเทพมหานคร 10110',
      phone: '02-000-0000',
      email: 'hr@example.co.th',
    },
  });
  console.log('  company: created');
}

const DEPARTMENTS = [
  { code: 'ADM', name: 'บริหาร' },
  { code: 'ACC', name: 'บัญชีและการเงิน' },
  { code: 'OPS', name: 'ปฏิบัติการ' },
  { code: 'SAL', name: 'ฝ่ายขาย' },
];

const POSITIONS = [
  { code: 'MGR', name: 'ผู้จัดการ', dept: 'ADM' },
  { code: 'ACC1', name: 'เจ้าหน้าที่บัญชี', dept: 'ACC' },
  { code: 'OPS1', name: 'เจ้าหน้าที่ปฏิบัติการ', dept: 'OPS' },
  { code: 'SAL1', name: 'พนักงานขาย', dept: 'SAL' },
];

async function seedOrg() {
  for (const dept of DEPARTMENTS) {
    await prisma.department.upsert({
      where: { code: dept.code },
      update: { name: dept.name },
      create: dept,
    });
  }
  for (const pos of POSITIONS) {
    const department = await prisma.department.findUnique({ where: { code: pos.dept } });
    await prisma.position.upsert({
      where: { code: pos.code },
      update: { name: pos.name, departmentId: department?.id ?? null },
      create: { code: pos.code, name: pos.name, departmentId: department?.id ?? null },
    });
  }
  console.log(`  departments: ${DEPARTMENTS.length}, positions: ${POSITIONS.length}`);
}

const EMPLOYEES = [
  { code: 'EMP001', first: 'สมชาย', last: 'ใจดี', nick: 'ชาย', dept: 'ADM', pos: 'MGR', salary: 65000, type: EmploymentType.MONTHLY },
  { code: 'EMP002', first: 'สมหญิง', last: 'รักงาน', nick: 'หญิง', dept: 'ACC', pos: 'ACC1', salary: 32000, type: EmploymentType.MONTHLY },
  { code: 'EMP003', first: 'ประเสริฐ', last: 'มั่นคง', nick: 'เสริฐ', dept: 'OPS', pos: 'OPS1', salary: 21000, type: EmploymentType.MONTHLY },
  { code: 'EMP004', first: 'วิภา', last: 'สดใส', nick: 'ภา', dept: 'SAL', pos: 'SAL1', salary: 25000, type: EmploymentType.MONTHLY },
  { code: 'EMP005', first: 'อนันต์', last: 'ตั้งใจ', nick: 'นันต์', dept: 'OPS', pos: 'OPS1', salary: 620, type: EmploymentType.DAILY },
  { code: 'EMP006', first: 'กมล', last: 'ชูใจ', nick: 'กม', dept: 'SAL', pos: 'SAL1', salary: 28000, type: EmploymentType.MONTHLY },
];

async function seedEmployees() {
  for (const e of EMPLOYEES) {
    const department = await prisma.department.findUnique({ where: { code: e.dept } });
    const position = await prisma.position.findUnique({ where: { code: e.pos } });
    await prisma.employee.upsert({
      where: { employeeCode: e.code },
      update: {},
      create: {
        employeeCode: e.code,
        firstName: e.first,
        lastName: e.last,
        nickname: e.nick,
        departmentId: department?.id ?? null,
        positionId: position?.id ?? null,
        employmentType: e.type,
        startDate: new Date(Date.UTC(2023, 0, 16)),
        baseSalary: e.salary,
        bankName: 'ธนาคารกสิกรไทย',
        bankAccount: `123-4-${e.code.slice(-5)}-0`,
        taxId: `1${e.code.slice(-3)}00000000`,
        socialSecurity: `1${e.code.slice(-3)}00000000`,
        status: 'ACTIVE',
      },
    });
  }
  console.log(`  employees: ${EMPLOYEES.length}`);
}

/**
 * One month of plausible attendance for the previous calendar month, written
 * through the same raw-data + record path a real sync uses.
 */
async function seedAttendance() {
  const existing = await prisma.attendanceRecord.count();
  if (existing > 0) {
    console.log(`  attendance: skipped (${existing} records already present)`);
    return;
  }

  const { computeAttendanceMetrics } = await import('../src/services/attendance.service.js');
  const { loadSettings } = await import('../src/services/settings.service.js');
  const settings = await loadSettings();

  const now = new Date();
  const year = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const month = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth(); // previous month, 1-based
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const employees = await prisma.employee.findMany();
  let count = 0;

  for (const employee of employees) {
    for (let day = 1; day <= daysInMonth; day += 1) {
      const workDate = new Date(Date.UTC(year, month - 1, day));
      const weekday = workDate.getUTCDay();
      const weekend = weekday === 0 || weekday === 6;
      if (weekend) continue;

      // Deterministic pseudo-variation so re-seeding produces the same data.
      const seed = (employee.employeeCode.charCodeAt(5) + day) % 10;

      let checkIn: Date | null = new Date(Date.UTC(year, month - 1, day, 8, 55));
      let checkOut: Date | null = new Date(Date.UTC(year, month - 1, day, 18, 5));

      if (seed === 3) checkIn = new Date(Date.UTC(year, month - 1, day, 9, 34)); // late
      if (seed === 5) checkOut = new Date(Date.UTC(year, month - 1, day, 20, 30)); // OT
      if (seed === 7) checkOut = null; // missing punch
      if (seed === 9) {
        checkIn = null;
        checkOut = null;
      } // absent

      const metrics = computeAttendanceMetrics(
        { workDate, checkIn, checkOut, isHoliday: false, isWeekend: false, isOnLeave: false, employmentType: employee.employmentType },
        settings
      );

      await prisma.attendanceRecord.create({
        data: {
          employeeId: employee.id,
          employeeCode: employee.employeeCode,
          workDate,
          checkIn,
          checkOut,
          originalCheckIn: checkIn,
          originalCheckOut: checkOut,
          workedMinutes: metrics.workedMinutes,
          normalMinutes: metrics.normalMinutes,
          otMinutes: metrics.otMinutes,
          breakMinutes: metrics.breakMinutes,
          lateMinutes: metrics.lateMinutes,
          earlyLeaveMinutes: metrics.earlyLeaveMinutes,
          isMissingCheckIn: metrics.isMissingCheckIn,
          isMissingCheckOut: metrics.isMissingCheckOut,
          isAbsent: metrics.isAbsent,
          isWeekend: false,
          isHoliday: false,
          status: metrics.status,
          source: 'GOOGLE_SHEET',
        },
      });
      count += 1;
    }
  }
  console.log(`  attendance: ${count} records for ${year}-${String(month).padStart(2, '0')}`);
}

async function main() {
  console.log('Seeding payroll database...');
  await seedRoles();
  await seedSettings();
  await seedAdmin();
  await seedCompany();
  await seedOrg();
  await seedEmployees();
  await seedAttendance();
  console.log('Seed complete.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
