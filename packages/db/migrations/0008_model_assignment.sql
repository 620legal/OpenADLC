-- A bot's model is either a pinned id or a floating alias (`newest:opus`).
-- The choice lives on the bot, so the console can change it without a restart
-- and `fleet up` does not put the YAML default back over it. Which account's
-- credential that choice is resolved against is `bots.model_account_id`,
-- added with the account itself.
--
-- The ledger must store the id that was actually called. An alias in `model`
-- makes a month of spend unattributable the moment the alias moves.
-- `model_alias` keeps the configured choice, which is free at resolution time
-- and impossible to reconstruct later: "ran as claude-opus-5, configured as
-- newest:opus".

alter table ledger
  add column if not exists model_alias text;

-- `not valid`: every row written from here on is checked, and the rows already
-- there are not. A usage row that recorded an alias before this existed cannot
-- be resolved after the fact, and validating it here would stop `fleet up` on
-- a row nobody can repair. Ledger rows are never updated, so an old one is
-- never checked again either.
alter table ledger drop constraint if exists ledger_model_resolved;
alter table ledger
  add constraint ledger_model_resolved check (model not like 'newest:%') not valid;

alter table ledger drop constraint if exists ledger_model_alias_shape;
alter table ledger
  add constraint ledger_model_alias_shape check (model_alias is null or model_alias like 'newest:%');

-- `bots.model` is already not null. An empty string would still reach
-- `chooseEngine` as no model at all, so an assignment with nothing chosen
-- has to be impossible at the row too.
alter table bots drop constraint if exists bots_model_present;
alter table bots
  add constraint bots_model_present check (length(btrim(model)) > 0);

-- When the model on this row was chosen in the console. Null when it came from
-- config/bots.yaml. `fleet up` reseeds from the file on every start, and it
-- has to tell the two apart: a console choice survives the reseed, and a YAML
-- edit still reaches a bot nobody has assigned. Every existing row came from
-- the file, so null is also the right starting value.
alter table bots
  add column if not exists model_set_at timestamptz;
