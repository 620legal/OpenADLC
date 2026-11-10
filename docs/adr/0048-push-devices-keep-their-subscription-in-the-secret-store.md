# 0048. Push devices keep their subscription in the secret store

- **Status:** accepted
- **Date:** 2026-11-10

## Context

The owner asked to reach people on their phones and computers by push,
installing the console as an app, in place of an ntfy topic, a Slack webhook or
a URL each person sets up (#280; retiring those is #281). [ADR
0024](0024-needs-you-alerts-are-raised-by-the-open-page.md) had ruled out "a
service worker with Web Push", because it needed VAPID keys, an endpoint and a
table of subscriptions, and it left reaching a person away from the console for
later. This is that later.

A browser's push subscription is an endpoint on its push service and two keys.
Whoever holds all three can send to that browser as the install, so a
subscription is a credential. AGENTS.md's invariant keeps a credential only in
the secret store, apart from an exact list of exceptions. [ADR
0026](0026-notifications-are-configured-in-settings-and-proved-by-their-last-send.md)
and [ADR 0035](0035-needs-you-items-follow-person-roles.md) already split a
channel that way: the setting says which kind and when it was set, and the
target is the secret (`notify-target`, `notify-target:person:<id>`).

The endpoint is also a URL a signed-in person hands the bridge to POST to from
inside the install, which is the reach `PERSONAL_KINDS` guards.

## Decision

- **A device is a row and a secret.** The table `push_devices`
  (`packages/db/migrations/0164_push_devices.sql`) holds:
  - the device's id;
  - its person, removed with them by a cascade;
  - its name;
  - its push service's host;
  - a SHA-256 of the endpoint, to recognise the same browser saving again.

  It holds no endpoint and no key. The subscription itself is the secret
  `push-device:<personId>:<deviceId>`. The bridge makes the id, writes the
  secret first and the row second, and deletes the secret if the row fails.
  A secret left with no row is swept when the bridge starts. Removing a
  person deletes their secrets by prefix, and then their rows.
- **The VAPID key is `push-vapid-key`.** It is a P-256 private JWK in the
  secret store, made the first time it is asked for, under an advisory lock and
  read again inside it. The bridge never rotates it, since a push service
  refuses a key other than the one a subscription was made with. It is never
  logged, never returned by any route, and used only to sign each request's
  `Authorization: vapid t=…, k=…`.
- **Only four push services.** An endpoint must be https with no port, user or
  password, on `fcm.googleapis.com`, `updates.push.services.mozilla.com`,
  `web.push.apple.com`, or a host under `.notify.windows.com`. Redirects are
  errors. Anything else is refused in words when it is saved.
- **Who gets a push.**
  - A notification routed to people goes to each of their devices, beside
    their own channels.
  - One that is not routed goes to every admin's devices, beside the
    install's channel. On a local install that is the operator.
  - `notifyKinds` decide for push too.
  - A tap opens the console on the item.
- **A 404 or 410 drops the device.** It means the push service says the
  subscription is gone, so the row and the secret are deleted and
  `notify.device_dropped` is recorded. Any other failure keeps the device.
  Every send is `notify.delivery` with `transport: "push"`,
  `source: "device"` and the device's id, never its endpoint.
- **The protocol is `node:crypto`.** VAPID uses ES256, signed with
  `ieee-p1363` (RFC 8292). The payload is encrypted as `aes128gcm` in one
  record of 4096 bytes (RFC 8291), pinned by RFC 8291's Appendix A vectors.
  There is no dependency.
- **The service worker caches nothing.** `apps/console/public/sw.js` has no
  `fetch` handler and opens no cache, so a signed-out person, or the next one
  on a shared computer, sees nothing from it. A push for a tab that is
  focused and visible shows nothing. WebKit revokes a subscription after a
  few pushes that show nothing, so there it shows the push and closes it at
  once. Otherwise the notification carries the tag the open page's own alert
  uses for that item (`openadlc-needs-you:<id>`), so one replaces the other.

This amends ADR 0024 on that one point. The alerts the open page raises stay
as 0024 decided.

## What this rules out

- **An encrypted column in `push_devices`.** It would make a send one read,
  but it adds an exception to the secret-store invariant and a key scheme of
  its own. Notifications are rare, so one secret read per device costs little.
- **A JSON setting like `personNotify`, with no table.** It would avoid the
  migration. But a person has several devices, and dropping one on a 410
  would be a read-modify-write of one row for the whole install, under a
  lock, on every send. Recognising the same endpoint again and removing a
  person's devices with them are what a table is for.
- **The `web-push` npm package.** It saves about 200 lines, and adds a
  dependency and its tree to the bridge for what `node:crypto` and the RFC's
  vectors already pin.
- **Any endpoint a browser gives.** Accepting one would let a signed-in
  person aim the bridge's POSTs at any address.
- **A service worker that caches pages for offline use.** It would serve one
  person's board to whoever opens the console next.

## What would make this worth revisiting

- A browser people use that pushes through a service not on the list. The
  list grows by one host then, not by any host.
- Sends becoming frequent enough that one secret read per device is a cost.
- The VAPID key needing rotation. That means every device turning
  notifications on again, which is a decision of its own.
