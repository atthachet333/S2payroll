import { buildApp } from './app.js';
import { env } from './config/env.js';
import { ensureDefaultSettings } from './services/settings.service.js';
import { assertProductionConfig } from './config/production-guard.js';

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
  } catch (err) {
    app.log.error({ err }, 'Could not reconcile default payroll settings');
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down`);
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
