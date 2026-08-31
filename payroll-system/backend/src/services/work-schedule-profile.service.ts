import { prisma } from '../plugins/prisma.js';
import type { Actor } from './payroll.service.js';
import { dayjs } from '../utils/datetime.js';
import { badRequest } from '../utils/errors.js';
import { recordAudit } from './audit.service.js';

export interface WorkScheduleProfileInput {
  name: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  workingDays: string[];
  workStartTime: string;
  workEndTime: string;
  flexArrivalMinutes: number;
  isActive?: boolean;
}

export const listWorkSchedules = () =>
  prisma.workScheduleProfile.findMany({ orderBy: { effectiveFrom: 'desc' } });

export async function createWorkSchedule(input: WorkScheduleProfileInput, actor: Actor) {
  const effectiveFrom = dayjs.utc(input.effectiveFrom).startOf('day').toDate();
  const effectiveTo = input.effectiveTo ? dayjs.utc(input.effectiveTo).startOf('day').toDate() : null;
  if (effectiveTo && effectiveTo < effectiveFrom) throw badRequest('วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มใช้');
  const overlap = await prisma.workScheduleProfile.count({
    where: {
      isActive: true,
      effectiveFrom: { lte: effectiveTo ?? new Date('9999-12-31') },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveFrom } }],
    },
  });
  if (overlap) throw badRequest('ช่วงวันที่ของตารางทำงานทับซ้อนกับรายการที่มีอยู่');
  const profile = await prisma.workScheduleProfile.create({
    data: {
      name: input.name, effectiveFrom, effectiveTo,
      workingDays: input.workingDays.join(','), workStartTime: input.workStartTime,
      workEndTime: input.workEndTime, flexArrivalMinutes: input.flexArrivalMinutes,
      isActive: input.isActive ?? true, createdBy: actor.userId, updatedBy: actor.userId,
    },
  });
  await recordAudit({
    action: 'WORK_SCHEDULE_CREATE', entity: 'WorkScheduleProfile', entityId: profile.id,
    newValue: { name: profile.name, effectiveFrom: profile.effectiveFrom, effectiveTo: profile.effectiveTo },
    userId: actor.userId, userEmail: actor.email, ipAddress: actor.ip, userAgent: actor.userAgent,
  });
  return profile;
}
