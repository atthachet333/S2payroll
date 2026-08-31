import { prisma } from '../plugins/prisma.js';
import { DEFAULT_PAYROLL_SETTINGS, DEFAULT_SETTINGS_MAP } from '../config/payroll-defaults.js';
import { Decimal, dec } from '../utils/money.js';
import { timeStringToMinutes } from '../utils/datetime.js';
import { badRequest, notFound } from '../utils/errors.js';

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

/** Resolve attendance/workweek values for a historical date. */
export async function loadSettingsForDate(date: Date): Promise<PayrollSettings> {
  const base = await loadSettings();
  const profile = await prisma.workScheduleProfile.findFirst({
    where: {
      isActive: true,
      effectiveFrom: { lte: date },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!profile) return base;
  return new PayrollSettings({
    ...base.raw(),
    WORKING_DAYS: profile.workingDays,
    WORK_START_TIME: profile.workStartTime,
    WORK_END_TIME: profile.workEndTime,
    LATE_GRACE_MINUTES: String(profile.flexArrivalMinutes),
  });
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

/**
 * Values that cannot be accepted as typed.
 *
 * The scheduler clamps the interval defensively as well, but rejecting it here
 * means the operator is told, rather than silently getting a different number
 * from the one they saved.
 */
function assertSettingValue(key: string, value: string): void {
  if (key === 'GOOGLE_SYNC_INTERVAL_SECONDS') {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || Math.floor(seconds) !== seconds || seconds < 30) {
      throw badRequest('รอบการอัปเดตต้องเป็นจำนวนเต็มและไม่น้อยกว่า 30 วินาที');
    }
  }
}

export async function updateSetting(key: string, value: string, userId: string) {
  const existing = await prisma.payrollSetting.findUnique({ where: { key } });
  if (!existing) throw notFound(`Setting ${key}`);
  assertSettingValue(key, value);
  return prisma.payrollSetting.update({
    where: { key },
    data: { value, updatedBy: userId },
  });
}

/**
 * Refresh the presentation metadata of existing settings from the code
 * defaults, without touching a single stored value.
 *
 * The database owns what a setting IS; the code owns how it is described. Once
 * a rule is withdrawn or a feature is not yet built, its label has to say so in
 * the Settings page, and that text only lives here.
 */
export async function syncSettingMetadata(): Promise<number> {
  const existing = await prisma.payrollSetting.findMany({
    select: { key: true, label: true, description: true, group: true, valueType: true },
  });
  const byKey = new Map(existing.map((s) => [s.key, s]));

  let updated = 0;
  for (const def of DEFAULT_PAYROLL_SETTINGS) {
    const current = byKey.get(def.key);
    if (!current) continue;
    const stale =
      current.label !== def.label ||
      (current.description ?? null) !== (def.description ?? null) ||
      current.group !== def.group ||
      current.valueType !== def.valueType;
    if (!stale) continue;
    await prisma.payrollSetting.update({
      where: { key: def.key },
      // value and updatedBy are deliberately absent - this never edits policy.
      data: {
        label: def.label,
        description: def.description ?? null,
        group: def.group,
        valueType: def.valueType,
      },
    });
    updated += 1;
  }
  return updated;
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
