# Production Go-Live Checklist

Work top to bottom. Anything marked **BLOCKER** must be done before real payroll
runs through this system.

| | |
|---|---|
| Frontend | http://localhost:2233 → `https://payroll.<domain>` via Cloudflare Tunnel |
| Backend | http://127.0.0.1:2234 |
| Database | `s2apayroll` on `192.168.2.135:3306` |
| Never touch | `s2a_erp_main` |

---

## Security

- [ ] **BLOCKER — Admin password changed.**
      The seeded `admin@payroll.local` still uses the bootstrap password from
      `.env`. Force a change:
      ```bash
      npm run admin:force-password-change -- --email admin@payroll.local
      ```
      The account is then locked out of every endpoint except sign-in and
      change-password until a new password is set. The command never sets,
      generates or prints a password.
- [ ] **BLOCKER — Production JWT secrets configured.**
      `JWT_SECRET` and `JWT_REFRESH_SECRET` must be different, 48 random bytes each:
      ```bash
      node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
      ```
      Startup validation refuses to boot in production on placeholders.
- [ ] **BLOCKER — Production CORS configured.**
      `CORS_ORIGIN=https://payroll.<domain>`. Not `*`, not localhost, not `http://`.
- [ ] `SEED_ADMIN_PASSWORD` is not a known default (`Admin@12345` etc.) — startup
      validation rejects it in production.
- [ ] `backend/.env` and `frontend/.env` are git-ignored and were never committed.
- [ ] Each real user has their own account; nobody shares the admin login.
- [ ] Unused accounts removed or deactivated (Settings → ผู้ใช้งาน).
- [ ] Role assignments reviewed — only genuine SUPER_ADMINs can unlock payroll.

## Database

- [ ] **BLOCKER — Database backup taken and a restore tested.**
      Follow [BACKUP_RESTORE.md](BACKUP_RESTORE.md) end to end, including the
      verification queries. An untested backup is not a backup.
- [ ] Nightly backup scheduled and writing to a second machine.
- [ ] `npx tsx scripts/verify-database.ts` shows the payroll user has privileges
      on `s2apayroll.*` only, and that the ERP databases are not visible.
- [ ] All migrations applied: `npm run prisma:deploy`.
- [ ] **`s2a_erp_main` protection verified** — see the final section.

## Google Sheets

- [ ] Service account created and the JSON key stored only in `backend/.env`.
- [ ] The spreadsheet is shared with the service account as **Viewer**, never Editor.
- [ ] `GOOGLE_SHEET_ID` and `GOOGLE_SHEET_RANGE` point at the real attendance tab.
- [ ] **Attendance preview verified.** Run a dry run and confirm the classification
      looks right before importing anything:
      Attendance → นำเข้าข้อมูล → ทดลองซิงค์.
      Check `NEW` / `UPDATE` / `DUPLICATE` / `PROTECTED` / `LOCKED` / `INVALID` /
      `UNKNOWN_EMPLOYEE` counts, and resolve every `UNKNOWN_EMPLOYEE` row before
      the first real import.
- [ ] Sheet headers resolve — Thai (`รหัสพนักงาน`, `วันที่`, `เวลาเข้างาน`,
      `เวลาออกงาน`) and English variants are both accepted. A missing required
      column fails the sync with a message naming it.
- [ ] Confirmed the system **never writes to the sheet**: the client requests only
      the `spreadsheets.readonly` scope.

## Payroll configuration

Review every value at **Settings → กฎการคำนวณ** with whoever owns payroll policy.
These ship as sensible Thai defaults but are **your** company's rules, not ours.

- [ ] **Payroll settings reviewed** — `STANDARD_WORK_DAYS`, `STANDARD_WORK_HOURS`,
      `WORK_START_TIME`, `WORK_END_TIME`, `BREAK_MINUTES`, `LATE_GRACE_MINUTES`.
- [ ] **Payroll cycle reviewed** — `PAYROLL_CYCLE_START_DAY` / `PAYROLL_CYCLE_END_DAY`
      (defaults 26 → 25, so September 2026 runs 2026-08-26 → 2026-09-25).
