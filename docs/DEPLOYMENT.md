# Deployment and operations

## Build and run

```bash
npm ci
npm run build                 # dist/server (API) + dist/web (SPA)
NODE_ENV=production DATABASE_URL=... APP_BASE_URL=https://time.example.org node dist/server/src/index.js
```

Or build the container: `docker build -t tutor-time-clock .`. The image runs as the `node` user and exposes `/healthz`.

On start, the API applies pending migrations, then serves `/v1/*` and the SPA. Put it behind an HTTPS-terminating proxy. With `NODE_ENV=production`, cookies are `Secure` and the API trusts `X-Forwarded-*` headers.

### Environment

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | local dev URL | Required in production |
| `PORT` | `3000` | |
| `NODE_ENV` | `development` | `production` enables Secure cookies, proxy trust and static serving |
| `APP_BASE_URL` | `http://localhost:5173` | Used in password-reset and invite links |
| `SESSION_TTL_HOURS` | `12` | Absolute session lifetime |
| `ALERT_WORKER_ENABLED` | `true` | Set `false` on all but one instance, or run the sweep separately |

## Before real employee data (release gates from the product pack)

These are organisational decisions. The software defaults are safe, but they are not legal approval.

- [ ] Payroll owner validates the CSV columns and a sample export; confirm the rounding policy is lawful in your jurisdiction.
- [ ] Retention period and legal-hold process agreed. `retention_days` is recorded but **nothing is deleted automatically**.
- [ ] Privacy review done before enabling location controls; tutors informed.
- [ ] Replace the development mailer with a transactional email provider. Implement the `Mailer` interface in `server/src/lib/mailer.ts` and pass it to `buildApp`.
- [ ] Decide on identity: keep local passwords, or front the app with your SSO/OIDC provider (and MFA).
- [ ] Backup and restore drill completed; alert on `/healthz` failures and on 5xx rates for `POST /v1/clock-events`.
- [ ] Remove or never load demo data. `npm run db:seed` refuses to run when `NODE_ENV=production`.

## Database hardening (recommended)

The app enforces append-only tables with triggers. For defence in depth, run the app as a role with no DDL rights and no UPDATE/DELETE on immutable tables:

```sql
CREATE ROLE ttc_app LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE ttc TO ttc_app;
GRANT USAGE ON SCHEMA public TO ttc_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ttc_app;
REVOKE UPDATE, DELETE ON clock_events, time_adjustments, audit_logs FROM ttc_app;
```

Run migrations with a separate owner role (`npm run db:migrate` with an owner `DATABASE_URL`), then start the app with `ttc_app`.

## What to monitor

- Clock API latency and errors (`POST /v1/clock-events`). Each response carries an `x-request-id` that also appears in logs and audit rows.
- Rejected transitions (409s), idempotent replays (200 responses on the clock endpoint), and pending corrections older than the service target.
- Failed exports (`export_jobs.status = 'failed'`) and alert sweep errors (`"alert sweep failed"` in logs).

## Scaling notes

- The rate limiter is in memory (per instance). Move it to Redis or similar before running multiple instances.
- Exports are generated synchronously inside a snapshot transaction, which suits ranges up to 93 days at MVP scale. The `export_jobs` status lifecycle already supports moving generation to a background worker.
- Export files are stored in the database (`bytea`) and expire after 7 days. Move them to private object storage with signed URLs if volume grows.
