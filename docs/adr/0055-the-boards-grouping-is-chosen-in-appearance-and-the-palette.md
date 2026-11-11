# 0055. The board's grouping is chosen in Appearance and the palette

- **Status:** accepted
- **Date:** 2026-11-11

## Context

ADR 0027 gave the board a second grouping, By state, beside By stage, chosen
per browser (`openadlc.board.view`) with a switch in the board's toolbar
(#226). The owner found the grouping useful but the switch in the way: "it
takes too much space. Should be configurable but not permanently on the board
because it is not something you use daily" (#303).

Settings → Appearance already holds per-browser display choices (Color mode),
but a non-admin cannot reach it: ADR 0053 gives a non-admin Settings with
Notifications alone. ⌘K is open to everyone on every page with the header.

⌘K run on the board pushes to the route the board is already on, so the board
does not remount; a view read once on mount would leave it drawn as it was.

## Decision

The board's toolbar has no By stage | By state switch. The view is chosen in
two places, both writing the same key with `saveView`:

- **Settings → Appearance** has a **Board** row beside Color mode, a
  radiogroup with By stage and By state, checked only once mounted, like
  `ThemeToggle`. Appearance stays an admin's, under ADR 0053.
- **⌘K** offers everyone, in its Act group, "Group the board by state" while
  the browser is By stage and "Group the board by stage" while it is By state
  (`id: 'board-view'`, the same id either way). Running it saves the view and
  goes to the board of the repository on screen.

While the board is By state it says so in one line under the toolbar
(`role="status"`): "Grouped by state." with a **Group by stage** button, then
where else it is changed — Settings → Appearance or ⌘K for an admin, ⌘K alone
for anyone else. By stage draws no line.

`saveView` stores the view and then dispatches `VIEW_EVENT`
(`openadlc:board-view`) on the page, even when storage throws, so the page in
front of the person follows. `onViewChange` hears that event and another tab's
`storage` event for the key; the board and the Board row subscribe to it.

The key, its values, its reading (By stage on a first visit, for a value it
does not know, where storage throws, and on the server's drawing) are ADR
0027's, unchanged: a browser that chose By state with the old switch stays on
it. ADR 0027's grouping itself stands.

## What this rules out

- **A smaller switch on the board.** The owner asked for the choice off the
  board, not for a smaller one: any control there takes room every day for a
  choice made rarely.
- **Showing a non-admin Appearance, or a slice of it.** That replaces ADR 0053
  for one per-browser preference. The choice is never more than one ⌘K away,
  and while the board is By state it says so itself, with the way back.
- **Storing the choice per person, or on the server.** It stays per browser,
  as ADR 0027 has it.

## What would make this worth revisiting

Non-admins being given Appearance, or other per-browser display choices of
theirs, in Settings: then the Board row belongs there for everyone, and a new
ADR superseding 0053 says so. Or the view being chosen often enough that one
step away from the board is too far.
