# Payroll Management System

ระบบบริหารเงินเดือน — a payroll system built on employee attendance data imported from Google Sheets.
The user interface is in Thai; all code, database fields, API names, comments and documentation are in English.

| | |
|---|---|
| Frontend | React 18 · Vite 6 · TypeScript · Tailwind CSS · shadcn/ui · Recharts · React Router · TanStack Query · Axios |
| Backend | Node.js · Fastify 5 · TypeScript · Prisma ORM · MariaDB · JWT · Zod |
| Frontend URL | http://localhost:2233 |
| Backend URL | http://localhost:2234 |

---

## Requirements

| Software | Version |
|---|---|
| Node.js | 20 LTS or newer (developed on 24.x) |
| npm | 10 or newer |
| MariaDB | 10.6 or newer (MySQL 8 also works) |

A Google Cloud service account is needed for the attendance sync, but the system runs fully
without it — every other feature works, and previously synced attendance stays usable.

---

## Installation

```bash
git clone <your-repo-url>
cd payroll-system
```

### 1. MariaDB setup

> **Deployed environment**
>
> | | |
> |---|---|
> | MariaDB server | `192.168.2.135:3306` (MariaDB 12.3.3) |
> | Payroll database | **`s2apayroll`** |
> | Payroll DB user | `s2apayroll@192.168.2.%` |
> | ERP database | `s2a_erp_main` — **DO NOT MODIFY.** Not owned by this project. |
>
> The payroll database shares a server with the ERP database but is completely
> separate. The `s2apayroll` user holds privileges on `s2apayroll.*` only, so the
> ERP databases are not even visible to this application — verify with
> `npx tsx scripts/verify-database.ts`.
>
> Note: `127.0.0.1:3306` on the development machine runs an unrelated, 2007-era
> MySQL 5.2 alpha which Prisma cannot use. Do not point `DATABASE_URL` at it.

Create the database and a dedicated application user (`backend/scripts/provision-database.sql`):

```sql
CREATE DATABASE IF NOT EXISTS `s2apayroll`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 's2apayroll'@'192.168.2.%'
  IDENTIFIED BY '<SECURE_PASSWORD>';

GRANT ALL PRIVILEGES ON `s2apayroll`.* TO 's2apayroll'@'192.168.2.%';
FLUSH PRIVILEGES;
```

