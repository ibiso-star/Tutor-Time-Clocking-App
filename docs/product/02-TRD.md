# Technical Requirements Document (TRD)

## 1. Scope and architecture
Responsive web client + authenticated API + relational database + background worker for notifications/exports. Recommended baseline: TypeScript web application, REST/JSON API, PostgreSQL, object storage only if photo capture is approved, and a queue/worker for notifications and report generation. Deploy behind HTTPS with managed secrets, database backups, and centralized logs. Exact stack is an implementation decision; correctness requirements below are stack-independent.

### Logical components
- **Web client:** tutor and admin routes, accessible responsive UI, local transient state; optionally a durable offline outbox in a later phase.
- **API:** identity/session validation, authorization, domain state machine, timestamp generation, idempotency, reporting endpoints.
- **Database:** normalized relational source of truth; append-only clock events and audit records; transactional session state.
- **Worker:** scheduled shift reminders, overdue/missed-punch alerts, export jobs, delivery retry and deduplication.
- **Observability:** structured logs, metrics, traces, alerting; avoid logging sensitive location/photo values.

## 2. Non-functional requirements
| Area | Requirement |
|---|---|
| Availability | Initial production SLO target 99.9% monthly for authenticated clock APIs; validate against hosting choice. |
| Performance | p95 clock command response <1.5 s under expected load; dashboard <2.5 s for standard date range. |
| Durability | Commit event and audit record in the same database transaction; managed backups and tested restore procedure. |
| Security | TLS, encryption at rest, server-side RBAC, least privilege, secure session handling, rate limiting, input validation. |
| Accessibility | WCAG 2.2 AA target for core tutor/admin paths; keyboard and screen-reader testing. |
| Compatibility | Current and previous major versions of mobile Safari and Chrome; graceful responsive desktop admin use. |
| Auditability | Immutable original clock events; append-only audit trail with actor, server time, action, target, reason, and correlation ID. |
| Privacy | Collect only configured/necessary fields; sensitive features off by default; retention and deletion controls. |

## 3. Time and state model
Store authoritative event times as UTC `timestamptz`. Store project IANA timezone (e.g. `America/Los_Angeles`) for display and reports; do not store a fixed offset as the timezone. Server time is generated inside the API/database transaction. Client time may be recorded only as untrusted context for offline capture. Duration is derived from event sequence, not from a mutable total field.

State machine: `OUT -> IN -> BREAK -> IN -> OUT`, with `IN -> OUT` when breaks are disabled. Each command checks the actor, active project membership, current state, policy, and idempotency key in one transaction. Use a row lock or equivalent serialization on the tutor/project active-session aggregate to prevent race conditions. A duplicate request returns the original result; invalid transitions return a conflict response and do not create events.

## 4. API contract (illustrative REST)
All endpoints require authenticated identity except login/reset endpoints. API responses use ISO-8601 UTC instants, stable IDs, and structured errors.

| Method / path | Purpose |
|---|---|
| `GET /v1/me` | Current user, role scopes, project policy summary. |
| `GET /v1/me/time-status?project_id=` | Current state, active session, duration, daily total. |
| `POST /v1/clock-events` | Submit `CLOCK_IN`, `CLOCK_OUT`, `BREAK_START`, or `BREAK_END`; requires `Idempotency-Key`. |
| `GET /v1/me/time-entries` | Tutor's history with bounded date filters and pagination. |
| `POST /v1/correction-requests` | Request a correction against an existing session/event. |
| `GET /v1/me/correction-requests` | Tutor correction status/history. |
| `GET /v1/admin/roster` | Authorized live status and alert summary. |
| `GET /v1/admin/time-entries` | Filtered/paginated entries. |
| `POST /v1/admin/correction-requests/{id}/decision` | Approve/reject with required reason. |
| `POST /v1/admin/adjustments` | Add adjustment/replacement interpretation with required reason; never overwrite source event. |
| `POST /v1/admin/exports` | Create export request with filters, timezone and output format. |
| `GET /v1/admin/exports/{id}` | Export status/download URL and recorded parameters. |
| `PATCH /v1/admin/projects/{id}/settings` | Authorized project policy update; audit changes. |

