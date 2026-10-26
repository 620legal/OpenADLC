# A cloud install still has the names from before the rename

A Google Cloud install made before the rename to OpenADLC keeps the names it
was made with on its host and in Secret Manager. It works on them: a release
with this runbook reads either name. A later release reads only OpenADLC's,
so rename the install first, once, by hand, with no task running.

| What | Before | After | How it moves |
|---|---|---|---|
| The bridge's and the host's secrets | `fleet-<ref>`, labelled `fleet=secret` | `openadlc-<ref>`, labelled `openadlc=secret` | copied by you (step 2), the old ones deleted by you last (step 6) |
| hostd's unit and the egress units | `fleet-hostd`, `fleet-egress-proxy`, `fleet-egress-firewall` | `openadlc-hostd`, `openadlc-egress-proxy`, `openadlc-egress-firewall` | the new cloud-init, at the reset (step 3) |
| The host's state: hostd's image file, the bots' sign-ins, the mirrors | `/var/lib/fleet` | `/var/lib/openadlc` | moved once, at the first boot on the new cloud-init, before any unit starts (`/etc/openadlc/from-fleet.sh`) |
| The scripts and the run state | `/etc/fleet`, `/run/fleet` | `/etc/openadlc`, `/run/openadlc` | written again at every boot; nothing to move |
| The VPC firewall's tag on the host | `fleet-host` | `openadlc-host` | in place, by the apply (step 3) |
| The load balancer's path matcher | `fleet` | `openadlc` | in place, by the apply (step 3) |
| The database URL's CA path | `/var/lib/fleet/database-ca/server-ca.pem` | `/var/lib/openadlc/database-ca/server-ca.pem` | a new version of `<prefix>-database-url` and a new bridge revision, by the apply (step 3) |
| The deployer's grant on the app key, with `deployer_reads_app_key` | `fleet-github-app-private-key` | `openadlc-github-app-private-key` | the new grant made before the old one goes, by the apply (step 3) |

Cloud SQL's database `fleet_db` and its user `fleet` stay as they are:
renaming them means moving the data.

## How you know

- A card in Needs you, from the `cloud-names` check:
  "This cloud install still has the names from before the rename to OpenADLC".
- `gcloud secrets list --project <project> --format='value(name.basename())' | grep '^fleet-'` lists secrets.
- On the host, `systemctl is-active fleet-hostd` answers `active`.

## What to check first

1. **The install runs a release that has this runbook**, on all three
   parts: Settings → System's OpenADLC row shows the console, the host and the
   bridge on it, and the `cloud-names` card is there (an older bridge has no
   such check). An older release reads only the old names, and would lose
   every secret you rename.
2. **A machine with the install's settings and the module of that release**:
   a checkout of the release's commit (`git checkout <tag> && pnpm install &&
   pnpm build`), and `openadlc cloud pull --bucket <bucket>` if the machine
   has no settings. `openadlc cloud apply` applies the checkout's
   `infra/gcp`.
3. **gcloud signed in as a person who can change the project**: Secret
   Manager's admin role (to copy secrets and their access), the reset, and OS
   Login's admin role for IAP (`gcloud compute ssh`). `jq` on the same
   machine; Cloud Shell has both.
4. **A cloud-init of your own** (`host_cloud_init` in the settings) is not
   renamed by this: the apply still moves the database URL's CA path, so yours
   must write the CA to `/var/lib/openadlc/database-ca/server-ca.pem` from
   then on, or hostd loses the database at the reset.

Set these for the commands below; `openadlc cloud output` and the settings
name them:

```bash
project=<project> zone=<zone> host=<prefix>-host-1
```

## What to do

### 1. Wait for the host to be idle

Settings → Pause work, and wait for the tasks that run to end. Answer or stop
each task that waits on a person: such a task keeps its computer on the host,
and the reset in step 3 ends it. The host is idle when this prints nothing:

```bash
gcloud compute ssh "$host" --zone "$zone" --project "$project" --tunnel-through-iap -- \
  'sudo docker ps -a --filter name=task- --format "{{.Names}} {{.Status}}"'
```

A `warm-…` computer is not a task's; hostd makes those again at its start.

### 2. Copy each secret to its new name, with its access

The bridge keeps running. Every secret is read under its new name once that is
there, and under its old one until then, so the install reads the same values
throughout. The module's own secrets (`<prefix>-database-url`,
`<prefix>-database-ca`, `<prefix>-webhook-secret`) carry no label and are not
touched: with the default prefix they also start with `openadlc-`, so the
commands below go by the `fleet-` name, never by an `openadlc-` one.

```bash
for old in $(gcloud secrets list --project "$project" --format='value(name.basename())' | grep '^fleet-'); do
  new="openadlc-${old#fleet-}"
  if gcloud secrets describe "$new" --project "$project" >/dev/null 2>&1; then
    echo "$new is there already: left as it is"; continue
  fi
  if ! gcloud secrets versions access latest --secret "$old" --project "$project" >/dev/null 2>&1; then
    echo "$old has no version to read (a credential deleted since): not copied"; continue
  fi
  gcloud secrets versions access latest --secret "$old" --project "$project" \
    | gcloud secrets create "$new" --project "$project" --replication-policy=automatic --labels=openadlc=secret --data-file=-
  # Who else may read it: whatever was granted on the old one by hand. The
  # host and the bridge read every secret through the project, and the
  # deployer's grant is the module's, which step 3 moves.
  policy=$(gcloud secrets get-iam-policy "$old" --project "$project" --format=json)
  if [ "$(printf '%s' "$policy" | jq '.bindings // [] | length')" -gt 0 ]; then
    printf '%s' "$policy" | jq 'del(.etag)' > "$new.policy.json"
    gcloud secrets set-iam-policy "$new" "$new.policy.json" --project "$project"
    rm "$new.policy.json"
  fi
