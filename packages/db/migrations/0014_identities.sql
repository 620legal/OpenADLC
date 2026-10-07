-- The GitHub accounts Fleet holds a sign-in for, apart from the seats that use them.
--
-- A bot was its GitHub account: the login sat on the bot's row, unique, and
-- the refresh token was filed under the bot's name. That is one account per
-- seat by construction, and it is what made a crew on a single account
-- impossible — nine seats holding nine copies of one refresh token lock each
-- other out on the first refresh, because GitHub rotates it on every use.
--
-- An identity is the account. Seats point at one (`bots.identity_id`), and
-- more than one seat may point at the same one. Its sign-in is filed under
-- `secret_ns`, so every seat on it asks the token broker for the same entry.
--
-- Every bot that has an account gets an identity of its own here, filed
-- under the bot's own name — where its secrets already are — so an existing
-- install is still one account per seat and nothing moves.

create table if not exists github_identities (
  id uuid primary key default gen_random_uuid(),
  login text not null,
  github_user_id bigint,
  -- The name the identity's secrets are filed under (`github-refresh-<ns>`).
  secret_ns text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists github_identities_login_key on github_identities (lower(login));
create unique index if not exists github_identities_user_key on github_identities (github_user_id)
  where github_user_id is not null;
create unique index if not exists github_identities_secret_ns_key on github_identities (secret_ns);

alter table bots add column if not exists identity_id uuid references github_identities(id) on delete set null;

insert into github_identities (login, github_user_id, secret_ns)
select b.github_login, c.github_user_id, b.name
from bots b
left join bot_credentials c on c.bot_id = b.id
where b.github_login is not null
on conflict do nothing;

update bots
set identity_id = i.id
from github_identities i
where bots.identity_id is null
  and bots.github_login is not null
  and lower(i.login) = lower(bots.github_login);
