import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button, Select } from '@/components/ui';
import { thaiMonthName } from '@/utils/format';
import { bangkokToday } from '@/utils/bangkok';

/**
 * Month navigation for the employee record.
 *
 * It exists because the previous controls lived in one card while the history
 * tabs lived in another, several sections further down the page. The months
 * were reachable but nobody could find them, which made a September visit look
 * as though August had been lost.
 *
 * The same component is rendered beside every section it governs, driven by one
 * piece of page state, so moving between tabs keeps the chosen month.
 */
export interface MonthValue {
  year: number;
  month: number;
}

/** The current month in company time, not in the browser's timezone. */
export function currentBangkokMonth(): MonthValue {
  const today = bangkokToday();
  return { year: today.year, month: today.month };
}

/** Month arithmetic on an absolute month index, so December wraps correctly. */
export function shiftMonth(value: MonthValue, delta: number): MonthValue {
  const index = value.year * 12 + (value.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export const previousMonth = (value: MonthValue) => shiftMonth(value, -1);

const YEAR_SPAN = 6;

export default function MonthSelector({
  value,
  onChange,
  className,
}: {
  value: MonthValue;
  onChange: (next: MonthValue) => void;
  className?: string;
}) {
  const now = currentBangkokMonth();
  const isCurrent = value.year === now.year && value.month === now.month;
  // Forward navigation stops at the current month: a payroll system has no
  // future attendance, and an endless run of empty months is not navigation.
  const atLatest = value.year > now.year || (value.year === now.year && value.month >= now.month);

  const shift = (delta: number) => onChange(shiftMonth(value, delta));

  const years = Array.from({ length: YEAR_SPAN }, (_, i) => now.year - (YEAR_SPAN - 1) + i);

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className ?? ''}`}>
      <Button
        variant="outline"
        size="icon"
        aria-label="เดือนก่อนหน้า"
        title="เดือนก่อนหน้า"
        onClick={() => shift(-1)}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>

      <Select
        aria-label="เดือน"
        className="h-8 w-28 text-xs"
        value={String(value.month)}
        onChange={(event) => onChange({ ...value, month: Number(event.target.value) })}
      >
        {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
          <option key={m} value={m}>
            {thaiMonthName(m)}
          </option>
        ))}
      </Select>

      <Select
        aria-label="ปี"
        className="h-8 w-20 text-xs"
        value={String(value.year)}
        onChange={(event) => onChange({ ...value, year: Number(event.target.value) })}
      >
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </Select>

      <Button
        variant="outline"
        size="icon"
        aria-label="เดือนถัดไป"
        title={atLatest ? 'ยังไม่มีข้อมูลของเดือนถัดไป' : 'เดือนถัดไป'}
        disabled={atLatest}
        onClick={() => shift(1)}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>

      <Button
        variant="outline"
        size="sm"
        disabled={isCurrent}
        onClick={() => onChange(now)}
      >
        เดือนนี้
      </Button>
    </div>
  );
}
