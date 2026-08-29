# Payroll Rules

Every rule below is a **configurable setting**, not hardcoded logic. The calculation engine
(`backend/src/services/payroll-calculator.service.ts`) reads each value through
`PayrollSettings`; changing a rule is a Settings edit, not a code change.

Defaults are seeded from `backend/src/config/payroll-defaults.ts` and editable at
**Settings → กฎการคำนวณ** or via `PATCH /api/settings`.

> The Thai statutory values shipped as defaults (5% social security capped at 750 THB/month,
> the progressive personal income tax ladder, the 50%/100,000 THB expense allowance and the
> 60,000 THB personal allowance) are **starting values**. Verify them against current
> Revenue Department and Social Security Office rules for your payroll year before going live.

---

## Settings reference

### Working time — group `ATTENDANCE`

| Key | Default | Meaning |
|---|---|---|
| `WORK_START_TIME` | `09:00` | Shift start; late minutes are measured from here |
| `WORK_END_TIME` | `18:00` | Shift end; work beyond this becomes OT |
| `BREAK_MINUTES` | `60` | Unpaid break subtracted from the worked duration |
| `LATE_GRACE_MINUTES` | `15` | Minutes after start that are not counted as late |
| `EARLY_LEAVE_GRACE_MINUTES` | `0` | Minutes before end that are not counted as early leave |
| `STANDARD_WORK_HOURS` | `8` | Paid hours in a standard day |
| `STANDARD_WORK_DAYS` | `22` | Divisor converting a monthly salary to a daily rate |
| `COUNT_WEEKEND_AS_WORKDAY` | `false` | When false, an empty weekend is not an absence |

### Overtime — group `OT`

| Key | Default | Meaning |
|---|---|---|
| `OT_ENABLED` | `true` | Master switch for all OT calculation |
| `MIN_OT_MINUTES` | `30` | Overtime shorter than this is ignored |
| `OT_RATE_WEEKDAY` | `1.5` | Multiplier on the hourly rate for weekday OT |
| `OT_RATE_WEEKEND` | `2` | Multiplier for Saturday/Sunday work |
| `OT_RATE_HOLIDAY` | `3` | Multiplier for public-holiday work |

### Deductions — group `DEDUCTION`

| Key | Default | Meaning |
|---|---|---|
| `LATE_DEDUCTION_MODE` | `PER_MINUTE` | `NONE` · `PER_MINUTE` · `PER_OCCURRENCE` |
| `LATE_DEDUCTION_USE_HOURLY_RATE` | `true` | Derive the deduction from the hourly rate instead of a flat amount |
| `LATE_DEDUCTION_AMOUNT` | `0` | Flat THB per late minute or occurrence |
| `ABSENCE_DEDUCTION_MODE` | `DAILY_RATE` | `NONE` · `DAILY_RATE` · `FIXED` |
| `ABSENCE_DEDUCTION_AMOUNT` | `0` | Flat THB per absent day when mode is `FIXED` |

### Social security — group `SOCIAL_SECURITY`

| Key | Default | Meaning |
|---|---|---|
| `SSO_ENABLED` | `true` | Master switch |
| `SSO_RATE` | `0.05` | Employee contribution rate |
| `SSO_MIN_BASE` | `1650` | Wage floor for the contribution base |
| `SSO_MAX_BASE` | `15000` | Wage ceiling for the contribution base |
| `SSO_MAX_CONTRIBUTION` | `750` | Hard cap on the monthly contribution |

### Tax — group `TAX`

| Key | Default | Meaning |
|---|---|---|
| `TAX_ENABLED` | `true` | Master switch |
| `TAX_PERSONAL_ALLOWANCE` | `60000` | Annual personal allowance |
| `TAX_EXPENSE_RATE` | `0.5` | Proportion of income deductible as expenses |
| `TAX_EXPENSE_CAP` | `100000` | Annual cap on the expense deduction |
| `TAX_BRACKETS` | see below | Progressive ladder, as JSON |

### Payroll behaviour — group `PAYROLL`

| Key | Default | Meaning |
|---|---|---|
| `PAYROLL_PAYMENT_DAY` | `28` | Default day of month for the payment date |
| `PRORATE_NEW_HIRES` | `true` | Pro-rate a partial month for joiners and leavers |
| `BLOCK_APPROVE_ON_MISSING_DATA` | `true` | Refuse approval while any employee is `MISSING_DATA` |
| `PAYSLIP_PREFIX` | `PS` | Prefix for generated payslip numbers |

