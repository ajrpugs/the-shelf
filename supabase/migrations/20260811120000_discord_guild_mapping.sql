-- Phase 12 §5.4 (docs/configurability-plan.md): /mybook and the Discord
-- guild it was typed in.
--
-- discord-interactions has been pinned to the seeded club since it was
-- built: a slash command carries a guild id and a Discord user id, never a
-- club id, so there was nowhere to look one up. clubs.discord_guild_id is
-- that lookup. A club with none set still resolves to the seeded club (the
-- function's existing fallback), so this is additive -- no club's current
-- behaviour changes until a librarian sets their own guild id.
--
-- Unique (partial, so multiple NULLs are fine): two clubs claiming the same
-- Discord server would make /mybook's club ambiguous.

alter table public.clubs
  add column if not exists discord_guild_id text;

drop index if exists clubs_discord_guild_id_key;
create unique index clubs_discord_guild_id_key
  on public.clubs(discord_guild_id)
  where discord_guild_id is not null;

alter table public.clubs drop constraint if exists clubs_discord_guild_id_len_chk;
alter table public.clubs
  add constraint clubs_discord_guild_id_len_chk
  check (discord_guild_id is null or discord_guild_id ~ '^[0-9]{1,25}$');
