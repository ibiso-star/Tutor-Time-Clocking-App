# Database Schema

## 1. Conventions
PostgreSQL-oriented logical schema. Primary keys are UUIDs. All official timestamps use `timestamptz` and are stored as UTC instants. `created_at`/`updated_at` are server-generated. Project timezone uses an IANA zone name. Do not store derived totals as the authoritative value; calculate from events plus approved adjustments. Sensitive optional fields are nullable and feature-gated.

## 2. Core entities

### `users`
- `id UUID PK`
- `auth_subject TEXT UNIQUE NOT NULL` — external identity provider subject
- `email CITEXT UNIQUE NOT NULL`, `display_name TEXT NOT NULL`
- `status TEXT CHECK (active|invited|suspended|deactivated)`
- `created_at`, `updated_at TIMESTAMPTZ NOT NULL`

### `projects`
- `id UUID PK`, `name TEXT NOT NULL`, `status TEXT`
- `timezone TEXT NOT NULL` — validated IANA identifier
- `settings JSONB NOT NULL` — validated policy snapshot/configuration; sensitive feature flags default false
- `retention_days INTEGER NULL`, `created_at`, `updated_at`

### `project_memberships`
- `id UUID PK`, `project_id UUID FK`, `user_id UUID FK`
- `role TEXT CHECK (tutor|supervisor|admin)`
- `team_id UUID NULL`, `active_from TIMESTAMPTZ`, `active_to TIMESTAMPTZ NULL`
- Unique active membership per `(project_id,user_id)`; indexes on project/role and user.

### `tutor_profiles`
- `user_id UUID PK/FK`, `employee_code TEXT NULL`, `phone TEXT NULL`
- `preferred_timezone TEXT NULL`, `created_at`, `updated_at`
- Keep payroll identifiers minimal and restrict access.

### `work_locations`
- `id UUID PK`, `project_id UUID FK`, `name TEXT`, `address TEXT NULL`
- `latitude NUMERIC NULL`, `longitude NUMERIC NULL`, `geofence_radius_m INTEGER NULL`
- `geofence_mode TEXT CHECK (off|warn|block)`, `active BOOLEAN`
- `created_at`, `updated_at`; coordinates are present only when location controls are enabled.

### `shifts`
- `id UUID PK`, `project_id UUID FK`, `tutor_id UUID FK NULL`
- `location_id UUID FK NULL`, `label TEXT`, `scheduled_start TIMESTAMPTZ`, `scheduled_end TIMESTAMPTZ`
- `status TEXT CHECK (scheduled|cancelled|completed)`
- `version INTEGER NOT NULL DEFAULT 1`, `created_at`, `updated_at`

## 3. Clock and calculation entities

### `work_sessions`
- `id UUID PK`, `project_id UUID FK`, `tutor_id UUID FK`, `shift_id UUID FK NULL`, `location_id UUID FK NULL`
- `state TEXT CHECK (in|break|closed)`
- `started_at TIMESTAMPTZ NOT NULL`, `closed_at TIMESTAMPTZ NULL`
- `version INTEGER NOT NULL DEFAULT 1`, `created_at`, `updated_at`
- Partial unique index: one row where `state IN ('in','break')` per `(project_id,tutor_id)`.

### `clock_events` (append-only)
- `id UUID PK`, `project_id UUID FK`, `session_id UUID FK`, `actor_id UUID FK`
- `event_type TEXT CHECK (clock_in|clock_out|break_start|break_end)`
- `occurred_at TIMESTAMPTZ NOT NULL` — official server timestamp
- `client_captured_at TIMESTAMPTZ NULL` — untrusted optional local capture time
- `received_at TIMESTAMPTZ NOT NULL`
- `source TEXT CHECK (web|offline_sync|admin_adjustment|system)`
- `idempotency_key UUID NOT NULL`, `sync_status TEXT CHECK (accepted|pending_review|rejected)`
- `location_id UUID FK NULL`, `location_lat NUMERIC NULL`, `location_lng NUMERIC NULL`, `location_accuracy_m NUMERIC NULL`
- `device_registration_id UUID FK NULL`, `metadata JSONB NOT NULL DEFAULT '{}'`
- Unique `(actor_id,project_id,idempotency_key)`; indexes on `(project_id,occurred_at)`, `(session_id,occurred_at)`, and tutor/time.
- App role has INSERT/SELECT but no UPDATE/DELETE; corrections are separate records.

### `break_intervals` (optional projection)
- `id UUID PK`, `session_id UUID FK`, `start_event_id UUID FK UNIQUE`, `end_event_id UUID FK UNIQUE NULL`
- `started_at TIMESTAMPTZ`, `ended_at TIMESTAMPTZ NULL`
- May be derived from clock events; if materialized, update only transactionally from event append and validate event references.