### Google Sheets — group `GOOGLE_SHEETS`

| Key | Default | Meaning |
|---|---|---|
| `SHEET_AUTO_CREATE_EMPLOYEE` | `false` | When false, an unknown employee code is a sync error |
| `SHEET_OVERWRITE_CORRECTED` | `false` | **Keep false** so manual corrections are never overwritten |

---

## Attendance calculation

Computed per employee per day by `computeAttendanceMetrics`, a pure function.

### Worked duration

```
raw     = check_out − check_in            (check_out rolled +1 day if it precedes check_in)
break   = BREAK_MINUTES  if raw > BREAK_MINUTES  else 0
worked  = raw − break
```

The break is only subtracted from a day long enough to have contained one, so a two-hour
half-day is not reduced to one hour.

### Late

```
arrival = minutes since midnight of check_in
late    = arrival − WORK_START_TIME   when arrival > WORK_START_TIME + LATE_GRACE_MINUTES
        = 0                           otherwise
```

Grace is a threshold, not a discount: arriving at 09:30 with a 15-minute grace counts **30**
late minutes, not 15.

### Overtime

On a normal weekday:

```
normal = min(worked, STANDARD_WORK_HOURS × 60)
ot     = max(0, worked − STANDARD_WORK_HOURS × 60)
ot     = 0  if ot < MIN_OT_MINUTES
```

On a weekend or public holiday the **entire** worked duration is overtime and `normal` is zero.

### Status

| Condition | Status |
|---|---|
| Approved leave covers the day | `LEAVE` |
| Public holiday, no punches | `HOLIDAY` |
| Weekend, no punches, `COUNT_WEEKEND_AS_WORKDAY = false` | `NORMAL` (not absent) |
| Weekday, no punches at all | `ABSENT` |
| Exactly one punch present | `MISSING_DATA` |
| Late minutes > 0 | `LATE` |
| OT minutes > 0 | `OT` |
| Otherwise | `NORMAL` |

A single missing punch is deliberately **never** treated as an absence — it is flagged for
human review, because guessing would silently underpay someone.

---

## Rate derivation

| Employment type | Daily rate | Hourly rate |
|---|---|---|
| `MONTHLY` | `base_salary ÷ STANDARD_WORK_DAYS` | `daily ÷ STANDARD_WORK_HOURS` |
| `CONTRACT` | same as monthly | same as monthly |
| `DAILY` | `base_salary` (already daily) | `daily ÷ STANDARD_WORK_HOURS` |
| `HOURLY` | `hourly × STANDARD_WORK_HOURS` | `base_salary` (already hourly) |

Example — 30,000 THB monthly, 22 days, 8 hours:
daily = 30000 ÷ 22 = **1,363.64**, hourly = 1363.64 ÷ 8 = **170.46**.

A misconfigured `STANDARD_WORK_DAYS = 0` yields a rate of 0 rather than a division error.

---

## Base salary

| Type | Base pay for the period |
|---|---|
| `MONTHLY` / `CONTRACT` | The full monthly salary, pro-rated for a partial month |
| `DAILY` | `daily rate × present_days` |
| `HOURLY` | `hourly rate × worked hours` |

**Pro-rating** applies when `PRORATE_NEW_HIRES` is on and the employee was on the payroll for
fewer days than the period contains:

```
base = monthly_salary × (employed_days ÷ working_days_in_period)
```

A joiner present for 11 of 22 working days on 30,000 THB receives **15,000**, and a review note
records the ratio.

---

## Overtime pay

```
ot_weekday = hourly × OT_RATE_WEEKDAY × weekday_ot_hours
ot_weekend = hourly × OT_RATE_WEEKEND × weekend_ot_hours
ot_holiday = hourly × OT_RATE_HOLIDAY × holiday_ot_hours
ot_amount  = sum of the three
```

Each bucket becomes its own payslip line, so an employee can see which hours were paid at
which multiplier. An employee with `ot_eligible = false` receives no OT regardless of hours worked.

Example — 170.46 hourly, 10 weekday OT hours: `170.46 × 1.5 × 10 = ` **2,556.90**.

---

## Deductions

### Late

