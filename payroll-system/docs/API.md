# API Reference

Base URL: `http://localhost:2234`

All endpoints return JSON. Every endpoint except `/api/health` and the auth endpoints requires
`Authorization: Bearer <accessToken>`.

## Conventions

**Money** is transported as a fixed 2-decimal string (`"32450.75"`), never a JSON number, so no
precision is lost in serialisation.

**Dates** are `YYYY-MM-DD`. **Timestamps** are ISO 8601 UTC. Punch times are stored as UTC
instants representing wall-clock time and should be rendered in UTC.

**Pagination** — list endpoints accept `page` (default 1) and `pageSize` (default 25, max 200):

```json
{ "items": [], "total": 0, "page": 1, "pageSize": 25 }
```

**Errors** always use this shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [] } }
```

| Status | Codes |
|---|---|
| 400 | `BAD_REQUEST`, `VALIDATION_ERROR` |
| 401 | `UNAUTHORIZED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND`, `ROUTE_NOT_FOUND` |
| 409 | `CONFLICT`, `DUPLICATE`, `FK_CONSTRAINT` |
| 422 | `UNPROCESSABLE` |
| 429 | rate limit exceeded |
| 500 | `INTERNAL_ERROR` (never includes a stack trace) |
| 503 | `SERVICE_UNAVAILABLE` (e.g. Google Sheets not configured) |

**Rate limits** — 300 requests/minute globally, 10/minute on login, 60/minute on refresh,
6/minute on sheet sync. Keyed by user id when authenticated, by IP otherwise.

---

## Health

### `GET /api/health`
No authentication.

```json
{ "status": "ok", "service": "payroll-api", "time": "2027-05-12T08:00:00.000Z" }
```

---

## Authentication

### `POST /api/auth/login`

```json
{ "email": "admin@payroll.local", "password": "Admin@12345" }
```

```json
{
  "accessToken": "eyJ…",
  "refreshToken": "9f3a…",
  "user": {
    "id": "uuid", "email": "admin@payroll.local",
    "firstName": "System", "lastName": "Administrator",
    "role": "SUPER_ADMIN",
    "permissions": ["employee:read", "…"],
    "employeeId": null
  }
}
```

A wrong password and a non-existent account return the same 401 message, so the endpoint
cannot be used to enumerate accounts.

### `POST /api/auth/refresh`
`{ "refreshToken": "…" }` → a new token pair. The presented refresh token is revoked as part
of issuing the new one (rotation).

### `POST /api/auth/logout`
`{ "refreshToken": "…" }` — revokes that token. Omit it while authenticated to revoke every
session for the current user.

### `GET /api/auth/me`
Returns the current `SessionUser`.

### `POST /api/auth/change-password`
`{ "currentPassword": "…", "newPassword": "…" }`. The new password needs at least 8 characters
with a letter and a digit. **All sessions are revoked** on success.

---

## Overview

### `GET /api/overview` · `payroll:read`
Optional `?periodId=`. Defaults to the newest period.

```json
{
  "period": { "id": "…", "code": "2027-05", "name": "พฤษภาคม 2027", "status": "CALCULATED" },
  "totals": { "employees": 6, "payroll": "…", "grossPayroll": "…", "otAmount": "…",
              "otHours": "…", "workingHours": "…", "lateCount": 4, "absentCount": 2 },
  "attendance": { "present": 120, "late": 4, "absent": 2, "leave": 3, "missingData": 1 },
  "payrollStatus": { "ready": 4, "needsReview": 1, "missingData": 1 },
  "trend": [{ "label": "05/2027", "gross": 0, "net": 0, "ot": 0, "deduction": 0 }]
}
```

---

## Employees

| Method | Path | Permission |
|---|---|---|
| GET | `/api/employees` | `employee:read` |
| GET | `/api/employees/:id` | `employee:read` |
| GET | `/api/employees/:id/summary` | `employee:read` |
| POST | `/api/employees` | `employee:write` |
| PATCH | `/api/employees/:id` | `employee:write` |
| POST | `/api/employees/:id/deactivate` | `employee:write` |

**List query**: `page`, `pageSize`, `search`, `departmentId`, `status`, `employmentType`.

**`POST /api/employees`**

```json
{
  "employeeCode": "EMP007",
  "firstName": "สมชาย", "lastName": "ใจดี", "nickname": "ชาย",
  "departmentId": "uuid", "positionId": "uuid",
  "employmentType": "MONTHLY",
  "startDate": "2027-05-01",
  "baseSalary": "32000",
  "bankName": "ธนาคารกสิกรไทย", "bankAccount": "123-4-56789-0",
  "taxId": "1100000000000", "socialSecurity": "1100000000000",
  "ssoEnabled": true, "taxEnabled": true, "otEligible": true,
  "status": "ACTIVE"
}
```

**`PATCH /api/employees/:id`** accepts the same fields except `employeeCode`, plus
`salaryChangeReason` and `salaryEffectiveDate`. Changing `baseSalary` writes a `salary_history`
row in the same transaction.

**`POST /api/employees/:id/deactivate`** — `{ "reason": "ลาออก 31 พ.ค. 2027" }`. Sets status to
`INACTIVE`; employees are never hard-deleted, so payroll history stays intact.

**`GET /api/employees/:id/summary`** returns the employee, aggregate attendance, payslips and
payroll history — the payload behind the employee detail page.

---

## Attendance

| Method | Path | Permission |
|---|---|---|
| GET | `/api/attendance` | `attendance:read` |
| GET | `/api/attendance/summary` | `attendance:read` |
| GET | `/api/attendance/:id` | `attendance:read` |
| PATCH | `/api/attendance/:id` | `attendance:write` |
| POST | `/api/attendance/recalculate` | `attendance:write` |

**List query**: `page`, `pageSize`, `employeeId`, `departmentId`, `from`, `to`, `status`, `search`.
`status` ∈ `NORMAL` `LATE` `OT` `ABSENT` `MISSING_DATA` `LEAVE` `HOLIDAY`.

**`PATCH /api/attendance/:id`** — manual correction.

```json
{ "checkIn": "09:00", "checkOut": "18:30", "note": "ลืมสแกนออก", "reason": "ยืนยันโดยหัวหน้างาน" }
```

`reason` is mandatory (min 3 characters). `checkIn` / `checkOut` accept `HH:mm`, `HH:mm:ss` or a
full ISO timestamp; `null` clears the punch.

Behaviour:
- `original_check_in` / `original_check_out` are **not** touched.
- Each changed field writes an `attendance_adjustments` row.
- Derived metrics are recomputed from the corrected punches.
- `is_corrected` is set, which protects the row from being overwritten by future syncs.
- Returns **400** if the row belongs to a locked payroll period.

**`POST /api/attendance/recalculate`** — `{ "from": "2027-05-01", "to": "2027-05-31" }`.
Re-derives metrics for unlocked rows against the current settings. A manually set status is
preserved. Returns `{ "updated": 132 }`.

---

## Google Sheets sync

| Method | Path | Permission |
|---|---|---|
| POST | `/api/sheets/sync` | `attendance:sync` |
| GET | `/api/sheets/status` | `attendance:read` |
| GET | `/api/sheets/history` | `attendance:read` |
| GET | `/api/sheets/preview` | `attendance:sync` |

**`POST /api/sheets/sync`**

```json
{ "sheetId": "optional override", "range": "Attendance!A:D", "dryRun": false }
```

```json
{
  "syncId": "uuid",
  "status": "PARTIAL",
  "totalRows": 240, "imported": 180, "updated": 40,
  "skipped": 0, "duplicates": 18, "protected": 2,
  "errors": [{ "row": 57, "employeeCode": "EMP999", "date": "2027-05-04",
               "message": "Unknown employee_code \"EMP999\"" }],
  "durationMs": 3421
}
```

`dryRun: true` reports what would happen without writing attendance rows.

Returns **503** when the Google credentials are not configured.

See [GOOGLE_SHEETS_SYNC.md](GOOGLE_SHEETS_SYNC.md) for the full semantics.

---

## Payroll

### Periods

| Method | Path | Permission |
|---|---|---|
| GET | `/api/payroll/periods` | `payroll:read` |
| POST | `/api/payroll/periods` | `payroll:write` |
| GET | `/api/payroll/periods/:id` | `payroll:read` |

**`POST /api/payroll/periods`** — `{ "year": 2027, "month": 5, "paymentDate": "2027-05-28" }`.
Returns **409** if that month already has a period.

**`GET /api/payroll/periods/:id`** returns the summary-card payload:

```json
{
  "period": { "…": "…" },
  "employees": 6,
  "grossTotal": "…", "otTotal": "…", "deductionTotal": "…", "netTotal": "…",
  "workingHours": "…", "otHours": "…",
  "ready": 4, "needsReview": 1, "missingData": 1
}
```

### Workflow

| Method | Path | Permission | From → To |
|---|---|---|---|
| POST | `…/:id/attendance-review` | `payroll:write` | `DRAFT` → `ATTENDANCE_REVIEW` |
| POST | `…/:id/calculate` | `payroll:calculate` | `DRAFT`/`ATTENDANCE_REVIEW`/`CALCULATED` → `CALCULATED` |
| POST | `…/:id/submit-review` | `payroll:write` | `CALCULATED` → `REVIEW` |
| POST | `…/:id/approve` | `payroll:approve` | `REVIEW` → `APPROVED` |
| POST | `…/:id/mark-paid` | `payroll:pay` | `APPROVED` → `PAID` |
| POST | `…/:id/lock` | `payroll:lock` | `PAID` → `LOCKED` |
| POST | `…/:id/unlock` | **`SUPER_ADMIN` only** | `LOCKED` → `PAID` |

**`calculate`** recomputes every active employee from attendance. Manual income/deduction lines
and prior field adjustments are preserved. Freezes `settings_snapshot` on the period.

**`approve`** returns **400** if any employee is still `MISSING_DATA`, while the
`BLOCK_APPROVE_ON_MISSING_DATA` setting is enabled.

**`mark-paid`** accepts an optional `{ "paymentDate": "2027-05-28" }`.

**`lock`** sets `is_locked` on every attendance row in the period as well.

**`unlock`** requires `{ "reason": "…" }` (min 5 characters) and always writes an audit log entry.
Returns **403** for any role other than `SUPER_ADMIN`.

An invalid transition returns **400**; any money write against a `LOCKED` period returns **403**.

### Payroll employees

| Method | Path | Permission |
|---|---|---|
| GET | `/api/payroll/periods/:id/employees` | `payroll:read` |
| GET | `/api/payroll/periods/:id/employees/:employeeId` | `payroll:read` |
| PATCH | `/api/payroll/periods/:id/employees/:employeeId` | `payroll:write` |
| GET | `…/:employeeId/payslip-preview` | `payslip:read` |
| POST | `/api/payroll/periods/:id/generate-payslips` | `payslip:issue` |

**List query**: `page`, `pageSize`, `search`, `departmentId`, `status`.

**`GET …/employees/:employeeId`** returns the row plus `incomes`, `deductions`, `adjustments`,
the full `employee`, the `period` and any issued `payslip`.

**`PATCH …/employees/:employeeId`** — manual adjustment.

```json
{
  "adjustments": [
    { "field": "bonusAmount", "value": "5000", "reason": "โบนัสประจำไตรมาส" }
  ],
  "status": "READY"
}
```

Allowed `field` values: `allowanceAmount`, `bonusAmount`, `otherIncome`, `otAmount`,
`loanDeduction`, `otherDeduction`, `lateDeduction`, `absenceDeduction`, `socialSecurity`, `tax`.

`reason` is mandatory. Each change writes a `payroll_adjustments` row with `changed_by`,
`changed_at`, `old_value`, `new_value` and `reason`. Gross, total deduction and net are
recomputed, and the period totals are refreshed.

**`POST …/generate-payslips`** requires the period to be `APPROVED`, `PAID` or `LOCKED`.
Returns `{ "created": 6, "refreshed": 0, "total": 6 }`. Re-issuing refreshes an existing
payslip rather than creating a duplicate.

---

## Payslips

| Method | Path | Permission |
|---|---|---|
| GET | `/api/payslips` | `payslip:read` |
| GET | `/api/payslips/:id` | `payslip:read` |

**List query**: `page`, `pageSize`, `periodId`, `employeeId`, `search`.

Each payslip carries a frozen `snapshot`:

```json
{
  "company":   { "name": "…", "address": "…", "taxId": "…" },
  "employee":  { "employeeCode": "EMP001", "name": "…", "department": "…", "bankAccount": "…" },
  "period":    { "code": "2027-05", "name": "พฤษภาคม 2027", "startDate": "…", "endDate": "…" },
  "paymentDate": "2027-05-28",
  "attendance": { "workingDays": 22, "presentDays": 21, "otHours": "6.50", "lateCount": 1 },
  "incomes":    [{ "label": "เงินเดือนพื้นฐาน", "quantity": null, "rate": null, "amount": "32000.00" }],
  "deductions": [{ "label": "ประกันสังคม", "quantity": null, "rate": "0.05", "amount": "750.00" }],
  "totals":     { "grossIncome": "…", "totalDeduction": "…", "netSalary": "…" }
}
```

PDF output is produced client-side from this snapshot using the A4 print layout, which keeps
Thai typography identical to the on-screen preview.

---

## Reports

| Method | Path | Permission |
|---|---|---|
| GET | `/api/reports/types` | `report:read` |
| GET | `/api/reports/{type}` | `report:read` |
| GET | `/api/reports/payroll` | alias of `payroll-summary` |
| GET | `/api/reports/attendance` | alias of `attendance-summary` |

Types: `payroll-summary`, `attendance-summary`, `ot`, `late`, `absence`,
`payroll-by-department`, `salary-history`.

**Query**: `periodId`, `from`, `to`, `departmentId`, `employeeId`, and
`format` ∈ `json` (default) · `csv` · `excel`.

`json` returns:

```json
{
  "title": "สรุปเงินเดือน - พฤษภาคม 2027",
  "columns": [{ "key": "employee_code", "header": "รหัสพนักงาน", "numeric": false }],
  "rows": [{ "employee_code": "EMP001", "net_salary": "30512.50" }],
  "totals": { "net_salary": "…" },
  "meta": { "period": "พฤษภาคม 2027", "generated_at": "2027-06-01 09:12" }
}
```

`csv` returns `text/csv` with a UTF-8 BOM so Excel opens Thai text correctly.
`excel` returns a styled `.xlsx` with numeric cells formatted `#,##0.00`.

