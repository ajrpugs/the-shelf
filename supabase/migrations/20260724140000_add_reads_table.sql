-- Phase 0 of docs/multi-tenant-plan.md: a real `reads` table that will
-- eventually replace the `shelf_state.data.history` jsonb array. This
-- migration is ADDITIVE ONLY — it creates a new table and backfills it from
-- the existing history, but does not alter or drop shelf_state,
-- shelf_reviews, or shelf_comments. The running app keeps reading/writing
-- the jsonb history exactly as before; `reads` is unused by the app until a
-- later cutover migration switches it over.
--
-- Re-running this migration is safe: table/policy creation is guarded, and
-- the backfill is `on conflict (ts) do nothing`.

create table if not exists public.reads (
  id               uuid primary key default gen_random_uuid(),
  round            int not null,
  winner_id        uuid references auth.users(id) on delete set null,
  winner_username  text not null default 'Reader',
  book             text not null default '',
  ts               text not null unique,
  rating           jsonb,
  ratings_open     boolean not null default false,
  meetings         jsonb,
  created_at       timestamptz default now()
);

-- One-time backfill from shelf_state.data.history. Tolerates the same legacy
-- shapes normalizeState already tolerates: `cycle`/`cycleNumber` -> round, and
-- (per CLAUDE.md) very old history entries whose winner_id was a plain name
-- rather than a uuid, from before the Discord OAuth migration -- those parse
-- to NULL here rather than failing the whole backfill. `ts` is kept as plain
-- TEXT (not cast to timestamptz) and reused byte-for-byte as the natural key:
-- shelf_reviews.book_ts / shelf_comments.book_ts already store this exact
-- string from the client's toISOString() calls, and PostgREST would
-- re-serialize a timestamptz differently (+00:00 vs Z) on read, silently
-- breaking every review/comment join. The regex below is a data-quality
-- guard (skip garbage), not a cast-safety requirement.
insert into public.reads (round, winner_id, winner_username, book, ts, rating, ratings_open, meetings)
select
  coalesce((h->>'round')::int, (h->>'cycle')::int, 1),
  case
    when h->>'winner_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then (h->>'winner_id')::uuid
    else null
  end,
  coalesce(nullif(h->>'winner_username', ''), nullif(h->>'winner', ''), 'Reader'),
  coalesce(h->>'book', ''),
  h->>'ts',
  h->'rating',
  coalesce((h->>'ratingsOpen')::boolean, false),
  h->'meetings'
from public.shelf_state, jsonb_array_elements(coalesce(data->'history', '[]'::jsonb)) as h
where id = 1
  and h->>'ts' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'
on conflict (ts) do nothing;

alter table public.reads enable row level security;

drop policy if exists "reads read for all" on public.reads;
create policy "reads read for all"
  on public.reads for select
  to anon, authenticated
  using (true);

-- No write policies: matches shelf_state's model, service-role only.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'reads'
  ) then
    alter publication supabase_realtime add table public.reads;
  end if;
end $$;
