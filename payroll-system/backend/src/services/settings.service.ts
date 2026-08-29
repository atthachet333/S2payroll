import { prisma } from '../plugins/prisma.js';
import { DEFAULT_PAYROLL_SETTINGS, DEFAULT_SETTINGS_MAP } from '../config/payroll-defaults.js';
import { Decimal, dec } from '../utils/money.js';
import { timeStringToMinutes } from '../utils/datetime.js';
import { notFound } from '../utils/errors.js';

export type SettingsMap = Record<string, string>;

export interface TaxBracket {
  upTo: number | null;
  rate: number;
}

/**
 * Typed, validated view over the raw settings key/value table.
 * Every getter falls back to the seeded default, so a missing or deleted row can
 * never crash a payroll run - it degrades to the documented default instead.
 */
export class PayrollSettings {
  constructor(private readonly map: SettingsMap) {}

  raw(): SettingsMap {
    return { ...this.map };
  }

  private get(key: string): string {
    return this.map[key] ?? DEFAULT_SETTINGS_MAP[key] ?? '';
  }

  string(key: string): string {
    return this.get(key);
  }

  number(key: string): number {
    const parsed = Number(this.get(key));
    return Number.isFinite(parsed) ? parsed : Number(DEFAULT_SETTINGS_MAP[key] ?? 0);
  }

  decimal(key: string): Decimal {
    return dec(this.get(key) || DEFAULT_SETTINGS_MAP[key] || '0');
  }

  boolean(key: string): boolean {
    return this.get(key).toLowerCase() === 'true';
  }

  /** Minutes since midnight for an "HH:mm" setting. */
  timeMinutes(key: string): number {
    return timeStringToMinutes(this.get(key) || '00:00');
  }

  json<T>(key: string, fallback: T): T {
    try {
      return JSON.parse(this.get(key)) as T;
    } catch {
      return fallback;
    }
  }

  taxBrackets(): TaxBracket[] {
    const fallback = JSON.parse(DEFAULT_SETTINGS_MAP.TAX_BRACKETS) as TaxBracket[];
    const brackets = this.json<TaxBracket[]>('TAX_BRACKETS', fallback);
    return Array.isArray(brackets) && brackets.length > 0 ? brackets : fallback;
  }
}

export async function loadSettings(): Promise<PayrollSettings> {
  const rows = await prisma.payrollSetting.findMany();
  const map: SettingsMap = { ...DEFAULT_SETTINGS_MAP };
  for (const row of rows) map[row.key] = row.value;
  return new PayrollSettings(map);
}

/** Build a settings view from a frozen snapshot stored on a payroll period. */
export const settingsFromSnapshot = (snapshot: SettingsMap): PayrollSettings =>
  new PayrollSettings({ ...DEFAULT_SETTINGS_MAP, ...snapshot });

export async function listSettings(group?: string) {
  return prisma.payrollSetting.findMany({
    where: group ? { group } : undefined,
    orderBy: [{ group: 'asc' }, { key: 'asc' }],
  });
}

export async function updateSetting(key: string, value: string, userId: string) {
  const existing = await prisma.payrollSetting.findUnique({ where: { key } });
  if (!existing) throw notFound(`Setting ${key}`);
  return prisma.payrollSetting.update({
    where: { key },
    data: { value, updatedBy: userId },
  });
}

/** Insert any setting introduced since the database was first seeded. */
export async function ensureDefaultSettings(): Promise<number> {
  const existing = await prisma.payrollSetting.findMany({ select: { key: true } });
  const known = new Set(existing.map((s) => s.key));
  const missing = DEFAULT_PAYROLL_SETTINGS.filter((s) => !known.has(s.key));
  if (missing.length === 0) return 0;
  await prisma.payrollSetting.createMany({ data: missing });
  return missing.length;
}