---

## Settings

| Method | Path | Permission |
|---|---|---|
| GET | `/api/settings` | `settings:read` |
| PATCH | `/api/settings` | `settings:write` |
| GET | `/api/settings/company` | `settings:read` |
| PUT | `/api/settings/company` | `settings:write` |
| GET | `/api/settings/departments` | `employee:read` |
| POST | `/api/settings/departments` | `settings:write` |
| PATCH | `/api/settings/departments/:id` | `settings:write` |
| GET | `/api/settings/positions` | `employee:read` |
| POST | `/api/settings/positions` | `settings:write` |
| PATCH | `/api/settings/positions/:id` | `settings:write` |
| GET | `/api/settings/roles` | `user:read` |
| GET | `/api/settings/users` | `user:read` |
| POST | `/api/settings/users` | `user:write` |
| PATCH | `/api/settings/users/:id` | `user:write` |
| GET | `/api/settings/audit-logs` | `audit:read` |
| GET | `/api/settings/holidays` | `settings:read` |
| POST | `/api/settings/holidays` | `settings:write` |
| DELETE | `/api/settings/holidays/:id` | `settings:write` |
| GET | `/api/settings/leaves` | `attendance:read` |
| POST | `/api/settings/leaves` | `attendance:write` |

**`GET /api/settings`** — optional `?group=` (`ATTENDANCE` `OT` `DEDUCTION` `SOCIAL_SECURITY`
`TAX` `PAYROLL` `GOOGLE_SHEETS`).

