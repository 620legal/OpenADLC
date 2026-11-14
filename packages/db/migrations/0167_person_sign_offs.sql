-- A pull request's author who is the person AGENTS.md's Human review names
-- for its paths signs off from the console (#322,
-- docs/adr/0063-an-author-who-is-the-named-person-signs-off-in-the-console.md).
--
-- GitHub refuses an approval from a pull request's own author, so on a
-- person's own pull request on a path named for them `review-gate` waited on
-- them for good. Their sign-off is recorded here instead of posted as a
-- review, and `review-gate` and the merge count it for that login only, and
-- only when `github_user_id` is the pull request author's account id.
--
-- Written only by the console's approve route, after the person's own
-- device-code sign-in, and audited (`pull.human_review_signed_off`). One row
-- per head and account: a new diff asks again.
--
-- A new table: nothing existing changes, and nothing counts it until a
-- person signs off.

create table if not exists person_sign_offs (
  id uuid primary key default gen_random_uuid(),
  repo_id uuid not null references repos(id) on delete cascade,
  pr_number int not null,
  head text not null check (head ~ '^[0-9a-f]{40}$'),
  github_user_id bigint not null,
  github_login text not null,
  -- The console sign-in that gave it.
  identity text not null,
  signed_at timestamptz not null default now(),
  unique (repo_id, pr_number, head, github_user_id)
);
create index if not exists person_sign_offs_pull on person_sign_offs (repo_id, pr_number);
