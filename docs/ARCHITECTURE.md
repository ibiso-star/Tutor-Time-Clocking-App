# Architecture and decisions

## Overview

```
Browser (React SPA)  ──HTTPS, cookie session + CSRF header──▶  Fastify API (/v1)  ──▶  PostgreSQL
                                                                 │  in-process alert worker (deduplicated)
                                                                 └─ serves built SPA in production
```

A single TypeScript codebase. The API is the only authority: the client never decides official time, state, role, or totals.

| Concern | Choice | Why |
|---|---|---|
| API | Fastify 5, REST/JSON, zod validation | TRD baseline; structured errors, small surface |
| Database | PostgreSQL, hand-written forward-only SQL migrations | Partial unique indexes, row locks, `timestamptz`, triggers for append-only tables |
| Web | React + Vite, no UI kit | Small bundle, full control of accessibility and states; admin screens lazy-loaded |
| Auth | Local email/password (scrypt), DB-backed opaque sessions, httpOnly SameSite cookies, per-session CSRF token | Self-contained MVP. The `users.auth_subject` column is ready for an OIDC provider (TRD §7) |
| Time | UTC `timestamptz` everywhere; IANA zone per project; Luxon for zone math | DST-safe days and reports (TRD §3) |
| PDF | pdfkit | Pure JS, no headless browser in production |

## Core invariants and where they are enforced

| Invariant (source) | Enforcement |
|---|---|
| Official time is the server's (PRD §8) | `clock_timestamp()` read inside the transaction after the lock; client time is stored only as `client_captured_at` |
| One open session per tutor per project (PRD §8) | Row lock on the membership (`FOR UPDATE`) serializes commands, backed by the partial unique index `work_sessions_one_open_uq` |
| Valid transitions only (PRD §8) | `domain/stateMachine.ts` (unit-tested matrix); rejected commands write nothing |
| Idempotent submission (TRD §5) | `Idempotency-Key` header; unique `(actor_id, project_id, idempotency_key)`; a replay returns the original event; reusing a key for a different action → 409 |
| Breaks never inferred (Flow §3) | Clock-out on break is rejected unless policy is `allow_combined` **and** the client explicitly asks; the break end is then recorded as its own event |
| Durations derived, never stored (Schema §7) | `domain/calc.ts` computes from accepted events plus non-superseded adjustments |
| Original records never overwritten (PRD §8) | `clock_events`, `time_adjustments` and `audit_logs` have a trigger rejecting UPDATE/DELETE |
| Mutation + audit are atomic (TRD §5) | Every write path calls `writeAudit` with the same transaction client |
| Concurrent review is detected (TRD §5) | Correction decisions, settings and shifts carry a `version`; mismatch → 409 `VERSION_CONFLICT` |
| Server-side RBAC and team scope (TRD §7) | `services/access.ts` resolves membership per request; tutors only see their own sessions (404 otherwise); team-scoped supervisors are filtered in SQL and on object access |
| Exports are reproducible (TRD §8) | Built inside a `REPEATABLE READ` snapshot; record version = hash of session versions + event counts + adjustment ids; SHA-256 checksum; filters, timezone and rounding stored |

## Calculation rules

- **Session work** = (end − start) − overlap of breaks, from accepted events. An open session counts up to "now" for display only.
- **Adjustments**, applied in creation order, skipping any that a later one supersedes:
  - `replace_interpretation` sets the effective start and/or end.
  - `add_time` adds minutes.
  - `void_session` sets the session to zero.
  - `other` is a note only.
  - Results never go below zero.
- **Day attribution:** a session belongs to the local date (in the report's timezone) on which it effectively starts. The tutor's "today" total uses the same rule, so it reconciles with exports.
- **Rounding:** off by default. When configured, it applies per session at reporting time. Exports always include both exact and rounded minutes, plus the rule's description.
- **Open sessions** appear in exports with status `open` but are excluded from totals.
- **Flags** (derived, never stored):
  - long session (over `max_shift_minutes`)
  - possible missed clock-out (still open from a previous local day)
  - long break
  - location review
  - event anomalies
  - pending correction
  - adjusted / voided

## Missed clock-outs and corrections

A supervisor resolves an open session by recording a corrected end time (or approving a tutor's request). The system:

1. Appends a `clock_out` event with `source = admin_adjustment`, attributed to the reviewer and timestamped when the review happened. Nothing is back-dated in the event log.
2. Appends a `replace_interpretation` adjustment carrying the corrected end, with the required reason.

The tutor can then clock in again. The raw record still shows the true span, and the effective record shows the corrected one.

## Notifications

`runAlertSweep` (every 60 s in-process; disable with `ALERT_WORKER_ENABLED=false` and run it elsewhere) raises in-app alerts for long sessions and missed clock-outs. Correction submissions and decisions notify inline. Each delivery has a unique `dedupe_key` (rule + target + recipient), so repeated sweeps or multiple workers never duplicate alerts. Only the in-app channel exists in this release; the delivery table already records status and attempts for email/SMS providers later.

## Security notes

- Passwords: scrypt (N=16384). Session and reset tokens are stored only as SHA-256 hashes.
- Login: generic error messages, a per-IP and per-email rate limit, and an account lock after 8 failures. Password reset responses don't reveal whether an account exists. Reset tokens are single-use, last 30 minutes, and sign out all sessions.
- CSRF: every non-GET `/v1` request from a signed-in session must send `X-CSRF-Token` matching the session.
- Headers: `nosniff`, `X-Frame-Options: DENY`, a strict CSP for the SPA, `Cache-Control: no-store` on the API, and redacted logging of cookies, tokens and passwords.
- CSV formula injection: cells starting with `= + - @ \t \r` are prefixed with `'`.
- The in-memory rate limiter suits a single instance. Use a shared store if you scale out.

## Deliberately not built (phase-gated)

As the pack recommends, these are excluded until policy is decided, and the settings schema **rejects** enabling them:

- offline queued punches
- photo capture
- device binding

Location coordinates are accepted only when the project explicitly enables location controls, and only at clock-in. MFA is not implemented; the identity design leaves room for an OIDC provider that supplies it.
