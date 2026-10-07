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
