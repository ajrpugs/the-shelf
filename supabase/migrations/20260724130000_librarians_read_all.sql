-- Let any signed-in user read the full librarian list. The Admin tab's
-- grant/revoke UI needs to show each reader's librarian status, and who the
-- librarians are isn't sensitive (the club knows who runs it). Writes remain
-- service-role only — there is still no insert/update/delete policy.

drop policy if exists "shelf_librarians read own" on public.shelf_librarians;
drop policy if exists "shelf_librarians read for authenticated" on public.shelf_librarians;
create policy "shelf_librarians read for authenticated"
  on public.shelf_librarians for select
  to authenticated
  using (true);
