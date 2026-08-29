# Architecture

## Overview

Two independent applications share nothing but an HTTP contract. Frontend code and backend
code never mix, and the frontend holds no database or Google credentials.

```
Browser (Thai UI)                Node.js API                      Data
┌──────────────────┐   HTTPS    ┌──────────────────┐            ┌─────────────┐
│ React 18 + Vite  │ ─────────► │ Fastify 5        │ ─Prisma──► │  MariaDB    │
│ TanStack Query   │  JSON+JWT  │ Zod validation   │            └─────────────┘
│ Tailwind/shadcn  │ ◄───────── │ RBAC middleware  │
│ Recharts         │            │ Payroll engine   │ ─read────► ┌─────────────┐
│ :2233            │            │ :2234            │  only      │Google Sheets│
└──────────────────┘            └──────────────────┘            └─────────────┘
```

The arrow to Google Sheets is one-directional by design: the service account is requested
with the `spreadsheets.readonly` scope, so the system is structurally incapable of writing
back to the source sheet.

## Backend layering

```
src/
├── server.ts                  process entry, signal handling
├── app.ts                     builds the Fastify instance (importable by tests)
├── config/
│   ├── env.ts                 Zod-validated environment; exits on invalid config
│   ├── permissions.ts         the RBAC matrix, in one file
│   └── payroll-defaults.ts    every payroll rule as a seedable default
├── plugins/
│   ├── prisma.ts              database client, lifecycle-managed
│   ├── security.ts            helmet, CORS, rate limiting, cookies
│   ├── auth.ts                JWT verification, requirePermission, requireRole
│   └── error-handler.ts       maps every error type to a stable JSON shape
├── middleware/actor.ts        derives the audit actor from a request
├── routes/                    HTTP surface: parse, authorise, delegate
├── services/                  all business logic
├── schemas/                   Zod request contracts
└── utils/                     money (Decimal), datetime, errors
```

**Routes stay thin.** A route handler validates input with a Zod schema, resolves the actor,
calls one service function and returns the result. It contains no business rules, so the rules
are testable without HTTP.

**Services hold the logic.** They own transactions, audit writes and workflow guards.

### Service responsibilities

| Service | Responsibility |
|---|---|
| `auth.service.ts` | Login, refresh-token rotation, logout, password change |
| `employee.service.ts` | Employee CRUD, deactivation, salary history, departments, positions |
| `attendance.service.ts` | Per-day attendance computation, manual correction, recalculation |
| `google-sheets.service.ts` | Read-only sheet fetch, upsert, duplicate and correction protection |
| `payroll-calculator.service.ts` | **Pure** calculation engine — no I/O, no state |
| `payroll.service.ts` | Periods, workflow transitions, aggregation, adjustments, locking |
| `payslip.service.ts` | Payslip issue and frozen snapshot rendering |
| `report.service.ts` | Report building, CSV and Excel export |
| `dashboard.service.ts` | Overview aggregates |
| `settings.service.ts` | Typed access over the settings table |
| `audit.service.ts` | Append-only audit log |

## The calculation engine is isolated

`payroll-calculator.service.ts` is a pure module. It takes an employee snapshot, an attendance
aggregate and a settings view, and returns the full breakdown. It performs no database access,
reads no globals and holds no mutable state.

This matters for three reasons:

1. **Testability.** Every rule is unit-testable without a database — 38 tests cover it directly.
2. **Auditability.** Given the same inputs it always produces the same output, so a historical
   payroll run can be re-explained exactly.
3. **Safety.** Business rules cannot leak into route handlers or drift between call sites.

```
attendance rows
   └─► aggregate per employee (payroll.service)
         └─► calculatePayroll (pure)
               working hours → OT → late → absence
                 → income → deductions → SSO → tax → net
         └─► persist PayrollEmployee + income/deduction lines
```

## Money handling

Money never touches a JavaScript `number`:

- **Database**: `DECIMAL(15,2)` for currency, `DECIMAL(8,2)` for hours.
- **Application**: `decimal.js`, configured once in `utils/money.ts` with 28-digit precision
  and `ROUND_HALF_UP`.
- **Transport**: fixed 2-decimal strings in JSON, so no precision is lost in serialisation.
- **Display**: the browser formats the string for presentation but never recomputes it.

## Attendance data model

Three layers keep the imported truth separate from human corrections:

| Layer | Table / column | Mutability |
|---|---|---|
| Source of truth | `attendance_raw_data` | Insert-only; never updated |
| Imported values | `attendance_records.original_check_in/out` | Written by sync only |
| Effective values | `attendance_records.check_in/out` | Corrected by authorised users |
| Change history | `attendance_adjustments` | Append-only |

The payroll engine reads the *effective* values. Auditors can always reconstruct what the
sheet said, what a human changed, who changed it, when and why.

## Payroll workflow

```
DRAFT ─► ATTENDANCE_REVIEW ─► CALCULATED ─► REVIEW ─► APPROVED ─► PAID ─► LOCKED
                                   ▲                                        │
                                   └──── recalculate ────┘        unlock ───┘
                                                             (SUPER_ADMIN + reason)
```

Transitions are declared once, in `ALLOWED_TRANSITIONS` in `payroll.service.ts`. Any write
that changes money calls `assertNotLocked` first, so no code path can modify a locked period.

Locking also freezes every attendance row in the period (`is_locked = true`), so the numbers
stay reproducible rather than drifting when someone edits a punch afterwards.

## Frontend structure

```
src/
├── app/App.tsx              router, query client, protected routes
├── layouts/AppLayout.tsx    top navigation (no permanent left sidebar)
├── pages/                   one file per route
├── features/                page-specific composites (dialogs, drawers, panels)
├── components/ui/           shadcn-style primitives, one module
├── services/                axios client and typed endpoint wrappers
├── types/                   API response types
└── utils/                   Thai formatting, class merging
```

**Server state lives in TanStack Query**, not in component state. Mutations invalidate the
query keys they affect, so a payroll calculation updates the summary cards, the employee table
and the overview page without manual refresh wiring.

**Permissions drive the UI.** `useAuth().can('payroll:approve')` hides actions the signed-in
role cannot perform. This is a usability measure only — the backend enforces the same matrix
independently on every request.

## Request lifecycle

```
1. Browser sends request with  Authorization: Bearer <access token>
2. security plugin      helmet headers, CORS check, rate limit
3. requirePermission    verifies JWT, re-checks the account is still active,
                        resolves the role, asserts the permission
4. route handler        Zod-validates the body/query
5. service              business rules, transaction, audit log
6. error handler        maps AppError / ZodError / Prisma errors to JSON
```

Step 3 deliberately re-reads the user's active flag from the database on every request, so
disabling an account takes effect immediately rather than when the access token expires.

## Resilience

The system keeps working when Google Sheets is unavailable: attendance already synced lives in
MariaDB, and every downstream feature (calculation, review, payslips, reports) reads only from
the database. A failed sync is recorded in `google_sheet_syncs` with its errors and changes
nothing else.
