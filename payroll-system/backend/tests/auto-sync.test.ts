import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  normaliseSyncInterval,
  safeErrorSummary,
  MIN_SYNC_INTERVAL_SECONDS,
  DEFAULT_SYNC_INTERVAL_SECONDS,
} from '../src/services/auto-sync.service.js';
import { DEFAULT_SETTINGS_MAP } from '../src/config/payroll-defaults.js';

/**
 * Background Google sync.
 *
 * The scheduler owns no import logic - it sequences the existing sync services
 * behind one lock. These tests pin the parts that are easy to regress: the
 * interval floor, the secret scrubbing, the single-flight guarantee, the source
 * ordering, and the single-process assumption the in-memory mutex rests on.
 */

const BACKEND = path.resolve(__dirname, '..');
const ROOT = path.resolve(BACKEND, '..');
const read = (p: string) => fs.readFileSync(path.join(BACKEND, p), 'utf8');
const service = read('src/services/auto-sync.service.ts');

// ---------------------------------------------------------------------------
// Interval
// ---------------------------------------------------------------------------

describe('sync interval is clamped to something the Sheets API tolerates', () => {
  it('defaults to 60 seconds', () => {
    expect(DEFAULT_SYNC_INTERVAL_SECONDS).toBe(60);
    expect(DEFAULT_SETTINGS_MAP.GOOGLE_SYNC_INTERVAL_SECONDS).toBe('60');
  });

  it('never polls faster than 30 seconds', () => {
    expect(MIN_SYNC_INTERVAL_SECONDS).toBe(30);
    expect(normaliseSyncInterval(1)).toBe(30);
    expect(normaliseSyncInterval(29)).toBe(30);
    expect(normaliseSyncInterval(30)).toBe(30);
  });

  it('honours a larger interval as given', () => {
    expect(normaliseSyncInterval(45)).toBe(45);
    expect(normaliseSyncInterval(600)).toBe(600);
  });

  it('falls back to the default for nonsense', () => {
    expect(normaliseSyncInterval(0)).toBe(60);
    expect(normaliseSyncInterval(-10)).toBe(60);
    expect(normaliseSyncInterval(Number.NaN)).toBe(60);
  });

  it('floors a fractional interval rather than drifting', () => {
    expect(normaliseSyncInterval(90.7)).toBe(90);
  });

  it('is not hardcoded at the call sites - the setting is read each tick', () => {
    expect(service).toContain("settings.number('GOOGLE_SYNC_INTERVAL_SECONDS')");
    expect(service).toContain("settings.boolean('GOOGLE_SYNC_ENABLED')");
    // readConfig runs inside tick(), not once at startup.
    expect(service).toMatch(/private async tick\(\)[\s\S]*?await this\.readConfig\(\)/);
  });
});

// ---------------------------------------------------------------------------
// Settings take effect without a restart
// ---------------------------------------------------------------------------

describe('settings changes apply without restarting the backend', () => {
  it('re-reads enabled and interval on every tick', () => {
    const tick = service.slice(service.indexOf('private async tick'), service.indexOf('async runCycle'));
    expect(tick).toContain('this.readConfig()');
    expect(tick).toContain('if (config.enabled)');
  });

  it('reschedules using the freshly read interval', () => {
    const tick = service.slice(service.indexOf('private async tick'), service.indexOf('async runCycle'));
    expect(tick).toContain('this.scheduleNext(interval)');
  });

  it('uses a self-rescheduling timeout rather than a fixed setInterval', () => {
    expect(service).toContain('setTimeout');
    expect(service).not.toContain('setInterval(');
  });

  it('rejects an interval below the floor at save time', () => {
    const settings = read('src/services/settings.service.ts');
    expect(settings).toContain("key === 'GOOGLE_SYNC_INTERVAL_SECONDS'");
    expect(settings).toContain('seconds < 30');
  });
});

// ---------------------------------------------------------------------------
// Ordering and reuse
// ---------------------------------------------------------------------------

