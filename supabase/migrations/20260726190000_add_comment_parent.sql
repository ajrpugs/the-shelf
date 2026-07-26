-- Single-level threaded replies for the discussion section. `parent_id` null
-- = a top-level comment; non-null = a reply to that comment. Threading is
-- single-level by design -- enforced in the post-comment edge function (a
-- reply's own parent_id must be null), not here: a check constraint can't
-- reference other rows. `on delete cascade` means deleting a top-level
-- comment takes its replies with it; the client warns about this in its
-- delete confirmation.
--
-- No RLS changes needed -- the existing insert-self/delete-self/read
-- policies on shelf_comments don't care about parent_id.

alter table public.shelf_comments
  add column if not exists parent_id uuid references public.shelf_comments(id) on delete cascade;
