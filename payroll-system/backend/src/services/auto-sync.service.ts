/**
 * Background Google Sheets sync.
 *
 * A single timer polls the settings each tick and, when enabled, runs one sync
 * cycle: Employees, then Attendance, then LeaveRequests. That order matters -
 * attendance and leave rows are matched to an employee by code, so a newly
 * hired person must exist before their punches or leave arrive.
 *
 * This module owns no import logic of its own. It calls the existing sync
 * services, so every guarantee they already provide - read-only Google access,
 * idempotent writes, manual-correction protection, locked-period protection,
 * suppression of deleted days, executive exemptions - applies unchanged.
 *
 * Concurrency: the process runs under PM2 `exec_mode: 'fork'` with
 * `instances: 1`, so exactly one Node process exists and an in-process mutex is
 * sufficient. If the deployment ever moves to cluster mode or multiple
 * replicas, this lock must be replaced with a database advisory lock -
 * `ecosystem.config.cjs` is asserted by a test to keep that assumption honest.
 */
import type { FastifyBaseLogger } from 'fastify';
import { loadSettings } from './settings.service.js';
import { importEmployees } from './employee-sync.service.js';
import { importLeaves } from './leave-sync.service.js';
import { syncAttendance } from './google-sheets.service.js';
import { prisma } from '../plugins/prisma.js';

/** Polling any faster than this would hammer the Sheets API for no benefit. */
export const MIN_SYNC_INTERVAL_SECONDS = 30;
export const DEFAULT_SYNC_INTERVAL_SECONDS = 60;

export type SyncSourceName = 'employees' | 'attendance' | 'leave';
export type SyncOverallStatus = 'IDLE' | 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'FAILED';

export function overallSyncStatus(failedSources: number, totalSources = 3): SyncOverallStatus {
  if (failedSources <= 0) return 'SUCCESS';
  if (failedSources >= totalSources) return 'FAILED';
  return 'PARTIAL';
}

export interface SyncSourceStatus {
  status: 'IDLE' | 'RUNNING' | 'SUCCESS' | 'FAILED';
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessfulAt: string | null;
  lastErrorAt: string | null;
  /** Human-readable, secret-free. */
  lastErrorSummary: string | null;
  /** Counts from the last successful run. */
  lastCounts: Record<string, number> | null;
}

export interface AutoSyncStatus {
  overall: SyncOverallStatus;
  enabled: boolean;
  running: boolean;
  intervalSeconds: number;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessfulAt: string | null;
  lastErrorAt: string | null;
  lastErrorSummary: string | null;
  /** Cycles declined because a previous cycle was still running. */
  skippedBecauseBusy: number;
  cyclesRun: number;
  sources: Record<SyncSourceName, SyncSourceStatus>;
}

const emptySource = (): SyncSourceStatus => ({
  status: 'IDLE',
  lastStartedAt: null,
  lastCompletedAt: null,
  lastSuccessfulAt: null,
  lastErrorAt: null,
  lastErrorSummary: null,
  lastCounts: null,
});

/**
 * Reduce any thrown value to a short operator-facing sentence.
 *
 * Credentials and connection strings can appear inside driver and Google client
 * errors, so the message is both truncated and scrubbed of anything resembling
 * a key, token or URL before it is stored or returned by the API.
 */
export function safeErrorSummary(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return raw
    .replace(/-----BEGIN[\s\S]*?END[^-]*-----/g, '[redacted key]')
    .replace(/\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]*/g, '[redacted url]')
    .replace(/\b(?:key|token|secret|password|credential)\b\s*[:=]\s*\S+/gi, '$& '.replace(/.*/, '[redacted]'))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

class AutoSyncScheduler {
  private timer: NodeJS.Timeout | null = null;
  /** The single concurrency gate shared by background and manual runs. */
  private running = false;
  private stopped = false;
  private logger: FastifyBaseLogger | null = null;

