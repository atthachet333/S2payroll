import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // The integration test boots the whole Fastify app, which pulls in heavy
    // dependencies (googleapis, exceljs); give the boot hook room to finish.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