**`PATCH /api/settings`**

```json
{ "settings": [ { "key": "OT_RATE_WEEKDAY", "value": "2" } ] }
```

Writes an audit entry containing the old and new values of every changed key.

**`POST /api/settings/users`** — only a `SUPER_ADMIN` may create another `SUPER_ADMIN`.
Password hashes are never returned by any user endpoint.

**`PATCH /api/settings/users/:id`** — changing the password or disabling the account revokes
that user's refresh tokens. The last active `SUPER_ADMIN` cannot be disabled.

**`GET /api/settings/audit-logs`** — query `page`, `pageSize`, `entity`, `entityId`, `userId`,
`action`, `from`, `to`.

---

## Permission matrix

| Permission | SUPER_ADMIN | ADMIN | HR | PAYROLL | VIEWER |
|---|:-:|:-:|:-:|:-:|:-:|
| `employee:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `employee:write` | ✓ | ✓ | ✓ | | |
| `attendance:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `attendance:write` | ✓ | ✓ | ✓ | | |
| `attendance:sync` | ✓ | ✓ | ✓ | | |
| `payroll:read` | ✓ | ✓ | | ✓ | ✓ |
| `payroll:write` | ✓ | ✓ | | ✓ | |
| `payroll:calculate` | ✓ | ✓ | | ✓ | |
| `payroll:approve` | ✓ | ✓ | | ✓ | |
| `payroll:pay` | ✓ | ✓ | | ✓ | |
| `payroll:lock` | ✓ | ✓ | | ✓ | |
| `payroll:unlock` | ✓ | | | | |
| `payslip:read` | ✓ | ✓ | | ✓ | ✓ |
| `payslip:issue` | ✓ | ✓ | | ✓ | |
| `report:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `settings:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `settings:write` | ✓ | ✓ | | | |
| `user:read` / `user:write` | ✓ | ✓ | | | |
| `audit:read` | ✓ | ✓ | | | |

`payroll:unlock` is deliberately reserved for `SUPER_ADMIN` — it is the only permission `ADMIN`
does not hold.
