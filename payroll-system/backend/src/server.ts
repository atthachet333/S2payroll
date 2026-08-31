import { buildApp } from './app.js';
import { env } from './config/env.js';
import { ensureDefaultSettings, syncSettingMetadata } from './services/settings.service.js';
import { assertProductionConfig } from './config/production-guard.js';
import { autoSync } from './services/auto-sync.service.js';

async function main(): Promise<void> {
  const app = await buildApp();

  // Refuse to serve a production system with placeholder secrets, wide-open
  // CORS or a known seed password still in place.
  assertProductionConfig({
    error: (msg) => app.log.error(msg),
    warn: (msg) => app.log.warn(msg),
  });

  // Insert any payroll setting introduced since this database was seeded, so an
  // upgrade never leaves the calculation engine reading a missing key.
  try {
    const added = await ensureDefaultSettings();
    if (added > 0) app.log.info(`Added ${added} new payroll setting(s) from defaults`);
    // Labels and descriptions live in code; values live in the database. This
    // refreshes only the former, so a withdrawn rule cannot keep advertising
    // itself in the Settings page.
    const relabelled = await syncSettingMetadata();
    if (relabelled > 0) app.log.info(`Refreshed metadata on ${relabelled} payroll setting(s)`);
  } catch (err) {
    app.log.error({ err }, 'Could not reconcile default payroll settings');
  }

  // Started only after the database is reachable and settings are reconciled,
  // so the first cycle cannot run against a half-initialised system.
  autoSync.start(app.log);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down`);
    // Stop scheduling new cycles first; the timer is unref'd so it can never
    // hold the process open.
    await autoSync.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`Payroll API listening on http://localhost:${env.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
