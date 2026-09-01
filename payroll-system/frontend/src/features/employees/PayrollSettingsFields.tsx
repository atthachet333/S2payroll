import { Field, Input, InfoRow, Select } from '@/components/ui';
import {
  ABSENCE_DEDUCTION_LABELS,
  LATE_DEDUCTION_LABELS,
  LEAVE_DEDUCTION_LABELS,
} from '@/components/StatusBadge';
import { formatMoney } from '@/utils/format';
import { cn } from '@/utils/cn';
import type {
  AbsenceDeductionType,
  EmployeePayrollPolicy,
  EmployeePayrollPolicyInput,
  LateDeductionType,
  LeaveDeductionType,
} from '@/types';

/**
 * The per-employee payroll settings, in one place.
 *
 * Employee Edit renders the editable form and Employee Detail renders the
 * read-only summary from this same module, over the same shape, so the two
 * screens cannot drift into describing one employee's rules differently.
 */

// ---------------------------------------------------------------------------
// Daily hourly-rate selector
// ---------------------------------------------------------------------------

/**
 * Rates the daily-rate form offers as quick picks.
 *
 * Suggestions, not a whitelist. The API accepts any positive money amount -
 * restricting wages to a fixed list made the system unable to record genuinely
 * negotiated rates like 62 or 82.50. The server exposes the same list from
 * settings; this is the fallback if that call has not resolved yet.
 */
export const DAILY_HOURLY_RATE_PRESETS = [60, 75, 93, 100] as const;

/** Money with at most two decimal places, or empty. Anything else is refused. */
export function validateHourlyRate(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return 'กรอกเป็นจำนวนเงิน ทศนิยมไม่เกิน 2 ตำแหน่ง';
  }
  if (Number(trimmed) <= 0) return 'อัตราค่าจ้างต้องมากกว่า 0';
  return null;
}

