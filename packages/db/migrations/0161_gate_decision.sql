-- A question says what is being decided and what each choice leads to, so a
-- person can answer it from the question alone. Both are stored on the gate,
-- the record every reader of a question shows it from, and copied into its
-- message's payload for the thread timeline, as `options` is. Display only:
-- an answer still resolves against `options`. See
-- docs/adr/0033-a-gate-stores-its-decision-and-consequences.md.
--
-- Additive, no backfill: a gate asked before this reads as having neither,
-- and is shown as it was.

alter table gates add column if not exists decision text;
alter table gates add column if not exists consequences text[] not null default '{}';