### `time_adjustments`
- `id UUID PK`, `session_id UUID FK`, `project_id UUID FK`, `tutor_id UUID FK`
- `adjustment_type TEXT CHECK (add_time|replace_interpretation|void_session|other)`
- `effective_start TIMESTAMPTZ NULL`, `effective_end TIMESTAMPTZ NULL`, `delta_minutes INTEGER NULL`
- `reason TEXT NOT NULL`, `source_correction_id UUID NULL`, `created_by UUID FK NOT NULL`, `created_at TIMESTAMPTZ NOT NULL`
- `supersedes_adjustment_id UUID FK NULL`; append-only. Enforce suitable non-null fields per adjustment type in application/constraint.

## 4. Review and audit

### `correction_requests`
- `id UUID PK`, `project_id UUID FK`, `session_id UUID FK`, `requester_id UUID FK`
- `requested_change JSONB NOT NULL` — schema-validated proposed values
- `explanation TEXT NOT NULL`, `status TEXT CHECK (pending|approved|rejected|withdrawn)`
- `submitted_at TIMESTAMPTZ NOT NULL`, `resolved_at TIMESTAMPTZ NULL`, `resolved_by UUID FK NULL`
- `decision_reason TEXT NULL`, `version INTEGER NOT NULL DEFAULT 1`

### `audit_logs` (append-only)
- `id UUID PK`, `project_id UUID FK NULL`, `actor_id UUID FK NULL`
- `action TEXT NOT NULL`, `target_type TEXT NOT NULL`, `target_id UUID NULL`
- `reason TEXT NULL`, `before JSONB NULL`, `after JSONB NULL`
- `occurred_at TIMESTAMPTZ NOT NULL`, `request_id TEXT NULL`, `ip_hash TEXT NULL`, `user_agent_summary TEXT NULL`
- Restrict read access; redact secrets and unnecessary sensitive payload. Consider tamper-evident export/archive controls for production.

## 5. Optional device, notification, export tables

### `device_registrations`
`id UUID PK`, `user_id UUID FK`, `project_id UUID FK`, `label TEXT`, `device_fingerprint_hash TEXT`, `status TEXT`, `registered_at TIMESTAMPTZ`, `revoked_at TIMESTAMPTZ NULL`. Avoid invasive fingerprinting; use only if approved.

### `notification_rules`
`id UUID PK`, `project_id UUID FK`, `event_type TEXT`, `enabled BOOLEAN`, `threshold_minutes INTEGER NULL`, `channels JSONB`, `settings JSONB`, `updated_by UUID FK`, `updated_at TIMESTAMPTZ`.

### `notification_deliveries`
`id UUID PK`, `rule_id UUID FK`, `recipient_id UUID FK`, `dedupe_key TEXT UNIQUE`, `related_entity_id UUID NULL`, `status TEXT`, `attempt_count INTEGER`, `scheduled_at TIMESTAMPTZ`, `sent_at TIMESTAMPTZ NULL`, `provider_response JSONB NULL`.

### `export_jobs`
`id UUID PK`, `project_id UUID FK`, `requested_by UUID FK`, `format TEXT CHECK (csv|pdf)`, `filters JSONB`, `timezone TEXT`, `rounding_policy JSONB`, `record_version TEXT`, `status TEXT`, `file_key TEXT NULL`, `checksum TEXT NULL`, `created_at TIMESTAMPTZ`, `completed_at TIMESTAMPTZ NULL`, `expires_at TIMESTAMPTZ NULL`.

## 6. Relationships and indexes
Users have project memberships and tutor profiles. Projects own settings, locations, shifts, sessions, events, rules, and exports. Sessions belong to one tutor/project and contain ordered clock events; corrections target sessions and approved requests may create adjustments. Audit records reference actors and targets without cascading deletion. Add indexes for active session lookup, tutor/date history, admin project/date filtering, pending corrections, unsent notifications, and export history.

## 7. Calculation and migration notes
Work minutes derive from accepted clock-in/out intervals less accepted break intervals, then apply only the configured rounding rule at the explicitly defined reporting/calculation stage. Preserve raw minutes and rounded minutes in export output. DST is handled by UTC instants and IANA timezone conversion for display. Store a project-settings version on sessions/events or in audit history so later setting changes do not obscure the policy in force. Avoid destructive schema migrations; backfill derived projections from immutable events and verify totals before cutover.

## 8. Data retention and deletion
Retention is a policy setting, not an unconditional cascade. Define legal/payroll minimums and legal hold before production. Deactivate identities while preserving accounting records; anonymize or delete personal data only through an approved workflow that retains legally required audit evidence. Photo/location data, if ever enabled, should have shorter dedicated retention and restricted access.
