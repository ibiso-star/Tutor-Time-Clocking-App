-- Vibe Amplified Tutor Time Clock — initial schema.
-- Conventions (see docs/product/05-Database-Schema.md):
--   * UUID primary keys, official instants stored as timestamptz (UTC).
--   * Durations are always derived from events + adjustments, never stored as authoritative totals.
--   * clock_events, time_adjustments and audit_logs are append-only (enforced by trigger below).

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject     text NOT NULL UNIQUE,
  email            text NOT NULL,
  display_name     text NOT NULL,
  status           text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'invited', 'suspended', 'deactivated')),
  is_system_admin  boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE user_credentials (
  user_id              uuid PRIMARY KEY REFERENCES users(id),
  password_hash        text NOT NULL,
  password_updated_at  timestamptz NOT NULL DEFAULT now(),
  failed_attempts      integer NOT NULL DEFAULT 0,
  locked_until         timestamptz NULL
);

CREATE TABLE auth_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    text NOT NULL UNIQUE,
  user_id       uuid NOT NULL REFERENCES users(id),
  csrf_token    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz NULL,
  user_agent_summary text NULL
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);

CREATE TABLE password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz NULL
);

-- ---------------------------------------------------------------------------
-- Projects, membership, people
-- ---------------------------------------------------------------------------
CREATE TABLE projects (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  timezone          text NOT NULL,
  settings          jsonb NOT NULL,
  settings_version  integer NOT NULL DEFAULT 1,
  retention_days    integer NULL CHECK (retention_days IS NULL OR retention_days > 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE project_memberships (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  role         text NOT NULL CHECK (role IN ('tutor', 'supervisor', 'admin')),
  team_id      uuid NULL REFERENCES teams(id),
  active_from  timestamptz NOT NULL DEFAULT now(),
  active_to    timestamptz NULL
);
CREATE UNIQUE INDEX project_memberships_active_uq
  ON project_memberships (project_id, user_id) WHERE active_to IS NULL;
CREATE INDEX project_memberships_project_role_idx ON project_memberships (project_id, role);
CREATE INDEX project_memberships_user_idx ON project_memberships (user_id);

CREATE TABLE tutor_profiles (
  user_id             uuid PRIMARY KEY REFERENCES users(id),
  employee_code       text NULL,
  phone               text NULL,
  preferred_timezone  text NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE work_locations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES projects(id),
  name               text NOT NULL,
  address            text NULL,
  latitude           numeric NULL,
  longitude          numeric NULL,
  geofence_radius_m  integer NULL CHECK (geofence_radius_m IS NULL OR geofence_radius_m > 0),
  geofence_mode      text NOT NULL DEFAULT 'off' CHECK (geofence_mode IN ('off', 'warn', 'block')),
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_locations_project_idx ON work_locations (project_id);

CREATE TABLE shifts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id),
  tutor_id         uuid NULL REFERENCES users(id),
  location_id      uuid NULL REFERENCES work_locations(id),
  label            text NOT NULL,
  scheduled_start  timestamptz NOT NULL,
  scheduled_end    timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'completed')),
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (scheduled_end > scheduled_start)
);
CREATE INDEX shifts_project_start_idx ON shifts (project_id, scheduled_start);
CREATE INDEX shifts_tutor_start_idx ON shifts (tutor_id, scheduled_start);

-- ---------------------------------------------------------------------------
-- Clocking
-- ---------------------------------------------------------------------------
CREATE TABLE work_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id),
  tutor_id          uuid NOT NULL REFERENCES users(id),
  shift_id          uuid NULL REFERENCES shifts(id),
  location_id       uuid NULL REFERENCES work_locations(id),
  state             text NOT NULL CHECK (state IN ('in', 'break', 'closed')),
  started_at        timestamptz NOT NULL,
  closed_at         timestamptz NULL,
  settings_version  integer NOT NULL,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'closed') = (closed_at IS NOT NULL))
);
-- At most one open (in / break) session per tutor per project.
CREATE UNIQUE INDEX work_sessions_one_open_uq
  ON work_sessions (project_id, tutor_id) WHERE state IN ('in', 'break');
CREATE INDEX work_sessions_tutor_started_idx ON work_sessions (tutor_id, started_at DESC);
CREATE INDEX work_sessions_project_started_idx ON work_sessions (project_id, started_at DESC);

CREATE TABLE clock_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL REFERENCES projects(id),
  session_id           uuid NOT NULL REFERENCES work_sessions(id),
  actor_id             uuid NOT NULL REFERENCES users(id),
  event_type           text NOT NULL CHECK (event_type IN ('clock_in', 'clock_out', 'break_start', 'break_end')),
  occurred_at          timestamptz NOT NULL,
  client_captured_at   timestamptz NULL,
  received_at          timestamptz NOT NULL,
  source               text NOT NULL CHECK (source IN ('web', 'offline_sync', 'admin_adjustment', 'system')),
  idempotency_key      uuid NOT NULL,
  sync_status          text NOT NULL DEFAULT 'accepted' CHECK (sync_status IN ('accepted', 'pending_review', 'rejected')),
  location_id          uuid NULL REFERENCES work_locations(id),
  location_lat         numeric NULL,
  location_lng         numeric NULL,
  location_accuracy_m  numeric NULL,
  settings_version     integer NOT NULL,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (actor_id, project_id, idempotency_key)
);
CREATE INDEX clock_events_project_time_idx ON clock_events (project_id, occurred_at);
CREATE INDEX clock_events_session_time_idx ON clock_events (session_id, occurred_at);

