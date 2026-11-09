-- One list of people (#251, docs/adr/0034-one-list-of-people.md).
--
-- Three lists used to describe the same people without knowing about each
-- other: `users` (who may use the console, by email), the `humans` setting
-- (the GitHub logins that approve, pinned by account id in `humanIds`), and
-- `person_github_accounts` (the account a person proved by device code). Roles
-- (#245) drew their members from `humans`, so on an install where `humans` was
-- empty nobody could be given a role.
--
-- A person is one row here. `email` is the console sign-in, null for someone
-- listed only by their GitHub account; `console_role` null means they cannot
-- sign in to the console. `github_user_id` is the pin: the account the login
-- resolved to when it was named, or the one the person linked. A login is not
-- unique, because GitHub frees a renamed account's login for anyone to take;
-- the id is. `github_linked_at` is written only by the person's own
-- device-code sign-in, which is what "confirmed" means. `approves` puts the
-- login in `humans`.
create table if not exists people (
  id uuid primary key default gen_random_uuid(),
  name text not null default '',
  email text unique,
  console_role text,
  github_login text,
  github_user_id bigint unique,
  github_linked_at timestamptz,
  approves boolean not null default false,
  added_by text not null,
  added_how text not null default 'added',
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email is null or (email = lower(email) and email <> '')),
  check (console_role is null or console_role in ('admin', 'user')),
  check (github_linked_at is null or github_user_id is not null),
  check (not approves or github_login is not null),
  check (added_how in ('added', 'first', 'admin-emails', 'console-members', 'humans', 'linked', 'roles'))
);
create index if not exists people_github_login on people (lower(github_login));

-- Who answered a gate, as a person, whichever way the answer came. No foreign
-- key: a removed person's answers stay as they were given.
alter table gates add column if not exists answered_by_person uuid;

-- The data moves forward once. `users` and `person_github_accounts` are left
-- as they are and nothing reads them afterwards; the `humans` row is deleted,
-- since `humans` is now worked out from `approves`.
do $$
declare
  account record;
  login text;
  pins jsonb;
  pin bigint;
  held uuid;
  roles jsonb;
  role jsonb;
  member text;
  members jsonb;
  out_roles jsonb;
begin
  -- 1. Each console user is a person. The columns are qualified: a bare
  -- `role` is also this block's variable, and Postgres refuses the ambiguity.
  insert into people (email, console_role, added_by, added_how, added_at, updated_at)
  select users.email, users.role, users.added_by, users.added_how, users.added_at, users.updated_at from users
  on conflict (email) do nothing;

  -- 2. Each linked account joins the person it was linked from, or is its own
  -- person when that identity never became a user.
  for account in select identity, github_login, github_user_id, linked_at from person_github_accounts loop
    update people set github_login = account.github_login, github_user_id = account.github_user_id,
                      github_linked_at = account.linked_at
     where email = account.identity;
    if not found then
      insert into people (email, github_login, github_user_id, github_linked_at, added_by, added_how, added_at)
      values (account.identity, account.github_login, account.github_user_id, account.linked_at, 'openadlc', 'linked', account.linked_at);
    end if;
  end loop;

  -- 3. Each login in `humans` approves.
  begin
    pins := coalesce((select value from settings where key = 'humanIds')::jsonb, '{}'::jsonb);
  exception when others then
    pins := '{}'::jsonb;
  end;
  for login in
    select distinct on (lower(entry)) entry
      from (select trim(both from unnest(string_to_array(coalesce((select value from settings where key = 'humans'), ''), ','))) as entry) listed
     where entry <> ''
  loop
    pin := null;
    if jsonb_typeof(pins -> lower(login)) = 'number' then pin := (pins ->> lower(login))::bigint; end if;
    held := null;
    if pin is not null then
      select id into held from people where github_user_id = pin;
    else
      select id into held from people where lower(github_login) = lower(login) order by added_at limit 1;
    end if;
    if held is not null then
      update people set approves = true, github_login = coalesce(github_login, login), updated_at = now() where id = held;
    else
      insert into people (github_login, github_user_id, approves, added_by, added_how)
      values (login, pin, true, 'openadlc', 'humans');
    end if;
  end loop;

  -- 4. Role members named logins; they now name person ids. A login no person
  -- holds (one only OPENADLC_HUMANS named) becomes a GitHub-only person who
  -- does not approve here: they still approve through the environment.
  begin
    roles := (select value from settings where key = 'personRoles')::jsonb;
  exception when others then
    roles := null;
  end;
  if roles is not null and jsonb_typeof(roles -> 'roles') = 'array' then
    out_roles := '[]'::jsonb;
    for role in select value from jsonb_array_elements(roles -> 'roles') loop
      members := '[]'::jsonb;
      if jsonb_typeof(role -> 'members') = 'array' then
        for member in select value from jsonb_array_elements_text(role -> 'members') loop
          member := trim(both from member);
          continue when member = '';
          select id into held from people where lower(github_login) = lower(member) order by approves desc, added_at limit 1;
          if held is null then
            pin := null;
            if jsonb_typeof(pins -> lower(member)) = 'number' then pin := (pins ->> lower(member))::bigint; end if;
            if pin is not null and exists (select 1 from people where github_user_id = pin) then pin := null; end if;
            insert into people (github_login, github_user_id, approves, added_by, added_how)
            values (member, pin, false, 'openadlc', 'roles')
            returning id into held;
          end if;
          if not members @> to_jsonb(held::text) then members := members || to_jsonb(held::text); end if;
        end loop;
      end if;
      out_roles := out_roles || jsonb_set(role, '{members}', members, true);
    end loop;
    update settings set value = jsonb_build_object('roles', out_roles)::text, updated_at = now(), updated_by = 'openadlc'
     where key = 'personRoles';
  end if;

  -- 5. `humans` is worked out from `approves` from here on.
  delete from settings where key = 'humans';
end
$$;
