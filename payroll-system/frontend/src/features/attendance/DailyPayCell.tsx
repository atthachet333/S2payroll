import * as React from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';
import { formatMinutes, formatMoney, formatNumber } from '@/utils/format';
import { cn } from '@/utils/cn';
import type { DailyPay } from '@/types';

/**
 * The "ได้เงินวันนี้" cell, and the explanation behind it.
 *
 * Every figure is computed by the backend - the table never derives money - but
 * a correct number nobody can account for is still a problem. Payroll staff
 * have to be able to answer "ทำไมยอดนี้ถึงได้เท่านี้?" from the screen, so the
 * cell opens a full trail: what was actually worked, what the break took, what
 * the rounding discarded, what remained, and the arithmetic that turned it into
 * money. None of it re-derives anything; it displays what the server sent.
 *
 * An employee with no configured rate reads "ยังไม่กำหนด" rather than ฿0.00,
 * because a zero here would look like a settled amount of nothing earned.
 */
export function DailyPayCell({ dailyPay }: { dailyPay: DailyPay | null | undefined }) {
  const [anchor, setAnchor] = React.useState<{ top: number; right: number } | null>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);

  // The attendance table scrolls horizontally, and an absolutely-positioned
  // panel inside an overflow container is clipped by it. Measuring the button
  // and rendering into document.body sidesteps the container entirely.
  const toggle = () => {
    if (anchor) {
      setAnchor(null);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
  };

  if (!dailyPay) return <span className="text-muted-foreground">-</span>;

  if (dailyPay.status === 'UNCONFIGURED') {
    return (
      <span className="text-warning" title={dailyPay.note ?? undefined}>
        ยังไม่กำหนด
      </span>
    );
  }

  if (dailyPay.status === 'NOT_APPLICABLE') {
    const pending = dailyPay.note === 'ข้อมูลเวลายังไม่ครบ';
    return (
      <span className={pending ? 'text-info' : 'text-muted-foreground'} title={dailyPay.note ?? undefined}>
        {pending ? 'กำลังคำนวณ' : '-'}
      </span>
    );
  }

  const adjusted =
    Number(dailyPay.attendanceDeduction) > 0 ||
    dailyPay.breakDeductionMinutes > 0 ||
    dailyPay.roundedAwayMinutes > 0;

  return (
    <span className="relative inline-flex items-center justify-end gap-1">
      <span className={cn('tabular-nums', adjusted && 'text-warning')}>
        ฿{formatMoney(dailyPay.net)}
      </span>
      <button
        ref={buttonRef}
        type="button"
        aria-label="ดูวิธีคิดยอดนี้"
        title="ดูวิธีคิดยอดนี้"
        onClick={(event) => {
          event.stopPropagation();
          toggle();
        }}
        onBlur={() => setAnchor(null)}
        className="rounded text-muted-foreground transition hover:text-primary"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      {anchor && <PayExplanation pay={dailyPay} anchor={anchor} />}
    </span>
  );
}

/** The itemised trail. Every line is a value the server already computed. */
function PayExplanation({
  pay,
  anchor,
}: {
  pay: DailyPay;
  anchor: { top: number; right: number };
}) {
  const hourly = pay.basisKind === 'HOURLY_RATE';
  const decimalHours = (pay.payableMinutes / 60).toFixed(2);

  return createPortal(
    <div
      style={{ top: anchor.top, right: Math.max(8, anchor.right) }}
      className="fixed z-50 w-72 rounded-lg border border-border bg-white p-3 text-left text-xs shadow-pop"
      onMouseDown={(event) => event.preventDefault()}
    >
      <p className="mb-2 font-semibold">วิธีคิดยอดวันนี้</p>
      <dl className="space-y-1">
        {hourly ? (
          <>
            <Line label="เวลาทำงานจริง" value={formatMinutes(pay.minutesBeforeRounding + pay.breakDeductionMinutes)} />
            <Line
              label="หักเวลาพัก"
              value={pay.breakDeductionMinutes > 0 ? formatMinutes(pay.breakDeductionMinutes) : '0 นาที'}
            />
            <Line label="หลังหักพัก" value={formatMinutes(pay.minutesBeforeRounding)} />
            <Line
              label="ปัดเวลาออก"
              value={pay.roundedAwayMinutes > 0 ? `${formatNumber(pay.roundedAwayMinutes)} นาที` : '0 นาที'}
              tone={pay.roundedAwayMinutes > 0 ? 'text-warning' : undefined}
            />
            <Line label="เวลาที่ใช้คิดเงิน" value={formatMinutes(pay.payableMinutes)} emphasis />
            <Line label="ชั่วโมงทศนิยม" value={`${decimalHours} ชั่วโมง`} />
            <Line label="อัตรา" value={`${formatMoney(pay.basis)} บาท/ชม.`} />
          </>
        ) : (
          <>
            <Line label="ฐานต่อวัน" value={`${formatMoney(pay.gross)} บาท`} />
            {pay.lateMinutesActual > 0 && (
              <>
                <Line label="เวลามาสายจริง" value={`${formatNumber(pay.lateMinutesActual)} นาที`} />
                <Line
                  label="มาสายหลังปัด"
                  value={`${formatNumber(pay.lateMinutesRounded)} นาที`}
                  tone={pay.lateMinutesRounded === 0 ? 'text-success' : undefined}
                />
                <Line label="ชั่วโมงที่ใช้หัก" value={`${formatNumber(pay.lateChargedHours)} ชั่วโมง`} />
              </>
            )}
          </>
        )}

        {Number(pay.lateDeduction) > 0 && (
          <Line label="หักมาสาย" value={`-${formatMoney(pay.lateDeduction)}`} tone="text-danger" />
        )}
        {Number(pay.leaveDeduction) > 0 && (
          <Line label="หักลา" value={`-${formatMoney(pay.leaveDeduction)}`} tone="text-danger" />
        )}
        {Number(pay.absenceDeduction) > 0 && (
          <Line label="หักขาดงาน" value={`-${formatMoney(pay.absenceDeduction)}`} tone="text-danger" />
        )}

        <div className="!mt-2 border-t border-border pt-1.5">
          <Line
            label={hourly ? 'ค่าจ้างวันนี้' : 'มูลค่าวันนี้'}
            value={`${formatMoney(pay.net)} บาท`}
            emphasis
          />
        </div>
      </dl>

      {!hourly && (
        // Monthly staff are not paid per day; saying so stops the column being
        // read as a daily wage the company owes.
        <p className="mt-2 text-[11px] text-muted-foreground">
          ค่าประกอบการพิจารณา ไม่ใช่ยอดจ่ายรายวัน · ประกันสังคมและภาษีคิดเป็นรายเดือน
          จึงไม่ถูกเฉลี่ยลงรายวัน
        </p>
      )}
    </div>,
    document.body
  );
}

const Line = ({
  label,
  value,
  tone,
  emphasis,
}: {
  label: string;
  value: string;
  tone?: string;
  emphasis?: boolean;
}) => (
  <div className="flex items-baseline justify-between gap-3">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className={cn('tabular-nums', emphasis && 'font-semibold', tone)}>{value}</dd>
  </div>
);

export default DailyPayCell;
