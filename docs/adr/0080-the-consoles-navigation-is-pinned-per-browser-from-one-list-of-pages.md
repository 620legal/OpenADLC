# 0080. The console's navigation is pinned per browser, from one list of pages

- **Status:** accepted
- **Date:** 2026-11-24

## Context

The console header's navigation grew with every page added. It held Board,
Crew, Costs, Insights, Releases and Settings, and the phone's bar fitted them
with a grid of up to five columns. Needs you was not in it at all: it was
reached from the chip at the right of the header, and the command palette
inserted it into its own list by hand. That gave the console three lists of
its pages (the header's `NAV`, the bar's columns, and the palette's
hand-built order), and a seventh page would not fit the bar.

The requester asked (#375) for each person to choose which pages show, with
the rest under a More menu. At intake they confirmed that the choice is per
browser, kept like the alert switches and the colour mode, and nothing stored
on the bridge.

## Decision

- **`PAGES` in `apps/console/src/lib/header.ts` is the one list of the
  console's pages:** Board, Needs you, Crew, Costs, Insights, Releases,
  Settings, in that order. The wide header, the phone's bar (`BottomNav`),
  More and the command palette all read it. A new page is added there and to
  `NAV_ICONS`.
- **`navFor(role)` still decides what a person may see.** It returns every
  page to every role, Settings included (ADR 0053). Neither More nor the bars
  list a page it leaves out: `pinnedNav(pages, pins)` skips a pin for a page
  that `pages` does not hold.
- **Which pages show is a per-browser choice**, kept in localStorage under
  `openadlc.nav.pins` as a JSON array of page ids in the order they were
  pinned (`apps/console/src/lib/nav-pins.ts`). It is never sent to the bridge.
  - Pinning adds a page to the end, and unpinning removes it.
  - A missing key, storage that throws, or a value that is not a JSON array
    falls back to the defaults: Board, Needs you, Crew, Releases.
  - An unknown or repeated entry is dropped, and a stored `[]` is kept.
- **The bars show the pinned pages, then More.** More opens every page the
  person may see, with a search box and a pin toggle on each. The server draws
  the defaults, and the bars read storage once mounted, so that the first
  drawing matches what the server sent. Every write is announced to the tab
  (`openadlc:nav-pins-changed`) and to other tabs (`storage`), so both bars
  follow it.
- **The palette lists every page, pinned or not**, built from `PAGES`. Its
  output is what it was before. The Needs you chip stays at the right of the
  header whatever is pinned.
- This refines ADR 0053's "Settings is in the header" to "Settings is in the
  header's navigation, or under its More".

## What this rules out

- **Pins kept per person on the bridge.** That would need a table, a route
  and a migration for a p3 convenience, and the requester declined it.
  Someone who uses two browsers pins in each.
- **A fixed overflow, such as the first N pages and then More.** The pages
  would move between the bar and More as the window resized, so a person could
  not learn where a page is. Pins put a page where the person put it, and the
  pinned row scrolls rather than overflow.
- **A list of pages per navigation.** Separate lists for the header, the bar
  and the palette had already drifted apart, so that Needs you was in only one
  of them.

## What would make this worth revisiting

People wanting their navigation to follow them across browsers and devices.
That would be the time to keep the pins on the bridge, per person, with
`PAGES` and `navFor` unchanged.
