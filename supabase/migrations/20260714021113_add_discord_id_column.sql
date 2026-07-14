alter table public.shelf_users
  add column if not exists discord_id text;

create index if not exists shelf_users_discord_id_idx
  on public.shelf_users(discord_id);
