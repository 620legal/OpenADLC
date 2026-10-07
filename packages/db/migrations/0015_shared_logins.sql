-- Seats may share one GitHub account.
--
-- `bots.github_login` was unique, which is one account per seat by
-- construction. The account is an identity now (0014), unique there; seats
-- that share one name the same login, and the database lets them.
alter table bots drop constraint if exists bots_github_login_key;
