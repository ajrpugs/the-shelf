-- Optimistic-locking token for shelf_state, guarding against two concurrent
-- admin actions clobbering each other. Meaningful now that history has moved
-- out to the `reads` table (see 20260724140000_add_reads_table.sql) and
-- shelf_state.data shrinks to just { eliminated, roundNumber } -- admin-update
-- reads this alongside `data` and writes with `where version = $expected`,
-- bumping it by one each time.
--
-- Purely additive; safe to re-run.

alter table public.shelf_state add column if not exists version int not null default 0;