describe('a cycle runs Employees, then Attendance, then Leave', () => {
  it('sequences the three sources in dependency order', () => {
    expect(service).toContain("for (const source of ['employees', 'attendance', 'leave'] as const)");
  });

  it('delegates to the existing sync services instead of re-parsing Google', () => {
    expect(service).toContain('importEmployees');
    expect(service).toContain('syncAttendance');
    expect(service).toContain('importLeaves');
    // No sheet parsing of its own.
    expect(service).not.toContain('spreadsheets.values');
    expect(service).not.toContain('googleapis');
  });

  it('awaits each source, so attendance cannot start before employees finish', () => {
    expect(service).toMatch(/const ok = await this\.runSource\(source\)/);
  });
});

// ---------------------------------------------------------------------------
// Single flight
// ---------------------------------------------------------------------------

describe('only one cycle runs at a time', () => {
  it('declines and counts a cycle that arrives while busy', () => {
    expect(service).toContain('if (this.running) {');
    expect(service).toContain('skippedBecauseBusy += 1');
    expect(service).toContain('return null;');
  });

  it('releases the lock even when sources failed', () => {
    const cycle = service.slice(service.indexOf('async runCycle'), service.indexOf('private async runSource'));
    expect(cycle).toContain('this.running = false');
    // runSource swallows its own errors, so the cycle cannot throw past release.
    expect(cycle).not.toContain('throw');
  });

  it('shares that lock with the manual endpoint', () => {
    const routes = read('src/routes/sheets.routes.ts');
    expect(routes).toContain("autoSync.runCycle('manual')");
    expect(routes).toContain('SYNC_ALREADY_RUNNING');
    expect(routes).toContain('409');
  });
});

// ---------------------------------------------------------------------------
// Failure isolation
// ---------------------------------------------------------------------------

describe('a failing source cannot crash the backend', () => {
  it('catches per source and keeps going', () => {
    const runSource = service.slice(
      service.indexOf('private async runSource'),
      service.indexOf('private async executeSource')
    );
    expect(runSource).toContain('try {');
    expect(runSource).toContain('} catch (error) {');
    expect(runSource).toContain('return false;');
    expect(runSource).not.toContain('throw');
  });

  it('catches around the tick so the timer always reschedules', () => {
    const tick = service.slice(service.indexOf('private async tick'), service.indexOf('async runCycle'));
    expect(tick).toContain('} catch (error) {');
    expect(tick).toContain('} finally {');
  });
});

describe('status and logs carry no secrets', () => {
  it('redacts a private key', () => {
    const summary = safeErrorSummary(
      new Error('auth failed -----BEGIN PRIVATE KEY-----abc123def-----END PRIVATE KEY----- retry')
    );
    expect(summary).not.toContain('abc123def');
    expect(summary).toContain('[redacted key]');
  });

  it('redacts a database connection string', () => {
    const summary = safeErrorSummary(new Error('connect failed mysql://user:pw@10.0.0.1:3306/db'));
    expect(summary).not.toContain('pw@');
    expect(summary).not.toContain('mysql://');
  });

  it('caps the length so a huge payload cannot land in the response', () => {
    expect(safeErrorSummary(new Error('x'.repeat(5000))).length).toBeLessThanOrEqual(300);
  });

  it('handles a non-Error throw', () => {
    expect(safeErrorSummary('plain string')).toBe('plain string');
    expect(safeErrorSummary(null)).toBe('Unknown error');
  });

  it('never places credentials in the status object', () => {
    for (const secret of ['GOOGLE_PRIVATE_KEY', 'DATABASE_URL', 'JWT_SECRET', 'accessToken']) {
      expect(service, secret).not.toContain(secret);
    }
  });
});

// ---------------------------------------------------------------------------
// Google stays read-only
// ---------------------------------------------------------------------------

