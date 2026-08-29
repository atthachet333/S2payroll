# Security

## Authentication

### Password storage

Passwords are hashed with **Argon2id** (`@node-rs/argon2`) using OWASP-aligned parameters:

```
memoryCost  19456 KiB (19 MiB)
timeCost    2 iterations
parallelism 1
```

Hashes are never returned by any endpoint — the user listing strips `passwordHash` explicitly.

### Tokens

| Token | Form | Lifetime | Storage |
|---|---|---|---|
| Access | Signed JWT (`HS256`) | `JWT_ACCESS_TTL`, default 15m | Client memory / localStorage |
| Refresh | Opaque 96-hex random string | `JWT_REFRESH_TTL`, default 7d | Server-side row, SHA-256 digest only |

Refresh tokens are **not** JWTs. They are random strings tracked in `refresh_tokens`, and only
their SHA-256 digest is stored — a database leak cannot be replayed as a session.

**Rotation**: presenting a refresh token revokes it and issues a new pair, so a stolen token has
a narrow window and its reuse is detectable.

**Revocation** happens on logout, password change, account disable, and admin password reset.

### Active-account re-check

The `authenticate` hook re-reads `is_active` and the current role from the database on **every**
authenticated request rather than trusting the JWT claim. Disabling an account or changing a
role takes effect immediately, not when the access token expires.

### Account enumeration

Login returns the same 401 message whether the account is missing, disabled, or the password is
wrong.

---

## Authorisation (RBAC)

The permission matrix lives in exactly one file, `backend/src/config/permissions.ts`, so a role
change is a single-line edit rather than a hunt through route handlers.

Routes declare what they need:

```ts
app.post('/periods/:id/approve',
  { preHandler: [app.requirePermission('payroll:approve')] },
  handler);
```

