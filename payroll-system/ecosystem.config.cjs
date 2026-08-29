/**
 * PM2 process definitions for the S2A Payroll system.
 *
 * Only the two applications below are defined here. Starting this file with
 * `pm2 start ecosystem.config.cjs` affects `s2apayroll-backend` and
 * `s2apayroll-frontend` only — any other PM2 application already running on
 * this host is untouched. Use `--only` if you want to be explicit.
 *
 *   pm2 start ecosystem.config.cjs --only s2apayroll-backend
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup            (then run the command it prints, as Administrator)
 *
 * No secrets appear in this file. Both applications read their configuration
 * from their own .env, which is git-ignored:
 *   backend/.env      (from backend/.env.production.example)
 *   frontend/.env     (from frontend/.env.production.example, build-time only)
 */

const path = require('node:path');

const root = __dirname;
const backendDir = path.join(root, 'backend');
const frontendDir = path.join(root, 'frontend');
const logDir = path.join(root, 'logs');

/** Settings shared by both applications. */
const common = {
  exec_mode: 'fork',
  instances: 1,
  autorestart: true,
  watch: false,
  // Restart on crash, but back off so a boot loop cannot spin the CPU.
  restart_delay: 4000,
  exp_backoff_restart_delay: 200,
  max_restarts: 10,
  min_uptime: '20s',
  max_memory_restart: '600M',
  time: true,
  merge_logs: true,
  log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
};

module.exports = {
  apps: [
    {
      name: 's2apayroll-backend',
      cwd: backendDir,
      // Runs the compiled output. Build first: npm run build
      script: path.join(backendDir, 'dist', 'server.js'),
      interpreter: 'node',
      ...common,

      env: {
        NODE_ENV: 'production',
        // PORT and every secret come from backend/.env, loaded by dotenv at
        // startup. They are deliberately not repeated here.
      },

      // server.ts handles SIGINT/SIGTERM: it closes Fastify and disconnects
      // Prisma before exiting, so in-flight requests finish cleanly.
      kill_timeout: 10000,
      listen_timeout: 15000,
      shutdown_with_message: false,
      wait_ready: false,

      out_file: path.join(logDir, 'backend-out.log'),
      error_file: path.join(logDir, 'backend-error.log'),
    },

    {
      name: 's2apayroll-frontend',
      cwd: frontendDir,
      // Serves the built static bundle from frontend/dist on port 2233.
      // `vite preview` is used because it correctly serves the SPA fallback,
      // which a plain static server would need configuring for.
      script: path.join(frontendDir, 'node_modules', 'vite', 'bin', 'vite.js'),
      args: 'preview --port 2233 --strictPort --host 127.0.0.1',
      interpreter: 'node',
      ...common,

      env: {
        NODE_ENV: 'production',
      },

      kill_timeout: 5000,
      out_file: path.join(logDir, 'frontend-out.log'),
      error_file: path.join(logDir, 'frontend-error.log'),
    },
  ],
};
