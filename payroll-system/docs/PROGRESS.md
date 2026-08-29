# Progress

Status as of the initial build. All ten phases are complete.

| Phase | Scope | Status |
|---|---|---|
| 1 | Project structure, environment, database connection, Prisma schema | ✅ Complete |
| 2 | Authentication and RBAC | ✅ Complete |
| 3 | Employees | ✅ Complete |
| 4 | Attendance and Google Sheets sync | ✅ Complete |
| 5 | Payroll engine | ✅ Complete |
| 6 | Payroll UI | ✅ Complete |
| 7 | Payslips and PDF | ✅ Complete |
| 8 | Reports | ✅ Complete |
| 9 | Settings and audit logs | ✅ Complete |
| 10 | Tests, validation, security review, production build | ✅ Complete |

---

## Verification

| Check | Result |
|---|---|
| Backend typecheck (`tsc --noEmit`) | ✅ 0 errors |
| Backend tests (`vitest run`) | ✅ **301 passed / 301** |
| Backend production build (`tsc -p tsconfig.build.json`) | ✅ `dist/server.js` emitted |
| Frontend typecheck (`tsc -b`) | ✅ 0 errors |
| Frontend production build (`vite build`) | ✅ 2,410 modules, 4 chunks |
| Prisma schema validation | ✅ Client generated |
| Migrations applied to `s2apayroll` | ✅ 2 migrations · 23 tables |

### Test breakdown

| Suite | Tests | Covers |
|---|---|---|
| `payroll-workflow.test.ts` | 59 | Every payroll status transition pair, locked-period guard |
| `security.test.ts` | 21 | RBAC matrix per role, database safety guard |
| `payroll-adjustments.test.ts` | 26 | Commission, attendance flags, adjustment + period validation, line/total reconciliation |
| `payroll-calculator.test.ts` | 38 | Rate derivation, OT multipliers, late and absence deductions, social security bands and cap, progressive tax brackets, pro-rating, employment types, review status, line-item/total consistency, decimal precision |
| `attendance.test.ts` | 26 | Worked duration, break handling, late grace, OT thresholds, weekend/holiday OT, missing punches, absence, leave, overnight shifts, settings overrides, sheet date/time parsing including Buddhist-era years |
| `sheet-mapping.test.ts` | 22 | Thai + English headers, reordered/extra columns, missing columns, positional fallback, row extraction |
| `payroll-cycle.test.ts` | 15 | 26→25 cycle, year boundary, leap year, configurable cycle days, contiguity |
| `sync-safety.test.ts` | 21 | Read-only scope, no write APIs, idempotent upsert, protected corrections, locked periods, code-only matching |
| `production-hardening.test.ts` | 45 | Seed password preservation, forced password change, production config validation, PDF filename safety, cleanup script gates, audit coverage |
| `app.test.ts` | 28 | App boot, route registration, 401 on every protected route, health DB probe (200 connected / 503 disconnected), error envelopes, no stack-trace leakage, helmet headers, CORS allow-list |

### Frontend bundle

| Chunk | Size | Gzipped |
|---|---|---|
| `index.css` | 29.0 kB | 6.4 kB |
| `query` (TanStack Query, Axios) | 100.9 kB | 34.3 kB |
| `react` (React, DOM, Router) | 158.2 kB | 51.9 kB |
| `index` (application) | 323.5 kB | 87.0 kB |
| `charts` (Recharts) | 393.6 kB | 108.1 kB |

---

## Phase detail

### Phase 1 — Foundation
Separate `backend/` and `frontend/` trees, `docs/`, environment files with `.env.example` for
both sides, Zod-validated configuration that exits on invalid input, and the full Prisma schema:
22 models, UUID primary keys, `created_at`/`updated_at` everywhere, `DECIMAL` money columns,
indexes, unique constraints and foreign keys.

### Phase 2 — Authentication and RBAC
Argon2id password hashing, JWT access tokens, opaque server-tracked refresh tokens with
rotation and SHA-256-digest storage, logout, password change with full session revocation, and a
single-source permission matrix enforced by `requirePermission` / `requireRole`. Active-account
state is re-checked on every request. Protected routes on the client mirror the same matrix.

### Phase 3 — Employees
Full CRUD with search and department/status/type filters, deactivation instead of deletion,
automatic salary-history capture on any pay change, and a detail page covering personal
information, payroll settings, salary history, attendance summary and payslip history.

