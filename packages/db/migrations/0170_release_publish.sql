-- A built release, tagged and published as the app only after it is signed
-- (#344, docs/adr/0071-a-release-is-tagged-and-published-as-the-app-only-after-it-is-signed.md).

-- The asset name shipped clients fetch the signed manifest by: an admin's
-- setting beside the rest of the recipe, never chosen by a run. Null is
-- `manifest.json`, so every repository here before this migration keeps it.
alter table repos add column if not exists release_manifest_asset text;

-- After `built`: `publishing` while the bridge drafts, uploads, signs, tags
-- and publishes; `published` once GitHub's published asset URL is the one
-- signed; `publish_failed` with a reason that names what was left.
alter table release_runs drop constraint if exists release_runs_state_check;
alter table release_runs add constraint release_runs_state_check
  check (state in ('running', 'built', 'failed', 'cancelled', 'refused', 'lost', 'publishing', 'published', 'publish_failed'));

-- `v<version>`, the release's draft or published id, its page, the signed
-- asset's URL, whether the tag was made on the pinned commit, and when it
-- was published.
alter table release_runs add column if not exists tag text;
alter table release_runs add column if not exists release_id bigint;
alter table release_runs add column if not exists release_url text;
alter table release_runs add column if not exists asset_url text;
alter table release_runs add column if not exists tagged boolean not null default false;
alter table release_runs add column if not exists published_at timestamptz;

-- One release in flight per repository until it is published or has failed,
-- so two cuts cannot race for one tag.
drop index if exists release_runs_one_running;
create unique index if not exists release_runs_one_in_flight on release_runs (repo_id) where state in ('running', 'built', 'publishing');
