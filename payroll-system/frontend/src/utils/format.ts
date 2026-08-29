import dayjs from 'dayjs';

const THAI_MONTHS = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
];

const THAI_MONTHS_SHORT = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
];

/**
 * Money is transported as a fixed 2dp string from the API and formatted only for
 * display, so no rounding decision is ever made in the browser.
 */
export function formatMoney(value: string | number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || value === '') return '-';
  const num = Number(value);
  if (Number.isNaN(num)) return String(value);
  return num.toLocaleString('th-TH', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatMoneyCompact(value: string | number | null | undefined): string {
  const num = Number(value ?? 0);
  if (Number.isNaN(num)) return '-';
  if (Math.abs(num) >= 1_000_000) return `${(num / 1_000_000).toFixed(2)} ล้าน`;
  if (Math.abs(num) >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toFixed(0);
}

export function formatNumber(value: string | number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || value === '') return '-';
  const num = Number(value);
  if (Number.isNaN(num)) return String(value);
  return num.toLocaleString('th-TH', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** "12 พ.ค. 2027" */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '-';
  const d = dayjs(value);
  if (!d.isValid()) return '-';
  return `${d.date()} ${THAI_MONTHS_SHORT[d.month()]} ${d.year()}`;
}

export function formatDateLong(value: string | Date | null | undefined): string {
  if (!value) return '-';
  const d = dayjs(value);
  if (!d.isValid()) return '-';
  return `${d.date()} ${THAI_MONTHS[d.month()]} ${d.year()}`;
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '-';
  const d = dayjs(value);
  if (!d.isValid()) return '-';
  return `${formatDate(value)} ${d.format('HH:mm')}`;
}

/**
 * Punch times are stored as UTC instants representing wall-clock time, so they
 * are rendered in UTC to show exactly the time recorded on the sheet.
 */
export function formatTime(value: string | Date | null | undefined): string {
  if (!value) return '-';
  // Read the UTC hour/minute directly rather than converting to the browser's
  // local zone, which would shift every punch by the machine's offset.
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toISOString().slice(11, 16);
}

export const formatIsoDate = (value: string | Date | null | undefined): string =>
  value ? dayjs(value).format('YYYY-MM-DD') : '';

/** 495 -> "8 ชม. 15 น." */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '-';
  if (minutes === 0) return '0';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} น.`;
  if (m === 0) return `${h} ชม.`;
  return `${h} ชม. ${m} น.`;
}

export const formatHours = (value: string | number | null | undefined): string =>
  value === null || value === undefined ? '-' : `${formatNumber(value, 2)}`;

export const thaiMonthName = (month: number): string => THAI_MONTHS[month - 1] ?? String(month);

export const employeeFullName = (e: {
  firstName?: string;
  lastName?: string;
  nickname?: string | null;
}): string => `${e.firstName ?? ''} ${e.lastName ?? ''}`.trim();