Roles: `SUPER_ADMIN` · `ADMIN` · `HR` · `PAYROLL` · `VIEWER`. The full matrix is in
[API.md](API.md#permission-matrix).

### Privilege boundaries

- **`payroll:unlock` is `SUPER_ADMIN` only** — it is the single permission `ADMIN` does not hold.
  Unlocking is guarded by `requireRole('SUPER_ADMIN')`, needs a reason of at least 5 characters,
  and always writes an audit entry.
- **Only a `SUPER_ADMIN` may create or promote another `SUPER_ADMIN`.**
- **The last active `SUPER_ADMIN` cannot be disabled**, so the system cannot be locked out.
- **Users cannot disable their own account** (enforced in the UI and by the last-admin check).

### Frontend permissions are cosmetic

`useAuth().can(...)` hides actions a role cannot perform. This is a usability measure only —
the backend enforces the same matrix independently on every request, so a modified client gains
nothing.

---

## Transport and HTTP hardening

Registered in `plugins/security.ts`:

| Control | Configuration |
|---|---|
| **Helmet** | Restrictive CSP (`default-src 'self'`, `frame-ancestors 'none'`), `nosniff`, HSTS, `X-Frame-Options` |
| **CORS** | Allow-list from `CORS_ORIGIN`; an unlisted origin is not reflected. Credentials enabled. |
| **Rate limiting** | 300/min global; 10/min login; 60/min refresh; 6/min sheet sync. Keyed by user id when authenticated, else IP. |
| **Body limit** | 5 MB |
| **Trust proxy** | Enabled so client IPs are correct behind a reverse proxy |

The tighter login limit is the primary defence against credential stuffing.

---

## Input validation

Every request body and query string is parsed with a **Zod** schema before reaching a service —
see `backend/src/schemas/index.ts`. Unvalidated input never reaches business logic or Prisma.

**SQL injection** is structurally prevented: all database access goes through Prisma's
parameterised query builder. There is no raw SQL string interpolation anywhere in the codebase.

**Mass assignment** is prevented because update handlers copy fields explicitly rather than
spreading the request body into Prisma.

**Field allow-lists** guard the sensitive paths: payroll adjustments are restricted to ten named
money fields, checked server-side, so no other column can be reached through that endpoint.

---

## Error handling

`plugins/error-handler.ts` maps every error to a stable JSON envelope:

```json
{ "error": { "code": "…", "message": "…", "details": [] } }
```

- **Stack traces are never returned.** Unhandled errors are logged server-side and returned as a
  generic `INTERNAL_ERROR`. A test asserts no stack frames appear in an error body.
- Prisma error codes are translated: `P2002` → 409 `DUPLICATE`, `P2025` → 404, `P2003` → 409.
- Zod failures return 400 with field-level detail (safe to display).

---

## Secrets

- Secrets live only in `backend/.env`, which is git-ignored. `.env.example` ships with
  placeholders and no real values.
- **The frontend never receives a secret.** Only `VITE_API_URL` is exposed, and every Vite
  variable is compiled into the public bundle by design.
- Google credentials are held only on the backend; the browser never talks to Google.
- Environment variables are validated by Zod at startup and the process **exits** on invalid
  configuration, so a missing `JWT_SECRET` fails loudly at boot instead of silently at runtime.
- `JWT_SECRET` and `JWT_REFRESH_SECRET` must differ, and each must be at least 16 characters
  (use 48+ random bytes in production).
- Logs redact `authorization`, `cookie` and `body.password`.

---

## Audit logging

`audit_logs` is append-only and records `user_id`, `user_email`, `action`, `entity`, `entity_id`,
`old_value`, `new_value`, `reason`, `ip_address`, `user_agent` and `created_at`.

Audited actions include:

| Action | Notes |
|---|---|
| `LOGIN`, `PASSWORD_CHANGE` | |
| `EMPLOYEE_CREATE` / `_UPDATE` / `_DEACTIVATE` | Salary changes carry old and new values |
| `ATTENDANCE_CORRECT` | Old and new punches plus mandatory reason |
| `SHEET_SYNC` | Counts and outcome |
| `PAYROLL_CALCULATE` / `_APPROVE` / `_MARK_PAID` | Workflow provenance |
| `PAYROLL_LOCK` / **`PAYROLL_UNLOCK`** | Unlock always carries a reason |
| `PAYROLL_ADJUST` | Field-level old and new values plus reason |
| `SETTINGS_UPDATE` | Old and new values of every changed key |
| `USER_CREATE` / `_UPDATE` | Role and active-state changes |

Audit writes are best-effort and never roll back the operation they describe — a logging failure
must not lose a payroll approval.

Beyond the audit log, three tables are themselves append-only histories:
`attendance_raw_data`, `attendance_adjustments` and `payroll_adjustments`.

---

## Financial integrity

- **Locked periods are immutable.** Every money-mutating path calls `assertNotLocked` first.
  Locking also freezes the period's attendance rows.
- **Unlock is privileged, justified and logged** — `SUPER_ADMIN` only, reason mandatory.
- **Workflow transitions are validated** against a single declared table; an invalid transition
  is rejected with 400.
- **Payroll snapshots employee identity**, so a past run stays correct after a rename or transfer.
- **Settings are frozen per period** in `settings_snapshot`, so a historical calculation can
  always be re-explained.
- **Decimal arithmetic throughout** — no floating-point rounding drift on any money path.

---

## Production checklist

- [ ] Replace `JWT_SECRET` and `JWT_REFRESH_SECRET` with fresh 48-byte random values
- [ ] Change the seeded administrator password and set a real `SEED_ADMIN_*` before first deploy
- [ ] `NODE_ENV=production`
- [ ] Set `CORS_ORIGIN` to the real frontend origin only — never `*`
- [ ] Terminate TLS at the reverse proxy; never serve the API over plain HTTP
- [ ] Give the database user only the privileges it needs (no `GRANT ALL` in production)
- [ ] Restrict MariaDB to the application host; do not expose 3306 publicly
- [ ] Confirm the Google service account has **Viewer** access, not Editor
- [ ] Set up encrypted, tested database backups
- [ ] Ship logs somewhere durable and monitor 401/403/429 rates
- [ ] Review the user list and remove unused accounts
- [ ] Re-verify the statutory tax and social-security defaults for the payroll year

---

## Known limitations

- **Token storage.** Tokens are kept in `localStorage`, which is readable by any script running
  on the page — an XSS vulnerability would expose them. The CSP and React's default escaping
  mitigate this. Moving refresh tokens to `httpOnly` cookies would be stronger; the backend
  already registers `@fastify/cookie` for that migration.
- **Rate limiting is in-process.** With multiple API instances, limits apply per instance. Use
  a shared Redis store for `@fastify/rate-limit` in a clustered deployment.
- **No MFA.** Single-factor password authentication only.
- **No automatic password-expiry or lockout after repeated failures** beyond the rate limit.
- **Audit logs have no retention policy** — they grow indefinitely and are not tamper-evident
  (append-only by convention, not cryptographically chained).
