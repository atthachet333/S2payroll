# Database

MariaDB (MySQL provider) via Prisma ORM. 22 tables, 15 unique constraints, 35 secondary
indexes, 21 foreign keys.

## Deployed instance

| | |
|---|---|
| Server | `192.168.2.135:3306` — MariaDB **12.3.3** |
| Database | **`s2apayroll`** (`utf8mb4` / `utf8mb4_unicode_ci`) |
| Application user | `s2apayroll@192.168.2.%` |
| Privileges | `GRANT ALL PRIVILEGES ON s2apayroll.*` — nothing else |

### The ERP database is off limits

`s2a_erp_main` lives on the **same MariaDB server** and belongs to a different system.
**It must never be read, written, migrated, reset or seeded by this project.**

Three independent layers enforce that:

1. **Privilege isolation.** The `s2apayroll` user has no grant on any ERP database. `SHOW
   DATABASES` from this connection returns only `information_schema`, `s2apayroll` and `test` —
   the ERP databases are not merely protected, they are invisible.
2. **Application guard.** `backend/scripts/db-guard.ts` parses `DATABASE_URL` and exits non-zero
   unless the target is exactly `s2apayroll`, with an explicit block-list for `s2a_erp_main`,
   `s2a_erp`, `mysql`, `information_schema` and `test`. It runs automatically before
   `prisma:migrate`, `prisma:deploy` and `seed`.
3. **Verification script.** `backend/scripts/verify-database.ts` performs a read-only audit of
   the live connection — identity, grants, visible databases, tables and seed row counts —
   and fails if anything references an ERP database.

```bash
npx tsx scripts/verify-database.ts
```

### Grant host

The application does **not** run on the database server; it runs on a developer/app machine and
connects across the LAN. A grant to `'s2apayroll'@'localhost'` would therefore never match and
every connection would fail with `Access denied`. The grant is scoped to `'192.168.2.%'` — the
subnet the application connects from.

Provisioning SQL: `backend/scripts/provision-database.sql`.

### Not the local MySQL

`127.0.0.1:3306` on the development machine runs an unrelated **MySQL 5.2.0-falcon-alpha**
(2007) installed at `C:\MySQL`. Prisma requires MySQL 5.7+ / MariaDB 10.2+ and fails against it
with `Unknown system variable 'socket'`, surfacing as a `P1000` at startup. `DATABASE_URL` must
point at `192.168.2.135`, not `localhost`.

## Conventions

| Rule | Implementation |
|---|---|
| Primary keys | `CHAR(36)` UUID, `@default(uuid())` |
| Table names | `snake_case` plural, via `@@map` |
| Column names | `snake_case`, via `@map` |
| Timestamps | `created_at` and `updated_at` on **every** table |
| Authorship | `created_by` (and `updated_by` / `changed_by`) where a user action authors the row |
| Money | `DECIMAL(15,2)` — never `FLOAT` or `DOUBLE` |
| Hours / days | `DECIMAL(8,2)` / `DECIMAL(6,2)` |
| Charset | `utf8mb4` — required for Thai text |
| Deletes | Employees and payroll data are never hard-deleted; status flags are used |

## Entity relationships

```
Role ──1:N──► User ──1:N──► RefreshToken
                 │
                 └──0:1──► Employee

Department ──1:N──► Position ──1:N──► Employee
     └────────────1:N───────────────────┘

Employee ──1:N──► AttendanceRecord ──1:N──► AttendanceAdjustment
    │                    └──N:1──► AttendanceRawData ──N:1──► GoogleSheetSync
    ├──1:N──► LeaveRecord
    ├──1:N──► SalaryHistory
    └──1:N──► PayrollEmployee

PayrollPeriod ──1:N──► PayrollEmployee ──1:N──► PayrollIncome
                              ├──1:N──► PayrollDeduction
                              ├──1:N──► PayrollAdjustment
                              └──1:1──► Payslip

Company, Holiday, PayrollSetting, AuditLog  (standalone)
```

---

## Authentication and organisation

### `roles`
The five fixed roles. `permissions` stores a JSON copy of the matrix for reference; the
authoritative matrix is `backend/src/config/permissions.ts`.

| Column | Type | Notes |
|---|---|---|
| `code` | enum | `SUPER_ADMIN` `ADMIN` `HR` `PAYROLL` `VIEWER` · **unique** |
| `name`, `description` | varchar | Thai label and English description |

### `users`

