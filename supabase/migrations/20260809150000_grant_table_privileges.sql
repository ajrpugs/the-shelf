-- Grant the table privileges the migrations never granted.
--
-- Found in Phase 4 prep, the first time the schema was ever built from
-- migrations alone: every RLS policy was correct, and yet `anon` got
-- `42501 permission denied for table reads` from PostgREST. RLS decides WHICH
-- ROWS a role may see; it does nothing if the role has no privilege on the table
-- in the first place.
--
-- Production has these grants (33 of them, visible in a pg_dump) but no
-- migration creates them: the original tables were created by pasting
-- supabase/schema.sql into the SQL editor, where Supabase's default privileges
-- for the `postgres` role granted them automatically. Anything built any other
-- way -- `supabase db reset`, a second project for Phase 4 -- silently came out
-- unreadable by the app.
--
-- Mirrors production exactly (GRANT ALL to the three API roles) rather than
-- narrowing, so local and production stay identical; RLS remains the thing that
-- actually restricts access, and no table here has a write policy for anon. The
-- ALTER DEFAULT PRIVILEGES lines mean future tables don't reintroduce the same
-- gap. GRANT is idempotent, so this is a no-op where the grants already exist.

grant usage on schema public to anon, authenticated, service_role;

grant all on all tables    in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all functions in schema public to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
