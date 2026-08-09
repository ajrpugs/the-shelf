select json_build_object(
  'clubs',(select count(*) from clubs),'club_secrets',(select count(*) from club_secrets),
  'shelf_users',(select count(*) from shelf_users),'profiles',(select count(*) from profiles),
  'shelf_librarians',(select count(*) from shelf_librarians),'club_members',(select count(*) from club_members),
  'shelf_state',(select count(*) from shelf_state),'reads',(select count(*) from reads),
  'shelf_reviews',(select count(*) from shelf_reviews),'shelf_comments',(select count(*) from shelf_comments),
  'shelf_comment_reactions',(select count(*) from shelf_comment_reactions)) as c;
