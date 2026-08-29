# Google Sheets Sync

Attendance imported from Google Sheets is the source for attendance calculation. The sync is
strictly one-directional: data flows **into** the database and the source sheet is never modified.

## Guarantees

| Guarantee | How it is enforced |
|---|---|
| The source sheet is never written to | The service account is requested with the `spreadsheets.readonly` scope, so a write is impossible at the API level |
| Original values are always preserved | Every fetched row is archived verbatim in `attendance_raw_data` (insert-only) and mirrored into `original_check_in` / `original_check_out` |
| Re-running is safe | Upsert on the unique key `(employee_id, work_date)` |
| Duplicates are detected | A SHA-256 fingerprint per row, plus in-pull deduplication |
| Manual corrections are never silently overwritten | Rows with `is_corrected = true` are skipped and counted under `protected` |
| Locked payroll is untouchable | Rows with `is_locked = true` are skipped |
| Failures are visible | Every attempt writes a `google_sheet_syncs` row with counts and per-row errors |
| The system survives an outage | Once synced, every feature reads only from MariaDB |

---

## Setup

1. In the [Google Cloud Console](https://console.cloud.google.com/), select or create a project.
2. Enable the **Google Sheets API**.
3. Create a **service account** and generate a **JSON key**.
4. Share the attendance spreadsheet with the service account's email address. **Viewer** access
   is sufficient — do not grant Editor.
5. Fill in `backend/.env`:

```ini
GOOGLE_PROJECT_ID=your-project-id
GOOGLE_CLIENT_EMAIL=payroll-sync@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvg...\n-----END PRIVATE KEY-----\n"
GOOGLE_SHEET_ID=1AbCdEfGhIjKlMnOpQrStUvWxYz
GOOGLE_SHEET_RANGE=Attendance!A:D
```

The private key must stay on a single line with literal `\n` escapes, wrapped in double quotes;
the backend converts them to real newlines at startup.

The sheet ID is the long identifier in the spreadsheet URL:
`https://docs.google.com/spreadsheets/d/`**`1AbCdEfGhIjKlMnOpQrStUvWxYz`**`/edit`

Until these are configured, `POST /api/sheets/sync` returns **503** with a Thai explanation and
the Attendance page shows a setup warning. Everything else in the system keeps working.

---

## Expected sheet format

| employee_code | date | check_in | check_out |
|---|---|---|---|
| EMP001 | 2027-05-12 | 08:55 | 18:05 |
| EMP002 | 2027-05-12 | 09:34 | 18:00 |
| EMP003 | 2027-05-12 | 08:50 | |

A header row is detected automatically when it contains `employee_code` or `date`. Column order
does not matter and extra columns are ignored. Recognised aliases:

| Field | Accepted headers |
|---|---|
| employee code | `employee_code`, `code`, `employeeid` |
| date | `date`, `work_date` |
| check in | `check_in`, `checkin`, `time_in` |
| check out | `check_out`, `checkout`, `time_out` |

Without a header row, columns are read positionally as A–D.

### Date formats

`YYYY-MM-DD` · `YYYY/MM/DD` · `DD/MM/YYYY` · `D/M/YYYY` · `DD-MM-YYYY` · `MM/DD/YYYY` · `YYYY-M-D`

Buddhist-era years are converted automatically: a parsed year above 2400 has 543 subtracted, so
`2570-05-12` becomes `2027-05-12`.

An unparseable date is reported as a row error rather than guessed.

### Time formats

`HH:mm:ss` · `HH:mm` · `H:mm` · `HH.mm` · `H.mm`

Blank cells, `-` and `null` are treated as a **missing punch**, not an error — the day is flagged
`MISSING_DATA` for human review.

An overnight shift is handled: when check-out precedes check-in, it is rolled forward one day.

---

## Running a sync

**From the UI**: Attendance → นำเข้าข้อมูล (Google Sheets) → ซิงค์ข้อมูลตอนนี้.
Requires the `attendance:sync` permission (SUPER_ADMIN, ADMIN, HR).

**Dry run**: ทดลองซิงค์ (ไม่บันทึก) reports what would change without writing attendance rows.

**From the API**:

```bash
curl -X POST http://localhost:2234/api/sheets/sync \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": false}'
```

Rate limited to 6 syncs per minute.

---

## Processing pipeline

For each row read from the sheet:

```
1. employee_code blank?              → error "Missing employee_code"
2. date unparseable?                 → error with the offending value
3. employee_code unknown?            → error "Unknown employee_code"
4. (employee, date) seen this pull?  → duplicates++, skip
5. archive the row in attendance_raw_data   (always, before any decision)
6. existing row is_locked?           → skipped++, skip
7. existing row is_corrected?        → protected++, skip   (unless SHEET_OVERWRITE_CORRECTED)
8. punches identical to last import? → duplicates++, skip
9. compute metrics, then upsert on (employee_id, work_date)
      new row → imported++      existing row → updated++
```

Step 5 happens **before** any skip decision, so even a protected or duplicate row leaves a
permanent record of what the sheet said at that moment.

Steps 6 and 7 are the core of the "never overwrite manual corrections silently" rule. When a
row is protected, the incoming values are still archived — nothing is lost, and the payroll team
can compare them against the correction if needed.

---

## Sync result

```json
{
  "syncId": "9c1e…",
  "status": "PARTIAL",
  "totalRows": 240,
  "imported": 180,
  "updated": 40,
  "skipped": 0,
  "duplicates": 18,
  "protected": 2,
  "errors": [
    { "row": 57, "employeeCode": "EMP999", "date": "2027-05-04",
      "message": "Unknown employee_code \"EMP999\"" },
    { "row": 92, "employeeCode": "EMP003", "date": "12 May 27",
      "message": "Unrecognised date format: \"12 May 27\"" }
  ],
  "durationMs": 3421
}
```

| Field | Meaning |
|---|---|
| `imported` | New attendance rows created |
| `updated` | Existing rows refreshed with changed punches |
| `duplicates` | Repeated within the pull, or unchanged since the last sync |
| `protected` | Left untouched because they carry a manual correction |
| `skipped` | Left untouched because the payroll period is locked |
| `errors` | Rows that could not be processed, with the source row number |

| Status | Meaning |
|---|---|
| `SUCCESS` | No errors |
| `PARTIAL` | Some rows failed, the rest were applied |
| `FAILED` | Every row failed, or the fetch itself threw |

The first 200 errors are stored on the sync record. Every attempt is also written to the audit
log as `SHEET_SYNC`.

---

## Sync history

`GET /api/sheets/history` and the Attendance page both show the last runs with their counts and
durations, so an unexpected spike in `protected` or `errors` is easy to spot.

`GET /api/sheets/status` reports whether credentials are configured, the truncated sheet ID, the
range, and the most recent sync.

---

## Correcting data

Corrections belong in the payroll system, not the sheet — the sheet is treated as an immutable
feed.

Attendance → edit a row → set the corrected times and a **mandatory reason**. This:

- writes the new values to `check_in` / `check_out`
- leaves `original_check_in` / `original_check_out` untouched
- appends one `attendance_adjustments` row per changed field
- sets `is_corrected = true`, protecting the row from future syncs
- recomputes worked minutes, OT, late and status
- writes an `ATTENDANCE_CORRECT` audit entry

The correction dialog shows the original imported values alongside the editable fields and the
full change history, so the reviewer always sees what the sheet said.

---

## Recalculating after a rule change

Changing an attendance rule (shift times, grace, break, OT threshold) does not retroactively
change already-imported rows. To apply new rules to a past month without re-syncing:

```bash
curl -X POST http://localhost:2234/api/attendance/recalculate \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from": "2027-05-01", "to": "2027-05-31"}'
```

Locked rows are excluded, and a manually set status is preserved.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| **503** `ยังไม่ได้ตั้งค่าการเชื่อมต่อ Google Sheets` | One of the four `GOOGLE_*` variables is empty. Restart the backend after editing `.env`. |
| `The caller does not have permission` | The spreadsheet was not shared with the service account email. |
| `Requested entity was not found` | Wrong `GOOGLE_SHEET_ID`. |
| `Unable to parse range` | `GOOGLE_SHEET_RANGE` names a tab that does not exist — check the tab name and spelling. |
| `error:1E08010C:DECODER routines::unsupported` | The private key lost its `\n` escapes or its surrounding quotes. |
| Every row reports `Unknown employee_code` | Employees have not been created yet, or the codes differ from the sheet. |
| High `protected` count | Expected when a month has had manual corrections — those rows are being defended. |
| Rows import but hours are 0 | The time column format is not recognised; check it against the accepted list above. |
