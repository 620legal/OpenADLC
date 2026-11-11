# 0053. Settings is everyone's, and a non-admin sees Notifications alone

- **Status:** accepted
- **Date:** 2026-11-11

## Context

ADR 0048 (#280) let everyone signed in turn push on for their own devices, in
Settings → Notifications. But the header showed Settings only to an admin
(`useNav`), and `/settings` answered a user "Settings need an admin", so a
person who is not an admin had no way there except typing the address. Hosts
and Notifications each had a page of their own, reached only through a summary
card on `/settings` (`#hosts`, `NotificationsSummary`'s `#notifications`), and
neither was in Settings' navigation; their pages had a back link and no
navigation. And a person could test their devices only one at a time.

The owner asked (#289): "make notifications and hosts their own category in
settings. Give the user a way to test notifications." At intake they chose to
show Settings to everyone, with Notifications as the only category a non-admin
sees.

## Decision

- **Settings is shown to everyone signed in.** `navFor(role)`
  (`apps/console/src/lib/header.ts`) returns the whole header navigation,
  Settings included, whatever the role.
- **A non-admin's Settings is Notifications alone.** `settingsNav` gives them
  one entry, Notifications, and no Run the setup again. `/settings` sends a
  known non-admin to `/settings/notifications` with `redirect()`. Every other
  Settings page (`/settings/hosts`, `/settings/spending`,
  `/settings/repositories/[name]`) keeps `AdminsOnly`, and every admin route
  its role: `PUT /v1/settings/notifications` stays `admin`, and the
  Notifications page leaves the kinds' switches out for a non-admin.
- **Hosts and Notifications are page entries in Settings' navigation.** Each
  `SETTINGS_SECTIONS` entry carries `page`: null for a section of `/settings`,
  or a path. Hosts and Notifications come after System. `settingsNav({ admin,
  omit, on })` builds the list for `/settings` and for each page with its own
  route, which draws the same `SettingsNav` with itself marked
  `aria-current="page"`; a section's link there is `/settings#id`. What is
  left out (Egress, Roles) is one rule, `navOmit`. The two summary cards on
  `/settings` are gone.
- **`POST /v1/me/push/test` tests every device of the caller** (role `user`).
  It acts only on the caller's own person, ignores the kind switches, sends
  through `sendToDevices` (the path `Notifier.send` pushes through, recording
  a `notify.delivery` per device and dropping a gone one), and answers
  `{devices: [{id, name, ok, status, error}]}`, empty when they have none.
  Its link, like the single-device test's, is the console's
  `/settings/notifications`. The console's **Send a test notification** at
  the top of Notifications calls it and reports each device; with none it
  says so rather than reporting success.

## What this rules out

- **A separate Notifications link in the header for non-admins, with Settings
  kept an admin's.** The owner chose Settings for everyone at intake.
- **The navigation's Hosts and Notifications pointing at anchors on
  `/settings`, keeping the summary cards.** `/settings/hosts` and
  `/settings/notifications` would still have no navigation, and each would
  have two places.
- **Testing every device as a loop over the single-device test in the
  console.** One request per device, a result per round trip, and not the
  send path real notifications take.
- **A Settings home of its own for a non-admin.** The redirect handles the
  header link and a typed address alike.

## What would make this worth revisiting

A second part of Settings that a non-admin should reach. Then their Settings
is no longer one page, `/settings` would need to show them a list rather than
redirect, and `settingsNav`'s non-admin rule would name what they may see
rather than Notifications alone.