**On the grant host:** the application runs on the developer machine and connects
across the LAN, *not* on the database server. A grant to `'localhost'` or
`'127.0.0.1'` would never match and login would fail with `Access denied`. Scope the
grant to the subnet the application connects from (or to that machine's exact IP).

`utf8mb4` is required — Thai text in employee names, departments and payslips depends on it.

#### Database safety guard

`npm run prisma:migrate`, `npm run prisma:deploy` and `npm run seed` all run
`scripts/db-guard.ts` first. It parses `DATABASE_URL` and **aborts** unless the target
database is `s2apayroll`, with an explicit block-list covering `s2a_erp_main` and
`s2a_erp`. A stray `.env` edit therefore cannot migrate, reset or seed the ERP database:

```
  DATABASE SAFETY CHECK FAILED
  DATABASE_URL points at "s2a_erp_main", which this project must never modify.
```

### 2. Environment configuration

```bash
cd backend
cp .env.example .env
```

Edit `backend/.env`:

```ini
PORT=2234
DATABASE_URL="mysql://s2apayroll:<SECURE_PASSWORD>@192.168.2.135:3306/s2apayroll"
JWT_SECRET=<random string, at least 32 characters>
JWT_REFRESH_SECRET=<a different random string, at least 32 characters>
CORS_ORIGIN=http://localhost:2233
```

`DATABASE_URL` must end in `/s2apayroll`. Never point it at `s2a_erp_main` or `s2a_erp`.

Generate strong secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Then the frontend:

```bash
cd ../frontend
cp .env.example .env
```

```ini
VITE_API_URL=http://localhost:2234
```

### 3. Prisma migration

```bash
cd backend
npm install
npm run prisma:generate
npm run prisma:deploy
npm run seed
```

`prisma:deploy` applies the committed migration in `prisma/migrations/`. During development,
use `npm run prisma:migrate` instead to create a new migration after editing the schema.

`npm run seed` is idempotent and creates:

- the five roles (`SUPER_ADMIN`, `ADMIN`, `HR`, `PAYROLL`, `VIEWER`)
- the bootstrap administrator from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`
- all payroll settings with documented defaults
- a company profile, sample departments, positions, employees and one month of attendance

**Change the seeded administrator password immediately after the first login.**

### 4. Google Sheets setup

1. In the [Google Cloud Console](https://console.cloud.google.com/), create (or pick) a project.
2. Enable the **Google Sheets API**.
3. Create a **service account**, then create a **JSON key** for it.
4. Open your attendance spreadsheet and **share it with the service account email** —
   *Viewer* access is enough and is all the system ever asks for.
5. Copy the values into `backend/.env`:

```ini
GOOGLE_PROJECT_ID=your-project-id
GOOGLE_CLIENT_EMAIL=payroll-sync@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvg...\n-----END PRIVATE KEY-----\n"
GOOGLE_SHEET_ID=1AbC...the-id-from-the-sheet-url
GOOGLE_SHEET_RANGE=Attendance!A:D
```

Keep the private key on one line with literal `\n` escape sequences, wrapped in double quotes.

The sheet needs these columns (a header row is detected automatically, and extra columns are ignored):

| employee_code | date | check_in | check_out |
|---|---|---|---|
| EMP001 | 2027-05-12 | 08:55 | 18:05 |

See [docs/GOOGLE_SHEETS_SYNC.md](docs/GOOGLE_SHEETS_SYNC.md) for accepted date/time formats
and the full duplicate-prevention rules.

---

## Running the system

Backend (port **2234**):

```bash
cd backend
npm install
npm run dev
```

Frontend (port **2233**):

```bash
cd frontend
npm install
npm run dev
```

Then open **http://localhost:2233** and sign in with the seeded administrator.

### Default ports

| Service | Port | URL |
|---|---|---|
| Frontend (Vite) | 2233 | http://localhost:2233 |
| Backend (Fastify) | 2234 | http://localhost:2234 |
| MariaDB | 3306 | — |

Both ports are pinned (`strictPort` on the frontend), so a conflict fails loudly
rather than silently moving to another port.

---

## All commands

### Backend

| Command | Purpose |
|---|---|
| `npm run dev` | Start the API in watch mode on port 2234 |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled production build |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run the test suite |
| `npm run prisma:generate` | Regenerate the Prisma client |
| `npm run prisma:migrate` | Create and apply a development migration |
| `npm run prisma:deploy` | Apply pending migrations (production) |
| `npm run prisma:studio` | Open Prisma Studio |
| `npm run seed` | Seed roles, settings, admin and demo data (idempotent) |
| `npm run db:check` | Assert `DATABASE_URL` targets `s2apayroll`; runs automatically before every migration and seed |
| `npx tsx scripts/verify-database.ts` | Read-only report: connection identity, grants, visible databases, tables, seed row counts |
| `npm run cleanup:test-payroll` | **Dev only.** Preview deletion of one test payroll period; add `--confirm` to execute. Refuses under NODE_ENV=production, refuses a LOCKED period, and never touches employees, attendance, users, settings or company data. |

### Frontend

| Command | Purpose |
|---|---|
| `npm run dev` | Start Vite on port 2233 |
| `npm run build` | Type-check and build to `dist/` |
| `npm run preview` | Preview the production build |
| `npm run typecheck` | Type-check only |

---

## Project layout

```
payroll-system/
├── backend/          Fastify API, Prisma schema, payroll engine
├── frontend/         React application
├── docs/             Architecture, database, API, rules, security, deployment
└── README.md
```

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, layering, request flow |
| [docs/DATABASE.md](docs/DATABASE.md) | All 22 models, relations, constraints |
| [docs/API.md](docs/API.md) | Every endpoint, payload and permission |
| [docs/PAYROLL_RULES.md](docs/PAYROLL_RULES.md) | Calculation rules and configurable settings |
| [docs/GOOGLE_SHEETS_SYNC.md](docs/GOOGLE_SHEETS_SYNC.md) | Sync behaviour and data-safety guarantees |
| [docs/SECURITY.md](docs/SECURITY.md) | Authentication, RBAC, hardening, audit |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production build and deployment |
| [docs/PROGRESS.md](docs/PROGRESS.md) | Build phases and current status |

---

## Key behaviours worth knowing

- **The Google Sheet is never modified.** The sync opens it with a read-only scope and
  only ever writes into the local database.
- **Original attendance is never lost.** Imported punches are archived verbatim in
  `attendance_raw_data` and mirrored into `original_check_in` / `original_check_out`.
  Manual corrections write to separate columns and are never silently overwritten by a later sync.
- **All money uses `Decimal`.** No JavaScript floating-point arithmetic appears on any
  financial path, in the database (`DECIMAL(15,2)`) or in the calculation engine (`decimal.js`).
- **Payroll rules are configuration, not code.** Working hours, OT multipliers, deduction
  modes, social-security bands and tax brackets are all editable under Settings.
- **Locked payroll periods are immutable.** Once `LOCKED`, financial values and the period's
  attendance rows are frozen; only a `SUPER_ADMIN` can unlock, a reason is mandatory,
  and the unlock is written to the audit log.