Clock command payload includes event type, project ID, optional shift/location ID, idempotency UUID, optional client-captured time and device metadata only when policy enables it. Server determines official timestamp. Return `event_id`, `server_timestamp`, `session_state`, `sync_status`, and whether the action was newly applied or an idempotent replay.

## 5. Data integrity and concurrency
- Unique idempotency scope: `(actor_id, project_id, idempotency_key)`.
- Enforce one active session per tutor/project with a partial unique constraint or locked state row.
- Validate event ordering and policy in a database transaction.
- Use optimistic versioning for correction decisions and project-setting edits.
- Audit event creation and business mutation atomically.
- Use soft deactivation for accounts; preserve references and historical records.
- Exports are immutable snapshots or reference a data version and filter parameters; subsequent edits create a new version/export.

## 6. Offline synchronization (phase-gated)
The MVP may require connectivity for official clock events. If offline queuing is included, the client generates a UUID, stores a signed/validated local payload in a durable outbox, marks it **Pending sync**, and retries with exponential backoff. The server stores `client_captured_at` as untrusted and `received_at` as authoritative receipt time, validates ordering/policy, and assigns status `accepted`, `needs_review`, or `rejected`. Conflicts must not be silently merged. UI never labels pending capture as an accepted official punch. Local storage must be protected from casual cross-user exposure and cleared on sign-out where feasible.

## 7. Security and privacy controls
- OIDC or a mature managed authentication service; secure, httpOnly, sameSite cookies for web sessions; CSRF protection where cookie auth is used.
- Password reset tokens short-lived and single-use; MFA optional at launch but supported in identity architecture.
- Enforce RBAC and project scope on every API call; no authorization decisions based on client-supplied role.
- Encrypt transport and storage; separate production secrets; rotate credentials; least-privilege service accounts.
- Rate-limit login, correction submission, and clock commands; detect suspicious request patterns without denying legitimate accessibility needs.
- Validate files and strip metadata if photos are later enabled; private storage and short-lived signed download links.
- GPS/photo/device collection requires feature enablement, just-in-time notice, permission, retention, access logging, and denial fallback.
- Audit sensitive reads/exports as well as writes where required; exclude secrets and unnecessary PII from logs.
- Define retention/legal hold behavior with counsel and payroll stakeholders before production.

## 8. Notifications, exports, and operations
Notification jobs use dedupe keys such as `(rule, target, scheduled_window)` to avoid repeat alerts. Persist delivery attempt, provider result, and retry state. Exports run from a consistent database snapshot, use explicit timezone and rounding configuration, escape CSV formula-leading characters, and record filters, actor, time, included version, and checksum. PDF/CSV files are access-controlled and expire from temporary storage according to policy.

Monitor clock API latency/errors, rejected transitions, idempotent replay rate, late-sync/conflict counts, queue depth, notification failure rate, export failures, and audit-write failures. Alert immediately on audit transaction failure or clock API availability breach. Provide backup restore drills, schema migration rollback strategy, and incident access procedures.

## 9. Testing requirements
Unit-test state transitions, duration calculations, timezone/DST boundaries, rounding, and permission checks. Integration-test concurrent clock-in, retries, transaction rollback, correction lifecycle, audit atomicity, exports and notification deduplication. End-to-end test mobile viewport and accessibility for tutor and admin roles. Security test object-level authorization, session handling, injection, CSRF, rate limiting, export leakage, and sensitive-data retention. Offline sync tests include duplicate replay, out-of-order events, clock drift, conflicts, and account deactivation.

## 10. Technical decisions requiring confirmation
Choose hosting/auth provider and expected user/load scale; decide whether offline queuing is MVP or phase two; define exact payroll schema and PDF format; determine photo/GPS/device legal and retention policies; confirm whether multiple active project sessions are allowed; define supported export retention and data-deletion obligations.
