# Vibe Amplified Tutor Time Clock

A mobile-first web app for tutors to record work sessions and breaks, and for supervisors to monitor attendance, review corrections, and export auditable timesheets.

Built from the product pack in [`docs/product/`](docs/product/README.md) (PRD, TRD, application flow, design brief, schema, implementation plan). This repository implements the **MVP scope (PRD §5, Implementation Plan phases 1–4)**. Optional and sensitive capabilities stay off or phase-gated, as the pack recommends. See [docs/IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md) for what is done, how each acceptance criterion is tested, and which policy decisions are still open.

## What it does

**Tutors** (phone-first)
- Clock in / out and start / end breaks. Each is one tap, with the official time stamped by the server.
- A live timer, today's total, a timecard strip of today's work and breaks, the next shift, and recent sessions.
- History by date, a per-session record (original events, corrections, adjustments), and correction requests with status.
- Clear offline and error states. A punch is never shown as recorded unless the server accepted it, and retries are safe.

**Supervisors and admins** (desktop-first, works on tablets and phones)
- A live roster with state, elapsed time, today's totals, and alerts for long sessions, missed clock-outs, long breaks, and location review.
- Filterable time entries and a full session investigation view: canonical calculation, raw events, adjustments, corrections, and audit trail.
- A corrections inbox with side-by-side compare. Decisions need a reason and are version-checked.
- Manual adjustments (correct times, add/remove minutes, void, or supersede an earlier adjustment), with a before/after preview and a warning about affected exports.
- CSV and PDF exports: explicit timezone and rounding, a reconciled preview, checksums, record versions, an "out of date" marker, and audited downloads.
- People and teams (team-scoped supervisors), locations with optional geofences, shifts, versioned project settings, and an append-only audit log.

## Quick start

Requirements: Node 20+ and PostgreSQL 14+ (or Docker for the database).

```bash
npm install
cp .env.example .env              # adjust DATABASE_URL if needed
docker compose up -d db           # or use your own PostgreSQL
npm run db:seed                   # migrates and loads demo data (refuses in production)
npm run dev                       # API on :3000, web on :5173
```

Open http://localhost:5173. Demo accounts all use the password `demo-password-1`:

| Email | Role | What you'll see |
|---|---|---|
| `admin@example.com` | Admin (all projects) | Full roster, settings, people, audit log |
| `supervisor@example.com` | Supervisor, North Campus | Roster and reviews for their team only |
| `ada@example.com` | Tutor | Clocked out, with a pending correction |
| `grace@example.com` | Tutor | Clocked in |
| `katherine@example.com` | Tutor | On break |
| `mary@example.com` | Tutor | Missed clock-out from yesterday |
| `alan@example.com` | Tutor | Clocked out, South Campus |

Password-reset and invite emails are printed to the API log in development (see [Deployment](docs/DEPLOYMENT.md) for production email).

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | API (watch) + Vite dev server with `/v1` proxy |
| `npm run build` / `npm start` | Production build; the API serves the built web app |
| `npm run db:migrate` | Apply pending SQL migrations |
| `npm run db:seed` | Migrate and load demo data into an empty database |
| `npm run typecheck` | TypeScript, server and web |
| `npm test` | Unit and integration tests (needs `TEST_DATABASE_URL`, default `ttc_test`) |
| `npm run test:e2e` | Playwright tests against the production build (needs `E2E_DATABASE_URL`, default `ttc_e2e`) |

The integration and E2E suites **drop and recreate the schema** of their database, and refuse to run unless the database name contains `test` or `e2e`.

## Project layout

```
server/src/
  domain/        pure, unit-tested rules: state machine, calculation, rounding, policy, CSV safety, timezones
  services/      transactional use cases: clock, review (corrections/adjustments), exports, notifications, access
  routes/        REST endpoints (/v1/...), validated with zod
  db/            pool, forward-only SQL migrations
server/test/     unit + integration tests (real PostgreSQL)
web/src/         React SPA: tutor screens, admin screens, shared components
e2e/             Playwright end-to-end tests
docs/            architecture, deployment, implementation status, product pack
```

## Documentation

- [Architecture and decisions](docs/ARCHITECTURE.md)
- [Deployment and operations](docs/DEPLOYMENT.md) (including Vercel + Supabase)
- [Implementation status, traceability and open decisions](docs/IMPLEMENTATION-STATUS.md)
- [Product pack](docs/product/README.md)
