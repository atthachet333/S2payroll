import type { LeaveType } from '@prisma/client';
import { prisma } from '../plugins/prisma.js';
import { eachDay, formatDateOnly } from '../utils/datetime.js';

type DatedEmployeeRecord = { employeeId: string; workDate: Date };

/** Attach the approved leave category that explains a LEAVE attendance day. */
export async function attachLeaveTypes<T extends DatedEmployeeRecord>(records: T[]): Promise<Array<T & {
  leaveType: LeaveType | null;
}>> {
  if (records.length === 0) return [];
  const employeeIds = [...new Set(records.map((record) => record.employeeId))];
  const times = records.map((record) => record.workDate.getTime());
  const from = new Date(Math.min(...times));
  const to = new Date(Math.max(...times));
  const leaves = await prisma.leaveRecord.findMany({
    where: {
      employeeId: { in: employeeIds },
      status: 'APPROVED',
      startDate: { lte: to },
      endDate: { gte: from },
    },
    select: { employeeId: true, startDate: true, endDate: true, leaveType: true },
  });
  const byDay = new Map<string, LeaveType>();
  for (const leave of leaves) {
    for (const date of eachDay(leave.startDate, leave.endDate)) {
      byDay.set(`${leave.employeeId}:${formatDateOnly(date)}`, leave.leaveType);
    }
  }
  return records.map((record) => ({
    ...record,
    leaveType: byDay.get(`${record.employeeId}:${formatDateOnly(record.workDate)}`) ?? null,
  }));
}