done
```

The values go from one gcloud to the other and are never printed. Then
check that every old secret has its copy. This prints nothing, or only lines
starting with `>`, refs made since under the new name alone:

```bash
diff <(gcloud secrets list --project "$project" --format='value(name.basename())' | sed -n 's/^fleet-//p' | sort) \
     <(gcloud secrets list --project "$project" --filter='labels.openadlc=secret' --format='value(name.basename())' | sed -n 's/^openadlc-//p' | sort)
```

GitHub rotates a bot's refresh token each time the bridge uses it, and the
bridge writes the new one where the secret is: under the old name until the
copy is made, and under the new one from then on. A rotation in the second
between the loop reading an old secret and making its copy leaves the copy one
token behind. This finds it and copies again. A copy the bridge has written to
since is newer than the old one, and is left:

```bash
for old in $(gcloud secrets list --project "$project" --format='value(name.basename())' | grep '^fleet-'); do
  new="openadlc-${old#fleet-}"
  a=$(gcloud secrets versions access latest --secret "$old" --project "$project" 2>/dev/null | shasum -a 256)
  b=$(gcloud secrets versions access latest --secret "$new" --project "$project" 2>/dev/null | shasum -a 256)
  [ "$a" = "$b" ] && continue
  if [ "$(gcloud secrets versions list "$new" --project "$project" --format='value(name)' | wc -l)" -eq 1 ]; then
    gcloud secrets versions access latest --secret "$old" --project "$project" \
      | gcloud secrets versions add "$new" --project "$project" --data-file=-
    echo "$new: copied again"
  else
    echo "$new: written since the copy, so it is the newer: left as it is"
  fi
done
```

If a workflow of yours reads the app key by name (a deploy workflow, with
`deployer_reads_app_key`), change it to `openadlc-github-app-private-key`
now; the old name goes in step 6.

### 3. Apply the module, which renames the host and resets it

```bash
openadlc cloud plan
```

Read the plan before applying it. It changes in place
`google_compute_instance.host` (its tag and its `user-data`), the seven
`google_compute_firewall` rules (their target tag) and
`google_compute_url_map.console`; replaces
`google_secret_manager_secret_version.database_url`, the new version made
before the old one is destroyed, which rolls the bridge's service to a new
revision; and, with `deployer_reads_app_key`, replaces
`google_secret_manager_secret_iam_member.deployer_app_key`, the new grant made
before the old one is destroyed. **Stop if it would destroy or replace
`google_compute_instance.host`, `google_sql_database_instance.openadlc` or
`google_compute_network.openadlc`**: none of that is this change, and
replacing the host destroys its disk.

```bash
openadlc cloud apply
```

The apply sees the host's cloud-init change and **resets the host**
(`gcloud compute instances reset`) by itself. A reset ends whatever runs on
the host, which is nothing once it is idle, and keeps its disk. The host boots
on the new cloud-init: `/etc/openadlc/from-fleet.sh` moves `/var/lib/fleet` to
`/var/lib/openadlc`, and then `openadlc-egress-proxy`,
`openadlc-egress-firewall` and `openadlc-hostd` start. If the reset fails,
`apply` prints the command; run it.

For a minute or so of the apply, the firewall's rules and the host's tag may
not match: IAP, the bridge's calls to hostd and the load balancer's health
checks are refused, and the VPC's egress rules may not apply to the host,
though its own iptables chains still hold the containers to the proxy.

An apply that stops at `deployer_app_key` with Secret Manager answering that
`openadlc-github-app-private-key` is not found ran before step 2 copied the
key: the old grant is still in place. Copy the key as in step 2 and apply
again.

### 4. Check that it worked

On the host:

```bash
gcloud compute ssh "$host" --zone "$zone" --project "$project" --tunnel-through-iap -- \
  'systemctl is-active openadlc-egress-proxy openadlc-egress-firewall openadlc-hostd; test -e /var/lib/fleet && echo "/var/lib/fleet is still here" || echo moved; cat /var/lib/openadlc/hostd-image.started; sudo journalctl -b --no-pager | grep -F "[openadlc] "'