export function DailyRateSelector({
  value,
  onChange,
  disabled,
  presets = DAILY_HOURLY_RATE_PRESETS as readonly number[],
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  presets?: readonly number[];
}) {
  const error = validateHourlyRate(value);
  const current = value.trim() === '' ? null : Number(value);

  return (
    <div className="sm:col-span-2">
      <Field
        label="อัตราค่าจ้างต่อชั่วโมง"
        error={error}
        hint="พิมพ์อัตราที่ตกลงกันจริง หรือเลือกจากอัตราที่ใช้บ่อยด้านล่าง"
      >
        <div className="flex items-center gap-2">
          <Input
            type="number"
            inputMode="decimal"
            min="0.01"
            step="0.01"
            value={value}
            disabled={disabled}
            aria-label="อัตราค่าจ้างต่อชั่วโมง"
            placeholder="เช่น 82.50"
            onChange={(e) => onChange(e.target.value)}
            className="text-right tabular-nums"
          />
          <span className="shrink-0 text-sm text-muted-foreground">บาท / ชั่วโมง</span>
        </div>
      </Field>

      {presets.length > 0 && (
        <div className="mt-2">
          <p className="mb-1.5 text-xs text-muted-foreground">อัตราที่ใช้บ่อย:</p>
          <div className="flex flex-wrap gap-2">
            {presets.map((rate) => {
              // Highlighted only to show which preset the current amount equals;
              // the typed value remains the source of truth either way.
              const active = current !== null && current === rate;
              return (
                <button
                  key={rate}
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange(String(rate))}
                  className={cn(
                    'rounded-lg border px-3.5 py-1.5 text-sm font-semibold tabular-nums transition',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                    active
                      ? 'border-primary bg-primary/10 ring-1 ring-primary'
                      : 'border-border hover:border-primary/40 hover:bg-secondary/60'
                  )}
                >
                  {rate}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <p className="mt-2 text-xs text-muted-foreground">
        ระบบไม่กำหนดอัตราให้พนักงานเอง กรุณาระบุอัตราที่ตกลงกันจริง
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Policy form state
// ---------------------------------------------------------------------------

export interface PolicyFormState {
  lateDeductionType: string;
  lateDeductionAmount: string;
  leaveDeductionType: string;
  leaveDeductionAmount: string;
  absenceDeductionType: string;
  absenceDeductionAmount: string;
  socialSecurityAmount: string;
  taxAmount: string;
}

export const emptyPolicyForm = (): PolicyFormState => ({
  lateDeductionType: '',
  lateDeductionAmount: '',
  leaveDeductionType: '',
  leaveDeductionAmount: '',
  absenceDeductionType: '',
  absenceDeductionAmount: '',
  socialSecurityAmount: '',
  taxAmount: '',
});

export const policyFormFrom = (policy: EmployeePayrollPolicy | null): PolicyFormState => ({
  lateDeductionType: policy?.lateDeductionType ?? '',
  lateDeductionAmount: policy?.lateDeductionAmount ?? '',
  leaveDeductionType: policy?.leaveDeductionType ?? '',
  leaveDeductionAmount: policy?.leaveDeductionAmount ?? '',
  absenceDeductionType: policy?.absenceDeductionType ?? '',
  absenceDeductionAmount: policy?.absenceDeductionAmount ?? '',
  socialSecurityAmount: policy?.socialSecurityAmount ?? '',
  taxAmount: policy?.taxAmount ?? '',
});

/**
 * An empty box means "not configured - use the company default", which is not
 * the same thing as 0. A typed 0 is a deliberate "deduct nothing" and is sent
 * through as a value.
 */
const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

export const policyFormToInput = (form: PolicyFormState): EmployeePayrollPolicyInput => ({
  lateDeductionType: (orNull(form.lateDeductionType) as LateDeductionType | null) ?? null,
  lateDeductionAmount: orNull(form.lateDeductionAmount),
  leaveDeductionType: (orNull(form.leaveDeductionType) as LeaveDeductionType | null) ?? null,
  leaveDeductionAmount: orNull(form.leaveDeductionAmount),
  absenceDeductionType: (orNull(form.absenceDeductionType) as AbsenceDeductionType | null) ?? null,
  absenceDeductionAmount: orNull(form.absenceDeductionAmount),
  socialSecurityAmount: orNull(form.socialSecurityAmount),
  taxAmount: orNull(form.taxAmount),
});

export const policyFormsEqual = (a: PolicyFormState, b: PolicyFormState): boolean =>
  (Object.keys(a) as (keyof PolicyFormState)[]).every((key) => a[key] === b[key]);

const USE_COMPANY_DEFAULT = 'ใช้ค่าเริ่มต้นของบริษัท';

// ---------------------------------------------------------------------------
// Editable form
// ---------------------------------------------------------------------------

export function PayrollPolicyFields({
  form,
  onChange,
  disabled,
}: {
  form: PolicyFormState;
  onChange: (next: PolicyFormState) => void;
  disabled?: boolean;
}) {
  const set = <K extends keyof PolicyFormState>(key: K, value: string) =>
    onChange({ ...form, [key]: value });

  return (
    <>
      <div className="rounded-lg border border-border bg-secondary/40 px-3.5 py-3 sm:col-span-2">
        <p className="text-sm font-medium">การตั้งค่าเงินเดือน</p>
        <p className="mt-1 text-xs text-muted-foreground">
          เว้นว่างไว้เพื่อใช้ค่าเริ่มต้นของบริษัท · กรอก 0 หมายถึงไม่หักเงินรายการนั้น
        </p>
      </div>

      <DeductionRule
        label="การหักมาสาย"
        typeValue={form.lateDeductionType}
        amountValue={form.lateDeductionAmount}
        options={LATE_DEDUCTION_LABELS}
        amountLabel="จำนวนเงิน (บาท ต่อ 1 ชั่วโมงที่สาย ปัดขึ้น)"
        disabled={disabled}
        onTypeChange={(v) => set('lateDeductionType', v)}
        onAmountChange={(v) => set('lateDeductionAmount', v)}
      />

      <DeductionRule
        label="การหักลา"
        typeValue={form.leaveDeductionType}
        amountValue={form.leaveDeductionAmount}
        options={LEAVE_DEDUCTION_LABELS}
        amountLabel="จำนวนเงิน (บาท ต่อวันลาที่ไม่ได้รับค่าจ้าง)"
        hint="ใช้กับวันลาที่บันทึกไว้ว่าไม่ได้รับค่าจ้างเท่านั้น วันลาที่ได้รับค่าจ้างจะไม่ถูกหัก"
        disabled={disabled}
        onTypeChange={(v) => set('leaveDeductionType', v)}
        onAmountChange={(v) => set('leaveDeductionAmount', v)}
      />

      <DeductionRule
        label="การหักขาดงาน"
        typeValue={form.absenceDeductionType}
        amountValue={form.absenceDeductionAmount}
        options={ABSENCE_DEDUCTION_LABELS}
        amountLabel="จำนวนเงิน (บาท ต่อวันที่ขาดงาน)"
        disabled={disabled}
        onTypeChange={(v) => set('absenceDeductionType', v)}
        onAmountChange={(v) => set('absenceDeductionAmount', v)}
      />

      <Field label="ประกันสังคม (บาท / เดือน)" hint="เว้นว่างเพื่อใช้สูตรของบริษัท · 0 = ไม่หัก">
        <Input
          type="number"
          min="0"
          step="0.01"
          value={form.socialSecurityAmount}
          disabled={disabled}
          onChange={(e) => set('socialSecurityAmount', e.target.value)}
          placeholder="เช่น 750.00"
        />
      </Field>

      <Field label="ภาษี (บาท / เดือน)" hint="เว้นว่างเพื่อใช้สูตรของบริษัท · 0 = ไม่หัก">
        <Input
          type="number"
          min="0"
          step="0.01"
          value={form.taxAmount}
          disabled={disabled}
          onChange={(e) => set('taxAmount', e.target.value)}
          placeholder="เช่น 100.00"
        />
      </Field>
    </>
  );
}

function DeductionRule({
  label,
  typeValue,
  amountValue,
  options,
  amountLabel,
  hint,
  disabled,
  onTypeChange,
  onAmountChange,
}: {
  label: string;
  typeValue: string;
  amountValue: string;
  options: Record<string, string>;
  amountLabel: string;
  hint?: string;
  disabled?: boolean;
  onTypeChange: (value: string) => void;
  onAmountChange: (value: string) => void;
}) {
  return (
    <Field label={label} hint={hint} className="sm:col-span-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <Select value={typeValue} disabled={disabled} onChange={(e) => onTypeChange(e.target.value)}>
          <option value="">{USE_COMPANY_DEFAULT}</option>
          {Object.entries(options).map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </Select>
        {/* The amount box only exists for the one mode that needs a number. */}
        {typeValue === 'FIXED_AMOUNT' && (
          <Input
            type="number"
            min="0"
            step="0.01"
            value={amountValue}
            disabled={disabled}
            aria-label={amountLabel}
            placeholder={amountLabel}
            onChange={(e) => onAmountChange(e.target.value)}
          />
        )}
      </div>
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Read-only summary
// ---------------------------------------------------------------------------

const describe = (
  type: string | null,
  amount: string | null,
  labels: Record<string, string>,
  unit: string
): string => {
  if (!type) return `${USE_COMPANY_DEFAULT}`;
  if (type === 'FIXED_AMOUNT') return `${formatMoney(amount ?? 0)} บาท ${unit}`;
  return labels[type] ?? type;
};

export function PayrollPolicySummary({ policy }: { policy: EmployeePayrollPolicy | null }) {
  return (
    <div className="divide-y divide-border/70">
      <InfoRow
        label="การหักมาสาย"
        value={describe(
          policy?.lateDeductionType ?? null,
          policy?.lateDeductionAmount ?? null,
          LATE_DEDUCTION_LABELS,
          'ต่อชั่วโมงที่สาย'
        )}
      />
      <InfoRow
        label="การหักลา"
        value={describe(
          policy?.leaveDeductionType ?? null,
          policy?.leaveDeductionAmount ?? null,
          LEAVE_DEDUCTION_LABELS,
          'ต่อวันลาไม่รับค่าจ้าง'
        )}
      />
      <InfoRow
        label="การหักขาดงาน"
        value={describe(
          policy?.absenceDeductionType ?? null,
          policy?.absenceDeductionAmount ?? null,
          ABSENCE_DEDUCTION_LABELS,
          'ต่อวันที่ขาด'
        )}
      />
      <InfoRow
        label="ประกันสังคม"
        value={
          policy?.socialSecurityAmount != null
            ? `${formatMoney(policy.socialSecurityAmount)} บาท / เดือน`
            : USE_COMPANY_DEFAULT
        }
      />
      <InfoRow
        label="ภาษี"
        value={
          policy?.taxAmount != null
            ? `${formatMoney(policy.taxAmount)} บาท / เดือน`
            : USE_COMPANY_DEFAULT
        }
      />
    </div>
  );
}

/**
 * The derived bases a monthly salary implies: 18,000 becomes 600 a day and 75
 * an hour. These are display and deduction bases only - the employee is still
 * paid a monthly salary.
 */
export function derivedBases(
  monthlySalary: string | number | null | undefined,
  dayDivisor = 30,
  hoursPerDay = 8
): { daily: number; hourly: number } | null {
  const salary = Number(monthlySalary ?? 0);
  if (!Number.isFinite(salary) || salary <= 0 || dayDivisor <= 0 || hoursPerDay <= 0) return null;
  const daily = salary / dayDivisor;
  return { daily, hourly: daily / hoursPerDay };
}
