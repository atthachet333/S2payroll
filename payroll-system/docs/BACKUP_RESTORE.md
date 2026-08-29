# Backup and Restore — `s2apayroll`

> **`s2a_erp_main` is never part of a payroll backup or restore.**
> Every command below names `s2apayroll` explicitly. Do not use `--all-databases`,
> and never restore a payroll dump into an ERP database or vice versa.

| | |
|---|---|
| Server | `192.168.2.135:3306` (MariaDB 12.3.3) |
| Database | `s2apayroll` |
| Charset | `utf8mb4` / `utf8mb4_unicode_ci` — required for Thai |

This document is procedural on purpose: there is **no automated restore command**
in this project. Restore is a deliberate, human-verified operation.

---

## What is irreplaceable

The Google Sheet holds raw punches only. Everything else exists **solely** in this
database and cannot be rebuilt from anywhere:

- manual attendance corrections and their reasons
- payroll calculations, adjustments and approvals
- issued payslips (frozen snapshots)
- the audit log
- payroll settings and the per-period settings snapshots

Treat a payroll backup as the system of record.

---

## 1. Backup

### One-off (PowerShell, Windows)

```powershell
$ErrorActionPreference = "Stop"
$stamp   = Get-Date -Format "yyyy-MM-dd_HHmm"
$backupDir = "D:\backups\payroll"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

# --single-transaction gives a consistent snapshot without locking writes.
# --databases keeps the CREATE DATABASE statement in the dump.
& "C:\Program Files\MariaDB 12.3\bin\mariadb-dump.exe" `
  --host=192.168.2.135 --port=3306 `
  --user=s2apayroll --password `
  --single-transaction --routines --events --triggers `
  --default-character-set=utf8mb4 `
  --databases s2apayroll `
  --result-file="$backupDir\s2apayroll_$stamp.sql"

Write-Host "Backup written to $backupDir\s2apayroll_$stamp.sql"
```

If your client is the MySQL-branded one, substitute `mysqldump.exe`.

### Compress and verify

```powershell
$sql = "D:\backups\payroll\s2apayroll_$stamp.sql"
Compress-Archive -Path $sql -DestinationPath "$sql.zip" -Force

# A dump that does not mention the payroll tables is not a valid backup.
Select-String -Path $sql -Pattern "CREATE TABLE ``payroll_periods``" -Quiet
Select-String -Path $sql -Pattern "CREATE TABLE ``payslips``"        -Quiet
Select-String -Path $sql -Pattern "s2a_erp_main" -Quiet   # MUST be False

(Get-Item $sql).Length / 1MB
```

The `s2a_erp_main` check must print `False`. If it prints `True`, the dump was
taken with the wrong flags — discard it and retake.

### Scheduled daily backup

```powershell
# Run once, as Administrator, to register a 01:00 daily job.
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File D:\scripts\backup-payroll.ps1"
$trigger = New-ScheduledTaskTrigger -Daily -At 1:00AM
Register-ScheduledTask -TaskName "S2A Payroll Backup" -Action $action -Trigger $trigger `
  -RunLevel Highest -Description "Nightly mariadb-dump of s2apayroll"
```

Put the backup block above into `D:\scripts\backup-payroll.ps1`, add a retention
sweep (below), and copy the output off the machine.

```powershell
# Keep 30 days locally.
Get-ChildItem "D:\backups\payroll\*.sql.zip" |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
  Remove-Item -Force
```

**A backup that only exists on the same host is not a backup.** Copy it to a
second machine or object storage.

---

## 2. Restore into a NEW database

Never restore over a live database as a first step. Restore beside it, verify,
then switch.

```powershell
$stamp  = "2026-08-29_0100"
$sql    = "D:\backups\payroll\s2apayroll_$stamp.sql"
$verify = "s2apayroll_verify_$($stamp -replace '[-_]','')"
```

### 2.1 Create the verification database

```sql
-- Run as an administrator on 192.168.2.135
CREATE DATABASE `s2apayroll_verify_20260829` 
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

GRANT ALL PRIVILEGES ON `s2apayroll_verify_20260829`.* TO 's2apayroll'@'192.168.2.%';
FLUSH PRIVILEGES;
```

### 2.2 Load the dump into it

The dump contains `CREATE DATABASE s2apayroll` / `USE s2apayroll`, so those two
lines must be stripped to redirect it:

```powershell
# Strip the CREATE DATABASE and USE lines so the dump lands in the target DB.
(Get-Content $sql) |
  Where-Object { $_ -notmatch '^(CREATE DATABASE|USE )' } |
  Set-Content "$sql.redirected"

Get-Content "$sql.redirected" | & "C:\Program Files\MariaDB 12.3\bin\mariadb.exe" `
  --host=192.168.2.135 --user=s2apayroll --password `
  --default-character-set=utf8mb4 $verify
```

---

## 3. Verification

Run against the **restored** database, not production.

```sql
USE `s2apayroll_verify_20260829`;

