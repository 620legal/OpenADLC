-- Whether a model account's credential has been seen to work.
--
-- A subscription used to store nothing and prove nothing: the accounts step
-- showed `~` for every one of them, because the only evidence was a task that
-- had not run yet. An account can now be checked from the console — hostd
-- runs its CLI in the bot image with exactly the credential a session would
-- get and a one-line prompt — and this is where the answer is kept, so the
-- screen can say ✓ with when, or × with the CLI's own words.
--
-- `verified_at` is when the last check ran, whatever it found. `verify_error`
-- is null when that check answered, so a time with no error is a pass and a
-- time with one is a failure. Both are null until the first check, and again
-- whenever the credential is replaced, because a verdict on the old one says
-- nothing about the new.
--
-- The message is what the CLI printed, scrubbed of the account's secret
-- before it reaches this row. The secret itself is still not a column.

alter table model_accounts
  add column if not exists verified_at timestamptz;

alter table model_accounts
  add column if not exists verify_error text;
