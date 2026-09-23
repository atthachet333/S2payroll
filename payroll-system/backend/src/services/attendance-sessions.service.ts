import type { AttendanceRawData } from '@prisma/client';
import { prisma } from '../plugins/prisma.js';
import { formatDateOnly, parseSheetTime } from '../utils/datetime.js';
import {
  resolveEventAttendance,
  sourceEventHash,
  type AttendanceSourceEvent,
} from './event-attendance.service.js';

export interface AttendanceSessionView {
  checkIn: Date | null;
  checkOut: Date | null;
  workedMinutes: number;
  checkInRawId: string | null;
  checkOutRawId: string | null;
  checkInClientRequestId: string | null;
  checkOutClientRequestId: string | null;
}

export interface AttendanceSessionsView {
  sessions: AttendanceSessionView[];
  sessionCount: number;
  completedWorkedMinutes: number;
  hasOpenSession: boolean;
  malformedSequence: boolean;
  attendanceIssues: string[];
}

type AttendanceLike = {
  employeeCode: string;
  workDate: Date;
  checkIn: Date | null;
  checkOut: Date | null;
  workedMinutes: number;
  status: unknown;
};

function payloadEvent(row: AttendanceRawData): AttendanceSourceEvent | null {
  const value = row.payload;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (!payload.type || !payload.time) return null;
  const string = (key: string) => String(payload[key] ?? '').trim();
  return {
    sheetRow: Number(payload.sheetRow ?? row.sheetRow ?? 0),
    timestamp: string('timestamp'),
    date: string('date') || row.rawDate,
    employeeCode: string('employeeCode') || string('empId') || row.employeeCode,
    displayName: string('displayName'),
    type: string('type'),
    time: string('time'),
    workHours: string('workHours'),
    lat: string('lat'),
    lng: string('lng'),
    summary: string('summary'),
    employmentType: string('employmentType'),
    userId: string('userId'),
    clientRequestId: string('clientRequestId'),
  };
}

/**
 * Add an event-level session view without changing the one-row-per-day schema.
 * All event identity comes from the immutable raw archive.
 */
export async function attachAttendanceSessions<T extends AttendanceLike>(items: T[]): Promise<Array<T & AttendanceSessionsView & { status: string }>> {
  if (items.length === 0) return [];
  const employeeCodes = [...new Set(items.map((item) => item.employeeCode))];
  const dates = [...new Set(items.map((item) => formatDateOnly(item.workDate)))];
  const raw = await prisma.attendanceRawData.findMany({
    where: { employeeCode: { in: employeeCodes }, rawDate: { in: dates } },
    orderBy: [{ sheetRow: 'asc' }, { createdAt: 'asc' }],
  });
  const rawByKey = new Map<string, AttendanceRawData[]>();
  for (const row of raw) {
    const key = `${row.employeeCode}|${row.rawDate}`;
    rawByKey.set(key, [...(rawByKey.get(key) ?? []), row]);
  }

  return items.map((item) => {
    const date = formatDateOnly(item.workDate);
    const rows = rawByKey.get(`${item.employeeCode}|${date}`) ?? [];
    const events = rows.map(payloadEvent).filter((event): event is AttendanceSourceEvent => Boolean(event));
    if (events.length === 0) {
      const fallback = item.checkIn || item.checkOut
        ? [{
            checkIn: item.checkIn,
            checkOut: item.checkOut,
            workedMinutes: item.workedMinutes,
            checkInRawId: null,
            checkOutRawId: null,
            checkInClientRequestId: null,
            checkOutClientRequestId: null,
          }]
        : [];
      return {
        ...item,
        status: String(item.status),
        sessions: fallback,
        sessionCount: fallback.length,
        completedWorkedMinutes: item.workedMinutes,
        hasOpenSession: Boolean(item.checkIn && !item.checkOut),
        malformedSequence: false,
        attendanceIssues: [],
      };
    }

    const resolved = resolveEventAttendance(events)[0];
    const rawByHash = new Map(rows.map((row) => [row.rowHash, row]));
    const sessions = resolved.sessions.map((session) => {
      const inRaw = session.checkIn ? rawByHash.get(sourceEventHash(session.checkIn)) : undefined;
      const outRaw = session.checkOut ? rawByHash.get(sourceEventHash(session.checkOut)) : undefined;
      return {
        checkIn: session.checkIn ? parseSheetTime(item.workDate, session.checkIn.time) : null,
        checkOut: session.checkOut ? parseSheetTime(item.workDate, session.checkOut.time) : null,
        workedMinutes: session.durationMinutes,
        checkInRawId: inRaw?.id ?? null,
        checkOutRawId: outRaw?.id ?? null,
        checkInClientRequestId: session.checkIn?.clientRequestId || null,
        checkOutClientRequestId: session.checkOut?.clientRequestId || null,
      };
    });
    return {
      ...item,
      status: resolved.hasOpenSession && !resolved.malformedSequence ? 'IN_PROGRESS' : String(item.status),
      sessions,
      sessionCount: sessions.length,
      completedWorkedMinutes: resolved.completedWorkedMinutes,
      hasOpenSession: resolved.hasOpenSession,
      malformedSequence: resolved.malformedSequence,
      attendanceIssues: resolved.malformedSequence ? [resolved.reason] : [],
    };
  });
}