CREATE TABLE correction_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id),
  session_id        uuid NOT NULL REFERENCES work_sessions(id),
  requester_id      uuid NOT NULL REFERENCES users(id),
  requested_change  jsonb NOT NULL,
  explanation       text NOT NULL,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  submitted_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz NULL,
  resolved_by       uuid NULL REFERENCES users(id),
  decision_reason   text NULL,
  version           integer NOT NULL DEFAULT 1
);
CREATE INDEX correction_requests_pending_idx ON correction_requests (project_id, status, submitted_at);
CREATE INDEX correction_requests_session_idx ON correction_requests (session_id);
-- One open request per session keeps review unambiguous.
CREATE UNIQUE INDEX correction_requests_one_pending_uq
  ON correction_requests (session_id) WHERE status = 'pending';

CREATE TABLE time_adjustments (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id                uuid NOT NULL REFERENCES work_sessions(id),
  project_id                uuid NOT NULL REFERENCES projects(id),
  tutor_id                  uuid NOT NULL REFERENCES users(id),
  adjustment_type           text NOT NULL CHECK (adjustment_type IN ('add_time', 'replace_interpretation', 'void_session', 'other')),
  effective_start           timestamptz NULL,
  effective_end             timestamptz NULL,
  delta_minutes             integer NULL,
  reason                    text NOT NULL CHECK (length(trim(reason)) > 0),
  source_correction_id      uuid NULL REFERENCES correction_requests(id),
  supersedes_adjustment_id  uuid NULL REFERENCES time_adjustments(id),
  created_by                uuid NOT NULL REFERENCES users(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (adjustment_type <> 'add_time' OR delta_minutes IS NOT NULL),
  CHECK (adjustment_type <> 'replace_interpretation' OR effective_start IS NOT NULL),
  CHECK (effective_end IS NULL OR effective_start IS NULL OR effective_end > effective_start)
);
CREATE INDEX time_adjustments_session_idx ON time_adjustments (session_id, created_at);
CREATE INDEX time_adjustments_project_created_idx ON time_adjustments (project_id, created_at);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NULL REFERENCES projects(id),
  actor_id            uuid NULL REFERENCES users(id),
  action              text NOT NULL,
  target_type         text NOT NULL,
  target_id           uuid NULL,
  reason              text NULL,
  before              jsonb NULL,
  after               jsonb NULL,
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  request_id          text NULL,
  ip_hash             text NULL,
  user_agent_summary  text NULL
);
CREATE INDEX audit_logs_project_time_idx ON audit_logs (project_id, occurred_at DESC);
CREATE INDEX audit_logs_target_idx ON audit_logs (target_type, target_id);

-- ---------------------------------------------------------------------------
-- Notifications and exports
-- ---------------------------------------------------------------------------
CREATE TABLE notification_rules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES projects(id),
  event_type         text NOT NULL CHECK (event_type IN ('long_session', 'missed_clock_out', 'correction_submitted', 'correction_decided')),
  enabled            boolean NOT NULL DEFAULT true,
  threshold_minutes  integer NULL,
  channels           jsonb NOT NULL DEFAULT '["in_app"]'::jsonb,
  settings           jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by         uuid NULL REFERENCES users(id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, event_type)
);

CREATE TABLE notification_deliveries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id            uuid NOT NULL REFERENCES notification_rules(id),
  project_id         uuid NOT NULL REFERENCES projects(id),
  recipient_id       uuid NOT NULL REFERENCES users(id),
  dedupe_key         text NOT NULL UNIQUE,
  related_entity_id  uuid NULL,
  channel            text NOT NULL DEFAULT 'in_app',
  title              text NOT NULL,
  body               text NOT NULL,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempt_count      integer NOT NULL DEFAULT 0,
  scheduled_at       timestamptz NOT NULL DEFAULT now(),
  sent_at            timestamptz NULL,
  provider_response  jsonb NULL,
  acknowledged_at    timestamptz NULL,
  acknowledged_by    uuid NULL REFERENCES users(id)
);
CREATE INDEX notification_deliveries_recipient_idx ON notification_deliveries (recipient_id, acknowledged_at, scheduled_at DESC);
CREATE INDEX notification_deliveries_unsent_idx ON notification_deliveries (status) WHERE status = 'pending';

CREATE TABLE export_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id),
  requested_by     uuid NOT NULL REFERENCES users(id),
  format           text NOT NULL CHECK (format IN ('csv', 'pdf')),
  filters          jsonb NOT NULL,
  timezone         text NOT NULL,
  rounding_policy  jsonb NOT NULL,
  record_version   text NULL,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  file_name        text NULL,
  content_type     text NULL,
  file_content     bytea NULL,
  checksum         text NULL,
  row_count        integer NULL,
  total_seconds    bigint NULL,
  error            text NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz NULL,
  expires_at       timestamptz NULL
);
CREATE INDEX export_jobs_project_created_idx ON export_jobs (project_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Append-only enforcement. The application never updates or deletes these rows;
-- this trigger makes that a database guarantee rather than a convention.
-- ---------------------------------------------------------------------------
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER clock_events_append_only
  BEFORE UPDATE OR DELETE ON clock_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER time_adjustments_append_only
  BEFORE UPDATE OR DELETE ON time_adjustments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
