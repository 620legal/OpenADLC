-- The GitHub comments that answered a question, one row each.
--
-- A reply on GitHub answered whichever question was open on the issue when its
-- delivery was handled. A delivery handled twice — GitHub's Redeliver after a
-- broken hook was fixed, or a second hook aimed at the bridge — applied the
-- same comment again, to the question open by then: a `1` to an earlier
-- question became `Approve` on a plan change. A comment is claimed here before
-- it answers anything, and one already claimed answers nothing.

create table if not exists gate_replies (
  comment_id bigint primary key,
  gate_id uuid not null references gates(id) on delete cascade,
  at timestamptz not null default now()
);
