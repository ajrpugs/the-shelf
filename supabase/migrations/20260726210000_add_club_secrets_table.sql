-- Phase 1 of docs/multi-tenant-plan.md: club_secrets, the second of the two
-- remaining schema gaps flagged in that doc's Phase 1 status line. Per-club
-- secrets live in their own table so they are simply unreachable from the
-- anon/authenticated API -- no policies at all, service-role only. RLS is
-- row-level; hiding a *column* via PostgREST is fiddly and easy to get
-- wrong (see the plan's §2).
--
-- Additive only: no edge function reads discord_webhook_url yet (the real
-- webhook still comes from the DISCORD_WEBHOOK_URL secret until Phase 6
-- wires per-club webhooks into admin-update/set-book/discord-interactions),
-- and calendar-feed doesn't consume calendar_token yet either. The existing
-- club gets a row now (with a generated calendar_token) so nothing has to
-- remember to backfill it later.
--
-- Purely additive; safe to re-run.

create table if not exists public.club_secrets (
  club_id             uuid primary key references public.clubs(id),
  discord_webhook_url text,
  calendar_token      text not null unique default gen_random_uuid()::text
);

alter table public.club_secrets enable row level security;

insert into public.club_secrets (club_id)
values ('8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8')
on conflict (club_id) do nothing;
