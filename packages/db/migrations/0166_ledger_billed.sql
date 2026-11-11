-- A run on a subscription seat costs no money per call (#285,
-- docs/adr/0050-a-subscription-run-is-estimated-not-billed.md). Its cost is
-- still worked out and written, but only billed rows (a run on an API key)
-- count toward the caps, the leasing budget and spend warnings.
--
-- Every row before this one is billed, so past spend and its history do not
-- change. A bridge of the release before this one, still running while it
-- applies, writes rows that default to billed: the side that counts.
alter table ledger add column billed boolean not null default true;

-- hostd sets `billed` from the credential at every session start; the bridge
-- copies it onto each ledger row. `unbilled_usd` is the part of `cost_usd`
-- that was an estimate, what a card shows as "est.".
alter table tasks
  add column billed boolean not null default true,
  add column unbilled_usd numeric(10,4) not null default 0;
