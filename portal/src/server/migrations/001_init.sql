-- Shift Portal schema. Lives in its own `shift` schema so it can share a database with other
-- systems (e.g. the central website) without name clashes, or run in a database of its own.
CREATE SCHEMA IF NOT EXISTS shift;

CREATE TABLE shift.employees (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name     text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  -- Identifier of this person in the central system, for later reconciliation.
  external_ref     text NULL UNIQUE,
  -- Credentials are stored only as SHA-256 hashes of high-entropy random values.
  link_token_hash  text NULL UNIQUE,
  badge_code_hash  text NULL UNIQUE,
  link_enabled     boolean NOT NULL DEFAULT true,
  kiosk_enabled    boolean NOT NULL DEFAULT true,
  active           boolean NOT NULL DEFAULT true,
  -- Current state is a projection of the event log, kept on the row we lock per punch.
  state            text NOT NULL DEFAULT 'OUT' CHECK (state IN ('OUT', 'IN', 'BREAK')),
  state_since      timestamptz NULL,
  open_session_id  uuid NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'OUT') = (open_session_id IS NULL))
);

CREATE TABLE shift.kiosks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  token_hash    text NOT NULL UNIQUE,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NULL,
  revoked_at    timestamptz NULL
);

CREATE TABLE shift.events (
  seq              bigserial UNIQUE,
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id      uuid NOT NULL REFERENCES shift.employees(id),
  session_id       uuid NOT NULL,
  event_type       text NOT NULL CHECK (event_type IN ('clock_in', 'break_start', 'break_end', 'clock_out')),
  occurred_at      timestamptz NOT NULL,
  state_after      text NOT NULL CHECK (state_after IN ('OUT', 'IN', 'BREAK')),
  source           text NOT NULL CHECK (source IN ('link', 'kiosk', 'api')),
  kiosk_id         uuid NULL REFERENCES shift.kiosks(id),
  idempotency_key  uuid NOT NULL,
  action           text NOT NULL,
  client_time      timestamptz NULL,
  ip_hash          text NULL,
  UNIQUE (employee_id, idempotency_key)
);
CREATE INDEX events_employee_time_idx ON shift.events (employee_id, occurred_at);
CREATE INDEX events_time_idx ON shift.events (occurred_at);

-- Transactional outbox: written in the same transaction as the event it announces.
CREATE TABLE shift.webhook_outbox (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL UNIQUE REFERENCES shift.events(id),
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz NULL,
  delivered_at     timestamptz NULL,
  last_error       text NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_outbox_due_idx ON shift.webhook_outbox (next_attempt_at) WHERE status = 'pending';

-- Events are append-only: corrections belong in the central system, never in rewrites here.
CREATE FUNCTION shift.forbid_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON shift.events
  FOR EACH ROW EXECUTE FUNCTION shift.forbid_mutation();
