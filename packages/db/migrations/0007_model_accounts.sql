-- A model credential, added once and referenced by many bots.
--
-- It used to be per bot: `engine-key-<bot>` in the secret store, pasted nine
-- times and rotated nine times, with no way to record a subscription at all.
-- The secret still does not live in this table. A `key` account's value is
-- `model-account-<id>` in the secret store, the same place as the GitHub App
-- key and for the same reason. A `subscription` account stores nothing: the
-- CLI's own login is the credential, and the row exists so an assignment can
-- name the seat.
--
-- `bots.model_account_id` is the reference that makes "in use" mean something.
-- Choosing which model a bot runs — a pinned id or a floating family — is a
-- later change; this column is only which credential it uses. Null means the
-- bot has not been moved off its per-bot engine key yet.
create table if not exists model_accounts (
  id          uuid primary key default gen_random_uuid(),
  provider    text not null check (provider in ('anthropic','openai','xai')),
  kind        text not null check (kind in ('key','subscription')),
  label       text not null,
  created_at  timestamptz not null default now()
);

alter table bots
  add column if not exists model_account_id uuid references model_accounts (id) on delete restrict;

create index if not exists bots_model_account
  on bots (model_account_id)
  where model_account_id is not null;