### Phase 4 — Attendance and Google Sheets sync
Read-only Sheets integration with header detection and column aliases, multi-format date and
time parsing (including Buddhist-era conversion), verbatim raw-data archival, idempotent upsert
on `(employee, date)`, hash-based duplicate detection, protection of manually corrected rows,
locked-period skipping, and a full sync history with per-row errors. Manual correction preserves
the original values and records a mandatory reason in an append-only adjustment table.

### Phase 5 — Payroll engine
`payroll-calculator.service.ts` is a pure, I/O-free module driven entirely by configurable
settings. It covers four employment types, three OT multipliers, two late-deduction modes, two
absence-deduction modes, Thai social security with floor/ceiling/cap, annualised progressive
withholding tax, and pro-rating for joiners and leavers. All arithmetic uses `decimal.js`.

### Phase 6 — Payroll UI
Period list, the seven-state workflow with per-state actions gated by permission, eight summary
cards, the full employee payroll table, and a detail drawer with attendance summary, income and
deduction breakdowns, itemised lines, a manual adjustment form and the adjustment history.

### Phase 7 — Payslips and PDF
Frozen payslip snapshots, an A4 print layout with company header, employee block, attendance
metrics, two-column income/deduction tables, net-pay box and signature lines. Print CSS hides
all application chrome so the browser's "Save as PDF" yields a clean document. No AI branding
or watermark anywhere.

### Phase 8 — Reports
Seven reports (payroll summary, attendance summary, OT, late, absence, payroll by department,
salary history) with a shared query contract, on-screen tables, styled Excel export via ExcelJS,
CSV export with a UTF-8 BOM for Thai text in Excel, and PDF via the print layout.

### Phase 9 — Settings and audit logs
Company profile, departments, positions, payroll/attendance/OT/deduction/tax rules, holidays,
leave records, users, the role permission matrix, and a filterable audit log viewer. Every rule
the engine reads is editable here.

### Phase 10 — Tests, validation, security, build
301 automated tests, clean typechecks and production builds on both sides, Zod validation on
every endpoint, helmet/CORS/rate limiting, structured errors with no stack-trace leakage, and
audit coverage of every sensitive action.

---

## Database deployment — complete

The system now runs against a live MariaDB instance, end to end.

| | |
|---|---|
| Server | `192.168.2.135:3306` — MariaDB 12.3.3 |
| Database | **`s2apayroll`** (`utf8mb4` / `utf8mb4_unicode_ci`) |
| User | `s2apayroll@192.168.2.%`, privileges on `s2apayroll.*` only |
| Frontend | http://localhost:2233 |
| Backend | http://localhost:2234 |
| ERP database | `s2a_erp_main` — untouched, and not visible to the payroll user |

### Verified

| Check | Result |
|---|---|
| Migration `20260828000000_init` applied | ✅ 23 tables in `s2apayroll` |
| Seed | ✅ 5 roles · 34 settings · 1 admin · 1 company · 4 departments · 4 positions · 6 employees · 138 attendance rows |
| Seed idempotency | ✅ Run 3× — zero duplicates |
| `GET /api/health` | ✅ `200 {"status":"ok","database":"connected"}` |
| Login `admin@payroll.local` | ✅ `200` — JWT + refresh token + `SUPER_ADMIN` + 20 permissions |
| Authenticated API calls | ✅ `/api/auth/me`, `/api/employees`, `/api/overview`, `/api/attendance` all 200 |
| Rejection paths | ✅ Wrong password 401 · no token 401 · unlisted CORS origin not reflected |
| Browser login at :2233 | ✅ Real backend auth, Overview + Employees render, no console errors |
| Thai text round-trip | ✅ `สมชาย ใจดี` / `บัญชีและการเงิน` correct through utf8mb4 |
| ERP isolation | ✅ `SHOW DATABASES` returns only `information_schema`, `s2apayroll`, `test` |

### Resolved: the P1000 startup failure

`DATABASE_URL` had been left at the `.env.example` placeholder
(`payroll:payroll@localhost:3306/payroll_db`). The deeper cause was that `127.0.0.1:3306` on the
development machine runs an unrelated **MySQL 5.2.0-falcon-alpha** (2007, `C:\MySQL`) which
Prisma cannot drive — it fails on `Unknown system variable 'socket'`. No credential change could
have fixed it; the fix was to target the MariaDB 12.3.3 server at `192.168.2.135`.

### Added safeguards

