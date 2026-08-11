-- Phase 9 (docs/configurability-plan.md §1): clubs.config -- the load-bearing
-- decision the rest of the plan builds on. One jsonb column per club, read
-- whole for one club at a time and never queried by field, holding every
-- per-club behavioural knob this plan adds: how a club picks its next read
-- first (§2 -- selection mode, sit-out), its rating profile and notification
-- preferences later.
--
-- jsonb takes no CHECK constraints on individual keys, so validation lives in
-- club-admin's update_club (via supabase/functions/_shared/club-config.mjs),
-- the same place timezone validation already lives (20260810120000). The
-- size guard here is the only thing the database itself enforces -- a
-- backstop against something absurd landing even via the service role.
--
-- The rule that makes an additive jsonb column safe with zero data
-- migration: every read of config must default to today's behaviour for a
-- club whose row has no key yet. club-config.mjs's normalizeConfig({}) is
-- exactly that default, and its test asserts it first.

alter table public.clubs
  add column if not exists config jsonb not null default '{}'::jsonb;

alter table public.clubs drop constraint if exists clubs_config_size_chk;
alter table public.clubs
  add constraint clubs_config_size_chk
  check (octet_length(config::text) <= 8192);