describe('automatic sync cannot write to Google', () => {
  const syncSources = [
    'src/services/google-sheets.service.ts',
    'src/services/employee-sync.service.ts',
    'src/services/leave-sync.service.ts',
  ];

  it('uses only the readonly scope', () => {
    for (const file of syncSources) {
      expect(read(file), file).toContain('spreadsheets.readonly');
    }
  });

  it('calls no mutating Sheets method anywhere in the sync path', () => {
    for (const file of [...syncSources, 'src/services/auto-sync.service.ts']) {
      const text = read(file);
      for (const method of ['values.update', 'values.append', 'values.clear', 'batchUpdate', 'values.batchUpdate']) {
        expect(text, `${file} :: ${method}`).not.toContain(method);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Lifecycle and deployment
// ---------------------------------------------------------------------------

describe('scheduler lifecycle', () => {
  it('starts only after the app is built and settings reconciled', () => {
    const server = read('src/server.ts');
    expect(server.indexOf('autoSync.start')).toBeGreaterThan(server.indexOf('ensureDefaultSettings'));
  });

  it('stops before the server closes, and unrefs its timer', () => {
    const server = read('src/server.ts');
    expect(server).toContain('await autoSync.stop()');
    expect(server.indexOf('autoSync.stop')).toBeLessThan(server.indexOf('app.close()'));
    expect(service).toContain('this.timer.unref?.()');
  });

  it('clears the timer on stop so nothing keeps the process alive', () => {
    const stop = service.slice(service.indexOf('async stop()'));
    expect(stop).toContain('clearTimeout(this.timer)');
    expect(stop).toContain('this.timer = null');
  });
});

describe('the in-process mutex matches the deployment model', () => {
  const ecosystem = fs.readFileSync(path.join(ROOT, 'ecosystem.config.cjs'), 'utf8');

  it('runs the backend as a single fork-mode process', () => {
    // An in-memory lock is only sufficient while exactly one process exists.
    expect(ecosystem).toContain("exec_mode: 'fork'");
    expect(ecosystem).toContain('instances: 1');
    expect(ecosystem).not.toContain("exec_mode: 'cluster'");
  });

  it('documents that assumption where the lock is implemented', () => {
    expect(service).toContain("exec_mode: 'fork'");
    expect(service).toContain('advisory lock');
  });
});

// ---------------------------------------------------------------------------
// Frontend polling
// ---------------------------------------------------------------------------

describe('frontend refreshes from the database, never from Google', () => {
  const FRONTEND = path.resolve(ROOT, 'frontend');
  const readFe = (p: string) => fs.readFileSync(path.join(FRONTEND, p), 'utf8');
  const endpoints = readFe('src/services/endpoints.ts');

  it('declares one polling table rather than scattering intervals', () => {
    expect(endpoints).toContain('POLL_INTERVAL_MS');
    expect(endpoints).toContain('attendance: 30_000');
    expect(endpoints).toContain('overview: 60_000');
    expect(endpoints).toContain('employees: 60_000');
  });

  it('polls attendance, calendar, overview and employees', () => {
    const attendance = readFe('src/pages/AttendancePage.tsx');
    expect(attendance).toContain('refetchInterval: POLL_INTERVAL_MS.attendance');
    expect(attendance).toContain('refetchInterval: POLL_INTERVAL_MS.calendar');
    expect(readFe('src/pages/OverviewPage.tsx')).toContain('refetchInterval: POLL_INTERVAL_MS.overview');
    expect(readFe('src/pages/EmployeesPage.tsx')).toContain('refetchInterval: POLL_INTERVAL_MS.employees');
  });

  it('keeps the current page and filters across a background refetch', () => {
    const attendance = readFe('src/pages/AttendancePage.tsx');
    expect(attendance).toContain('placeholderData: (previous) => previous');
    expect(readFe('src/pages/EmployeesPage.tsx')).toContain('placeholderData: (previous) => previous');
  });

  it('does not poll payroll, so nothing recalculates on a timer', () => {
    const payroll = readFe('src/pages/PayrollPage.tsx');
    expect(payroll).not.toContain('refetchInterval');
  });

  it('never reaches Google from the browser', () => {
    for (const file of ['src/services/endpoints.ts', 'src/pages/AttendancePage.tsx']) {
      expect(readFe(file), file).not.toMatch(/googleapis|sheets\.googleapis/);
    }
  });

  it('shows a plain-language status, not a stack trace', () => {
    const widget = readFe('src/features/attendance/AutoSyncStatus.tsx');
    expect(widget).toContain('อัปเดตอัตโนมัติ');
    expect(widget).toContain('กำลังอัปเดต...');
    expect(widget).toContain('อัปเดตไม่สำเร็จ');
    expect(widget).toContain('อัปเดตอัตโนมัติปิดอยู่');
    // The raw backend summary is deliberately not rendered.
    expect(widget).not.toContain('{status.lastErrorSummary}');
  });
});