- `backend/scripts/db-guard.ts` — blocks every migration and seed unless `DATABASE_URL` targets
  `s2apayroll`; explicitly block-lists `s2a_erp_main` and `s2a_erp`. Wired into `prisma:migrate`,
  `prisma:deploy` and `seed`.
- `backend/scripts/verify-database.ts` — read-only audit of connection identity, grants, visible
  databases, tables and seed row counts.
- `backend/scripts/provision-database.sql` — documented provisioning, with the grant scoped to
  the subnet the application actually connects from.
- `GET /api/health` now issues a real `SELECT 1` and returns **503** when the database is
  unreachable, instead of reporting a cheerful 200.

---

## Payroll business workflow — verified end to end

A live test payroll period was created and driven through the entire lifecycle against the real
`s2apayroll` database and the seeded **July 2026** attendance.

### Test period

| | |
|---|---|
| Period | `2026-07` · กรกฎาคม 2026 · `6c9b3ad6-c1d5-4d74-a468-6a902b6321ca` |
| Window | 2026-07-01 → 2026-07-31 · payment 2026-07-31 |
| Final status | **PAID** (locked, then unlocked as part of testing the unlock path) |
| Employees | 6 · 23 scheduled working days |

### Lifecycle executed

`DRAFT` → `ATTENDANCE_REVIEW` → `CALCULATED` → `REVIEW` → *(approve blocked)* → corrections →
`CALCULATED` → `REVIEW` → `APPROVED` → payslips → `PAID` → `LOCKED` → *(edits refused)* →
`UNLOCK` (SUPER_ADMIN + reason) → `PAID`

| Guard | Result |
|---|---|
| `ATTENDANCE_REVIEW → APPROVED` | ✅ rejected — invalid transition |
| Approve with 6 employees MISSING_DATA | ✅ rejected — 400, blocked by `BLOCK_APPROVE_ON_MISSING_DATA` |
| Adjust money while LOCKED | ✅ 403 |
| Recalculate while LOCKED | ✅ 403 |
| Edit attendance in a LOCKED period | ✅ 400 |
| Unlock with a 1-character reason | ✅ 400 |
| Unlock as `PAYROLL` role | ✅ 403 — `Requires role: SUPER_ADMIN` |
| Unlock as `SUPER_ADMIN` with reason | ✅ audit entry `PAYROLL_UNLOCK` with the reason recorded |

### Calculation result (after corrections and one commission adjustment)

| | |
|---|---|
| Gross payroll | 196,114.81 |
| OT | 8,594.81 (33.59 h) |
| Deductions | 28,403.34 |
| Net payroll | 167,711.47 |

Sample — EMP001 สมชาย ใจดี: 23 scheduled / 20 worked days · 166.70 h (159.03 normal + 5.17 OT) ·
2 late (68 min) · 3 absent → gross 71,364.08 − deductions 12,748.66 = **net 58,615.42**.

Every employee initially came back `MISSING_DATA`, which is the intended behaviour: the seeded
month deliberately contains days with one punch missing, and the engine refuses to treat them as
normal attendance. After 13 manual corrections (originals preserved, each with a mandatory
reason) the period calculated cleanly.

### Bugs found and fixed during this phase

1. **Absences were double-reported as missing punch data.** A day with no punches set both
   `isMissingCheckIn` and `isMissingCheckOut`, so EMP001 showed "missing check-in 3, missing
   check-out 5" against only 2 genuinely incomplete days. An absence is a known state, not a data
   problem. Fixed in `computeAttendanceMetrics`; totals were unaffected (reporting only).
2. **Manual adjustments did not update the itemised lines.** Adjusting `commissionAmount` changed
   the header gross but created no income line, so the payslip printed lines summing to 67,864.08
   under a stated gross of 71,364.08. Adjustments now rewrite the matching line, and a test
   asserts lines reconcile with headers across every income/deduction combination.
3. **Employee filter requested `pageSize=500`,** above the API's documented maximum of 200, so the
   dropdown silently 400'd. Now requests 200 and hides the dropdown above that, falling back to
   free-text search rather than offering a partial list.

### Schema additions

Migration `20260829000000_payroll_commission_and_attendance_flags` (additive only):
`PayrollItemKind += COMMISSION`; `payroll_employees += commission_amount, normal_hours,
missing_check_in_days, missing_check_out_days`.

### Test coverage added