  private status: AutoSyncStatus = {
    overall: 'IDLE',
    enabled: false,
    running: false,
    intervalSeconds: DEFAULT_SYNC_INTERVAL_SECONDS,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastSuccessfulAt: null,
    lastErrorAt: null,
    lastErrorSummary: null,
    skippedBecauseBusy: 0,
    cyclesRun: 0,
    sources: {
      employees: emptySource(),
      attendance: emptySource(),
      leave: emptySource(),
    },
  };

  /** Clamp an operator-supplied interval to something the Sheets API tolerates. */
  static normaliseInterval(seconds: number): number {
    if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_SYNC_INTERVAL_SECONDS;
    return Math.max(MIN_SYNC_INTERVAL_SECONDS, Math.floor(seconds));
  }

  /**
   * Read the live configuration. Called every tick rather than cached, so an
   * operator toggling the switch or changing the interval in Settings takes
   * effect on the next cycle with no restart.
   */
  private async readConfig(): Promise<{ enabled: boolean; intervalSeconds: number }> {
    const settings = await loadSettings();
    return {
      enabled: settings.boolean('GOOGLE_SYNC_ENABLED'),
      intervalSeconds: AutoSyncScheduler.normaliseInterval(
        settings.number('GOOGLE_SYNC_INTERVAL_SECONDS')
      ),
    };
  }

  start(logger: FastifyBaseLogger): void {
    this.logger = logger;
    this.stopped = false;
    this.scheduleNext(DEFAULT_SYNC_INTERVAL_SECONDS);
    logger.info('Google auto-sync scheduler started');
  }

