# 0029. The jump list is read whole when the palette opens

- **Status:** accepted
- **Date:** 2026-11-02

## Context

The console's command palette (OpenADLC#228), ⌘K on a Mac and Ctrl+K
elsewhere, opens a work item by its key, number or title from any page. The
console had no list of items on every page to search: the board reads its own
cards, and each page reads only what it shows. The person who asked chose the
items it covers on intake: open items and recently closed ones. They did not
choose the other option, every item searched on the server as you type.

The bridge already reads the links of the items the board can show
(`workItems.boardLinks(since)`), each item's links whole. Matching a few
hundred items by number, key, `repo#n` and title words costs the browser
nothing.

## Decision

- **The palette's item search is the bridge's `GET /v1/items`** (`user`,
  `item-search-routes.ts`). It lists the open items and those closed in the
  last 30 days (`RECENTLY_CLOSED_DAYS`), at most 1000 (`JUMP_LIST_MAX`), open
  first and then newest first. It leaves out a link in a repository the install
  no longer manages, the subjects `ignoredSubjects` leaves out, an item whose
  first issue is ignored, and an item with no link left. Each item is its key,
  its number, its first issue's title, its `repo#n` refs, whether it is open,
  and when it closed. Before the install is numbered it is
  `{ numbered: false, items: [] }`.
- **It is read whole each time the palette opens and matched in the browser.**
  The console route is `GET /api/palette`, which reads it beside the pauses for
  Resume, each read able to fail on its own. The matching is `rankJump` in
  `lib/command-palette.ts`. Nothing is kept between openings, and no page's
  read carries it.
- **The console's key rules live in `lib/keys.ts`.** A single-key shortcut
  does nothing while typing in a field, while any `role=dialog` is open, or
  with Ctrl, ⌘ or Alt held. Enter also yields to a focused button or link. Only
  the palette's shortcut passes while typing, and it is exact per platform:
  Ctrl+K in a Mac's text field stays "delete to end of line".
- **The palette and the keys list are mounted once by `AppShell`.** Every page
  with the header has them; the walkthrough and sign-in do not.

## What this rules out

- **Holding the jump list in `HeaderData`.** Every page's read, every 15
  seconds, would carry hundreds of items for a palette that is rarely open.
- **Searching on the server per keystroke.** The person did not choose it, and
  one read per opening is enough for open items plus a month.
- **`GET /v1/items/search`.** The router would match it as
  `/v1/items/:subject` with the subject "search".

## What would make this worth revisiting

An install whose open items plus a month's closed ones run past
`JUMP_LIST_MAX`, or a read slow enough that the palette shows "Loading items…"
long after it opens. Either makes searching on the server per query the better
trade.
