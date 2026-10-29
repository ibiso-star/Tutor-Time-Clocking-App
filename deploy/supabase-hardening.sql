-- Supabase hardening for Tutor Time Clock. Run once (as the `postgres` role) after migrations.
-- Supabase exposes the `public` schema through its Data API to the `anon` and `authenticated`
-- roles. This app never uses the Data API: every read and write goes through the app's own
-- server, which connects as the dedicated `ttc_app` role created here. So:
--   1. Row Level Security is enabled on every table, with a single policy that admits only ttc_app.
--   2. anon/authenticated lose all privileges on the schema's tables, sequences and functions.
--   3. ttc_app gets least privilege: no DDL, and no UPDATE/DELETE on append-only tables.
-- Replace :'app_password' (psql variable) with a strong generated password.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ttc_app') THEN
    CREATE ROLE ttc_app LOGIN;
  END IF;
END $$;
ALTER ROLE ttc_app WITH LOGIN PASSWORD :'app_password';
ALTER ROLE ttc_app SET search_path = public;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

GRANT USAGE ON SCHEMA public TO ttc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ttc_app;
REVOKE UPDATE, DELETE ON clock_events, time_adjustments, audit_logs FROM ttc_app;
REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM ttc_app;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS ttc_app_all ON public.%I', t);
    EXECUTE format('CREATE POLICY ttc_app_all ON public.%I TO ttc_app USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