| Suite | Tests | Covers |
|---|---|---|
| `payroll-workflow.test.ts` | 59 | All 49 (from, to) transition pairs, terminal LOCKED, lock guard status codes |
| `security.test.ts` | 21 | Full RBAC matrix per role, `payroll:unlock` reserved to SUPER_ADMIN, DB guard allow/deny |
| `payroll-adjustments.test.ts` | 26 | Commission, attendance problem flags, adjustment validation, period creation, line/total reconciliation |

**191 backend tests passing.**

---

## Production finishing — complete

### Admin password safety
The seed already never reset an existing password (it returns early when the account exists), but
it **printed the plaintext password to stdout**, leaking it into terminal scrollback and CI logs.
That is fixed. The bootstrap admin is now created with `mustChangePassword: true`, enforced in the
auth hook: such an account receives **403 `PASSWORD_CHANGE_REQUIRED`** on every route except
`/api/auth/me`, `/change-password` and `/logout`. The flag clears when the password is replaced.

### Server-side payslip PDF
`GET /api/payslips/:id/pdf` renders A4 PDFs with **pdfkit** and **Sarabun** (SIL OFL), shipped as a
package dependency rather than depending on a host font. Thai renders correctly.

Every figure comes from the stored snapshot and is verified three ways before a byte is written:
income lines must sum to the stated gross, deduction lines to the stated total, and
`gross − deductions` must equal both the stated net **and** the live `payroll_employees.net_salary`.
A drifted snapshot returns 422 rather than a wrong document. Verified by tampering: inflated gross,
inflated net and a removed income line were all rejected.

### Bulk export
`GET /api/payroll/periods/:id/payslips/download` streams a ZIP, one PDF per employee plus a
MANIFEST. Requires `APPROVED`/`PAID`/`LOCKED` (DRAFT → 400), deterministic ASCII filenames,
de-duplicated entries, audited as `PAYSLIP_BULK_EXPORT`. A payslip that fails verification is
skipped and listed in the manifest rather than aborting the whole archive.

### Cleanup tool
`npm run cleanup:test-payroll -- --period <id|code> [--confirm]`. Four independent gates: refuses
under `NODE_ENV=production`, routes through the shared database guard, requires an explicit period
(no bulk mode), and requires `--confirm` after printing the plan. Refuses to delete a LOCKED
period. Deletes payroll output only — employees, attendance, users, settings and company data are
untouched — and writes a `PAYROLL_PERIOD_CLEANUP` audit entry.

### Production config validation
`assertProductionConfig` runs at startup. In production it **exits** on placeholder JWT secrets,
short/identical secrets, wildcard or localhost-only CORS, plain-http origins, known seed passwords,
or a half-configured Google Sheets integration. Outside production the same findings are warnings.
Messages name the variable and never print its value — asserted by a test.

### Verified

| Check | Result |
|---|---|
| Backend tests | ✅ **238 / 238** |
| Backend typecheck / build | ✅ clean · `dist/server.js` |
| Frontend typecheck / build | ✅ clean · 5 chunks |
| PDF reconciliation | ✅ 6/6 payslips, 1 A4 page each, net present in rendered text |
| Tampered snapshot | ✅ rejected (3/3 cases), snapshot restored |
| PDF / ZIP without a token | ✅ 401 |
| ZIP on a DRAFT period | ✅ 400 |
| Cleanup under `NODE_ENV=production` | ✅ refused |
| Cleanup pointed at `s2a_erp_main` | ✅ refused by the guard |
| ERP isolation | ✅ ERP databases not visible to the payroll user |

---

## Real-company readiness — complete

Prepared for live company usage. See [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md).

| Area | Delivered |
|---|---|
| Admin credential risk |  sets  only — never sets, generates or prints a password. Revokes sessions. Idempotent. |
| Production env templates | ,  — placeholders only |
| Sheet column mapping |  resolves columns by header name (Thai + English aliases). No hardcoded positions. Missing required column fails with a message naming it. |
| Sync preview | Seven classifications — NEW / UPDATE / DUPLICATE / PROTECTED / LOCKED / INVALID / UNKNOWN_EMPLOYEE — with employee name, reason and per-class counters. Dry run writes nothing at all, not even sync history. |
| Employee matching |  only. Names are never used to resolve a row. Unknown codes are classified, never guessed. |
| Payroll cycle |  /  (default 26 → 25). September 2027 suggests 2027-08-26 → 2027-09-25. Overridable per period; overlapping windows rejected. |
| Pre-payroll check |  grades findings BLOCKING / WARNING / INFO.  refuses while any BLOCKING finding stands — enforced server-side, not just in the UI. |
| Audit page | Filters by date range, user, action, target type, payroll period and employee. |
| Readiness |  checks database, payroll settings and payslip fonts. Google Sheets is reported but never required. |
| Backup / restore | [BACKUP_RESTORE.md](BACKUP_RESTORE.md) — Windows commands, verification queries, rollback. Never names . |
| Deployment |  defines  and  only; graceful shutdown, restart backoff, log files, no secrets. |

