# 0026. Notifications are configured in Settings and proved by their last send

- **Status:** accepted
- **Date:** 2026-11-02

## Context

Owner notifications had one transport, the `OPENADLC_NOTIFY_WEBHOOK`
environment variable. Empty, the bridge only logged "would notify the owner",
and nothing ever proved delivery to a real endpoint (OpenADLC#225). A person
should be able to choose ntfy, Slack or a generic webhook in Settings, switch
each kind off, and see whether it reaches them.

Two kinds a person must act on were not notified at all: a pull request
waiting for a person to merge or approve it, and a review that stopped.
Neither is one event. A stalled review is written in four places
(`stage-handoff.ts`, `webhooks.ts`, twice in `send-back.ts`), and a merge held
for a person is decided in `merge-line.ts` and `automation.ts`, paths a person
reviews. Needs you already turns both into items with stable ids
(`merge_waiting`, `review_stalled`).

The person asked chose, at intake, that the proof is the last real send or
Send a test, not a check that sends its own test: that would buzz a phone all
day. At design they chose to read the two new kinds from Needs you rather than
emit them from the writers.

## Decision

- **The transport is in `notifyTransport`, its target in the secret store.**
  `notifyTransport` holds `{kind, server?, setAt, setBy}`; the Slack URL, the
  webhook URL or the ntfy topic is the `notify-target` secret. The topic counts
  as a secret: on ntfy.sh anyone who knows it can subscribe. The console is
  shown the target only masked, its host and last four characters. Only
  `PUT /v1/settings/notifications` writes the two together; `PATCH /v1/install`
  refuses the keys. A backup carries `notify-target` with the install.
  `OPENADLC_NOTIFY_WEBHOOK` is the generic webhook when nothing is set in
  Settings.
- **Each kind has a switch in `notifyKinds`, on unless `false`.**
  `check_fixed` follows `check_failing`. An off kind is recorded as
  `notify.<event>` with `off: true` and not delivered.
- **Every delivery is a `notify.delivery` event.** `{event, transport, source,
  setAt, ok, status, error}`, after each real send and each test; never the
  target, and the error passes `redactTarget` first. No table of its own:
  `events` is indexed on `(type, at)` and answers `payload @>`.
- **The `notifications` health check reads the last send and never sends.**
  It fails, as a warning, while the newest `notify.delivery` since the
  transport's `setAt` failed or none exists; no transport passes; the
  environment's webhook with no send yet is no answer. It is not blocking:
  the registry sends a lasting blocking failure through the notifier, which
  would post "notifications are broken" to the transport that is broken.
- **Merge-waiting and review-stopped are read from Needs-you items.**
  `WaitingNotices` reads `attentionItems` with `GET /v1/attention`'s own deps
  every 60 s and sends one notification per item `id@since`, deduped by
  `notify.<kind>` with that `item`, so a restart sends nothing twice and the
  same pull request held again later is a new occurrence. The first pass an
  install ever runs records what already waits with `baseline: true` and sends
  none of it.

## What this rules out

- **Emitting the two kinds from their writers.** It touches the merge line and
  `automation.ts`, which need a person's review, and every future writer of a
  stalled review would have to remember to emit (ADR 0021's reason for reading
  events where they happen).
- **A check that sends its own test daily or on each change.** Ruled out at
  intake: it notifies a person for nothing.
- **Keeping the target in `settings`.** It would be in every database dump and
  in `GET /v1/install`.
- **A `notify_deliveries` table.** `events` already answers the lookups, beside
  the platform's other decisions.

## What would make this worth revisiting

- A transport that needs more than one secret (an ntfy access token, an email
  server), or per-person routing: `notifyTransport` and one `notify-target` hold
  one destination for the install.
- Needs you ceasing to give merge-waiting and stalled-review items stable ids
  and a `since` that changes only on a new occurrence.
- A poll a minute behind becoming too slow for a merge a person waits on.
