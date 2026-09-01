import { EmploymentType, PayrollEmployeeStatus } from '@prisma/client';

/**
 * The one place that decides whether an employee is ready to be paid.
 *
 * Readiness is per employee, never per period. One person with a missing punch
 * or an unset wage rate must not stop everybody else from being calculated, so
 * every payroll row carries its own state and its own reasons, and the period
 * reports the mix rather than refusing to run.
 *
 * Both the pre-payroll check (before any money is computed) and the calculator
 * (after) resolve status through this function, on the same inputs, so the
 * readiness screen can never promise something the calculation then contradicts.
 *
 * Order matters - the first condition that holds wins, most fundamental first:
 *
 *   EXCLUDED              not payable under company policy
 *   UNCONFIGURED          no usable wage rate: worked time only, never money
 *   ATTENDANCE_INCOMPLETE a past day has one punch missing
 *   PARTIAL               calculated, but not yet a settled figure
 *   READY                 complete and final
 */
export interface ReadinessInput {
  employmentType: EmploymentType;
  /** Excluded from payroll by company policy (e.g. attendance-exempt with no rate). */
  excluded: boolean;
  /** A usable wage rate exists for this employee in this period. */
  payConfigured: boolean;
  attendanceRequired: boolean;
  missingDataDays: number;
  missingCheckInDays: number;
  missingCheckOutDays: number;
  presentDays: number;
  workingDays: number;
  absentDays: number;
  /** Days worked that no pay-rate range covers. Money is not invented for them. */
  unratedDays: number;
  /** Net pay came out below zero. */
  netNegative: boolean;
  /** The period is still open, so the figures are a preview. */
  isEstimate: boolean;
}

export interface Readiness {
  status: PayrollEmployeeStatus;
  reasons: string[];
  /** What the UI should offer to resolve this row, if anything. */
  action: ReadinessAction | null;
}

/**
 * Actions the UI can offer, so a readiness row is never a dead end.
 *
 * RECORD_ATTENDANCE and FIX_ATTENDANCE share a status but not a remedy: an
 * employee with no attendance at all needs time recorded, while one with a
 * half-punched day needs that day corrected. Sending the first case to the
 * missing-punch filter would show them an empty list.
 */
export type ReadinessAction = 'SET_PAY' | 'FIX_ATTENDANCE' | 'RECORD_ATTENDANCE';

/** Statuses whose amounts must never be treated as a final salary. */
export const NON_FINAL_STATUSES: PayrollEmployeeStatus[] = [
  PayrollEmployeeStatus.UNCONFIGURED,
  PayrollEmployeeStatus.ATTENDANCE_INCOMPLETE,
  PayrollEmployeeStatus.MISSING_DATA,
];

export function resolveReadiness(input: ReadinessInput): Readiness {
  if (input.excluded) {
    return {
      status: PayrollEmployeeStatus.EXCLUDED,
      reasons: ['ยกเว้นจากการคำนวณเงินเดือนตามนโยบายบริษัท'],
      action: null,
    };
  }

  if (!input.payConfigured) {
    const monthly =
      input.employmentType === EmploymentType.MONTHLY ||
      input.employmentType === EmploymentType.CONTRACT;
    return {
      status: PayrollEmployeeStatus.UNCONFIGURED,
      reasons: [
        monthly
          ? 'ยังไม่ได้กำหนดเงินเดือน — ยอดนี้ยังไม่ใช่เงินเดือนสุทธิจริง'
          : 'ยังไม่ได้กำหนดอัตราค่าจ้าง — ยอดนี้ยังไม่ใช่ค่าจ้างจริง',
      ],
      action: 'SET_PAY',
    };
  }

  if (input.attendanceRequired && input.missingDataDays > 0) {
    const parts: string[] = [];
    if (input.missingCheckInDays > 0) parts.push(`ไม่มีเวลาเข้า ${input.missingCheckInDays} วัน`);
    if (input.missingCheckOutDays > 0) parts.push(`ไม่มีเวลาออก ${input.missingCheckOutDays} วัน`);
    return {
      status: PayrollEmployeeStatus.ATTENDANCE_INCOMPLETE,
      reasons: [
        `มีข้อมูลเข้า-ออกไม่ครบ ${input.missingDataDays} วัน` +
          (parts.length > 0 ? ` (${parts.join(', ')})` : ''),
      ],
      action: 'FIX_ATTENDANCE',
    };
  }

  if (input.attendanceRequired && input.presentDays === 0 && input.workingDays > 0) {
    return {
      status: PayrollEmployeeStatus.ATTENDANCE_INCOMPLETE,
      reasons: ['ไม่พบข้อมูลการลงเวลาในรอบนี้'],
      action: 'RECORD_ATTENDANCE',
    };
  }

  const reasons: string[] = [];
  if (input.netNegative) reasons.push('เงินสุทธิติดลบ กรุณาตรวจสอบรายการหัก');
  if (input.absentDays > 0) reasons.push(`ขาดงาน ${input.absentDays} วัน`);
  if (input.unratedDays > 0) {
    reasons.push(
      `มี ${input.unratedDays} วันที่ยังไม่มีอัตราค่าจ้างครอบคลุม — วันเหล่านั้นยังไม่ถูกคิดเป็นเงิน`
    );
  }
  if (input.isEstimate) reasons.push('รอบเงินเดือนยังไม่สิ้นสุด ยอดนี้เป็นประมาณการ');

  return {
    status: reasons.length > 0 ? PayrollEmployeeStatus.PARTIAL : PayrollEmployeeStatus.READY,
    reasons,
    action: null,
  };
}
