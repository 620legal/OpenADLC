# 0024. Needs-you alerts are raised by the open page

- **Status:** accepted
- **Date:** 2026-11-02

## Context

A person with the console in a background tab had no way to learn that a bot
was waiting on them without looking at it: the tab's title was a fixed
"OpenADLC console", the console had no icon, and the live refresh stopped
while the tab was hidden, so even a page that could have said so read nothing
new (#222). Reaching a person with no console open at all is the bridge's
notifications' job (#225, through ntfy, Slack or a webhook); this is the tab
that is already open.

## Decision

- Alerts are raised by an open console tab, from the live refresh's own reads.
  `NeedsYouAlerts`, mounted in `AppShell`, sets the title ("(N) <console
  name>"), adds an amber-dot icon while anything waits, and, when switched on,
  plays a short WebAudio note and raises one desktop notification for what is
  new. There is no service worker, no push, and no bridge change: the work
  items come in `HeaderData.needsItems`, from the attention list the page
  already reads.
- The page's live refresh keeps running while the tab is hidden
  (`keepRefreshing`), and still reads at once when a tab comes back after
  longer than one wait. A poll that only matters on screen, the board's
  activity, keeps `refreshWhileVisible`.
- The three switches (tab count and dot, sound, desktop notifications) are kept
  per browser in `localStorage`, one key each under `openadlc.alerts.`, the
  count on and the other two off by default. They live in a menu in the header
  that every role reaches. Permission for notifications is asked from that
  switch only.
- "New" is per document load: the first read after load is the baseline, an id
  seen once never alerts again in that document, and tabs of one browser claim
  an id in `localStorage` so only one of them alerts. Only waiting work
  notifies; the install's own items do not.

## What this rules out

- **A service worker with Web Push.** It would notify with no tab open, but it
  needs VAPID keys (a new credential), a push endpoint on the bridge and a
  subscription table. Reaching a person away from the console is #225's.
- **A small attention-only read while hidden, instead of the full
  `router.refresh()`.** It would be lighter on the bridge, but it is a second
  read path for the same facts and a new server action.
- **Drawing the dot over a console icon on a canvas.** The console has no icon
  to draw over, and adding one is its own change.
- **Keeping the switches on the server, or in Settings.** Settings is an
  admin's, and whether a browser may notify is that browser's to say.

## What would make this worth revisiting

Background tabs costing the bridge too much. Chromium slows a hidden timer to
about once a minute after five minutes, so each background tab is about one
full page read a minute; if that load shows, an attention-only read while
hidden is the change to make.