- [ ] **OT settings reviewed** — `OT_RATE_WEEKDAY` (1.5), `OT_RATE_WEEKEND` (2),
      `OT_RATE_HOLIDAY` (3), `MIN_OT_MINUTES`.
- [ ] **Social security settings reviewed** — rate 5%, base 1,650–15,000,
      cap 750/month. **Verify against current SSO rules for the payroll year.**
- [ ] **Tax settings reviewed** — personal allowance 60,000, expense 50% capped at
      100,000, and the progressive bracket ladder.
      **Verify against current Revenue Department rules.**
- [ ] Deduction rules reviewed — `LATE_DEDUCTION_MODE`, `ABSENCE_DEDUCTION_MODE`.
- [ ] Public holidays entered for the year (Settings → วันหยุด).
- [ ] Company profile complete — it prints on every payslip.
- [ ] Every employee has a correct `employee_code` matching the sheet, a base
      salary, and correct SSO/tax/OT flags.

## Payroll dry run

- [ ] Attendance imported for a real month and reviewed.
- [ ] Pre-payroll check passes with **zero BLOCKING findings**.
- [ ] **Test payroll completed** — calculate, review, and compare several
      employees against a manual calculation before approving anything.
- [ ] **Payslip PDF visually checked.** Open one PDF and confirm Thai renders
      correctly, the company details are right, and income/deductions/net agree
      with the payroll screen.
- [ ] Bulk payslip ZIP downloads and opens.
- [ ] Reports export to Excel and CSV with Thai text intact.

## Deployment

- [ ] `backend/.env` created from `backend/.env.production.example`, all
      placeholders replaced.
- [ ] `frontend/.env` created from `frontend/.env.production.example` with the
      public `VITE_API_URL`, **then the frontend rebuilt** (Vite inlines it).
- [ ] Both built: `cd backend && npm run build`, `cd frontend && npm run build`.
- [ ] **PM2 startup verified:**
      ```bash
      pm2 start ecosystem.config.cjs
      pm2 save
      pm2 startup      # run the printed command as Administrator
      ```
      Then reboot the server and confirm both processes come back.
- [ ] `pm2 logs s2apayroll-backend` shows no configuration warnings.
- [ ] Graceful shutdown works: `pm2 restart s2apayroll-backend` does not error.
- [ ] **Cloudflare HTTPS verified** — the site loads over `https://`, HTTP
      redirects, and the certificate is valid.
- [ ] The backend is **not** reachable directly from the internet
      (`HOST=127.0.0.1`, only the tunnel is public).
- [ ] MariaDB port 3306 is not exposed publicly.

## Health

- [ ] `GET /api/health` returns `{"status":"ok","database":"connected"}`.
- [ ] `GET /api/ready` returns `ready` with `database`, `payroll-settings` and
      `payslip-fonts` all passing.
- [ ] Confirmed readiness does **not** depend on Google Sheets — payroll must keep
      working from already-synced attendance if the sheet is unreachable.
- [ ] Monitoring polls `/api/ready` and alerts on 503.

## `s2a_erp_main` protection — verify before go-live

- [ ] `npx tsx scripts/verify-database.ts` prints
      *"ERP databases are not visible to this user"*.
- [ ] The guard blocks a misconfiguration:
      ```bash
      DATABASE_URL="mysql://u:p@192.168.2.135:3306/s2a_erp_main" npx tsx scripts/db-guard.ts
      # must exit 1 with "which this project must never modify"
      ```
- [ ] No backup or restore command anywhere in your runbooks names `s2a_erp_main`.
- [ ] The `s2apayroll` MariaDB user has no grant on any ERP database.

---

## Sign-off

| Item | Who | Date |
|---|---|---|
| Payroll rules reviewed and approved | | |
| Test payroll checked against manual calculation | | |
| Backup and restore drill completed | | |
| Security items completed | | |
| Go-live approved | | |
