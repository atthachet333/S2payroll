import { PayType, Prisma } from '@prisma/client';
import { prisma } from '../plugins/prisma.js';
import type { Actor } from './payroll.service.js';
import { dayjs } from '../utils/datetime.js';
import { badRequest, notFound } from '../utils/errors.js';
import { recordAudit } from './audit.service.js';

export interface PayProfileInput {
  payType: PayType;
  monthlySalary?: string | null;
  hourlyRate?: string | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  isActive?: boolean;
}

const normalize = (input: PayProfileInput) => ({
  payType: input.payType,
  monthlySalary: input.payType === PayType.MONTHLY ? new Prisma.Decimal(input.monthlySalary!) : null,
  hourlyRate: input.payType === PayType.HOURLY ? new Prisma.Decimal(input.hourlyRate!) : null,
  effectiveFrom: dayjs.utc(input.effectiveFrom).startOf('day').toDate(),
  effectiveTo: input.effectiveTo ? dayjs.utc(input.effectiveTo).startOf('day').toDate() : null,
  isActive: input.isActive ?? true,
});

export const listPayProfiles = (employeeId: string) =>
  prisma.employeePayProfile.findMany({
    where: { employeeId },
    orderBy: { effectiveFrom: 'desc' },
  });

export async function listEmployeePayConfigurations() {
  const today = dayjs.utc().startOf('day').toDate();
  const employees = await prisma.employee.findMany({
    where: { status: { in: ['ACTIVE', 'PROBATION'] } },
    orderBy: { employeeCode: 'asc' },
    select: {
      id: true, employeeCode: true, firstName: true, lastName: true, employmentType: true, baseSalary: true,
      attendanceRequired: true, leaveTrackingRequired: true,
      payProfiles: {
        where: { isActive: true, effectiveFrom: { lte: today }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }] },
        orderBy: { effectiveFrom: 'desc' }, take: 1,
      },
    },
  });
  return employees.map(({ payProfiles, ...employee }) => {
    const profile = payProfiles[0] ?? null;
    const legacyConfigured = new Prisma.Decimal(employee.baseSalary).greaterThan(0);
    return ({
    ...employee,
    exempt: !employee.attendanceRequired && !employee.leaveTrackingRequired,
    profile,
    paySource: profile ? 'PAY_PROFILE' : legacyConfigured ? 'LEGACY_BASE_SALARY' : 'UNCONFIGURED',
    legacyBaseSalary: employee.baseSalary,
  });
  });
}

export async function activePayProfile(employeeId: string, effectiveDate: Date) {
  return prisma.employeePayProfile.findFirst({
    where: {
      employeeId,
      isActive: true,
      effectiveFrom: { lte: effectiveDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveDate } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
}

/**
 * A wage rate has to be a positive amount of money.
 *
 * This used to reject any DAILY rate outside a fixed 60/75/93/100 whitelist.
 * That was too strong: the company negotiates rates that are not on the list -
 * 62, 82.50, 120 - and a validator that refuses them makes the system unable to
 * describe real employment terms. The four familiar values are now presets the
 * form offers for convenience, not the set of permissible wages.
 *
 * What remains enforced is what actually protects a payslip: the amount must be
 * a real, positive, two-decimal money value. A rate of 0 or a negative one is
 * not a cheaper wage, it is the absence of a wage, and the readiness screen
 * already has a word for that.
 */
function assertUsableRate(data: { payType: PayType; monthlySalary: Prisma.Decimal | null; hourlyRate: Prisma.Decimal | null }) {
  const amount = data.payType === PayType.HOURLY ? data.hourlyRate : data.monthlySalary;
  const label = data.payType === PayType.HOURLY ? 'อัตราค่าจ้างต่อชั่วโมง' : 'เงินเดือน';

  if (amount === null) throw badRequest(`กรุณาระบุ${label}`);
  if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) {
    throw badRequest(`${label}ต้องมากกว่า 0`);
  }
  // Money is stored at two decimal places; a third would be silently rounded
  // away on write, so the operator is told rather than quietly corrected.
  if (amount.decimalPlaces() > 2) {
    throw badRequest(`${label}ต้องมีทศนิยมไม่เกิน 2 ตำแหน่ง`);
  }
}

export async function createPayProfile(employeeId: string, input: PayProfileInput, actor: Actor) {
  if (!(await prisma.employee.count({ where: { id: employeeId } }))) throw notFound('Employee');
  const data = normalize(input);
  assertUsableRate(data);
  if (data.effectiveTo && data.effectiveTo < data.effectiveFrom) {
    throw badRequest('วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มใช้');
  }
  const overlaps = await prisma.employeePayProfile.findMany({
    where: {
      employeeId,
      isActive: true,
      effectiveFrom: { lte: data.effectiveTo ?? new Date('9999-12-31') },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: data.effectiveFrom } }],
    },
  });
  const exact = overlaps.find((profile) => profile.effectiveFrom.getTime() === data.effectiveFrom.getTime());
  const profile = await prisma.$transaction(async (tx) => {
    if (exact) {
      return tx.employeePayProfile.update({
        where: { id: exact.id },
        data: { ...data, updatedBy: actor.userId },
      });
    }
    const cannotCloseSafely = overlaps.some((profile) => profile.effectiveFrom >= data.effectiveFrom);
    if (cannotCloseSafely) throw badRequest('ช่วงวันที่ของอัตราค่าจ้างทับซ้อนกับรายการในอนาคต');
    const priorEnd = dayjs.utc(data.effectiveFrom).subtract(1, 'day').toDate();
    for (const prior of overlaps) {
      await tx.employeePayProfile.update({ where: { id: prior.id }, data: { effectiveTo: priorEnd, updatedBy: actor.userId } });
    }
    return tx.employeePayProfile.create({ data: { employeeId, ...data, createdBy: actor.userId, updatedBy: actor.userId } });
  });
  await recordAudit({
    action: exact ? 'EMPLOYEE_PAY_PROFILE_UPDATE' : 'EMPLOYEE_PAY_PROFILE_CREATE', entity: 'EmployeePayProfile', entityId: profile.id,
    oldValue: exact ? { payType: exact.payType, monthlySalary: exact.monthlySalary, hourlyRate: exact.hourlyRate, effectiveFrom: exact.effectiveFrom } : undefined,
    newValue: { employeeId, payType: profile.payType, effectiveFrom: profile.effectiveFrom },
    userId: actor.userId, userEmail: actor.email, ipAddress: actor.ip, userAgent: actor.userAgent,
  });
  return profile;
}
