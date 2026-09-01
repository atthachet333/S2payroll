/**
 * The company calendar day, in company time.
 *
 * The browser's own timezone is not the company's. Deriving "this month" from
 * `new Date()` puts a user abroad - or one working either side of midnight -
 * into the wrong month by default, which on the first or last day of a month
 * means the page opens on a month the payroll office is not looking at.
 *
 * Intl is used rather than a date library so there is no dependency on a
 * plugin being registered, which is how the trend chart previously ended up
 * silently formatting Thai months in English.
 */
export const COMPANY_TIME_ZONE = 'Asia/Bangkok';

export interface BangkokDate {
  year: number;
  /** 1-12, not the 0-based month a Date carries. */
  month: number;
  day: number;
  /** YYYY-MM-DD in company time. */
  iso: string;
}

export function bangkokToday(now: Date = new Date()): BangkokDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: COMPANY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const pick = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');

  return {
    year,
    month,
    day,
    iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

/**
 * First and last calendar day of a month, as plain date strings.
 *
 * Deliberately string arithmetic rather than Date maths: attendance work dates
 * are stored as pure dates, and converting through an instant is how 31 August
 * ends up filed under September.
 */
export function monthRange(year: number, month: number): { from: string; to: string } {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    from: `${year}-${pad(month)}-01`,
    to: `${year}-${pad(month)}-${pad(lastDay)}`,
  };
}
