-- The GitHub account a console person proved is theirs, by approving a device
-- code as it in Settings (the bridge's `person-github.ts`). A pull-request
-- command only a named reviewer may send (`/approve-pages`) is offered only to
-- the person whose linked account is that reviewer's, and posted only from a
-- sign-in by that same account; see
-- docs/adr/0018-a-sign-off-is-posted-with-a-token-kept-for-one-post.md.
--
-- Only the login and the account id are kept, never a token. Written only by
-- the person's own sign-in, never by an admin, so a row cannot name somebody
-- else's account. One account belongs to one person.

create table if not exists person_github_accounts (
  identity text primary key,
  github_login text not null,
  github_user_id bigint not null unique,
  linked_at timestamptz not null default now()
);
