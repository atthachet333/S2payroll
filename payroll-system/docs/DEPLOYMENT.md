# Deployment

## Build

### Backend

```bash
cd backend
npm ci
npm run prisma:generate
npm run typecheck
npm test
npm run build          # → dist/
```

`npm run build` uses `tsconfig.build.json`, which compiles only `src/` (tests and the seed
script stay out of the production bundle). The entry point is `dist/server.js`.

### Frontend

```bash
cd frontend
npm ci
npm run build          # type-checks, then → dist/
```

Output is a static bundle, split into `react`, `charts`, `query` and app chunks so the heavy
libraries stay cacheable across deploys.

Set `VITE_API_URL` **before** building — Vite inlines environment variables at build time, so
changing it later requires a rebuild.

```bash
VITE_API_URL=https://payroll-api.example.co.th npm run build
```

---

## Database

```bash
cd backend
npm run prisma:deploy     # applies committed migrations; never prompts
```

Use `prisma:deploy` in production, never `prisma:migrate` (which can prompt and reset).

Seed once, on a fresh installation only:

```bash
npm run seed
```

The seed is idempotent, but on a production database run it only for the initial bootstrap —
it creates demo employees and attendance you will not want in a live system. For production,
seed and then remove the demo records, or run only the roles/settings portions.

**Change the administrator password immediately after the first login.**

---

## Running the API

### systemd

`/etc/systemd/system/payroll-api.service`:

```ini
[Unit]
Description=Payroll API
After=network.target mariadb.service

[Service]
Type=simple
User=payroll
WorkingDirectory=/opt/payroll/backend
EnvironmentFile=/opt/payroll/backend/.env
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/payroll/backend

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now payroll-api
sudo journalctl -u payroll-api -f
```

The server handles `SIGINT` and `SIGTERM`, closing Fastify and disconnecting Prisma before exit,
so restarts do not drop in-flight requests abruptly.

### PM2

```bash
npm i -g pm2
cd /opt/payroll/backend
pm2 start dist/server.js --name payroll-api
pm2 save && pm2 startup
```

### Windows

Run the API as a service with [NSSM](https://nssm.cc/):

```
nssm install PayrollAPI "C:\Program Files\nodejs\node.exe" "D:\payroll\backend\dist\server.js"
nssm set PayrollAPI AppDirectory D:\payroll\backend
nssm start PayrollAPI
```

---

## Serving the frontend

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name payroll.example.co.th;

    ssl_certificate     /etc/letsencrypt/live/payroll.example.co.th/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/payroll.example.co.th/privkey.pem;

    root /opt/payroll/frontend/dist;
    index index.html;

    # Hashed assets are immutable; index.html must never be cached.
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    # Client-side routing: unknown paths fall through to the SPA.
    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:2234;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;   # sheet syncs and payroll runs can be slow
    }

    client_max_body_size 8m;
}

server {
    listen 80;
    server_name payroll.example.co.th;
    return 301 https://$host$request_uri;
}
```

`try_files … /index.html` is required — without it, refreshing on `/payroll/<id>` returns 404.

`X-Forwarded-For` matters because the API runs with `trustProxy`, and rate limiting keys on the
client IP for unauthenticated requests.

When the API is proxied under the same origin, set `VITE_API_URL` to the site origin (or an
empty string with a same-origin `/api` prefix) and set `CORS_ORIGIN` to that origin.

---

## Production environment

`backend/.env`:

```ini
NODE_ENV=production
PORT=2234
HOST=127.0.0.1                # bind to loopback; nginx is the only public listener
LOG_LEVEL=info

DATABASE_URL="mysql://payroll:STRONG_PASSWORD@localhost:3306/payroll_db"

JWT_SECRET=<48 random bytes, hex>
JWT_REFRESH_SECRET=<a different 48 random bytes, hex>
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d

CORS_ORIGIN=https://payroll.example.co.th

RATE_LIMIT_MAX=300
RATE_LIMIT_WINDOW=1 minute

GOOGLE_PROJECT_ID=...
GOOGLE_CLIENT_EMAIL=...
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GOOGLE_SHEET_ID=...
GOOGLE_SHEET_RANGE=Attendance!A:D
```

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

In `NODE_ENV=production` the logger emits JSON (no `pino-pretty`), suitable for shipping to a
log aggregator.

---

## Docker (optional)

`backend/Dockerfile`:

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
EXPOSE 2234
CMD ["node", "dist/server.js"]
```

`docker-compose.yml`:

```yaml
services:
  db:
    image: mariadb:11
    environment:
      MARIADB_DATABASE: payroll_db
      MARIADB_USER: payroll
      MARIADB_PASSWORD: ${DB_PASSWORD}
      MARIADB_ROOT_PASSWORD: ${DB_ROOT_PASSWORD}
    command: --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci
    volumes: [db-data:/var/lib/mysql]
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 10s
      retries: 10

  api:
    build: ./backend
    env_file: ./backend/.env
    depends_on:
      db: { condition: service_healthy }
    ports: ["2234:2234"]

volumes:
  db-data:
```

`utf8mb4` on the server is required for Thai text.

---

## Backups

```bash
mysqldump --single-transaction --routines --default-character-set=utf8mb4 \
  -u payroll -p payroll_db | gzip > payroll-$(date +%F).sql.gz
```

`--single-transaction` gives a consistent snapshot without locking writes.

Restore:

```bash
gunzip < payroll-2027-05-31.sql.gz | mysql -u payroll -p payroll_db
```

Back up daily, keep offsite copies, and **test a restore** — payroll data is not reproducible
from anywhere else. The Google Sheet holds only raw punches; corrections, adjustments,
approvals, payslips and audit history exist solely in this database.

---

## Health check and monitoring

```bash
curl -fsS http://127.0.0.1:2234/api/health
```

Returns 200 with `{"status":"ok"}`. Suitable for a load-balancer probe or a systemd watchdog.

Worth monitoring:

- non-200 rate on `/api/*`, especially 401/403/429 spikes
- sheet-sync failures (`google_sheet_syncs.status = FAILED`)
- database connection errors in the API logs
- disk usage — `attendance_raw_data` and `audit_logs` grow monotonically

---

## Upgrading

```bash
git pull
cd backend && npm ci && npm run prisma:generate && npm run prisma:deploy && npm run build
sudo systemctl restart payroll-api

cd ../frontend && npm ci && npm run build
sudo systemctl reload nginx
```

Take a database backup before applying migrations. If a release adds payroll settings, the
backend inserts the new defaults automatically via `ensureDefaultSettings` without disturbing
configured values.
