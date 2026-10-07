-- Install settings an operator can change without a shell.
--
-- These lived only in ~/.fleet/install.json, written by `fleet init`, and were
-- read into the bridge's environment at start-up. So configuring an install
-- meant a terminal, and changing anything meant restarting the stack.
--
-- Here instead because the console has to be able to write them and have them
-- take effect on the next request. A row overrides the environment variable of
-- the same meaning; absent, the environment still wins, so an install
-- configured by `fleet init` or by a deployment's env keeps working untouched.
create table if not exists settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