-- 1. All 23 tables present (22 application + _prisma_migrations)
SELECT COUNT(*) AS tables_restored
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 's2apayroll_verify_20260829';

-- 2. Row counts match the source
SELECT 'employees' t, COUNT(*) n FROM employees
UNION ALL SELECT 'attendance_records', COUNT(*) FROM attendance_records
UNION ALL SELECT 'payroll_periods',    COUNT(*) FROM payroll_periods
UNION ALL SELECT 'payroll_employees',  COUNT(*) FROM payroll_employees
UNION ALL SELECT 'payslips',           COUNT(*) FROM payslips
UNION ALL SELECT 'audit_logs',         COUNT(*) FROM audit_logs;

-- 3. Thai text survived the round trip (must render, not show ??? or mojibake)
SELECT employee_code, first_name, last_name FROM employees LIMIT 5;

-- 4. Money is intact and payroll still reconciles
SELECT code, name, status,
       total_employees, gross_total, deduction_total, net_total,
       ROUND(gross_total - deduction_total, 2) AS recomputed_net,
       IF(ROUND(gross_total - deduction_total, 2) = ROUND(net_total, 2), 'OK', 'MISMATCH') AS check_net
FROM payroll_periods ORDER BY year DESC, month DESC;

-- 5. Migration history is present, so Prisma will not try to re-apply
SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at;
```

Every `check_net` must read `OK`. Compare the counts in step 2 against the same
query on production; they should match the moment the dump was taken.

### Application-level verification

Point a **non-production** backend at the restored database and confirm it serves:

```powershell
# In a scratch copy of backend\.env — never the production file
# DATABASE_URL="mysql://s2apayroll:<PASSWORD>@192.168.2.135:3306/s2apayroll_verify_20260829"

# The database guard only permits the name `s2apayroll`, so a verification run
# needs EXPECTED_DATABASE adjusted in scripts/db-guard.ts, or simply verify with
# SQL above. Do NOT weaken the guard on the production host.
```

In practice the SQL checks above are sufficient; the guard is deliberately strict.

---

## 4. Rollback procedure

Use when a migration, a bad import or an operator error has damaged production.

1. **Stop writes.**
   ```powershell
   pm2 stop s2apayroll-backend
   ```

2. **Back up the damaged database first.** You may need it for forensics, and it
   is the only record of what went wrong.
   ```powershell
   & mariadb-dump --host=192.168.2.135 --user=s2apayroll --password `
     --single-transaction --databases s2apayroll `
     --result-file="D:\backups\payroll\PRE-ROLLBACK_$(Get-Date -f yyyyMMdd_HHmm).sql"
   ```

3. **Restore into a new database and verify** — sections 2 and 3 above. Do not
   skip this even under pressure.

4. **Swap.** Rename rather than drop, so the damaged data remains recoverable:
   ```sql
   -- MariaDB has no RENAME DATABASE. Create the new name and move the tables,
   -- or simply repoint the application at the verified database:
   ```
   The lowest-risk swap is to repoint `DATABASE_URL` at the verified copy after
   renaming it to `s2apayroll`:
   ```sql
   CREATE DATABASE `s2apayroll_damaged_20260829`
     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   -- move each table out of the live DB
   RENAME TABLE `s2apayroll`.`payroll_periods` TO `s2apayroll_damaged_20260829`.`payroll_periods`;
   -- ... repeat for every table, then move the verified tables in:
   RENAME TABLE `s2apayroll_verify_20260829`.`payroll_periods` TO `s2apayroll`.`payroll_periods`;
   ```
   Script the table list from `information_schema.TABLES` rather than typing it.

5. **Restart and confirm.**
   ```powershell
   pm2 start s2apayroll-backend
   curl.exe http://127.0.0.1:2234/api/health
   curl.exe http://127.0.0.1:2234/api/ready
   ```

6. **Record what happened** — the audit log will show the damaging action; note
   the incident and the rollback in your operations log.

7. **Keep the damaged database** for at least 30 days before dropping it.

---

## 5. Restore drill

A backup is only proven by a restore. Do this quarterly:

- [ ] Take a fresh backup
- [ ] Restore it into `s2apayroll_drill_<date>`
- [ ] Run every verification query in section 3
- [ ] Confirm Thai text renders correctly
- [ ] Confirm `check_net` is `OK` for every period
- [ ] Drop the drill database
- [ ] Note the date and the elapsed time — that is your real recovery time

---

## Quick reference

| Task | Command |
|---|---|
| Backup | `mariadb-dump --single-transaction --databases s2apayroll --result-file=...` |
| Restore (new DB) | strip `CREATE DATABASE`/`USE`, then `mariadb <target> < dump.sql` |
| Verify tables | `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='<db>'` |
| Verify money | compare `gross_total - deduction_total` to `net_total` |
| Stop the app | `pm2 stop s2apayroll-backend` |

**Never** run `--all-databases`, and never name `s2a_erp_main` in any payroll
backup or restore command.
