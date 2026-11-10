# 0049. Push is the only notification channel

- **Status:** accepted
- **Date:** 2026-11-10

## Context

ADR 0048 (#280) let a person get OpenADLC's notifications as push on their
phone and computer, beside the install's channel (ntfy, Slack or a webhook,
ADR 0026, with `OPENADLC_NOTIFY_WEBHOOK` as its fallback) and each person's own
ntfy or Slack channel (ADR 0035). The owner asked for push instead of the
three: "I want to use PWA instead of ntfy, slack, webhook."

Their targets are credentials in the secret store (`notify-target`,
`notify-target:person:<id>`), a file locally and Secret Manager on GCP.
Migrations are SQL files run by `openadlc up` and by the bridge and host at
start, with no secret store in reach. A backup carried both targets with the
install, and `restorable()` wrote back every archived secret but the internal
one, so an archive made before this change would put a channel back.

With the channel gone on upgrade, an admin cannot be told by notification that
they have to turn push on. Intake chose the `notifications` health card as
that notice, rather than a Needs-you item.

## Decision

- Push to devices is OpenADLC's only notification channel. A routed
  notification goes to its people's devices, an unrouted one to every admin's
  (on a local install, the operator's), through one admin resolver.
  `notifyKinds` still decides which kinds are sent, for every device.
- The install's channel, each person's channel and `OPENADLC_NOTIFY_WEBHOOK`
  are retired. Migration `0165` deletes the `notifyTransport` and
  `personNotify` settings. The bridge deletes `notify-target` and every
  `notify-target:person:*` secret at every start (`retireOldChannels`, found
  by `SecretStore.list` prefix, recorded as `notify.channels_retired {count}`,
  never a value); a store that refuses leaves them unread for the next start.
  `OPENADLC_NOTIFY_WEBHOOK` set in the environment is ignored, with one
  warning at start.
- A backup no longer takes a retired target (`classifySecret` says `never`),
  and a restore skips both the retired settings (unknown keys) and secrets
  (`plan.secrets.skipped`), so an older archive still restores, without them.
- The removed API stays registered and says what to do instead:
  `/v1/me/notifications` (GET, PUT, POST test) and
  `POST /v1/settings/notifications/test` answer 410 `{code: 'retired'}`;
  `PUT /v1/settings/notifications` takes `{switches}` and refuses `kind`,
  `server` or `target`; `PATCH /v1/install` refuses the retired keys before
  its unknown-key check.
- The `notifications` health check passes only while an admin has a device
  that receives push: one whose newest `notify.delivery` from a device got
  through, or that has not been sent one yet. Otherwise it is a warning card,
  "No admin has a device that receives push", which says to install the
  console as an app and turn on notifications. It sends nothing, and runs
  again when a device is added or removed.
- This supersedes ADR 0026's transport, target and environment decisions (its
  switches, its `notify.delivery` events and "the check never sends" stand),
  ADR 0035's "each person may have a channel of their own" (routing by person
  roles stands), and ADR 0048's "beside the channels, not instead".

## What this rules out

- **Leaving the stored targets in place and only no longer reading them.** It
  keeps a credential no code needs in the secret store and in every backup.
- **Deleting the secrets inside the migration**, through a JavaScript
  migration step. Migrations here have no secret store in reach; a start step
  beside `sweepOrphans` is where the bridge already cleans the secret store.
- **A one-time Needs-you item after the upgrade.** Declined at intake: the
  health card already says what to do and clears itself when it is done.
- **Keeping one fallback channel for installs with no device.** Until an admin
  turns on a device, unrouted notifications reach nobody but the console's
  badge and alert; the card says so. That is the trade the owner chose.

## What would make this worth revisiting

A place a person must be reached that a browser's push cannot: an install
whose admins cannot install the console as an app or reach a push service
(`push-egress`), or a need to notify someone who never signs in to the
console.
