# Implementation status

Maps the product pack to what is built and how it's verified. Tests live in `server/test/unit`, `server/test/integration` and `e2e/`.

## PRD acceptance criteria (§11)

| Criterion | Status | Verified by |
|---|---|---|
| Clock-in/out records have server UTC timestamps and correct transitions | Done | `clock.test.ts` "uses server time…", `stateMachine.test.ts` full matrix |
| Same idempotency key → one event; conflicting keys can't create invalid state | Done | `clock.test.ts` replay, key-reuse, and concurrent same-key tests; concurrent different-key clock-in yields exactly one session |
| Tutor sees correct status, duration, today total and history after refresh/login | Done | `clock.test.ts`, e2e `tutor.spec.ts` |
| Admin can trace original event, correction, decision, adjustment and export metadata | Done | `review.test.ts` (events unchanged after approval, audit actions present), `exports.test.ts` (download audited, supersede marker) |
| CSV/PDF apply dates, timezone and rounding consistently and log metadata | Done | `exports.test.ts` reconciliation with preview and time-entries totals, rounding test, PDF test |
| Offline / permission-denied states don't falsely claim acceptance | Done (online-only MVP) | e2e offline test; network failures show "Not recorded" and retry with the same key |
| Core flows keyboard operable, labelled, not color-only | Done for built flows; formal audit pending | Status always text + icon; labelled fields with associated errors; native `<dialog>`; live-region announcements; e2e uses role/label locators |

## MVP scope (PRD §5)

| # | Item | Status |
|---|---|---|
| 1 | Sign-in, password reset, role-based experiences | Done. MFA not built (see open decisions) |
| 2 | Tutor dashboard: status, action, elapsed, today, recent, shifts, corrections | Done |
| 3 | Server-authoritative clock-in/out and configurable breaks | Done |
| 4 | Idempotent submission, state validation, immutable history | Done (DB trigger enforces append-only) |
| 5 | Live roster, search/filter, timeline, long-session / missed-punch flags | Done |
| 6 | Correction workflow preserving originals | Done |
| 7 | Manual adjustment with mandatory reason and audit | Done (preview + affected-export warning) |
| 8 | CSV and PDF exports with scope, timezone, rounding, version, actor, time | Done |
| 9 | Project settings (feature-flagged; sensitive off by default) | Done. Photo, device and offline settings are locked to off |
| 10 | Responsive accessible UI, seed data, automated tests, docs | Done |

## Test suite summary

- **Unit (48):** the state-machine matrix, duration and break maths, adjustments and supersede, DST spring-forward and fall-back days, rounding modes and increments, flags, CSV escaping, and policy/timezone validation.
- **Integration (49, real PostgreSQL):**
  - auth, CSRF, cookies, reset flow, logout
  - RBAC, object-level and team scoping (including corrections and shifts), deactivation
  - clock lifecycle, concurrency, idempotency, append-only triggers, audit atomicity
  - geofence block/allow
  - corrections approve/reject/withdraw/version conflict
  - adjustments add/supersede/void/close-open-session
  - exports: reconciliation, rounding, formula injection, PDF, supersede, range validation
  - settings versioning and audit
  - alert deduplication
- **E2E (6, Playwright):**
  - tutor clock/break/clock-out/correction on a phone viewport
  - offline blocking
  - no horizontal scroll
  - supervisor approval with team scoping
  - admin missed-clock-out resolution
  - CSV export download

## Open decisions (need product, legal or ops owners)

These come from the PRD §10 and TRD §10. The code ships the conservative default for each.

| Decision | Current default | Where to change |
|---|---|---|
| Can a tutor work in several projects at once? | Allowed (one open session **per project**) | Constraint `work_sessions_one_open_uq` |
| Clock-out while on break | Must end the break first (`allow_combined` available) | Project settings |
| Rounding legality and increments | Exact; rounding opt-in per project | Project settings |
| Payroll export columns and PDF layout | Generic columns incl. employee code, exact + rounded minutes | `services/exports.ts` |
| Corrections after an export | Export flagged "records changed"; admin generates a new one | — |
| Retention and deletion | Recorded only; nothing auto-deleted | Needs a reviewed deletion workflow |
| Offline punches | Not supported (online-only) | Phase-gated |
| Location / photo / device controls | Location opt-in at clock-in only; photo and device unavailable | Requires privacy review |
| Identity provider and MFA | Local passwords | Swap for OIDC; `users.auth_subject` is ready |
| Notification channels | In-app only | Add a provider behind `notification_deliveries` |
| Second-person approval for admin actions | Not required (reviewers can't decide their own requests) | — |

## Known limitations

- The rate limiter and alert worker are in-process. See [DEPLOYMENT.md](DEPLOYMENT.md#scaling-notes) for multi-instance setups.
- No localisation yet. Dates and times use the browser locale's formatting, in the project timezone.
- The Docker image and CI workflow are written but were not executed in the environment that produced this build. Unit, integration and E2E suites were run locally against PostgreSQL 16.