---

## Real-company readiness — complete

Prepared for live company usage. Go-live steps: [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md).

| Area | Delivered |
|---|---|
| Admin credential risk | `npm run admin:force-password-change -- --email <addr>` sets `mustChangePassword` only — it never sets, generates or prints a password. Revokes active sessions. Idempotent. |
| Production env templates | `backend/.env.production.example`, `frontend/.env.production.example` — placeholders only |
| Sheet column mapping | `sheet-mapping.service.ts` resolves columns by header name with Thai and English aliases. No hardcoded positions anywhere in the import path. A missing required column fails the sync with a message naming it and listing accepted names. |
| Sync preview | Seven classifications — NEW, UPDATE, DUPLICATE, PROTECTED, LOCKED, INVALID, UNKNOWN_EMPLOYEE — each with employee name, reason and per-class counters. A dry run writes nothing at all, not even sync history or an audit entry. |
| Employee matching | `employee_code` only. Names are never used to resolve a row; an unknown code is classified, never guessed onto another employee. |
| Payroll cycle | `PAYROLL_CYCLE_START_DAY` / `PAYROLL_CYCLE_END_DAY`, default 26 → 25. September 2027 suggests 2027-08-26 → 2027-09-25. Overridable per period; overlapping windows are rejected. |
| Pre-payroll check | `GET /api/payroll/periods/:id/pre-check` grades findings BLOCKING / WARNING / INFO. `calculatePeriod` refuses while any BLOCKING finding stands — enforced server-side, so the API cannot be used to skip it. |
| Audit page | Filters by date range, user, action, target type, payroll period and employee. |
| Readiness | `GET /api/ready` checks database, payroll settings and payslip fonts. Google Sheets is reported but never required, so payroll keeps running from already-synced attendance. |
| Backup / restore | [BACKUP_RESTORE.md](BACKUP_RESTORE.md) — Windows commands, verification queries, rollback procedure. No command anywhere names `s2a_erp_main`. |
| Deployment | `ecosystem.config.cjs` defines `s2apayroll-backend` and `s2apayroll-frontend` only, with graceful shutdown, restart backoff, log files and no secrets. |

### Verified live

| Check | Result |
|---|---|
| Readiness endpoint | ✅ `ready` — database, settings, fonts pass; Google Sheets optional |
| Cycle suggestion | ✅ Sep 2027 → 2027-08-26 → 2027-09-25; Jan 2027 crosses the year correctly |
| Pre-payroll check | ✅ 0 blocking, 0 warning, 3 info on the July 2026 test period |
| Admin CLI refusals | ✅ no email, ERP database, unknown user |
| Admin CLI happy path | ✅ set → idempotent re-run → clear, sessions revoked, no password touched |
| ERP isolation | ✅ ERP databases still invisible to the payroll user |

---

## Optional improvements

Not required by the specification; listed for future planning.

**Security**
- Move refresh tokens to `httpOnly`, `SameSite=Strict` cookies (`@fastify/cookie` is already registered)
- Multi-factor authentication for `SUPER_ADMIN`
- Redis-backed rate limiting for multi-instance deployments
- Retention and tamper-evidence for audit logs

**Payroll**
- Additional tax allowances (spouse, children, insurance, provident fund)
- Employer social-security contribution tracking and the PP1/PP1Kor filings
- Mid-cycle salary changes pro-rated within a single period
- Bank transfer file export (SCB/KBank/BBL formats)
- Multiple pay cycles (semi-monthly, weekly)
- Year-to-date accumulation and the 50 ทวิ annual certificate

**Attendance**
- Shift patterns and rosters per employee or department
- Scheduled automatic sync on a cron rather than manual triggering
- Leave-balance tracking with accrual and an approval workflow
- Bulk correction for a whole day or department

**Platform**
- Server-side PDF rendering with an embedded Thai font, for emailing payslips
- Employee self-service portal for viewing personal payslips
- End-to-end tests against a disposable MariaDB container
- Structured log shipping and metrics dashboards