```

It prints `active` three times, `moved`, the image Settings → System shows for
the host, and `[openadlc] moved /var/lib/fleet to /var/lib/openadlc`. Then:

- The firewall finds the host: `gcloud compute instances describe "$host"
  --zone "$zone" --project "$project" --format='value(tags.items)'` prints
  `openadlc-host`, and `gcloud compute firewall-rules list --project
  "$project" --filter='targetTags.list():openadlc-host' --format='value(name)'`
  lists the seven rules (gcloud refuses `--filter='targetTags:openadlc-host'`:
  it sends that one to the API as a pattern the API rejects): `<prefix>-allow-iap`, `-allow-bridge`, `-allow-lb`,
  `-allow-egress-web`, `-allow-egress-internal`, `-deny-egress` and
  `-deny-ingress`.
- The board has no `hostd` card ("OpenADLC’s host service is not answering"),
  and no `bot-sign-in` or `model-account` card: the bots are signed in, from
  the sign-ins that moved with the directory and the copied secrets.
- The console opens at its domain, and its Terminal tab attaches, which is the
  path matcher.

### 5. Resume work

Settings → Resume work, and watch a task start and finish.

### 6. Delete the old secrets

**This destroys** every version of each `fleet-` secret, and cannot be
undone. Do it only once steps 4 and 5 passed and nothing of yours reads a
`fleet-` secret by name. A secret whose copy is missing is kept:

```bash
for old in $(gcloud secrets list --project "$project" --format='value(name.basename())' | grep '^fleet-'); do
  new="openadlc-${old#fleet-}"
  gcloud secrets describe "$new" --project "$project" >/dev/null 2>&1 || { echo "$new is missing: $old kept"; continue; }
  gcloud secrets delete "$old" --project "$project" --quiet
done
```

The `cloud-names` card clears at the check's next run, within the hour, or at
once with Check again on the card.

## If that does not work

- **`/var/lib/fleet is still here`** after the reset, with
  `[openadlc] /var/lib/fleet and /var/lib/openadlc are both here` or `could not
  move` in the journal: hostd started from an empty `/var/lib/openadlc`, on
  the module's `hostd_image`, with no sign-ins. Pause work, set the empty
  directory aside and reset, so the next boot moves the old one:

  ```bash
  gcloud compute ssh "$host" --zone "$zone" --project "$project" --tunnel-through-iap -- \
    'sudo systemctl stop openadlc-hostd; sudo umount /var/lib/openadlc; sudo mv /var/lib/openadlc /var/lib/openadlc.set-aside'
  gcloud compute instances reset "$host" --zone "$zone" --project "$project"
  ```

  Stopping hostd ends the tasks on the host. Once step 4 passes, remove the
  set-aside directory (`sudo rm -rf /var/lib/openadlc.set-aside`, which
  **destroys** what hostd wrote there since the first reset).
- **A unit is not active**: `sudo journalctl -u <unit> -b --no-pager | tail -50`
  on the host says why; the host's start is the same as before but for its
  names.
- **A bot is signed out** after step 2: its refresh token was rotated while
  it was copied and the second loop was not run, or ran too early. Run it
  again; if the card stays, reconnect the bot in Settings → GitHub →
  Connected accounts.

## Going back

On this release nothing about the secrets needs undoing: it reads each under
its new name first, and the copies hold what the old ones did, or newer.

To put the host back on the old names, before or after step 6: pause work,
put the directory back under its old name, and apply the module as it was
before the rename, from the commit before this change:

```bash
gcloud compute ssh "$host" --zone "$zone" --project "$project" --tunnel-through-iap -- \
  'sudo systemctl stop openadlc-hostd; sudo umount /var/lib/openadlc; sudo mv /var/lib/openadlc /var/lib/fleet'
git checkout <the commit before the rename> -- infra/gcp
openadlc cloud apply   # resets the host onto the old cloud-init
git checkout HEAD -- infra/gcp
```

Stopping hostd ends the tasks on the host, and it stays down until the reset.
With `deployer_reads_app_key`, that module grants the deployer
`fleet-github-app-private-key`, which must still be there.

A release from before this one reads only the old names. Going back to one
is safe only if no part of this release has migrated the database
([cloud-update-stopped.md](cloud-update-stopped.md)), and needs the old
secrets as they are now: since step 2 the bridge has written rotated refresh
tokens under the new names. Before rolling it back, copy each new secret back
onto its old name, then delete the new ones (**destroys** them), or the next
release that reads both would take them over what the older release writes:

```bash
for new in $(gcloud secrets list --project "$project" --filter='labels.openadlc=secret' --format='value(name.basename())'); do
  old="fleet-${new#openadlc-}"
  if gcloud secrets describe "$old" --project "$project" >/dev/null 2>&1; then
    gcloud secrets versions access latest --secret "$new" --project "$project" \
      | gcloud secrets versions add "$old" --project "$project" --data-file=-
  else
    gcloud secrets versions access latest --secret "$new" --project "$project" \
      | gcloud secrets create "$old" --project "$project" --replication-policy=automatic --labels=fleet=secret --data-file=-
  fi
done
for new in $(gcloud secrets list --project "$project" --filter='labels.openadlc=secret' --format='value(name.basename())'); do
  gcloud secrets delete "$new" --project "$project" --quiet
done
```
