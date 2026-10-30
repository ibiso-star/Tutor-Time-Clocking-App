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

## Vercel + Supabase

The repository deploys to Vercel as static files plus one serverless function, with PostgreSQL on Supabase.

- **Static site:** the built SPA in `dist/web`.
- **API:** `api/index.ts` runs the same Fastify app.
- **Routing:** `vercel.json` sends `/v1/*` and `/healthz` to the function and everything else to the SPA, and sets the security headers.

**Database setup (once):**
1. Create a Supabase project and apply the migrations. The schema is `server/src/db/migrations/*.sql`; run them through the Supabase SQL editor, or run `npm run db:migrate` with the owner connection string.
2. Run `deploy/supabase-hardening.sql` as `postgres`. It does three things:
   - turns on Row Level Security with a policy admitting only `ttc_app`
   - removes Data API access for `anon` and `authenticated`
   - creates the least-privilege `ttc_app` login role
3. Set the role's password in the SQL editor: `ALTER ROLE ttc_app PASSWORD '<generated>';`. Keep it out of chat and source control.

**Vercel environment variables (Production):**

| Variable | Value |
|---|---|
| `DATABASE_URL` | Supabase **transaction pooler** string (port 6543), with user `ttc_app.<project-ref>` and the password above. Don't append `sslmode`. |
| `DATABASE_SSL` | `require` (TLS on, server certificate not verified), **or** set `DATABASE_CA_CERT` to the PEM text of Supabase's CA (Dashboard → Database settings → SSL) for full verification |
| `NODE_ENV` | `production` |
| `APP_BASE_URL` | The production URL, used in reset/invite links |
| `DEMO_SEED` | `true` only for a public demo: seeds demo data into an empty database on first start |
| `RESEND_API_KEY` | API key from [Resend](https://resend.com) (sending access is enough). Turns on real invite and password-reset emails. Without it, emails are only written to the function logs. |
| `MAIL_FROM` | Required with `RESEND_API_KEY`: the sender, on a domain verified in Resend, e.g. `Tutor Time Clock <noreply@example.org>` |

**Differences from the long-running server:**
- No migrations on start: apply them before deploying a new schema.
- No background alert worker: alert sweeps run (deduplicated, at most once a minute per instance) when reviewers poll their alerts.
- The login rate limiter is per function instance, so it's weaker than on a single server. Add a shared store before relying on it.

## Before real employee data (release gates from the product pack)

These are organisational decisions. The software defaults are safe, but they are not legal approval.

- [ ] Payroll owner validates the CSV columns and a sample export; confirm the rounding policy is lawful in your jurisdiction.
- [ ] Retention period and legal-hold process agreed. `retention_days` is recorded but **nothing is deleted automatically**.
- [ ] Privacy review done before enabling location controls; tutors informed.
- [ ] Turn on email: verify your sending domain in Resend, then set `RESEND_API_KEY` and `MAIL_FROM`. Send yourself a password reset to confirm delivery. If a send fails, the person is still added and the failure is logged (`invite email failed` / `password reset email failed`); they can use "Forgot password" to get a new link.
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
