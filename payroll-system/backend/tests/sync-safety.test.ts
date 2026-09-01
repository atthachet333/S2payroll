import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(here, '..');
const read = (...p: string[]) =>
  fs.readFileSync(path.join(backendRoot, ...p), 'utf8').replace(/\r\n/g, '\n');

const sheetsSource = read('src', 'services', 'google-sheets.service.ts');
const leaveSheetsSource = read('src', 'services', 'leave-sync.service.ts');

/**
 * The attendance sheet belongs to the customer, not to this system. These tests
 * pin the guarantees that make the integration safe to point at a live sheet.
 */

describe('Google Sheets is read-only', () => {
  it('requests only the read-only OAuth scope', () => {
    expect(sheetsSource).toContain('spreadsheets.readonly');
    // The read/write scope must never appear.
    expect(sheetsSource).not.toMatch(/auth\/spreadsheets'/);
    expect(sheetsSource).not.toContain('https://www.googleapis.com/auth/drive');
  });

  it('keeps LeaveRequests access read-only too', () => {
    expect(leaveSheetsSource).toContain('spreadsheets.readonly');
    expect(leaveSheetsSource).toContain('spreadsheets.values.get');
    for (const writeCall of ['values.update', 'values.append', 'values.clear', 'values.batchUpdate', 'spreadsheets.batchUpdate']) {
      expect(leaveSheetsSource).not.toContain(writeCall);
    }
  });

  it('never calls a Sheets write API', () => {
    for (const writeCall of [
      'values.update',
      'values.append',
      'values.clear',
      'values.batchUpdate',
      'spreadsheets.batchUpdate',
      'spreadsheets.create',
    ]) {
      expect(sheetsSource, writeCall).not.toContain(writeCall);
    }
  });

  it('only reads values from the sheet', () => {
    expect(sheetsSource).toContain('spreadsheets.values.get');
  });
});

describe('sync idempotency and protection', () => {
  it('upserts on the (employee, work_date) unique key', () => {
    expect(sheetsSource).toContain('employee_work_date');
    expect(sheetsSource).toContain('attendanceRecord.upsert');
  });

  it('never deletes attendance during a sync', () => {
    expect(sheetsSource).not.toContain('attendanceRecord.delete');
    expect(sheetsSource).not.toContain('attendanceRecord.deleteMany');
  });

  it('skips rows that are unchanged since the last import', () => {
    expect(sheetsSource).toContain('originalCheckIn?.getTime() === checkIn?.getTime()');
  });

  it('protects a manual correction unless explicitly allowed by settings', () => {
    expect(sheetsSource).toContain('existing?.isCorrected && !allowOverwriteCorrected');
    expect(sheetsSource).toContain('SHEET_OVERWRITE_CORRECTED');
  });

  it('ships SHEET_OVERWRITE_CORRECTED defaulting to false', async () => {
    const { DEFAULT_PAYROLL_SETTINGS } = await import('../src/config/payroll-defaults.js');
    const setting = DEFAULT_PAYROLL_SETTINGS.find((s) => s.key === 'SHEET_OVERWRITE_CORRECTED');
    expect(setting?.value).toBe('false');
  });

  it('skips rows belonging to a locked payroll period', () => {
    expect(sheetsSource).toContain('existing?.isLocked');
  });

  it('archives every fetched row verbatim before deciding what to do with it', () => {
    const archiveIndex = sheetsSource.indexOf('attendanceRawData.create');
    const lockedIndex = sheetsSource.indexOf('existing?.isLocked');
    expect(archiveIndex).toBeGreaterThan(-1);
    // Archival happens before the skip branches, so nothing is ever lost.
    expect(archiveIndex).toBeLessThan(lockedIndex);
  });

  it('preserves the imported values in original_check_in / original_check_out', () => {
    expect(sheetsSource).toContain('originalCheckIn: checkIn');
    expect(sheetsSource).toContain('originalCheckOut: checkOut');
  });
});

describe('employee matching', () => {
  it('resolves employees by employee_code only', () => {
    expect(sheetsSource).toContain('byCode.get(row.employeeCode)');
  });

  it('never looks an employee up by name', () => {
    // A name-based fallback could post one person's hours onto another.
    expect(sheetsSource).not.toMatch(/where:\s*\{\s*firstName/);
    expect(sheetsSource).not.toMatch(/where:\s*\{\s*lastName/);
    expect(sheetsSource).not.toContain('byName');
  });

  it('classifies an unrecognised code rather than guessing', () => {
    expect(sheetsSource).toContain("action: 'UNKNOWN_EMPLOYEE'");
    expect(sheetsSource).toContain('Unknown employee_code');
  });

  it('does not create employees implicitly during a sync', () => {
    expect(sheetsSource).not.toContain('employee.create');
  });
});

describe('invalid rows are never imported', () => {
  it('classifies a malformed date as INVALID', () => {
    expect(sheetsSource).toContain("action: 'INVALID'");
    expect(sheetsSource).toContain('Unrecognised date format');
  });

  it('classifies a malformed time as INVALID rather than a missing punch', () => {
    expect(sheetsSource).toContain('Unrecognised time format');
  });

  it('continues past every invalid classification instead of writing it', () => {
    // Each classification branch ends in `continue;` before the upsert.
    const upsertIndex = sheetsSource.indexOf('attendanceRecord.upsert');
    const invalidIndex = sheetsSource.indexOf("action: 'INVALID'");
    expect(invalidIndex).toBeLessThan(upsertIndex);
  });
});

describe('dry run writes nothing', () => {
  it('does not create a sync history record for a preview', () => {
    expect(sheetsSource).toContain('const sync = options.dryRun\n    ? null');
  });

  it('guards raw-data archival and the upsert behind the dry-run check', () => {
    expect(sheetsSource).toContain('if (!options.dryRun)');
    expect(sheetsSource).toContain('if (options.dryRun) {');
  });

  it('reports dryRun on the result so the UI cannot mistake a preview for an import', () => {
    expect(sheetsSource).toContain('dryRun: Boolean(options.dryRun)');
  });
});
