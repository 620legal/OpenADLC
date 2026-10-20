-- A signing key on a bot's GitHub account that a person has said is used
-- somewhere OpenADLC is not: the "signing keys OpenADLC did not register" card
-- stops counting it, and lists it with an undo. By account login and GitHub's
-- key id — the key outlives any one seat on the account, and a seat's rename
-- changes neither.
create table if not exists external_signing_keys (
  login text not null,
  key_id bigint not null,
  -- The title GitHub showed when it was dismissed, so the card can still name
  -- it after the key itself is gone from the account.
  title text,
  dismissed_by text not null,
  dismissed_at timestamptz not null default now(),
  primary key (login, key_id)
);