  /**
   * One self-rescheduling timer rather than setInterval: the next delay is
   * chosen after each tick from the current setting, so an interval change is
   * picked up without tearing down and rebuilding timers.
   */
  private scheduleNext(seconds: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, seconds * 1000);
    // Never hold the event loop open; a pending sync must not block shutdown.
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    let interval = DEFAULT_SYNC_INTERVAL_SECONDS;
    try {
      const config = await this.readConfig();
      interval = config.intervalSeconds;
      this.status.enabled = config.enabled;
      this.status.intervalSeconds = interval;

      if (config.enabled) {
        await this.runCycle('scheduler');
      }
    } catch (error) {
      // A settings read failure must not kill the timer.
      this.status.lastErrorAt = new Date().toISOString();
      this.status.lastErrorSummary = safeErrorSummary(error);
      this.logger?.error({ err: error }, 'Auto-sync tick failed');
    } finally {
      this.scheduleNext(interval);
    }
  }

  /**
   * Run one full cycle. Returns null when another cycle already holds the lock,
   * which is how both the scheduler and the manual endpoint decline safely.
   */
  async runCycle(trigger: 'scheduler' | 'manual'): Promise<AutoSyncStatus | null> {
    if (this.running) {
      this.status.skippedBecauseBusy += 1;
      this.logger?.debug({ trigger }, 'Auto-sync skipped: a cycle is already running');
      return null;
    }
    this.running = true;
    this.status.running = true;
    this.status.overall = 'RUNNING';
    this.status.lastStartedAt = new Date().toISOString();

    // Each source runs independently: one failing source must not stop the
    // others, and must never propagate out of the cycle.
    let failedSources = 0;
    for (const source of ['employees', 'attendance', 'leave'] as const) {
      const ok = await this.runSource(source);
      if (!ok) failedSources += 1;
    }

    this.status.cyclesRun += 1;
    this.status.lastCompletedAt = new Date().toISOString();
    this.status.overall = overallSyncStatus(failedSources);
    if (failedSources > 0) {
      this.status.lastErrorAt = this.status.lastCompletedAt;
    } else {
      this.status.lastSuccessfulAt = this.status.lastCompletedAt;
      this.status.lastErrorSummary = null;
    }
    this.running = false;
    this.status.running = false;
    return this.getLiveStatus();
  }

  private async runSource(source: SyncSourceName): Promise<boolean> {
    const entry = this.status.sources[source];
    entry.status = 'RUNNING';
    entry.lastStartedAt = new Date().toISOString();
    try {
      const counts = await this.executeSource(source);
      entry.lastCounts = counts;
      entry.lastCompletedAt = new Date().toISOString();
      entry.lastSuccessfulAt = entry.lastCompletedAt;
      entry.lastErrorSummary = null;
      entry.status = 'SUCCESS';
      return true;
    } catch (error) {
      const summary = safeErrorSummary(error);
      entry.lastCompletedAt = new Date().toISOString();
      entry.lastErrorAt = entry.lastCompletedAt;
      entry.lastErrorSummary = summary;
      entry.status = 'FAILED';
      this.status.lastErrorSummary = summary;
      this.logger?.warn({ source, summary }, 'Auto-sync source failed');
      return false;
    }
  }

  /**
   * Delegates to the existing sync services. No Google parsing or import logic
   * is reimplemented here.
   */
  private async executeSource(source: SyncSourceName): Promise<Record<string, number>> {
    if (source === 'employees') {
      const result = await importEmployees({
        // The sheet carries no hire date; new employees start today and are
        // flagged for payroll review, exactly as the manual import does.
        defaultStartDate: new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z'),
      });
      return {
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
      };
    }

    if (source === 'attendance') {
      const actor = await this.systemActor();
      const result = await syncAttendance({ actor });
      return {
        imported: result.imported,
        updated: result.updated,
        duplicates: result.duplicates,
        protected: result.protected,
        skipped: result.skipped,
        invalid: result.invalid,
        unknownEmployee: result.unknownEmployee,
      };
    }

    const result = await importLeaves({});
    return {
      created: result.created,
      updated: result.updated,
      unchanged: result.unchanged,
      skippedInvalid: result.skippedInvalid,
      skippedUnknownEmployee: result.skippedUnknownEmployee.length,
    };
  }

  /** Attribute automated writes to the bootstrap admin, as manual syncs are. */
  private async systemActor(): Promise<{ userId: string; email: string }> {
    const admin = await prisma.user.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true, email: true },
    });
    if (!admin) throw new Error('No active user to attribute the automatic sync to');
    return { userId: admin.id, email: admin.email };
  }

  /**
   * Status with `enabled` and `intervalSeconds` read live from settings.
   *
   * The cached copy is only refreshed by a tick, so between boot and the first
   * tick it would report the scheduler as disabled even when the setting says
   * otherwise - and the UI would show "ปิดอยู่" for up to a full interval.
   */
  async getLiveStatus(): Promise<AutoSyncStatus> {
    try {
      const config = await this.readConfig();
      this.status.enabled = config.enabled;
      this.status.intervalSeconds = config.intervalSeconds;
    } catch {
      // Fall through to the cached values rather than failing the endpoint.
    }
    return this.getStatus();
  }

  getStatus(): AutoSyncStatus {
    // Deep copy so a caller cannot mutate scheduler state through the response.
    return {
      ...this.status,
      sources: {
        employees: { ...this.status.sources.employees },
        attendance: { ...this.status.sources.attendance },
        leave: { ...this.status.sources.leave },
      },
    };
  }

  /** True while a cycle holds the lock; used by the manual endpoint. */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Stop scheduling further cycles. A cycle already in flight is left to finish
   * its current source rather than being torn out mid-write; the timer is
   * unref'd and cleared so nothing keeps the process alive.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger?.info('Google auto-sync scheduler stopped');
  }

  /** Test seam: restore a pristine scheduler between cases. */
  resetForTests(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.running = false;
    this.status.running = false;
    this.status.skippedBecauseBusy = 0;
    this.status.cyclesRun = 0;
  }
}

export const autoSync = new AutoSyncScheduler();
export const normaliseSyncInterval = AutoSyncScheduler.normaliseInterval;
