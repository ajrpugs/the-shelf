-- Phase 6b: a reader can choose their own display name.
--
-- Until now a name was whatever the identity provider said, with no way to change
-- it. The blocker wasn't the UI, it was that `ensureUserRow` rewrites the name from
-- provider metadata on *every* sign-in, so a chosen name would silently revert the
-- next time you logged in.
--
-- `display_name_customised` is what resolves that. While false, the name keeps
-- tracking the provider (so a reader who renames themselves on Discord still sees
-- it update, which is the behaviour everyone has today). Once true, sign-in leaves
-- the name alone. A "use my provider's name again" reset clears the flag and lets
-- the next sign-in take over.
--
-- Length guards on both name columns. The client validates for the error message,
-- but these columns are writable directly by their owner under RLS -- unlike almost
-- everything else here, which goes through an edge function -- so the database has
-- to be the thing that actually holds the line.

alter table public.profiles
  add column if not exists display_name_customised boolean not null default false;

alter table public.profiles drop constraint if exists profiles_display_name_len_chk;
alter table public.profiles
  add constraint profiles_display_name_len_chk
  check (length(btrim(display_name)) between 1 and 40);

-- shelf_users.discord_username is still what the app *reads* (and what
-- admin-update uses for the winner's name in Discord embeds), so a customised name
-- is written to both and needs the same guard. The read cutover to `profiles` is
-- deliberately not part of this change -- it would mean touching the draw path and
-- the Discord embeds at the same time as adding a user-facing feature.
alter table public.shelf_users drop constraint if exists shelf_users_name_len_chk;
alter table public.shelf_users
  add constraint shelf_users_name_len_chk
  check (length(btrim(discord_username)) between 1 and 40);