| Column | Type | Notes |
|---|---|---|
| `email` | varchar(191) | **unique**, stored lowercase |
| `password_hash` | varchar(255) | Argon2id — never returned by any endpoint |
| `role_id` | char(36) | → `roles` · indexed |
| `is_active` | bool | Re-checked on **every** authenticated request |
| `employee_id` | char(36) | Optional 1:1 link to an employee record · **unique** |
| `last_login_at` | datetime | |

### `refresh_tokens`
Refresh tokens are opaque random strings; only their SHA-256 digest is stored, so a database
leak cannot be replayed as a session.

| Column | Notes |
|---|---|
| `token_hash` | **unique**, SHA-256 of the token |
| `expires_at`, `revoked_at` | Rotation revokes the presented token when issuing a new pair |
| `user_agent`, `ip_address` | Session provenance |

### `companies`
Single company profile rendered on the payslip header.

### `departments` / `positions`
`code` is unique on both. A position may optionally belong to a department.

---

## Employees

### `employees`

| Column | Type | Notes |
|---|---|---|
| `employee_code` | varchar(32) | **unique** — the join key for the Google Sheet |
| `first_name`, `last_name`, `nickname` | varchar | |
| `national_id`, `email`, `phone` | varchar | |
| `department_id`, `position_id` | char(36) | Nullable, indexed |
| `employment_type` | enum | `MONTHLY` `DAILY` `HOURLY` `CONTRACT` |
| `start_date`, `end_date` | date | `end_date` bounds pro-rating for leavers |
| `base_salary` | **DECIMAL(15,2)** | Monthly, daily or hourly depending on `employment_type` |
| `bank_name`, `bank_account` | varchar | |
| `tax_id`, `social_security` | varchar | |
| `sso_enabled`, `tax_enabled`, `ot_eligible` | bool | Per-employee overrides of the global rules |
| `status` | enum | `ACTIVE` `PROBATION` `INACTIVE` `TERMINATED` · indexed |

### `salary_history`
Every change to `base_salary` writes a row here inside the same transaction as the update, so
salary history cannot diverge from the employee record.

`previous_salary`, `new_salary` (both DECIMAL(15,2)), `effective_date`, `reason`, `created_by`.

---

## Attendance

### `attendance_raw_data` — insert-only
The verbatim archive of every row read from the sheet. Nothing ever updates or deletes these
rows; they are the audit source of truth.

| Column | Notes |
|---|---|
| `sync_id` | → `google_sheet_syncs` |
| `employee_code`, `raw_date`, `raw_check_in`, `raw_check_out` | Exactly as the sheet had them, as text |
| `row_hash` | SHA-256 fingerprint used for duplicate detection · indexed |
| `sheet_row` | Source row number, for error reporting |
| `payload` | JSON copy of the full row |

### `attendance_records` — the working row

**Unique constraint: `(employee_id, work_date)`** — one row per employee per day. This is what
makes the sync idempotent.

| Column | Type | Notes |
|---|---|---|
| `check_in`, `check_out` | datetime | **Effective** values used by payroll (may be corrected) |
| `original_check_in`, `original_check_out` | datetime | **Imported** values, written by sync only |
| `worked_minutes`, `normal_minutes`, `ot_minutes`, `break_minutes` | int | Derived |
| `late_minutes`, `early_leave_minutes` | int | Derived |
| `is_missing_check_in`, `is_missing_check_out`, `is_absent` | bool | |
| `is_holiday`, `is_weekend` | bool | Determines which OT multiplier applies |
| `status` | enum | `NORMAL` `LATE` `OT` `ABSENT` `MISSING_DATA` `LEAVE` `HOLIDAY` · indexed |
| `source` | enum | `GOOGLE_SHEET` `MANUAL` `IMPORT_FILE` |
| `is_corrected` | bool | **Set by a manual edit; blocks silent overwrite by a later sync** |
| `is_locked` | bool | Set when the covering payroll period is locked |

Indexes: `(work_date)`, `(status)`, `(employee_code, work_date)`, `(raw_data_id)`.

### `attendance_adjustments` — append-only
One row per changed field per correction: `field_name`, `old_value`, `new_value`, `reason`
(mandatory), `changed_by`, `changed_at`.

### `leave_records`
`leave_type` (`ANNUAL` `SICK` `PERSONAL` `MATERNITY` `UNPAID` `OTHER`), date range, `total_days`,
`is_paid`, `status`. Unpaid leave is deducted on the same basis as an absence.

### `holidays`
`date` is **unique**. Listed dates are not counted as absence, and work performed on them is
paid at the holiday OT multiplier.

---

## Payroll

### `payroll_periods`

**Unique constraint: `(year, month)`** — one payroll period per calendar month.

