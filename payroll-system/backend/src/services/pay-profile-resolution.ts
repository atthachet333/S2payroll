import { EmploymentType, PayType, type EmployeePayProfile } from '@prisma/client';
import { dec } from '../utils/money.js';

export type PayProfileLike = Pick<
  EmployeePayProfile,
  'id' | 'payType' | 'monthlySalary' | 'hourlyRate' | 'effectiveFrom' | 'effectiveTo' | 'isActive'
>;

export function profileCoversDate(profile: PayProfileLike, effectiveDate: Date): boolean {
  return profile.isActive
    && profile.effectiveFrom <= effectiveDate
    && (profile.effectiveTo === null || profile.effectiveTo >= effectiveDate);
}

/** One canonical type/rate rule shared by employee completeness and payroll readiness. */
export function isUsablePayProfile(
  profile: PayProfileLike,
  employmentType: EmploymentType
): boolean {
  if (!profile.isActive) return false;
  if (employmentType === EmploymentType.MONTHLY || employmentType === EmploymentType.CONTRACT) {
    return profile.payType === PayType.MONTHLY
      && dec(profile.monthlySalary ?? 0).greaterThan(0);
  }
  return profile.payType === PayType.HOURLY
    && dec(profile.hourlyRate ?? 0).greaterThan(0);
}

/** Most recent valid profile covering the requested date; mismatched old profiles never qualify. */
export function resolveEffectivePayProfile<T extends PayProfileLike>(
  profiles: readonly T[],
  employmentType: EmploymentType,
  effectiveDate: Date
): T | null {
  const matching = profiles.filter(
    (profile) => profileCoversDate(profile, effectiveDate)
      && isUsablePayProfile(profile, employmentType)
  );
  if (matching.length === 0) return null;
  return matching.reduce((latest, profile) =>
    profile.effectiveFrom > latest.effectiveFrom ? profile : latest
  );
}
