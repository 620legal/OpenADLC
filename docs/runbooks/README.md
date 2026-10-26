# Runbooks

One file per thing that can go wrong in production, written for whoever is
holding the pager at three in the morning — which may be a bot.

A runbook says: how you know this is happening, what to check first, what to do,
and what to do if that does not work. It does not explain the architecture.

`config/review.yaml` routes changes under this directory to the SRE lens, because
a runbook that is wrong is worse than one that is missing.

## The runbooks

| Runbook | When |
|---|---|
| [unsigned-post.md](unsigned-post.md) | A post on GitHub claims a seat's header or tag and carries no signature that checks |
| [cloud-update-stopped.md](cloud-update-stopped.md) | A Google Cloud install's update stopped between its parts, or a part runs another release |
| [rename-gcp-host.md](rename-gcp-host.md) | A Google Cloud install made before the rename to OpenADLC still has its host's and its secrets' old names (`fleet-hostd`, `/var/lib/fleet`, `fleet-<ref>`) |
