-- Who may use the console, and as what.
--
-- IAP decides who reaches the console at all; this decides what they may do
-- once there. An admin reaches everything; a user files requests, answers the
-- crew and reads the board, threads and costs. The bridge looks the verified
-- identity up here on every `/v1` request, and refuses one that is not here.
--
-- `email` is stored lower-cased: IAP's claim and what an admin types can
-- differ in case, and two rows for one person would give them two roles.
-- `added_how` says how a row came to be: an admin added it, or it is one of
-- the first admins, seeded from FLEET_ADMIN_EMAILS, from the console's IAP
-- members, or because that person was the first to arrive.
create table if not exists users (
  email text primary key,
  role text not null,
  added_by text not null,
  added_how text not null default 'added',
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email = lower(email) and email <> ''),
  check (role in ('admin', 'user')),
  check (added_how in ('added', 'first', 'admin-emails', 'console-members'))
);
