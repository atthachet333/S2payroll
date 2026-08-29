import Decimal from 'decimal.js';
import { Prisma } from '@prisma/client';

/**
 * All financial arithmetic in this system goes through decimal.js.
 * Native JavaScript numbers are never used to add, multiply or round money.
 *
 * Configuration:
 *   precision 28  - far beyond any payroll magnitude we handle
 *   ROUND_HALF_UP - the rounding convention used for Thai payroll and tax
 */
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

export type Money = Decimal;

type Numeric = Decimal | Prisma.Decimal | number | string | null | undefined;

/** Coerce anything Prisma or JSON can hand us into a Decimal. Null becomes 0. */
export function dec(value: Numeric): Decimal {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  if (value instanceof Decimal) return value;
  return new Decimal(value.toString());
}

/** Round to 2 dp using half-up - the canonical form for every stored money value. */
export function money(value: Numeric): Decimal {
  return dec(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Round to 2 dp and return the Prisma.Decimal that the client expects on write. */
export function toPrismaDecimal(value: Numeric): Prisma.Decimal {
  return new Prisma.Decimal(money(value).toFixed(2));
}

/** Round an hour quantity to 2 dp. */
export function hours(value: Numeric): Decimal {
  return dec(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function toPrismaHours(value: Numeric): Prisma.Decimal {
  return new Prisma.Decimal(hours(value).toFixed(2));
}

export const sum = (...values: Numeric[]): Decimal =>
  values.reduce<Decimal>((acc, v) => acc.plus(dec(v)), new Decimal(0));

export const sumMoney = (...values: Numeric[]): Decimal => money(sum(...values));

/** Serialise a Decimal for JSON responses as a fixed 2 dp string. */
export const moneyString = (value: Numeric): string => money(value).toFixed(2);

/** Minutes to hours as a Decimal (60 minutes -> 1.00). */
export const minutesToHours = (minutes: number): Decimal =>
  new Decimal(minutes).dividedBy(60).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export const isZero = (value: Numeric): boolean => dec(value).isZero();
