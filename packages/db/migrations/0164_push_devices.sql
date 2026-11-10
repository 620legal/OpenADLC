-- A person's devices that take Web Push (#280,
-- docs/adr/0048-push-devices-keep-their-subscription-in-the-secret-store.md).
--
-- A push subscription is a credential: whoever holds its endpoint and keys
-- can send to that browser as the install. So it is kept only in the secret
-- store, as `push-device:<personId>:<id>`, and this table holds nothing of
-- it but the push service's host and a hash of the endpoint, which is how the
-- same browser saving again is recognised rather than added twice.
--
-- The cascade backs up removing a person; it does not replace the bridge's
-- own removal, which a cascade cannot do for the secret.
create table if not exists push_devices (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  name text not null check (length(name) between 1 and 60),
  service text not null,
  endpoint_hash text not null,
  added_at timestamptz not null default now(),
  unique (person_id, endpoint_hash)
);
create index if not exists push_devices_person on push_devices (person_id);