| Mode | Formula |
|---|---|
| `NONE` | 0 |
| `PER_MINUTE`, hourly-rate basis | `(hourly ÷ 60) × late_minutes` |
| `PER_MINUTE`, flat basis | `LATE_DEDUCTION_AMOUNT × late_minutes` |
| `PER_OCCURRENCE` | `LATE_DEDUCTION_AMOUNT × late_count` |

### Absence

Deductible days = `absent_days + unpaid_leave_days`. Approved **paid** leave is never deducted.

| Mode | Formula |
|---|---|
| `NONE` | 0 |
| `DAILY_RATE` | `daily_rate × deductible_days` |
| `FIXED` | `ABSENCE_DEDUCTION_AMOUNT × deductible_days` |

### Social security

```
base = clamp(gross_income, SSO_MIN_BASE, SSO_MAX_BASE)
sso  = min(base × SSO_RATE, SSO_MAX_CONTRIBUTION)
```

Assessed on gross income before attendance deductions. Skipped entirely when the employee has
`sso_enabled = false`.

| Gross | Contribution |
|---|---|
| 1,000 | 82.50 (lifted to the 1,650 floor) |
| 10,000 | 500.00 |
| 90,000 | 750.00 (capped) |

### Withholding tax

The month's income is annualised, run through the bracket ladder, and divided back by 12:

```
monthly_net = gross − late_deduction − absence_deduction − social_security
annual      = monthly_net × 12
expenses    = min(annual × TAX_EXPENSE_RATE, TAX_EXPENSE_CAP)
taxable     = annual − expenses − TAX_PERSONAL_ALLOWANCE
monthly_tax = brackets(taxable) ÷ 12
```

Default ladder (`TAX_BRACKETS`):

| Annual taxable income (THB) | Rate |
|---|---|
| 0 – 150,000 | 0% |
| 150,001 – 300,000 | 5% |
| 300,001 – 500,000 | 10% |
| 500,001 – 750,000 | 15% |
| 750,001 – 1,000,000 | 20% |
| 1,000,001 – 2,000,000 | 25% |
| 2,000,001 – 5,000,000 | 30% |
| above 5,000,000 | 35% |

`upTo: null` marks the final open-ended bracket.

Worked example — 60,000 gross, 750 social security:

```
monthly net 59,250 → annual 711,000
expenses    min(355,500, 100,000) = 100,000
taxable     711,000 − 100,000 − 60,000 = 551,000
tax         150k@0 + 150k@5% (7,500) + 200k@10% (20,000) + 51k@15% (7,650) = 35,150
monthly     35,150 ÷ 12 = 2,929.17
```

Skipped when the employee has `tax_enabled = false`.

---

## Totals

```
gross_income    = base_salary + ot_amount + allowance + bonus + other_income
total_deduction = late + absence + social_security + tax + loan + other_deduction
net_salary      = gross_income − total_deduction
```

The generated line items always sum exactly to these header totals — a property covered by
a unit test.

---

## Review status

The engine assigns a status rather than leaving a wrong figure to be discovered later.

| Status | Assigned when |
|---|---|
| `MISSING_DATA` | Any day has an incomplete punch, or there is no attendance at all |
| `NEEDS_REVIEW` | Net salary is negative, there are absences, or base salary is 0 |
| `READY` | None of the above |

Each condition appends a Thai explanation to `review_notes`, shown in the payroll detail drawer.

While `BLOCK_APPROVE_ON_MISSING_DATA` is enabled, a period cannot be approved while any
employee is still `MISSING_DATA`.

---

## Manual adjustments

Authorised users may override any of: `allowanceAmount`, `bonusAmount`, `otherIncome`,
`otAmount`, `loanDeduction`, `otherDeduction`, `lateDeduction`, `absenceDeduction`,
`socialSecurity`, `tax`.

Every adjustment records `changed_by`, `changed_at`, `old_value`, `new_value` and a mandatory
`reason`, and recomputes gross, total deduction and net.

Adjustments and manual line items **survive a recalculation** — recalculating regenerates only
the system-generated lines (`is_manual = false`).

No adjustment is possible on a `LOCKED` period.

---

## Precision

All arithmetic uses `decimal.js` at 28-digit precision with `ROUND_HALF_UP`, rounded to 2
decimals at each stored value. No JavaScript floating-point operation appears on any financial
path — `0.1 + 0.2` yields exactly `0.30`, which is asserted by a unit test.
