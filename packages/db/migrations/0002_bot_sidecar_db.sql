-- Which bots run their checks against a database of their own.
--
-- A builder or a reviewer needs one: `make ci` has to run somewhere, and it must
-- not be anywhere another bot or the platform can see. Intake and the automation
-- account never run a suite, so they carry the cost of a container for nothing.
--
-- Until now this was configuration hostd never saw, so no sidecar was ever
-- started and a task's DATABASE_URL was whatever hostd's own environment held —
-- the platform's database, which holds the ledger and the audit trail.

alter table bots add column sidecar_db boolean not null default false;
