-- Phase 3.5 of docs/multi-tenant-plan.md: shelf_state stops being a singleton.
--
-- shelf_state has carried a club_id column since Phase 1 slice 1, but the row
-- was still *addressed* as the fixed `id = 1` singleton by admin-update and by
-- the client -- so club #2 would have shared club #1's `eliminated` list and
-- `roundNumber`. There is nowhere for a second club's game state to live. This
-- makes club_id the real key:
--
--   * unique (club_id) -- one state row per club, enforced by the DB rather
--     than by everyone remembering to pass id = 1.
--   * id gets a sequence-backed default, so Phase 4's club-creation path can
--     `insert into shelf_state (club_id) values (...)` without inventing an id.
--     The column stays an int primary key; nothing about the existing row moves.
--
-- Deliberately additive: id stays 1, data/version are untouched, and the
-- currently-deployed `.eq("id", 1)` queries keep working unchanged. That's what
-- lets this migration land *before* the edge-function and frontend deploys that
-- switch over to `.eq("club_id", ...)`, per the deployment order in CLAUDE.md.

alter table public.shelf_state
  drop constraint if exists shelf_state_club_id_key;
alter table public.shelf_state
  add constraint shelf_state_club_id_key unique (club_id);

-- Sequence starts after the existing singleton, so the next insert gets 2.
create sequence if not exists public.shelf_state_id_seq owned by public.shelf_state.id;
select setval(
  'public.shelf_state_id_seq',
  greatest(coalesce((select max(id) from public.shelf_state), 0), 1)
);
alter table public.shelf_state
  alter column id set default nextval('public.shelf_state_id_seq');
