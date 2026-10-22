# A cloud install's update stopped partway

A Google Cloud install rolls a release in three parts, the console, then
hostd on the host, then the bridge, either from Settings → System (self-update)
or with `openadlc cloud update`. This is for when that stopped before the end.

## How you know

- Settings → System's OpenADLC row, or a card in Needs you, says the update
  failed or stopped, naming the part it reached: "checking images", "waiting",
  "console", "host", "bridge".
- `openadlc cloud update` stopped and printed "What is left, in order:" with
  commands.
- The console, the bridge and the host report different releases: the row
  shows each part's image.

## What to check first

1. **Which parts run which release.** The failure says it; or read each part.
   For the console and the bridge, read the revision that serves, not the
   service's template: a roll whose revision never became ready leaves the
   template on the new image while the old one still serves.

   ```bash
   for part in console bridge; do
     revision=$(gcloud run services describe <prefix>-$part --region <region> --project <project> --format='value(status.latestReadyRevisionName)')
     gcloud run revisions describe "$revision" --region <region> --project <project> --format='value(spec.containers[0].image)'
   done
   gcloud compute ssh <host> --zone <zone> --project <project> --tunnel-through-iap -- 'cat /var/lib/fleet/hostd-image /var/lib/fleet/hostd-image.started'
   ```

   Each should be `<region>-docker.pkg.dev/<project>/<prefix>-ghcr/620legal/openadlc/<image>@sha256:…`.
2. **Whether hostd is up.** `gcloud compute ssh <host> --zone <zone> --project <project> --tunnel-through-iap -- 'sudo systemctl status fleet-hostd --no-pager | head -20'`. A unit that keeps restarting with a pull error is a host that can't fetch the release's image: check the mirror (`gcloud artifacts repositories describe <prefix>-ghcr --location <region> --project <project>`) and that the release's packages are public.
3. **Whether the release's images check out.** If the stop was at "checking images", the failure names the image and gh's reason. A release whose images fail the check is never taken; that's not something to work around.

## What to do

- **To finish the same release:** run `openadlc cloud update --release <tag>` from a machine with the install's settings (`openadlc cloud pull --bucket <bucket>` first, if it has none). It checks the images again and rolls only the parts not already on the release, by what the console's serving revision runs and the image hostd last started on, ending with the bridge. Pause work first (Settings → Pause work) when hostd is not on the release yet: restarting it ends the tasks running on the host.
- **To go back:** the failure names the image each rolled part ran before, with the command that puts it back: self-update's record and card, and what `openadlc cloud update` printed. Where it could not read one, read it with check 1's commands first. Put the console and the bridge back with `gcloud run services update <prefix>-<part> --region <region> --project <project> --image <that image>`. For the host, when it ran a release image, write that into `/var/lib/fleet/hostd-image` over IAP (`sudo sh -c 'echo <that image> > /var/lib/fleet/hostd-image'`) and `sudo systemctl restart fleet-hostd`; when it ran the module's `hostd_image` (a tag, on a fresh install), remove both `/var/lib/fleet/hostd-image` and `/var/lib/fleet/hostd-image.started` instead, since the host falls back to the image hostd last started on, the new release, before `hostd_image`. Going back is safe only if no part of the newer release started: the bridge and hostd migrate the database as they start, and migrations don't go back. If the bridge or hostd already ran the new release, finish it instead.
- **A host back on its fallback image** (`hostd-image.started` older than the file): the pull of the new image failed. Fix the cause in check 2, then restart `fleet-hostd`.

## If that does not work

- Pause work in Settings, so no task starts while parts differ.
- Restore the database from the backup taken before the update, if a migration went wrong: `docs/self-hosting.md`, Backup and restore.
- Record what you saw in an issue, with the failure text and each part's image.
