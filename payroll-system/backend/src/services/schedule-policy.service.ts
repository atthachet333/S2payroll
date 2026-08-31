import type { PayrollSettings } from './settings.service.js';
import { dayjs } from '../utils/datetime.js';

export const WEEKDAY_TOKENS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
export type WeekdayToken = (typeof WEEKDAY_TOKENS)[number];
export type CalendarDayType = 'WORKING_DAY' | 'WEEKLY_OFF' | 'HOLIDAY';

export function workingDayTokens(settings: PayrollSettings): Set<WeekdayToken> {
  const configured = settings.string('WORKING_DAYS') || 'MON,TUE,WED,THU,FRI,SAT';
  return new Set(
    configured
      .split(',')
      .map((token) => token.trim().toUpperCase())
      .filter((token): token is WeekdayToken => WEEKDAY_TOKENS.includes(token as WeekdayToken))
  );
}

export function weekdayToken(date: Date): WeekdayToken {
  return WEEKDAY_TOKENS[dayjs.utc(date).day()];
}

export function isScheduledWorkday(date: Date, settings: PayrollSettings): boolean {
  return workingDayTokens(settings).has(weekdayToken(date));
}

export function getDayType(
  date: Date,
  settings: PayrollSettings,
  holidayDates: Set<string>
): CalendarDayType {
  const key = dayjs.utc(date).format('YYYY-MM-DD');
  if (holidayDates.has(key)) return 'HOLIDAY';
  return isScheduledWorkday(date, settings) ? 'WORKING_DAY' : 'WEEKLY_OFF';
}
