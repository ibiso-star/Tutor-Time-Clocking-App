-- Shift Portal hardening for Supabase. Run once as `postgres` after migrations.
-- Creates the least-privilege `shift_app` login role the portal connects as. It can use only the
-- `shift` schema, can never UPDATE or DELETE events, and has no DDL rights. Row Level Security is
-- enabled on every portal table with a single policy admitting `shift_app`, and Supabase's
-- `anon` / `authenticated` Data API roles get no access.
-- Afterwards, set the password in the SQL editor:  ALTER ROLE shift_app PASSWORD '<generated>';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shift_app') THEN
    CREATE ROLE shift_app LOGIN;
  END IF;
END $$;

REVOKE ALL ON SCHEMA shift FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA shift FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA shift FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA shift FROM PUBLIC, anon, authenticated;

GRANT USAGE ON SCHEMA shift TO shift_app;
GRANT SELECT, INSERT, UPDATE ON shift.employees, shift.kiosks, shift.webhook_outbox TO shift_app;
GRANT SELECT, INSERT ON shift.events TO shift_app;
GRANT SELECT ON shift.schema_migrations TO shift_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA shift TO shift_app;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'shift' LOOP
    EXECUTE format('ALTER TABLE shift.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS shift_app_all ON shift.%I', t);
    EXECUTE format('CREATE POLICY shift_app_all ON shift.%I TO shift_app USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
