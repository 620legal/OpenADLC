-- The machine each host runs on, as hostd saw it when it last registered
-- (`registerHost`, packages/db/src/store/hosts.ts), for Settings → Hosts.
--
-- Nullable with no default and no backfill: a host that has not registered
-- since this change, or an older hostd still running, reads "not reported"
-- rather than a number nobody measured. See
-- docs/adr/0025-the-hosts-page-reads-what-reconcile-judges.md.

alter table hosts
  add column if not exists cpus int,
  add column if not exists memory_bytes bigint;
