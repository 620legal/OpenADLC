-- A bot's question may name the person role it is for (Legal, Product, ...),
-- so Needs you shows it only to that role's people. The gate stores the role's
-- id, so renaming a custom role keeps routing it, and the name as the bot
-- wrote it, so a question for a role the install does not have can say so
-- ("no role here is called Privacy"). Who holds the role is read on every
-- load and never stored here, so moving a person in or out of a role needs no
-- rewrite of open gates. See
-- docs/adr/0035-needs-you-items-follow-person-roles.md.
--
-- Additive, no backfill: a gate asked before this reads as naming no role,
-- and is shown to everyone as it was.

alter table gates add column if not exists person_role text;
alter table gates add column if not exists person_role_asked text;