| Column | Notes |
|---|---|
| `code` | `2027-05` · **unique** |
| `name` | Thai label, e.g. `พฤษภาคม 2027` |
| `start_date`, `end_date`, `payment_date` | |
| `status` | `DRAFT` → `ATTENDANCE_REVIEW` → `CALCULATED` → `REVIEW` → `APPROVED` → `PAID` → `LOCKED` · indexed |
| `total_employees`, `gross_total`, `ot_total`, `deduction_total`, `net_total` | Cached aggregates |
| `calculated_at` / `approved_at`+`approved_by` / `paid_at`+`paid_by` / `locked_at`+`locked_by` | Full workflow provenance |
| `settings_snapshot` | **JSON copy of every payroll setting at calculation time** |

`settings_snapshot` is what allows a historical run to be re-explained years later, even after
the live rules have changed.

### `payroll_employees`

**Unique constraint: `(period_id, employee_id)`.**

Employee identity is **denormalised** into this table (`employee_code`, `employee_name`,
`department_name`, `position_name`, `employment_type`) so a past payroll stays correct after
someone is renamed or moves department.

Attendance aggregates: `working_days`, `present_days`, `absent_days`, `leave_days`,
`late_count`, `late_minutes`, `working_hours`, `ot_hours`, `ot_weekday_hours`,
`ot_weekend_hours`, `ot_holiday_hours`, `missing_data_days`.

Money, all `DECIMAL(15,2)`: `base_salary`, `ot_amount`, `allowance_amount`, `bonus_amount`,
`other_income`, `gross_income`, `late_deduction`, `absence_deduction`, `social_security`,
`tax`, `loan_deduction`, `other_deduction`, `total_deduction`, `net_salary`.

| Column | Notes |
|---|---|
| `status` | `READY` `NEEDS_REVIEW` `MISSING_DATA` `EXCLUDED` · indexed with `period_id` |
| `review_notes` | JSON array of Thai messages explaining why review is needed |
| `has_adjustment` | True once any manual override has been applied |

### `payroll_incomes` / `payroll_deductions`
Itemised lines: `kind`, `label`, `quantity`, `rate` (`DECIMAL(15,4)`), `amount`, `is_manual`.

`is_manual` is the important flag: a recalculation deletes and regenerates only the lines with
`is_manual = false`, so manually entered allowances, bonuses and loans survive.

### `payroll_adjustments` — append-only
`field_name`, `old_value`, `new_value`, `reason` (mandatory), `changed_by`, `changed_at`.
Written for every manual override of a money field.

### `payslips`

| Column | Notes |
|---|---|
| `payslip_no` | `PS-2027-05-EMP001` · **unique** |
| `payroll_employee_id` | **unique** — at most one payslip per employee per period |
| `snapshot` | JSON: company, employee, attendance, income lines, deduction lines, totals |
| `net_salary` | Denormalised for listing and search |

The snapshot is frozen at issue time, so a reprinted payslip always matches the one originally
handed to the employee.

---

## Configuration, sync and audit

### `payroll_settings`
`key` is **unique**. `value_type` (`STRING` `NUMBER` `DECIMAL` `BOOLEAN` `TIME` `JSON`) drives
the editor control shown in Settings. `group` is indexed for grouped display.

Every rule the calculation engine reads lives here — see
[PAYROLL_RULES.md](PAYROLL_RULES.md) for the full list.

### `google_sheet_syncs`
One row per sync attempt: `status` (`RUNNING` `SUCCESS` `PARTIAL` `FAILED`), `total_rows`,
`imported_count`, `updated_count`, `skipped_count`, `duplicate_count`, `protected_count`,
`error_count`, `errors` (JSON), `started_at`, `finished_at`, `duration_ms`, `triggered_by`.

`protected_count` records how many rows were left alone because they carried a manual correction.

### `audit_logs`
`user_id`, `user_email`, `action`, `entity`, `entity_id`, `old_value` (JSON), `new_value` (JSON),
`reason`, `ip_address`, `user_agent`, `created_at`.

Indexed on `(entity, entity_id)`, `(user_id)` and `(created_at)`.

Audit writes are best-effort and never roll back the business operation they describe — a
logging failure must not lose a payroll approval.

---

## Migrations

```bash
npm run prisma:migrate     # development: create + apply
npm run prisma:deploy      # production: apply committed migrations
```

Both scripts run the safety guard first and refuse to proceed against any database other than
`s2apayroll`.

The initial migration is committed at `prisma/migrations/20260828000000_init/migration.sql`.
It has been **applied to `s2apayroll`**, creating 23 tables (22 application tables plus
Prisma's `_prisma_migrations`).

Regenerate the DDL from the schema without a live database:

```bash
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
```
