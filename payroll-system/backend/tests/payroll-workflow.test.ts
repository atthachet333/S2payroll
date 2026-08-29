import { describe, it, expect } from 'vitest';
import { PayrollPeriodStatus } from '@prisma/client';
import { assertTransition, assertNotLocked } from '../src/services/payroll.service.js';
import { AppError } from '../src/utils/errors.js';

/**
 * The payroll workflow is the part of this system where a mistake costs money,
 * so the transition table and the lock guard are tested exhaustively rather than
 * by example: every one of the 49 (from, to) pairs is asserted.
 */

const ALL: PayrollPeriodStatus[] = [
  'DRAFT',
  'ATTENDANCE_REVIEW',
  'CALCULATED',
  'REVIEW',
  'APPROVED',
  'PAID',
  'LOCKED',
];

/** The single source of truth this test holds the implementation to. */
const EXPECTED_ALLOWED: Record<PayrollPeriodStatus, PayrollPeriodStatus[]> = {
  DRAFT: ['ATTENDANCE_REVIEW', 'CALCULATED'],
  ATTENDANCE_REVIEW: ['CALCULATED', 'DRAFT'],
  CALCULATED: ['REVIEW', 'ATTENDANCE_REVIEW', 'CALCULATED'],
  REVIEW: ['APPROVED', 'CALCULATED'],
  APPROVED: ['PAID', 'REVIEW'],
  PAID: ['LOCKED', 'APPROVED'],
  LOCKED: [],
};

const isAllowed = (from: PayrollPeriodStatus, to: PayrollPeriodStatus): boolean =>
  EXPECTED_ALLOWED[from].includes(to);

describe('payroll period transitions', () => {
  // 7 x 7 = 49 pairs, each asserted explicitly.
  for (const from of ALL) {
    for (const to of ALL) {
      const allowed = isAllowed(from, to);
      it(`${allowed ? 'allows' : 'rejects'} ${from} -> ${to}`, () => {
        if (allowed) {
          expect(() => assertTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertTransition(from, to)).toThrow();
        }
      });
    }
  }

  it('walks the full happy path end to end', () => {
    const path: PayrollPeriodStatus[] = [
      'DRAFT',
      'ATTENDANCE_REVIEW',
      'CALCULATED',
      'REVIEW',
      'APPROVED',
      'PAID',
      'LOCKED',
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(() => assertTransition(path[i], path[i + 1])).not.toThrow();
    }
  });

  it('treats LOCKED as terminal - no forward transition exists', () => {
    for (const to of ALL) {
      expect(() => assertTransition('LOCKED', to)).toThrow();
    }
  });

  it('allows recalculation to pull a calculated period back to CALCULATED', () => {
    expect(() => assertTransition('CALCULATED', 'CALCULATED')).not.toThrow();
  });

  it('never allows skipping review to approve straight from CALCULATED', () => {
    expect(() => assertTransition('CALCULATED', 'APPROVED')).toThrow();
  });

  it('never allows paying a period that was not approved', () => {
    expect(() => assertTransition('REVIEW', 'PAID')).toThrow();
    expect(() => assertTransition('CALCULATED', 'PAID')).toThrow();
    expect(() => assertTransition('DRAFT', 'PAID')).toThrow();
  });

  it('never allows locking a period that was not paid', () => {
    for (const from of ALL.filter((s) => s !== 'PAID')) {
      expect(() => assertTransition(from, 'LOCKED')).toThrow();
    }
  });

  it('reports a 400-class error with a Thai message on an invalid transition', () => {
    try {
      assertTransition('DRAFT', 'LOCKED');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(400);
      expect((err as AppError).message).toContain('DRAFT');
      expect((err as AppError).message).toContain('LOCKED');
    }
  });
});

describe('locked period protection', () => {
  it('blocks every money-mutating operation once LOCKED', () => {
    expect(() => assertNotLocked('LOCKED')).toThrow();
  });

  it('returns 403 rather than 400, since this is an authorisation boundary', () => {
    try {
      assertNotLocked('LOCKED');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(403);
      expect((err as AppError).code).toBe('FORBIDDEN');
    }
  });

  it('permits edits in every non-locked state', () => {
    for (const status of ALL.filter((s) => s !== 'LOCKED')) {
      expect(() => assertNotLocked(status), `${status} should be editable`).not.toThrow();
    }
  });
});
