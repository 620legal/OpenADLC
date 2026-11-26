-- The security seat's findings, as its signed `review_posted` marker lists
-- them (#378, docs/adr/0087-security-review-findings-are-stored-from-the-seats-signed-marker.md).
--
-- One row per signed security-seat review whose marker carried a findings
-- list (an empty one included). Reviews posted before this change, and
-- reviews with no list, have no row: nothing is back-filled. Written only by
-- the review webhook, after the review's signature verifies to the security
-- seat (`security-findings.ts`).
--
-- The pull request's state is not copied here: `work_item_links` keeps it,
-- and the reconciler repairs it when GitHub drops a delivery. The Security
-- page reads a finding as unfixed from the latest row of a merged or closed
-- pull request (`securityReviews.unfixed`).
--
-- A new table: nothing existing changes, and the merge line reads nothing
-- from it.

create table if not exists security_reviews (
  id uuid primary key default gen_random_uuid(),
  repo_id uuid not null references repos(id) on delete cascade,
  pr_number int not null,
  -- GitHub's review id; an edit re-signs and overwrites.
  review_id bigint not null unique,
  head_sha text,
  seat text not null,
  -- The review's html_url from the delivery.
  url text not null,
  submitted_at timestamptz not null,
  -- ReviewFinding[] as reviewFindings returned it.
  findings jsonb not null,
  recorded_at timestamptz not null default now()
);
create index if not exists security_reviews_pull on security_reviews (repo_id, pr_number, submitted_at desc, review_id desc);
